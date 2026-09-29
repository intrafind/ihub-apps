/**
 * Which apps the Outlook add-in offers — the `allowedApps` list of the add-in's
 * OAuth client.
 *
 * The restriction lives on the client rather than in `officeIntegration`
 * because that is where the server enforces it: an authorization-code token's
 * permissions are the user's group permissions intersected with the issuing
 * client's allow-list (`applyOAuthClientFilter` in utils/authorization.js), read
 * fresh on every request. This module only translates between that list and the
 * two states the admin page offers.
 *
 * - `all`     — no client-level restriction. Stored as `['*']`; an empty list
 *               means the same for a user-delegated token, so both read as `all`.
 * - `limited` — only the listed apps, and only where the user's groups allow
 *               them too. Being listed never grants access.
 *
 * Two readers, two strictness levels, as in officeStartPage.js: `describe`
 * accepts whatever the file holds, `validate` rejects a bad save with a reason.
 */

import { APP_ID_PATTERN, APP_ID_MAX_LENGTH } from '../../shared/validationPatterns.js';

/** The wildcard the OAuth client edit page also uses for "no restriction". */
export const ALL_APPS = '*';

/** Far more than any deployment ships; a guard against a runaway request body. */
export const MAX_OFFICE_ALLOWED_APPS = 500;

const isAppId = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= APP_ID_MAX_LENGTH &&
  APP_ID_PATTERN.test(value);

/**
 * The add-in's app access as the admin page shows it.
 *
 * @param {unknown} allowedApps - `allowedApps` of the OAuth client as stored.
 * @returns {{ mode: 'all' | 'limited', appIds: string[] }} `appIds` is empty in
 *   `all` mode. Non-string entries are dropped so a hand-edited file cannot
 *   break the picker; ids of apps that no longer exist are kept, because they
 *   are still part of the list and the admin has to be able to see and remove
 *   them.
 */
export function describeOfficeAppAccess(allowedApps) {
  if (!Array.isArray(allowedApps) || allowedApps.length === 0 || allowedApps.includes(ALL_APPS)) {
    return { mode: 'all', appIds: [] };
  }
  // Non-empty without the wildcard restricts, even if nothing in it matches an
  // app: the server intersects with the list as stored, so it allows nothing.
  return {
    mode: 'limited',
    appIds: [...new Set(allowedApps.filter(id => typeof id === 'string' && id.length > 0))]
  };
}

/**
 * Check an allow-list an admin is saving.
 *
 * An empty list is refused rather than repaired: for this client it would mean
 * "no restriction", which is the opposite of what someone who emptied a
 * "limited" list intends. The admin page sends `['*']` for "all apps".
 *
 * @param {unknown} value - The `allowedApps` field of the request body.
 * @returns {{ value: string[] } | { error: string }} The list to store — `['*']`
 *   whenever the wildcard is present — or the reason the input was rejected.
 */
export function validateOfficeAllowedApps(value) {
  if (!Array.isArray(value)) {
    return { error: 'allowedApps must be an array of app ids, or ["*"] for all apps' };
  }
  if (value.length === 0) {
    return {
      error:
        'allowedApps must not be empty: an empty list means no restriction. Send ["*"] to allow all apps, or list the apps to allow'
    };
  }
  if (value.length > MAX_OFFICE_ALLOWED_APPS) {
    return { error: `allowedApps must not hold more than ${MAX_OFFICE_ALLOWED_APPS} ids` };
  }
  if (value.includes(ALL_APPS)) return { value: [ALL_APPS] };
  if (!value.every(isAppId)) {
    return { error: 'allowedApps must only contain valid app ids' };
  }
  return { value: [...new Set(value)] };
}
