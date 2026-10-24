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
  findSessionById,
  readSessionMeta,
  extractTitle
};
