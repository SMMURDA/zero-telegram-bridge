#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const token = String(process.env.TOKEN || '').trim();
const chatArg = String(process.env.CHAT_ID || '').trim();
const configPath = String(process.env.CONFIG_PATH || '').trim();
const dryRun = process.env.DRY_RUN === '1';

if (!token) {
  console.error('Bot token is required.');
  process.exit(1);
}
if (!configPath) {
  console.error('CONFIG_PATH is required.');
  process.exit(1);
}

const redact = value => String(value == null ? '' : value).replaceAll(token, '<token>');

function api(method, params = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/${method}`,
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (_) {
          return reject(new Error(`${method}: invalid response (HTTP ${res.statusCode})`));
        }
        if (!parsed.ok) {
          return reject(new Error(`${method}: ${parsed.description || `HTTP ${res.statusCode}`}`));
        }
        resolve(parsed.result);
      });
    });
    req.setTimeout(25000, () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

function parseChatId(value) {
  if (!value) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id === 0) {
    throw new Error(`Invalid chat ID: ${value}`);
  }
  return id;
}

function writeConfig(chatId) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {}

  const config = {
    ...existing,
    token,
    allowedChatIds: [chatId],
    workdir: existing.workdir || path.join(os.homedir(), 'zero-workspace'),
    zeroBin: existing.zeroBin || process.env.ZERO_BIN || 'zero',
    model: existing.model || 'flash',
    effort: existing.effort || 'low',
    jobTimeoutMs: existing.jobTimeoutMs || 1800000,
    maxFileBytes: existing.maxFileBytes || 20971520,
    autoCompact: typeof existing.autoCompact === 'boolean' ? existing.autoCompact : false,
    autoCompactThreshold: typeof existing.autoCompactThreshold === 'number'
      ? existing.autoCompactThreshold
      : 0.75,
    progressMode: existing.progressMode || 'full',
    thinkingLanguage: typeof existing.thinkingLanguage === 'string'
      ? existing.thinkingLanguage
      : 'auto'
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(configPath), 0o700); } catch (_) {}
  try { fs.mkdirSync(config.workdir, { recursive: true }); } catch (_) {}

  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  try { fs.chmodSync(configPath, 0o600); } catch (_) {}
}

(async () => {
  try {
    if (dryRun) {
      const chatId = parseChatId(chatArg);
      if (!chatId) throw new Error('CHAT_ID is required in dry-run mode.');
      writeConfig(chatId);
      console.log(JSON.stringify({ ok: true, dryRun: true, chatId, config: configPath }));
      return;
    }

    const me = await api('getMe');
    let chatId = parseChatId(chatArg);

    if (!chatId) {
      const updates = await api('getUpdates', { offset: -1, limit: 1, timeout: 0 });
      const update = Array.isArray(updates) && updates.length
        ? updates[updates.length - 1]
        : null;
      const message = update && (
        update.message ||
        update.edited_message ||
        (update.callback_query && update.callback_query.message)
      );
      chatId = message && message.chat ? parseChatId(String(message.chat.id)) : null;
      if (!chatId) {
        throw new Error(
          `No chat found. Send a message to @${me.username} first, or pass the chat ID.`
        );
      }
    }

    await api('sendMessage', {
      chat_id: chatId,
      text: '✅ Zero Telegram Bridge connected.',
      disable_web_page_preview: true
    });

    writeConfig(chatId);
    console.log(JSON.stringify({
      ok: true,
      username: me.username,
      chatId,
      config: configPath
    }));
  } catch (error) {
    console.error(redact(error.message));
    process.exit(1);
  }
})();
