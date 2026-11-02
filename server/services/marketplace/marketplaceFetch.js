// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Outbound fetches of the marketplace: which hosts a registry may make the
 * server fetch from, and which of them receive the registry's credentials.
 *
 * Every marketplace fetch — a registry's catalog, an item's manifest
 * (`integration.json`, `SKILL.md`, an app's JSON …), the companion files of a
 * skill or an integration, the GitHub tree that lists them — goes through
 * {@link marketplaceFetch}. Before each request, and again for every redirect
 * hop, {@link assertAllowedMarketplaceTarget} decides where it may go:
 *
 * - **The registry's own host** — the host of the catalog URL the admin
 *   configured — is admitted as it is, private address or not. A company
 *   marketplace behind the firewall is supported, and the admin chose that
 *   host. An item's manifest and its companions are on the registry's own host
 *   only when their host *is* that host.
 * - **A GitHub registry** (catalog on `raw.githubusercontent.com`,
 *   `api.github.com` or `github.com`) also admits the GitHub pair it is read
 *   through: `api.github.com` and `raw.githubusercontent.com`.
 * - **Every other host** must be a public address (`assertPublicTarget`: no
 *   loopback, link-local, private ranges or cloud metadata endpoints), and the
 *   connection is pinned to the addresses that passed, so DNS cannot be
 *   re-pointed between the check and the connect.
 *
 * Redirects are never followed by the HTTP client: each hop comes back here,
 * is checked by the same rules, and at most {@link MAX_MARKETPLACE_REDIRECTS}
 * hops are followed. So a catalog — which the publisher of a public registry
 * controls — cannot steer the server to an internal address, neither directly
 * nor through a redirect, while a private registry keeps working.
 *
 * Credentials are a separate, narrower question, answered by
 * {@link sharesCredentialScope}: a hop that leaves the scope of the URL the
 * caller sent the credentials to is sent without them.
 *
 * @module services/marketplace/marketplaceFetch
 */

import { throttledFetch } from '../../requestThrottler.js';
import { assertPublicTarget, createPinnedLookup } from '../../utils/ssrfGuard.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'MarketplaceFetch';

/** Redirect hops one marketplace fetch follows at most. */
export const MAX_MARKETPLACE_REDIRECTS = 5;

/** `code` of the error thrown when a target host is refused. */
export const MARKETPLACE_TARGET_BLOCKED = 'MARKETPLACE_TARGET_BLOCKED';

/** Hosts that share one GitHub token: the Contents API, the raw host and github.com. */
export const GITHUB_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'github.com']);

/** The hosts a GitHub registry's items, companions and file trees are read from. */
const GITHUB_FETCH_HOSTS = ['api.github.com', 'raw.githubusercontent.com'];

/** Statuses that carry a `Location` to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A marketplace fetch the guard refused. The message names the host so the
 * admin sees which address the catalog pointed at.
 */
export class MarketplaceTargetError extends Error {
  /**
   * @param {string} message - What was refused and why
   * @param {string|null} [host] - The refused host (`hostname[:port]`), when the URL had one
   */
  constructor(message, host = null) {
    super(message);
    this.name = 'MarketplaceTargetError';
    this.code = MARKETPLACE_TARGET_BLOCKED;
    this.host = host;
  }
}

/**
 * The public-address check applied to every host that is not the registry's
 * own. A property of an object (not a bare import) so a test can serve a
 * "public" host from loopback; production always uses `assertPublicTarget`.
 *
 * @type {{ checkTarget: (url: URL) => Promise<{ ok: boolean, reason?: string, addresses?: string[] }> }}
 */
export const marketplaceTargetGuard = {
  checkTarget: url => assertPublicTarget(url)
};

/**
 * Parse an http(s) URL; anything else (not a URL, another scheme) is null.
 *
 * @param {string|URL} value
 * @returns {URL|null}
 */
function parseHttpUrl(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/**
 * The hosts a registry admits without the public-address check: the host of
 * its catalog URL and, for a GitHub registry, the GitHub pair. Hosts are
 * compared as `URL.host` — hostname plus a non-default port — so another port
 * on the registry's machine is another host. A registry without a valid
 * `source` admits nothing.
 *
 * @param {{ source?: string }|null|undefined} registry - Registry config
 * @returns {Set<string>} Admitted `URL.host` values
 *
 * @example
 * registryOwnHosts({ source: 'https://raw.githubusercontent.com/org/repo/main/catalog.json' });
 * // → Set { 'raw.githubusercontent.com', 'api.github.com' }
 */
export function registryOwnHosts(registry) {
  const hosts = new Set();
  const source = typeof registry?.source === 'string' ? parseHttpUrl(registry.source) : null;
  if (!source) return hosts;
  hosts.add(source.host);
  if (GITHUB_HOSTS.has(source.hostname)) {
    for (const host of GITHUB_FETCH_HOSTS) hosts.add(host);
  }
  return hosts;
}

/**
 * Decide whether the server may fetch `url` for `registry`: the registry's
 * own hosts are admitted as they are (see {@link registryOwnHosts}); any other
 * host must pass the public-address check, whose validated addresses the
 * caller pins the connection to.
 *
 * @param {string|URL} url - The URL about to be fetched (one redirect hop)
 * @param {{ id?: string, source?: string }|null|undefined} registry - Registry config
 * @returns {Promise<{ target: URL, admittedAs: 'registry'|'public', addresses: string[]|null }>}
 *   The parsed target, why it was admitted, and the addresses to pin to (null
 *   for the registry's own hosts, which are connected to as usual)
 * @throws {MarketplaceTargetError} For a non-http(s) URL, or a host that is
 *   neither the registry's own nor a public address
 */
export async function assertAllowedMarketplaceTarget(url, registry) {
  const target = parseHttpUrl(url);
  if (!target) {
    throw new MarketplaceTargetError(
      'Marketplace fetch refused: only http and https URLs can be fetched'
    );
  }
  if (registryOwnHosts(registry).has(target.host)) {
    return { target, admittedAs: 'registry', addresses: null };
  }

  const check = await marketplaceTargetGuard.checkTarget(target);
  if (!check?.ok) {
    const reason = check?.reason || 'not a public address';
    logger.warn('Marketplace fetch refused: target is not public', {
      component: COMPONENT,
      registryId: registry?.id,
      host: target.host,
      reason
    });
    throw new MarketplaceTargetError(
      `Marketplace fetch from '${target.host}' refused: the host is not the registry's own ` +
        `host and not a public address (${reason})`,
      target.host
    );
  }
  const addresses =
    Array.isArray(check.addresses) && check.addresses.length ? check.addresses : null;
  return { target, admittedAs: 'public', addresses };
}

/**
 * Whether a URL may carry the registry's credentials: it is an http(s) URL on
 * the host of one of the `trustedUrls` (integration.json, the registry's
 * catalog) with the same scheme, or both are GitHub hosts and the URL is https.
 *
 * @param {string} url
 * @param {Array<string|undefined>} trustedUrls
 * @returns {boolean}
 */
export function sharesCredentialScope(url, trustedUrls) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  for (const trusted of trustedUrls) {
    if (typeof trusted !== 'string') continue;
    let known;
    try {
      known = new URL(trusted);
    } catch {
      continue;
    }
    // Same host *and* scheme: a catalog must not move the credentials from
    // https to plain http, where they would travel in the clear.
    if (known.protocol === target.protocol && known.host === target.host) return true;
    if (
      target.protocol === 'https:' &&
      GITHUB_HOSTS.has(known.hostname) &&
      GITHUB_HOSTS.has(target.hostname)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Close the body of a redirect answer that is not read, so its connection is
 * not left waiting for a reader.
 *
 * @param {object} response - fetch Response
 */
function discardBody(response) {
  const body = response?.body;
  if (!body) return;
  try {
    if (typeof body.destroy === 'function') body.destroy();
    else if (typeof body.cancel === 'function') body.cancel().catch(() => {});
  } catch {
    // Already closed.
  }
}

/**
 * {@link assertAllowedMarketplaceTarget} for one hop of a fetch. A refusal of
 * a redirect hop also names the host that redirected there, so the admin can
 * tell a catalog entry from a redirect behind it.
 *
 * @param {string|URL} hop - The URL about to be fetched
 * @param {{ id?: string, source?: string }|null|undefined} registry - Registry config
 * @param {URL|null} redirectedFrom - The URL whose redirect led here; null for the first request
 * @returns {Promise<{ target: URL, admittedAs: 'registry'|'public', addresses: string[]|null }>}
 * @throws {MarketplaceTargetError} When the hop is refused
 */
async function assertHop(hop, registry, redirectedFrom) {
  try {
    return await assertAllowedMarketplaceTarget(hop, registry);
  } catch (error) {
    if (redirectedFrom && error.code === MARKETPLACE_TARGET_BLOCKED) {
      error.message += `; reached through a redirect from '${redirectedFrom.host}'`;
    }
    throw error;
  }
}

/**
 * Fetch a marketplace URL for a registry through the request throttle, with
 * the target guard on every hop and redirects followed by hand.
 *
 * `headers` go to every hop. `authHeaders` (the registry's credentials, or
 * `{}` when the caller decided this URL must not get them) go to the first
 * hop, and to a later hop only when it shares the credential scope of the
 * first URL ({@link sharesCredentialScope}).
 *
 * @param {string} throttleId - Request throttle queue (`marketplace-registry`, `marketplace-installer`)
 * @param {string} url - URL to fetch
 * @param {Object} options
 * @param {{ id?: string, source?: string }} options.registry - Registry the fetch is made for
 * @param {Record<string, string>} [options.headers={}] - Headers for every hop (e.g. `Accept`)
 * @param {Record<string, string>} [options.authHeaders={}] - The registry's credentials
 * @returns {Promise<object>} The final, non-redirect fetch Response (unread)
 * @throws {MarketplaceTargetError} When a hop's host is refused
 * @throws {Error} After more than {@link MAX_MARKETPLACE_REDIRECTS} redirects
 *
 * @example
 * const response = await marketplaceFetch('marketplace-installer', companionUrl, {
 *   registry,
 *   headers: { Accept: 'text/plain' },
 *   authHeaders: trusted ? authHeaders : {}
 * });
 */
export async function marketplaceFetch(
  throttleId,
  url,
  { registry, headers = {}, authHeaders = {} } = {}
) {
  const first = parseHttpUrl(url);
  let hop = url;
  /** The URL whose redirect led to `hop`; null for the first request. */
  let redirectedFrom = null;
  for (let redirects = 0; ; redirects += 1) {
    const { target, addresses } = await assertHop(hop, registry, redirectedFrom);
    const withCredentials = redirects === 0 || sharesCredentialScope(target.href, [first.href]);
    const response = await throttledFetch(throttleId, target.href, {
      headers: withCredentials ? { ...headers, ...authHeaders } : { ...headers },
      // Every hop comes back here to be checked; the client follows nothing.
      redirect: 'manual',
      ...(addresses ? { lookup: createPinnedLookup(addresses) } : {})
    });

    const location = REDIRECT_STATUSES.has(response?.status)
      ? response.headers?.get?.('location')
      : null;
    if (!location) return response;

    discardBody(response);
    if (redirects >= MAX_MARKETPLACE_REDIRECTS) {
      throw new Error(
        `Marketplace fetch from '${first.host}' stopped after ${MAX_MARKETPLACE_REDIRECTS} redirects`
      );
    }
    redirectedFrom = target;
    try {
      hop = new URL(location, target);
    } catch {
      throw new MarketplaceTargetError(
        `Marketplace fetch from '${target.host}' refused: the redirect location is not a valid URL`,
        target.host
      );
    }
  }
}
