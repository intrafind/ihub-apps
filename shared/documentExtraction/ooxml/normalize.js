/**
 * Prepares word/document.xml for mammoth.
 *
 * mammoth turns a Word file into HTML but drops or mangles several things that matter to a
 * model reading the text: custom heading styles and outline levels, page breaks (words on
 * both sides of one are glued together), `w:cr`, moved text (both ends vanish), and it keeps
 * text the author hid. This pass rewrites the DOM so that mammoth's output is right, instead
 * of patching the HTML afterwards.
 *
 * Mutates `doc`. Every step tolerates missing or unusual parts; the caller treats a thrown
 * error as "use the legacy extraction".
 *
 * @module shared/documentExtraction/ooxml/normalize
 */
import { PAGE_BREAK_MARKER } from '../markers.js';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Built-in heading styles mammoth maps itself (`heading 1` … `heading 6`). */
const NATIVE_HEADING_NAME = /^heading\s*[1-6]$/i;

/** Section break types that start a new page (the default type is `nextPage`). */
const PAGE_STARTING_SECTION_TYPES = new Set([undefined, 'nextPage', 'oddPage', 'evenPage']);

/** Style ID of the synthetic heading style for Markdown level 1–6. */
export const outlineStyleId = level => `IHubOutline${level}`;

/**
 * @param {Document} doc - Parsed word/document.xml
 * @param {Object} context
 * @param {ReturnType<import('./xml.js').createWordXml>} context.xml
 * @param {ReturnType<import('./styles.js').readStyles>} context.styles
 * @param {boolean} [context.canAddOutlineStyles] - False when the package has no styles part
 * @returns {{ outlineLevels: Set<number> }} Markdown heading levels (1–6) that now reference a
 *   synthetic `IHubOutline{n}` style the caller must add to styles.xml
 */
export function normalizeDocumentXml(doc, { xml, styles, canAddOutlineStyles = true }) {
  const outlineLevels = new Set();
  const markerParagraphs = new Set();

  const closestParagraph = node => {
    let current = node.parentNode;
    while (current && !xml.isW(current, 'p')) current = current.parentNode;
    return current;
  };
  const ownRuns = para => xml.all(para, 'r').filter(run => closestParagraph(run) === para);

  const textElement = text => {
    const t = xml.create(doc, 't');
    t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    t.textContent = text;
    return t;
  };
  const markerParagraph = () => {
    const para = xml.create(doc, 'p');
    const run = xml.create(doc, 'r');
    run.appendChild(textElement(PAGE_BREAK_MARKER));
    para.appendChild(run);
    markerParagraphs.add(para);
    return para;
  };

  // 1. Moved text. mammoth drops both ends; keep the new position, drop the old one.
  for (const from of xml.all(doc, 'moveFrom')) from.parentNode?.removeChild(from);
  for (const to of xml.all(doc, 'moveTo')) {
    const parent = to.parentNode;
    if (!parent) continue;
    while (to.firstChild) parent.insertBefore(to.firstChild, to);
    parent.removeChild(to);
  }

  // 2. Sections: a section that starts on a new page is a page boundary after the paragraph
  // that ends the previous section. (A sectPr describes the section it ENDS, but its type says
  // how that section STARTS — so the type of section k decides the break after section k-1.)
  const body = xml.kid(doc.documentElement, 'body');
  const sections = [];
  for (const sectPr of xml.all(doc, 'sectPr')) {
    const parent = sectPr.parentNode;
    const endParagraph = xml.isW(parent, 'pPr') ? parent.parentNode : null;
    if (!endParagraph && parent !== body) continue; // e.g. inside a header part reference
    sections.push({ endParagraph, type: xml.val(xml.kid(sectPr, 'type')) });
  }
  const pageBreakAfter = new Set();
  for (let index = 1; index < sections.length; index += 1) {
    const previousEnd = sections[index - 1].endParagraph;
    if (previousEnd && PAGE_STARTING_SECTION_TYPES.has(sections[index].type)) {
      pageBreakAfter.add(previousEnd);
    }
  }

  // 3. Paragraphs, in document order (includes table cells, text boxes, content controls).
  let seenContent = false;
  for (const para of xml.all(doc, 'p')) {
    if (!para.parentNode) continue;
    const pPr = xml.kid(para, 'pPr');
    const styleId = xml.val(xml.kid(pPr, 'pStyle'));

    // 3a. Hidden text (w:vanish — directly, via character style, or via paragraph style).
    const paragraphStyleHidden = styles.resolve(styleId, 'vanish');
    let hiddenRuns = 0;
    const visibleRuns = [];
    for (const run of ownRuns(para)) {
      const rPr = xml.kid(run, 'rPr');
      let hidden = xml.toggle(xml.kid(rPr, 'vanish'));
      if (hidden === undefined) {
        const charStyle = xml.val(xml.kid(rPr, 'rStyle'));
        if (charStyle) hidden = styles.resolve(charStyle, 'vanish');
      }
      if (hidden === undefined) hidden = paragraphStyleHidden === true;
      if (hidden) {
        run.parentNode.removeChild(run);
        hiddenRuns += 1;
      } else {
        visibleRuns.push(run);
      }
    }
    const markHidden =
      (xml.toggle(xml.kid(xml.kid(pPr, 'rPr'), 'vanish')) ?? paragraphStyleHidden) === true;
    if (visibleRuns.length === 0 && (markHidden || hiddenRuns > 0)) {
      // A hidden paragraph is not output and — for numbering — does not count. The only
      // paragraph of a table cell must stay (a cell needs one); it is simply empty.
      const parent = para.parentNode;
      const soleCellParagraph = xml.isW(parent, 'tc') && xml.kids(parent, 'p').length === 1;
      if (!soleCellParagraph) parent.removeChild(para);
      continue;
    }

    // 3b. Page break before the paragraph (own property or paragraph style). Not before the
    // first content: a chapter that starts on page 1 is not a boundary between content.
    const pageBreakBefore =
      xml.toggle(xml.kid(pPr, 'pageBreakBefore')) ?? styles.resolve(styleId, 'pageBreakBefore');
    if (pageBreakBefore && seenContent) para.parentNode.insertBefore(markerParagraph(), para);
    if (para.textContent.trim()) seenContent = true;

    // 3c. Runs: soft hyphens out; w:cr is a line break; a page break must not glue words.
    for (const run of visibleRuns) {
      for (const child of Array.from(run.childNodes)) {
        if (xml.isW(child, 'softHyphen')) {
          run.removeChild(child);
        } else if (xml.isW(child, 'cr')) {
          run.replaceChild(xml.create(doc, 'br'), child);
        } else if (xml.isW(child, 'br') && xml.attr(child, 'type') === 'page') {
          run.insertBefore(xml.create(doc, 'br'), child);
          run.insertBefore(textElement(PAGE_BREAK_MARKER), child);
          run.replaceChild(xml.create(doc, 'br'), child);
        } else if (xml.isW(child, 't') && child.textContent.includes('­')) {
          child.textContent = child.textContent.replace(/­/g, '');
        }
      }
    }

    // 3d. Headings by outline level. mammoth maps built-in `heading 1–6` itself; every other
    // style with an outline level (corporate templates) and every paragraph with its own
    // outline level gets a synthetic style named `heading N`, which mammoth also maps.
    if (canAddOutlineStyles) {
      const directLevel = xml.val(xml.kid(pPr, 'outlineLvl'));
      const direct = directLevel === undefined ? undefined : Number(directLevel);
      const level = Number.isNaN(direct)
        ? undefined
        : (direct ?? styles.resolve(styleId, 'outlineLvl'));
      const native = NATIVE_HEADING_NAME.test(styles.name(styleId) || '');
      if (level !== undefined && level >= 0 && level <= 8 && !(native && direct === undefined)) {
        const mapped = Math.min(level, 5) + 1;
        outlineLevels.add(mapped);
        let paraProps = pPr;
        if (!paraProps) {
          paraProps = xml.create(doc, 'pPr');
          para.insertBefore(paraProps, para.firstChild);
        }
        let pStyle = xml.kid(paraProps, 'pStyle');
        if (!pStyle) {
          pStyle = xml.create(doc, 'pStyle');
          paraProps.insertBefore(pStyle, paraProps.firstChild);
        }
        pStyle.setAttributeNS(xml.ns, 'w:val', outlineStyleId(mapped));
      }
    }
  }

  // 4. Section breaks that start a new page.
  for (const para of pageBreakAfter) {
    if (para.parentNode) para.parentNode.insertBefore(markerParagraph(), para.nextSibling);
  }

  // 5. One marker per boundary (a section break next to a page-break-before heading).
  for (const marker of markerParagraphs) {
    const previous = marker.previousSibling;
    if (marker.parentNode && previous && markerParagraphs.has(previous)) {
      marker.parentNode.removeChild(marker);
    }
  }

  return { outlineLevels };
}

/**
 * Adds the synthetic heading styles `IHubOutline1–6` (named `heading N`) to styles.xml.
 *
 * @param {Document} stylesDoc
 * @param {ReturnType<import('./xml.js').createWordXml>} xml
 * @param {Iterable<number>} levels
 */
export function addOutlineStyles(stylesDoc, xml, levels) {
  for (const level of levels) {
    const style = xml.create(stylesDoc, 'style');
    style.setAttributeNS(xml.ns, 'w:type', 'paragraph');
    style.setAttributeNS(xml.ns, 'w:styleId', outlineStyleId(level));
    const name = xml.create(stylesDoc, 'name');
    name.setAttributeNS(xml.ns, 'w:val', `heading ${level}`);
    style.appendChild(name);
    stylesDoc.documentElement.appendChild(style);
  }
}
