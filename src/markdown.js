'use strict';

/**
 * Minimal Markdown -> Telegram HTML converter.
 *
 * Covers the constructs that show up in agent replies: fenced code, inline
 * code, bold, italic, strikethrough, links, headings, blockquotes, bullet
 * lists, and horizontal rules. Everything else is HTML-escaped and sent as
 * plain text, so Telegram never interprets model output as markup.
 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return String(text).replace(/"/g, '&quot;');
}

function renderPre(code, lang) {
  const language = String(lang || '').trim();
  const cls = /^[\w.+#-]+$/.test(language)
    ? ` class="language-${language}"`
    : '';
  return `<pre><code${cls}>${escapeHtml(String(code).replace(/\n$/, ''))}</code></pre>`;
}

function toTelegramHtml(markdown) {
  let text = String(markdown == null ? '' : markdown);
  const stash = [];
  const put = html => {
    const token = `\uE000${stash.length}\uE001`;
    stash.push(html);
    return token;
  };

  // Code first: its contents must never be formatted.
  text = text.replace(/(^|\n)[ \t]*```([^\n`]*)\n([\s\S]*?)```/g,
    (m, lead, lang, code) => lead + put(renderPre(code, lang)));
  text = text.replace(/(^|\n)[ \t]*~~~([^\n~]*)\n([\s\S]*?)~~~/g,
    (m, lead, lang, code) => lead + put(renderPre(code, lang)));

  text = text.replace(/`([^`\n]+)`/g,
    (m, code) => put(`<code>${escapeHtml(code)}</code>`));

  // Escape everything that is not code.
  text = escapeHtml(text);

  // Images and links.
  text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, alt, url) => `<a href="${escapeAttr(url)}">${alt || 'image'}</a>`);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|tg:\/\/[^\s)]+)\)/g,
    (m, label, url) => `<a href="${escapeAttr(url)}">${label}</a>`);

  // Headings.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm, '<b>$1</b>');

  // Blockquotes (the leading > was escaped to &gt;).
  text = text.replace(/^[ \t]*&gt;[ \t]?(.*)$/gm, '<blockquote>$1</blockquote>');

  // Bullets, before italic so "* item" is not treated as emphasis.
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');

  // Bold+italic first, so the single markers do not cross tags.
  text = text.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<b><i>$1</i></b>');
  text = text.replace(/(^|[^\w])___([\s\S]+?)___(?!\w)/g, '$1<b><i>$2</i></b>');

  // Bold, strikethrough, italic.
  text = text.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/(^|[^\w])__([\s\S]+?)__(?!\w)/g, '$1<b>$2</b>');
  text = text.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');
  text = text.replace(/(^|[^*])\*(?!\*)([^\s*][^*\n]*?)\*(?!\*)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[^\w])_([^\s_][^_\n]*?)_(?!\w)/g, '$1<i>$2</i>');

  // Horizontal rules.
  text = text.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '────────');

  return text.replace(/\uE000(\d+)\uE001/g,
    (m, index) => stash[Number(index)] ?? m);
}

/**
 * Split Markdown into Telegram-sized chunks. Splits are never made inside a
 * fenced code block (unless the block itself is absurdly large).
 */
function splitMarkdown(text, max = 2800) {
  const source = String(text == null ? '' : text);
  if (source.length <= max) return [source];

  const lines = source.split('\n');
  const chunks = [];
  let current = [];
  let currentLen = 0;
  let inFence = false;

  const flush = () => {
    if (!current.length) return;
    chunks.push(current.join('\n'));
    current = [];
    currentLen = 0;
  };

  for (const line of lines) {
    const isFence = /^[ \t]*(```|~~~)/.test(line);
    const lineLen = line.length + 1;

    if (!inFence && currentLen + lineLen > max && current.length) flush();

    current.push(line);
    currentLen += lineLen;
    if (isFence) inFence = !inFence;
  }
  flush();

  const out = [];
  for (const chunk of chunks) {
    if (chunk.length <= max + 500) {
      out.push(chunk);
      continue;
    }
    let rest = chunk;
    while (rest.length > max + 500) {
      let cut = rest.lastIndexOf('\n', max);
      if (cut < max * 0.5) cut = max;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest) out.push(rest);
  }

  return out.filter(chunk => chunk.trim() !== '');
}

module.exports = { toTelegramHtml, splitMarkdown, escapeHtml };
