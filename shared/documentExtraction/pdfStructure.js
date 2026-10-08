/**
 * Structure of a PDF beyond its lines: headings and tables, read from the sources a PDF offers
 * in this order of trust — the tagged structure tree, the outline (bookmarks), a conservative
 * font-size heuristic. The first source that yields headings wins for the whole document, so
 * a document never mixes two styles of guessing.
 *
 * Pure functions on pdf.js output (items of `getTextContent({ includeMarkedContent: true })`,
 * the result of `page.getStructTree()`, the resolved outline). pdf.js itself is not imported:
 * `shared/` has no bare imports, and the browser and the node tests load different builds.
 *
 * Wrong is worse than missing: a line is only turned into a heading or a table row when the
 * source is unambiguous, otherwise it stays the plain line it was before. Text is never
 * dropped or reordered — the structure only adds `#` prefixes and `|` cell separators.
 *
 * @module shared/documentExtraction/pdfStructure
 */

/** Upper bound of struct tree nodes read per page (hostile or broken trees). */
const MAX_TREE_NODES = 200000;

/** Outline entries read per document; a longer outline is cut, not rejected. */
export const MAX_OUTLINE_ENTRIES = 2000;

/** Line comparisons the outline matching may spend per document. */
const MAX_OUTLINE_COMPARISONS = 2000000;

/** A line longer than this is a sentence, not a heading. */
const MAX_HEADING_CHARS = 120;

const HEADING_ROLE = /^H([1-6])$/;
const CELL_ROLES = new Set(['TD', 'TH']);

/** Level of a structure role: `H1`…`H6` and `Title`; the untyped `H` has no level and is ignored. */
export function headingLevelOfRole(role) {
  if (role === 'Title') return 1;
  const match = HEADING_ROLE.exec(typeof role === 'string' ? role : '');
  return match ? Number(match[1]) : 0;
}

function collapse(text) {
  return text.replace(/[ \t]+/g, ' ').trim();
}

/**
 * Index of a page's structure tree: for each marked-content id the table, row, cell and heading
 * the text belongs to.
 *
 * The tree is walked iteratively and node by node counted, so a deep or huge tree cannot
 * exhaust the stack or the time of the upload.
 *
 * @param {object|null} tree - `await page.getStructTree()`
 * @returns {{infoOf: (id: string) => object|undefined, headings: number, tables: number}|null}
 */
export function indexStructTree(tree) {
  if (!tree || typeof tree !== 'object') return null;
  const parents = new Map();
  const owners = new Map();
  const stack = [tree];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_TREE_NODES) {
    const node = stack.pop();
    visited += 1;
    if (!Array.isArray(node.children)) continue;
    for (const child of node.children) {
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'content') {
        if (typeof child.id === 'string') owners.set(child.id, node);
      } else {
        parents.set(child, node);
        stack.push(child);
      }
    }
  }

  const cache = new Map();
  let headings = 0;
  let tables = 0;
  const infoOfNode = owner => {
    if (cache.has(owner)) return cache.get(owner);
    // Chain from the root to the element that holds the content.
    const chain = [];
    for (let node = owner; node; node = parents.get(node)) chain.push(node);
    chain.reverse();
    const info = {};
    const tableAt = chain.findIndex(node => node.role === 'Table');
    if (tableAt >= 0) {
      // The outermost table decides: a nested table is flattened into its cell.
      const rowAt = chain.findIndex((node, i) => i > tableAt && node.role === 'TR');
      const cell =
        rowAt >= 0 ? chain.slice(rowAt + 1).find(node => CELL_ROLES.has(node.role)) : null;
      if (cell) {
        const row = chain[rowAt];
        const cells = (row.children || []).filter(child => CELL_ROLES.has(child.role));
        info.table = chain[tableAt];
        info.row = row;
        info.cellIndex = cells.indexOf(cell);
        info.cellCount = cells.length;
        info.headerRow = cells.length > 0 && cells.every(child => child.role === 'TH');
      }
    }
    if (!info.row) {
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const level = headingLevelOfRole(chain[i].role);
        if (level > 0) {
          info.heading = chain[i];
          info.level = level;
          break;
        }
      }
    }
    cache.set(owner, info);
    return info;
  };

  const infos = new Map();
  for (const [id, owner] of owners) {
    const info = infoOfNode(owner);
    infos.set(id, info);
  }
  const seenHeadings = new Set();
  const seenTables = new Set();
  for (const info of infos.values()) {
    if (info.heading && !seenHeadings.has(info.heading)) {
      seenHeadings.add(info.heading);
      headings += 1;
    }
    if (info.table && !seenTables.has(info.table)) {
      seenTables.add(info.table);
      tables += 1;
    }
  }
  return { infoOf: id => infos.get(id), headings, tables };
}

/** pdf.js reports fixed-width fonts as the generic family `monospace` in the text styles. */
function isMonospace(styles, fontName) {
  const style = styles && fontName ? styles[fontName] : null;
  return Boolean(style) && style.fontFamily === 'monospace';
}

/** Most frequent height of the characters of a line (spacers have height 0 and do not count). */
function dominantHeight(parts) {
  const chars = new Map();
  for (const { str, height } of parts) {
    const count = str.trim().length;
    if (count > 0 && height > 0) {
      const rounded = Math.round(height * 10) / 10;
      chars.set(rounded, (chars.get(rounded) || 0) + count);
    }
  }
  let best = 0;
  let bestCount = 0;
  for (const [height, count] of chars) {
    if (count > bestCount) {
      best = height;
      bestCount = count;
    }
  }
  return best;
}

/** A line of code: most of its characters are set in a fixed-width font. */
function isMostlyMono(parts) {
  let mono = 0;
  let other = 0;
  for (const { str, mono: isMono } of parts) {
    const count = str.trim().length;
    if (isMono) mono += count;
    else other += count;
  }
  return mono > other;
}

/**
 * Lines of a page as arrays of parts `{ str, height, info }`. A line ends where pdf.js reports
 * `hasEOL`; marked-content items carry no text and only maintain the stack that tells which
 * structure element a text item belongs to.
 */
function readLines(items, index, styles) {
  const lines = [];
  let parts = [];
  const stack = [];
  const finish = () => {
    if (parts.length > 0) lines.push(parts);
    parts = [];
  };
  const infoOfStack = () => {
    if (!index) return null;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const info = stack[i] === null ? undefined : index.infoOf(stack[i]);
      if (info) return info;
    }
    return null;
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    if (typeof item.str !== 'string') {
      if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
        stack.push(typeof item.id === 'string' ? item.id : null);
      } else if (item.type === 'endMarkedContent') {
        stack.pop();
      }
      continue;
    }
    parts.push({
      str: item.str,
      height: item.height,
      mono: isMonospace(styles, item.fontName),
      info: infoOfStack()
    });
    if (item.hasEOL) finish();
  }
  finish();
  return lines;
}

/**
 * Where a line belongs: a table row, a heading, or nowhere (plain line). Only the parts that
 * carry text count; a line that mixes owners stays plain.
 */
function classify(parts) {
  const real = parts.filter(part => part.str.trim() !== '');
  if (real.length === 0) return null;
  const rows = new Set(real.map(part => (part.info && part.info.row) || null));
  if (rows.size === 1) {
    const [row] = rows;
    if (row) return { kind: 'row', row, info: real[0].info };
    const headings = new Set(real.map(part => (part.info && part.info.heading) || null));
    if (headings.size === 1) {
      const [heading] = headings;
      if (heading) return { kind: 'heading', heading, level: real[0].info.level };
    }
  }
  return { kind: 'line' };
}

/** Blocks of one page: plain lines, tagged headings and tables, in reading (stream) order. */
export function pageBlocks(items, tree, styles) {
  const index = indexStructTree(tree);
  const lines = readLines(items, index, styles);
  const blocks = [];

  let table = null;
  let row = null;
  let heading = null;
  const flushRow = () => {
    if (row) table.rows.push(row);
    row = null;
  };
  const flushTable = () => {
    flushRow();
    if (table) {
      let width = 1;
      for (const r of table.rows) width = Math.max(width, r.cells.length);
      for (const r of table.rows) while (r.cells.length < width) r.cells.push('');
      blocks.push({ type: 'table', rows: table.rows });
    }
    table = null;
  };
  const flushHeading = () => {
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading.level,
        text: heading.texts.join(' '),
        size: heading.size
      });
    }
    heading = null;
  };

  for (const parts of lines) {
    const text = collapse(parts.map(part => part.str).join(''));
    if (text === '') continue;
    const kind = classify(parts) || { kind: 'line' };

    if (kind.kind === 'row') {
      flushHeading();
      if (table && table.node !== kind.info.table) flushTable();
      if (!table) table = { node: kind.info.table, rows: [] };
      if (row && row.node !== kind.row) flushRow();
      if (!row) row = { node: kind.row, cells: [], header: kind.info.headerRow };
      const byCell = new Map();
      for (const part of parts) {
        if (!part.info || part.info.row !== kind.row) continue;
        byCell.set(part.info.cellIndex, (byCell.get(part.info.cellIndex) || '') + part.str);
      }
      for (const [cellIndex, raw] of byCell) {
        const value = collapse(raw);
        if (value === '') continue;
        const at = cellIndex >= 0 ? cellIndex : Math.max(row.cells.length - 1, 0);
        while (row.cells.length <= at) row.cells.push('');
        row.cells[at] = row.cells[at] ? `${row.cells[at]} ${value}` : value;
      }
      // Empty cells have no content in the stream: the row is as wide as the tree says.
      while (row.cells.length < kind.info.cellCount) row.cells.push('');
      continue;
    }

    flushTable();
    if (kind.kind === 'heading') {
      if (heading && heading.node !== kind.heading) flushHeading();
      if (!heading)
        heading = { node: kind.heading, level: kind.level, texts: [], size: dominantHeight(parts) };
      heading.texts.push(text);
      continue;
    }
    flushHeading();
    blocks.push({ type: 'line', text, size: dominantHeight(parts), mono: isMostlyMono(parts) });
  }
  flushTable();
  flushHeading();
  return blocks;
}

/** Number of headings in the blocks of all pages. */
export function countHeadings(pages) {
  let count = 0;
  for (const page of pages)
    for (const block of page.blocks) if (block.type === 'heading') count += 1;
  return count;
}

// ---------------------------------------------------------------------------------------------
// Outline (bookmarks)

const normalizeTitle = text =>
  String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

// What may stand in front of an outline title in the text: a chapter label such as `1.2`, `IV`, `a`.
const LABEL_PREFIX = /^(?:\d{1,3}|[ivxlcdm]{1,6}|[a-z])/;

const DONE = 'done';
const PARTIAL = 'partial';
const NO = 'no';

/** Does the text read so far spell the title, or could it still, with more lines? */
function progress(seen, key) {
  if (seen === key) return DONE;
  if (key.startsWith(seen)) return PARTIAL;
  const label = LABEL_PREFIX.exec(seen);
  if (label) {
    const rest = seen.slice(label[0].length);
    if (rest === key) return DONE;
    if (rest !== '' && key.startsWith(rest)) return PARTIAL;
  }
  return NO;
}

/**
 * Does the text of `blocks[start …]` spell the outline title? Returns the number of lines (a
 * long title wraps over up to three), or 0. A line without letters or digits (a closing brace,
 * a rule) never belongs to a title.
 */
function titleSpan(blocks, start, key) {
  let seen = '';
  for (let span = 1; span <= 3 && start + span <= blocks.length; span += 1) {
    const block = blocks[start + span - 1];
    if (block.type !== 'line') return 0;
    // Normalised once per line: an outline with thousands of entries asks again and again.
    if (block.key === undefined) block.key = normalizeTitle(block.text);
    const piece = block.key;
    if (piece === '') return 0;
    seen += piece;
    const state = progress(seen, key);
    if (state === DONE) return span;
    if (state === NO) return 0;
  }
  return 0;
}

/**
 * Find the line of every outline entry on the page its destination points to. Entries are
 * matched in order, so a title that occurs twice on a page is found twice.
 *
 * @param {Array<{blocks: Array}>} pages
 * @param {Array<{title: string, depth: number, pageIndex: number}>} entries
 * @returns {{matches: Array, entries: number}}
 */
export function planOutline(pages, entries) {
  const matches = [];
  const used = new Set();
  const cursors = new Map();
  // An outline that points thousands of entries at one page full of lines would otherwise cost
  // entries × lines comparisons.
  let budget = MAX_OUTLINE_COMPARISONS;
  for (const entry of entries) {
    const page = pages[entry.pageIndex];
    const key = normalizeTitle(entry.title);
    if (!page || key.length < 3) continue;
    const find = from => {
      for (let i = from; i < page.blocks.length && budget > 0; i += 1) {
        budget -= 1;
        if (used.has(`${entry.pageIndex}:${i}`)) continue;
        const span = titleSpan(page.blocks, i, key);
        if (span > 0) return { i, span };
      }
      return null;
    };
    const hit = find(cursors.get(entry.pageIndex) || 0) || find(0);
    if (!hit) continue;
    for (let k = 0; k < hit.span; k += 1) used.add(`${entry.pageIndex}:${hit.i + k}`);
    cursors.set(entry.pageIndex, hit.i + hit.span);
    matches.push({
      pageIndex: entry.pageIndex,
      blockIndex: hit.i,
      span: hit.span,
      level: Math.min(Math.max(entry.depth, 1), 6)
    });
  }
  return { matches, entries: entries.length };
}

/** Turn the matched lines into headings (a title that wrapped over lines becomes one heading). */
function applyPlan(pages, matches) {
  const byPage = new Map();
  for (const match of matches) {
    if (!byPage.has(match.pageIndex)) byPage.set(match.pageIndex, new Map());
    byPage.get(match.pageIndex).set(match.blockIndex, match);
  }
  for (const [pageIndex, starts] of byPage) {
    const page = pages[pageIndex];
    const blocks = [];
    for (let i = 0; i < page.blocks.length; i += 1) {
      const match = starts.get(i);
      if (!match) {
        blocks.push(page.blocks[i]);
        continue;
      }
      const lines = page.blocks.slice(i, i + match.span);
      blocks.push({
        type: 'heading',
        level: match.level,
        text: lines.map(line => line.text).join(' '),
        size: lines[0].size
      });
      i += match.span - 1;
    }
    page.blocks = blocks;
  }
}

/**
 * Headings from the outline. The outline is only trusted when most of its entries are found as
 * text on their pages — an outline whose titles differ from the text (or whose entries point to
 * figures) would promote a few random lines.
 *
 * @returns {number} Headings added
 */
export function applyOutlineHeadings(pages, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const plan = planOutline(pages, entries);
  if (plan.matches.length === 0 || plan.matches.length / plan.entries < 0.5) return 0;
  applyPlan(pages, plan.matches);
  return plan.matches.length;
}

// ---------------------------------------------------------------------------------------------
// Font-size heuristic (last resort)

const CHAPTER_LABEL = /^\d+(?:\.\d+)*\.?\s+\p{L}/u;
const MAX_TIERS = 4;

const roundSize = size => Math.round(size * 2) / 2;

/**
 * Headings from the font size: lines clearly larger than the body text, short, not ending like a
 * sentence, not repeated on many pages (running headers). Deliberately conservative: when the
 * document does not show a clean picture (large text is a big share of the document, more than
 * four sizes), nothing is promoted.
 *
 * @returns {number} Headings added
 */
export function applyFontHeadings(pages) {
  const bySize = new Map();
  let total = 0;
  const pagesOfLine = new Map();
  let pagesWithLines = 0;
  for (let p = 0; p < pages.length; p += 1) {
    let any = false;
    for (const block of pages[p].blocks) {
      if (block.type !== 'line' || block.mono || !(block.size > 0)) continue;
      any = true;
      const size = roundSize(block.size);
      bySize.set(size, (bySize.get(size) || 0) + block.text.length);
      total += block.text.length;
      const key = block.text.toLowerCase().replace(/\d+/g, '#');
      if (!pagesOfLine.has(key)) pagesOfLine.set(key, new Set());
      pagesOfLine.get(key).add(p);
    }
    if (any) pagesWithLines += 1;
  }
  if (total === 0) return 0;

  const isRunning = text => {
    const pagesSeen = pagesOfLine.get(text.toLowerCase().replace(/\d+/g, '#'));
    return pagesSeen && pagesSeen.size >= 3 && pagesSeen.size >= 0.5 * pagesWithLines;
  };

  // The body size is the most frequent one. Code that the PDF does not mark as fixed-width can
  // outweigh the real body text, so a size that holds at least 15 % of the characters is tried
  // too when the first guess would make a fifth of the document "headings".
  const sizesByShare = [...bySize]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .filter(([, chars], i) => i === 0 || chars >= 0.15 * total)
    .slice(0, 3)
    .map(([size]) => size);

  const findCandidates = body => {
    const found = [];
    let chars = 0;
    for (let p = 0; p < pages.length; p += 1) {
      pages[p].blocks.forEach((block, b) => {
        if (block.type !== 'line' || block.mono || !(block.size > 0)) return;
        const size = roundSize(block.size);
        const labelled = CHAPTER_LABEL.test(block.text);
        if (size < body * (labelled ? 1.05 : 1.15) || size <= body) return;
        if (block.text.length > MAX_HEADING_CHARS || /[.;,]$/.test(block.text)) return;
        if (!/\p{L}{2}/u.test(block.text) || isRunning(block.text)) return;
        found.push({ p, b, size, labelled });
        chars += block.text.length;
      });
    }
    const tiers = [...new Set(found.map(candidate => candidate.size))].sort((a, b) => b - a);
    return found.length > 0 && chars <= 0.2 * total && tiers.length <= MAX_TIERS
      ? { found, tiers }
      : null;
  };

  let plan = null;
  for (const body of sizesByShare) {
    plan = findCandidates(body);
    if (plan) break;
  }
  if (!plan) return 0;
  const candidates = plan.found;
  const sizes = plan.tiers;

  const levelOf = size => sizes.indexOf(size) + 1;
  const byPage = new Map();
  for (const candidate of candidates) {
    if (!byPage.has(candidate.p)) byPage.set(candidate.p, new Map());
    byPage.get(candidate.p).set(candidate.b, candidate);
  }
  let added = 0;
  for (const [p, starts] of byPage) {
    const blocks = [];
    const source = pages[p].blocks;
    for (let b = 0; b < source.length; b += 1) {
      const candidate = starts.get(b);
      if (!candidate) {
        blocks.push(source[b]);
        continue;
      }
      const { size } = source[b];
      let text = source[b].text;
      // A heading that wraps: the next line has the same size and is no new numbered heading.
      let next = starts.get(b + 1);
      while (next && next.size === candidate.size && !next.labelled && !/[.:]$/.test(text)) {
        text = `${text} ${source[b + 1].text}`;
        b += 1;
        next = starts.get(b + 1);
      }
      blocks.push({ type: 'heading', level: levelOf(candidate.size), text, size });
      added += 1;
    }
    pages[p].blocks = blocks;
  }
  return added;
}
