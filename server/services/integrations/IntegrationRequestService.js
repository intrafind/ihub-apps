// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Requests for catalog integrations (#2926; concept
 * `2026-10-20 Unified Integrations/03-product-concept.md` §6.6).
 *
 * A user who sees a catalog entry their admin has not made available to them
 * presses **Request**; the admin works the queue: *approve* (opens the install
 * wizard), *decline*, or *decline and hide*.
 *
 * **Records.** One document per (user, definition) in the
 * `integration-requests` runtime namespace, keyed `ireq_<hash>` and owned by
 * the user, so "my requests" is an owner-index read and account deletion
 * removes them. The key is deterministic, which is what makes "one open
 * request per user and definition" hold across workers: the first write is
 * create-only (`etag: null`), a later one replaces a closed request with a
 * compare-and-set on its etag.
 *
 * ```
 * { id, definition, status, reason, requester: { id, name, groups },
 *   createdAt, updatedAt, decidedAt, decidedBy: { id, name } | null, note,
 *   hidden, fulfilledBy, closedAt }
 * ```
 *
 * `status` is `open` → `approved` (the admin is installing it) → `fulfilled`,
 * or `open` | `approved` → `declined`. `open` and `approved` count as open: a
 * second request is refused while one of them stands. A declined or fulfilled
 * request can be made again.
 *
 * **Hidden definitions.** "Decline and hide" puts the definition on the hidden
 * list (`integration-requests-hidden`, one marker per definition): it is left
 * out of every user's "Not available yet" list and cannot be requested until
 * an admin shows it again. Hiding also declines the other open requests for
 * that definition.
 *
 * **Closing on install.** A request closes as `fulfilled` once an enabled
 * installation of its definition exists that the requester's groups allow
 * ({@link IntegrationRequestService#closeFulfilled}). That runs after an
 * install, an update or an enable, and whenever a list is read, so a group
 * change the admin makes later closes it too. The requester's groups are the
 * ones they had when they asked; the user's own listing checks with their
 * current groups.
 *
 * @module services/integrations/IntegrationRequestService
 */
import crypto from 'node:crypto';
import { requireStorage } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { INTEGRATION_ID_PATTERN } from '../../validators/integrationDefinitionSchema.js';
import { mayUseIntegration } from './integrationAccess.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'IntegrationRequestService';

export const REQUESTS_NAMESPACE = RUNTIME_NAMESPACES.integrationRequests;
export const HIDDEN_NAMESPACE = RUNTIME_NAMESPACES.integrationRequestsHidden;

/** Longest reason a user may give, and longest note an admin may add. */
export const MAX_REASON_LENGTH = 500;
export const MAX_NOTE_LENGTH = 500;
/** Longest definition id accepted (the pattern has no bound of its own). */
export const MAX_DEFINITION_ID_LENGTH = 200;

export const REQUEST_STATUSES = Object.freeze({
  OPEN: 'open',
  APPROVED: 'approved',
  DECLINED: 'declined',
  FULFILLED: 'fulfilled'
});

const STANDING = new Set([REQUEST_STATUSES.OPEN, REQUEST_STATUSES.APPROVED]);

/** Request ids: `ireq_` and 32 hex characters. */
export const REQUEST_ID_PATTERN = /^ireq_[a-f0-9]{32}$/;

/** An error with a stable code and the HTTP status the routes answer with. */
export class IntegrationRequestError extends Error {
  /**
   * @param {string} code - REQUEST_EXISTS | REQUEST_NOT_FOUND | REQUEST_CLOSED | REQUEST_CONFLICT
   * @param {string} message
   * @param {number} status
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'IntegrationRequestError';
    this.code = code;
    this.status = status;
  }
}

/** Whether a request is still waiting (open or approved). */
export function isStanding(request) {
  return STANDING.has(request?.status);
}

/** Whether a value can be a definition id. */
export function isDefinitionId(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_DEFINITION_ID_LENGTH &&
    INTEGRATION_ID_PATTERN.test(value)
  );
}

/** Whether a value can be a request id. */
export function isRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** The one key of a user's request for a definition. */
export function requestIdFor(userId, definition) {
  return `ireq_${hash(`${userId}\n${definition}`)}`;
}

/** The key of a definition's hidden marker. */
export function hiddenKeyFor(definition) {
  return `ihid_${hash(definition)}`;
}

/**
 * A free text the user or admin typed: trimmed, control characters other than
 * line breaks removed. Null when empty.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function cleanText(value) {
  if (typeof value !== 'string') return null;

  const text = value.replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return text || null;
}

/** The display name of a principal, never its email when a name is known. */
function nameOf(user) {
  return String(user?.name || user?.username || user?.id || '');
}

function groupsOf(user) {
  return Array.isArray(user?.groups) ? user.groups.filter(g => typeof g === 'string') : [];
}

export class IntegrationRequestService {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore} [options.documents]
   *   The document store; the active storage provider's when omitted.
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this._documents = options.documents || null;
    this.now = options.now || (() => Date.now());
  }

  _docs() {
    return this._documents || requireStorage().documents;
  }

  _iso() {
    return new Date(this.now()).toISOString();
  }

  // ── Storage ─────────────────────────────────────────────────────────────

  async _getDoc(ns, key) {
    return this._docs().get(ns, key);
  }

  /**
   * Write a document. `etag`: undefined overwrites, null creates only, a
   * string replaces only that version. A lost race is a REQUEST_CONFLICT.
   */
  async _putDoc(ns, key, data, { ownerId, etag } = {}) {
    try {
      await this._docs().put(ns, key, data, {
        ownerId,
        ...(etag !== undefined ? { etag } : {})
      });
      return data;
    } catch (error) {
      if (error?.code === 'ETAG_MISMATCH') {
        throw new IntegrationRequestError(
          'REQUEST_CONFLICT',
          'The request changed meanwhile; try again',
          409
        );
      }
      throw error;
    }
  }

  async _deleteDoc(ns, key) {
    return this._docs().delete(ns, key);
  }

  async _listDocs(ns, { ownerId } = {}) {
    const documents = this._docs();
    const out = [];
    let cursor = null;
    do {
      const page = await documents.list(ns, {
        limit: 1000,
        includeData: true,
        ...(ownerId ? { ownerId } : {}),
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items || []) if (doc?.data) out.push(doc.data);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  // ── Requests ────────────────────────────────────────────────────────────

  /** Every request, newest first. */
  async list() {
    const all = await this._listDocs(REQUESTS_NAMESPACE);
    return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** The requests of one user (owner-index read). */
  async listForUser(userId) {
    if (!userId) return [];
    return this._listDocs(REQUESTS_NAMESPACE, { ownerId: String(userId) });
  }

  /** One request, or null. */
  async get(id) {
    if (!isRequestId(id)) return null;
    const doc = await this._getDoc(REQUESTS_NAMESPACE, id);
    return doc?.data || null;
  }

  /**
   * Record a user's request for a definition.
   *
   * @param {Object} params
   * @param {Object} params.user - The requester (`id`, `name`, `groups`)
   * @param {string} params.definition - A definition id (checked by the caller)
   * @param {string|null} [params.reason]
   * @returns {Promise<Object>} The stored request
   * @throws {IntegrationRequestError} REQUEST_EXISTS when one stands
   */
  async create({ user, definition, reason = null }) {
    const userId = String(user.id);
    const id = requestIdFor(userId, definition);
    const existing = await this._getDoc(REQUESTS_NAMESPACE, id);
    if (existing?.data && isStanding(existing.data)) {
      throw new IntegrationRequestError(
        'REQUEST_EXISTS',
        'You have already requested this integration',
        409
      );
    }
    const now = this._iso();
    const record = {
      id,
      definition,
      status: REQUEST_STATUSES.OPEN,
      reason: cleanText(reason),
      requester: { id: userId, name: nameOf(user), groups: groupsOf(user) },
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      decidedBy: null,
      note: null,
      hidden: false,
      fulfilledBy: null,
      closedAt: null
    };
    try {
      await this._putDoc(REQUESTS_NAMESPACE, id, record, {
        ownerId: userId,
        etag: existing ? existing.etag : null
      });
    } catch (error) {
      // Another worker wrote the same (user, definition) first: that is the
      // duplicate this rule is about.
      if (error instanceof IntegrationRequestError && error.code === 'REQUEST_CONFLICT') {
        throw new IntegrationRequestError(
          'REQUEST_EXISTS',
          'You have already requested this integration',
          409
        );
      }
      throw error;
    }
    return record;
  }

  /**
   * Approve or decline a request.
   *
   * @param {string} id
   * @param {Object} params
   * @param {'approved'|'declined'} params.decision
   * @param {Object} params.admin - Who decided (`id`, `name`)
   * @param {string|null} [params.note]
   * @param {boolean} [params.hide=false] - Decline only: hide the definition
   * @returns {Promise<{request: Object, alsoDeclined: Object[]}>}
   * @throws {IntegrationRequestError} REQUEST_NOT_FOUND, REQUEST_CLOSED, REQUEST_CONFLICT
   */
  async decide(id, { decision, admin, note = null, hide = false }) {
    const doc = await this._getDoc(REQUESTS_NAMESPACE, id);
    const current = doc?.data;
    if (!current) {
      throw new IntegrationRequestError('REQUEST_NOT_FOUND', 'Request not found', 404);
    }
    if (!isStanding(current)) {
      throw new IntegrationRequestError('REQUEST_CLOSED', 'This request is already closed', 409);
    }
    const now = this._iso();
    const decidedBy = { id: String(admin?.id || ''), name: nameOf(admin) };
    const declined = decision === REQUEST_STATUSES.DECLINED;
    const next = {
      ...current,
      status: declined ? REQUEST_STATUSES.DECLINED : REQUEST_STATUSES.APPROVED,
      updatedAt: now,
      decidedAt: now,
      decidedBy,
      note: cleanText(note),
      hidden: declined && hide === true,
      closedAt: declined ? now : null
    };
    await this._putDoc(REQUESTS_NAMESPACE, id, next, {
      ownerId: current.requester.id,
      etag: doc.etag ?? undefined
    });

    const alsoDeclined = [];
    if (declined && hide === true) {
      await this.hide(current.definition, admin);
      // Hidden for everyone: the other open requests for it are declined too.
      for (const other of await this.list()) {
        if (other.id === id || other.definition !== current.definition) continue;
        if (other.status !== REQUEST_STATUSES.OPEN) continue;
        const closed = {
          ...other,
          status: REQUEST_STATUSES.DECLINED,
          updatedAt: now,
          decidedAt: now,
          decidedBy,
          note: next.note,
          hidden: true,
          closedAt: now
        };
        try {
          await this._putDoc(REQUESTS_NAMESPACE, other.id, closed, {
            ownerId: other.requester.id
          });
          alsoDeclined.push(closed);
        } catch (error) {
          logger.warn('Could not decline a request of a hidden definition', {
            component: COMPONENT,
            requestId: other.id,
            error: error.message
          });
        }
      }
    }
    return { request: next, alsoDeclined };
  }

  /**
   * Close the standing requests whose definition now has an enabled
   * installation the requester's groups allow.
   *
   * @param {Object} params
   * @param {Object[]} params.installations - The installed instances
   * @param {string} [params.definition] - Only requests for this definition
   * @param {Object} [params.user] - Only this user's requests, checked with
   *   their current groups instead of the stored ones
   * @returns {Promise<Object[]>} The requests closed
   */
  async closeFulfilled({ installations, definition, user } = {}) {
    const enabled = (Array.isArray(installations) ? installations : []).filter(
      instance => instance?.id && instance.enabled !== false
    );
    if (enabled.length === 0) return [];
    const candidates = user ? await this.listForUser(user.id) : await this.list();
    const closed = [];
    for (const request of candidates) {
      if (!isStanding(request)) continue;
      if (definition && request.definition !== definition) continue;
      const principal = user || { id: request.requester.id, groups: request.requester.groups };
      const match = enabled.find(
        instance =>
          instance.definition === request.definition && mayUseIntegration(instance, principal)
      );
      if (!match) continue;
      const now = this._iso();
      const next = {
        ...request,
        status: REQUEST_STATUSES.FULFILLED,
        updatedAt: now,
        fulfilledBy: match.id,
        closedAt: now
      };
      try {
        await this._putDoc(REQUESTS_NAMESPACE, request.id, next, {
          ownerId: request.requester.id
        });
        closed.push(next);
      } catch (error) {
        logger.warn('Could not close a fulfilled integration request', {
          component: COMPONENT,
          requestId: request.id,
          error: error.message
        });
      }
    }
    return closed;
  }

  /**
   * Delete every request of a user (account deletion).
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async forgetUser(userId) {
    let removed = 0;
    for (const request of await this.listForUser(userId)) {
      if (await this._deleteDoc(REQUESTS_NAMESPACE, request.id)) removed += 1;
    }
    return removed;
  }

  // ── Hidden definitions ──────────────────────────────────────────────────

  /** The hidden definitions: `[{ definition, hiddenAt, hiddenBy }]`, oldest first. */
  async listHidden() {
    const all = await this._listDocs(HIDDEN_NAMESPACE);
    return all.sort((a, b) => String(a.hiddenAt).localeCompare(String(b.hiddenAt)));
  }

  /** The hidden definition ids, as a Set. */
  async hiddenDefinitions() {
    return new Set((await this.listHidden()).map(entry => entry.definition));
  }

  /** Hide a definition from the users' catalog view. */
  async hide(definition, admin) {
    const marker = {
      definition,
      hiddenAt: this._iso(),
      hiddenBy: { id: String(admin?.id || ''), name: nameOf(admin) }
    };
    await this._putDoc(HIDDEN_NAMESPACE, hiddenKeyFor(definition), marker, { ownerId: 'system' });
    return marker;
  }

  /** Show a hidden definition again. Answers whether it was hidden. */
  async unhide(definition) {
    return Boolean(await this._deleteDoc(HIDDEN_NAMESPACE, hiddenKeyFor(definition)));
  }
}

let singleton = null;

/** The service of this process. */
export function getIntegrationRequestService() {
  if (!singleton) singleton = new IntegrationRequestService();
  return singleton;
}

/** Test seam: replace the singleton. */
export function setIntegrationRequestServiceForTests(service) {
  singleton = service;
}
