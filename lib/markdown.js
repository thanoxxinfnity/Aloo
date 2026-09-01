/**
 * ALOO — Minimal, safe markdown renderer.
 * ---------------------------------------------------------------------------
 * Model output is UNTRUSTED. A prompt-injected reply containing
 * `<img onerror=...>` must never execute, so the pipeline is strictly:
 *
 *      escape ALL html  ->  then re-introduce only our own tags
 *
 * Doing it in that order is what makes this safe; a renderer that escapes
 * afterwards, or that allows raw HTML through, does not have this property.
 * We support the subset a chat assistant actually emits — headings, bold,
 * italics, lists, links, inline code, fenced code, blockquotes, rules — and
 * nothing else.
 */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links become anchors; javascript:/data: URLs stay plain text. */
function safeHref(url) {
  const trimmed = String(url).trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export function renderMarkdown(input) {
  if (!input) return '';

  // 1. Escape everything up front.
  let text = escapeHtml(input);

  // 2. Pull fenced code blocks out before any inline rule can touch them.
  //    Placeholders use a token shape that cannot appear in escaped text.
  const blocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(
      `<pre><code data-lang="${escapeHtml(lang || '')}">${code.replace(/\n$/, '')}</code></pre>`
    );
    return `@@ALOOBLOCK${blocks.length - 1}@@`;
  });

  // 3. Inline code, same trick at a smaller scale.
  const inlines = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlines.push(`<code>${code}</code>`);
    return `@@ALOOCODE${inlines.length - 1}@@`;
  });

  // 4. Block-level structure, line by line.
  const lines = text.split('\n');
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(listType === 'ul' ? '</ul>' : '</ol>');
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s{0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeList();
      out.push('<hr />');
      continue;
    }

    const quote = /^\s{0,3}&gt;\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  let html = out.join('\n');

  // 5. Restore the placeholders.
  html = html.replace(/@@ALOOCODE(\d+)@@/g, (_m, i) => inlines[Number(i)] || '');
  html = html.replace(/@@ALOOBLOCK(\d+)@@/g, (_m, i) => blocks[Number(i)] || '');
  // A fenced block wrapped in <p> by the paragraph rule — unwrap it.
  html = html.replace(/<p>(<pre>[\s\S]*?<\/pre>)<\/p>/g, '$1');

  return html;
}

/** Inline spans: links, bold, italics, strikethrough, citation markers. */
function inline(str) {
  return (
    str
      // [text](url)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
        const href = safeHref(url);
        return href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : label;
      })
      // Bare URLs.
      .replace(
        /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      // Research citations like [3] get a highlight.
      .replace(/\[(\d{1,2})\]/g, '<sup class="cite">[$1]</sup>')
  );
}

/** Strip markdown to plain text — used for copy-to-clipboard and speech. */
export function markdownToPlain(input) {
  return String(input || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>]/g, '')
    .trim();
}
