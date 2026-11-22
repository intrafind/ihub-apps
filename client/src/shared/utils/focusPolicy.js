// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * When something that appears by itself may move the keyboard focus to itself.
 *
 * A card that appears while the person writes (an approval, a question of the
 * assistant) must not take the focus: the next key they press would land in
 * the card, and an Enter meant for the message could answer it. So a card asks
 * {@link mayTakeFocus} first and, when the answer is no, leaves the focus where
 * it is and has its arrival said through the page's live region instead.
 *
 * The answer is no while:
 * - the focus is in the composer (an element inside `[data-composer]`);
 * - the composer holds text that is not sent yet (an enabled text field inside
 *   `[data-composer]` with a value), wherever the focus is;
 * - the focus is in any other text field or editable element (a text `input`,
 *   a `textarea`, a `select`, a `contenteditable`);
 * - the person pressed a key in a text field or pressed a pointer anywhere less
 *   than {@link RECENT_INTERACTION_MS} ago.
 *
 * @module shared/utils/focusPolicy
 */

/** The mark of the chat composer. */
export const COMPOSER_SELECTOR = '[data-composer]';

/** An interaction this recent still counts as the person being busy. */
export const RECENT_INTERACTION_MS = 1000;

/** Input types a person does not type into. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
]);

let lastInteractionAt = null;
let trackedDocument = null;

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * Whether an element takes typed text.
 *
 * @param {Element|null|undefined} element
 * @returns {boolean}
 */
export function isEditable(element) {
  if (!element || element.nodeType !== 1) return false;
  if (element.isContentEditable) return true;
  // Where `isContentEditable` is not implemented (jsdom), the attribute says it.
  if (element.closest?.('[contenteditable]:not([contenteditable="false"])')) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((element.type || 'text').toLowerCase());
  return false;
}

/**
 * Whether the composer holds text that is not sent yet.
 *
 * @param {Document} doc
 * @returns {boolean}
 */
function composerHoldsText(doc) {
  for (const composer of doc.querySelectorAll(COMPOSER_SELECTOR)) {
    for (const field of composer.querySelectorAll('textarea, input')) {
      if (!isEditable(field) || field.disabled) continue;
      if (typeof field.value === 'string' && field.value.trim() !== '') return true;
    }
  }
  return false;
}

/**
 * Note that the person interacted now. Called by the document listeners that
 * {@link trackInteractions} installs; exported for tests.
 *
 * @param {number} [at] - `performance.now()` time
 */
export function noteInteraction(at = now()) {
  lastInteractionAt = at;
}

function onKeyDown(event) {
  if (isEditable(event.target)) noteInteraction();
}

function onPointerDown() {
  noteInteraction();
}

/**
 * Start noting key presses in text fields and pointer presses on `doc`.
 * Idempotent per document; the module calls it for the page's document when it
 * is first loaded in a browser.
 *
 * @param {Document} [doc]
 */
export function trackInteractions(doc = typeof document === 'undefined' ? null : document) {
  if (!doc || trackedDocument === doc) return;
  if (trackedDocument) {
    trackedDocument.removeEventListener('keydown', onKeyDown, true);
    trackedDocument.removeEventListener('pointerdown', onPointerDown, true);
  }
  trackedDocument = doc;
  doc.addEventListener('keydown', onKeyDown, { capture: true, passive: true });
  doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
}

/** Forget the last interaction (tests). */
export function resetFocusPolicy() {
  lastInteractionAt = null;
}

/**
 * Whether an element that just appeared may move the focus to itself.
 *
 * @param {Object} [options]
 * @param {Document} [options.doc=document]
 * @param {number} [options.at] - the current `performance.now()` time
 * @returns {boolean}
 */
export function mayTakeFocus({ doc = typeof document === 'undefined' ? null : document, at } = {}) {
  if (!doc) return false;
  const active = doc.activeElement;
  if (active && active !== doc.body && active.closest?.(COMPOSER_SELECTOR)) return false;
  if (isEditable(active)) return false;
  if (composerHoldsText(doc)) return false;
  const time = at ?? now();
  if (lastInteractionAt !== null && time - lastInteractionAt < RECENT_INTERACTION_MS) return false;
  return true;
}

/**
 * Whether an element is rendered (not inside `display: none`). The chat page
 * renders its list twice, for narrow and for wide screens, and hides one: a
 * card in the hidden copy must neither take the focus nor be announced. Where
 * the browser cannot tell (`checkVisibility` is missing, as in jsdom), it
 * counts as shown.
 *
 * @param {Element|null|undefined} element
 * @returns {boolean}
 */
export function isShown(element) {
  if (!element) return false;
  return typeof element.checkVisibility === 'function' ? element.checkVisibility() : true;
}

/**
 * Whether nobody holds the focus but the composer: the focus is on nothing (the
 * page), or inside `[data-composer]`. The composer takes the focus back at the
 * end of a turn only then, so a card that took it, or a field the person types
 * in, keeps it.
 *
 * @param {Document} [doc=document]
 * @returns {boolean}
 */
export function focusIsFree(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return false;
  const active = doc.activeElement;
  if (!active || active === doc.body || active === doc.documentElement) return true;
  return Boolean(active.closest?.(COMPOSER_SELECTOR));
}

trackInteractions();
