// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How the iFinder panel maps its search profile choices onto the `ifinder`
 * binding (`app.integrations.ifinder`) the server reads
 * (`server/services/integrations/scopes/iFinderScopes.js`).
 *
 *   - "Start in" is `defaultScope`; none means the installation's default.
 *   - "Users may switch search profile": `menu` (`scopePicker` absent),
 *     `inline` (`scopePicker: 'inline'`) or `fixed` (`scopePicker: 'hidden'`
 *     plus `pinnedScope`, the start profile or the installation's default).
 */

import { pickerModeOf } from './iAssistantBinding';

export { pickerModeOf };

function without(binding, ...keys) {
  const copy = { ...binding };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * The profile a fixed app searches in: the start profile, else the
 * installation's default (undefined while that is not known).
 * @param {Object} [binding]
 * @param {string} [installationDefault]
 * @returns {string|undefined}
 */
export function fixedProfileOf(binding, installationDefault) {
  return binding?.defaultScope || installationDefault || undefined;
}

function withPinned(binding, installationDefault) {
  const pinned = fixedProfileOf(binding, installationDefault);
  return pinned ? { ...binding, pinnedScope: pinned } : without(binding, 'pinnedScope');
}

/**
 * The binding switched to a mode.
 * @param {Object} [binding]
 * @param {'menu'|'inline'|'fixed'} mode
 * @param {string} [installationDefault] - the installation's default search profile, when known
 * @returns {Object}
 */
export function applyIFinderPickerMode(binding, mode, installationDefault) {
  const rest = without(binding, 'scopePicker', 'pinnedScope');
  if (mode === 'fixed') return withPinned({ ...rest, scopePicker: 'hidden' }, installationDefault);
  return mode === 'inline' ? { ...rest, scopePicker: 'inline' } : rest;
}

/**
 * The binding with a start profile ('' for the installation's default); a
 * fixed binding follows it.
 * @param {Object} [binding]
 * @param {string} profileId
 * @param {string} [installationDefault]
 * @returns {Object}
 */
export function setStartProfile(binding, profileId, installationDefault) {
  const value = typeof profileId === 'string' ? profileId.trim() : '';
  const next = value ? { ...binding, defaultScope: value } : without(binding, 'defaultScope');
  return pickerModeOf(next) === 'fixed' ? withPinned(next, installationDefault) : next;
}
