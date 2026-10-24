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

const ROOT = path.resolve(__dirname, '..');
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
  maxFileBytes: Number(process.env.ZERO_MAX_FILE_BYTES || fileConfig.maxFileBytes || 20971520)
};

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

const KB = {
  newSession: '🆕 New Session',
  sessions: '🗂️ Sessions',
  resume: '⏪ Resume',
  model: '🧠 Model',
  effort: '⚙️ Effort',
  cwd: '📁 Folder',
  status: '📊 Status',
  cost: '💰 Cost',
  stop: '⏹️ Stop',
  help: '❓ Help'
};

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: KB.newSession }, { text: KB.sessions }, { text: KB.resume }],
    [{ text: KB.model }, { text: KB.effort }, { text: KB.cwd }],
    [{ text: KB.status }, { text: KB.cost }, { text: KB.stop }],
    [{ text: KB.help }]
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Type a message or pick a menu…'
};

const KEYBOARD_MAP = {
  [KB.newSession]: '/new',
  [KB.sessions]: '/sessions',
  [KB.resume]: '/resume',
  [KB.model]: '/model',
  [KB.effort]: '/effort',
  [KB.cwd]: '/cwd',
  [KB.status]: '/status',
  [KB.cost]: '/cost',
  [KB.stop]: '/stop',
  [KB.help]: '/help'
};

const BOT_COMMANDS = [
  { command: 'start', description: '🚀 Start the bot' },
  { command: 'help', description: '📖 Help & commands' },
  { command: 'menu', description: '🎛️ Show keyboard menu' },
  { command: 'new', description: '🆕 New conversation' },
  { command: 'resume', description: '⏪ Resume a session' },
  { command: 'sessions', description: '🗂️ Recent sessions' },
  { command: 'status', description: '📊 Bridge status & queue' },
  { command: 'model', description: '🧠 View or set model' },
  { command: 'effort', description: '⚙️ View or set effort' },
  { command: 'cwd', description: '📁 Working directory' },
  { command: 'cost', description: '💰 Session & total cost' },
  { command: 'stop', description: '⏹️ Stop running task' },
  { command: 'ping', description: '🏓 Check bridge health' },
  { command: 'id', description: '🪪 Show chat ID' },
  { command: 'mcp', description: '🔌 Zero MCP servers' },
  { command: 'plugin', description: '🧩 Zero plugins' },
  { command: 'agents', description: '🤖 List agents' },
  { command: 'doctor', description: '🩺 Zero health check' },
  { command: 'version', description: '🏷️ Zero CLI version' },
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
• /stop — stop a running task
• /model — switch models

🔒 Full-auto mode. Only your chat ID is served.`;

const HELP = `📖 ZERO HELP

💬 Chat
• Send a normal message — the agent replies and can use tools
• 📎 Photo / document / voice — downloaded and analyzed
• ↩️ Reply to a message — its quote is included
• !command — run a shell command in the working directory (e.g. !ls -la)

🆕 Sessions
/new — start a new conversation
/resume — list sessions in the working directory
/resume <number|id> — resume a specific session
/sessions — recent sessions
/status — model, effort, folder, queue, cost
/stop — stop the running task and clear the queue

🧠 Settings
/model [name] — view or set model
/effort [low|medium|high|max] — set effort
/cwd [path] — view or set working directory
/cost — session and total cost
/menu — show the keyboard
/id — your chat ID
/ping — check bridge health

🛠️ Zero
/mcp [subcommand] — manage MCP servers
/plugin [subcommand] — manage plugins
/agents — list agents
/doctor — Zero CLI health check
/version — Zero CLI version
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
let processing = false;
let activeJob = null;
let stopped = false;
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
      lastCallCost: 0
    };
  }
  const s = state.sessions[id];
  if (!s.cwd) s.cwd = config.workdir;
  if (!s.model) s.model = config.model;
  if (!s.effort) s.effort = config.effort;
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

// ------------------------------------------------------------------- Zero CLI
function killTree(child, signal = 'SIGTERM') {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (_) { try { child.kill(signal); } catch (_) {} }
}

function zeroArgs(prompt, s) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--model', s.model,
    '--effort', s.effort
  ];
  if (s.resumeId) args.push('-r', s.resumeId);
  else if (!s.newSession) args.push('-c');
  args.push('--', prompt);
  return args;
}

function runZero(prompt, s, onChild, control) {
  return new Promise((resolve, reject) => {
    const args = zeroArgs(prompt, s);
    log('run zero', JSON.stringify({
      cwd: s.cwd,
      model: s.model,
      effort: s.effort,
      resume: s.resumeId || null,
      cont: !s.newSession,
      len: prompt.length
    }));

    const child = spawn(config.zeroBin, args, {
      cwd: s.cwd,
      env: { ...process.env, HOME, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: Zero's sandbox can kill its own group on exit
      // without taking this bridge down with it.
      detached: true
    });
    if (onChild) onChild(child);

    let stdout = '';
    let stderr = '';
    let killedBy = null;
    const limit = 32 * 1024 * 1024;

    child.stdout.on('data', d => { if (stdout.length < limit) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < limit) stderr += d; });

    const timeout = setTimeout(() => {
      killedBy = 'timeout';
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 5000);
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

function projectDir(cwd) {
  return path.join(HOME, '.zero', 'projects', cwd.replace(/[\/\\:]/g, '-'));
}

function readFirstPrompt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' && parsed.message) {
          const content = parsed.message.content;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            const text = content.find(x => x && x.type === 'text' && x.text);
            if (text) return text.text;
          }
        }
        if (parsed.type === 'queue-operation' && parsed.operation === 'enqueue' && parsed.content) {
          return parsed.content;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return '(untitled)';
}

function listSessions(cwd, limit = 12) {
  const dir = projectDir(cwd);
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch (_) { return null; }
        return { file: full, id: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch (_) {}
  return files.map((f, i) => ({
    ...f,
    index: i + 1,
    title: readFirstPrompt(f.file)
  }));
}

function shortSessionLabel(x) {
  const date = new Date(x.mtime).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const title = clip(String(x.title || '').replace(/\s+/g, ' ').trim(), 28) || 'untitled';
  return clip(`▶️ ${x.index}. ${date} · ${title}`, 60);
}

function sessionsKeyboard(list) {
  const rows = list.slice(0, 10).map(x => [{
    text: shortSessionLabel(x),
    callback_data: `resume:${x.id}`
  }]);
  rows.push([{ text: '🆕 Start a new session', callback_data: 'new' }]);
  return { inline_keyboard: rows };
}

async function handleCommand(chatId, text, s) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1).join(' ');
  const args = parts.slice(1);

  switch (cmd) {
    case '/start':
      return send(chatId, WELCOME, { reply_markup: MAIN_KEYBOARD });

    case '/help':
      return send(chatId, HELP, { reply_markup: MAIN_KEYBOARD });

    case '/menu':
      return send(chatId, '🎛️ Keyboard menu shown.', { reply_markup: MAIN_KEYBOARD });

    case '/new':
    case '/clear':
      s.newSession = true;
      s.resumeId = null;
      s.lastSessionId = null;
      s.lastTotal = 0;
      saveState();
      return send(chatId, '🆕 New conversation ready. The next message starts a fresh Zero session.');

    case '/resume': {
      if (!rest) {
        const list = listSessions(s.cwd);
        if (!list.length) return send(chatId, `No sessions in ${s.cwd} yet.`);
        return send(chatId,
          `⏪ Pick a session to resume.\nTap a button below — it activates immediately.\n\nFolder: ${s.cwd}`,
          { reply_markup: sessionsKeyboard(list) });
      }
      let id = rest;
      if (/^\d+$/.test(rest)) {
        const list = listSessions(s.cwd);
        const item = list[Number(rest) - 1];
        if (!item) return send(chatId, `Session number ${rest} not found. Use /resume to list.`);
        id = item.id;
      }
      s.resumeId = id;
      s.newSession = false;
      saveState();
      return send(chatId, `⏪ Next message will resume: ${id}`);
    }

    case '/sessions': {
      const list = listSessions(s.cwd);
      if (!list.length) return send(chatId, `No sessions in ${s.cwd} yet.`);
      return send(chatId,
        `🗂️ Sessions in ${s.cwd}\nTap a button to activate a session immediately.`,
        { reply_markup: sessionsKeyboard(list) });
    }

    case '/status': {
      const running = activeJob
        ? `yes (${fmtDuration(Date.now() - activeJob.startedAt)})`
        : 'no';
      const mode = s.resumeId
        ? `resume ${s.resumeId}`
        : (s.newSession ? 'new (next)' : 'continue (-c)');
      return send(chatId,
        `📊 Bridge status\n` +
        `model: ${s.model}\n` +
        `effort: ${s.effort}\n` +
        `folder: ${s.cwd}\n` +
        `session mode: ${mode}\n` +
        `last session: ${s.lastSessionId || '-'}\n` +
        `running: ${running}\n` +
        `queue: ${jobQueue.length}\n` +
        `session cost: ${fmtCost(s.lastTotal)} | total: ${fmtCost(s.spent)}\n` +
        `uptime: ${fmtDuration(Date.now() - startedAt)}`
      );
    }

    case '/model':
      if (!rest) {
        return send(chatId, `Model: ${s.model}\nChange: /model <name> (e.g. flash, pro, deepseek-v4-flash)`);
      }
      s.model = rest;
      saveState();
      return send(chatId, `🧠 Model → ${s.model}`);

    case '/effort':
      if (!rest) return send(chatId, `Effort: ${s.effort}\nChange: /effort low|medium|high|max`);
      if (!['low', 'medium', 'high', 'max'].includes(rest.toLowerCase())) {
        return send(chatId, 'Effort must be low, medium, high, or max.');
      }
      s.effort = rest.toLowerCase();
      saveState();
      return send(chatId, `⚙️ Effort → ${s.effort}`);

    case '/cwd': {
      if (!rest) return send(chatId, `Working directory: ${s.cwd}\nChange: /cwd /absolute/path`);
      const target = path.resolve(rest.replace(/^~(?=$|\/)/, HOME));
      let st;
      try { st = fs.statSync(target); } catch (_) {
        return send(chatId, `Folder not found: ${target}`);
      }
      if (!st.isDirectory()) return send(chatId, `Not a folder: ${target}`);
      s.cwd = target;
      s.newSession = true;
      s.resumeId = null;
      saveState();
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
      if (!activeJob) {
        const queued = jobQueue.length;
        jobQueue = [];
        return send(chatId, queued
          ? `⏹️ Queue cleared (${queued} job${queued === 1 ? '' : 's'}).`
          : 'No task is running.');
      }
      if (activeJob.control) activeJob.control.stop = true;
      killTree(activeJob.child, 'SIGTERM');
      const dying = activeJob;
      setTimeout(() => killTree(dying && dying.child, 'SIGKILL'), 5000);
      const queued = jobQueue.length;
      jobQueue = [];
      return send(chatId, `⏹️ Task stopped${queued ? `, ${queued} queued job${queued === 1 ? '' : 's'} cleared` : ''}.`);
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
      return send(chatId, await runCli(['doctor'], { timeout: 120000 }));

    case '/version':
      return send(chatId, await runCli(['--version']));

    case '/config': {
      const safe = { ...config, token: config.token ? '<redacted>' : '' };
      return send(chatId, '```\n' + JSON.stringify(safe, null, 2) + '\n```');
    }

    default:
      return null; // Unknown slash command: forward to Zero.
  }
}

// ----------------------------------------------------------------------- Jobs
function enqueue(chatId, prompt, label, kind = 'zero') {
  jobQueue.push({ chatId, prompt, label, kind });
  pump();
}

async function pump() {
  if (processing || stopped) return;
  processing = true;
  try {
    while (jobQueue.length && !stopped) {
      const job = jobQueue.shift();
      await runJob(job);
    }
  } finally {
    processing = false;
  }
}

async function runJob(job) {
  const s = sessionFor(job.chatId);
  const stopTyping = typingLoop(job.chatId);
  try {
    if (job.kind === 'shell') {
      const out = await runShell(job.prompt, s.cwd);
      await send(job.chatId, out);
      return;
    }

    const control = { stop: false };
    const result = await new Promise((resolve, reject) => {
      runZero(job.prompt, s, child => {
        activeJob = { child, control, chatId: job.chatId, startedAt: Date.now() };
      }, control).then(resolve, reject);
    });

    updateCost(s, result.parsed);
    s.newSession = false;
    s.resumeId = null;
    saveState();

    let text = result.text;
    if (!text || !text.trim()) text = '(no output)';
    const denied = result.parsed && Array.isArray(result.parsed.permission_denials)
      ? result.parsed.permission_denials.length
      : 0;
    if (denied) text += `\n\n⚠️ ${denied} tool call${denied === 1 ? '' : 's'} denied by the permission system.`;

    await send(job.chatId, text);
  } catch (e) {
    if (e.code === 'STOPPED') {
      await send(job.chatId, '⏹️ Cancelled.');
    } else if (e.code === 'TIMEOUT') {
      await send(job.chatId,
        `⏱️ Timed out after ${fmtDuration(config.jobTimeoutMs)}. Try /stop and break the task into smaller steps.`);
    } else {
      log('job failed:', e.message);
      await send(job.chatId, `❌ Error: ${redact(e.message).slice(0, 3500)}`);
    }
  } finally {
    stopTyping();
    activeJob = null;
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
    if (data === 'new') {
      s.newSession = true;
      s.resumeId = null;
      s.lastSessionId = null;
      s.lastTotal = 0;
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: '🆕 New session ready' });
      await removeInline(chatId, msg.message_id);
      await send(chatId,
        '🆕 New conversation ready. The next message starts a fresh Zero session.',
        { reply_markup: MAIN_KEYBOARD });
      return;
    }

    if (data.startsWith('resume:')) {
      const id = data.slice('resume:'.length);
      const all = listSessions(s.cwd, 100);
      const meta = all.find(x => x.id === id);
      if (!meta) {
        await api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Session not found' });
        return;
      }
      s.resumeId = id;
      s.newSession = false;
      saveState();
      await api('answerCallbackQuery', { callback_query_id: cq.id, text: '⏪ Session activated' });
      await removeInline(chatId, msg.message_id);
      const title = String(meta.title || '').replace(/\s+/g, ' ').slice(0, 80);
      await send(chatId,
        `⏪ Session active: ${id.slice(0, 8)}${title ? `\n${title}` : ''}\n` +
        'The next message continues this session. Use /new to start fresh.',
        { reply_markup: MAIN_KEYBOARD });
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
    enqueue(chatId, text.slice(1), 'shell', 'shell');
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

  enqueue(chatId, prompt, text || (attachment ? 'attachment' : 'message'), 'zero');
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
    log(`bridge started as @${me.username} (pid ${process.pid})`);
    await syncCommands();
    await send([...allowedChatIds][0],
      `🤖 Zero bridge online (@${me.username}). Send a message or /help.`);
  } catch (e) {
    log('startup check failed:', e.message);
  }
  pollLoop();
})();
