/**
 * PowerPoint (.pptx) → text with the structure of the deck: slides in the order of the
 * presentation, the title of a slide as a heading, tables as Markdown tables, hidden slides
 * flagged, and — only when an app asks for them (decision A3) — the speaker notes.
 *
 * Pure orchestration over injected libraries (JSZip, DOMParser), like the Word extraction. A
 * deck is a zip of DrawingML/PresentationML parts: `ppt/presentation.xml` lists the slides in
 * the order the author sees them (`p:sldIdLst`), resolved through its relationships to
 * `ppt/slides/slideN.xml`. The file names only say in which order the slides were *created*.
 *
 * @module shared/documentExtraction/pptx
 */
import { markdownTableLines } from './markdown.js';
import { readRelationships, relationshipTargets } from './ooxml/package.js';
import { parseXml } from './ooxml/xml.js';

const A_NS = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main' // NOSONAR — a namespace name, never requested
]);
const P_NS = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main' // NOSONAR — a namespace name, never requested
]);

const DEFAULT_PRESENTATION_PART = 'ppt/presentation.xml';

/** Elements of a given namespace family and local name, in document order. */
const descendants = (root, nsSet, name) =>
  root
    ? Array.from(root.getElementsByTagNameNS('*', name)).filter(el => nsSet.has(el.namespaceURI))
    : [];
const children = (el, nsSet, name) =>
  el
    ? Array.from(el.childNodes).filter(
        node => node.nodeType === 1 && node.localName === name && nsSet.has(node.namespaceURI)
      )
    : [];

/** `r:id` of an element, whichever namespace family the package uses. */
function relationshipId(el) {
  for (const attribute of Array.from(el.attributes || [])) {
    if (attribute.localName === 'id' && (attribute.namespaceURI || '').endsWith('/relationships')) {
      return attribute.value;
    }
  }
  return undefined;
}

const isOn = value => value === '1' || value === 'true';

/**
 * Text of a DrawingML paragraph. Runs are joined without a separator (a word can be split
 * across runs by formatting), a line break inside the paragraph is a space, and the automatic
 * slide number and date are left out: they say nothing about the content.
 */
function paragraphText(paragraph) {
  let text = '';
  const visit = node => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1 || !A_NS.has(child.namespaceURI)) continue;
      if (child.localName === 't') text += child.textContent;
      else if (child.localName === 'br') text += ' ';
      else if (child.localName === 'fld') {
        if (!/^(slidenum|datetime)/i.test(child.getAttribute('type') || '')) visit(child);
      } else if (child.localName === 'r') visit(child);
    }
  };
  visit(paragraph);
  return text.replace(/\s+/g, ' ').trim();
}

const paragraphsOf = txBody =>
  children(txBody, A_NS, 'p')
    .map(paragraphText)
    .filter(text => text !== '');

/** The placeholder type of a shape (`title`, `body`, …; none for a plain text box). */
function placeholderType(shape) {
  const properties = children(shape, P_NS, 'nvSpPr')[0];
  const ph = descendants(properties, P_NS, 'ph')[0];
  return ph ? ph.getAttribute('type') || 'body' : null;
}

/** A DrawingML table as a grid of cell texts, plus whether its first row is a header row. */
function tableGrid(table) {
  const grid = [];
  for (const row of children(table, A_NS, 'tr')) {
    const line = [];
    for (const cell of children(row, A_NS, 'tc')) {
      const column = line.length;
      if (isOn(cell.getAttribute('hMerge'))) {
        // The rest of a cell that spans columns: its text is in the first column.
        line.push('');
      } else if (isOn(cell.getAttribute('vMerge'))) {
        // The rest of a cell that spans rows: every row stays self-contained.
        line.push(grid.length > 0 ? (grid[grid.length - 1][column] ?? '') : '');
      } else {
        line.push(paragraphsOf(children(cell, A_NS, 'txBody')[0]).join(' '));
      }
    }
    grid.push(line);
  }
  const properties = children(table, A_NS, 'tblPr')[0];
  return { grid, header: !!properties && isOn(properties.getAttribute('firstRow')) };
}

/**
 * The text blocks of one slide, in the order of the shape tree: `{ title, blocks }` where a
 * block is `{ text }` or `{ table: lines }`.
 */
function slideContent(doc) {
  const titles = [];
  const blocks = [];
  const walk = node => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      if (P_NS.has(child.namespaceURI) && child.localName === 'sp') {
        const type = placeholderType(child);
        if (type === 'sldNum' || type === 'dt') continue;
        const paragraphs = paragraphsOf(children(child, P_NS, 'txBody')[0]);
        if (paragraphs.length === 0) continue;
        if (type === 'title' || type === 'ctrTitle') titles.push(paragraphs.join(' '));
        else for (const text of paragraphs) blocks.push({ text });
      } else if (P_NS.has(child.namespaceURI) && child.localName === 'graphicFrame') {
        const table = descendants(child, A_NS, 'tbl')[0];
        if (table) {
          const { grid, header } = tableGrid(table);
          if (grid.length > 0) blocks.push({ table: markdownTableLines(grid, { header }) });
        }
      } else if (P_NS.has(child.namespaceURI) && child.localName === 'grpSp') {
        walk(child);
      } else if (child.localName === 'AlternateContent') {
        // The same shape twice, once for newer and once for older versions: read one.
        const choice = Array.from(child.childNodes).find(
          node => node.nodeType === 1 && node.localName === 'Choice'
        );
        const fallback = Array.from(child.childNodes).find(
          node => node.nodeType === 1 && node.localName === 'Fallback'
        );
        if (choice || fallback) walk(choice || fallback);
      }
    }
  };
  const tree = descendants(doc, P_NS, 'spTree')[0];
  if (tree) walk(tree);
  return { title: titles.join(' '), blocks };
}

/**
 * @param {Object} args
 * @param {ArrayBuffer} args.arrayBuffer - The .pptx file
 * @param {Function} args.JSZip - JSZip constructor
 * @param {typeof DOMParser} args.DOMParser
 * @param {'ignore'|'include'} [args.speakerNotes] - `include` adds the notes of a slide as
 *   `[Notes]` after it; they are not sent by default
 * @returns {Promise<string>} Text of the slides, '' when no slide has any
 * @throws When the package cannot be read — the caller falls back to the plain extraction
 */
export async function extractPptxText({
  arrayBuffer,
  JSZip,
  DOMParser: DOMParserCtor,
  speakerNotes = 'ignore'
}) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const readPart = async name => {
    const file = zip.file(name);
    return file ? parseXml(DOMParserCtor, await file.async('string')) : null;
  };
  const includeNotes = speakerNotes === 'include';

  // The slides in the order of the presentation. A deck without a usable slide list (or whose
  // list cannot be read) falls back to the order of the file names, numbered by them.
  const [mainTarget] = Object.values(
    await relationshipTargets(zip, DOMParserCtor, '', ['/officeDocument'])
  );
  const presentationPart = mainTarget || DEFAULT_PRESENTATION_PART;
  let slides = [];
  let isDeck = false;
  try {
    const presentation = await readPart(presentationPart);
    // The main part of a PowerPoint file is a `p:presentation`; a Word file named .pptx has
    // a document there.
    isDeck =
      presentation?.documentElement?.localName === 'presentation' &&
      P_NS.has(presentation.documentElement.namespaceURI);
    const relationships = new Map(
      (await readRelationships(zip, DOMParserCtor, presentationPart)).map(rel => [rel.id, rel])
    );
    slides = descendants(presentation, P_NS, 'sldId').map((entry, index) => ({
      number: index + 1,
      part: relationships.get(relationshipId(entry))?.target
    }));
  } catch {
    slides = [];
  }
  // A slide list none of whose entries resolves (the relationships are missing or empty) is no
  // list: the file names still tell where the slides are. A list that resolves in part keeps
  // its numbering; the entries that do not resolve are skipped below.
  if (!slides.some(slide => slide.part)) slides = [];
  if (slides.length === 0) {
    slides = Object.keys(zip.files)
      .map(path => ({ part: path, match: /^ppt\/slides\/slide(\d+)\.xml$/.exec(path) }))
      .filter(entry => entry.match)
      .map(entry => ({ number: Number(entry.match[1]), part: entry.part }))
      .sort((a, b) => a.number - b.number);
  }

  // A package without slides whose main part is no presentation (missing, unreadable, or the
  // document of another Office format) is no deck.
  if (slides.length === 0 && !isDeck) {
    throw new Error(`${presentationPart} is not a presentation`);
  }

  const output = [];
  for (const { number, part } of slides) {
    if (!part) continue;
    const doc = await readPart(part);
    if (!doc) continue;
    const { title, blocks } = slideContent(doc);

    let notes = [];
    if (includeNotes) {
      // A notes part that cannot be read costs the notes only.
      try {
        const [notesTarget] = (await readRelationships(zip, DOMParserCtor, part))
          .filter(rel => rel.type.endsWith('/notesSlide'))
          .map(rel => rel.target);
        const notesDoc = notesTarget ? await readPart(notesTarget) : null;
        for (const shape of descendants(notesDoc, P_NS, 'sp')) {
          if (placeholderType(shape) === 'body') {
            notes.push(...paragraphsOf(children(shape, P_NS, 'txBody')[0]));
          }
        }
      } catch {
        notes = [];
      }
    }
    if (!title && blocks.length === 0 && notes.length === 0) continue;

    // `show="0"`: the slide is skipped in the slide show, but it is part of the deck.
    const hidden = ['0', 'false'].includes(doc.documentElement.getAttribute('show'));
    const marker = `[Slide ${number}${hidden ? ' (hidden)' : ''}]`;
    const lines = [marker];
    if (title) lines.push(`# ${title}`);
    for (const block of blocks) {
      if (block.table) {
        if (lines.length > 1 && lines[lines.length - 1] !== '') lines.push('');
        lines.push(...block.table, '');
      } else {
        lines.push(block.text);
      }
    }
    while (lines[lines.length - 1] === '') lines.pop();
    if (notes.length > 0) lines.push('[Notes]', ...notes);
    output.push(lines.join('\n'));
  }
  return output.join('\n\n').trim();
}
