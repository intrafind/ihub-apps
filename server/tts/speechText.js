/**
 * Turn a chat message (Markdown, sometimes with HTML) into text a speech model
 * can read aloud, and split it into requests the provider accepts.
 *
 * A TTS model reads every character it gets: `**`, `|---|`, a URL or a code
 * block come out as noise, or as a minute of the model spelling out
 * JavaScript. So markup is dropped and only the words survive, keeping the
 * paragraph structure because that is where the chunker cuts and where a
 * listener expects a pause.
 *
 * Deliberately dropped: fenced code, block math, images, raw URLs, citation
 * markers ([1], [^1]), footnote definitions, HTML tags (their text stays,
 * except for <script>/<style> and inline <think> reasoning), table separator
 * rows and horizontal rules.
 *
 * The input comes from the user (up to 200,000 characters), so every pattern
 * here must stay linear: see the notes on `stripInline` and `dropElements`.
 */

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
};

/** End a line with a full stop when it ends without punctuation, so the model pauses. */
function terminate(line) {
  const trimmed = line.trim();
  if (!trimmed) return '';
  return /[.!?;:…,)"'»]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Strip inline Markdown (links, emphasis, inline code, citations) from one line. */
function stripInline(line) {
  // Every scanning class excludes its own opening delimiter, so an unclosed
  // `![`, `[`, `(` or `<` stops at the next one instead of rescanning the
  // rest of the line from each occurrence — the input is user-supplied and
  // can be up to 200,000 characters.
  return (
    line
      // Images: nothing to read.
      .replace(/!\[[^[\]]*\]\([^()]*\)/g, '')
      .replace(/!\[[^[\]]*\]\[[^[\]]*\]/g, '')
      // Links: keep the label, drop the target.
      .replace(/\[([^[\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/\[([^[\]]+)\]\[[^[\]]*\]/g, '$1')
      // Citation and footnote markers: [1], [1, 2], [^1], [1][2].
      .replace(/ ?\[\^?[\d ,–-]+\]/g, '')
      .replace(/ ?\[\^[^[\]]+\]/g, '')
      // Autolinks and bare URLs: a URL read aloud is noise.
      .replace(/<(?:https?|mailto|ftp):[^<>\s]+>/gi, '')
      .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, '')
      // Inline math and code: keep the content without the delimiters.
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/\$([^$\n]+)\$/g, '$1')
      // Emphasis and strikethrough.
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?;:]|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      // Bare emphasis characters left over from unbalanced markup.
      .replace(/(^|\s)[*_~]+(?=\s|$)/g, '$1')
  );
}

/**
 * Remove `<script>`, `<style>` and `<think>`/`<thinking>` elements with their
 * content: code that styles the page, and a model's reasoning. Each search
 * continues from where the last one ended (`lastIndex`), so many unclosed
 * tags cost one pass, not one pass each. An unclosed element drops the rest
 * of the text: a cut-off `<think>` block must not be read.
 */
function dropElements(text) {
  const openTag = /<(script|style|thinking|think)(?=[\s/>])/gi;
  let result = '';
  let pos = 0;
  let match;
  while ((match = openTag.exec(text))) {
    result += `${text.slice(pos, match.index)}\n`;
    const closeTag = new RegExp(`</${match[1]}\\s*>`, 'gi');
    closeTag.lastIndex = openTag.lastIndex;
    const end = closeTag.exec(text);
    if (!end) return result;
    pos = end.index + end[0].length;
    openTag.lastIndex = pos;
  }
  return result + text.slice(pos);
}

/** A fence line (``` or ~~~), with up to three spaces of indent. */
const FENCE = /^ ?(`{3,}|~{3,})/;

/**
 * Convert Markdown into plain, speakable text.
 *
 * @param {string} markdown
 * @returns {string} Paragraphs separated by a blank line; '' when nothing is left.
 */
export function toSpeechText(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return '';

  let text = dropElements(markdown.replace(/\r\n?/g, '\n'))
    // Block math is never read.
    .replace(/\$\$[\s\S]*?\$\$/g, '\n')
    // HTML: block-level tags end a paragraph, every other tag just goes.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|li|tr|h[1-6]|details|summary|blockquote|ul|ol|table)\b[^<>]*>/gi, '\n')
    .replace(/<\/?[a-z][^<>]*>/gi, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, m => HTML_ENTITIES[m]);

  // Collapse runs before any per-line pattern sees them: a run of spaces or
  // of sentence punctuation is where a backtracking pattern turns quadratic.
  text = text.replace(/[^\S\n]+/g, ' ').replace(/[.!?…]{4,}/g, '...');

  const paragraphs = [];
  let current = [];
  const flush = () => {
    if (current.length) paragraphs.push(current.join(' '));
    current = [];
  };

  // While inside a fenced code block: the opening marker. Code is never read,
  // and an unterminated fence (a cut-off answer) drops everything after it.
  let fence = null;

  for (const rawLine of text.split('\n')) {
    const marker = rawLine.match(FENCE);
    if (fence) {
      const closes =
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !rawLine.slice(marker[0].length).trim();
      if (closes) fence = null;
      continue;
    }
    if (marker) {
      flush();
      fence = marker[1];
      continue;
    }

    let line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    // Horizontal rules end a paragraph; a table's separator row is skipped so
    // the header and its rows are read together.
    if (/^([-*_])( ?\1){2,}$/.test(line)) {
      flush();
      continue;
    }
    if (/^\|? ?:?-{2,}:? ?(\| ?:?-{2,}:? ?)*\|?$/.test(line)) continue;
    // Footnote definitions and link reference definitions.
    if (/^\[\^[^\]]+\]:/.test(line) || /^\[[^\]]+\]: ?\S/.test(line)) continue;

    // Headings and list items stand alone: each is its own sentence.
    const heading = line.match(/^#{1,6} (.*)$/);
    if (heading) {
      flush();
      // Drop a closing `###` sequence without a backtracking pattern.
      let title = heading[1];
      let end = title.length;
      while (end > 0 && (title[end - 1] === '#' || title[end - 1] === ' ')) end--;
      title = title.slice(0, end);
      const spoken = terminate(stripInline(title));
      if (spoken) paragraphs.push(spoken);
      continue;
    }

    // Blockquote markers.
    line = line.replace(/^(> ?)+/, '');

    // Table rows: read the cells as a list.
    if (/^\|.*\|$/.test(line)) {
      const cells = line
        .slice(1, -1)
        .split('|')
        .filter(cell => cell.trim())
        .map(cell => stripInline(cell).trim())
        .filter(Boolean);
      if (cells.length) current.push(terminate(cells.join(', ')));
      continue;
    }

    const listItem = line.match(/^(?:[-*+]|\d{1,3}[.)]) (?:\[[ xX]\] )?(.*)$/);
    if (listItem) {
      const spoken = terminate(stripInline(listItem[1]));
      if (spoken) current.push(spoken);
      continue;
    }

    const spoken = stripInline(line).trim();
    if (spoken) current.push(spoken);
  }
  flush();

  return paragraphs
    .map(p => p.replace(/ {2,}/g, ' ').trim())
    .filter(p => /[\p{L}\p{N}]/u.test(p))
    .join('\n\n');
}

/**
 * Split speakable text into pieces of at most `maxChars`, cutting at paragraph
 * boundaries, then sentences, then words — never inside a word unless a single
 * word is longer than the limit. Providers cap one request (Mistral recommends
 * about 300 words) and stream it as it is generated, so time to first audio
 * does not depend on the piece size; fewer, fuller pieces mean fewer seams.
 *
 * @param {string} text - Output of {@link toSpeechText}.
 * @param {{ maxChars?: number }} [opts]
 * @returns {string[]}
 */
export function splitSpeechText(text, { maxChars = 1500 } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];

  // Break into the smallest units we are willing to cut between: sentences
  // (a paragraph boundary is also a sentence boundary), and words when a
  // sentence alone is over the limit.
  const units = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    // A sentence ends at . ! ? … (plus closing quotes/brackets) followed by
    // whitespace or the end — so "0.7" or "e.g." mid-word never splits.
    const sentences = paragraph.match(/\S[\s\S]*?(?:[.!?…]+["'»)\]]*(?=\s|$)|$)/g) || [paragraph];
    sentences.forEach((sentence, i) => {
      const trimmed = sentence.trim();
      if (!trimmed) return;
      units.push({ text: trimmed, paragraphEnd: i === sentences.length - 1 });
    });
  }

  const chunks = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const unit of units) {
    const pieces = unit.text.length > maxChars ? splitWords(unit.text, maxChars) : [unit.text];
    for (const piece of pieces) {
      const joiner = current ? (current.endsWith('\n\n') ? '' : ' ') : '';
      if (current && current.length + joiner.length + piece.length > maxChars) push();
      current += (current ? joiner : '') + piece;
    }
    if (unit.paragraphEnd) current += '\n\n';
  }
  push();
  return chunks;
}

function splitWords(sentence, maxChars) {
  const out = [];
  let current = '';
  for (const word of sentence.split(/\s+/)) {
    if (word.length > maxChars) {
      if (current) out.push(current);
      current = '';
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }
    if (current && current.length + 1 + word.length > maxChars) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

export default { toSpeechText, splitSpeechText };
