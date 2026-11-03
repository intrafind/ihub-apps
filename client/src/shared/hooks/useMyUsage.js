// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The caller's usage limits (`GET /api/usage/me`), shared by every component
 * that shows them — the usage page, the chat input warning, the model
 * picker — so they load once and refresh together.
 *
 * Call `refreshMyUsage()` after anything that used tokens (the end of a chat
 * run); mounted components update with the new numbers.
 */

const MAX_AGE_MS = 30 * 1000;

let state = { data: null, error: null, loading: false, loadedAt: 0 };
let inFlight = null;
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

async function load(language) {
  if (inFlight) return inFlight;
  setState({ loading: true });
  // Loaded on first use: the chat input and model picker render this hook,
  // and they must not pull the API client in with them.
  inFlight = import('../../api/endpoints/usage')
    .then(({ fetchMyUsage }) => fetchMyUsage({ language }))
    .then(data => setState({ data, error: null, loading: false, loadedAt: Date.now() }))
    .catch(error => setState({ error, loading: false, loadedAt: Date.now() }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Reload the usage now (e.g. after a chat answer). */
export function refreshMyUsage(language) {
  return load(language);
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
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!enabled) return;
    if (!state.loadedAt || Date.now() - state.loadedAt > MAX_AGE_MS) void load(i18n.language);
  }, [enabled, i18n.language]);

  const refresh = useCallback(() => load(i18n.language), [i18n.language]);

  const bucketsForModel = useCallback(
    modelId =>
      (snapshot.data?.buckets || []).filter(
        b => b.scope === 'allModels' || (b.scope === 'model' && b.modelId === modelId)
      ),
    [snapshot.data]
  );

  return {
    data: snapshot.data,
    error: snapshot.error,
    loading: snapshot.loading,
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
