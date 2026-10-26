#!/usr/bin/env node
'use strict';

/**
 * Zero CLI <-> Telegram bridge.
 *
 * Long-polls the Telegram Bot API, runs `zero -p` for each incoming message,
 * and sends the result back. Only allowlisted chat IDs are served.
 *
 * Environment variables (override runtime/config.json):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_ALLOWED_CHAT_IDS   comma-separated
 *   TELEGRAM_WORKDIR
 *   ZERO_BIN
 *   ZERO_MODEL
 *   ZERO_EFFORT
 *   ZERO_JOB_TIMEOUT_MS
 *   ZERO_MAX_FILE_BYTES
 *   ZERO_BRIDGE_RUNTIME
 *   ZERO_BRIDGE_CONFIG
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { toTelegramHtml, splitMarkdown, escapeHtml } = require('./markdown');
const { extractFileMarkers, uploadMethodsFor, buildMultipart } = require('./files');
const {
  discoverSessions,
  findActiveSession,
  findSessionById,
  readLastUsage
} = require('./sessions');

const ROOT = path.resolve(__dirname, '..');
const VERSION = (() => {
  try { return require(path.join(ROOT, 'package.json')).version || '0.0.0'; }
  catch (_) { return '0.0.0'; }
})();

const RUNTIME_DIR = process.env.ZERO_BRIDGE_RUNTIME
  ? path.resolve(process.env.ZERO_BRIDGE_RUNTIME)
  : path.join(ROOT, 'runtime');
fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });

const CONFIG_PATH = process.env.ZERO_BRIDGE_CONFIG
  ? path.resolve(process.env.ZERO_BRIDGE_CONFIG)
  : path.join(RUNTIME_DIR, 'config.json');
const STATE_PATH = path.join(RUNTIME_DIR, 'state.json');
const LOG_PATH = path.join(RUNTIME_DIR, 'bridge.log');

const HOME = process.env.HOME || '/home/zero';
const PROGRESS_MODES = ['full', 'messages', 'stream', 'off'];
const MAX_QUEUE = 50;
const SESSION_PAGE_SIZE = 10;
const SESSION_LIST_LIMIT = 60;
const BTW_TIMEOUT_MS = 5 * 60 * 1000;

let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`Cannot read ${CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }
}

const envChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const fileChatIds = Array.isArray(fileConfig.allowedChatIds)
  ? fileConfig.allowedChatIds.map(String)
  : [];

const config = {
  token: process.env.TELEGRAM_BOT_TOKEN || fileConfig.token || '',
  allowedChatIds: envChatIds.length ? envChatIds : fileChatIds,
  workdir: process.env.TELEGRAM_WORKDIR || fileConfig.workdir || path.join(HOME, 'zero-workspace'),
  zeroBin: process.env.ZERO_BIN || fileConfig.zeroBin || 'zero',
  model: process.env.ZERO_MODEL || fileConfig.model || 'flash',
  effort: process.env.ZERO_EFFORT || fileConfig.effort || 'low',
  jobTimeoutMs: Number(process.env.ZERO_JOB_TIMEOUT_MS || fileConfig.jobTimeoutMs || 1800000),
  maxFileBytes: Number(process.env.ZERO_MAX_FILE_BYTES || fileConfig.maxFileBytes || 20971520),
  autoCompact: process.env.ZERO_BRIDGE_AUTO_COMPACT === '1' || Boolean(fileConfig.autoCompact),
  autoCompactThreshold: Number(
    process.env.ZERO_BRIDGE_AUTO_COMPACT_THRESHOLD || fileConfig.autoCompactThreshold || 0.75
  ),
  progressMode: process.env.ZERO_BRIDGE_PROGRESS_MODE || fileConfig.progressMode || 'full',
  thinkingLanguage: String(
    process.env.ZERO_THINKING_LANGUAGE || fileConfig.thinkingLanguage || 'auto'
  ).trim() || 'auto'
};
if (!(config.autoCompactThreshold > 0.1 && config.autoCompactThreshold < 0.98)) {
  config.autoCompactThreshold = 0.75;
}
if (!PROGRESS_MODES.includes(config.progressMode)) {
  config.progressMode = 'full';
}

if (!config.token) {
  console.error(
    'Missing Telegram bot token.\n' +
    'Set TELEGRAM_BOT_TOKEN or create ' + CONFIG_PATH + ' (see config.example.json).'
  );
  process.exit(1);
}
if (!config.allowedChatIds.length) {
  console.error(
    'No allowed chat IDs.\n' +
    'Set TELEGRAM_ALLOWED_CHAT_IDS or add "allowedChatIds" to ' + CONFIG_PATH + '.'
  );
  process.exit(1);
}
try {
  fs.mkdirSync(config.workdir, { recursive: true });
} catch (e) {
  console.error(`Cannot create workdir ${config.workdir}: ${e.message}`);
  process.exit(1);
}

const allowedChatIds = new Set(config.allowedChatIds.map(String));
const CHUNK = 3800;
const TYPING_MS = 4500;

// `zero -p` has no interactive UI, and Telegram cannot answer AskUserQuestion.
const TELEGRAM_SYSTEM_PROMPT =
  'You are running through Telegram. Never use AskUserQuestion or other ' +
  'interactive UI tools. If you need clarification, ask in plain text in ' +
  'your final reply. To send a file or screenshot, end your final reply with ' +
  'a marker block: one [[send-file:/absolute/path]] per line, with no text ' +
  'after it. Relative paths resolve from the working directory. The marker ' +
  'is removed and the file is uploaded separately. Never send secrets, ' +
  'credentials, or the bridge configuration file.';

function thinkingLanguage(s) {
  const raw = String((s && s.thinkingLanguage) || '').trim();
  const key = raw.toLowerCase();
  if (!key || ['auto', 'off', 'default', 'none'].includes(key)) return null;
  if (key === 'id' || key === 'indonesian' || key === 'bahasa') {
    return { key: 'id', label: 'Indonesian (Bahasa Indonesia)' };
  }
  if (key === 'en' || key === 'english') return { key: 'en', label: 'English' };
  return { key, label: raw };
}

function thinkingLanguagePrompt(s) {
  const lang = thinkingLanguage(s);
  if (!lang) return '';
  if (lang.key === 'id') {
    return ' PENTING: Semua proses berpikir/internal thinking WAJIB ditulis dalam ' +
      'Bahasa Indonesia, bahkan jika pengguna menulis dalam bahasa lain. Jangan menulis ' +
      'thinking dalam bahasa Inggris. Jawaban akhir tetap menggunakan bahasa pengguna. ' +
      'Jangan terjemahkan kode, perintah, path file, atau identifier teknis.';
  }
  return ' Write all internal thinking/reasoning blocks in ' + lang.label +
    ', even if the user writes in another language. Keep code, commands, file paths, ' +
    'and technical identifiers unchanged. The final answer should use the user\'s ' +
    'language; this instruction only applies to thinking.';
}

// A user-turn hint works more reliably than the system prompt alone for
// reasoning models. It goes after the user's text so Zero reads the real
// message as the session title. Slash commands are left untouched so /compact
// and skills still parse correctly.
function thinkingLanguageHint(s) {
  const lang = thinkingLanguage(s);
  if (!lang) return '';
  const instruction = lang.key === 'id'
    ? 'Seluruh proses berpikir/internal thinking HARUS dalam Bahasa Indonesia. ' +
      'Dilarang menulis thinking dalam bahasa Inggris. Jawaban akhir ikuti bahasa pengguna. ' +
      'Jangan terjemahkan kode, perintah, path file, atau identifier teknis.'
    : 'Write all internal thinking/reasoning in ' + lang.label + '. ' +
      'The final answer must use the user\'s language. Do not translate code, ' +
      'commands, file paths, or technical identifiers.';
  return `[ATURAN WAJIB: ${instruction}]`;
}

function promptWithThinkingLanguage(prompt, s) {
  if (String(prompt || '').trimStart().startsWith('/')) return prompt;
  const hint = thinkingLanguageHint(s);
  return hint ? `${prompt}\n\n${hint}` : prompt;
}

const KB = {
  newSession: '🆕 New Session',
  sessions: '🗂️ Sessions',
  resume: '⏪ Resume',
  model: '🧠 Model',
  effort: '⚙️ Effort',
  cwd: '📁 Folder',
  status: '📊 Status',
  stop: '⏹️ Stop',
  compact: '🗜️ Compact & Auto',
  settings: '⚙️ Settings',
  queue: '📋 Queue',
  btw: '💭 BTW',
  help: '❓ Help'
};

// Reply keyboards cannot be edited in place. They are refreshed whenever the
// bridge sends a message, so the count can be stale while a job is running.
// The activity message carries the live count and an inline Queue button.
function mainKeyboard(includeActive = true) {
  const depth = queueDepth(includeActive);
  const queueLabel = depth > 0 ? `${KB.queue} (${depth})` : KB.queue;
  return {
    keyboard: [
      [{ text: KB.newSession }, { text: KB.sessions }, { text: KB.resume }],
      [{ text: KB.model }, { text: KB.effort }, { text: KB.cwd }],
      [{ text: KB.status }, { text: KB.settings }, { text: KB.stop }],
      [{ text: queueLabel }, { text: KB.btw }],
      [{ text: KB.compact }, { text: KB.help }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Type a message or pick a menu…'
  };
}

const KEYBOARD_MAP = {
  [KB.newSession]: '/new',
  [KB.sessions]: '/sessions',
  [KB.resume]: '/resume',
  [KB.model]: '/model',
  [KB.effort]: '/effort',
  [KB.cwd]: '/cwd',
  [KB.status]: '/status',
  [KB.stop]: '/stop',
  [KB.compact]: '/compactmenu',
  [KB.settings]: '/settings',
  [KB.queue]: '/queue',
  [KB.btw]: '/btw',
  [KB.help]: '/help',
  // Legacy reply keyboards cached by Telegram clients.
  '💰 Cost': '/cost',
  '🔄 Auto-Compact': '/autocompact',
  '🗜️ Compact': '/compactmenu'
};

const BOT_COMMANDS = [
  { command: 'start', description: '🚀 Start the bot' },
  { command: 'help', description: '📖 Help & commands' },
  { command: 'menu', description: '🎛️ Show keyboard menu' },
  { command: 'new', description: '🆕 New conversation' },
  { command: 'resume', description: '⏪ Resume a session' },
  { command: 'sessions', description: '🗂️ Recent sessions' },
  { command: 'compact', description: '🗜️ Compact context' },
  { command: 'autocompact', description: '🔄 Toggle auto-compact' },
  { command: 'progress', description: '💬 Progress display mode' },
  { command: 'settings', description: '⚙️ Settings menu' },
  { command: 'status', description: '📊 Bridge status & queue' },
  { command: 'queue', description: '📋 View or clear the job queue' },
  { command: 'btw', description: '💭 Quick side question in a read-only run' },
  { command: 'model', description: '🧠 View or set model' },
  { command: 'effort', description: '⚙️ View or set effort' },
  { command: 'cwd', description: '📁 Working directory' },
  { command: 'cost', description: '💰 Session & total cost' },
  { command: 'stop', description: '⏹️ Interrupt running task' },
  { command: 'ping', description: '🏓 Check bridge health' },
  { command: 'id', description: '🪪 Show chat ID' },
  { command: 'mcp', description: '🔌 Zero MCP servers' },
  { command: 'plugin', description: '🧩 Zero plugins' },
  { command: 'agents', description: '🤖 List agents' },
  { command: 'doctor', description: '🩺 Non-interactive health check' },
  { command: 'version', description: '🏷️ Bridge & Zero CLI version' },
  { command: 'config', description: '🔧 Bridge configuration' }
];

const WELCOME = `👋 Welcome to Zero!

I'm your Zero agent on Telegram. I can chat, read and write files, run commands, search the web, and more.

💬 Send any message to start.
📎 Send a photo or document to analyze it.
↩️ Reply to a message to include its context.
🎛️ Use the keyboard below for quick actions.
⌨️ Type /help for all commands.

🚀 Quick start
• /new — start a new conversation
• /status — check bridge status
• /compact — summarize and free context
• /settings — tap-to-change model, effort, folder, and more

🔒 Full-auto mode. Only your chat ID is served.`;

const HELP = `📖 ZERO HELP

💬 Chat
• Send a normal message — the agent replies and can use tools
• 📎 Photo / document / voice — downloaded and analyzed
• 📤 File output — the agent can attach files with [[send-file:/path]]
• ↩️ Reply to a message — its quote is included
• !command — run a shell command in the working directory (e.g. !ls -la)

🆕 Sessions
/new — start a new conversation
/resume — list sessions in the working directory
/resume <number|id> — resume a specific session
/sessions — recent sessions
/compact [instructions] — summarize now
/compactmenu — Compact & Auto menu (also the keyboard button)
/status — model, effort, folder, queue, cost, context
/queue — view, remove, or clear queued jobs
/btw <question> — quick side question in a read-only run (does not alter this chat)
/stop — interrupt the running task (SIGINT) and clear the queue

🧠 Settings
/settings — inline menu for model, effort, folder, progress, auto-compact
/model — inline model picker; /model <name> to set directly
/effort — inline effort picker; /effort <level> to set directly
/cwd — recent folders to pick; /cwd <path> to set directly
/cost — session and total cost
/autocompact — auto-compact panel (inline buttons)
/progress — full / messages / stream / off (tap-to-pick menu)
/menu — show the keyboard
/id — your chat ID
/ping — check bridge health

🛠️ Zero
/mcp [subcommand] — manage MCP servers
/plugin [subcommand] — manage plugins
/agents — list agents
/doctor — non-interactive health check (full doctor needs a terminal)
/version — bridge and Zero CLI versions
/config — bridge config (token redacted)

✨ More
/any-command — forwarded to Zero (skills, etc.)
/help — this help

⚠️ Full-auto: the agent can modify files and run commands. Only allowlisted chat IDs are served.`;

let state = { offset: 0, sessions: {} };
try {
  state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
} catch (_) {}
if (!state.sessions) state.sessions = {};

let jobQueue = [];
let jobSeq = 0;
let processing = false;
let activeJob = null;
let activeProgress = null;
let stopped = false;
const btwJobs = new Map();
const btwCancelled = new Set();
const startedAt = Date.now();

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    return typeof a === 'string' ? a : JSON.stringify(a);
  }).join(' ');
  try { fs.appendFileSync(LOG_PATH, line + '\n', { mode: 0o600 }); } catch (_) {}
}

function saveState() {
  try {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) { log('state save failed:', e.message); }
}

function sessionFor(chatId) {
  const id = String(chatId);
  if (!state.sessions[id]) {
    state.sessions[id] = {
      model: config.model,
      effort: config.effort,
      cwd: config.workdir,
      newSession: true,
      resumeId: null,
      lastSessionId: null,
      lastTotal: 0,
      spent: 0,
      lastCallCost: 0,
      autoCompact: config.autoCompact,
      autoCompactThreshold: config.autoCompactThreshold,
      progressMode: config.progressMode,
      progressModeExplicit: false,
      thinkingLanguage: config.thinkingLanguage,
      lastContextTokens: 0,
      contextWindow: null,
      contextPct: 0,
      contextSource: 'bot',
      lastCompactAt: null,
      autoCompactFailedAt: 0,
      pendingResume: null,
      cwdMenus: {}
    };
  }
  const s = state.sessions[id];
  if (!s.cwd) s.cwd = config.workdir;
  if (!s.model) s.model = config.model;
  if (!s.effort) s.effort = config.effort;
  if (typeof s.autoCompact !== 'boolean') s.autoCompact = config.autoCompact;
  if (typeof s.autoCompactThreshold !== 'number') s.autoCompactThreshold = config.autoCompactThreshold;
  if (!PROGRESS_MODES.includes(s.progressMode)) s.progressMode = config.progressMode;
  if (typeof s.progressModeExplicit !== 'boolean') s.progressModeExplicit = false;
  if (!s.progressModeExplicit) s.progressMode = config.progressMode;
  if (typeof s.thinkingLanguage !== 'string' || !s.thinkingLanguage.trim()) {
    s.thinkingLanguage = config.thinkingLanguage;
  }
  if (typeof s.lastContextTokens !== 'number') s.lastContextTokens = 0;
  if (typeof s.contextPct !== 'number') s.contextPct = 0;
  if (!s.contextSource) s.contextSource = 'bot';
  if (typeof s.autoCompactFailedAt !== 'number') s.autoCompactFailedAt = 0;
  if (!('pendingResume' in s)) s.pendingResume = null;
  if (!s.cwdMenus || typeof s.cwdMenus !== 'object' || Array.isArray(s.cwdMenus)) {
    s.cwdMenus = {};
  }
  return s;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function redact(text) {
  if (!text) return text;
  return String(text).replaceAll(config.token, '<token>');
}

function clip(text, max) {
  const chars = Array.from(String(text));
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

// ---------------------------------------------------------------- Telegram API
class ApiError extends Error {
  constructor(method, body) {
    super(`${method}: ${body.description || 'Telegram error'} (${body.error_code})`);
    this.errorCode = body.error_code;
    this.parameters = body.parameters;
  }
}

// A fresh connection per request avoids stale keep-alive sockets through
// proxies and sandboxes that drop idle connections.
function telegramRequest(method, params, timeoutSec) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.token}/${method}`,
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (body.length < 8 * 1024 * 1024) body += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (_) {
          return reject(new Error(`${method}: invalid JSON (HTTP ${res.statusCode})`));
        }
        if (!parsed.ok) return reject(new ApiError(method, parsed));
        resolve(parsed.result);
      });
    });
    req.setTimeout((timeoutSec || 65) * 1000, () => {
      req.destroy(Object.assign(new Error(`${method}: ETIMEDOUT`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function api(method, params = {}, attempt = 1) {
  try {
    return await telegramRequest(method, params, params.timeout ? params.timeout + 20 : 65);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const code = e.code ? ` (${e.code})` : '';
    const transient = /ECONN|ETIMEDOUT|EPIPE|socket|network/i.test(`${e.message}${code}`);
    if (transient && attempt < 3) {
      log(`api ${method} attempt ${attempt} failed: ${e.message}${code}; retrying`);
      await sleep(750 * attempt);
      return api(method, params, attempt + 1);
    }
    throw Object.assign(new Error(`${method}: ${e.message}${code}`), { code: e.code });
  }
}

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.zip': 'application/zip'
};

function mimeFor(file) {
  return MIME_TYPES[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

// Uploads are intentionally single-shot: retrying a partially delivered file
// could post it twice. Callers log the error and continue with the job.
function telegramUpload(method, fields, file, timeoutSec = 180) {
  return new Promise((resolve, reject) => {
    const { boundary, body } = buildMultipart(fields, file);
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.token}/${method}`,
      method: 'POST',
      agent: false,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length
      }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (raw.length < 8 * 1024 * 1024) raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) {
          return reject(new Error(`${method}: invalid JSON (HTTP ${res.statusCode})`));
        }
        if (!parsed.ok) return reject(new ApiError(method, parsed));
        resolve(parsed.result);
      });
    });
    req.setTimeout(timeoutSec * 1000, () => {
      req.destroy(Object.assign(new Error(`${method}: ETIMEDOUT`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function isProtectedSendPath(file) {
  const real = candidate => {
    try { return fs.realpathSync(candidate); } catch (_) { return candidate; }
  };
  const protectedPaths = [
    CONFIG_PATH,
    STATE_PATH,
    LOG_PATH,
    path.join(HOME, '.git-credentials')
  ].map(real);
  return protectedPaths.includes(real(file));
}

async function sendFileToTelegram(chatId, rawPath, s) {
  const requested = String(rawPath || '').trim();
  if (!requested) return false;

  const expanded = requested.replace(/^~(?=$|\/)/, HOME);
  const target = path.resolve(s.cwd, expanded);

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    await send(chatId, `⚠️ Cannot send file (not found): ${requested}`);
    return false;
  }
  if (!stat.isFile()) {
    await send(chatId, `⚠️ Cannot send (not a regular file): ${requested}`);
    return false;
  }
  if (isProtectedSendPath(target)) {
    await send(chatId, '⚠️ Refusing to send a protected bridge file.');
    return false;
  }
  if (stat.size > config.maxFileBytes) {
    await send(chatId,
      `⚠️ File too large to send: ${path.basename(target)} ` +
      `(${stat.size} bytes, limit ${config.maxFileBytes}).`);
    return false;
  }

  const name = path.basename(target);
  let data;
  try {
    data = fs.readFileSync(target);
  } catch (e) {
    await send(chatId, redact(`⚠️ Failed to read ${name}: ${e.message}`).slice(0, 500));
    return false;
  }

  const fields = { chat_id: chatId, caption: clip(name, 200) };
  const methods = uploadMethodsFor(name, stat.size);
  let lastError = null;

  for (const method of methods) {
    const field = method === 'sendPhoto' ? 'photo' : 'document';
    try {
      await telegramUpload(method, fields, {
        field,
        filename: name,
        mime: mimeFor(name),
        data
      });
      return true;
    } catch (e) {
      lastError = e;
      if (methods.length > 1) {
        log(`${method} failed, trying document fallback:`, e.message);
      }
    }
  }

  log('send file failed:', lastError ? lastError.message : 'unknown error');
  await send(chatId,
    redact(`⚠️ Failed to send ${name}: ${lastError ? lastError.message : 'unknown error'}`)
      .slice(0, 500));
  return false;
}

let commandsSynced = false;
async function syncCommands() {
  if (commandsSynced) return;
  try {
    await api('setMyCommands', { commands: BOT_COMMANDS });
    commandsSynced = true;
    log('bot commands synced');
  } catch (e) {
    log('setMyCommands failed:', e.message);
  }
}

async function send(chatId, text, extra = {}) {
  const out = String(text == null || text === '' ? '(no output)' : text);
  for (const chunk of splitMessage(out)) {
    try {
      await api('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...extra
      });
    } catch (e) {
      log('sendMessage failed:', e.message);
      if (e.errorCode === 429 && e.parameters && e.parameters.retry_after) {
        await sleep((e.parameters.retry_after + 1) * 1000);
        try {
          await api('sendMessage', { chat_id: chatId, text: chunk, ...extra });
        } catch (e2) { log('send retry failed:', e2.message); }
      }
    }
  }
}

async function sendFormatted(chatId, markdown, extra = {}) {
  const parsed = extractFileMarkers(String(markdown == null ? '' : markdown));
  if (!parsed.text && parsed.files.length) return; // Marker-only step: files are sent by the job.
  const chunks = splitMarkdown(parsed.text || '(no output)', 2800);
  if (!chunks.length) chunks.push('(no output)');

  for (const chunk of chunks) {
    const html = toTelegramHtml(chunk) || chunk;
    try {
      await api('sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra
      });
    } catch (e) {
      log('formatted send failed:', e.message);
      // Telegram can reject malformed entities; deliver the raw text instead.
      await send(chatId, chunk || '(no output)', extra);
    }
  }
}

// Thinking is shown in a quote block so long, multi-paragraph reasoning stays
// visually separate from the answer and cannot break the surrounding message.
async function sendThinkingMessage(chatId, markdown) {
  const chunks = splitMarkdown(String(markdown == null ? '' : markdown), 2400);
  for (const chunk of chunks) {
    const html = toTelegramHtml(chunk) || escapeHtml(chunk);
    try {
      await api('sendMessage', {
        chat_id: chatId,
        text: `🤔 <b>Thinking</b>\n\n<blockquote>${html}</blockquote>`,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (e) {
      log('thinking send failed:', e.message);
      await send(chatId, `🤔 Thinking\n\n${chunk}`);
    }
  }
}

function splitMessage(text) {
  if (text.length <= CHUNK) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf('\n', CHUNK);
    if (cut < CHUNK * 0.6) cut = CHUNK;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function typingLoop(chatId) {
  let alive = true;
  const tick = async () => {
    if (!alive) return;
    try { await api('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch (_) {}
    if (alive) setTimeout(tick, TYPING_MS);
  };
  tick();
  return () => { alive = false; };
}

// --------------------------------------------------------- Live progress log
function oneLine(text, max = 140) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function firstLine(text, max = 160) {
  const line = String(text == null ? '' : text)
    .split('\n')
    .map(part => part.trim())
    .find(Boolean) || '';
  return oneLine(line, max);
}

function describeTool(name, input) {
  const inp = input || {};
  const file = inp.file_path || inp.path || inp.notebook_path || '';
  switch (name) {
    case 'Bash':
      return { icon: '🔧', label: 'Bash', detail: firstLine(inp.command, 160) };
    case 'Read':
      return { icon: '📖', label: 'Read', detail: oneLine(file, 140) };
    case 'Edit':
    case 'MultiEdit':
      return { icon: '✏️', label: name, detail: oneLine(file, 140) };
    case 'Write':
      return { icon: '📝', label: 'Write', detail: oneLine(file, 140) };
    case 'Grep': {
      const parts = [oneLine(inp.pattern, 90)];
      if (inp.path) parts.push(`in ${oneLine(inp.path, 60)}`);
      return { icon: '🔍', label: 'Grep', detail: parts.join(' ') };
    }
    case 'Glob':
      return { icon: '🔎', label: 'Glob', detail: oneLine(inp.pattern, 110) };
    case 'WebFetch':
      return { icon: '🌐', label: 'Fetch', detail: oneLine(inp.url, 140) };
    case 'WebSearch':
      return { icon: '🔎', label: 'Web', detail: oneLine(inp.query, 140) };
    case 'Task':
    case 'Agent':
      return { icon: '🤖', label: 'Agent', detail: oneLine(inp.description || inp.prompt, 140) };
    case 'TodoWrite':
      return { icon: '📋', label: 'Todos updated', detail: '' };
    default: {
      const hint = inp.command || inp.file_path || inp.path ||
        inp.pattern || inp.query || inp.url || '';
      return { icon: '🛠️', label: name || 'Tool', detail: oneLine(hint, 140) };
    }
  }
}

// Thinking arrives as raw model text. Keep its line structure, render the
// common Markdown constructs, and show the result as a compact quote instead
// of flattening it into one very long, unreadable line.
function formatThinkingLine(line) {
  let s = String(line == null ? '' : line).replace(/\s+$/, '');
  if (!s.trim()) return '';
  s = s.trim();
  if (/^```/.test(s)) return '';
  const heading = /^#{1,6}\s+/.test(s);
  s = s.replace(/^#{1,6}\s+/, '');
  s = s.replace(/^>\s?/, '');
  s = s.replace(/^[-*+]\s+/, '• ');
  s = s.replace(/^([-*_])\1{2,}$/, '────────');
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  return heading ? `<b>${s}</b>` : s;
}

function thinkingHtml(text, max = 900) {
  let raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return '';
  let truncated = false;
  if (raw.length > max) {
    raw = raw.slice(0, max).replace(/\s+\S*$/, '');
    truncated = true;
  }

  const out = [];
  for (const line of raw.split('\n')) {
    if (out.filter(Boolean).length >= 12) {
      truncated = true;
      break;
    }
    const formatted = formatThinkingLine(line);
    if (!formatted) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(formatted);
  }
  while (out.length && out[out.length - 1] === '') out.pop();

  let html = out.join('\n');
  // A hard cut can strand an opening marker such as "**" or a lone backtick.
  html = html.replace(/(\*\*|__|`)+\s*$/, '').trimEnd();
  if (truncated) html += (html ? '\n' : '') + '…';
  return html;
}

function renderActivityEntry(entry) {
  const when = `[${entry.at}s]`;
  if (entry.kind === 'thinking') {
    const body = thinkingHtml(entry.text);
    if (!body) return '';
    return `${when} 🤔 <b>Thinking</b>\n<blockquote>${body}</blockquote>`;
  }
  const detail = entry.detail
    ? `\n<code>${escapeHtml(entry.detail)}</code>`
    : '';
  return `${when} ${entry.icon} <b>${escapeHtml(entry.label)}</b>${detail}`;
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(blockquote|p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// One Telegram message per job, edited as tools run. The message is created
// lazily on the first thinking block or tool call, so simple replies stay
// clean. Entries are trimmed whole, never sliced mid-line.
function createStreamProgress(chatId) {
  const started = Date.now();
  let msg = null;
  let ensurePromise = null;
  let entries = [];
  let total = 0;
  let closed = false;
  let chain = Promise.resolve();
  let flushTimer = null;
  let lastFlush = 0;

  const elapsed = () => Math.floor((Date.now() - started) / 1000);

  const ensure = () => {
    if (msg) return Promise.resolve(true);
    if (!ensurePromise) {
      ensurePromise = api('sendMessage', {
        chat_id: chatId,
        text: '🧠 <b>Working…</b>',
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: queueInlineKeyboard()
      }).then(m => {
        msg = m;
        return true;
      }).catch(e => {
        log('progress message failed:', e.message);
        return false;
      });
    }
    return ensurePromise;
  };

  const build = header => {
    let visible = entries.slice();
    let hidden = total - visible.length;
    const compose = () => {
      const note = hidden > 0
        ? `… <i>${hidden} earlier step${hidden === 1 ? '' : 's'}</i>\n\n`
        : '';
      const body = visible
        .map(renderActivityEntry)
        .filter(Boolean)
        .join('\n\n');
      return `${header}\n\n${note}${body}`;
    };
    let text = compose();
    while (text.length > 3900 && visible.length > 1) {
      visible.shift();
      hidden++;
      text = compose();
    }
    return text;
  };

  const render = () =>
    build(`🧠 <b>Working…</b> ${elapsed()}s · 📋 ${queueDepth(true)}`);

  const edit = (text, markup = queueInlineKeyboard()) => {
    if (!msg) return Promise.resolve();
    chain = chain.then(async () => {
      try {
        await api('editMessageText', {
          chat_id: chatId,
          message_id: msg.message_id,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: markup
        });
      } catch (e) {
        if (/not modified/i.test(e.message)) return;
        log('progress edit failed:', e.message);
        // A malformed entity must never freeze the activity message.
        try {
          await api('editMessageText', {
            chat_id: chatId,
            message_id: msg.message_id,
            text: stripHtml(text),
            disable_web_page_preview: true,
            reply_markup: markup
          });
        } catch (e2) {
          log('progress plain edit failed:', e2.message);
        }
      }
    });
    return chain;
  };

  const schedule = () => {
    if (closed || flushTimer) return;
    const wait = Math.max(0, 1500 - (Date.now() - lastFlush));
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (closed) return;
      lastFlush = Date.now();
      edit(render());
    }, wait);
  };

  const addEntry = entry => {
    if (closed) return;
    total++;
    entries.push(entry);
    if (entries.length > 14) entries = entries.slice(-14);
    ensure().then(ok => { if (ok) schedule(); });
  };

  return {
    addText() {},
    refresh() {
      if (msg && !closed) schedule();
    },
    addThinking(text) {
      if (closed) return;
      const raw = String(text || '').trim();
      if (!raw) return;
      const last = entries[entries.length - 1];
      if (last && last.kind === 'thinking') {
        // Consecutive thinking blocks are revisions of the same thought.
        last.text = raw;
        ensure().then(ok => { if (ok) schedule(); });
        return;
      }
      addEntry({ kind: 'thinking', at: elapsed(), text: raw });
    },
    addTool(name, input) {
      if (closed) return;
      addEntry({ kind: 'tool', at: elapsed(), ...describeTool(name, input) });
    },
    async flush() {
      await ensurePromise;
      await chain;
    },
    async finish(opts = {}) {
      if (closed) return;
      closed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await ensurePromise;
      if (!msg) return; // No activity: nothing to finalize.
      await chain;

      const secs = elapsed();
      let header;
      if (opts.ok) header = `✅ <b>Done</b> in ${secs}s`;
      else if (opts.status === 'stopped') header = `⏹️ <b>Stopped</b> after ${secs}s`;
      else if (opts.status === 'timeout') header = `⏱️ <b>Timed out</b> after ${secs}s`;
      else header = `❌ <b>Failed</b> after ${secs}s`;
      await edit(build(header), { inline_keyboard: [] });
    }
  };
}

// Tool calls always share one editable activity message. Thinking and answer
// steps can either join that stream or be sent as separate messages.
function createActivityProgress(chatId, options = {}) {
  const answerSteps = options.answerSteps !== false;
  const streamThinking = Boolean(options.streamThinking);
  const showThinking = options.showThinking !== false;
  const activity = createStreamProgress(chatId);
  let chain = Promise.resolve();
  let lastSend = 0;
  let accepting = true;
  let lastText = '';
  let lastTextOk = false;
  const seen = new Set();

  const queue = task => {
    if (!accepting) return;
    chain = chain.then(async () => {
      const wait = Math.max(0, 350 - (Date.now() - lastSend));
      if (wait) await sleep(wait);
      await task();
      lastSend = Date.now();
    }).catch(e => log('progress step failed:', e.message));
    return chain;
  };

  return {
    addText(text, key) {
      if (!answerSteps || !accepting) return;
      const body = String(text || '').trim();
      if (!body) return;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      lastText = body;
      lastTextOk = false;
      queue(async () => {
        await sendFormatted(chatId, `💬\n\n${body}`);
        lastTextOk = true;
      });
    },
    addThinking(text, key) {
      if (!accepting) return;
      const body = String(text || '').trim();
      if (!body) return;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      // Thinking after text means the earlier text was not the final answer.
      lastText = '';
      lastTextOk = false;
      if (streamThinking) activity.addThinking(body);
      else if (showThinking) {
        queue(() => sendThinkingMessage(chatId, body));
      }
    },
    addTool(name, input, key) {
      if (!accepting) return;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      lastText = '';
      lastTextOk = false;
      activity.addTool(name, input);
    },
    getLastText() { return lastText; },
    getLastTextOk() { return lastTextOk; },
    refresh() { activity.refresh(); },
    async flush() {
      await chain;
      await activity.flush();
    },
    async finish(opts = {}) {
      accepting = false;
      await chain;
      await activity.finish(opts);
    }
  };
}

function createProgress(chatId, mode = 'messages') {
  if (mode === 'off') {
    return {
      addText() {},
      addThinking() {},
      addTool() {},
      getLastText() { return ''; },
      getLastTextOk() { return false; },
      refresh() {},
      async flush() {},
      async finish() {}
    };
  }
  if (mode === 'stream') {
    return createActivityProgress(chatId, { showThinking: false });
  }
  if (mode === 'full') {
    return createActivityProgress(chatId, { streamThinking: true });
  }
  return createActivityProgress(chatId);
}

// ------------------------------------------------------------------- Zero CLI
function killTree(child, signal = 'SIGTERM') {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (_) { try { child.kill(signal); } catch (_) {} }
}

function processAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

// ESC/Ctrl+C-like stop: SIGINT first, then escalate if the child ignores it.
function requestStop(job) {
  if (!job) return;
  if (job.control) job.control.stop = true;
  killTree(job.child, 'SIGINT');

  const timers = [];
  timers.push(setTimeout(() => {
    if (processAlive(job.child)) killTree(job.child, 'SIGTERM');
  }, 2000));
  timers.push(setTimeout(() => {
    if (processAlive(job.child)) killTree(job.child, 'SIGKILL');
  }, 5000));

  if (job.child) {
    job.child.once('close', () => timers.forEach(clearTimeout));
  }
}

function zeroArgs(prompt, s, stream = true) {
  const args = ['-p', '--output-format', stream ? 'stream-json' : 'json'];
  if (stream) args.push('--verbose');
  const systemPrompt = TELEGRAM_SYSTEM_PROMPT + thinkingLanguagePrompt(s);
  args.push(
    '--dangerously-skip-permissions',
    '--model', s.model,
    '--effort', s.effort,
    '--disallowedTools', 'AskUserQuestion',
    '--append-system-prompt', systemPrompt
  );
  if (s.resumeId) args.push('-r', s.resumeId);
  else if (!s.newSession) args.push('-c');
  args.push('--', prompt);
  return args;
}

function runZero(prompt, s, onChild, control) {
  return new Promise((resolve, reject) => {
    const stream = !(control && control.stream === false);
    const progress = control && control.progress;
    const args = zeroArgs(promptWithThinkingLanguage(prompt, s), s, stream);
    log('run zero', JSON.stringify({
      cwd: s.cwd,
      model: s.model,
      effort: s.effort,
      resume: s.resumeId || null,
      cont: !s.newSession,
      stream,
      len: prompt.length
    }));

    const child = spawn(config.zeroBin, args, {
      cwd: s.cwd,
      env: {
        ...process.env,
        HOME,
        NO_COLOR: '1',
        // Let the SessionStart hook skip nested jobs spawned by this bridge.
        ZERO_BRIDGE_CHILD: '1',
        // The bridge owns auto-compaction so the Telegram toggle is authoritative.
        DISABLE_AUTO_COMPACT: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: Zero's sandbox can kill its own group on exit
      // without taking this bridge down with it.
      detached: true
    });
    if (onChild) onChild(child);

    let stdout = '';
    let stderr = '';
    let killedBy = null;
    let lineBuf = '';
    const seenTools = new Set();
    const limit = 32 * 1024 * 1024;

    const emitTool = (block, key) => {
      if (!progress || !block || block.type !== 'tool_use') return;
      const dedupeKey = key || (block.id ? `id:${block.id}` : '');
      if (dedupeKey && seenTools.has(dedupeKey)) return;
      if (dedupeKey) seenTools.add(dedupeKey);
      progress.addTool(block.name, block.input || {}, dedupeKey);
    };

    const handleLine = raw => {
      const line = raw.trim();
      if (!line.startsWith('{')) return;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { return; }

      // Every stream-json event carries the live session ID. Keep it on the
      // control object so /btw can read the exact conversation in flight.
      if (evt.session_id && control) control.sessionId = evt.session_id;

      if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
        const content = evt.message.content;
        const messageId = evt.message.id || evt.message.uuid || 'msg';

        content.forEach((block, index) => {
          if (!block || !progress) return;
          if (block.type === 'text' &&
            typeof block.text === 'string' && block.text.trim()) {
            progress.addText(block.text, `text:${messageId}:${index}`);
          } else if (block.type === 'thinking' &&
            typeof block.thinking === 'string' && block.thinking.trim()) {
            progress.addThinking(block.thinking, `thinking:${messageId}:${index}`);
          } else if (block.type === 'tool_use') {
            emitTool(block, `tool:${messageId}:${index}:${block.id || ''}`);
          }
        });
      } else if (evt.type === 'stream_event' &&
        evt.event && evt.event.type === 'content_block_start') {
        const block = evt.event.content_block;
        emitTool(block, block && block.id
          ? `stream:${block.id}`
          : `stream:${evt.event.index}`);
      }
    };

    child.stdout.on('data', d => {
      if (stdout.length < limit) stdout += d;
      if (!stream) return;
      lineBuf += d;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        handleLine(lineBuf.slice(0, idx));
        lineBuf = lineBuf.slice(idx + 1);
      }
    });
    child.stderr.on('data', d => { if (stderr.length < limit) stderr += d; });

    const timeout = setTimeout(() => {
      killedBy = 'timeout';
      killTree(child, 'SIGTERM');
      const killTimer = setTimeout(() => {
        if (processAlive(child)) killTree(child, 'SIGKILL');
      }, 5000);
      child.once('close', () => clearTimeout(killTimer));
    }, config.jobTimeoutMs);

    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.on('close', code => {
      clearTimeout(timeout);
      if ((control && control.stop) || killedBy === 'stop') {
        return reject(Object.assign(new Error('stopped'), { code: 'STOPPED' }));
      }
      if (killedBy === 'timeout') {
        return reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
      }

      if (stream && lineBuf.trim()) handleLine(lineBuf);
      const parsed = parseResult(stdout);
      if (parsed) {
        if (parsed.is_error) {
          return reject(Object.assign(
            new Error(parsed.result || 'Zero returned an error'),
            { code: 'ZERO_ERROR', parsed }
          ));
        }
        return resolve({
          text: typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result),
          parsed
        });
      }
      const errText = (stderr || stdout || '').trim();
      reject(Object.assign(
        new Error(errText || `zero exited with code ${code}`),
        { code: 'NO_RESULT', exitCode: code }
      ));
    });
  });
}

function parseResult(stdout) {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === 'result') return parsed;
    } catch (_) {}
  }
  return null;
}

function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(config.zeroBin, args, {
      cwd: opts.cwd || config.workdir,
      env: { ...process.env, HOME, NO_COLOR: '1' },
      timeout: opts.timeout || 60000,
      maxBuffer: 8 * 1024 * 1024
    }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err && !out) return reject(err);
      resolve(out || '(no output)');
    });
  });
}

function runShell(cmd, cwd) {
  return new Promise(resolve => {
    execFile('/bin/sh', ['-c', cmd], {
      cwd,
      env: { ...process.env, HOME, NO_COLOR: '1' },
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024
    }, (err, stdout, stderr) => {
      let out = `${stdout || ''}${stderr || ''}`.trim();
      if (err && !out) out = `exit ${err.code || err.signal || 'error'}`;
      resolve(out || '(no output)');
    });
  });
}

function updateCost(s, parsed) {
  if (!parsed) return;
  const total = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0;
  if (parsed.session_id && parsed.session_id !== s.lastSessionId) {
    s.lastSessionId = parsed.session_id;
    s.lastTotal = 0;
  }
  let delta = total - (s.lastTotal || 0);
  if (delta < 0) delta = total;
  s.lastTotal = total;
  s.lastCallCost = delta;
  s.spent = (s.spent || 0) + delta;
}

function updateUsage(s, parsed) {
  if (!parsed) return;
  const u = parsed.usage || {};
  const tokens =
    (u.input_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.output_tokens || 0);

  if (tokens > 0) s.lastContextTokens = tokens;

  const modelUsage = parsed.modelUsage || {};
  let window = 0;
  for (const entry of Object.values(modelUsage)) {
    if (entry && typeof entry.contextWindow === 'number') {
      window = Math.max(window, entry.contextWindow);
    }
  }
  if (window) s.contextWindow = window;
  s.contextPct = s.contextWindow
    ? Math.min(1, s.lastContextTokens / s.contextWindow)
    : 0;
  s.contextSource = 'bot';
}

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function contextLine(s) {
  if (!s.lastContextTokens) {
    if (s.lastCompactAt) {
      const t = new Date(s.lastCompactAt).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit'
      });
      return `compacted at ${t}`;
    }
    return 'unknown (send a message first)';
  }
  const pct = s.contextWindow ? ` (${(s.contextPct * 100).toFixed(1)}%)` : '';
  const window = s.contextWindow ? ` / ${fmtTokens(s.contextWindow)}` : '';
  return `${fmtTokens(s.lastContextTokens)}${window}${pct}`;
}

async function runCompact(chatId, s, instructions = '') {
  const prompt = instructions ? `/compact ${instructions}` : '/compact';
  log('compact', JSON.stringify({ chatId, instructions: instructions.slice(0, 200) }));

  const control = { stop: false, stream: false };
  const result = await new Promise((resolve, reject) => {
    runZero(prompt, s, child => {
      activeJob = { child, control, chatId, startedAt: Date.now(), label: 'compact', kind: 'compact' };
    }, control).then(resolve, reject);
  });

  updateCost(s, result.parsed);
  s.lastContextTokens = 0;
  s.contextPct = 0;
  s.resumeId = null;
  s.newSession = false;
  s.lastCompactAt = Date.now();
  s.autoCompactFailedAt = 0;
  saveState();
  return result;
}

function latestSessionForCwd(cwd) {
  return discoverSessions(HOME, SESSION_LIST_LIMIT).find(session => session.cwd === cwd) || null;
}

function btwArgs(question, s, sessionId) {
  return [
    '-p', '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--model', s.model,
    '--effort', s.effort,
    '--disallowedTools', 'AskUserQuestion',
    '--append-system-prompt', TELEGRAM_SYSTEM_PROMPT + thinkingLanguagePrompt(s),
    '-r', sessionId,
    // Read the current conversation without writing a new session. A persisted
    // fork would clutter /sessions and could be picked as the next BTW source.
    '--no-session-persistence',
    '--', promptWithThinkingLanguage(question, s)
  ];
}

function runBtwZero(args, cwd, onChild) {
  return new Promise((resolve, reject) => {
    const child = execFile(config.zeroBin, args, {
      cwd,
      env: {
        ...process.env,
        HOME,
        NO_COLOR: '1',
        ZERO_BRIDGE_CHILD: '1',
        DISABLE_AUTO_COMPACT: '1'
      },
      detached: true,
      timeout: BTW_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024
    }, (err, stdout, stderr) => {
      const parsed = parseResult(stdout || '');
      if (parsed) {
        if (parsed.is_error) {
          return reject(Object.assign(
            new Error(parsed.result || 'Zero returned an error'),
            { code: 'ZERO_ERROR', parsed }
          ));
        }
        return resolve({
          text: typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result),
          parsed
        });
      }
      if (err) {
        if (err.killed) {
          // Make sure tool subprocesses in the detached group also stop.
          killTree(child, 'SIGTERM');
          return reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
        }
        const detail = (stderr || stdout || err.message || '').trim();
        return reject(Object.assign(new Error(detail || 'btw failed'), { code: 'NO_RESULT' }));
      }
      reject(Object.assign(new Error('btw returned no result'), { code: 'NO_RESULT' }));
    });
    if (onChild) onChild(child);
  });
}

// A BTW run is read-only: spend is tracked, but the chat's cost/session
// pointer, context counters, and resume state are untouched.
function addOneOffCost(s, parsed) {
  const total = parsed && typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0;
  if (!(total > 0)) return;
  s.spent = (s.spent || 0) + total;
  s.lastCallCost = total;
  saveState();
}

async function runBtw(chatId, s, question) {
  const prompt = String(question || '').trim();
  if (!prompt) {
    return send(chatId,
      '💭 Usage: /btw <question>\nExample: /btw what does this error mean?');
  }

  const key = String(chatId);
  if (btwJobs.has(key)) {
    return send(chatId, '💭 A BTW question is already running. Wait for it or use /stop.');
  }

  const latest = latestSessionForCwd(s.cwd);
  const inFlight = activeJob && activeJob.control && activeJob.control.sessionId;
  // Prefer the session the user explicitly resumed, then the session ID Zero
  // reported for the in-flight job, then the last completed bot session.
  // Never resurrect a session after /new when nothing has run yet.
  const sessionId =
    s.resumeId ||
    inFlight ||
    s.lastSessionId ||
    (activeJob && latest && latest.id) ||
    (!s.newSession && latest && latest.id) ||
    null;
  if (!sessionId) {
    return send(chatId, '💭 No session yet. Send a regular message first.');
  }

  const stopTyping = typingLoop(chatId);
  try {
    const result = await runBtwZero(btwArgs(prompt, s, sessionId), s.cwd, child => {
      btwJobs.set(key, child);
    });
    addOneOffCost(s, result.parsed);

    const parsed = extractFileMarkers(result.text);
    const cost = result.parsed && typeof result.parsed.total_cost_usd === 'number'
      ? `\n\n_btw cost: ${fmtCost(result.parsed.total_cost_usd)}_`
      : '';
    await sendFormatted(chatId, `💭 **BTW**\n\n${parsed.text || '(no output)'}${cost}`);
    for (const file of parsed.files) {
      await sendFileToTelegram(chatId, file, s);
    }
  } catch (e) {
    if (btwCancelled.has(key)) {
      // /stop already reported the interruption; stay quiet here.
    } else if (e.code === 'TIMEOUT') {
      await send(chatId, `⏱️ BTW timed out after ${fmtDuration(BTW_TIMEOUT_MS)}.`);
    } else {
      log('btw failed:', e.message);
      await send(chatId, redact(`❌ BTW failed: ${e.message}`).slice(0, 1000));
    }
  } finally {
    stopTyping();
    btwJobs.delete(key);
    btwCancelled.delete(key);
  }
}

async function maybeAutoCompact(chatId, s) {
  if (!s.autoCompact || s.newSession || !s.contextWindow) return;
  if (s.contextPct < s.autoCompactThreshold) return;
  if (Date.now() - (s.lastCompactAt || 0) < 5 * 60 * 1000) return;
  if (Date.now() - (s.autoCompactFailedAt || 0) < 5 * 60 * 1000) return;

  const pct = (s.contextPct * 100).toFixed(1);
  const threshold = Math.round(s.autoCompactThreshold * 100);
  try {
    await runCompact(chatId, s);
    await send(chatId,
      `🗜️ Auto-compacted context at ${pct}% (threshold ${threshold}%).`);
  } catch (e) {
    if (e.code === 'STOPPED') return;
    s.autoCompactFailedAt = Date.now();
    saveState();
    log('auto-compact failed:', e.message);
    await send(chatId, `⚠️ Auto-compact failed: ${redact(e.message).slice(0, 500)}`);
  }
}

// ----------------------------------------------------------------- Attachments
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const req = https.get(url, { agent: false }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        out.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        return reject(new Error(`download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
    });
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
    req.on('error', err => {
      out.close();
      try { fs.unlinkSync(dest); } catch (_) {}
      reject(err);
    });
  });
}

async function downloadAttachment(message, cwd) {
  let fileId;
  let name;
  if (Array.isArray(message.photo) && message.photo.length) {
    fileId = message.photo[message.photo.length - 1].file_id;
    name = `photo_${message.message_id}.jpg`;
  } else if (message.document) {
    fileId = message.document.file_id;
    name = message.document.file_name || `document_${message.message_id}`;
  } else if (message.voice) {
    fileId = message.voice.file_id;
    name = `voice_${message.message_id}.ogg`;
  } else if (message.audio) {
    fileId = message.audio.file_id;
    name = message.audio.file_name || `audio_${message.message_id}.mp3`;
  } else if (message.video) {
    fileId = message.video.file_id;
    name = message.video.file_name || `video_${message.message_id}.mp4`;
  } else {
    return null;
  }

  const meta = await api('getFile', { file_id: fileId });
  if (meta.file_size && meta.file_size > config.maxFileBytes) {
    throw new Error(`file too large (${meta.file_size} bytes)`);
  }
  const safe = path.basename(name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  const uploadDir = path.join(cwd, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const dest = path.join(uploadDir, `${Date.now()}_${safe}`);
  await downloadFile(`https://api.telegram.org/file/bot${config.token}/${meta.file_path}`, dest);
  const size = fs.statSync(dest).size;
  return {
    path: dest,
    mime: message.document?.mime_type || 'application/octet-stream',
    size
  };
}

function buildPrompt(message, attachment) {
  const parts = [];
  if (message.reply_to_message) {
    const quoted = message.reply_to_message.text || message.reply_to_message.caption || '';
    if (quoted) parts.push(`[Replying to: "${quoted.slice(0, 600)}"]`);
  }
  if (attachment) {
    const isImage = attachment.mime.startsWith('image/') ||
      /\.(jpe?g|png|webp|gif)$/i.test(attachment.path);
    parts.push(
      `[Telegram attachment saved at: ${attachment.path} (${attachment.mime}, ${attachment.size} bytes)]\n` +
      (isImage
        ? 'Use the Read tool on that path to view the image, then answer the request.'
        : 'Read the file if relevant (Read for text/images, Bash for other types).')
    );
  }
  if (message.text) parts.push(message.text);
  else if (message.caption) parts.push(message.caption);
  return parts.join('\n\n').trim();
}

// -------------------------------------------------------------------- Commands
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtCost(n) {
  return '$' + (Number(n) || 0).toFixed(6);
}

function resetContext(s) {
  s.lastContextTokens = 0;
  s.contextPct = 0;
  s.contextSource = 'bot';
  s.lastCompactAt = null;
}

function applyResumedContext(s, meta) {
  const tokens = readLastUsage(meta.file);
  s.lastContextTokens = tokens || 0;
  s.contextPct = tokens && s.contextWindow
    ? Math.min(1, tokens / s.contextWindow)
    : 0;
  s.contextSource = tokens ? 'resumed' : 'bot';
  s.lastCompactAt = null;
}

function activateResume(s, meta) {
  s.resumeId = meta.id;
  s.newSession = false;
  s.cwd = meta.cwd;
  s.pendingResume = null;
  applyResumedContext(s, meta);
}

function resumeWarningText(meta, active) {
  const title = oneLine(String(meta.title || '').replace(/`/g, "'"), 80);
  return `⚠️ **This session is active in a terminal**\n\n` +
    `The same session \`${meta.id.slice(0, 8)}\`${title ? ` — ${title}` : ''} is open in a terminal ` +
    `(pid ${active.pid}, \`${displayCwd(active.cwd || meta.cwd)}\`).\n\n` +
    `Resuming it from Telegram can conflict: both processes may write to the same session, and the bot agent will see the terminal context.\n\n` +
    'Recommended: finish or close the terminal session first.';
}

function resumeWarningKeyboard(meta) {
  return {
    inline_keyboard: [[
      { text: '⚠️ Resume anyway', callback_data: `resume-force:${meta.id}` },
      { text: '❌ Cancel', callback_data: 'resume-cancel' }
    ]]
  };
}

function displayCwd(cwd) {
  if (!cwd) return '?';
  if (cwd === HOME) return '~';
  if (cwd.startsWith(HOME + path.sep)) return '~/' + cwd.slice(HOME.length + 1);
  return cwd;
}

// ------------------------------------------------------------ Inline settings
const BUILTIN_MODELS = [
  { value: 'pro', label: 'Pro' },
  { value: 'flash', label: 'Flash' },
  { value: 'lite', label: 'Lite' }
];
const EFFORTS = ['low', 'medium', 'high', 'max'];

function readZeroConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, '.zero', 'config.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

// Built-in tier aliases plus the model list Zero has cached locally.
function modelChoices(s) {
  const seen = new Set();
  const out = [];
  const add = (value, label, description) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ value, label: label || value, description: description || '' });
  };

  BUILTIN_MODELS.forEach(m => add(m.value, m.label));
  const cached = readZeroConfig().additionalModelOptionsCache;
  if (Array.isArray(cached)) {
    for (const m of cached) {
      if (!m) continue;
      if (typeof m === 'string') add(m, m);
      else add(m.value, m.label || m.value, m.description);
    }
  }
  add(s.model, s.model);
  return out;
}

function modelMenu(s) {
  const models = modelChoices(s);
  const rows = [];
  for (let i = 0; i < models.length; i += 2) {
    rows.push(models.slice(i, i + 2).map(m => ({
      text: `${m.value === s.model ? '✅ ' : ''}${clip(m.label, 24)}`,
      callback_data: `model:${m.value}`
    })));
  }
  rows.push([{ text: '⬅️ Settings', callback_data: 'settings:main' }]);
  return { inline_keyboard: rows };
}

function modelText(s) {
  const current = modelChoices(s).find(m => m.value === s.model);
  const desc = current && current.description ? ` — ${current.description}` : '';
  return `🧠 Model\ncurrent: ${s.model}${desc}\n\n` +
    'Tap a model below, or set any provider ID with /model <id>.';
}

async function showModel(chatId, s, editMessageId = null) {
  await showPanel(chatId, modelText(s), modelMenu(s), editMessageId);
}

function effortMenu(s) {
  const rows = [];
  for (let i = 0; i < EFFORTS.length; i += 2) {
    rows.push(EFFORTS.slice(i, i + 2).map(level => ({
      text: `${s.effort === level ? '✅ ' : ''}${level[0].toUpperCase()}${level.slice(1)}`,
      callback_data: `effort:${level}`
    })));
  }
  rows.push([{ text: '⬅️ Settings', callback_data: 'settings:main' }]);
  return { inline_keyboard: rows };
}

function effortText(s) {
  return `⚙️ Effort\ncurrent: ${s.effort}\n\n` +
    '• low — fastest, minimal reasoning\n' +
    '• medium — balanced\n' +
    '• high — deeper reasoning\n' +
    '• max — most thorough, slowest\n\n' +
    'Tap a level to switch, or use /effort <level>.';
}

async function showEffort(chatId, s, editMessageId = null) {
  await showPanel(chatId, effortText(s), effortMenu(s), editMessageId);
}

function recentCwdChoices(s) {
  const out = [];
  const add = p => {
    if (!p || !path.isAbsolute(p) || out.includes(p)) return;
    try {
      if (!fs.statSync(p).isDirectory()) return;
    } catch (_) {
      return;
    }
    out.push(p);
  };
  add(s.cwd);
  add(config.workdir);
  add(HOME);
  for (const x of discoverSessions(HOME, 60)) add(x.cwd);
  return out.slice(0, 9);
}

function cwdMenu(s, options, token) {
  const rows = options.map((p, i) => [{
    text: `${p === s.cwd ? '✅ ' : ''}📁 ${clip(displayCwd(p), 38)}`,
    callback_data: `cwd:${token}:${i}`
  }]);
  rows.push([{ text: '⬅️ Settings', callback_data: 'settings:main' }]);
  return { inline_keyboard: rows };
}

function cwdText(s) {
  return `📁 Working directory\ncurrent: ${s.cwd}\n\n` +
    'Tap a recent folder, or send /cwd /absolute/path.\n' +
    'Changing folders starts a new session.';
}

async function showCwd(chatId, s, editMessageId = null) {
  const options = recentCwdChoices(s);
  const token = Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  for (const [key, entry] of Object.entries(s.cwdMenus)) {
    if (!entry || !Array.isArray(entry.options) || now - (entry.at || 0) > 30 * 60 * 1000) {
      delete s.cwdMenus[key];
    }
  }
  s.cwdMenus[token] = { options, at: now };
  saveState();
  await showPanel(chatId, cwdText(s), cwdMenu(s, options, token), editMessageId);
}

function changeCwd(s, target) {
  s.cwd = target;
  s.newSession = true;
  s.resumeId = null;
  s.pendingResume = null;
  s.cwdMenus = {};
  resetContext(s);
  saveState();
}

function settingsText(s) {
  return `⚙️ Settings\n` +
    `🧠 model: ${s.model}\n` +
    `⚙️ effort: ${s.effort}\n` +
    `📁 folder: ${displayCwd(s.cwd)}\n` +
    `💬 progress: ${s.progressMode}\n` +
    `🔄 auto-compact: ${s.autoCompact ? 'ON' : 'OFF'} ` +
    `(${Math.round(s.autoCompactThreshold * 100)}%)\n\n` +
    'Tap a button to change it — no commands needed.';
}

function settingsMenu(s) {
  return {
    inline_keyboard: [
      [
        { text: `🧠 Model: ${clip(s.model, 20)}`, callback_data: 'settings:model' },
        { text: `⚙️ Effort: ${s.effort}`, callback_data: 'settings:effort' }
      ],
      [{ text: `📁 Folder: ${clip(displayCwd(s.cwd), 32)}`, callback_data: 'settings:cwd' }],
      [
        { text: `💬 Progress: ${s.progressMode}`, callback_data: 'settings:progress' },
        {
          text: `🔄 Auto-compact: ${s.autoCompact ? 'ON' : 'OFF'}`,
          callback_data: 'settings:autocompact'
        }
      ]
    ]
  };
}

async function showSettings(chatId, s, editMessageId = null) {
  await showPanel(chatId, settingsText(s), settingsMenu(s), editMessageId);
}

async function showPanel(chatId, text, markup, editMessageId = null) {
  if (editMessageId) {
    try {
      await api('editMessageText', {
        chat_id: chatId,
        message_id: editMessageId,
        text,
        reply_markup: markup,
        disable_web_page_preview: true
      });
      return;
    } catch (_) {}
  }
  await send(chatId, text, { reply_markup: markup });
}

function shortSessionLabel(x) {
  const date = new Date(x.mtime).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const project = clip(displayCwd(x.cwd), 20);
  const title = clip(String(x.title || '').replace(/\s+/g, ' ').trim(), 20) || 'untitled';
  return clip(`▶️ ${x.index}. ${date} · ${project} · ${title}`, 60);
}

function sessionsKeyboard(slice, page, pages, mode) {
  const rows = slice.map(x => [{
    text: shortSessionLabel(x),
    callback_data: `resume:${x.id}`
  }]);

  const nav = [];
  if (page > 0) {
    nav.push({ text: '⬅️ Newer', callback_data: `sesspage:${mode}:${page - 1}` });
  }
  if (page < pages - 1) {
    nav.push({ text: 'Older ➡️', callback_data: `sesspage:${mode}:${page + 1}` });
  }
  if (nav.length) rows.push(nav);

  rows.push([{ text: '🆕 Start a new session', callback_data: 'new' }]);
  return { inline_keyboard: rows };
}

async function showSessionPicker(chatId, mode = 'sessions', page = 0, editMessageId = null) {
  const list = discoverSessions(HOME, SESSION_LIST_LIMIT);
  if (!list.length) {
    return send(chatId, 'No sessions found in any project yet.');
  }

  const pages = Math.max(1, Math.ceil(list.length / SESSION_PAGE_SIZE));
  const current = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const slice = list.slice(
    current * SESSION_PAGE_SIZE,
    (current + 1) * SESSION_PAGE_SIZE
  );

  const title = mode === 'resume'
    ? '⏪ Pick a session to resume.'
    : '🗂️ Recent sessions across all projects';
  const body = `${title}\n` +
    `Page ${current + 1}/${pages} · newest first. ` +
    'Tap a session — it activates immediately.';

  await showPanel(chatId, body, sessionsKeyboard(slice, current, pages, mode), editMessageId);
}

function compactMenu(s) {
  return {
    inline_keyboard: [
      [{ text: '🗜️ Compact now', callback_data: 'compact:now' }],
      [{
        text: `🔄 Auto-compact: ${s.autoCompact ? 'ON' : 'OFF'} ` +
          `(${Math.round(s.autoCompactThreshold * 100)}%)`,
        callback_data: 'compact:auto'
      }],
      [{ text: '⬅️ Settings', callback_data: 'settings:main' }]
    ]
  };
}

function compactText(s) {
  const last = s.lastCompactAt
    ? new Date(s.lastCompactAt).toLocaleString('en-GB')
    : 'never';
  return `🗜️ Compact & auto-compact\n` +
    `context: ${contextLine(s)}\n` +
    `auto-compact: ${s.autoCompact ? 'ON' : 'OFF'} ` +
    `(${Math.round(s.autoCompactThreshold * 100)}%)\n` +
    `last compact: ${last}\n\n` +
    'Compact now summarizes the conversation. Auto-compact runs after a reply ' +
    'when context crosses the threshold.';
}

async function showCompactMenu(chatId, s, editMessageId = null) {
  await showPanel(chatId, compactText(s), compactMenu(s), editMessageId);
}

function autoCompactMenu(s) {
  const mark = pct =>
    Math.abs(s.autoCompactThreshold - pct / 100) < 0.001 ? '✅ ' : '';
  return {
    inline_keyboard: [
      [s.autoCompact
        ? { text: '⛔ Turn off', callback_data: 'ac:off' }
        : { text: '✅ Turn on', callback_data: 'ac:on' }],
      [
        { text: `${mark(60)}60%`, callback_data: 'ac:t:60' },
        { text: `${mark(75)}75%`, callback_data: 'ac:t:75' },
        { text: `${mark(85)}85%`, callback_data: 'ac:t:85' }
      ],
      [{ text: '⬅️ Settings', callback_data: 'settings:main' }]
    ]
  };
}

function autoCompactText(s) {
  const last = s.lastCompactAt
    ? new Date(s.lastCompactAt).toLocaleString('en-GB')
    : 'never';
  return `🗜️ Auto-compact\n` +
    `status: ${s.autoCompact ? 'ON' : 'OFF'}\n` +
    `threshold: ${Math.round(s.autoCompactThreshold * 100)}%\n` +
    `context: ${contextLine(s)}\n` +
    `last compact: ${last}\n\n` +
    'When enabled, the bridge runs /compact after a reply once context crosses the threshold.';
}

async function showAutoCompact(chatId, s, editMessageId = null) {
  await showPanel(chatId, autoCompactText(s), autoCompactMenu(s), editMessageId);
}

function progressMenu(s) {
  const mark = mode => s.progressMode === mode ? '✅ ' : '';
  return {
    inline_keyboard: [
      [{ text: `${mark('full')}🧠🔧 Thinking + tools stream`, callback_data: 'progress:full' }],
      [{ text: `${mark('messages')}🔧 Tools stream, thinking message`, callback_data: 'progress:messages' }],
      [{ text: `${mark('stream')}🔧 Tools only stream`, callback_data: 'progress:stream' }],
      [{ text: `${mark('off')}🚫 Off (final only)`, callback_data: 'progress:off' }],
      [{ text: '⬅️ Settings', callback_data: 'settings:main' }]
    ]
  };
}

function progressText(s) {
  return `💬 Progress mode: ${s.progressMode}\n\n` +
    '• full — thinking + tools stream in one message; answer steps separate\n' +
    '• messages — tools stream in one message; thinking + answer steps separate (default)\n' +
    '• stream — only tools stream; thinking hidden; answer steps separate\n' +
    '• off — only the final answer\n\n' +
    'In full, messages, and stream, answer steps are separate messages.';
}

async function showProgress(chatId, s, editMessageId = null) {
  await showPanel(chatId, progressText(s), progressMenu(s), editMessageId);
}

function checkJsonFile(file) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return '✅ OK';
  } catch (e) {
    return e.code === 'ENOENT' ? '— not present' : `❌ ${e.message}`;
  }
}

function recentLogIssues() {
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-300);
    const bad = lines.filter(line => /error|failed|ETIMEDOUT|409 Conflict/i.test(line));
    return { count: bad.length, last: bad.length ? bad[bad.length - 1] : '' };
  } catch (_) {
    return { count: 0, last: '' };
  }
}

function diskInfo() {
  try {
    const st = fs.statfsSync(RUNTIME_DIR);
    const free = st.bavail * st.bsize;
    const total = st.blocks * st.bsize;
    return `${(free / 1e9).toFixed(1)} GB free / ${(total / 1e9).toFixed(1)} GB`;
  } catch (_) {
    return 'unknown';
  }
}

async function bridgeDoctor(s) {
  const [zeroVersion, mcpOut, agentsOut] = await Promise.all([
    runCli(['--version'], { timeout: 20000 }).catch(e => `error: ${e.message}`),
    runCli(['mcp', 'list'], { timeout: 30000 }).catch(e => `error: ${e.message}`),
    runCli(['agents'], { timeout: 20000 }).catch(e => `error: ${e.message}`)
  ]);

  const firstLine = text => String(text || '').trim().split('\n')[0] || '(no output)';
  const mode = s.resumeId
    ? `resume ${s.resumeId}`
    : (s.newSession ? 'new (next)' : 'continue (-c)');
  const issues = recentLogIssues();
  const lastIssue = issues.last
    ? `\n• last: \`${oneLine(issues.last, 150).replace(/`/g, "'")}\``
    : '';

  return [
    '🩺 **Health check**',
    '',
    '**Bridge**',
    `• version: \`v${VERSION}\``,
    `• uptime: ${fmtDuration(Date.now() - startedAt)}`,
    `• pid: \`${process.pid}\``,
    `• workdir: \`${s.cwd}\``,
    `• mode: ${mode}`,
    '',
    '**Zero CLI**',
    `• version: \`${firstLine(zeroVersion)}\``,
    `• binary: \`${config.zeroBin}\``,
    `• node: \`${process.version}\``,
    `• agents: ${firstLine(agentsOut)}`,
    `• MCP: ${oneLine(mcpOut, 200) || '(no output)'}`,
    '',
    '**Config**',
    `• \`~/.zero/settings.json\`: ${checkJsonFile(path.join(HOME, '.zero', 'settings.json'))}`,
    `• \`~/.zero/config.json\`: ${checkJsonFile(path.join(HOME, '.zero', 'config.json'))}`,
    `• bot token: ${config.token ? 'configured ✅' : 'missing ❌'}`,
    `• allowed chats: ${allowedChatIds.size}`,
    '',
    '**Session**',
    `• model: \`${s.model}\` (${s.effort})`,
    `• auto-compact: ${s.autoCompact ? 'ON' : 'OFF'} (${Math.round(s.autoCompactThreshold * 100)}%)`,
    `• context: ${contextLine(s)}`,
    '',
    '**Runtime**',
    `• disk: ${diskInfo()}`,
    `• log issues (last 300 lines): ${issues.count}${lastIssue}`,
    '',
    'ℹ️ Full `zero doctor` is an interactive terminal UI. Run it in a terminal for the complete report.'
  ].join('\n');
}

async function handleCommand(chatId, text, s) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1).join(' ');
  const args = parts.slice(1);

  switch (cmd) {
    case '/start':
      return send(chatId, WELCOME, { reply_markup: mainKeyboard() });

    case '/help':
      return send(chatId, HELP, { reply_markup: mainKeyboard() });

    case '/menu':
      return send(chatId, '🎛️ Keyboard menu shown.', { reply_markup: mainKeyboard() });

    case '/settings':
      return showSettings(chatId, s);

    case '/new':
    case '/clear':
      s.newSession = true;
      s.resumeId = null;
      s.lastSessionId = null;
      s.lastTotal = 0;
      s.pendingResume = null;
      resetContext(s);
      saveState();
      return send(chatId, '🆕 New conversation ready. The next message starts a fresh Zero session.');

    case '/resume': {
      if (!rest) {
        return showSessionPicker(chatId, 'resume');
      }

      const all = discoverSessions(HOME, SESSION_LIST_LIMIT);
      let meta;
      if (/^\d+$/.test(rest)) {
        meta = all[Number(rest) - 1];
      } else {
        meta = findSessionById(HOME, rest) ||
          all.find(x => x.id.startsWith(rest));
      }
      if (!meta) {
        return send(chatId, 'Session not found across projects. Use /resume to list.');
      }

      const active = findActiveSession(HOME, meta.id);
      if (active) {
        s.pendingResume = { id: meta.id, cwd: meta.cwd, at: Date.now() };
        saveState();
        return sendFormatted(chatId, resumeWarningText(meta, active),
          { reply_markup: resumeWarningKeyboard(meta) });
      }

      activateResume(s, meta);
      saveState();
      return send(chatId, `⏪ Next message will resume: ${meta.id}\n📁 ${meta.cwd}`);
    }

    case '/sessions':
      return showSessionPicker(chatId, 'sessions');

    case '/compactmenu':
      return showCompactMenu(chatId, s);

    case '/compact': {
      if (s.newSession && !s.lastSessionId) {
        return send(chatId, 'No active session to compact yet. Send a message first.');
      }
      const queued = processing || jobQueue.length > 0;
      enqueue(chatId, rest, 'compact', 'compact');
      return send(chatId, queued
        ? '🗜️ Compact queued. It will run after the current task.'
        : (rest
          ? `🗜️ Compacting context with instructions: ${rest}`
          : '🗜️ Compacting context…'));
    }

    case '/autocompact': {
      const [sub, value] = rest.split(/\s+/).filter(Boolean);
      if (sub === 'on' || sub === 'off') {
        s.autoCompact = sub === 'on';
        saveState();
        return send(chatId,
          `🔄 Auto-compact ${s.autoCompact ? 'enabled' : 'disabled'} ` +
          `(threshold ${Math.round(s.autoCompactThreshold * 100)}%).`);
      }
      if (sub === 'threshold' && value) {
        let pct = Number(value);
        if (pct > 1) pct = pct / 100;
        if (!(pct > 0.1 && pct < 0.98)) {
          return send(chatId, 'Threshold must be between 11% and 97%.');
        }
        s.autoCompactThreshold = pct;
        saveState();
        return send(chatId, `🔄 Auto-compact threshold → ${Math.round(pct * 100)}%.`);
      }
      return showAutoCompact(chatId, s);
    }

    case '/progress': {
      if (rest) {
        const mode = rest.toLowerCase();
        if (!PROGRESS_MODES.includes(mode)) {
          return send(chatId, 'Usage: /progress full|messages|stream|off');
        }
        s.progressMode = mode;
        s.progressModeExplicit = true;
        saveState();
        return send(chatId, `💬 Progress mode → ${mode}`);
      }
      return showProgress(chatId, s);
    }

    case '/queue':
      return showQueue(chatId);

    case '/btw':
      return runBtw(chatId, s, rest);

    case '/status': {
      const running = activeJob
        ? `yes (${fmtDuration(Date.now() - activeJob.startedAt)})`
        : 'no';
      const mode = s.resumeId
        ? `resume ${s.resumeId}`
        : (s.newSession ? 'new (next)' : 'continue (-c)');
      return send(chatId,
        `📊 Bridge status\n` +
        `bridge: v${VERSION}\n` +
        `model: ${s.model}\n` +
        `effort: ${s.effort}\n` +
        `thinking language: ${s.thinkingLanguage}\n` +
        `folder: ${s.cwd}\n` +
        `session mode: ${mode}\n` +
        `last session: ${s.lastSessionId || '-'}\n` +
        `running: ${running}\n` +
        `queue: ${queueDepth(true)} (${jobQueue.length} waiting)\n` +
        `auto-compact: ${s.autoCompact ? 'ON' : 'OFF'} (${Math.round(s.autoCompactThreshold * 100)}%)\n` +
        `context: ${contextLine(s)}${s.contextSource === 'resumed'
          ? ' (last known from session)'
          : ' (bot session)'}\n` +
        `session cost: ${fmtCost(s.lastTotal)} | total: ${fmtCost(s.spent)}\n` +
        `uptime: ${fmtDuration(Date.now() - startedAt)}`
      );
    }

    case '/model':
      if (!rest) return showModel(chatId, s);
      s.model = rest;
      saveState();
      return send(chatId, `🧠 Model → ${s.model}`);

    case '/effort':
      if (!rest) return showEffort(chatId, s);
      if (!EFFORTS.includes(rest.toLowerCase())) {
        return send(chatId, 'Effort must be low, medium, high, or max.');
      }
      s.effort = rest.toLowerCase();
      saveState();
      return send(chatId, `⚙️ Effort → ${s.effort}`);

    case '/cwd': {
      if (!rest) return showCwd(chatId, s);
      const target = path.resolve(rest.replace(/^~(?=$|\/)/, HOME));
      let st;
      try { st = fs.statSync(target); } catch (_) {
        return send(chatId, `Folder not found: ${target}`);
      }
      if (!st.isDirectory()) return send(chatId, `Not a folder: ${target}`);
      changeCwd(s, target);
      return send(chatId, `📁 Working directory → ${target}\nA new session will start in this folder.`);
    }

    case '/cost':
      return send(chatId,
        `💰 Cost\n` +
        `current session: ${fmtCost(s.lastTotal)}\n` +
        `last call: ${fmtCost(s.lastCallCost)}\n` +
        `total (bridge): ${fmtCost(s.spent)}`
      );

    case '/stop': {
      const btw = btwJobs.get(String(chatId));
      if (btw) {
        btwCancelled.add(String(chatId));
        killTree(btw, 'SIGINT');
        btwJobs.delete(String(chatId));
      }
      if (!activeJob) {
        const queued = jobQueue.length;
        jobQueue = [];
        queueChanged();
        const reply_markup = mainKeyboard(false);
        if (queued) {
          return send(chatId, `⏹️ Queue cleared (${queued} job${queued === 1 ? '' : 's'}).`,
            { reply_markup });
        }
        return send(chatId, btw ? '⏹️ BTW interrupted.' : 'No task is running.', { reply_markup });
      }
      requestStop(activeJob);
      const queued = jobQueue.length;
      jobQueue = [];
      queueChanged();
      return send(chatId,
        `⏹️ Interrupting${queued ? ` and clearing ${queued} queued job${queued === 1 ? '' : 's'}` : ''}` +
        `${btw ? ' and stopping BTW' : ''}. You can send your next message now.`,
        { reply_markup: mainKeyboard(false) });
    }

    case '/ping':
      return send(chatId, `🏓 pong — uptime ${fmtDuration(Date.now() - startedAt)}`);

    case '/id':
      return send(chatId, `Chat ID: ${chatId}`);

    case '/mcp':
      return send(chatId, await runCli(['mcp', ...(args.length ? args : ['list'])]));

    case '/plugin':
    case '/plugins':
      return send(chatId, await runCli(['plugin', ...(args.length ? args : ['list'])]));

    case '/agents':
      return send(chatId, await runCli(['agents']));

    case '/doctor':
      return sendFormatted(chatId, await bridgeDoctor(s));

    case '/version': {
      const zeroVersion = await runCli(['--version']);
      return send(chatId, `Bridge: v${VERSION}\nZero CLI: ${zeroVersion}`);
    }

    case '/config': {
      const safe = { version: VERSION, ...config, token: config.token ? '<redacted>' : '' };
      return send(chatId, '```\n' + JSON.stringify(safe, null, 2) + '\n```');
    }

    default:
      return null; // Unknown slash command: forward to Zero.
  }
}

// ----------------------------------------------------------------------- Jobs
function enqueue(chatId, prompt, label, kind = 'zero', options = {}) {
  if (jobQueue.length >= MAX_QUEUE) {
    send(chatId,
      `⚠️ Queue is full (${MAX_QUEUE} jobs). Wait for the running job or use /stop.`)
      .catch(e => log('queue notice failed:', e.message));
    return null;
  }

  const job = { id: ++jobSeq, chatId, prompt, label, kind, queuedAt: Date.now() };
  const busy = processing;
  jobQueue.push(job);

  if (busy && options.notify === true) {
    send(chatId, `📋 Queued #${job.id} · position ${jobQueue.length} — ${oneLine(label, 80)}`,
      { reply_markup: mainKeyboard(true) })
      .catch(e => log('queue notice failed:', e.message));
  }

  pump();
  queueChanged();
  return job;
}

function queueDepth(includeActive = true) {
  const active = includeActive && (processing || activeJob) ? 1 : 0;
  return active + jobQueue.length;
}

function queueInlineKeyboard() {
  return {
    inline_keyboard: [[{
      text: `${KB.queue} (${queueDepth(true)})`,
      callback_data: 'queue:open'
    }]]
  };
}

function queueChanged() {
  if (!activeProgress || typeof activeProgress.refresh !== 'function') return;
  try {
    activeProgress.refresh();
  } catch (e) {
    log('queue refresh failed:', e.message);
  }
}

function queueSnapshot() {
  const now = Date.now();
  const lines = [];
  if (activeJob) {
    lines.push(
      `▶️ running: ${clip(oneLine(activeJob.label || activeJob.kind || 'job', 70), 70)} · ` +
      `${fmtDuration(now - activeJob.startedAt)}`
    );
  } else if (processing) {
    lines.push('▶️ running: shell');
  } else {
    lines.push('▶️ running: —');
  }
  lines.push(`⏳ waiting: ${jobQueue.length}`);
  if (btwJobs.size) lines.push(`💭 btw: ${btwJobs.size} running`);
  jobQueue.slice(0, 10).forEach((job, index) => {
    const age = fmtDuration(Math.max(0, now - job.queuedAt));
    lines.push(
      `${index + 1}. #${job.id} · ${job.kind} · queued ${age} ago — ` +
      `${clip(oneLine(job.label, 70), 70)}`
    );
  });
  if (jobQueue.length > 10) lines.push(`… and ${jobQueue.length - 10} more`);
  return lines.join('\n');
}

function queueMenu() {
  const rows = jobQueue.slice(0, 10).map(job => [{
    text: `🗑 #${job.id} ${clip(oneLine(job.label, 40), 40)}`,
    callback_data: `queue:rm:${job.id}`
  }]);
  if (jobQueue.length) {
    rows.push([{
      text: `🧹 Clear all (${jobQueue.length})`,
      callback_data: 'queue:clear'
    }]);
  }
  rows.push([{ text: '🔄 Refresh', callback_data: 'queue:show' }]);
  return { inline_keyboard: rows };
}

async function showQueue(chatId, editMessageId = null) {
  await showPanel(chatId, `📋 Job queue\n\n${queueSnapshot()}`, queueMenu(), editMessageId);
}

async function pump() {
  if (processing || stopped) return;
  processing = true;
  try {
    while (jobQueue.length && !stopped) {
      const job = jobQueue.shift();
      queueChanged();
      await runJob(job);
    }
  } finally {
    processing = false;
  }
}

async function runJob(job) {
  const s = sessionFor(job.chatId);
  const stopTyping = typingLoop(job.chatId);
  let progress = null;
  try {
    if (job.kind === 'shell') {
      const out = await runShell(job.prompt, s.cwd);
      await send(job.chatId, out);
      return;
    }

    if (job.kind === 'compact') {
      if (s.newSession && !s.lastSessionId) {
        await send(job.chatId, 'No active session to compact yet. Send a message first.');
        return;
      }
      const result = await runCompact(job.chatId, s, job.prompt);
      const extra = result.text && result.text.trim() ? `\n\n${result.text.trim()}` : '';
      await send(job.chatId, `✅ Context compacted.${extra}`);
      return;
    }

    progress = createProgress(job.chatId, s.progressMode);
    activeProgress = progress;
    const control = { stop: false, progress };
    const result = await new Promise((resolve, reject) => {
      runZero(job.prompt, s, child => {
        activeJob = {
          child,
          control,
          chatId: job.chatId,
          startedAt: Date.now(),
          label: job.label,
          kind: job.kind
        };
      }, control).then(resolve, reject);
    });

    updateCost(s, result.parsed);
    updateUsage(s, result.parsed);
    s.newSession = false;
    s.resumeId = null;
    saveState();

    const extracted = extractFileMarkers(result.text);
    let text = extracted.text;
    if (!text.trim()) text = extracted.files.length ? '' : '(no output)';
    const denied = result.parsed && Array.isArray(result.parsed.permission_denials)
      ? result.parsed.permission_denials.length
      : 0;
    if (denied) text += `\n\n⚠️ ${denied} tool call${denied === 1 ? '' : 's'} denied by the permission system.`;

    await progress.flush();
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const finalAlreadySent = progress.getLastTextOk() &&
      normalize(text) === normalize(progress.getLastText());
    await progress.finish({ ok: true });
    if (!finalAlreadySent && text) {
      await sendFormatted(job.chatId, text, { reply_markup: mainKeyboard(false) });
    }
    for (const file of extracted.files) {
      await sendFileToTelegram(job.chatId, file, s);
    }
    await maybeAutoCompact(job.chatId, s);
  } catch (e) {
    if (progress) {
      await progress.finish({
        ok: false,
        status: e.code === 'STOPPED' ? 'stopped'
          : e.code === 'TIMEOUT' ? 'timeout'
          : 'error'
      });
    }
    const reply_markup = mainKeyboard(false);
    if (e.code === 'STOPPED') {
      await send(job.chatId, '⏹️ Cancelled.', { reply_markup });
    } else if (e.code === 'TIMEOUT') {
      await send(job.chatId,
        `⏱️ Timed out after ${fmtDuration(config.jobTimeoutMs)}. Try /stop and break the task into smaller steps.`,
        { reply_markup });
    } else {
      log('job failed:', e.message);
      await send(job.chatId, `❌ Error: ${redact(e.message).slice(0, 3500)}`, { reply_markup });
    }
  } finally {
    stopTyping();
    activeJob = null;
    activeProgress = null;
  }
}

// -------------------------------------------------------------------- Inbound
async function removeInline(chatId, messageId) {
  try {
    await api('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    });
  } catch (_) {}
}

async function handleCallback(cq) {
  const msg = cq.message;
  const chatId = msg && msg.chat && msg.chat.id;
  const fromId = cq.from && cq.from.id;
  if (!chatId || (!allowedChatIds.has(String(chatId)) && !allowedChatIds.has(String(fromId)))) {
    try {
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: '⛔ Unauthorized' });
    } catch (_) {}
    return;
  }

  const s = sessionFor(chatId);
  const data = cq.data || '';
  try {
    if (data.startsWith('queue:')) {
      const action = data.slice('queue:'.length);
      if (action === 'open') {
        await api('answerCallbackQuery', { callback_query_id: cq.id });
        return showQueue(chatId);
      }
      if (action === 'show') {
        await api('answerCallbackQuery', { callback_query_id: cq.id });
        return showQueue(chatId, msg.message_id);
      }
      if (action === 'clear') {
        const before = jobQueue.length;
        jobQueue = jobQueue.filter(job => String(job.chatId) !== String(chatId));
        const removed = before - jobQueue.length;
        queueChanged();
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: removed
            ? `Cleared ${removed} queued job${removed === 1 ? '' : 's'}`
            : 'Queue is already empty'
        });
        return showQueue(chatId, msg.message_id);
      }
      if (action.startsWith('rm:')) {
        const id = Number(action.slice(3));
        const index = jobQueue.findIndex(
          job => job.id === id && String(job.chatId) === String(chatId)
        );
        if (index === -1) {
          await api('answerCallbackQuery', {
            callback_query_id: cq.id,
            text: 'That job is no longer queued'
          });
          return showQueue(chatId, msg.message_id);
        }
        const [removed] = jobQueue.splice(index, 1);
        queueChanged();
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: `Removed #${removed.id}`
        });
        return showQueue(chatId, msg.message_id);
      }
      await api('answerCallbackQuery', { callback_query_id: cq.id });
      return;
    }

    if (data.startsWith('settings:')) {
      const panel = data.slice('settings:'.length);
      await api('answerCallbackQuery', { callback_query_id: cq.id });
      if (panel === 'model') return showModel(chatId, s, msg.message_id);
      if (panel === 'effort') return showEffort(chatId, s, msg.message_id);
      if (panel === 'cwd') return showCwd(chatId, s, msg.message_id);
      if (panel === 'progress') return showProgress(chatId, s, msg.message_id);
      if (panel === 'autocompact') return showAutoCompact(chatId, s, msg.message_id);
      return showSettings(chatId, s, msg.message_id);
    }

    if (data.startsWith('compact:')) {
      const action = data.slice('compact:'.length);
      if (action === 'now') {
        if (s.newSession && !s.lastSessionId) {
          await api('answerCallbackQuery', {
            callback_query_id: cq.id,
            text: 'No active session to compact yet'
          });
          return;
        }
        const queued = processing || jobQueue.length > 0;
        enqueue(chatId, '', 'compact', 'compact');
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: queued ? 'Compact queued' : 'Compacting…'
        });
        await send(chatId, queued
          ? '🗜️ Compact queued. It will run after the current task.'
          : '🗜️ Compacting context…');
        return;
      }
      if (action === 'auto') {
        await api('answerCallbackQuery', { callback_query_id: cq.id });
        await showAutoCompact(chatId, s, msg.message_id);
        return;
      }
      await api('answerCallbackQuery', { callback_query_id: cq.id });
      return;
    }

    if (data.startsWith('model:')) {
      const value = data.slice('model:'.length);
      if (!value || !modelChoices(s).some(m => m.value === value)) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Unknown model' });
        return;
      }
      if (s.model === value) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Already selected' });
        return;
      }
      s.model = value;
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: `🧠 ${value}` });
      await showModel(chatId, s, msg.message_id);
      return;
    }

    if (data.startsWith('effort:')) {
      const level = data.slice('effort:'.length);
      if (!EFFORTS.includes(level)) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Invalid effort' });
        return;
      }
      if (s.effort === level) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Already selected' });
        return;
      }
      s.effort = level;
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: `⚙️ Effort: ${level}` });
      await showEffort(chatId, s, msg.message_id);
      return;
    }

    if (data.startsWith('cwd:')) {
      const [, token, rawIndex] = data.split(':');
      const index = Number(rawIndex);
      const entry = s.cwdMenus[token];
      const target = entry && Array.isArray(entry.options) && Number.isInteger(index)
        ? entry.options[index]
        : null;
      if (!target) {
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: 'Folder list expired. Use /cwd again.'
        });
        return;
      }
      let st;
      try { st = fs.statSync(target); } catch (_) {
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: 'Folder no longer exists'
        });
        return;
      }
      if (!st.isDirectory()) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not a folder' });
        return;
      }
      changeCwd(s, target);
      await api('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: `📁 ${displayCwd(target)}`
      });
      await removeInline(chatId, msg.message_id);
      await send(chatId,
        `📁 Working directory → ${target}\nA new session will start in this folder.`,
        { reply_markup: mainKeyboard() });
      return;
    }

    if (data.startsWith('ac:')) {
      const action = data.slice(3);
      if (action === 'on' || action === 'off') {
        const wanted = action === 'on';
        if (s.autoCompact === wanted) {
          await api('answerCallbackQuery', {
            callback_query_id: cq.id,
            text: wanted ? 'Already enabled' : 'Already disabled'
          });
          return;
        }
        s.autoCompact = wanted;
        saveState();
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: s.autoCompact ? 'Auto-compact enabled' : 'Auto-compact disabled'
        });
      } else if (action.startsWith('t:')) {
        const pct = Number(action.slice(2)) / 100;
        if (!(pct > 0.1 && pct < 0.98)) {
          await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Invalid threshold' });
          return;
        }
        if (Math.abs(s.autoCompactThreshold - pct) < 0.001) {
          await api('answerCallbackQuery', {
            callback_query_id: cq.id,
            text: `Already ${Math.round(pct * 100)}%`
          });
          return;
        }
        s.autoCompactThreshold = pct;
        saveState();
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: `Threshold set to ${Math.round(pct * 100)}%`
        });
      } else {
        await api('answerCallbackQuery', { callback_query_id: cq.id });
        return;
      }
      await showAutoCompact(chatId, s, msg.message_id);
      return;
    }

    if (data.startsWith('progress:')) {
      const mode = data.slice('progress:'.length);
      if (!PROGRESS_MODES.includes(mode)) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Invalid mode' });
        return;
      }
      if (s.progressMode === mode) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: `Already ${mode}` });
        return;
      }
      s.progressMode = mode;
      s.progressModeExplicit = true;
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: `Progress mode: ${mode}` });
      await showProgress(chatId, s, msg.message_id);
      return;
    }

    if (data.startsWith('sesspage:')) {
      const [, mode, rawPage] = data.split(':');
      await api('answerCallbackQuery', { callback_query_id: cq.id });
      return showSessionPicker(
        chatId,
        mode === 'resume' ? 'resume' : 'sessions',
        Number(rawPage),
        msg.message_id
      );
    }

    if (data === 'new') {
      s.newSession = true;
      s.resumeId = null;
      s.lastSessionId = null;
      s.lastTotal = 0;
      s.pendingResume = null;
      resetContext(s);
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: '🆕 New session ready' });
      await removeInline(chatId, msg.message_id);
      await send(chatId,
        '🆕 New conversation ready. The next message starts a fresh Zero session.',
        { reply_markup: mainKeyboard() });
      return;
    }

    if (data.startsWith('resume-force:')) {
      const id = data.slice('resume-force:'.length);
      const pending = s.pendingResume;
      if (!pending || pending.id !== id || Date.now() - pending.at > 5 * 60 * 1000) {
        s.pendingResume = null;
        saveState();
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: 'Confirmation expired. Use /resume again.'
        });
        await removeInline(chatId, msg.message_id);
        return;
      }

      const meta = findSessionById(HOME, id);
      if (!meta) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Session not found' });
        return;
      }

      activateResume(s, meta);
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: '⏪ Session activated' });
      await removeInline(chatId, msg.message_id);
      await send(chatId,
        `⏪ Session active: ${id.slice(0, 8)}\n📁 ${meta.cwd}\n` +
        'Warning: the terminal session may still be active. Avoid using it there while the bot runs.',
        { reply_markup: mainKeyboard() });
      return;
    }

    if (data === 'resume-cancel') {
      s.pendingResume = null;
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Cancelled' });
      await removeInline(chatId, msg.message_id);
      await send(chatId, 'Resume cancelled. The terminal session was left untouched.');
      return;
    }

    if (data.startsWith('resume:')) {
      const id = data.slice('resume:'.length);
      const meta = findSessionById(HOME, id) ||
        discoverSessions(HOME, 100).find(x => x.id === id);
      if (!meta) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Session not found' });
        return;
      }

      const active = findActiveSession(HOME, meta.id);
      if (active) {
        s.pendingResume = { id, cwd: meta.cwd, at: Date.now() };
        saveState();
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: '⚠️ Warning sent'
        });
        await sendFormatted(chatId, resumeWarningText(meta, active),
          { reply_markup: resumeWarningKeyboard(meta) });
        return;
      }

      activateResume(s, meta);
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: '⏪ Session activated' });
      await removeInline(chatId, msg.message_id);
      const title = String(meta.title || '').replace(/\s+/g, ' ').slice(0, 80);
      await send(chatId,
        `⏪ Session active: ${id.slice(0, 8)}${title ? `\n${title}` : ''}\n` +
        `📁 ${meta.cwd}\n` +
        'The next message continues this session. Use /new to start fresh.',
        { reply_markup: mainKeyboard() });
      return;
    }

    await api('answerCallbackQuery', { callback_query_id: cq.id });
  } catch (e) {
    log('callback failed:', e.message);
    try {
      await api('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: `❌ ${e.message.slice(0, 150)}`
      });
    } catch (_) {}
  }
}

async function handleMessage(message) {
  const chatId = message.chat && message.chat.id;
  if (!chatId) return;
  const fromId = message.from && message.from.id;
  if (!allowedChatIds.has(String(chatId)) && !allowedChatIds.has(String(fromId))) {
    log('unauthorized chat', chatId, fromId);
    try { await send(chatId, '⛔ Unauthorized. This chat ID is not allowed.'); } catch (_) {}
    return;
  }

  const s = sessionFor(chatId);
  let text = (message.text || '').trim();
  if (KEYBOARD_MAP[text]) text = KEYBOARD_MAP[text];
  else if (/^📋 Queue( \(\d+\))?$/.test(text)) text = '/queue';

  // Commands are handled immediately so /status and /stop work while busy.
  if (text.startsWith('/')) {
    try {
      const handled = await handleCommand(chatId, text, s);
      if (handled !== null) return;
    } catch (e) {
      log('command failed:', e.message);
      return send(chatId, `❌ ${redact(e.message).slice(0, 3000)}`);
    }
  }

  // Shell passthrough.
  if (text.startsWith('!') && text.length > 1) {
    enqueue(chatId, text.slice(1), 'shell', 'shell', { notify: true });
    return;
  }

  // Attachments.
  let attachment = null;
  try {
    attachment = await downloadAttachment(message, s.cwd);
  } catch (e) {
    log('attachment failed:', e.message);
    await send(chatId, `⚠️ Failed to download attachment: ${e.message}`);
    return;
  }

  const prompt = buildPrompt(message, attachment);
  if (!prompt) return;

  enqueue(chatId, prompt, text || (attachment ? 'attachment' : 'message'), 'zero', { notify: true });
}

// ---------------------------------------------------------------------- Poll
async function pollLoop() {
  let backoff = 1000;
  let healthy = false;
  let polls = 0;

  while (!stopped) {
    try {
      // Keep well under proxy idle cutoffs (often around 50 seconds).
      const updates = await api('getUpdates', {
        offset: state.offset || 0,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });

      if (!healthy) {
        log('polling OK');
        healthy = true;
        syncCommands();
      }
      if (++polls % 10 === 0) log(`poll heartbeat #${polls}`);
      backoff = 1000;

      for (const u of updates) {
        if (typeof u.update_id === 'number') {
          state.offset = u.update_id + 1;
          saveState();
        }
        if (u.message) {
          handleMessage(u.message).catch(e => log('handleMessage failed:', e.message));
        }
        if (u.callback_query) {
          handleCallback(u.callback_query).catch(e => log('handleCallback failed:', e.message));
        }
      }
    } catch (e) {
      healthy = false;
      if (e.errorCode === 409) {
        log('409 Conflict: another poller is using this bot token. Retrying in 10s.');
        await sleep(10000);
      } else if (e.errorCode === 429) {
        const wait = (e.parameters && e.parameters.retry_after) || 5;
        log(`429 rate limited; waiting ${wait}s`);
        await sleep((wait + 1) * 1000);
      } else {
        log('poll error:', e.message);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }
}

// ---------------------------------------------------------------------- Boot
function shutdown(signal) {
  log('shutting down:', signal);
  stopped = true;
  if (activeJob) {
    if (activeJob.control) activeJob.control.stop = true;
    killTree(activeJob.child, 'SIGTERM');
  }
  for (const child of btwJobs.values()) {
    killTree(child, 'SIGTERM');
  }
  btwJobs.clear();
  saveState();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => { /* keep running */ });
process.on('uncaughtException', e => log('uncaught:', e));
process.on('unhandledRejection', e => log('unhandled rejection:', e));

(async () => {
  try {
    const me = await api('getMe');
    log(`bridge v${VERSION} started as @${me.username} (pid ${process.pid})`);
    await syncCommands();
    await send([...allowedChatIds][0],
      `🤖 Zero bridge v${VERSION} online (@${me.username}). Send a message or /help.`,
      { reply_markup: mainKeyboard() });
  } catch (e) {
    log('startup check failed:', e.message);
  }
  pollLoop();
})();
