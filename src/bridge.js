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
const { toTelegramHtml, splitMarkdown } = require('./markdown');
const {
  discoverSessions,
  findActiveTerminal,
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
  )
};
if (!(config.autoCompactThreshold > 0.1 && config.autoCompactThreshold < 0.98)) {
  config.autoCompactThreshold = 0.75;
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
  compact: '🗜️ Compact',
  autoCompact: '🔄 Auto-Compact',
  help: '❓ Help'
};

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: KB.newSession }, { text: KB.sessions }, { text: KB.resume }],
    [{ text: KB.model }, { text: KB.effort }, { text: KB.cwd }],
    [{ text: KB.status }, { text: KB.cost }, { text: KB.stop }],
    [{ text: KB.compact }, { text: KB.autoCompact }, { text: KB.help }]
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
  [KB.compact]: '/compact',
  [KB.autoCompact]: '/autocompact',
  [KB.help]: '/help'
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
  { command: 'status', description: '📊 Bridge status & queue' },
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
/compact [instructions] — summarize and free context
/status — model, effort, folder, queue, cost, context
/stop — interrupt the running task (SIGINT) and clear the queue

🧠 Settings
/model [name] — view or set model
/effort [low|medium|high|max] — set effort
/cwd [path] — view or set working directory
/cost — session and total cost
/autocompact — toggle auto-compact (with confirmation)
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
      lastCallCost: 0,
      autoCompact: config.autoCompact,
      autoCompactThreshold: config.autoCompactThreshold,
      lastContextTokens: 0,
      contextWindow: null,
      contextPct: 0,
      contextSource: 'bot',
      lastCompactAt: null,
      autoCompactFailedAt: 0,
      pendingResume: null
    };
  }
  const s = state.sessions[id];
  if (!s.cwd) s.cwd = config.workdir;
  if (!s.model) s.model = config.model;
  if (!s.effort) s.effort = config.effort;
  if (typeof s.autoCompact !== 'boolean') s.autoCompact = config.autoCompact;
  if (typeof s.autoCompactThreshold !== 'number') s.autoCompactThreshold = config.autoCompactThreshold;
  if (typeof s.lastContextTokens !== 'number') s.lastContextTokens = 0;
  if (typeof s.contextPct !== 'number') s.contextPct = 0;
  if (!s.contextSource) s.contextSource = 'bot';
  if (typeof s.autoCompactFailedAt !== 'number') s.autoCompactFailedAt = 0;
  if (!('pendingResume' in s)) s.pendingResume = null;
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

async function sendFormatted(chatId, markdown, extra = {}) {
  const chunks = splitMarkdown(String(markdown == null ? '' : markdown), 2800);
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

function formatToolUse(name, input) {
  const inp = input || {};
  const file = inp.file_path || inp.path || inp.notebook_path || '';
  switch (name) {
    case 'Bash':
      return `🔧 Bash: ${oneLine(inp.command, 170)}`;
    case 'Read':
      return `📖 Read: ${oneLine(file, 140)}`;
    case 'Edit':
    case 'MultiEdit':
      return `✏️ ${name}: ${oneLine(file, 140)}`;
    case 'Write':
      return `📝 Write: ${oneLine(file, 140)}`;
    case 'Grep':
      return `🔍 Grep: ${oneLine(inp.pattern, 90)}` +
        (inp.path ? ` in ${oneLine(inp.path, 60)}` : '');
    case 'Glob':
      return `🔎 Glob: ${oneLine(inp.pattern, 110)}`;
    case 'WebFetch':
      return `🌐 Fetch: ${oneLine(inp.url, 140)}`;
    case 'WebSearch':
      return `🔎 Web: ${oneLine(inp.query, 140)}`;
    case 'Task':
    case 'Agent':
      return `🤖 Agent: ${oneLine(inp.description || inp.prompt, 140)}`;
    case 'TodoWrite':
      return '📋 Todos updated';
    default: {
      const hint = inp.command || inp.file_path || inp.path ||
        inp.pattern || inp.query || inp.url || '';
      return `🛠️ ${name}${hint ? `: ${oneLine(hint, 140)}` : ''}`;
    }
  }
}

// One Telegram message per job, edited as tools run. The message is created
// lazily on the first tool call, so simple replies do not leave clutter.
function createProgress(chatId) {
  const started = Date.now();
  let msg = null;
  let ensurePromise = null;
  let lines = [];
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
        text: '🧠 Working…',
        disable_web_page_preview: true
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

  const render = () => {
    const hidden = total - lines.length;
    const note = hidden > 0
      ? `… ${hidden} earlier step${hidden === 1 ? '' : 's'}\n`
      : '';
    return `🧠 Working… ${elapsed()}s\n\n${note}${lines.join('\n')}`;
  };

  const edit = (text) => {
    if (!msg) return Promise.resolve();
    chain = chain.then(() => api('editMessageText', {
      chat_id: chatId,
      message_id: msg.message_id,
      text,
      disable_web_page_preview: true
    })).catch(e => {
      if (!/not modified/i.test(e.message)) log('progress edit failed:', e.message);
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

  return {
    addTool(name, input) {
      if (closed) return;
      total++;
      lines.push(`[${elapsed()}s] ${formatToolUse(name, input)}`);
      if (lines.length > 14) lines = lines.slice(-14);
      ensure().then(ok => { if (ok) schedule(); });
    },
    async finish(opts = {}) {
      if (closed) return;
      closed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await ensurePromise;
      if (!msg) return; // No tool calls: no progress message to finalize.
      await chain;

      const secs = elapsed();
      let header;
      if (opts.ok) header = `✅ Done in ${secs}s`;
      else if (opts.status === 'stopped') header = `⏹️ Stopped after ${secs}s`;
      else if (opts.status === 'timeout') header = `⏱️ Timed out after ${secs}s`;
      else header = `❌ Failed after ${secs}s`;

      const hidden = total - lines.length;
      const note = hidden > 0
        ? `… ${hidden} earlier step${hidden === 1 ? '' : 's'}\n`
        : '';
      let text = `${header}\n\n${note}${lines.join('\n')}`;
      if (text.length > 3900) text = text.slice(text.length - 3900);
      await edit(text);
    }
  };
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
  args.push(
    '--dangerously-skip-permissions',
    '--model', s.model,
    '--effort', s.effort
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
    const args = zeroArgs(prompt, s, stream);
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

    const emitTool = block => {
      if (!progress || !block || block.type !== 'tool_use') return;
      if (block.id && seenTools.has(block.id)) return;
      if (block.id) seenTools.add(block.id);
      progress.addTool(block.name, block.input || {});
    };

    const handleLine = raw => {
      const line = raw.trim();
      if (!line.startsWith('{')) return;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { return; }
      if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
        for (const block of evt.message.content) emitTool(block);
      } else if (evt.type === 'stream_event' &&
        evt.event && evt.event.type === 'content_block_start') {
        emitTool(evt.event.content_block);
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
      activeJob = { child, control, chatId, startedAt: Date.now() };
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
  return `⚠️ **Active terminal session detected**\n\n` +
    `Zero CLI is running in \`${displayCwd(meta.cwd)}\` (pid ${active.pid}).\n\n` +
    `Resuming \`${meta.id.slice(0, 8)}\`${title ? ` — ${title}` : ''} from Telegram can conflict with that terminal: both may write to the same session, and the bot agent will see the terminal context.\n\n` +
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

function shortSessionLabel(x) {
  const date = new Date(x.mtime).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const project = clip(displayCwd(x.cwd), 20);
  const title = clip(String(x.title || '').replace(/\s+/g, ' ').trim(), 20) || 'untitled';
  return clip(`▶️ ${x.index}. ${date} · ${project} · ${title}`, 60);
}

function sessionsKeyboard(list) {
  const rows = list.slice(0, 12).map(x => [{
    text: shortSessionLabel(x),
    callback_data: `resume:${x.id}`
  }]);
  rows.push([{ text: '🆕 Start a new session', callback_data: 'new' }]);
  return { inline_keyboard: rows };
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
      ]
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
  const text = autoCompactText(s);
  const markup = autoCompactMenu(s);
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
      s.pendingResume = null;
      resetContext(s);
      saveState();
      return send(chatId, '🆕 New conversation ready. The next message starts a fresh Zero session.');

    case '/resume': {
      if (!rest) {
        const list = discoverSessions(HOME, 12);
        if (!list.length) return send(chatId, 'No sessions found in any project yet.');
        return send(chatId,
          '⏪ Pick a session to resume.\nAcross all projects, newest first. Tap a session — it activates immediately.',
          { reply_markup: sessionsKeyboard(list) });
      }

      const all = discoverSessions(HOME, 50);
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

      const active = findActiveTerminal(meta.cwd);
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

    case '/sessions': {
      const list = discoverSessions(HOME, 12);
      if (!list.length) return send(chatId, 'No sessions found in any project yet.');
      return send(chatId,
        '🗂️ Recent sessions across all projects\nTap a button to activate a session immediately.',
        { reply_markup: sessionsKeyboard(list) });
    }

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
        `folder: ${s.cwd}\n` +
        `session mode: ${mode}\n` +
        `last session: ${s.lastSessionId || '-'}\n` +
        `running: ${running}\n` +
        `queue: ${jobQueue.length}\n` +
        `auto-compact: ${s.autoCompact ? 'ON' : 'OFF'} (${Math.round(s.autoCompactThreshold * 100)}%)\n` +
        `context: ${contextLine(s)}${s.contextSource === 'resumed'
          ? ' (last known from session)'
          : ' (bot session)'}\n` +
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
      s.pendingResume = null;
      resetContext(s);
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
      requestStop(activeJob);
      const queued = jobQueue.length;
      jobQueue = [];
      return send(chatId,
        `⏹️ Interrupting${queued ? ` and clearing ${queued} queued job${queued === 1 ? '' : 's'}` : ''}. ` +
        'You can send your next message now.');
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

    progress = createProgress(job.chatId);
    const control = { stop: false, progress };
    const result = await new Promise((resolve, reject) => {
      runZero(job.prompt, s, child => {
        activeJob = { child, control, chatId: job.chatId, startedAt: Date.now() };
      }, control).then(resolve, reject);
    });

    updateCost(s, result.parsed);
    updateUsage(s, result.parsed);
    s.newSession = false;
    s.resumeId = null;
    saveState();

    let text = result.text;
    if (!text || !text.trim()) text = '(no output)';
    const denied = result.parsed && Array.isArray(result.parsed.permission_denials)
      ? result.parsed.permission_denials.length
      : 0;
    if (denied) text += `\n\n⚠️ ${denied} tool call${denied === 1 ? '' : 's'} denied by the permission system.`;

    await progress.finish({ ok: true });
    await sendFormatted(job.chatId, text);
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
        { reply_markup: MAIN_KEYBOARD });
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
        { reply_markup: MAIN_KEYBOARD });
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

      const active = findActiveTerminal(meta.cwd);
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
    log(`bridge v${VERSION} started as @${me.username} (pid ${process.pid})`);
    await syncCommands();
    await send([...allowedChatIds][0],
      `🤖 Zero bridge v${VERSION} online (@${me.username}). Send a message or /help.`);
  } catch (e) {
    log('startup check failed:', e.message);
  }
  pollLoop();
})();
