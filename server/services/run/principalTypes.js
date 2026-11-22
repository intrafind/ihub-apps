// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The kinds of principal a run acts as, without the resolver's dependencies:
 * the run context and the tool runner read them on every run.
 *
 * @module services/run/principalTypes
 */

/** The kinds of principal a run can act as. */
export const PRINCIPAL_TYPES = Object.freeze(['user', 'client', 'service']);

/** The auth mode a service account's principal carries. */
export const SERVICE_AUTH_MODE = 'service';

/**
 * The kind of principal a resolved principal is.
 *
 * `client` is a program: an OAuth client (client credentials, a static key), a
 * personal API key, or a third-party app acting with a user's token
 * (`oauth_*` auth modes). Exactly the principals `isUnattendedCaller` in
 * `utils/toolApproval.js` called unattended before the run context existed.
 *
 * @param {Object|null|undefined} principal
 * @returns {'user'|'client'|'service'}
 */
export function principalTypeOf(principal) {
  if (!principal) return 'user';
  if (principal.authMode === SERVICE_AUTH_MODE) return 'service';
  if (
    principal.isOAuthClient === true ||
    principal.isPersonalApiKey === true ||
    (typeof principal.authMode === 'string' && principal.authMode.startsWith('oauth_'))
  ) {
    return 'client';
  }
  return 'user';
}
