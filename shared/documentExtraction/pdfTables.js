// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tables of a PDF that does not tag them, read from where the text sits on the page.
 *
 * Most PDFs have no structure tree (anything printed from a browser, a report generator or a
 * word processor without the "accessible PDF" switch), and pdf.js reports their tables as a
 * stream of items in drawing order, in which the lines of a wrapped cell are interleaved with
 * the other cells of the row (`Kriterium Azure` / `OpenAI` / `Foundry Models … Azure` / `SQL`).
 * The geometry still tells the table: the text is arranged in columns, and the gaps between the
 * columns line up from row to row.
 *
 *  1. Items on the same baseline are one visual line; items of a line that are further apart
 *     than a word space are separate segments (cells).
 *  2. Neighbouring lines with several segments form a region; a line with one segment joins it
 *     only as the wrapped end of a cell.
 *  3. A column boundary is a gap that most lines of the region have at the same place. Lines
 *     with text across a boundary are not table lines.
 *  4. A row is one line, or several when the spacing says they are one wrapped cell.
 *  5. The result is only a table when it looks like one: at least three rows and two columns,
 *     most rows with several cells, and not a list, a table of contents or two columns of prose.
 *
 * Wrong is worse than missing (see {@link module:shared/documentExtraction/pdfStructure}): when
 * a region does not clearly look like a table its text stays the plain lines it was, and no
 * text is ever dropped or reordered outside a table the geometry is sure of.
 *
 * Pure functions on pdf.js text items; pdf.js itself is not imported.
 *
 * @module shared/documentExtraction/pdfTables
 */

/** Pages with more text items than this are not examined (bounds the work on hostile input). */
const MAX_ITEMS = 30000;
/** Lines of one table; a longer run is cut into several tables. */
const MAX_TABLE_LINES = 600;
const MIN_ROWS = 3;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 30;
/** How often a region is split at a line that does not fit its columns. */
const MAX_SPLIT_DEPTH = 8;

/** Items closer to the baseline than this share of the text height are on the same line. */
const SAME_LINE = 0.3;
/** Items further apart than this share of the text height (3 pt at least) are separate cells. */
const CELL_GAP = 0.6;
const MIN_CELL_GAP = 3;
/** A column boundary is at least this wide (points). */
const MIN_BOUNDARY = 3;
/** A line this much (relative) taller or smaller than its neighbours is not in the same table. */
const SIZE_TOLERANCE = 0.2;
/** Largest distance between lines of a table, in text heights (cell padding included). */
const MAX_ROW_DISTANCE = 3.2;
/** Largest distance for the wrapped end of a cell, in text heights. */
const MAX_WRAP_DISTANCE = 1.6;
/** The spacing inside a wrapped cell is this much (relative) tighter than between rows. */
const ROW_JUMP = 1.35;
/** Share of the rows that must have two cells or more. */
const MIN_FILLED_ROWS = 0.6;

const MARKER = /^(?:[•◦▪▫‣●○■□\-–—*·]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])$/u;
const PAGE_NUMBER = /^(?:\d{1,4}|[ivxlcdm]{1,6})$/i;

const isAxisAligned = t => Math.abs(t[1]) < 0.01 && Math.abs(t[2]) < 0.01;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
};

/** Text items with a position, in the page's own order. Anything rotated or invisible is left out. */
function glyphsOf(items, styles) {
  const glyphs = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item.str !== 'string' || item.str.trim() === '') continue;
    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6 || !isAxisAligned(t)) continue;
    const height = Number(item.height) || Math.abs(t[3]);
    const width = Number(item.width);
    if (!(height > 0) || !Number.isFinite(width) || width < 0) continue;
    const style = styles && item.fontName ? styles[item.fontName] : null;
    glyphs.push({
      index,
      str: item.str,
      x: t[4],
      y: t[5],
      w: width,
      h: height,
      font: item.fontName || '',
      mono: Boolean(style) && style.fontFamily === 'monospace'
    });
  }
  return glyphs;
}

/** Cells of a visual line: runs of items that are no further apart than a word space. */
function segmentsOf(line) {
  const limit = Math.max(CELL_GAP * line.h, MIN_CELL_GAP);
  const segments = [];
  let current = null;
  for (const glyph of line.glyphs) {
    const gap = current ? glyph.x - current.x1 : 0;
    if (current && gap <= limit) {
      current.text += gap > 0.15 * line.h ? ` ${glyph.str}` : glyph.str;
      current.x1 = Math.max(current.x1, glyph.x + glyph.w);
      current.glyphs.push(glyph);
    } else {
      current = { x0: glyph.x, x1: glyph.x + glyph.w, text: glyph.str, glyphs: [glyph] };
      segments.push(current);
    }
  }
  return segments;
}

/** The page's text as visual lines, top to bottom, each with its cells. */
function visualLines(glyphs) {
  const sorted = [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let line = null;
  for (const glyph of sorted) {
    if (line && Math.abs(line.y - glyph.y) <= SAME_LINE * Math.max(line.h, glyph.h)) {
      line.glyphs.push(glyph);
      line.h = Math.max(line.h, glyph.h);
    } else {
      line = { y: glyph.y, h: glyph.h, glyphs: [glyph] };
      lines.push(line);
    }
  }
  for (const l of lines) {
    l.glyphs.sort((a, b) => a.x - b.x);
    l.segments = segmentsOf(l);
    let mono = 0;
    let other = 0;
    for (const g of l.glyphs) {
      if (g.mono) mono += g.str.trim().length;
      else other += g.str.trim().length;
    }
    l.mono = mono > other;
  }
  return lines;
}

const similarSize = (a, b) => Math.abs(a - b) <= SIZE_TOLERANCE * Math.max(a, b);
const isSeed = line => !line.mono && line.segments.length >= MIN_COLUMNS;

/** The horizontal stretches covered by text in any of the lines, close ones merged. */
function coverage(lines) {
  const spans = [];
  for (const line of lines) for (const s of line.segments) spans.push([s.x0, s.x1]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] - last[1] < MIN_BOUNDARY) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/** Runs of neighbouring lines that may be a table. */
function regionsOf(lines) {
  const regions = [];
  let i = 0;
  while (i < lines.length) {
    if (!isSeed(lines[i])) {
      i += 1;
      continue;
    }
    const region = [lines[i]];
    let j = i + 1;
    while (j < lines.length && region.length < MAX_TABLE_LINES) {
      const prev = region[region.length - 1];
      const line = lines[j];
      const distance = prev.y - line.y;
      if (line.mono || !similarSize(prev.h, line.h)) break;
      if (distance > MAX_ROW_DISTANCE * Math.max(prev.h, line.h)) break;
      if (!isSeed(line)) {
        // One cell only: the end of a wrapped cell, if it stays within one column.
        if (distance > MAX_WRAP_DISTANCE * line.h) break;
        // It may be wider than anything else in its column, but it belongs to exactly one.
        const [segment] = line.segments;
        const touched = coverage(region).filter(([a, b]) => segment.x0 < b && segment.x1 > a);
        if (touched.length !== 1) break;
      }
      region.push(line);
      j += 1;
    }
    regions.push(region);
    i = j;
  }
  return regions;
}

/**
 * Column boundaries of a region: gaps between cells that most of its lines have at the same
 * place, and that no more than a few lines have text across.
 *
 * @returns {Array<[number, number]>} Horizontal stretches, left to right
 */
function boundariesOf(lines) {
  const events = [];
  const multi = lines.filter(line => line.segments.length >= MIN_COLUMNS).length;
  for (const line of lines) {
    const segs = line.segments;
    for (let k = 0; k < segs.length; k += 1) {
      events.push([segs[k].x0, 0, 1], [segs[k].x1, 0, -1]);
      if (k + 1 < segs.length) events.push([segs[k].x1, 1, 1], [segs[k + 1].x0, 1, -1]);
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const needed = Math.max(2, Math.ceil(0.5 * multi));
  const tolerated = Math.floor(0.1 * lines.length);
  const boundaries = [];
  let spans = 0;
  let gaps = 0;
  let open = null;
  for (let k = 0; k < events.length; k += 1) {
    const [x, kind, delta] = events[k];
    if (kind === 0) spans += delta;
    else gaps += delta;
    // Judge the stretch up to the next position only once every event here is counted.
    if (k + 1 < events.length && events[k + 1][0] === x) continue;
    const next = k + 1 < events.length ? events[k + 1][0] : x;
    if (next > x && gaps >= needed && spans <= tolerated) {
      if (open) open[1] = next;
      else open = [x, next];
    } else if (open) {
      boundaries.push(open);
      open = null;
    }
  }
  if (open) boundaries.push(open);
  return boundaries.filter(([a, b]) => b - a >= MIN_BOUNDARY);
}

/**
 * Whether a line has one cell with text on both sides of a boundary. The widest cell of a
 * column, usually its header, may reach into the gap towards the next column; no cell of the
 * table spans the whole gap.
 */
function crossesBoundary(line, boundaries) {
  return line.segments.some(s => boundaries.some(([a, b]) => s.x0 < a + 0.5 && s.x1 > b - 0.5));
}

/** The spacing above which the next line starts a new row (0: every line is a row). */
function rowThreshold(lines) {
  const gaps = [];
  for (let k = 1; k < lines.length; k += 1) gaps.push(lines[k - 1].y - lines[k].y);
  if (gaps.length < 2) return 0;
  const sorted = [...gaps].sort((a, b) => a - b);
  let best = 0;
  let at = -1;
  for (let k = 0; k + 1 < sorted.length; k += 1) {
    const ratio = sorted[k + 1] / Math.max(sorted[k], 0.01);
    if (ratio > best) {
      best = ratio;
      at = k;
    }
  }
  const tightest = Math.max(...lines.map(line => line.h));
  if (at < 0 || best < ROW_JUMP || sorted[at] > MAX_WRAP_DISTANCE * tightest) return 0;
  return (sorted[at] + sorted[at + 1]) / 2;
}

const collapse = text => text.replace(/\s+/g, ' ').trim();

/** Rows of cells, from the lines of a region and its column boundaries. */
function rowsOf(lines, boundaries) {
  const columnOf = segment => {
    const center = (segment.x0 + segment.x1) / 2;
    let column = 0;
    for (const [a, b] of boundaries) if (center > (a + b) / 2) column += 1;
    return column;
  };
  const threshold = rowThreshold(lines);
  const rows = [];
  let row = null;
  lines.forEach((line, k) => {
    if (!row || lines[k - 1].y - line.y > threshold) {
      row = { cells: new Array(boundaries.length + 1).fill(''), lines: [] };
      rows.push(row);
    }
    row.lines.push(line);
    for (const segment of line.segments) {
      const column = columnOf(segment);
      row.cells[column] = row.cells[column] ? `${row.cells[column]} ${segment.text}` : segment.text;
    }
  });
  for (const r of rows) r.cells = r.cells.map(collapse);
  return rows;
}

/** A first column of list markers, or a last one of page numbers, is a list or a table of contents. */
function isListOrContents(rows, columns) {
  const markers = rows.map(r => r.cells[0]).filter(Boolean);
  if (markers.length >= MIN_ROWS && markers.every(cell => MARKER.test(cell))) return true;
  return (
    columns === 2 &&
    rows.length >= MIN_ROWS &&
    rows.every(r => r.cells[1] === '' || PAGE_NUMBER.test(r.cells[1])) &&
    rows.filter(r => PAGE_NUMBER.test(r.cells[1])).length >= MIN_ROWS
  );
}

/** Whether a column reads like the lines of a paragraph (two-column layouts). */
function isProse(rows, columns) {
  for (let c = 0; c < columns; c += 1) {
    const cells = rows
      .slice(1)
      .map(r => r.cells[c])
      .filter(Boolean);
    if (cells.length < MIN_ROWS) continue;
    const lower = cells.filter(cell => /^\p{Ll}/u.test(cell)).length;
    if (lower >= 0.4 * cells.length && median(cells.map(cell => cell.length)) >= 25) return true;
  }
  return false;
}

/** Whether the first row is set apart from the others by its font or size. */
function hasHeader(rows) {
  const first = rows[0];
  const headFonts = new Set();
  let headHeight = 0;
  for (const line of first.lines) {
    for (const g of line.glyphs) {
      headFonts.add(g.font);
      headHeight = Math.max(headHeight, g.h);
    }
  }
  if (headFonts.size !== 1) return false;
  const chars = new Map();
  const heights = [];
  for (const row of rows.slice(1)) {
    for (const line of row.lines) {
      for (const g of line.glyphs) {
        chars.set(g.font, (chars.get(g.font) || 0) + g.str.trim().length);
        heights.push(g.h);
      }
    }
  }
  let body = '';
  let most = -1;
  for (const [font, count] of chars) {
    if (count > most) {
      body = font;
      most = count;
    }
  }
  const [head] = headFonts;
  return head !== body || headHeight > 1.05 * median(heights);
}

/** Tables of one region, or none when it does not clearly look like one. */
function tablesOfRegion(region, depth = 0) {
  if (region.length < MIN_ROWS || depth > MAX_SPLIT_DEPTH) return [];
  const boundaries = boundariesOf(region);
  const columns = boundaries.length + 1;
  if (columns < MIN_COLUMNS || columns > MAX_COLUMNS) return [];

  // A line with text across a boundary is not part of the table: cut it from the ends, split
  // the region at one in the middle.
  const bad = region.map(line => crossesBoundary(line, boundaries));
  if (bad.some(Boolean)) {
    const parts = [];
    let part = [];
    region.forEach((line, k) => {
      if (bad[k]) {
        parts.push(part);
        part = [];
      } else {
        part.push(line);
      }
    });
    parts.push(part);
    return parts.flatMap(p => tablesOfRegion(p, depth + 1));
  }

  // A table starts with a line of several cells, and ends with one or with the wrapped end of a
  // cell; a lone cell any further from the line above is text around the table.
  let start = 0;
  let end = region.length;
  while (start < end && region[start].segments.length < MIN_COLUMNS) start += 1;
  while (
    end > start + 1 &&
    region[end - 1].segments.length < MIN_COLUMNS &&
    region[end - 2].y - region[end - 1].y > MAX_WRAP_DISTANCE * region[end - 1].h
  ) {
    end -= 1;
  }
  const lines = region.slice(start, end);
  if (lines.length < MIN_ROWS) return [];

  const rows = rowsOf(lines, boundaries);
  if (rows.length < MIN_ROWS) return [];
  const filled = rows.filter(r => r.cells.filter(Boolean).length >= 2).length;
  if (filled < MIN_FILLED_ROWS * rows.length) return [];
  if (isListOrContents(rows, columns) || isProse(rows, columns)) return [];

  const members = new Set();
  for (const line of lines) for (const g of line.glyphs) members.add(g.index);
  const header = hasHeader(rows);
  return [
    {
      members,
      rows: rows.map((r, k) => ({ cells: r.cells, header: header && k === 0 }))
    }
  ];
}

/**
 * Tables of a page, found by where the text sits.
 *
 * @param {Array<object>} items - `getTextContent().items` (marked-content entries are ignored)
 * @param {object|null} [styles] - `getTextContent().styles`, for fixed-width fonts
 * @returns {Array<{members: Set<number>, rows: Array<{cells: string[], header: boolean}>}>}
 *   `members` holds the positions in `items` of the text each table contains
 */
export function detectTables(items, styles = null) {
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return [];
  const glyphs = glyphsOf(items, styles);
  if (glyphs.length < MIN_ROWS * MIN_COLUMNS) return [];
  const lines = visualLines(glyphs);
  return regionsOf(lines).flatMap(region => tablesOfRegion(region));
}
