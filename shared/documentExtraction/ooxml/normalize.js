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
 * @param {ReturnType<import('./numbering.js').createNumbering>|null} [context.numbering] - List
 *   numbering model; when given, Word's list labels (`1.`, `1.1`, `a)`) become text
 * @param {boolean} [context.canAddOutlineStyles] - False when the package has no styles part
 * @returns {{ outlineLevels: Set<number> }} Markdown heading levels (1–6) that now reference a
 *   synthetic `IHubOutline{n}` style the caller must add to styles.xml
 */
export function normalizeDocumentXml(
  doc,
  { xml, styles, numbering = null, canAddOutlineStyles = true }
) {
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

  // 0. Paragraphs whose paragraph mark is tracked as deleted or moved away are gone in the
  // accepted view (mammoth merges or drops them): they take no number. Looked up before the
  // moved-text pass removes the `w:moveFrom` marks.
  const goneParagraphs = new Set();
  for (const para of xml.all(doc, 'p')) {
    const markProps = xml.kid(xml.kid(para, 'pPr'), 'rPr');
    if (xml.kid(markProps, 'del') || xml.kid(markProps, 'moveFrom')) goneParagraphs.add(para);
  }

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

    // Text mammoth will output: `w:t` of visible runs. Field codes (`w:instrText`) and tracked
    // deletions (`w:delText`) are in `textContent` but never in the result.
    const hasAcceptedContent = visibleRuns.some(run =>
      xml.all(run, 't').some(text => text.textContent.trim() !== '')
    );

    // 3b. Page break before the paragraph (own property or paragraph style). Not before the
    // first content: a chapter that starts on page 1 is not a boundary between content.
    const pageBreakBefore =
      xml.toggle(xml.kid(pPr, 'pageBreakBefore')) ?? styles.resolve(styleId, 'pageBreakBefore');
    if (pageBreakBefore && hasAcceptedContent && seenContent) {
      para.parentNode.insertBefore(markerParagraph(), para);
    }
    if (hasAcceptedContent) seenContent = true;

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
        } else if (xml.isW(child, 't') && child.textContent.includes('\u00AD')) {
          child.textContent = child.textContent.replace(/\u00AD/g, '');
        }
      }
    }

    // 3d. List labels. Word computes `1.`, `1.1`, `a)` from the list definition; they are not
    // in the file. The label becomes the first text of the paragraph and the list properties are
    // neutralized, so mammoth neither lists the paragraph nor numbers it a second time.
    // Bullets stay with mammoth (a `-` list); without a result there is no label — a wrong
    // number is worse than none.
    if (numbering && !goneParagraphs.has(para)) {
      const direct = xml.kid(pPr, 'numPr');
      const directNumId = xml.val(xml.kid(direct, 'numId'));
      const numId = directNumId ?? styles.resolve(styleId, 'numId');
      if (numId !== undefined && numId !== '0') {
        const levelRaw = xml.val(xml.kid(direct, 'ilvl')) ?? styles.resolve(styleId, 'ilvl');
        const level =
          levelRaw === undefined || Number.isNaN(Number(levelRaw)) ? undefined : Number(levelRaw);
        const result = numbering.advance(numId, level, styleId);
        if (result.kind !== 'bullet' && result.kind !== 'unknown') {
          const hasContent =
            para.textContent.trim() !== '' ||
            xml.all(para, 'drawing').length > 0 ||
            xml.all(para, 'pict').length > 0;
          // A numbered paragraph without content still takes a number but shows no label.
          if (result.kind === 'label' && hasContent) {
            const run = xml.create(doc, 'r');
            run.appendChild(textElement(`${result.text} `));
            para.insertBefore(run, pPr ? pPr.nextSibling : para.firstChild);
          }
          const props = pPr || para.insertBefore(xml.create(doc, 'pPr'), para.firstChild);
          let numPr = xml.kid(props, 'numPr');
          if (numPr) while (numPr.firstChild) numPr.removeChild(numPr.firstChild);
          else numPr = props.appendChild(xml.create(doc, 'numPr'));
          // mammoth looks a list level up by (ilvl, numId); without an ilvl it falls back to the
          // level a numbering definition links to the paragraph's style, and the paragraph would
          // be listed anyway. Both values together point at "list 0", which does not exist.
          for (const name of ['ilvl', 'numId']) {
            numPr.appendChild(xml.create(doc, name)).setAttributeNS(xml.ns, 'w:val', '0');
          }
        }
      }
    }

    // 3e. Headings by outline level. mammoth maps built-in `heading 1–6` itself; every other
    // style with an outline level (corporate templates) and every paragraph with its own
    // outline level gets a synthetic style named `heading N`, which mammoth also maps.
    if (hasAcceptedContent) {
      const directLevel = xml.val(xml.kid(pPr, 'outlineLvl'));
      const direct = directLevel === undefined ? undefined : Number(directLevel);
      const level = Number.isNaN(direct)
        ? undefined
        : (direct ?? styles.resolve(styleId, 'outlineLvl'));
      const native = NATIVE_HEADING_NAME.test(styles.name(styleId) || '');
      const pStyleElement = xml.kid(pPr, 'pStyle');
      if (direct === 9 && native && pStyleElement) {
        // The author set "body text" on a paragraph with a built-in heading style: not a
        // heading, whatever the style says (mammoth would map the style).
        pPr.removeChild(pStyleElement);
      } else if (
        level !== undefined &&
        level >= 0 &&
        level <= 8 &&
        !(native && direct === undefined)
      ) {
        const mapped = Math.min(level, 5) + 1;
        if (canAddOutlineStyles) {
          outlineLevels.add(mapped);
          let paraProps = pPr;
          if (!paraProps) {
            paraProps = xml.create(doc, 'pPr');
            para.insertBefore(paraProps, para.firstChild);
          }
          let pStyle = pStyleElement;
          if (!pStyle) {
            pStyle = xml.create(doc, 'pStyle');
            paraProps.insertBefore(pStyle, paraProps.firstChild);
          }
          pStyle.setAttributeNS(xml.ns, 'w:val', outlineStyleId(mapped));
        } else {
          // A package without a styles part has no style to hand to mammoth: write the
          // heading marker into the text instead.
          const run = xml.create(doc, 'r');
          run.appendChild(textElement(`${'#'.repeat(mapped)} `));
          para.insertBefore(run, pPr ? pPr.nextSibling : para.firstChild);
        }
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
