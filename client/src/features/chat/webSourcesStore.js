import { useSyncExternalStore } from 'react';

/**
 * Which answer's sources view is open, and which citation is highlighted.
 *
 * The inline citation badges live inside the answer's rendered Markdown, the
 * source cards in a panel rendered next to the chat — two trees that share no
 * React parent on every surface ChatMessage is used in (main chat, compare
 * mode, canvas, the Office add-in, a shared chat). A module-level store keeps
 * them in sync without a provider each of those surfaces would need to mount.
 *
 * State:
 *   open:   { messageKey, focus } | null — the answer whose sources are shown,
 *           and the citation number to scroll to
 *   pinned: { messageKey, n } | null — set by a click or tap, kept until the
 *           next pin or until the view closes
 *   hover:  { messageKey, n } | null — set while a badge or card is hovered or
 *           focused; shown over the pinned one, which returns when it ends
 *
 * @module features/chat/webSourcesStore
 */

let state = { open: null, pinned: null, hover: null };
const listeners = new Set();

function set(next) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

const same = (a, messageKey, n) => a?.messageKey === messageKey && a?.n === n;

/** Open the sources view of an answer, optionally scrolled to citation `n`. */
export function openWebSources(messageKey, focus = null) {
  set({ open: { messageKey, focus } });
}

/** Close the sources view, and drop the pinned highlight with it. */
export function closeWebSources() {
  set({ open: null, pinned: null, hover: null });
}

/**
 * Highlight citation `n` of an answer: pinned (click, tap) or while hovered.
 * @param {string} messageKey
 * @param {number} n
 * @param {{pinned?: boolean}} [options]
 */
export function highlightCitation(messageKey, n, { pinned = false } = {}) {
  if (pinned) {
    if (same(state.pinned, messageKey, n) && !state.hover) return;
    set({ pinned: { messageKey, n }, hover: null });
  } else if (!same(state.hover, messageKey, n)) {
    set({ hover: { messageKey, n } });
  }
}

/** End the hover highlight of citation `n`; a pinned one stays. */
export function releaseCitation(messageKey, n) {
  if (same(state.hover, messageKey, n)) set({ hover: null });
}

/**
 * @returns {{open: Object|null, highlight: {messageKey: string, n: number}|null,
 *   pinned: Object|null}} `highlight` is the hovered citation, else the pinned one
 */
export function useWebSourcesState() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { open: current.open, pinned: current.pinned, highlight: current.hover || current.pinned };
}

/**
 * Subscribe outside React, for DOM that React does not own (the rendered
 * Markdown, whose citation badges are highlighted in place).
 * @param {() => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeWebSources(listener) {
  return subscribe(listener);
}

/** @returns {{messageKey: string, n: number}|null} the hovered, else the pinned citation */
export function currentCitationHighlight() {
  return state.hover || state.pinned;
}

/** Test helper — back to the initial state. */
export function _resetWebSourcesStore() {
  set({ open: null, pinned: null, hover: null });
}
