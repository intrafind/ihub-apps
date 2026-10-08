/**
 * Headers and footers of a Word document: letterheads, document numbers, confidentiality
 * notes, the sender address in a text box. mammoth has no reader for them, so without this
 * they never reach the model.
 *
 * Only what Word shows is read (visible text): a first-page header needs `w:titlePg` in its
 * section, an even-page header needs `w:evenAndOddHeaders` in the settings; hidden text, tracked
 * deletions and the results of page-number fields (`PAGE`, `NUMPAGES`, `SECTIONPAGES` — the
 * cached value belongs to whichever page was rendered last, so it would only mislead) are left
 * out. Images are dropped, tables become lines of cells joined with ` | `.
 *
 * @module shared/documentExtraction/ooxml/headerFooter
 */

const R_NAMESPACES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships' // NOSONAR: an XML namespace name, never requested
];
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/** Fields whose result is a page number. */
const PAGE_FIELD = /^\s*(?:PAGE|NUMPAGES|SECTIONPAGES)\b/i;

/**
 * What is left of "Seite {PAGE} von {NUMPAGES}" once the numbers are gone ("Seite von") is
 * noise, not content. A line that held a page-number field and now consists only of these words
 * is dropped; any other word ("Vertraulich", "Entwurf") keeps its line.
 */
const PAGINATION_WORDS = new Set(
  (
    'seite seiten s page pages p pp pag pág pagina página sur van av af z ze på de di von vom of ' +
    'strana strona sida sivu oldal sayfa стр страница из 第 页 頁 ページ'
  ).split(' ')
);

const isPaginationOnly = line => {
  const words = line
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  return !/\d/.test(line) && words.every(word => PAGINATION_WORDS.has(word));
};

const relationshipId = element => {
  for (const ns of R_NAMESPACES) {
    const value = element.getAttributeNS(ns, 'id');
    if (value) return value;
  }
  return element.getAttribute('r:id') || undefined;
};

/**
 * @param {Object} args
 * @param {Document} args.documentDoc - Parsed word/document.xml
 * @param {ReturnType<import('./xml.js').createWordXml>} args.xml
 * @param {Map<string, {type: string, target: string}>} args.relationships - Relationships of the
 *   document part by id (targets already resolved to package part names)
 * @param {(partName: string) => Promise<Document|null>} args.readPart - Parsed part, or null
 * @param {{resolve: (styleId: string|undefined, prop: string) => *}} [args.styles] - Style model
 *   (`readStyles`): text hidden through a character or paragraph style is not read
 * @param {boolean} [args.evenAndOddHeaders] - `w:evenAndOddHeaders` in the settings
 * @returns {Promise<{header: string[], footer: string[]}>} De-duplicated, non-empty lines
 */
export async function readHeaderFooterText({
  documentDoc,
  xml,
  relationships,
  readPart,
  styles = { resolve: () => undefined },
  evenAndOddHeaders = false
}) {
  // ── text of one paragraph ────────────────────────────────────────────────────────────────
  const textBoxesIn = (node, found) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      if (child.namespaceURI === MC_NS && child.localName === 'AlternateContent') {
        // Word writes the same box twice (modern + legacy drawing): read the first.
        const branch =
          Array.from(child.childNodes).find(
            n => n.nodeType === 1 && n.namespaceURI === MC_NS && n.localName === 'Choice'
          ) ||
          Array.from(child.childNodes).find(
            n => n.nodeType === 1 && n.namespaceURI === MC_NS && n.localName === 'Fallback'
          );
        if (branch) textBoxesIn(branch, found);
      } else if (child.localName === 'txbxContent') {
        found.push(child);
      } else {
        textBoxesIn(child, found);
      }
    }
  };

  const paragraphLines = paragraph => {
    const fields = []; // complex fields being read: { instr, phase, page }
    const boxes = [];
    let text = '';
    let hadPageField = false;
    const suppressed = () => fields.some(f => f.phase === 'result' && f.page);

    const paragraphStyleHidden = styles.resolve(
      xml.val(xml.kid(xml.kid(paragraph, 'pPr'), 'pStyle')),
      'vanish'
    );

    // Hidden like the body pass decides it: the run's own property, else its character style,
    // else the paragraph's style.
    const isHidden = run => {
      const rPr = xml.kid(run, 'rPr');
      let hidden = xml.toggle(xml.kid(rPr, 'vanish'));
      if (hidden === undefined) {
        const characterStyle = xml.val(xml.kid(rPr, 'rStyle'));
        if (characterStyle) hidden = styles.resolve(characterStyle, 'vanish');
      }
      if (hidden === undefined) hidden = paragraphStyleHidden;
      return hidden === true;
    };

    const readRun = run => {
      const hidden = isHidden(run);
      for (const child of Array.from(run.childNodes)) {
        if (child.nodeType !== 1) continue;
        if (
          child.namespaceURI === MC_NS ||
          ['drawing', 'pict', 'object'].includes(child.localName)
        ) {
          if (!hidden && !suppressed()) textBoxesIn({ childNodes: [child] }, boxes);
          continue;
        }
        if (child.namespaceURI !== xml.ns) continue;
        switch (child.localName) {
          case 'fldChar': {
            const type = xml.attr(child, 'fldCharType');
            if (type === 'begin') fields.push({ instr: '', phase: 'instr', page: false });
            else if (type === 'separate' && fields.length > 0) {
              const field = fields[fields.length - 1];
              field.phase = 'result';
              field.page = PAGE_FIELD.test(field.instr);
              if (field.page) hadPageField = true;
            } else if (type === 'end') fields.pop();
            break;
          }
          case 'instrText': {
            const field = fields[fields.length - 1];
            if (field && field.phase === 'instr') field.instr += child.textContent;
            break;
          }
          case 't':
            if (!hidden && !suppressed()) text += child.textContent;
            break;
          case 'tab':
          case 'br':
          case 'cr':
            if (!hidden && !suppressed()) text += ' ';
            break;
          case 'noBreakHyphen':
            if (!hidden && !suppressed()) text += '-';
            break;
          default:
        }
      }
    };

    const visit = node => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType !== 1 || child.namespaceURI !== xml.ns) continue;
        switch (child.localName) {
          case 'r':
            readRun(child);
            break;
          case 'fldSimple':
            if (PAGE_FIELD.test(xml.attr(child, 'instr') || '')) hadPageField = true;
            else visit(child);
            break;
          case 'ins':
          case 'moveTo':
          case 'hyperlink':
          case 'smartTag':
          case 'sdtContent':
            visit(child);
            break;
          case 'sdt':
            visit(xml.kid(child, 'sdtContent') || child);
            break;
          // Tracked deletions and moved-away text are not shown in the accepted view.
          default:
        }
      }
    };
    visit(paragraph);

    let line = text.replace(/\s+/g, ' ').trim();
    if (hadPageField && isPaginationOnly(line)) line = '';
    return [line, ...boxes.flatMap(box => blockLines(box))];
  };

  /** Lines of a container of paragraphs and tables (a header, a table cell, a text box). */
  function blockLines(container) {
    const lines = [];
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType !== 1 || child.namespaceURI !== xml.ns) continue;
      if (child.localName === 'p') {
        lines.push(...paragraphLines(child));
      } else if (child.localName === 'tbl') {
        for (const row of xml.kids(child, 'tr')) {
          const cells = xml
            .kids(row, 'tc')
            .map(cell => blockLines(cell).join(' ').trim())
            .filter(Boolean);
          if (cells.length > 0) lines.push(cells.join(' | '));
        }
      } else if (child.localName === 'sdt') {
        lines.push(...blockLines(xml.kid(child, 'sdtContent') || child));
      }
    }
    return lines;
  }

  // ── which parts are shown ────────────────────────────────────────────────────────────────
  const result = { header: [], footer: [] };
  const seen = { header: new Set(), footer: new Set() };
  const partCache = new Map();
  const linesOfPart = async target => {
    if (!partCache.has(target)) {
      let lines = [];
      try {
        const doc = await readPart(target);
        const root = doc && doc.documentElement;
        if (root) lines = blockLines(root).filter(Boolean);
      } catch {
        // A part that is not valid XML costs its own lines only, not those of the other parts.
      }
      partCache.set(target, lines);
    }
    return partCache.get(target);
  };

  // Section properties that apply now: a `w:sectPr` inside a `w:sectPrChange` is the record of
  // how the section looked before a tracked change.
  const sections = xml
    .all(documentDoc, 'sectPr')
    .filter(s => !xml.isW(s.parentNode, 'sectPrChange'));
  // A section without a reference of some type uses the one of the section before it.
  const inherited = { header: new Map(), footer: new Map() };
  for (const sectPr of sections) {
    const titlePage = xml.toggle(xml.kid(sectPr, 'titlePg')) === true;
    for (const kind of ['header', 'footer']) {
      for (const reference of xml.kids(sectPr, `${kind}Reference`)) {
        inherited[kind].set(xml.attr(reference, 'type') || 'default', reference);
      }
      for (const type of ['default', 'first', 'even']) {
        const reference = inherited[kind].get(type);
        if (!reference) continue;
        if (type === 'first' && !titlePage) continue;
        if (type === 'even' && !evenAndOddHeaders) continue;
        const relationship = relationships.get(relationshipId(reference));
        if (!relationship || !relationship.type.endsWith(`/${kind}`)) continue;
        for (const line of await linesOfPart(relationship.target)) {
          if (seen[kind].has(line)) continue;
          seen[kind].add(line);
          result[kind].push(line);
        }
      }
    }
  }
  return result;
}
