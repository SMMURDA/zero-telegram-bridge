'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseFrontmatter,
  discoverSkills,
  filterSkills
} = require('../src/skills');

const simple = parseFrontmatter('---\nname: demo\ndescription: A demo skill\n---\n# Demo\n');
assert.strictEqual(simple.data.name, 'demo');
assert.strictEqual(simple.data.description, 'A demo skill');
assert.strictEqual(simple.body, '# Demo\n');

const quoted = parseFrontmatter('---\nname: "quoted-name"\ndescription: \'single quoted\'\n---\n');
assert.strictEqual(quoted.data.name, 'quoted-name');
assert.strictEqual(quoted.data.description, 'single quoted');

const folded = parseFrontmatter(
  '---\nname: folded\ndescription: >\n  first line\n  second line\n---\n'
);
assert.strictEqual(folded.data.description, 'first line second line');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-skills-'));

function writeSkill(root, folder, content) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

const home = path.join(tmp, 'home');
const cwd = path.join(tmp, 'project');

writeSkill(path.join(home, '.zero', 'skills'), 'alpha',
  '---\nname: alpha\ndescription: user alpha\n---\n');
writeSkill(path.join(home, '.zero', 'skills'), 'fallback-name',
  '---\ndescription: folder-name fallback\n---\n\n# Title\n\nFirst real paragraph.\n');
writeSkill(path.join(home, '.zero', 'skills'), 'no-description',
  '---\nname: no-description\n---\n\n# Heading\n\nBody summary here.\n');
writeSkill(path.join(home, '.zero', 'skills'), 'fallback-punct',
  '---\nname: "***"\ndescription: punctuation fallback\n---\n');
writeSkill(path.join(home, '.zero', 'plugins', 'marketplaces', 'demo', 'plugins',
  'demo-plugin', 'skills'), 'plugin-skill',
  '---\nname: plugin-skill\ndescription: from a plugin\n---\n');

writeSkill(path.join(cwd, '.zero', 'skills'), 'alpha',
  '---\nname: alpha\ndescription: project alpha\n---\n');
writeSkill(path.join(cwd, '.zero', 'skills'), 'beta',
  '---\nname: beta\ndescription: beta skill\n---\n');

try {
  const skills = discoverSkills(home, cwd);
  const names = skills.map(skill => skill.name);

  assert.deepStrictEqual(
    names,
    ['alpha', 'beta', 'fallback-name', 'fallback-punct', 'no-description', 'plugin-skill'],
    'discovers user, project, and plugin skills, sorted by name'
  );

  const alpha = skills.find(skill => skill.name === 'alpha');
  assert.strictEqual(alpha.source, 'project', 'project skill overrides user skill');
  assert.strictEqual(alpha.description, 'project alpha');

  const fallback = skills.find(skill => skill.name === 'fallback-name');
  assert.strictEqual(fallback.description, 'folder-name fallback');

  const noDescription = skills.find(skill => skill.name === 'no-description');
  assert.strictEqual(noDescription.description, 'Body summary here.');

  const punct = skills.find(skill => skill.name === 'fallback-punct');
  assert.ok(punct, 'a name that cleans to empty falls back to the folder name');

  const plugin = skills.find(skill => skill.name === 'plugin-skill');
  assert.strictEqual(plugin.source, 'plugin');
  assert.strictEqual(plugin.description, 'from a plugin');

  assert.deepStrictEqual(
    filterSkills(skills, 'beta').map(skill => skill.name),
    ['beta'],
    'filters by name'
  );
  assert.deepStrictEqual(
    filterSkills(skills, 'plugin').map(skill => skill.name),
    ['plugin-skill'],
    'filters by description or source'
  );
  assert.strictEqual(filterSkills(skills, '').length, skills.length);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('skills tests passed');
