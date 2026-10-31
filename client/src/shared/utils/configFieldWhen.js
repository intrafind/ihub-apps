// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether an install field of an integration definition applies, given the
 * other values and the sign-in mode (`when` clause); the server's
 * `fieldApplies` reads it the same way.
 *
 * @param {Object} field - ConfigField
 * @param {Object} [values]
 * @param {string} [authMode]
 * @returns {boolean}
 */
export function fieldApplies(field, values = {}, authMode = 'none') {
  const when = field?.when;
  if (!when) return true;
  if (when.authMode && !when.authMode.includes(authMode || 'none')) return false;
  if (when.field) {
    const actual = values[when.field];
    if (when.equals !== undefined && actual !== when.equals) return false;
    if (when.in && !when.in.includes(actual)) return false;
  }
  return true;
}

/**
 * The sensitive install field a sign-in mode stores in the credential store,
 * or null (mirrors the server's `secretFieldForMode`).
 *
 * @param {Object} definition - definition detail view
 * @param {string} mode
 * @returns {Object|null} the ConfigField
 */
export function secretFieldForMode(definition, mode) {
  const install = definition?.install || [];
  const auth = definition?.auth || {};
  let key = null;
  if (mode === 'service-account') key = auth.serviceAccount?.field;
  else if (mode === 'oauth-client') {
    key =
      auth.oauthClient?.field || install.find(f => f.key === 'clientSecret' && f.sensitive)?.key;
  } else if (mode === 'oauth-user') key = auth.oauthUser?.field;
  return key ? install.find(f => f.key === key) || null : null;
}
