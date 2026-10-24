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
 * Detect an interactive Zero CLI process in a given working directory.
 * The bot's own `zero -p` children are ignored: they are non-interactive and
 * their stdin is not a TTY.
 */
function findActiveTerminal(cwd) {
  if (!cwd) return null;
  let target;
  try {
    target = path.resolve(cwd);
  } catch (_) {
    return null;
  }

  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (_) {
    return null;
  }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;

    let cmdline;
    try {
      cmdline = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8')
        .replace(/\0/g, ' ')
        .trim();
    } catch (_) {
      continue;
    }

    if (!cmdline.includes('zero-cli')) continue;
    // `-p`/`--print` is the bot's one-shot child, not an interactive session.
    if (/(^|\s)(-p|--print)(\s|$)/.test(cmdline)) continue;

    let stdin;
    try {
      stdin = fs.readlinkSync(`/proc/${name}/fd/0`);
    } catch (_) {
      continue;
    }
    if (!/^\/dev\/(pts\/|tty)/.test(stdin)) continue;

    let processCwd;
    try {
      processCwd = fs.readlinkSync(`/proc/${name}/cwd`);
    } catch (_) {
      continue;
    }
    if (path.resolve(processCwd) !== target) continue;

    return { pid, cmdline };
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
  findActiveTerminal,
  findSessionById,
  readLastUsage,
  readSessionMeta,
  extractTitle
};
