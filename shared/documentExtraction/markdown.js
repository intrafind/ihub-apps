/**
 * HTML → Markdown for extracted Word documents.
 *
 * mammoth's HTML goes through Turndown with rules chosen for a model reader:
 * no escaping of Markdown characters (it would put backslashes into every `1.`, `[1]` and
 * `a_b` of the document), tables as GFM tables with merged cells expanded, images reduced to
 * their alt text (never base64), footnotes as `[^n]`, no link noise from internal anchors.
 *
 * Several rules are copied from `server/tools/lib/pageContent.js` (the web page reader);
 * consolidating the two converters is a release 2 cleanup.
 *
 * @module shared/documentExtraction/markdown
 */

const FOOTNOTE_REF = /^#(foot|end)note-(\d+)$/;
const FOOTNOTE_BACKLINK = /^#(foot|end)note-ref-\d+$/;

const footnoteLabel = (kind, number) => (kind === 'end' ? `[^e${number}]` : `[^${number}]`);

/**
 * Whitespace runs that contain a line break, replaced by `replacement`. One pass over maximal
 * whitespace runs: a pattern of optional spaces, line breaks and optional spaces rescans every
 * run quadratically (a document with a very long run of spaces would stall the tab).
 */
const replaceNewlineRuns = (text, replacement) =>
  text.replace(/\s+/g, run => (run.includes('\n') ? replacement : run));

/** `text` with a trailing run of line breaks reduced to one (linear, unlike a `\n+$` pattern). */
const singleTrailingNewline = text => {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end -= 1;
  return end === text.length ? text : `${text.slice(0, end)}\n`;
};

/** `line` without trailing spaces and tabs (linear, unlike a `[ \t]+$` pattern). */
const stripTrailingBlanks = line => {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return end === line.length ? line : line.slice(0, end);
};

/** A table cell on one line: paragraphs and line breaks as `<br>`, pipes escaped. */
function cellMarkdown(service, cell) {
  const doc = cell.ownerDocument;
  const clone = cell.cloneNode(true);
  // A nested table has no place in a one-line cell: flatten it to its text.
  for (const nested of Array.from(clone.querySelectorAll('table'))) {
    if (!nested.parentNode) continue;
    const text = Array.from(nested.querySelectorAll('tr'))
      .map(row =>
        Array.from(row.children)
          .filter(c => c.nodeName === 'TD' || c.nodeName === 'TH')
          .map(c => c.textContent.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' / ')
      )
      .filter(Boolean)
      .join(' ; ');
    nested.parentNode.replaceChild(doc.createTextNode(text), nested);
  }
  // `# Heading` inside a table row would be noise: headings in cells are plain text.
  for (const heading of Array.from(clone.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    const paragraph = doc.createElement('p');
    while (heading.firstChild) paragraph.appendChild(heading.firstChild);
    heading.parentNode.replaceChild(paragraph, heading);
  }
  const text = replaceNewlineRuns(service.turndown(clone.innerHTML || ''), '<br>')
    .replace(/^(<br>)+|(<br>)+$/g, '')
    .trim();
  return escapeTableCell(text);
}

/**
 * Text of one table cell as it goes between pipes. A pipe ends the cell, so it is escaped.
 * Backslashes are doubled first — only in a cell that needs the escape — because a backslash in
 * front of a pipe would escape the escape (`\|` in the text must come out as `\\\|`, not `\\|`,
 * which is a backslash and a column delimiter).
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeTableCell(text) {
  return text.includes('|') ? text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|') : text;
}

/**
 * Lines of a Markdown table from a grid of cell texts, every row as wide as the widest.
 *
 * @param {string[][]} grid
 * @param {{header?: boolean}} [options] - `header`: the first row is a header row and gets the
 *   separator row (a table without a header row of its own is not given an invented one)
 * @returns {string[]}
 */
export function markdownTableLines(grid, { header = true } = {}) {
  let width = 0;
  for (const row of grid) width = Math.max(width, row.length);
  const lines = grid.map(row => {
    const cells = Array.from({ length: width }, (_, i) => escapeTableCell(row[i] ?? ''));
    return `| ${cells.join(' | ')} |`;
  });
  if (header && grid.length > 0) lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return lines;
}

/**
 * Rows of a table as a grid of cell texts. A cell that spans rows repeats its text in each
 * spanned row (every row stays self-contained); one that spans columns keeps its text in the
 * first column and leaves the others empty. Columns never shift.
 */
function tableGrid(service, table) {
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    // Rows of a nested table belong to that table's own cell.
    row => row.closest('table') === table
  );
  const grid = [];
  const pending = []; // column → { text, remaining }
  for (const row of rows) {
    const cells = Array.from(row.children).filter(c => c.nodeName === 'TD' || c.nodeName === 'TH');
    const line = [];
    let column = 0;
    const fillPending = () => {
      while (pending[column] && pending[column].remaining > 0) {
        line[column] = pending[column].text;
        pending[column].remaining -= 1;
        column += 1;
      }
    };
    for (const cell of cells) {
      fillPending();
      const text = cellMarkdown(service, cell);
      const colspan = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
      const rowspan = Math.max(1, Number(cell.getAttribute('rowspan')) || 1);
      for (let offset = 0; offset < colspan; offset += 1) {
        line[column + offset] = offset === 0 ? text : '';
        pending[column + offset] = { text: offset === 0 ? text : '', remaining: rowspan - 1 };
      }
      column += colspan;
    }
    fillPending();
    for (let c = column; c < pending.length; c += 1) {
      if (pending[c] && pending[c].remaining > 0) {
        line[c] = pending[c].text;
        pending[c].remaining -= 1;
      }
    }
    if (line.length > 0) grid.push(Array.from(line, value => value || ''));
  }
  return grid;
}

/**
 * @param {typeof import('turndown')} TurndownService - Turndown constructor (injected)
 * @returns {import('turndown')} Turndown service with the document rules
 */
export function createDocumentMarkdownConverter(TurndownService) {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---'
  });
  // Escaping would put a backslash into every "1.", "[1]", "a_b" and "*" of the document.
  service.escape = text => text;

  service.remove(['script', 'style', 'noscript']);

  // Later rules take precedence over earlier ones.
  service.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      return alt ? `[Image: ${alt}]` : '';
    }
  });

  // Links keep their text and target. A link inside the document (`#_Toc1`, table of contents)
  // is only its text.
  service.addRule('link', {
    filter: node => node.nodeName === 'A' && Boolean(node.getAttribute('href')),
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const href = node.getAttribute('href').trim();
      if (href.startsWith('#') || /^javascript:/i.test(href)) return content;
      const destination = href.replace(
        /[()\\\s]/g,
        char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
      );
      return `[${content}](${destination})`;
    }
  });

  // The "↑" link back from a footnote to its reference is noise.
  service.addRule('footnoteBackLink', {
    filter: node =>
      node.nodeName === 'A' && FOOTNOTE_BACKLINK.test(node.getAttribute('href') || ''),
    replacement: () => ''
  });

  // Footnote reference in the text: `[^1]`.
  service.addRule('footnoteReference', {
    filter: node => {
      if (node.nodeName !== 'SUP') return false;
      const link = node.querySelector('a');
      return !!link && FOOTNOTE_REF.test(link.getAttribute('href') || '');
    },
    replacement: (_content, node) => {
      const [, kind, number] = node.querySelector('a').getAttribute('href').match(FOOTNOTE_REF);
      return footnoteLabel(kind, number);
    }
  });

  // The footnote list at the end of the document: `[^1]: text`.
  service.addRule('footnoteDefinitions', {
    filter: node =>
      node.nodeName === 'OL' &&
      node.children.length > 0 &&
      Array.from(node.children).every(
        child => child.nodeName === 'LI' && FOOTNOTE_REF.test(`#${child.getAttribute('id') || ''}`)
      ),
    replacement: (_content, node) => {
      const definitions = Array.from(node.children).map(item => {
        const [, kind, number] = `#${item.getAttribute('id')}`.match(FOOTNOTE_REF);
        const text = replaceNewlineRuns(service.turndown(item.innerHTML || ''), ' ').trim();
        return `${footnoteLabel(kind, number)}: ${text}`;
      });
      return `\n\n${definitions.join('\n')}\n\n`;
    }
  });

  // One space after the list marker instead of Turndown's three.
  service.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const text = singleTrailingNewline(content.replace(/^\n+/, '')).replace(/\n/g, '\n  ');
      const parent = node.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start')) || 1;
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      }
      return prefix + text + (node.nextSibling && !/\n$/.test(text) ? '\n' : '');
    }
  });

  service.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const grid = tableGrid(service, node);
      if (grid.length === 0) return '';
      const width = Math.max(...grid.map(row => row.length));
      const line = row =>
        `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
      const [header, ...rows] = grid;
      const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
      return `\n\n${[line(header), separator, ...rows.map(line)].join('\n')}\n\n`;
    }
  });

  return service;
}

/** Top-level blocks converted per Turndown call (see htmlToMarkdown). */
const CHUNK_BLOCKS = 100;

/**
 * Convert mammoth's HTML to Markdown, a bounded number of top-level blocks at a time.
 *
 * Turndown joins block after block by copying the whole output so far, so converting a long
 * document in one call takes quadratic time (measured in Chromium: 5,000 paragraphs 1.1 s,
 * 20,000 paragraphs 12.6 s, against 0.6 s for mammoth itself). Top-level blocks — paragraphs,
 * headings, lists, tables — are independent in Markdown, so converting them in chunks and
 * joining the pieces with a blank line gives the same text in linear time.
 *
 * @param {import('turndown')} service - From createDocumentMarkdownConverter
 * @param {string} html
 * @param {typeof DOMParser} DOMParserCtor
 * @returns {string} Markdown (not yet normalized)
 */
export function htmlToMarkdown(service, html, DOMParserCtor) {
  const doc = new DOMParserCtor().parseFromString(html, 'text/html');
  const blocks = Array.from(doc.body.childNodes);
  const pieces = [];
  for (let start = 0; start < blocks.length; start += CHUNK_BLOCKS) {
    const chunk = doc.createElement('div');
    for (const block of blocks.slice(start, start + CHUNK_BLOCKS)) chunk.appendChild(block);
    pieces.push(service.turndown(chunk));
  }
  return pieces.join('\n\n');
}

/**
 * Tidy converted Markdown: no trailing spaces, soft hyphens gone, non-breaking hyphens
 * (mammoth emits U+2011 for `w:noBreakHyphen`) as plain `-` so the text matches what was
 * typed, at most one blank line in a row.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function normalizeMarkdown(markdown) {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00AD/g, '')
    .replace(/\u2011/g, '-')
    .split('\n')
    .map(stripTrailingBlanks)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
