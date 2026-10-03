/**
 * The `/` picker of the chat input (prompts and skills), as plain text
 * operations so they can be tested without a browser.
 *
 * The picker opens in two places:
 * - in an **empty** input — the `/` is not typed, and what is picked becomes
 *   the input (the original behaviour);
 * - right after **whitespace** in a non-empty input — the `/` *is* typed (so
 *   closing the picker leaves a literal slash), and what is picked replaces
 *   that `/`. Its offset is the picker's *anchor*.
 *
 * A picked skill is not sent: `/<skill-name> ` goes into the text, and the
 * server activates every skill named by a `/name` token in the message.
 */

/**
 * Whether a `/` typed into a non-empty input opens the picker: the caret is a
 * plain cursor (no selection) at the start of a word — at the very start of
 * the text or right after whitespace. A `/` inside a word (`and/or`, a URL)
 * stays a plain character.
 *
 * @param {string} value - The input's text.
 * @param {number|null|undefined} selectionStart - Caret start.
 * @param {number|null|undefined} selectionEnd - Caret end.
 * @returns {boolean}
 */
export function opensSlashPickerMidText(value, selectionStart, selectionEnd) {
  if (typeof value !== 'string' || value === '') return false;
  if (typeof selectionStart !== 'number' || selectionStart !== selectionEnd) return false;
  if (selectionStart === 0) return true;
  return /\s/.test(value.charAt(selectionStart - 1));
}

/**
 * Type a `/` at the caret, as the browser would have.
 *
 * @param {string} value - The input's text.
 * @param {number} position - The caret.
 * @returns {string}
 */
export function typeSlashAt(value, position) {
  return `${value.slice(0, position)}/${value.slice(position)}`;
}

/**
 * Put picked text where the picker was opened.
 *
 * @param {string} value - The input's text now.
 * @param {number|null} anchor - Offset of the typed `/`, or null when the
 *   picker opened in an empty input (the text then becomes the input).
 * @param {string} text - The text to insert.
 * @param {number|null} [caretInText] - Where the caret goes, relative to
 *   `text`; the end of `text` when omitted.
 * @returns {{value: string, caret: number}}
 *
 * @example
 * insertAtSlash('Summarize / please', 10, 'the text above');
 * // → { value: 'Summarize the text above please', caret: 24 }
 */
export function insertAtSlash(value, anchor, text, caretInText = null) {
  const caretOffset =
    typeof caretInText === 'number' ? Math.min(Math.max(caretInText, 0), text.length) : text.length;
  if (typeof anchor !== 'number') {
    return { value: text, caret: caretOffset };
  }
  const current = typeof value === 'string' ? value : '';
  const at = Math.min(Math.max(anchor, 0), current.length);
  const hasSlash = current.charAt(at) === '/';
  const before = current.slice(0, at);
  const after = current.slice(at + (hasSlash ? 1 : 0));
  return { value: before + text + after, caret: at + caretOffset };
}

/**
 * The text a picked skill puts into the input: `/<name>` and a space, unless
 * whitespace already follows. Personal skills are named by their `name`,
 * never their `usk_…` id.
 *
 * @param {string} name - The skill's name.
 * @param {string} [following=''] - The text after the insertion point.
 * @returns {string}
 */
export function skillToken(name, following = '') {
  return /^\s/.test(following) ? `/${name}` : `/${name} `;
}

/**
 * Insert a picked skill where the picker was opened.
 *
 * @param {string} value - The input's text now.
 * @param {number|null} anchor - See `insertAtSlash`.
 * @param {string} name - The skill's name.
 * @returns {{value: string, caret: number}}
 */
export function insertSkillAtSlash(value, anchor, name) {
  if (typeof anchor !== 'number') return insertAtSlash(value, anchor, skillToken(name));
  const current = typeof value === 'string' ? value : '';
  const hasSlash = current.charAt(anchor) === '/';
  const following = current.slice(anchor + (hasSlash ? 1 : 0));
  return insertAtSlash(current, anchor, skillToken(name, following));
}
