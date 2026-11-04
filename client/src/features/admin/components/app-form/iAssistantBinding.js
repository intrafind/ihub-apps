// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How the iAssistant panel maps its choices onto the `iassistant` binding
 * (`app.integrations.iassistant`) the server reads
 * (`server/services/integrations/scopes/iAssistantScopes.js`).
 *
 * "Users may switch iAssistant" has three modes:
 *   - `menu`   – the picker is in the menu (`scopePicker` absent);
 *   - `inline` – the picker is in the chat input (`scopePicker: 'inline'`);
 *   - `fixed`  – no picker; the app's own setting is used
 *                (`scopePicker: 'hidden'` + `pinnedScope`).
 * The default scope is never written: the server's default already is the
 * app's iAssistant / all / configured.
 */

export const CONFIGURED_SCOPE = 'configured';
export const ALL_SEARCH_PROFILES_SCOPE = 'all';
export const ASSISTANT_SCOPE_PREFIX = 'assistant:';

/**
 * The scope a fixed app uses, from the app's `iassistant` settings:
 * its iAssistant, else every search profile, else the configured profiles.
 * @param {Object} [iassistant] - `app.iassistant`
 * @returns {string}
 */
export function derivePinnedScope(iassistant) {
  const assistantId =
    typeof iassistant?.assistantId === 'string' ? iassistant.assistantId.trim() : '';
  if (assistantId) return `${ASSISTANT_SCOPE_PREFIX}${assistantId}`;
  if (iassistant?.allSearchProfiles === true) return ALL_SEARCH_PROFILES_SCOPE;
  return CONFIGURED_SCOPE;
}

/**
 * The mode a binding is in.
 * @param {Object} [binding]
 * @returns {'menu'|'inline'|'fixed'}
 */
export function pickerModeOf(binding) {
  if (binding?.scopePicker === 'hidden') return 'fixed';
  return binding?.scopePicker === 'inline' ? 'inline' : 'menu';
}

function without(binding, ...keys) {
  const copy = { ...binding };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * The binding switched to a mode.
 * @param {Object} [binding]
 * @param {'menu'|'inline'|'fixed'} mode
 * @param {Object} [iassistant] - `app.iassistant`
 * @returns {Object}
 */
export function applyPickerMode(binding, mode, iassistant) {
  const rest = without(binding, 'scopePicker', 'pinnedScope', 'defaultScope');
  if (mode === 'fixed') {
    return { ...rest, scopePicker: 'hidden', pinnedScope: derivePinnedScope(iassistant) };
  }
  return mode === 'inline' ? { ...rest, scopePicker: 'inline' } : rest;
}

/**
 * The binding with a fixed pinned scope re-derived from the panel, so it never
 * drifts when the iAssistant or "all search profiles" change. The same object
 * comes back when nothing changes or the binding is not fixed.
 * @param {Object} [binding]
 * @param {Object} [iassistant] - `app.iassistant` after the change
 * @returns {Object|undefined}
 */
export function syncPinnedScope(binding, iassistant) {
  if (!binding || pickerModeOf(binding) !== 'fixed') return binding;
  const pinned = derivePinnedScope(iassistant);
  return binding.pinnedScope === pinned ? binding : { ...binding, pinnedScope: pinned };
}

/**
 * Scope settings the panel does not write (the server still honours them): a `defaultScope`, or a
 * `pinnedScope` that is not the one the panel derives (hand-edited JSON).
 * @param {Object} [binding]
 * @param {Object} [iassistant] - `app.iassistant`
 * @returns {{ key: 'defaultScope'|'pinnedScope', value: string }[]}
 */
export function legacyScopeSettings(binding, iassistant) {
  const found = [];
  if (binding?.defaultScope) found.push({ key: 'defaultScope', value: binding.defaultScope });
  const pinned = binding?.pinnedScope;
  if (pinned && (pickerModeOf(binding) !== 'fixed' || pinned !== derivePinnedScope(iassistant))) {
    found.push({ key: 'pinnedScope', value: pinned });
  }
  return found;
}

/**
 * The binding without the scope settings the panel does not write: `defaultScope` goes, and a
 * `pinnedScope` is removed, or re-derived while the binding is fixed.
 * @param {Object} [binding]
 * @param {Object} [iassistant] - `app.iassistant`
 * @returns {Object}
 */
export function resetLegacyScopeSettings(binding, iassistant) {
  const rest = without(binding, 'defaultScope', 'pinnedScope');
  return pickerModeOf(binding) === 'fixed'
    ? { ...rest, pinnedScope: derivePinnedScope(iassistant) }
    : rest;
}

/**
 * The binding with "also offer all my search profiles" set (`allowAllSearchProfiles`).
 * @param {Object} [binding]
 * @param {boolean} allow
 * @returns {Object}
 */
export function setAllowAllSearchProfiles(binding, allow) {
  return allow
    ? { ...binding, allowAllSearchProfiles: true }
    : without(binding, 'allowAllSearchProfiles');
}
