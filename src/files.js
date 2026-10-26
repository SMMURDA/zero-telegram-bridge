'use strict';

/**
 * Helpers for files the agent asks the bridge to send back to Telegram.
 *
 * The agent ends its final answer with a contiguous block of marker lines:
 *   [[send-file:/absolute/path]]
 *   [[send-file:relative/path]]
 * Only that trailing block is consumed. A marker quoted in the middle of a
 * reply (for example while explaining this syntax) is left untouched.
 */

const MARKER = /^[ \t]*\[\[send-file:[ \t]*([^\]\n]+?)[ \t]*\]\][ \t]*$/;

function extractFileMarkers(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const files = [];
  const seen = new Set();

  let index = lines.length - 1;
  while (index >= 0 && !lines[index].trim()) index--;

  for (; index >= 0; index--) {
    const match = lines[index].match(MARKER);
    if (!match) break;
    const file = match[1].trim();
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
    lines[index] = '';
  }

  const visible = lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: visible, files: files.reverse() };
}

// Formats accepted by Telegram's sendPhoto. GIF is deliberately excluded so
// it is uploaded as a document and keeps its animation.
function isImageFile(file) {
  return /\.(?:jpe?g|png|webp)$/i.test(String(file || ''));
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Telegram's image processor can reject a technically valid image (for
// example, a 1x1 PNG returns IMAGE_PROCESS_FAILED). Keep document upload as a
// fallback so the file still reaches the user.
function uploadMethodsFor(file, size) {
  return isImageFile(file) && Number(size) <= MAX_PHOTO_BYTES
    ? ['sendPhoto', 'sendDocument']
    : ['sendDocument'];
}

function buildMultipart(fields, file) {
  const boundary = '----ZeroBridge' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8'
    ));
  }
  const filename = String(file.filename).replace(/["\r\n]/g, '_');
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; ` +
    `filename="${filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
    'utf8'
  ));
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

module.exports = {
  extractFileMarkers,
  isImageFile,
  uploadMethodsFor,
  buildMultipart
};
