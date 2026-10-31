// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Client of the iFinder Smart Collections public API (v1, GA since iFinder 6.8):
 * list and get, and (iteration 2 of the iFinder tier) create, rename, add
 * documents, remove documents and delete a collection, with the calling user's
 * own JWT.
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
 *  - **Writes are an unversioned read-modify-write in iFinder** (the utilities
 *    service has no `if_seq_no`), so two writes to one collection that overlap
 *    lose one of them. This client does not serialize them: the caller does,
 *    across all iHub instances (`services/projects/ifinder/collectionLock.js`).
 *  - `PATCH` updates **every non-null field** it is sent, `owner`, `documents`
 *    and `viewers` included. {@link SmartCollectionsService#rename} therefore
 *    builds its body from `name` and `description` alone: an `owner` would hand
 *    the collection to someone else and `documents` would overwrite the list.
 *  - The owner of a new collection is **not sent**: the webapp fills it from
 *    the token. iFinder checks no document id on add (no existence, no ACL),
 *    so the caller checks readability first.
 *
 * The service holds no state: caching and the merge into the project list are
 * the project tier's (`services/projects/ifinder/IFinderTier.js`).
 *
 * @module services/integrations/SmartCollectionsService
 */
import { httpFetch } from '../../utils/httpConfig.js';
import iFinderTokenProvider from './iFinderTokenProvider.js';
import { isUnavailableError } from './oauthRefreshError.js';
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
export const WRITE_TIMEOUT_MS = 15000;

/** Documents one collection holds at most (utilities `max-document-count`). */
export const MAX_COLLECTION_DOCUMENTS = 200;

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
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  /** iFinder refused a write as invalid (400, 409, 422). Asking again unchanged will not help. */
  REJECTED: 'REJECTED'
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

function collectionIdOrThrow(id) {
  if (typeof id !== 'string' || !COLLECTION_ID.test(id)) {
    throw new SmartCollectionsError(SMART_COLLECTIONS_ERRORS.NOT_FOUND, 'Invalid collection id');
  }
  return id.toLowerCase();
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

class SmartCollectionsService {
  /**
   * One authenticated request against the collections resource.
   *
   * @param {Object} params
   * @param {Object} params.user - The calling user (the JWT subject).
   * @param {string} [params.method='GET']
   * @param {string} [params.suffix] - Path below the collection resource (`/<id>`).
   * @param {Object} [params.query] - Query parameters.
   * @param {Object|Array} [params.body] - JSON body.
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs]
   * @returns {Promise<{status: number, body: Object|null}>} The status and the
   *   parsed JSON body, null for a 204 or an empty body.
   * @throws {SmartCollectionsError}
   */
  async _request({
    user,
    method = 'GET',
    suffix = '',
    query = {},
    body,
    signal,
    timeoutMs = GET_TIMEOUT_MS
  }) {
    const baseUrl = iFinderService.getConfig().baseUrl.replace(/\/+$/, '');
    const url = new URL(`${baseUrl}${SMART_COLLECTIONS_PATH}${suffix}`);
    for (const [key, value] of Object.entries(query)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(entry));
      }
    }
    let authorization;
    try {
      authorization = await iFinderTokenProvider.getAuthorizationHeader(user, {
        scope: SMART_COLLECTIONS_SCOPE
      });
    } catch (error) {
      // No private key, no value for the configured subject field, or (token
      // exchange) no usable sign-in: iFinder was not asked, and asking again
      // will not help until an admin or the user acts. A provider that is
      // briefly unreachable is the exception.
      throw new SmartCollectionsError(
        isUnavailableError(error)
          ? SMART_COLLECTIONS_ERRORS.UNAVAILABLE
          : SMART_COLLECTIONS_ERRORS.UNAUTHORIZED,
        `The iFinder token could not be obtained: ${error?.message}`,
        { cause: error }
      );
    }
    const hasBody = body !== undefined;
    let response;
    try {
      response = await httpFetch(url.toString(), {
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {})
        },
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: withTimeout(signal, timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      logger.warn('iFinder Smart Collections request failed', {
        component: COMPONENT,
        host: url.host,
        method,
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
                : method !== 'GET' && (status === 400 || status === 409 || status === 422)
                  ? SMART_COLLECTIONS_ERRORS.REJECTED
                  : SMART_COLLECTIONS_ERRORS.UNAVAILABLE;
      throw new SmartCollectionsError(code, `iFinder answered ${status}`, { status });
    }
    // 204 is how the webapp answers when the utilities service sent no body:
    // nothing to read, not a failure.
    if (response.status === 204) return { status: 204, body: null };
    let text = '';
    try {
      text = await response.text();
      return { status: response.status, body: text.trim() ? JSON.parse(text) : null };
    } catch (error) {
      throw new SmartCollectionsError(
        SMART_COLLECTIONS_ERRORS.INVALID_RESPONSE,
        'iFinder answered with a body that is not JSON',
        { status: response.status, cause: error }
      );
    }
  }

  /** One authenticated GET: the parsed JSON body, null when there is none. */
  async _get(params) {
    return (await this._request({ ...params, method: 'GET' })).body;
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

  /**
   * Create a collection. The owner is **not sent**: the webapp sets it to the
   * authenticated user's principal, so the collection is the caller's.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.name
   * @param {string} [params.description='']
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{id: string}>} The new collection's UUID, lowercase.
   * @throws {SmartCollectionsError}
   */
  async create({ user, name, description = '', signal }) {
    const { body } = await this._request({
      user,
      method: 'POST',
      body: { name, description },
      signal,
      timeoutMs: WRITE_TIMEOUT_MS
    });
    const id = typeof body?.id === 'string' ? body.id.toLowerCase() : '';
    if (!COLLECTION_ID.test(id)) {
      throw new SmartCollectionsError(
        SMART_COLLECTIONS_ERRORS.INVALID_RESPONSE,
        'iFinder did not answer with the id of the new collection'
      );
    }
    return { id };
  }

  /**
   * Rename a collection (and change its description). The body holds only the
   * fields given: `PATCH` writes every non-null field it gets, so `owner`,
   * `documents` and `viewers` are never part of it.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.id
   * @param {string} [params.name]
   * @param {string} [params.description]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<void>}
   * @throws {SmartCollectionsError}
   */
  async rename({ user, id, name, description, signal }) {
    const body = {};
    if (typeof name === 'string') body.name = name;
    if (typeof description === 'string') body.description = description;
    if (Object.keys(body).length === 0) return;
    await this._request({
      user,
      method: 'PATCH',
      suffix: `/${collectionIdOrThrow(id)}`,
      body,
      signal,
      timeoutMs: WRITE_TIMEOUT_MS
    });
  }

  /**
   * Delete a collection in iFinder. Its documents are untouched: a collection
   * only lists them.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.id
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<void>}
   * @throws {SmartCollectionsError} `NOT_FOUND` when it is gone already, or not the caller's.
   */
  async remove({ user, id, signal }) {
    await this._request({
      user,
      method: 'DELETE',
      suffix: `/${collectionIdOrThrow(id)}`,
      signal,
      timeoutMs: WRITE_TIMEOUT_MS
    });
  }

  /**
   * Add documents to a collection's membership. iFinder checks neither that
   * a document exists nor that the user may read it: the caller did.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.id
   * @param {string[]} params.documentIds
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<void>}
   * @throws {SmartCollectionsError}
   */
  async addDocuments({ user, id, documentIds, signal }) {
    await this._request({
      user,
      method: 'POST',
      suffix: `/${collectionIdOrThrow(id)}/documents`,
      body: documentIds.map(documentId => ({ id: documentId })),
      signal,
      timeoutMs: WRITE_TIMEOUT_MS
    });
  }

  /**
   * Remove documents from a collection's membership. The documents themselves
   * are untouched: this endpoint knows nothing else.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.id
   * @param {string[]} params.documentIds
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<void>}
   * @throws {SmartCollectionsError}
   */
  async removeDocuments({ user, id, documentIds, signal }) {
    await this._request({
      user,
      method: 'DELETE',
      suffix: `/${collectionIdOrThrow(id)}/documents`,
      body: documentIds.map(documentId => ({ id: documentId })),
      signal,
      timeoutMs: WRITE_TIMEOUT_MS
    });
  }
}

export const smartCollections = new SmartCollectionsService();
export default smartCollections;
