/**
 * OpenDocument text (.odt) → Markdown: headings by outline level, paragraphs, lists with the
 * numbers Writer computes, tables, footnotes, links, images as alt text, page breaks.
 *
 * Tracked changes need no extra handling: ODF keeps deleted text inside
 * `text:tracked-changes`, which is not walked, so the text is the accepted view. Text the
 * author hid (`text:display="none"`) and the automatic page number and page count fields are
 * left out.
 *
 * @module shared/documentExtraction/odf/writer
 */
import { PAGE_BREAK_MARKER } from '../markers.js';
import { markdownDestination, markdownTableLines } from '../markdown.js';
import { createNumbering, readListStyles } from './lists.js';
import { readStyles } from './styles.js';
import { NS, attr, is, kid, kids } from './xml.js';

const MAX_DEPTH = 64; // nested lists, tables, sections: more is a hostile file
const MAX_NODES = 3_000_000;
const MAX_REPEAT_COLUMNS = 100;
const MAX_REPEAT_ROWS = 50;

/** Containers whose children are more of the body (sections, indexes, tables of contents). */
const CONTAINERS = new Set([
  'section',
  'table-of-content',
  'table-index',
  'illustration-index',
  'object-index',
  'user-index',
  'alphabetical-index',
  'bibliography',
  'index-body',
  'index-title'
]);

// Fields that show a number the layout computes, not content.
const LAYOUT_FIELDS = new Set(['page-number', 'page-count']);

const collapse = text => text.replace(/[ \t\r\n]+/g, ' ');
const oneLine = text => text.replace(/\s+/g, ' ').trim();

/**
 * The reading functions of one OpenDocument file: its text as Markdown, the plain text of a cell,
 * the lines of a slide's shapes. They share the styles, the list numbering and the footnote
 * counter of the file, so they are made once per file.
 *
 * @param {Object} args
 * @param {Document} args.contentDoc - content.xml
 * @param {Document|null} args.stylesDoc - styles.xml
 */
export function createOdfReader({ contentDoc, stylesDoc }) {
  const styles = readStyles(contentDoc, stylesDoc);
  const numbering = createNumbering(readListStyles(contentDoc, stylesDoc));

  const output = []; // blocks: strings
  const notes = []; // footnote and endnote definitions
  let noteCount = 0;
  let endnoteCount = 0;
  let seenContent = false;
  let visited = 0;
  let listCount = 0; // the lists of the document, to keep the lines of one list together

  const guard = depth => {
    visited += 1;
    if (depth > MAX_DEPTH || visited > MAX_NODES) throw new Error('document is too deeply nested');
  };

  const pushBlock = text => {
    if (text.trim() === '') return;
    output.push(text);
    seenContent = true;
  };
  const pageBreak = () => {
    if (seenContent && output[output.length - 1] !== PAGE_BREAK_MARKER)
      output.push(PAGE_BREAK_MARKER);
  };
  const startsPage = styleName =>
    styles.breakBefore(styleName) ||
    // A page style change begins a new page.
    !!styles.resolve(styleName, 'paragraph', style => attr(style, 'style', 'master-page-name'));

  // ---- inline text -----------------------------------------------------------------------

  /** Text of a paragraph's content; blocks that live inside it (text boxes) go to `after`. */
  function inline(el, after, depth) {
    guard(depth);
    let out = '';
    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        out += collapse(node.data);
        continue;
      }
      if (node.nodeType !== 1) continue;
      if (node.namespaceURI !== NS.text && node.namespaceURI !== NS.draw) continue;
      const name = node.localName;
      if (node.namespaceURI === NS.draw) {
        if (name === 'frame') out += frame(node, after, depth + 1);
        else if (name === 'a' || name === 'g') out += inline(node, after, depth + 1);
        continue;
      }
      if (name === 's') out += ' '.repeat(Math.min(Number(attr(node, 'text', 'c') ?? 1) || 1, 100));
      else if (name === 'tab') out += ' ';
      else if (name === 'line-break') out += '\n';
      else if (name === 'span') {
        if (!styles.hidden(attr(node, 'text', 'style-name'), 'text'))
          out += inline(node, after, depth + 1);
      } else if (name === 'a') {
        const text = inline(node, after, depth + 1);
        const href = attr(node, 'xlink', 'href');
        if (href && !href.startsWith('#') && text.trim()) {
          // A bracket in the text would end the link text early.
          const label = text.trim().replace(/[[\]]/g, '\\$&');
          out += `[${label}](${markdownDestination(href.trim())})`;
        } else out += text;
      } else if (name === 'note') out += note(node, after, depth + 1);
      else if (name === 'ruby')
        out += inline(kid(node, 'text', 'ruby-base') || node, after, depth + 1);
      else if (name === 'hidden-text') {
        if (attr(node, 'text', 'is-hidden') !== 'true') out += inline(node, after, depth + 1);
      } else if (!LAYOUT_FIELDS.has(name)) {
        // Fields (date, title, variables …) and unknown inline elements: their text.
        out += inline(node, after, depth + 1);
      }
    }
    return out;
  }

  /** An image (as its alt text) or a text box (its paragraphs follow the host paragraph). */
  function frame(el, after, depth) {
    let text = '';
    const image = kid(el, 'draw', 'image');
    if (image) {
      const alt =
        oneLine(kid(el, 'svg', 'title')?.textContent ?? '') ||
        oneLine(kid(el, 'svg', 'desc')?.textContent ?? '');
      if (alt) text += `[Image: ${alt}]`;
    }
    const box = kid(el, 'draw', 'text-box');
    if (box) {
      const inner = [];
      blocks(box, null, inner, depth + 1);
      after.push(...inner);
    }
    return text;
  }

  function note(el, after, depth) {
    const isEndnote = attr(el, 'text', 'note-class') === 'endnote';
    const id = isEndnote ? `e${(endnoteCount += 1)}` : String((noteCount += 1));
    const bodyEl = kid(el, 'text', 'note-body');
    const text = oneLine(plainText(bodyEl, depth + 1));
    if (text) notes.push(`[^${id}]: ${text}`);
    return `[^${id}]`;
  }

  /** All the text of an element, blocks and lists included, on one line (cells, notes). */
  function plainText(el, depth) {
    guard(depth);
    const parts = [];
    for (const child of kids(el)) {
      if (is(child, 'text', 'p') || is(child, 'text', 'h')) {
        if (!styles.hidden(attr(child, 'text', 'style-name'), 'paragraph')) {
          const text = oneLine(inline(child, [], depth + 1));
          if (text) parts.push(text);
        }
      } else if (child.namespaceURI === NS.text || child.namespaceURI === NS.table) {
        const text = oneLine(plainText(child, depth + 1));
        if (text) parts.push(text);
      }
    }
    return parts.join(' ');
  }

  // ---- blocks ----------------------------------------------------------------------------

  /** A paragraph or heading as a block of text (with its list marker or number). */
  function paragraph(el, { label, marker, indent = '', listId = 0 }, target, depth) {
    const styleName = attr(el, 'text', 'style-name');
    if (styles.hidden(styleName, 'paragraph')) return;
    if (kids(el, 'text', 'hidden-paragraph').some(h => attr(h, 'text', 'is-hidden') === 'true'))
      return;
    const after = [];
    const text = inline(el, after, depth + 1)
      .replace(/­/g, '')
      // Runs of spaces first (they are only spaces here: the text was collapsed), then the one
      // space that may be left around a break. `[ \t]*\n[ \t]*` backtracks quadratically on a
      // long run of spaces — a file can chain thousands of `text:s` elements.
      .replace(/ {2,}/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .trim();
    const heading = is(el, 'text', 'h');
    let block = '';
    if (text) {
      if (heading) {
        const level = Math.min(Math.max(Number(attr(el, 'text', 'outline-level') ?? 1) || 1, 1), 6);
        const number = label ?? numbering.heading(el, level, styles.listStyleName(styleName));
        block = `${'#'.repeat(level)} ${number ? `${number} ` : ''}${text}`;
      } else {
        block = `${indent}${marker ? `${marker} ` : ''}${text}`;
      }
    }
    if (block && startsPage(styleName)) target.push({ pageBreak: true });
    if (block) target.push({ text: block, heading, listId: heading ? 0 : listId });
    for (const extra of after) target.push(extra);
    if (block && styles.breakAfter(styleName)) target.push({ pageBreak: true });
  }

  function list(el, parent, target, depth) {
    guard(depth);
    const context = numbering.enterList(el, parent);
    context.rootId = parent ? parent.rootId : (listCount += 1);
    for (const item of kids(el)) {
      if (!is(item, 'text', 'list-item') && !is(item, 'text', 'list-header')) continue;
      const shown = numbering.item(context, item);
      const indent = '  '.repeat(context.level - 1);
      let first = true;
      for (const child of kids(item)) {
        if (is(child, 'text', 'p') || is(child, 'text', 'h')) {
          const marker = shown?.bullet ? '-' : shown?.label || '';
          paragraph(
            child,
            {
              label: is(child, 'text', 'h') ? shown?.label : undefined,
              marker: first ? marker : '',
              indent,
              listId: context.rootId
            },
            target,
            depth + 1
          );
          first = false;
        } else if (is(child, 'text', 'list')) {
          list(child, context, target, depth + 1);
        } else if (is(child, 'table', 'table')) {
          target.push({ text: tableLines(child, depth + 1).join('\n'), table: true });
        }
      }
    }
  }

  function tableLines(el, depth, { firstRowHeader = false } = {}) {
    guard(depth);
    const grid = [];
    let headerRows = 0;
    const rowsOf = parent => {
      for (const child of kids(parent)) {
        if (child.namespaceURI !== NS.table) continue;
        if (child.localName === 'table-header-rows') {
          const before = grid.length;
          rowsOf(child);
          headerRows += grid.length - before;
        } else if (child.localName === 'table-rows' || child.localName === 'table-row-group') {
          rowsOf(child);
        } else if (child.localName === 'table-row') {
          const repeat = Math.min(
            Number(attr(child, 'table', 'number-rows-repeated') ?? 1) || 1,
            MAX_REPEAT_ROWS
          );
          const cells = rowCells(child, grid[grid.length - 1] || [], depth + 1);
          for (let i = 0; i < repeat; i += 1) grid.push(cells.slice());
        }
      }
    };
    rowsOf(el);
    return markdownTableLines(grid, {
      header: headerRows > 0 || (firstRowHeader && grid.length > 0)
    });
  }

  /** Cell texts of a row; a cell covered by a row span above repeats that cell's text. */
  function rowCells(row, above, depth) {
    const cells = [];
    let coveredByColumns = 0;
    for (const cell of kids(row)) {
      const covered = is(cell, 'table', 'covered-table-cell');
      if (!covered && !is(cell, 'table', 'table-cell')) continue;
      const repeat = Math.min(
        Number(attr(cell, 'table', 'number-columns-repeated') ?? 1) || 1,
        MAX_REPEAT_COLUMNS
      );
      let text = '';
      if (!covered) {
        text = plainText(cell, depth + 1);
        coveredByColumns = (Number(attr(cell, 'table', 'number-columns-spanned') ?? 1) || 1) - 1;
      }
      for (let i = 0; i < repeat; i += 1) {
        if (covered) {
          // Covered by a column span to the left: empty; by a row span above: its text again.
          if (coveredByColumns > 0) {
            cells.push('');
            coveredByColumns -= 1;
          } else {
            cells.push(above[cells.length] ?? '');
          }
        } else {
          cells.push(text);
        }
      }
    }
    return cells;
  }

  /** Blocks of an element's children into `target` (pieces: text, page breaks). */
  function blocks(parent, listContext, target, depth) {
    guard(depth);
    for (const el of kids(parent)) {
      if (el.namespaceURI === NS.text) {
        if (el.localName === 'p' || el.localName === 'h') paragraph(el, {}, target, depth + 1);
        else if (el.localName === 'list') list(el, listContext, target, depth + 1);
        else if (CONTAINERS.has(el.localName)) blocks(el, null, target, depth + 1);
      } else if (is(el, 'table', 'table')) {
        target.push({ text: tableLines(el, depth + 1).join('\n'), table: true });
      } else if (is(el, 'draw', 'frame')) {
        const after = [];
        const text = frame(el, after, depth + 1);
        if (text) target.push({ text });
        target.push(...after);
      }
    }
  }

  /** Text of the document: blocks are separated by a blank line, the lines of a list by one break. */
  function documentMarkdown() {
    const body = kid(kid(contentDoc.documentElement, 'office', 'body'), 'office', 'text');
    const pieces = [];
    if (body) blocks(body, null, pieces, 0);

    let listBlock = -1; // index in `output` of the list block that is still being filled
    let listOfBlock = 0;
    for (const piece of pieces) {
      if (piece.pageBreak) {
        pageBreak();
        listBlock = -1;
      } else if (piece.listId && piece.listId === listOfBlock && listBlock === output.length - 1) {
        output[listBlock] += `\n${piece.text}`;
      } else {
        pushBlock(piece.text);
        listBlock = piece.listId ? output.length - 1 : -1;
        listOfBlock = piece.listId;
      }
    }
    if (notes.length > 0) output.push(notes.join('\n'));
    return output.join('\n\n').trim();
  }

  /**
   * The lines of the text inside a shape of a slide (a text box, a group): one line per
   * paragraph or list item, a table with a blank line before and after it.
   *
   * @param {Element} container
   * @returns {string[]}
   */
  function shapeLines(container) {
    const pieces = [];
    blocks(container, null, pieces, 1);
    const lines = [];
    for (const piece of pieces) {
      if (piece.pageBreak) continue;
      if (piece.table) {
        if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
        lines.push(...piece.text.split('\n'), '');
      } else {
        lines.push(piece.text);
      }
    }
    // Footnotes of the slide's text stay with the slide.
    lines.push(...notes.splice(0));
    while (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  return {
    styles,
    documentMarkdown,
    shapeLines,
    /** All the text of an element on one line (the cell of a spreadsheet, a title). */
    plainText: el => oneLine(plainText(el, 0)),
    /** A table as Markdown lines; `firstRowHeader`: the table says its first row is a header. */
    tableLines: (el, options) => tableLines(el, 0, options)
  };
}

/**
 * @param {Object} args
 * @param {Document} args.contentDoc - content.xml
 * @param {Document|null} args.stylesDoc - styles.xml
 * @returns {string} Markdown
 */
export function odtMarkdown(args) {
  return createOdfReader(args).documentMarkdown();
}
