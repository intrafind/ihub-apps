// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder search profiles a user may search with.
 *
 * iFinder's public API has no "my search profiles" endpoint: profile listing
 * lives on the admin API, which an end-user token cannot reach, and the
 * iAssistants list (`/public-api/v0/assistants`) only names the profiles some
 * iAssistant happens to be composed with. The searchbar learns the user's
 * profiles from the configuration action of the internal search API,
 * `GET /internal-api/v2/search?action=getconfiguration`, which answers with the
 * searchbar configuration as a list of blocks, one of them
 * `{ sources: [{ value, name, default, … }] }`:
 *
 *   - `value` is the profile id, Base64-encoded;
 *   - `name` is the display name;
 *   - `default` marks the user's first profile, the one iFinder searches when
 *     a request names a profile the user does not have.
 *
 * iHub reads the same list, as the user (the iFinder JWT), so what it calls
 * "available" is exactly what the searchbar offers that user. iFinder still
 * checks the profile on every search; this list decides which profile iHub asks
 * for, not what the user may see.
 *
 * The configuration action requires the feature `fi_ifinder_allow` (iFinder
 * 6.9, TCC-1868): a user without it is answered with 403. The caller treats
 * that, like any other failure, as "unknown" rather than "no profiles".
 */
import { throttledFetch } from '../../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import logger from '../../utils/logger.js';

export const CONFIGURATION_PATH = '/internal-api/v2/search';

/** How long a user's profile list is kept when the caller passes no TTL. */
export const DEFAULT_CACHE_TTL_MS = 300000;

/**
 * Decode a Base64 profile id, or null for a value that is not one.
 * @param {*} value
 * @returns {string|null}
 */
function decodeProfileId(value) {
  if (typeof value !== 'string') return null;
  const encoded = value.trim();
  if (!encoded || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
  return decoded && !decoded.includes('�') ? decoded : null;
}

/**
 * The search profiles in a `getconfiguration` response.
 *
 * @param {Object|Array} payload - the response body, `{ results: [...] }`
 * @returns {Array<{id: string, name: string, isDefault: boolean}>|null} the
 *   profiles in the order iFinder sorts them, or null when the response has no
 *   `sources` block at all (an unknown shape is not the same as "none")
 */
export function parseSearchProfiles(payload) {
  const blocks = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload)
      ? payload
      : [];
  const block = blocks.find(entry => entry && Array.isArray(entry.sources));
  if (!block) return null;

  const profiles = [];
  const seen = new Set();
  for (const source of block.sources) {
    const id = decodeProfileId(source?.value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : id;
    profiles.push({ id, name, isDefault: source.default === true });
  }
  // iFinder marks the first profile as the default; keep that true for a
  // response that marks none.
  if (profiles.length > 0 && !profiles.some(profile => profile.isDefault)) {
    profiles[0].isDefault = true;
  }
  return profiles;
}

class IFinderSearchProfiles {
  constructor() {
    /** @type {Map<string, { value: Array, expiresAt: number }>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<Array>>} in-flight reads, keyed as the cache */
    this.inFlight = new Map();
    this.fetch = throttledFetch;
  }

  /** Drop every cached list. Called from the config reload hooks. */
  reset() {
    this.cache.clear();
    this.inFlight.clear();
  }

  /**
   * The search profiles the user may search with, cached per user.
   *
   * @param {Object} params
   * @param {Object} params.user - authenticated user; the request is made as them
   * @param {string} params.baseUrl - iFinder base URL
   * @param {number} [params.ttlMs] - how long the list is cached
   * @param {number} [params.timeout] - request timeout in ms
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Array<{id: string, name: string, isDefault: boolean}>>}
   * @throws when iFinder cannot be asked or answers with something unreadable
   */
  getUserSearchProfiles({ user, baseUrl, ttlMs = DEFAULT_CACHE_TTL_MS, timeout, signal }) {
    if (!user?.id || user.id === 'anonymous') {
      return Promise.reject(new Error('Search profiles can only be listed for a signed-in user'));
    }
    if (!baseUrl) return Promise.reject(new Error('No iFinder base URL configured'));

    const key = `${baseUrl}::${user.id}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const lookup = this.fetchSearchProfiles({ user, baseUrl, timeout, signal })
      .then(profiles => {
        this.cache.set(key, { value: profiles, expiresAt: Date.now() + ttlMs });
        return profiles;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, lookup);
    return lookup;
  }

  /**
   * One uncached read of the user's profiles.
   * @private
   */
  async fetchSearchProfiles({ user, baseUrl, timeout, signal }) {
    const url =
      `${baseUrl.replace(/\/+$/, '')}${CONFIGURATION_PATH}?` +
      new URLSearchParams({ action: 'getconfiguration' });

    const response = await this.fetch('iFinderSearchProfiles', url, {
      method: 'GET',
      headers: {
        Authorization: getIFinderAuthorizationHeader(user),
        Accept: 'application/json'
      },
      ...(timeout ? { timeout } : {}),
      ...(signal ? { signal } : {})
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Reading the iFinder search profiles failed (${response.status}): ${errorText.slice(0, 200)}`
      );
    }

    const profiles = parseSearchProfiles(await response.json());
    if (!profiles) {
      throw new Error('The iFinder configuration response lists no search profiles block');
    }

    logger.debug('Read the iFinder search profiles of a user', {
      component: 'IFinderSearchProfiles',
      profileCount: profiles.length
    });
    return profiles;
  }
}

export default new IFinderSearchProfiles();
