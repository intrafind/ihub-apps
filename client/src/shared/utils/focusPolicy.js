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
 * The first two rules do not apply to a focus the page placed by itself (the
 * composer takes the focus back at the end of a turn, {@link noteAutoFocus})
 * as long as the person has not pressed a key or a pointer since: an empty
 * composer the page just focused is not someone typing, and a card that
 * appears in the next moment (the turn ended because it asks) still takes the
 * focus.
 *
 * A disabled or inert element that still counts as focused (a browser without
 * the focus fixup leaves a text field focused when it is disabled, as the
 * composer is while an answer runs) holds no focus: nobody types into it.
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
/** The element the page moved the focus to by itself, until the person next interacts. */
let autoFocused = null;

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * Whether an element can be used at all: not disabled (itself or through a
 * disabled `fieldset`) and not inside an `inert` subtree.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function isUsable(element) {
  if (element.disabled === true) return false;
  if (element.matches?.(':disabled')) return false;
  return !element.closest?.('[inert]');
}

/**
 * Whether an element takes typed text. A disabled or inert field does not.
 *
 * @param {Element|null|undefined} element
 * @returns {boolean}
 */
export function isEditable(element) {
  if (!element || element.nodeType !== 1) return false;
  if (!isUsable(element)) return false;
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
      if (!isEditable(field)) continue;
      if (typeof field.value === 'string' && field.value.trim() !== '') return true;
    }
  }
  return false;
}

/**
 * The element that holds the focus, or null when nothing does: the page itself,
 * or a disabled or inert element the browser still reports as focused.
 *
 * @param {Document} doc
 * @returns {Element|null}
 */
function focusHolder(doc) {
  const active = doc.activeElement;
  if (!active || active === doc.body || active === doc.documentElement) return null;
  return isUsable(active) ? active : null;
}

/**
 * Note that the person interacted now. Called by the document listeners that
 * {@link trackInteractions} installs; exported for tests.
 *
 * @param {number} [at] - `performance.now()` time
 */
export function noteInteraction(at = now()) {
  lastInteractionAt = at;
  autoFocused = null;
}

/**
 * Note that the page, not the person, just moved the focus to `element` (the
 * composer taking the focus back at the end of a turn). Until the person
 * presses a key in a text field or a pointer, that focus does not count as
 * typing.
 *
 * @param {Element|null|undefined} element
 */
export function noteAutoFocus(element) {
  autoFocused = element ?? null;
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
  autoFocused = null;
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
  const active = focusHolder(doc);
  const placedByPage = active !== null && active === autoFocused;
  if (!placedByPage && active?.closest?.(COMPOSER_SELECTOR)) return false;
  if (!placedByPage && isEditable(active)) return false;
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
 * page, or a disabled element), or inside `[data-composer]`. The composer takes
 * the focus back at the end of a turn only then, so a card that took it, or a
 * field the person types in, keeps it.
 *
 * @param {Document} [doc=document]
 * @returns {boolean}
 */
export function focusIsFree(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return false;
  const active = focusHolder(doc);
  if (!active) return true;
  return Boolean(active.closest?.(COMPOSER_SELECTOR));
}

trackInteractions();
