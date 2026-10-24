'use strict';

const fs = require('fs');
const path = require('path');

const META_BYTES = 64 * 1024;
const MAX_READS = 200;

function extractTitle(content) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const block = content.find(x => x && x.type === 'text' && x.text);
    if (block) text = block.text;
  }
  text = String(text || '').trim();
  if (!text) return '';
  // Skip injected CLI command wrappers.
  if (/^<(local-command-caveat|command-name|local-command-stdout|command-message)/.test(text)) {
    return '';
  }
  return text;
}

function readSessionMeta(file) {
  let buffer;
  try {
    const fd = fs.openSync(file, 'r');
    buffer = Buffer.alloc(META_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    buffer = buffer.subarray(0, read);
  } catch (_) {
    return { title: '(untitled)', cwd: null };
  }

  let cwd = null;
  let title = '';

  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }

    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;

    if (!title) {
      if (entry.type === 'user' && entry.message) {
        title = extractTitle(entry.message.content);
      } else if (entry.type === 'queue-operation' &&
        entry.operation === 'enqueue' && entry.content) {
        title = extractTitle(entry.content);
      }
    }

    if (cwd && title) break;
  }

  return { title: title || '(untitled)', cwd };
}

/**
 * Find recent sessions across every Zero project, not just one cwd.
 * Returns [{ id, file, mtime, title, cwd, index }] sorted by mtime desc.
 */
function discoverSessions(home, limit = 12) {
  if (!(limit > 0)) return [];

  const root = path.join(home, '.zero', 'projects');
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory());
  } catch (_) {
    return [];
  }

  const files = [];
  for (const dir of projectDirs) {
    const projectPath = path.join(root, dir.name);
    let names = [];
    try {
      names = fs.readdirSync(projectPath);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projectPath, name);
      try {
        const stat = fs.statSync(file);
        files.push({
          file,
          id: name.replace(/\.jsonl$/, ''),
          mtime: stat.mtimeMs
        });
      } catch (_) {}
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);

  const sessions = [];
  let reads = 0;
  for (const file of files) {
    if (sessions.length >= limit) break;
    if (++reads > MAX_READS) break;

    const meta = readSessionMeta(file.file);
    if (!meta.cwd) continue;

    sessions.push({
      ...file,
      title: meta.title,
      cwd: meta.cwd
    });
  }

  return sessions.map((session, index) => ({ ...session, index: index + 1 }));
}

/**
 * Read the token count from the last assistant usage entry in a session.
 * Used to show a resumed session's context before the bot runs a new turn.
 */
function readLastUsage(file) {
  let tail;
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    tail = Buffer.alloc(size);
    fs.readSync(fd, tail, 0, size, stat.size - size);
    fs.closeSync(fd);
  } catch (_) {
    return null;
  }

  const lines = tail.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const usage = (entry.message && entry.message.usage) || entry.usage;
    if (!usage) continue;
    const tokens =
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.output_tokens || 0);
    if (tokens > 0) return tokens;
  }
  return null;
}

/**
 * Detect whether one exact session is open in a live interactive Zero CLI.
 *
 * Zero writes ~/.zero/sessions/<pid>.json for active sessions, including the
 * sessionId, so this is an exact match. Stale registry entries are ignored by
 * checking that the PID is still alive.
 */
function isInteractiveZeroProcess(pid) {
  let cmdline;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .replace(/\0/g, ' ')
      .trim();
  } catch (_) {
    // /proc is unavailable (e.g. macOS): trust the registry entry.
    return true;
  }

  if (!cmdline) return false;
  if (/(^|\s)(-p|--print)(\s|$)/.test(cmdline)) return false;
  if (!cmdline.includes('_cli.js') && !cmdline.includes('zero-cli')) return false;

  let stdin = '';
  try {
    stdin = fs.readlinkSync(`/proc/${pid}/fd/0`);
  } catch (_) {}
  if (stdin && !/^\/dev\/(pts\/|tty)/.test(stdin)) return false;

  return true;
}

function findActiveSession(home, sessionId, options = {}) {
  const verifyProcess = options.verifyProcess !== false;
  if (!sessionId) return null;

  const registry = path.join(home, '.zero', 'sessions');
  let names;
  try {
    names = fs.readdirSync(registry);
  } catch (_) {
    return null;
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;

    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(registry, name), 'utf8'));
    } catch (_) {
      continue;
    }

    if (!entry || entry.sessionId !== sessionId) continue;

    const pid = Number(entry.pid) || Number(name.replace(/\.json$/, ''));
    if (!Number.isInteger(pid) || pid <= 0) continue;

    try {
      process.kill(pid, 0);
    } catch (error) {
      // EPERM means the process exists but belongs to another user.
      if (error.code !== 'EPERM') continue;
    }

    if (entry.kind && entry.kind !== 'interactive') continue;
    if (verifyProcess && !isInteractiveZeroProcess(pid)) continue;

    return {
      pid,
      cwd: entry.cwd || null,
      kind: entry.kind || 'interactive',
      entrypoint: entry.entrypoint || 'cli',
      startedAt: entry.startedAt || null
    };
  }

  return null;
}

/**
 * Look up one exact session ID without the recency limit used for listings.
 * Zero's `-r` is scoped to the session's project directory, so the caller also
 * needs the cwd returned here.
 */
function findSessionById(home, id) {
  if (!id) return null;
  const root = path.join(home, '.zero', 'projects');

  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory());
  } catch (_) {
    return null;
  }

  for (const dir of projectDirs) {
    const file = path.join(root, dir.name, `${id}.jsonl`);
    try {
      const stat = fs.statSync(file);
      const meta = readSessionMeta(file);
      if (!meta.cwd) return null;
      return {
        file,
        id,
        mtime: stat.mtimeMs,
        title: meta.title,
        cwd: meta.cwd
      };
    } catch (_) {}
  }

  return null;
}

module.exports = {
  discoverSessions,
  findActiveSession,
  findSessionById,
  isInteractiveZeroProcess,
  readLastUsage,
  readSessionMeta,
  extractTitle
};
