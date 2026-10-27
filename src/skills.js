'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_DESCRIPTION = 160;
const PLUGIN_MAX_DEPTH = 7;

function unquote(value) {
  const text = String(value == null ? '' : value).trim();
  if (text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseFrontmatter(source) {
  const text = String(source == null ? '' : source);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: text };

  const data = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    let value = kv[2].trim();

    // Folded/literal YAML blocks: collect the indented continuation lines.
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts = [];
      while (i + 1 < lines.length && /^[ \t]+/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(value.startsWith('|') ? '\n' : ' ');
    } else {
      value = unquote(value);
    }
    data[key] = value;
  }

  return { data, body: text.slice(match[0].length) };
}

function firstParagraph(body) {
  const lines = String(body || '').split(/\r?\n/);
  for (const line of lines) {
    const text = line.trim();
    if (!text || text === '---' || text.startsWith('#')) continue;
    if (text.startsWith('```') || text.startsWith('~~~')) continue;
    return text.replace(/^[-*+]\s+/, '');
  }
  return '';
}

function cleanText(text, max = MAX_DESCRIPTION) {
  const value = String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + '…';
}

function readSkill(dir, source) {
  const file = path.join(dir, 'SKILL.md');
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }

  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (_) {
    return null;
  }

  const fallbackName = path.basename(dir);
  const name = cleanText(parsed.data.name, 80) || cleanText(fallbackName, 80);
  if (!name) return null;

  const description = cleanText(
    parsed.data.description || firstParagraph(parsed.body),
    MAX_DESCRIPTION
  );

  return { name, description, source, path: file };
}

function scanSkillRoot(root, source, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = readSkill(path.join(root, entry.name), source);
    if (skill) out.push(skill);
  }
}

// Best-effort scan of installed plugins. Plugin layouts vary, so walk a few
// levels looking for SKILL.md files; skip dependency and VCS directories.
function scanPluginSkills(root, out, depth = 0, seen = new Set()) {
  if (depth > PLUGIN_MAX_DEPTH) return;

  let real;
  try { real = fs.realpathSync(root); } catch (_) { return; }
  if (seen.has(real)) return;
  seen.add(real);

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return;
  }

  if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
    const skill = readSkill(root, 'plugin');
    if (skill) out.push(skill);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    scanPluginSkills(path.join(root, entry.name), out, depth + 1, seen);
  }
}

/**
 * Discover user, project, and plugin skills. A skill with the same name in
 * multiple places is shown once, with project overriding user and user
 * overriding plugin.
 */
function discoverSkills(home, cwd) {
  const plugin = [];
  const user = [];
  const project = [];

  scanPluginSkills(path.join(home, '.zero', 'plugins'), plugin);
  scanSkillRoot(path.join(home, '.zero', 'skills'), 'user', user);
  if (cwd) scanSkillRoot(path.join(cwd, '.zero', 'skills'), 'project', project);

  const byName = new Map();
  for (const skill of [...plugin, ...user, ...project]) {
    byName.set(skill.name.toLowerCase(), skill);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function filterSkills(skills, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter(skill =>
    `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(needle)
  );
}

module.exports = {
  parseFrontmatter,
  discoverSkills,
  filterSkills
};
