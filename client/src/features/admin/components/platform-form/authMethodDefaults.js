// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The settings a sign-in method starts with when `platform.json` has no block
 * for it yet. They mirror the defaults of `server/validators/platformConfigSchema.js`.
 *
 * The server stores each auth block as posted and its runtime readers do not
 * apply the schema defaults, so a block posted as `{ enabled: true }` alone
 * loses them.
 *
 * Used only when the admin turns a method on whose block is missing, never at
 * load time, so nothing is posted that the admin did not ask for.
 */
export const AUTH_METHOD_DEFAULTS = Object.freeze({
  anonymousAuth: { defaultGroups: ['anonymous'] },
  proxyAuth: {
    allowSelfSignup: false,
    userHeader: 'X-Forwarded-User',
    groupsHeader: 'X-Forwarded-Groups',
    trustedProxies: ['loopback'],
    jwtProviders: []
  },
  localAuth: { sessionTimeoutMinutes: 480, showDemoAccounts: false },
  oidcAuth: { allowSelfSignup: false, providers: [] },
  ldapAuth: { allowSelfSignup: true, providers: [] },
  ntlmAuth: {
    debug: false,
    defaultGroups: [],
    sessionTimeoutMinutes: 480
  }
});

/**
 * Turn a sign-in method on or off in a platform configuration.
 *
 * An existing block keeps all its settings and only `enabled` changes. A block
 * that does not exist yet is created from {@link AUTH_METHOD_DEFAULTS} when the
 * method is turned on.
 *
 * @param {object} config - The platform configuration being edited
 * @param {string} method - The block key, e.g. `'ntlmAuth'`
 * @param {boolean} enabled - Whether the method is on
 * @returns {object} A new configuration; `config` is not changed
 *
 * @example
 * withAuthMethodEnabled({}, 'ntlmAuth', true)
 * // { ntlmAuth: { debug: false, defaultGroups: [], sessionTimeoutMinutes: 480,
 * //               enabled: true } }
 */
export function withAuthMethodEnabled(config, method, enabled) {
  const current = config?.[method];
  let base = {};
  if (current && typeof current === 'object') base = current;
  else if (enabled) base = structuredClone(AUTH_METHOD_DEFAULTS[method] ?? {});
  return { ...config, [method]: { ...base, enabled } };
}
