// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The caller's view of one integration (`GET /api/integrations/:id`) for the
 * Connect cards, shared by every card on the page for {@link INFO_TTL_MS}: a
 * chat with many cards makes one request per integration.
 *
 * @module features/integrations/connect/integrationInfo
 */
import { fetchUserIntegration, requestConnectUrl } from '../../../api/userIntegrationsApi';
import { currentReturnUrl } from './connectResult';

/** How long one answer is reused by the cards of a page. */
export const INFO_TTL_MS = 30 * 1000;

/** @type {Map<string, {at: number, promise: Promise<Object|null>}>} */
const cache = new Map();

/**
 * The integration as the user sees it, or null when unknown or not allowed.
 * Resolves to null when it cannot be loaded (the card then works from the
 * prompt alone).
 *
 * @param {string} id - Installation id
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - Ignore a cached answer
 * @returns {Promise<Object|null>}
 */
export function loadIntegrationInfo(id, { force = false } = {}) {
  const now = Date.now();
  const hit = cache.get(id);
  if (!force && hit && now - hit.at < INFO_TTL_MS) return hit.promise;
  const promise = fetchUserIntegration(id).catch(() => null);
  cache.set(id, { at: now, promise });
  return promise;
}

/** Forget cached answers (after a sign-in or disconnect). */
export function invalidateIntegrationInfo(id) {
  if (id) cache.delete(id);
  else cache.clear();
}

/**
 * Start the sign-in to an integration and leave the page for the vendor's
 * consent; the browser comes back to `returnUrl` (default: this page).
 *
 * @param {string} id - Installation id
 * @param {Object} [options]
 * @param {boolean} [options.reconnect=false]
 * @param {string[]} [options.scopes] - Reconnect: the permissions to add
 * @param {string} [options.returnUrl]
 * @param {(url: string) => void} [options.navigate] - Test seam; defaults to a full-page navigation
 * @returns {Promise<void>}
 */
export async function startIntegrationConnect(
  id,
  { reconnect = false, scopes, returnUrl = currentReturnUrl(), navigate } = {}
) {
  const url = await requestConnectUrl(id, { reconnect, scopes, returnUrl });
  invalidateIntegrationInfo(id);
  if (typeof navigate === 'function') navigate(url);
  else window.location.assign(url);
}

/**
 * The enabled actions of an integration grouped by side effect, for the
 * "Permissions" line of a card: `[{ effect: 'read', titles: [...] }, …]`.
 *
 * @param {Array<{title: string, sideEffect: string}>} actions
 * @returns {Array<{effect: string, titles: string[]}>}
 */
export function permissionsByEffect(actions) {
  const order = ['read', 'write', 'destructive', 'unknown'];
  const groups = new Map();
  for (const action of Array.isArray(actions) ? actions : []) {
    const effect = order.includes(action?.sideEffect) ? action.sideEffect : 'unknown';
    const title = typeof action?.title === 'string' && action.title ? action.title : action?.name;
    if (!title) continue;
    const list = groups.get(effect) || [];
    if (!list.includes(title)) list.push(title);
    groups.set(effect, list);
  }
  return order
    .filter(effect => groups.has(effect))
    .map(effect => ({
      effect,
      titles: groups.get(effect)
    }));
}

/** Test seam. */
export function resetIntegrationInfoForTests() {
  cache.clear();
}
