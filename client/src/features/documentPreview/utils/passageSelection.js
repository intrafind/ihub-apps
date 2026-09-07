/**
 * Turns a citation document's passage list into the props the document preview
 * expects.
 *
 * The preview highlights a list of passage texts and may single one of them out.
 * Those two must be derived together: the list drops passages with no usable
 * text, so an index taken from the *displayed* list would point at the wrong
 * passage as soon as one is dropped. Callers therefore name the passage they
 * want focused and let this resolve its position.
 */

/**
 * Whether a passage carries text that could be matched in a document. Blank and
 * whitespace-only content is useless to the matcher and is not counted.
 *
 * @param {{content: string}} passage
 * @returns {boolean}
 */
export const hasPassageText = passage =>
  typeof passage?.content === 'string' && passage.content.trim().length > 0;

/**
 * @param {Array<{content: string}>} passageList the document's passages, in
 *   display order.
 * @param {{content: string}} [focusPassage] the passage to single out; must be
 *   an element of `passageList` (identity comparison).
 * @returns {{passages: string[], initialPassageIndex: number}} passage texts and
 *   the index of the focused one within them, or `-1` for none.
 */
export function selectPreviewPassages(passageList, focusPassage = null) {
  const usable = (passageList || []).filter(hasPassageText);
  return {
    passages: usable.map(p => p.content),
    initialPassageIndex: focusPassage ? usable.indexOf(focusPassage) : -1
  };
}
