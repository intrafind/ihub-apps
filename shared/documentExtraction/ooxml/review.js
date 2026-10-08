/**
 * Tracked changes and comments of a Word document (opt-in per app, decision A3).
 *
 * By default the extraction shows the accepted view without comments — what the document
 * says once all changes are accepted. For review and comparison tasks an app can ask for
 * the marks instead: insertions and deletions as CriticMarkup (`{++added++}`, `{--removed--}`),
 * comments as `{>>Author: text<<}` right after the text they are attached to.
 *
 * mammoth drops deleted text and comments, so both are written into the document as ordinary
 * text runs before mammoth reads it (the same approach as the numbering labels). Mutates the
 * DOM; the caller treats a thrown error as "use the legacy extraction".
 *
 * @module shared/documentExtraction/ooxml/review
 */
import { DELETE_CLOSE, DELETE_OPEN, INSERT_CLOSE, INSERT_OPEN, commentMarker } from '../markers.js';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Values the per-app options accept; everything else means the default. */
export const TRACKED_CHANGES_MODES = ['accepted', 'markup'];
export const COMMENTS_MODES = ['ignore', 'inline'];

/**
 * @param {{trackedChanges?: string, comments?: string}} [options]
 * @returns {{trackedChanges: 'accepted'|'markup', comments: 'ignore'|'inline'}}
 */
export function normalizeReviewOptions(options) {
  return {
    trackedChanges: options?.trackedChanges === 'markup' ? 'markup' : 'accepted',
    comments: options?.comments === 'inline' ? 'inline' : 'ignore'
  };
}

// `w:ins` / `w:del` also occur inside property elements, where they mark a paragraph mark or a
// table row, not text.
const PROPERTY_PARENTS = new Set(['rPr', 'trPr', 'tcPr', 'pPr', 'tblPrEx', 'sectPr']);

/**
 * Comments by id: author and text (the paragraphs of a comment joined by a space). Deleted text
 * (`w:delText`) is not part of it.
 *
 * @param {Document} commentsDoc - Parsed word/comments.xml
 * @param {ReturnType<import('./xml.js').createWordXml>} xml
 * @returns {Map<string, {author: string|undefined, text: string}>}
 */
export function readComments(commentsDoc, xml) {
  const comments = new Map();
  for (const comment of xml.all(commentsDoc, 'comment')) {
    const id = xml.attr(comment, 'id');
    if (id === undefined) continue;
    const paragraphs = xml
      .all(comment, 'p')
      .map(para =>
        xml
          .all(para, 't')
          .map(text => text.textContent)
          .join('')
      )
      .filter(text => text.trim() !== '');
    comments.set(id, { author: xml.attr(comment, 'author'), text: paragraphs.join(' ') });
  }
  return comments;
}

/**
 * Writes insertions and deletions into the text of word/document.xml as CriticMarkup.
 *
 * Moved text is a deletion where it was and an insertion where it is. Paragraph and row marks
 * that mammoth would use to merge or drop content (`w:del`, `w:moveFrom`) are removed, so a
 * deleted paragraph or table row stays where it was, with its text marked as deleted.
 * Formatting changes (`w:rPrChange` …) are not text and stay unmarked.
 *
 * @param {Document} doc
 * @param {ReturnType<import('./xml.js').createWordXml>} xml
 */
export function markTrackedChanges(doc, xml) {
  const textElement = text => {
    const element = xml.create(doc, 't');
    element.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    element.textContent = text;
    return element;
  };
  const markerRun = text => {
    const run = xml.create(doc, 'r');
    run.appendChild(textElement(text));
    return run;
  };
  const textOf = element =>
    xml
      .all(element, 't')
      .map(text => text.textContent)
      .join('');
  const isRunContainer = element =>
    !!element.parentNode &&
    !(
      element.parentNode.namespaceURI === xml.ns &&
      PROPERTY_PARENTS.has(element.parentNode.localName)
    );

  // Marks of whole paragraphs and rows.
  for (const props of xml.all(doc, 'pPr')) {
    const markProps = xml.kid(props, 'rPr');
    for (const name of ['del', 'moveFrom']) {
      const mark = xml.kid(markProps, name);
      if (mark) markProps.removeChild(mark);
    }
  }
  for (const props of xml.all(doc, 'trPr')) {
    const mark = xml.kid(props, 'del');
    if (mark) props.removeChild(mark);
  }

  /** Replaces `container` by its content, between the marker runs when there is text. */
  const unwrap = (container, open, close, dropIfBlank) => {
    const parent = container.parentNode;
    const marked = textOf(container).trim() !== '';
    if (!marked && dropIfBlank) {
      parent.removeChild(container);
      return;
    }
    if (marked) parent.insertBefore(markerRun(open), container);
    while (container.firstChild) parent.insertBefore(container.firstChild, container);
    if (marked) parent.insertBefore(markerRun(close), container);
    parent.removeChild(container);
  };

  for (const removed of [...xml.all(doc, 'del'), ...xml.all(doc, 'moveFrom')]) {
    if (!isRunContainer(removed)) continue;
    // Deleted text is stored as `w:delText`; as `w:t` it is ordinary text for mammoth.
    for (const deleted of xml.all(removed, 'delText')) {
      deleted.parentNode.replaceChild(textElement(deleted.textContent), deleted);
    }
    // A deleted field has nothing to show; its parts must not unbalance a field around it.
    for (const name of ['delInstrText', 'instrText', 'fldChar']) {
      for (const part of xml.all(removed, name)) part.parentNode.removeChild(part);
    }
    unwrap(removed, DELETE_OPEN, DELETE_CLOSE, true);
  }
  for (const added of [...xml.all(doc, 'ins'), ...xml.all(doc, 'moveTo')]) {
    if (isRunContainer(added)) unwrap(added, INSERT_OPEN, INSERT_CLOSE, false);
  }
}

/**
 * Replaces every comment reference of word/document.xml by the comment as text. A reference
 * sits right after the end of the commented range, so the comment follows the text it is about.
 * References to unknown or empty comments are removed.
 *
 * @param {Document} doc
 * @param {ReturnType<import('./xml.js').createWordXml>} xml
 * @param {Map<string, {author: string|undefined, text: string}>} comments
 */
export function inlineComments(doc, xml, comments) {
  for (const reference of xml.all(doc, 'commentReference')) {
    const parent = reference.parentNode;
    if (!parent) continue;
    const comment = comments.get(xml.attr(reference, 'id'));
    if (!comment || comment.text.trim() === '') {
      parent.removeChild(reference);
      continue;
    }
    const text = xml.create(doc, 't');
    text.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    text.textContent = commentMarker(comment);
    parent.replaceChild(text, reference);
  }
}
