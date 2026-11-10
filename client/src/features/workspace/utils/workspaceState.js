// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rules of the workspace pane that do not need React: its width, what the
 * URL says is open, whether there is room for a split, which layer Esc closes
 * and when the left sidebar folds to its rail. Kept here so they can be tested
 * on their own (concept "Workspace Pane for Artifacts, Files and Sources", §4, §9).
 *
 * @module features/workspace/utils/workspaceState
 */

/** Size limits of the docked pane, in CSS pixels (concept §4). */
export const PANE_LIMITS = Object.freeze({
  /** The default width is this share of the space the chat and the pane share… */
  defaultRatio: 0.5,
  /** …clamped to this range. */
  defaultMin: 420,
  defaultMax: 960,
  /** The narrowest the user can drag the pane to. */
  min: 360,
  /** The widest, as a share of the shared space. */
  maxRatio: 0.7,
  /** The chat next to the pane never gets narrower than this. */
  chatMin: 360
});

/** One arrow key press moves the divider this far; with Shift, `PAGE_STEP`. */
export const KEY_STEP = 16;
export const PAGE_STEP = 64;

/** Where the user's own pane width is kept: a convenience, never required. */
export const WIDTH_STORAGE_KEY = 'ihub_workspace_pane_width';

/** Below this viewport width there is no split: the pane is a full-screen sheet. */
export const SPLIT_MIN_VIEWPORT = 1024;
/** Below this viewport width, opening the pane folds the left sidebar to its rail. */
export const SIDEBAR_COLLAPSE_BELOW = 1280;

/** The search parameters the pane lives in. `artifact`, `view` and `source` are from the concept. */
export const PANE_PARAMS = Object.freeze({
  artifact: 'artifact',
  source: 'source',
  file: 'file',
  files: 'files',
  view: 'view'
});

/** The tabs of the Files index. */
export const FILES_TABS = Object.freeze(['generated', 'uploaded', 'sources']);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * The range the pane's width may take in a row of `containerWidth` pixels: at
 * least `PANE_LIMITS.min`, at most 70% of the row and never so wide that the
 * chat drops below its own minimum.
 *
 * @param {number} containerWidth - Width of the row the chat and the pane share.
 * @returns {{ min: number, max: number }}
 */
export function paneWidthBounds(containerWidth) {
  const width = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 0;
  // The epsilon keeps 70% of 1400 at 980: in floating point it is 979.999….
  const max = Math.floor(
    Math.min(width * PANE_LIMITS.maxRatio, width - PANE_LIMITS.chatMin) + 1e-9
  );
  return { min: PANE_LIMITS.min, max: Math.max(PANE_LIMITS.min, max) };
}

/**
 * Clamp a width to what the row allows.
 *
 * @param {number} width
 * @param {number} containerWidth
 * @returns {number}
 */
export function clampPaneWidth(width, containerWidth) {
  const { min, max } = paneWidthBounds(containerWidth);
  const value = Number.isFinite(width) ? Math.round(width) : defaultPaneWidth(containerWidth);
  return clamp(value, min, max);
}

/**
 * The width the pane opens with: half the row, clamped to 420–960px, then to
 * what the row allows.
 *
 * @param {number} containerWidth
 * @returns {number}
 */
export function defaultPaneWidth(containerWidth) {
  const width = Number.isFinite(containerWidth) ? containerWidth : 0;
  const preferred = clamp(
    Math.round(width * PANE_LIMITS.defaultRatio),
    PANE_LIMITS.defaultMin,
    PANE_LIMITS.defaultMax
  );
  const { min, max } = paneWidthBounds(width);
  return clamp(preferred, min, max);
}

/**
 * The width after a key press on the divider, or null when the key does not
 * resize. The divider sits on the pane's left edge: ArrowLeft makes the pane
 * wider, ArrowRight narrower. Home and End snap to the limits.
 *
 * @param {string} key - `KeyboardEvent.key`
 * @param {number} width - The current width.
 * @param {number} containerWidth
 * @param {{ shiftKey?: boolean }} [modifiers]
 * @returns {number|null}
 */
export function widthAfterKey(key, width, containerWidth, { shiftKey = false } = {}) {
  const { min, max } = paneWidthBounds(containerWidth);
  const step = shiftKey ? PAGE_STEP : KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clamp(width + step, min, max);
    case 'ArrowRight':
    case 'ArrowDown':
      return clamp(width - step, min, max);
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return null;
  }
}

/**
 * The pane's width as a whole percentage of the row (for `aria-valuenow` and
 * the "Workspace 55 percent" announcement).
 *
 * @param {number} width
 * @param {number} containerWidth
 * @returns {number}
 */
export function widthPercent(width, containerWidth) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 0;
  return Math.round((width / containerWidth) * 100);
}

/**
 * The width the user dragged the pane to last time, or null. Browser storage
 * may be missing or throw (private window, blocked site data): that only loses
 * the convenience.
 *
 * @param {Storage|null} [storage]
 * @returns {number|null}
 */
export function readStoredWidth(storage = safeLocalStorage()) {
  try {
    const value = Number.parseInt(storage?.getItem(WIDTH_STORAGE_KEY) ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Remember the pane width; null forgets it (a double-click on the divider).
 *
 * @param {number|null} width
 * @param {Storage|null} [storage]
 */
export function writeStoredWidth(width, storage = safeLocalStorage()) {
  try {
    if (width == null) storage?.removeItem(WIDTH_STORAGE_KEY);
    else storage?.setItem(WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Storage is a convenience only.
  }
}

function safeLocalStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ kind: 'artifact'|'source'|'file', id: string }
 *   | { kind: 'files', tab: 'generated'|'uploaded'|'sources'|null }} PaneTarget
 */

/**
 * What the URL says the pane shows, and whether in full screen. One target at a
 * time: an artifact wins over a source, a source over an uploaded file, any
 * item over the Files index.
 *
 * @param {URLSearchParams} params
 * @returns {{ target: PaneTarget|null, full: boolean }}
 */
export function readPaneParams(params) {
  const get = name => {
    const value = params?.get?.(name);
    return typeof value === 'string' && value !== '' ? value : null;
  };
  let target = null;
  if (get(PANE_PARAMS.artifact)) target = { kind: 'artifact', id: get(PANE_PARAMS.artifact) };
  else if (get(PANE_PARAMS.source)) target = { kind: 'source', id: get(PANE_PARAMS.source) };
  else if (get(PANE_PARAMS.file)) target = { kind: 'file', id: get(PANE_PARAMS.file) };
  else if (params?.has?.(PANE_PARAMS.files)) {
    const tab = get(PANE_PARAMS.files);
    target = { kind: 'files', tab: FILES_TABS.includes(tab) ? tab : null };
  }
  return { target, full: Boolean(target) && get(PANE_PARAMS.view) === 'full' };
}

/**
 * The search parameters with the pane set to `target` (null: closed), keeping
 * every other parameter as it was.
 *
 * @param {URLSearchParams} params
 * @param {PaneTarget|null} target
 * @param {boolean} [full]
 * @returns {URLSearchParams}
 */
export function writePaneParams(params, target, full = false) {
  const next = new URLSearchParams(params);
  Object.values(PANE_PARAMS).forEach(name => next.delete(name));
  if (!target) return next;
  if (target.kind === 'files') next.set(PANE_PARAMS.files, target.tab || '');
  else next.set(PANE_PARAMS[target.kind], target.id);
  if (full) next.set(PANE_PARAMS.view, 'full');
  return next;
}

/** Whether two targets name the same thing. */
export function sameTarget(a, b) {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === 'files' ? (a.tab || null) === (b.tab || null) : a.id === b.id;
}

/**
 * How the pane is presented: docked next to the chat (`split`), or a
 * full-screen sheet over it. Embedded surfaces (the Outlook task pane, the
 * extension's side panel, an embed) and anything below 1024px never split.
 * 400% zoom shrinks the CSS viewport below 1024px, so it lands in the sheet too.
 *
 * @param {{ viewportWidth: number, surface?: string|null, forceSheet?: boolean }} context
 * @returns {'split'|'sheet'}
 */
export function presentationOf({ viewportWidth, surface = null, forceSheet = false }) {
  if (forceSheet || surface) return 'sheet';
  return Number.isFinite(viewportWidth) && viewportWidth >= SPLIT_MIN_VIEWPORT ? 'split' : 'sheet';
}

/**
 * Which layer Esc closes, innermost first: an open menu, the selection chip,
 * the expanded composer dock, full screen, then the pane itself. Null when Esc
 * does nothing here: it was pressed in the composer (which never closes the
 * pane) or outside the pane.
 *
 * @param {{ menuOpen?: boolean, chipOpen?: boolean, dockExpanded?: boolean, full?: boolean,
 *   inPane?: boolean, inComposer?: boolean }} state
 * @returns {'menu'|'chip'|'dock'|'full'|'pane'|null}
 */
export function escapeLayer({
  menuOpen = false,
  chipOpen = false,
  dockExpanded = false,
  full = false,
  inPane = false,
  inComposer = false
}) {
  if (inComposer || !inPane) return null;
  if (menuOpen) return 'menu';
  if (chipOpen) return 'chip';
  if (dockExpanded) return 'dock';
  if (full) return 'full';
  return 'pane';
}

/** Where the "auto-collapsed once in this tab" flag is kept. */
export const SIDEBAR_SESSION_KEY = 'ihub_workspace_sidebar_autocollapsed';

/**
 * Whether opening the pane should fold the left sidebar to its rail: only
 * below 1280px, only when it is expanded, only once per tab session, and never
 * after the user expanded it again by hand.
 *
 * @param {{ viewportWidth: number, collapsed: boolean, alreadyThisSession: boolean,
 *   userExpanded: boolean }} state
 * @returns {boolean}
 */
export function shouldAutoCollapseSidebar({
  viewportWidth,
  collapsed,
  alreadyThisSession,
  userExpanded
}) {
  if (collapsed || alreadyThisSession || userExpanded) return false;
  return Number.isFinite(viewportWidth) && viewportWidth < SIDEBAR_COLLAPSE_BELOW;
}

/** The event the pane sends the sidebar when it opens or closes. */
export const WORKSPACE_PANE_EVENT = 'ihub:workspace-pane';
