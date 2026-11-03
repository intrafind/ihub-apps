// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { fetchIntegrationPreferences, saveIntegrationPreferences } from '../../../api';
import { loadAppSettings, saveAppSettings } from '../../../utils/appSettings';

/** The keys of the integration state the browser used to keep per app. */
const BROWSER_KEYS = ['enabledTools', 'websearchEnabled', 'integrationScopes'];

/**
 * What this browser kept for the app before the default moved to the server,
 * or null when it kept nothing.
 *
 * @param {string} appId
 * @returns {Object|null}
 */
export function browserIntegrationSettings(appId) {
  const saved = loadAppSettings(appId);
  if (!saved || typeof saved !== 'object') return null;
  const out = {};
  if (Array.isArray(saved.enabledTools)) out.enabledTools = saved.enabledTools;
  if (typeof saved.websearchEnabled === 'boolean') out.websearchEnabled = saved.websearchEnabled;
  if (
    saved.integrationScopes &&
    typeof saved.integrationScopes === 'object' &&
    !Array.isArray(saved.integrationScopes)
  ) {
    out.integrationScopes = saved.integrationScopes;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Remove the integration state from what this browser keeps for the app. */
export function forgetBrowserIntegrationSettings(appId) {
  const saved = loadAppSettings(appId);
  if (!saved || typeof saved !== 'object') return;
  if (!BROWSER_KEYS.some(key => Object.hasOwn(saved, key))) return;
  const rest = { ...saved };
  for (const key of BROWSER_KEYS) delete rest[key];
  saveAppSettings(appId, rest);
}

/**
 * Load the user's default for an app, importing what this browser kept once:
 * when the server has no default yet and the browser has one, it is saved
 * with `import` (written only if still absent), then removed from the browser.
 *
 * @param {string} appId
 * @param {Object|null} [kept] - What the browser kept, read before anything
 *   rewrote it (`useAppSettings` rewrites the app's settings on mount)
 * @returns {Promise<Object|null>} `{ stored, available, preferences }`, or null
 *   when the server could not answer
 */
export async function loadIntegrationDefaults(appId, kept = browserIntegrationSettings(appId)) {
  const answer = await fetchIntegrationPreferences(appId);
  if (!answer || typeof answer !== 'object') return null;
  if (answer.stored || !answer.available) {
    if (answer.stored) forgetBrowserIntegrationSettings(appId);
    return answer;
  }
  if (!kept) return answer;
  try {
    const imported = await saveIntegrationPreferences(appId, kept, { importOnce: true });
    forgetBrowserIntegrationSettings(appId);
    return imported || answer;
  } catch {
    // Not imported: the server's answer stands, and the next load tries again.
    return answer;
  }
}

/**
 * The default a new chat of an app starts with, from the server (#2923).
 *
 * `preferences` is null while loading and when the server cannot answer (a
 * mocked or offline API, an anonymous guest whose request failed); the caller
 * then falls back to the app's own defaults.
 *
 * @param {string|null|undefined} appId
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] - False skips the request (the
 *   admin's isolated test panel starts from the app's own defaults)
 * @returns {{loading: boolean, preferences: (Object|null), stored: boolean}}
 */
export default function useIntegrationDefaults(appId, { enabled = true } = {}) {
  const [answer, setAnswer] = useState({ appId: null, value: null });
  const active = Boolean(appId) && enabled;

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    // Read now, in the same commit, before the settings hook's save effect
    // rewrites what the browser kept for the app.
    const kept = browserIntegrationSettings(appId);
    // Inside the chain, so any failure (also a missing function in a test's
    // API mock) lands in the catch.
    Promise.resolve()
      .then(() => loadIntegrationDefaults(appId, kept))
      .then(value => {
        if (!cancelled) setAnswer({ appId, value });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ appId, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [appId, active]);

  if (!active) return { loading: false, preferences: null, stored: false };
  const settled = answer.appId === appId;
  return {
    loading: !settled,
    preferences: settled ? answer.value?.preferences || null : null,
    stored: settled && answer.value?.stored === true
  };
}
