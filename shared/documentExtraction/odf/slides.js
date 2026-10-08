/**
 * OpenDocument presentations (.odp) → the same text as a PowerPoint deck: slides in the order of
 * the presentation, the title of a slide as a heading, tables as Markdown tables, hidden slides
 * flagged, and — only when an app asks for them — the speaker notes.
 *
 * @module shared/documentExtraction/odf/slides
 */
import { NS, attr, kid, kids } from './xml.js';

// Placeholders that show a number or a date the layout computes: not content.
const LAYOUT_CLASSES = new Set(['page-number', 'date-time']);
// A notes page repeats the placeholders of its layout too.
const NOTES_SKIPS = new Set([...LAYOUT_CLASSES, 'header', 'footer']);
const MAX_DEPTH = 32; // groups inside groups

/** The title and the blocks (`{ lines }`) of the shapes of a slide, in the order of the file. */
function slideContent(page, reader) {
  const titles = [];
  const blocks = [];

  const visit = (parent, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const shape of kids(parent)) {
      if (shape.namespaceURI !== NS.draw) continue;
      const name = shape.localName;
      if (name === 'g' || name === 'a') {
        visit(shape, depth + 1);
      } else if (name === 'frame') {
        const placeholder = attr(shape, 'presentation', 'class');
        if (LAYOUT_CLASSES.has(placeholder) || placeholder === 'notes') continue;
        const box = kid(shape, 'draw', 'text-box');
        const table = kid(shape, 'table', 'table');
        if (box) {
          if (placeholder === 'title') {
            const title = reader.plainText(box);
            if (title) titles.push(title);
          } else {
            const lines = reader.shapeLines(box);
            if (lines.length > 0) blocks.push({ lines });
          }
        } else if (table) {
          // Impress marks a table whose first row is a header with `use-first-row-styles`.
          const lines = reader.tableLines(table, {
            firstRowHeader: attr(table, 'table', 'use-first-row-styles') === 'true'
          });
          if (lines.length > 0) blocks.push({ lines, table: true });
        }
      } else if (name !== 'page-thumbnail' && name !== 'image' && name !== 'plugin') {
        // A shape with text of its own (rectangle, custom shape, …).
        const lines = reader.shapeLines(shape);
        if (lines.length > 0) blocks.push({ lines });
      }
    }
  };
  visit(page, 0);
  return { title: titles.join(' '), blocks };
}

/** The notes of a slide, one line per paragraph. */
function notesOf(page, reader) {
  const notes = kid(page, 'presentation', 'notes');
  const lines = [];
  for (const frame of kids(notes, 'draw', 'frame')) {
    if (NOTES_SKIPS.has(attr(frame, 'presentation', 'class'))) continue;
    const box = kid(frame, 'draw', 'text-box');
    if (box) lines.push(...reader.shapeLines(box));
  }
  return lines;
}

/**
 * @param {Object} args
 * @param {Element} args.presentation - `office:presentation`
 * @param {Object} args.reader - `createOdfReader(...)`
 * @param {Object} args.styles - `readStyles(...)`
 * @param {'ignore'|'include'} [args.speakerNotes]
 * @returns {string} Text of the slides, '' when no slide has any
 */
export function odpText({ presentation, reader, styles, speakerNotes = 'ignore' }) {
  const output = [];
  kids(presentation, 'draw', 'page').forEach((page, index) => {
    const { title, blocks } = slideContent(page, reader);
    let notes = [];
    if (speakerNotes === 'include') {
      // Notes that cannot be read cost the notes only.
      try {
        notes = notesOf(page, reader);
      } catch {
        notes = [];
      }
    }
    if (!title && blocks.length === 0 && notes.length === 0) return;

    const hidden = styles.slideHidden(attr(page, 'draw', 'style-name'));
    const lines = [`[Slide ${index + 1}${hidden ? ' (hidden)' : ''}]`];
    if (title) lines.push(`# ${title}`);
    for (const block of blocks) {
      if (block.table && lines.length > 1 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(...block.lines);
      if (block.table) lines.push('');
    }
    while (lines[lines.length - 1] === '') lines.pop();
    if (notes.length > 0) lines.push('[Notes]', ...notes);
    output.push(lines.join('\n'));
  });
  return output.join('\n\n').trim();
}
