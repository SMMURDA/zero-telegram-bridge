'use strict';

const assert = require('assert');
const { extractFileMarkers, isImageFile, buildMultipart } = require('../src/files');

const single = extractFileMarkers('Here is the chart.\n\n[[send-file:/tmp/chart.png]]\n');
assert.strictEqual(single.text, 'Here is the chart.', 'trailing marker is removed');
assert.deepStrictEqual(single.files, ['/tmp/chart.png'], 'absolute path is kept');

const multiple = extractFileMarkers(
  'Two files:\n\n[[send-file:reports/a.txt]]\n[[send-file:/tmp/b.png]]'
);
assert.deepStrictEqual(
  multiple.files,
  ['reports/a.txt', '/tmp/b.png'],
  'relative and absolute paths are collected in order'
);
assert.strictEqual(multiple.text, 'Two files:', 'markers leave no stray blank lines');

const duplicate = extractFileMarkers(
  '[[send-file:/tmp/a.png]]\n[[send-file:/tmp/a.png]]'
);
assert.deepStrictEqual(duplicate.files, ['/tmp/a.png'], 'duplicate markers are de-duplicated');
assert.strictEqual(duplicate.text, '', 'marker-only text becomes empty');

const untouched = extractFileMarkers('No markers here.\n\n```\n[[not-a-marker]]\n```');
assert.deepStrictEqual(untouched.files, [], 'unrelated brackets are ignored');
assert.strictEqual(
  untouched.text,
  'No markers here.\n\n```\n[[not-a-marker]]\n```',
  'normal text is unchanged'
);

const inline = extractFileMarkers('Example: [[send-file:/tmp/secret.txt]] in a sentence.');
assert.deepStrictEqual(inline.files, [], 'inline markers are not treated as uploads');
assert.strictEqual(
  inline.text,
  'Example: [[send-file:/tmp/secret.txt]] in a sentence.',
  'inline marker text is preserved'
);

const middle = extractFileMarkers(
  'Here is an example:\n[[send-file:/tmp/secret.txt]]\nThis text comes after it.'
);
assert.deepStrictEqual(middle.files, [], 'markers followed by more text are ignored');
assert.strictEqual(
  middle.text,
  'Here is an example:\n[[send-file:/tmp/secret.txt]]\nThis text comes after it.',
  'non-trailing marker text is preserved'
);

const indented = extractFileMarkers('Done.\n\n  [[send-file:/tmp/indented.txt]]  \n\n');
assert.deepStrictEqual(indented.files, ['/tmp/indented.txt'], 'indented trailing markers are accepted');
assert.strictEqual(indented.text, 'Done.', 'trailing blank lines are removed');

assert.strictEqual(isImageFile('/tmp/a.PNG'), true, 'png is an image');
assert.strictEqual(isImageFile('/tmp/a.jpeg'), true, 'jpeg is an image');
assert.strictEqual(isImageFile('/tmp/a.webp'), true, 'webp is an image');
assert.strictEqual(isImageFile('/tmp/a.gif'), false, 'gif is sent as a document');
assert.strictEqual(isImageFile('/tmp/a.txt'), false, 'text is not an image');
assert.strictEqual(isImageFile(''), false, 'empty path is not an image');

const payload = Buffer.from('hello world');
const multipart = buildMultipart(
  { chat_id: 42, caption: 'test file', skipped: null },
  { field: 'document', filename: 'a"b.txt', mime: 'text/plain', data: payload }
);
const raw = multipart.body.toString('utf8');
assert.strictEqual(
  multipart.body.length,
  Buffer.byteLength(raw, 'utf8'),
  'body length matches its UTF-8 content'
);
assert(raw.startsWith(`--${multipart.boundary}\r\n`), 'body starts with the boundary');
assert(raw.includes('name="chat_id"\r\n\r\n42\r\n'), 'fields are encoded');
assert(!raw.includes('name="skipped"'), 'null fields are skipped');
assert(raw.includes('filename="a_b.txt"'), 'filename quotes are sanitized');
assert(raw.includes('Content-Type: text/plain'), 'file MIME type is included');
assert(raw.includes('hello world'), 'file bytes are included');
assert(raw.endsWith(`\r\n--${multipart.boundary}--\r\n`), 'body ends with the closing boundary');

console.log('files tests passed');
