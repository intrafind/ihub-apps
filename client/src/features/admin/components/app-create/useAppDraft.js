// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The state of the "New app" page as a hook: the reducer of
 * `draftState.js` with its actions, kept in the tab's storage so that a
 * reload brings the author's work back.
 *
 * @module features/admin/components/app-create/useAppDraft
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  draftReducer,
  initialDraftState,
  parseDraftState,
  serializeDraftState
} from './draftState.js';

/** Where the draft is kept for the tab, unless the caller names another place. */
export const APP_DRAFT_STORAGE_KEY = 'ihub.appCreate.draft';

/** The tab's storage, or null where the browser refuses it. */
function tabStorage() {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readStored(storageKey) {
  try {
    return parseDraftState(tabStorage()?.getItem(storageKey));
  } catch {
    return null;
  }
}

function writeStored(storageKey, state) {
  try {
    const storage = tabStorage();
    if (!storage) return;
    const text = state ? serializeDraftState(state) : null;
    if (text === null) storage.removeItem(storageKey);
    else storage.setItem(storageKey, text);
  } catch {
    // A full or blocked storage only costs the restore after a reload.
  }
}

/**
 * The page's state with its actions. The state is kept in the tab's storage
 * and comes back after a reload, with `restored: true`.
 *
 * @param {object} [options]
 * @param {string} [options.storageKey] - Where the draft is kept for the tab.
 * @param {boolean} [options.restore=true] - Start from what the tab kept.
 *   `false` for a page opened to copy a named app, which starts from that app.
 * @returns {{
 *   state: object,
 *   begin: (start: object) => void,
 *   describe: (description: string) => void,
 *   editText: (field: string, value: string, id?: string) => void,
 *   editMeta: (field: string, value: string) => void,
 *   editId: (value: string) => void,
 *   deriveId: (value: string) => void,
 *   editLink: (change: { url?: string, mode?: string }) => void,
 *   setExtras: (extras: object) => void,
 *   back: () => void,
 *   reset: () => void,
 *   forget: () => void
 * }} `forget()` removes what the tab kept and keeps nothing from then on. It
 *   is for the moment the page is left for good (the app was created, or the
 *   author discarded it): the state stays as it is until the page is gone.
 */
export function useAppDraft({ storageKey = APP_DRAFT_STORAGE_KEY, restore = true } = {}) {
  const [state, dispatch] = useReducer(draftReducer, undefined, () =>
    restore ? readStored(storageKey) || initialDraftState() : initialDraftState()
  );

  // Set by forget(): the page is being left, and nothing is kept any more.
  const forgottenRef = useRef(false);

  useEffect(() => {
    if (!forgottenRef.current) writeStored(storageKey, state);
  }, [storageKey, state]);

  const begin = useCallback(start => dispatch({ type: 'begin', ...start }), []);
  const describe = useCallback(description => dispatch({ type: 'describe', description }), []);
  const editText = useCallback(
    (field, value, id) => dispatch({ type: 'text', field, value, id }),
    []
  );
  const editMeta = useCallback((field, value) => dispatch({ type: 'meta', field, value }), []);
  const editId = useCallback(value => dispatch({ type: 'id', value, touched: true }), []);
  const deriveId = useCallback(value => dispatch({ type: 'id', value, touched: false }), []);
  const editLink = useCallback(change => dispatch({ type: 'link', ...change }), []);
  const setExtras = useCallback(extras => dispatch({ type: 'extras', extras }), []);
  const back = useCallback(() => dispatch({ type: 'back' }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const forget = useCallback(() => {
    forgottenRef.current = true;
    writeStored(storageKey, null);
  }, [storageKey]);

  return useMemo(
    () => ({
      state,
      begin,
      describe,
      editText,
      editMeta,
      editId,
      deriveId,
      editLink,
      setExtras,
      back,
      reset,
      forget
    }),
    [
      state,
      begin,
      describe,
      editText,
      editMeta,
      editId,
      deriveId,
      editLink,
      setExtras,
      back,
      reset,
      forget
    ]
  );
}

export default useAppDraft;
