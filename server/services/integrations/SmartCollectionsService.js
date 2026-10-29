// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Client of the iFinder Smart Collections public API (v1, GA since iFinder 6.8):
 * list and get, with the calling user's own JWT.
 *
 *  - The paths are the **v1** ones (`/public-api/smart-collections/api/v1/...`),
 *    not the v0 paths the 6.8 documentation still shows.
 *  - The JWT default scope is `fi_index_read`; these calls request
 *    `fi_smartcollections` explicitly, and the user needs that role in iFinder.
 *  - Every request goes through `httpFetch()`, so `ssl.domainWhitelist` and the
 *    proxy configuration apply like for every other iFinder call.
 *  - The owner of a collection is the JWT principal claim, which iHub signs from
 *    `jwtSubjectField` (`utils/iFinderJwt.js`). iFinder's list call matches it
 *    case-sensitively and the per-collection checks do not, so a collection
 *    whose owner differs from the caller's `sub` only in case is missing from
 *    {@link SmartCollectionsService#list} but still opens by id. iHub does not
 *    work around that.
 *
 * The service holds no state: caching and the merge into the project list are
 * the project tier's (`services/projects/ifinder/IFinderTier.js`).
 *
 * @module services/integrations/SmartCollectionsService
 */
import { httpFetch } from '../../utils/httpConfig.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import logger from '../../utils/logger.js';
import iFinderService from './iFinderService.js';

const COMPONENT = 'SmartCollectionsService';

/** The role (JWT scope) the Smart Collections API needs. */
export const SMART_COLLECTIONS_SCOPE = 'fi_smartcollections';

/** The v1 collection resource, below the iFinder base URL. */
export const SMART_COLLECTIONS_PATH = '/public-api/smart-collections/api/v1/smart-collections';

/** Collections asked for per page. iFinder defaults to 10 without `size`. */
export const LIST_PAGE_SIZE = 100;

/** Most collections one list call reads: a user holds a handful, not hundreds. */
export const MAX_COLLECTIONS = 300;

/** Default timeouts, in milliseconds. The list sits on the way to the projects page. */
export const LIST_TIMEOUT_MS = 5000;
export const GET_TIMEOUT_MS = 8000;

const COLLECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a call failed, as far as the project tier needs to tell. */
export const SMART_COLLECTIONS_ERRORS = Object.freeze({
  /** iFinder answers, but has no Smart Collections v1 API (an older version). */
  UNSUPPORTED: 'UNSUPPORTED',
  /** The user's token lacks `fi_smartcollections`. */
  FORBIDDEN: 'FORBIDDEN',
  /** iFinder does not accept the token (signature, issuer, audience). An admin matter. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** No such collection, or it belongs to someone else (iFinder answers 404 for both). */
  NOT_FOUND: 'NOT_FOUND',
  /** Timeout, network or TLS error, or a 5xx. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** iFinder answered with something that is no collection. */
  INVALID_RESPONSE: 'INVALID_RESPONSE'
});

export class SmartCollectionsError extends Error {
  /**
   * @param {keyof typeof SMART_COLLECTIONS_ERRORS} code
   * @param {string} message
   * @param {{status?: number|null, cause?: unknown}} [options]
   */
  constructor(code, message, { status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SmartCollectionsError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @typedef {Object} SmartCollectionSummary
 * @property {string} id - The collection's UUID, lowercase.
 * @property {string} name
 * @property {string} description
 * @property {string} owner
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 * @property {number} documentCount
 */

/**
 * @typedef {SmartCollectionSummary & {documentIds: string[]}} SmartCollection
 */

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function timestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** The distinct, non-empty document ids of a raw collection, in order. */
function documentIdsOf(raw) {
  const seen = new Set();
  for (const entry of Array.isArray(raw?.documents) ? raw.documents : []) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id.trim()) seen.add(id.trim());
  }
  return [...seen];
}

/**
 * One raw collection from iFinder as a summary, or null when it has no valid
 * id. The raw `documents` (ids and notes) are reduced to their count here, so
 * a list never carries the ids or the notes any further.
 *
 * @param {Object} raw
 * @returns {SmartCollectionSummary|null}
 */
export function summarizeCollection(raw) {
  if (!raw || typeof raw.id !== 'string' || !COLLECTION_ID.test(raw.id)) return null;
  return {
    id: raw.id.toLowerCase(),
    name: text(raw.name, 200),
    description: text(raw.description, 2000),
    owner: text(raw.owner, 500),
    createdAt: timestamp(raw.creation_date),
    updatedAt: timestamp(raw.modification_date),
    documentCount: documentIdsOf(raw).length
  };
}

/**
 * @param {Object} raw
 * @returns {SmartCollection|null}
 */
export function parseCollection(raw) {
  const summary = summarizeCollection(raw);
  return summary ? { ...summary, documentIds: documentIdsOf(raw) } : null;
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

class SmartCollectionsService {
  /**
   * One authenticated GET against the collections resource.
   *
   * @param {Object} params
   * @param {Object} params.user - The calling user (the JWT subject).
   * @param {string} [params.suffix] - Path below the collection resource (`/<id>`).
   * @param {Object} [params.query] - Query parameters.
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs]
   * @returns {Promise<Object|null>} The parsed JSON body, null for a 204.
   * @throws {SmartCollectionsError}
   */
  async _get({ user, suffix = '', query = {}, signal, timeoutMs = GET_TIMEOUT_MS }) {
    const baseUrl = iFinderService.getConfig().baseUrl.replace(/\/+$/, '');
    const url = new URL(`${baseUrl}${SMART_COLLECTIONS_PATH}${suffix}`);
    for (const [key, value] of Object.entries(query)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(entry));
      }
    }
    let authorization;
    try {
      authorization = getIFinderAuthorizationHeader(user, { scope: SMART_COLLECTIONS_SCOPE });
    } catch (error) {
      // No private key, or no value for the configured subject field: iFinder
      // was not asked, and asking again will not help until an admin acts.
      throw new SmartCollectionsError(
        SMART_COLLECTIONS_ERRORS.UNAUTHORIZED,
        `The iFinder token could not be signed: ${error?.message}`,
        { cause: error }
      );
    }
    let response;
    try {
      response = await httpFetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        signal: withTimeout(signal, timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      logger.warn('iFinder Smart Collections request failed', {
        component: COMPONENT,
        host: url.host,
        reason: timedOut ? 'timeout' : error?.message
      });
      throw new SmartCollectionsError(
        SMART_COLLECTIONS_ERRORS.UNAVAILABLE,
        timedOut ? 'iFinder did not answer in time' : `iFinder is not reachable: ${error?.message}`,
        { cause: error }
      );
    }
    if (!response.ok) {
      // The body is not read: it may carry a stack or a token echo.
      const { status } = response;
      const code =
        status === 404 && suffix
          ? SMART_COLLECTIONS_ERRORS.NOT_FOUND
          : status === 404 || status === 405 || status === 410 || status === 501
            ? SMART_COLLECTIONS_ERRORS.UNSUPPORTED
            : status === 403
              ? SMART_COLLECTIONS_ERRORS.FORBIDDEN
              : status === 401
                ? SMART_COLLECTIONS_ERRORS.UNAUTHORIZED
                : SMART_COLLECTIONS_ERRORS.UNAVAILABLE;
      throw new SmartCollectionsError(code, `iFinder answered ${status}`, { status });
    }
    // 204 is how the webapp answers when the utilities service sent no body:
    // nothing to read, not a failure.
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch (error) {
      throw new SmartCollectionsError(
        SMART_COLLECTIONS_ERRORS.INVALID_RESPONSE,
        'iFinder answered with a body that is not JSON',
        { status: response.status, cause: error }
      );
    }
  }

  /**
   * One page of the user's collections.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {number} [params.from=0]
   * @param {number} [params.size=0]
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs]
   * @returns {Promise<{collections: SmartCollectionSummary[], received: number}>} `received`
   *   counts the entries iFinder sent, valid or not: a full page means there may be more.
   */
  async listPage({ user, from = 0, size = LIST_PAGE_SIZE, signal, timeoutMs = LIST_TIMEOUT_MS }) {
    const body = await this._get({
      user,
      query: { from, size, sort: 'modification_date:desc' },
      signal,
      timeoutMs
    });
    // 204 (no body) is how the webapp answers when utilities sent nothing.
    const raw = Array.isArray(body?.collections) ? body.collections : [];
    return {
      collections: raw.map(summarizeCollection).filter(Boolean),
      received: raw.length
    };
  }

  /**
   * The capability call: whether this iFinder serves the Smart Collections v1
   * API to this user. It asks for no collection (`size=0`), so it costs one
   * round trip and moves no data.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs]
   * @returns {Promise<void>} Resolves when the API answers.
   * @throws {SmartCollectionsError} `UNSUPPORTED` for an iFinder without the
   *   API, `FORBIDDEN` when the user lacks the role, `UNAVAILABLE` and
   *   `UNAUTHORIZED` when iFinder cannot be asked.
   */
  async probe({ user, signal, timeoutMs }) {
    await this.listPage({ user, from: 0, size: 0, signal, timeoutMs });
  }

  /**
   * The user's collections, newest first, as summaries (no document ids).
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs] - For each page.
   * @returns {Promise<{collections: SmartCollectionSummary[], truncated: boolean}>}
   *   `truncated`: the user has more collections than {@link MAX_COLLECTIONS}.
   */
  async list({ user, signal, timeoutMs }) {
    const collections = [];
    let truncated = false;
    for (let from = 0; ; from += LIST_PAGE_SIZE) {
      const page = await this.listPage({ user, from, size: LIST_PAGE_SIZE, signal, timeoutMs });
      collections.push(...page.collections);
      if (page.received < LIST_PAGE_SIZE) break;
      if (collections.length >= MAX_COLLECTIONS) {
        truncated = true;
        break;
      }
    }
    return { collections: collections.slice(0, MAX_COLLECTIONS), truncated };
  }

  /**
   * One collection with its document ids.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.id - The collection's UUID.
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs]
   * @returns {Promise<SmartCollection>}
   * @throws {SmartCollectionsError} `NOT_FOUND` for a missing collection and for
   *   one that is not the caller's: iFinder answers 404 for both.
   */
  async get({ user, id, signal, timeoutMs }) {
    if (typeof id !== 'string' || !COLLECTION_ID.test(id)) {
      throw new SmartCollectionsError(SMART_COLLECTIONS_ERRORS.NOT_FOUND, 'Invalid collection id');
    }
    const raw = await this._get({
      user,
      suffix: `/${id.toLowerCase()}`,
      signal,
      timeoutMs
    });
    const collection = parseCollection(raw);
    if (!collection || collection.id !== id.toLowerCase()) {
      throw new SmartCollectionsError(
        SMART_COLLECTIONS_ERRORS.INVALID_RESPONSE,
        'iFinder answered with a different collection'
      );
    }
    return collection;
  }
}

export const smartCollections = new SmartCollectionsService();
export default smartCollections;
