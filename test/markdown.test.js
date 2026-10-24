'use strict';

const assert = require('assert');
const { toTelegramHtml, splitMarkdown } = require('../src/markdown');

function eq(input, expected, label) {
  assert.strictEqual(toTelegramHtml(input), expected, label || input);
}

eq('**Halo**', '<b>Halo</b>', 'bold');
eq('ini *miring* ya', 'ini <i>miring</i> ya', 'italic');
eq('***penting***', '<b><i>penting</i></b>', 'bold+italic');
eq('pakai `**bukan bold**`', 'pakai <code>**bukan bold**</code>', 'inline code');
eq('```html\n<b>x</b>\n```',
  '<pre><code class="language-html">&lt;b&gt;x&lt;/b&gt;</code></pre>',
  'fenced code');
eq('[contoh](https://example.com/?a=1&b=2)',
  '<a href="https://example.com/?a=1&amp;b=2">contoh</a>',
  'link');
eq('# Judul', '<b>Judul</b>', 'heading');
eq('file_name_here', 'file_name_here', 'snake_case');
eq('* item', '• item', 'bullet');
eq('<b>hi</b>', '&lt;b&gt;hi&lt;/b&gt;', 'raw html escaped');
eq('~~hapus~~', '<s>hapus</s>', 'strikethrough');
eq('> kutipan', '<blockquote>kutipan</blockquote>', 'blockquote');

// Chunking must respect code fences.
const long =
  'a\n'.repeat(600) +
  '```js\n' +
  'code\n'.repeat(50) +
  '```\n' +
  'b\n'.repeat(600);
const chunks = splitMarkdown(long, 800);
assert(chunks.length >= 2, 'long text is split');
for (const chunk of chunks) {
  const fences = (chunk.match(/```/g) || []).length;
  assert.strictEqual(fences % 2, 0, 'each chunk has balanced fences');
  assert(chunk.length <= 1400, `chunk too large (${chunk.length})`);
}

console.log('markdown tests passed');
