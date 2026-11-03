// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useViewerKey } from '../contexts/authContextValue';

/**
 * The caller's usage limits (`GET /api/usage/me`), shared by every component
 * that shows them — the usage page, the chat input warning, the model
 * picker — so they load once and refresh together.
 *
 * - Call `refreshMyUsage()` after anything that used tokens (the end of a
 *   chat run); mounted components update with the new numbers. A refresh
 *   while a request is still out asks again once it is back, so the answer
 *   includes the run that just ended.
 * - The numbers belong to one viewer: when someone else signs in (no page
 *   reload), they are dropped, along with any answer still on its way.
 * - When a budget's window resets, the numbers reload on their own, and a tab
 *   that comes back to the foreground reloads numbers that went stale.
 */

const MAX_AGE_MS = 30 * 1000;
/** A reload at a reset waits this long past it, for clocks that differ a little. */
const RESET_SLACK_MS = 2000;
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

let state = { data: null, error: null, loading: false, loadedAt: 0, viewer: undefined };
let inFlight = null;
let refetchAfter = false;
/** Bumped when the viewer changes: answers of an older generation are dropped. */
let generation = 0;
let language = 'en';
let resetTimer = null;
let visibilityBound = false;
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

/** The earliest moment one of the shown budgets resets, as epoch ms, or null. */
function nextResetAt(data) {
  const times = (data?.buckets || [])
    .map(b => Date.parse(b.resetAt))
    .filter(t => Number.isFinite(t) && t > Date.now());
  return times.length ? Math.min(...times) : null;
}

function scheduleResetReload(data) {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = null;
  const at = nextResetAt(data);
  if (!at) return;
  const delay = Math.min(at - Date.now() + RESET_SLACK_MS, MAX_TIMER_MS);
  resetTimer = setTimeout(() => {
    resetTimer = null;
    if (listeners.size > 0) void load();
  }, delay);
}

function load() {
  if (state.viewer === null || state.viewer === undefined) return Promise.resolve();
  if (inFlight) {
    refetchAfter = true;
    return inFlight;
  }
  const gen = generation;
  setState({ loading: true });
  // Loaded on first use: the chat input and model picker render this hook,
  // and they must not pull the API client in with them.
  inFlight = import('../../api/endpoints/usage')
    .then(({ fetchMyUsage }) => fetchMyUsage({ language }))
    .then(data => {
      if (gen !== generation) return;
      setState({ data, error: null, loading: false, loadedAt: Date.now() });
      scheduleResetReload(data);
    })
    .catch(error => {
      if (gen !== generation) return;
      setState({ error, loading: false, loadedAt: Date.now() });
    })
    .finally(() => {
      inFlight = null;
      if (refetchAfter && gen === generation) {
        refetchAfter = false;
        void load();
      }
    });
  return inFlight;
}

/** Switch to another viewer's numbers: forget the old ones and anything in flight. */
function setViewer(viewer) {
  if (viewer === state.viewer) return;
  generation += 1;
  inFlight = null;
  refetchAfter = false;
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = null;
  setState({ data: null, error: null, loading: false, loadedAt: 0, viewer });
}

function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || listeners.size === 0) return;
    if (Date.now() - state.loadedAt > MAX_AGE_MS) void load();
  });
}

/** Reload the usage now (e.g. after a chat answer). */
export function refreshMyUsage() {
  return load();
}

/** For tests: back to the state before anything loaded. */
export function resetMyUsageStore() {
  generation += 1;
  inFlight = null;
  refetchAfter = false;
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = null;
  state = { data: null, error: null, loading: false, loadedAt: 0, viewer: undefined };
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true]
 * @returns {{data: Object|null, error: Error|null, loading: boolean, refresh: Function,
 *   bucketsForModel: (modelId: string) => Array}}
 */
export default function useMyUsage({ enabled = true } = {}) {
  const { i18n } = useTranslation();
  const viewer = useViewerKey();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!enabled) return;
    language = i18n.language || 'en';
    setViewer(viewer);
    bindVisibility();
    if (!state.loadedAt || Date.now() - state.loadedAt > MAX_AGE_MS) void load();
  }, [enabled, i18n.language, viewer]);

  const refresh = useCallback(() => load(), []);

  // Numbers that belong to another viewer are never shown, even for the one
  // render before the effect above swaps them out.
  const own = snapshot.viewer === viewer ? snapshot : { data: null, error: null, loading: false };

  const bucketsForModel = useCallback(
    modelId =>
      (own.data?.buckets || []).filter(
        b => b.scope === 'allModels' || (b.scope === 'model' && b.modelId === modelId)
      ),
    [own.data]
  );

  return {
    data: own.data,
    error: own.error,
    loading: own.loading,
    refresh,
    bucketsForModel
  };
}

/** The bucket a model's next call would be refused by, or the closest one to its limit. */
export function mostUrgentBucket(buckets) {
  let worst = null;
  for (const b of buckets || []) {
    if (b.exceeded) return b;
    if (!worst || b.percent > worst.percent) worst = b;
  }
  return worst;
}
