'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const manifest = require('../.zero-plugin/plugin.json');
const marketplace = require('../.zero-plugin/marketplace.json');
const hooks = require('../hooks/hooks.json');

assert.strictEqual(manifest.name, 'zero-telegram-bridge');
assert.strictEqual(manifest.version, pkg.version, 'plugin version matches package');
assert.strictEqual(manifest.license, 'MIT');
assert.strictEqual(
  Object.hasOwn(manifest, 'hooks'),
  false,
  'hooks/hooks.json is auto-loaded; manifest must not reference it again'
);

assert.strictEqual(marketplace.name, 'smmurda-tools');
assert.strictEqual(marketplace.metadata.version, pkg.version, 'marketplace version matches package');
assert.strictEqual(marketplace.plugins.length, 1);

const entry = marketplace.plugins[0];
assert.strictEqual(entry.name, manifest.name);
assert.strictEqual(entry.source, './');
assert.strictEqual(entry.version, pkg.version);

const sessionStart = hooks.hooks && hooks.hooks.SessionStart;
assert(Array.isArray(sessionStart) && sessionStart.length > 0, 'SessionStart hook exists');
const commands = sessionStart.flatMap(entry => entry.hooks.map(hook => hook.command));
assert(
  commands.some(command => command.includes('plugin-session-start.sh')),
  'SessionStart runs the plugin auto-start script'
);

const required = [
  '.zero-plugin/plugin.json',
  '.zero-plugin/marketplace.json',
  'hooks/hooks.json',
  'hooks/plugin-session-start.sh',
  'skills/telegram-bridge/SKILL.md',
  'commands/telegram-setup.md',
  'scripts/setup.sh',
  'scripts/setup-telegram.js',
  'scripts/start.sh',
  'scripts/stop.sh',
  'scripts/supervise.sh'
];
for (const file of required) {
  assert(fs.existsSync(path.join(root, file)), `${file} exists`);
}

const skill = fs.readFileSync(path.join(root, 'skills/telegram-bridge/SKILL.md'), 'utf8');
assert(/^---\nname: telegram-bridge\n/.test(skill), 'skill frontmatter names the skill');
assert(skill.includes('scripts/setup.sh'), 'skill points at the setup script');
assert(skill.includes('~/.zero/telegram-bridge'), 'skill documents the stable data directory');

const command = fs.readFileSync(path.join(root, 'commands/telegram-setup.md'), 'utf8');
assert(/^---\ndescription:/.test(command), 'telegram-setup command has a description');

console.log('plugin tests passed');
