// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Per-user voice mode preferences, kept in `localStorage` like other UI
 * preferences. Every read and write is wrapped: storage can be blocked
 * (private window, site data cleared) and the mode must work without it.
 *
 * Only what the user changed is stored, so a platform or app default that
 * changes later still reaches everyone who never touched the setting:
 * `{ listeningStyle?, bargeIn?, captions? }`.
 */
const STORAGE_KEY = 'ihub.voiceMode.prefs';

/** @returns {{ listeningStyle?: string, bargeIn?: boolean, captions?: boolean }} */
export function loadVoiceModePrefs() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const prefs = {};
    if (parsed.listeningStyle === 'hands-free' || parsed.listeningStyle === 'push-to-talk') {
      prefs.listeningStyle = parsed.listeningStyle;
    }
    if (typeof parsed.bargeIn === 'boolean') prefs.bargeIn = parsed.bargeIn;
    if (typeof parsed.captions === 'boolean') prefs.captions = parsed.captions;
    return prefs;
  } catch {
    return {};
  }
}

/** Merge `patch` into the stored preferences. */
export function saveVoiceModePrefs(patch) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadVoiceModePrefs(), ...patch }));
  } catch {
    // Storage is blocked: the choice lasts for this session only.
  }
}
