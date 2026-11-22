// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * UserAppRepository — personal apps, on top of the storage abstraction.
 *
 * Three kinds of documents:
 *
 *   `user-apps/<appId>`                    the app: content, owner, members, state
 *   `user-app-shares/<appId>.<h>`          one marker per member target, one for
 *                                          the receiver of an open offer and one
 *                                          for its sender
 *   `user-app-revisions/<appId>.<rev>`     the last content states of the app
 *
 * The app document is filed under its **owner** as the document owner, so "my
 * apps" is an index read. A personal app never reaches `contents/apps/` and
 * never `configCache.getApps()`.
 *
 * A marker is filed under the principal it reaches — `user:<id>`,
 * `group:<name>` or `everyone` — so "shared with me" is a handful of index
 * reads. The markers are an index, never the authority: the member list and
 * `pendingOwner` on the document decide, and a marker the document no longer
 * backs grants nothing and is pruned. That is also what makes a revoke
 * immediate: the document is rewritten first, the markers go after.
 *
 * A content state is written in the same lock as every write that changes
 * `content`; the newest `MAX_CONTENT_STATES` are kept. When an app is deleted
 * its newest state stays for `DELETED_STATE_TTL_MS`, filed under
 * `deleted:<ownerId>`, and is removed when the same owner next creates or
 * deletes an app.
 *
 * Every read-modify-write of one app runs under
 * `locks.withLock('user-app:<id>')` with the etag of the document it read.
 * The limits per person (apps, open offers) are counted under
 * `locks.withLock('user-app-owner:<userId>')`. Where both are held, the
 * owner lock is taken first.
 *
 * `revision` is the app's ETag. It grows with every change a person can
 * see: content, members, an offer, the owner, the state. It does not grow
 * when only the owner snapshot or `lastUsedAt` is rewritten.
 *
 * Failures a route answers are {@link StorageError}s with these codes:
 * `USER_APP_ACCESS_CHANGED` (403), `ETAG_MISMATCH` (409), `QUOTA_USER_APPS`
 * (409), `QUOTA_USER_APP_OFFERS` (409), `USER_APP_NO_OFFER` (404).
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 4, 8.3 and 10.
 *
 * @module services/userApps/UserAppRepository
 */
import { createHash, randomBytes } from 'node:crypto';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { EtagMismatchError, StorageError } from '../../storage/errors.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { canonicalJson } from '../../storage/canonicalJson.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import {
  USER_APP_ID_PREFIX,
  USER_APP_ORIGINS,
  isUserAppId
} from '../../../shared/userAppContent.js';
import {
  memberTargetKey,
  openOffer,
  ownerSnapshotNeedsRefresh,
  userAppOwnerSnapshot
} from './userAppAccess.js';

const COMPONENT = 'UserAppRepository';

/** Namespace holding the app documents. */
export const USER_APPS_NAMESPACE = RUNTIME_NAMESPACES.userApps;

/** Namespace holding the share and offer markers. */
export const USER_APP_SHARES_NAMESPACE = RUNTIME_NAMESPACES.userAppShares;

/** Namespace holding the content states. */
export const USER_APP_REVISIONS_NAMESPACE = RUNTIME_NAMESPACES.userAppRevisions;

/** Schema version stamped on every document written here. */
export const USER_APP_VERSION = 1;

/** Content states kept per app. */
export const MAX_CONTENT_STATES = 20;

/** How long the newest content state of a deleted app is kept. */
export const DELETED_STATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** `lastUsedAt` is rewritten at most this often per app. */
export const LAST_USED_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Most shared apps one listing returns. */
export const MAX_SHARED_LISTED = 200;

/** Random bytes in a personal app ID: 16 bytes, 32 hex characters. */
const ID_BYTES = 16;

/** Documents per `list` call while walking an index. */
const PAGE_SIZE = 200;

/** Hard bound on documents walked for one listing. */
const MAX_SCANNED = 5000;

/** What {@link UserAppRepository#_getReadable} answers for a document that cannot be read. */
const UNREADABLE = Symbol('unreadable');

/** Lock lease for one write: the shape the project repository uses. */
const LOCK_OPTIONS = { ttlMs: 15000, waitMs: 5000, fence: false };

/**
 * Code of the error a write throws when its `authorize` check fails on the
 * app loaded under the lock: the caller's access changed between the route's
 * own check and the write.
 */
export const ACCESS_CHANGED = 'USER_APP_ACCESS_CHANGED';

/** Code of the error for a create or an accept over `limits.maxAppsPerUser`. */
export const QUOTA_APPS = 'QUOTA_USER_APPS';

/** Code of the error for an offer over `limits.maxOpenOffersPerUser`. */
export const QUOTA_OFFERS = 'QUOTA_USER_APP_OFFERS';

/** Code of the error for an accept without an open offer to the caller. */
export const NO_OFFER = 'USER_APP_NO_OFFER';

function assertAuthorized(authorize, record) {
  if (typeof authorize === 'function' && !authorize(record)) {
    throw new StorageError('Your access to this app changed', { code: ACCESS_CHANGED });
  }
}

function assertRevision(expectedRevision, record) {
  if (expectedRevision === undefined || expectedRevision === null) return;
  if (Number(expectedRevision) !== Number(record.revision)) {
    throw new EtagMismatchError('The app was changed by someone else');
  }
}

/**
 * Mint a personal app ID: the prefix and 16 random bytes in lower-case hex.
 *
 * @returns {string}
 */
export function mintUserAppId() {
  return `${USER_APP_ID_PREFIX}${randomBytes(ID_BYTES).toString('hex')}`;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

/**
 * The hash that ties an audit entry to a content state: SHA-256 of the
 * canonical JSON of `content`.
 *
 * @param {Object} content
 * @returns {string} `sha256:<hex>`
 */
export function contentHashOf(content) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(content ?? {}))
    .digest('hex')}`;
}

/**
 * Key of one member marker: the app ID plus a digest of the target key.
 * Digested because user IDs and group names are external strings that are
 * not key-safe.
 *
 * @param {string} appId
 * @param {string} targetKey - `user:<id>`, `group:<name>` or `everyone`.
 * @returns {string}
 */
export function shareMarkerKey(appId, targetKey) {
  return `${appId}.${digest(targetKey)}`;
}

/**
 * Key of the marker that puts an offered app into the receiver's list.
 *
 * @param {string} appId
 * @param {string} receiverId
 * @returns {string}
 */
export function offerMarkerKey(appId, receiverId) {
  return `${appId}.${digest(`offer:${receiverId}`)}`;
}

/** Key of the marker that counts an open offer for its sender. One per app. */
function offerSentMarkerKey(appId) {
  return `${appId}.${digest('offer-sent')}`;
}

/** The index a sender's open offers are filed under. */
function offerSenderIndex(senderId) {
  return `offer-by:${senderId}`;
}

/** The index the kept state of a deleted app is filed under. */
function deletedStatesIndex(ownerId) {
  return `deleted:${ownerId}`;
}

/**
 * Key of one content state. Zero-padded so the index lists them in order.
 *
 * @param {string} appId
 * @param {number} revision
 * @returns {string}
 */
export function revisionKey(appId, revision) {
  return `${appId}.${String(revision).padStart(8, '0')}`;
}

function actorOf(actor) {
  return { id: String(actor?.id ?? ''), name: String(actor?.name || actor?.id || '') };
}

/** One member entry as stored: the target, its display name and its role. */
function storedMember(member) {
  const type = member.type;
  return {
    type,
    id: type === 'everyone' ? null : String(member.id),
    name: String(member.name || member.id || ''),
    role: member.role === 'editor' ? 'editor' : 'user'
  };
}

/**
 * Every document of one index walk, bounded. With `includeData: false` the
 * documents come back without a body, which is all a delete cascade needs.
 */
async function collect(documents, ns, options, max = MAX_SCANNED) {
  const items = [];
  const withData = options?.includeData !== false;
  let cursor = null;
  do {
    const page = await documents.list(ns, {
      limit: PAGE_SIZE,
      includeData: true,
      ...options,
      ...(cursor ? { cursor } : {})
    });
    for (const doc of page.items) if (doc && (!withData || doc.data)) items.push(doc);
    cursor = page.nextCursor;
  } while (cursor && items.length < max);
  return items;
}

/**
 * Durable storage of personal apps.
 */
export class UserAppRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet; null makes every method a no-op.
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   *   Lock facet; null makes every method a no-op.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   * @param {() => string} [options.mintId] - ID minter, for tests.
   * @param {(id: string) => boolean} [options.isConfigAppId] - Whether a config
   *   app (enabled or not) has this ID. A minted ID never equals one.
   * @param {(user: Object) => Object} [options.snapshotOf] - The owner snapshot
   *   of a request user; defaults to `userAppOwnerSnapshot`.
   */
  constructor({
    documents = null,
    locks = null,
    logger: log,
    mintId = mintUserAppId,
    isConfigAppId = () => false,
    snapshotOf = userAppOwnerSnapshot
  } = {}) {
    this.documents = documents || null;
    this.locks = locks || null;
    this.logger = log || logger;
    this._mintId = mintId;
    this._isConfigAppId = isConfigAppId;
    this._snapshotOf = snapshotOf;
  }

  /**
   * Whether this repository can actually store anything.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.documents && this.locks);
  }

  _withLock(appId, fn) {
    return this.locks.withLock(`user-app:${appId}`, fn, LOCK_OPTIONS);
  }

  _withOwnerLock(ownerId, fn) {
    return this.locks.withLock(`user-app-owner:${ownerId}`, fn, LOCK_OPTIONS);
  }

  async _load(appId) {
    const doc = await this.documents.get(USER_APPS_NAMESPACE, appId);
    return { record: doc?.data || null, etag: doc ? doc.etag : null };
  }

  async _write(record, etag) {
    if (etag === undefined) {
      throw new StorageError('_write needs the etag the matching read returned', {
        code: 'INVALID_ARGUMENT'
      });
    }
    const doc = await this.documents.put(USER_APPS_NAMESPACE, record.id, record, {
      ownerId: String(record.owner.id),
      etag
    });
    return doc.data;
  }

  /** Store the content state of `record` and drop the states beyond the newest ones. */
  async _writeContentState(record) {
    await this.documents.put(
      USER_APP_REVISIONS_NAMESPACE,
      revisionKey(record.id, record.revision),
      {
        version: USER_APP_VERSION,
        appId: record.id,
        revision: record.revision,
        contentHash: record.contentHash,
        content: record.content,
        ownerId: String(record.owner.id),
        savedAt: record.updatedAt,
        savedBy: record.updatedBy
      },
      { ownerId: record.id }
    );
    // Keys sort by revision, so everything before the newest ones is the
    // oldest part of the list.
    const docs = await collect(this.documents, USER_APP_REVISIONS_NAMESPACE, {
      ownerId: record.id,
      includeData: false
    });
    const stale = docs.slice(0, Math.max(0, docs.length - MAX_CONTENT_STATES));
    for (const doc of stale) {
      await this.documents.delete(USER_APP_REVISIONS_NAMESPACE, doc.key);
    }
  }

  async _writeMemberMarkers(appId, targetKeys) {
    for (const targetKey of targetKeys) {
      await this.documents.put(
        USER_APP_SHARES_NAMESPACE,
        shareMarkerKey(appId, targetKey),
        { appId, target: targetKey, kind: 'member' },
        { ownerId: targetKey }
      );
    }
  }

  async _removeMemberMarkers(appId, targetKeys) {
    for (const targetKey of targetKeys) {
      await this.documents.delete(USER_APP_SHARES_NAMESPACE, shareMarkerKey(appId, targetKey));
    }
  }

  async _writeOfferMarkers(appId, offer) {
    const target = memberTargetKey({ type: 'user', id: offer.id });
    await this.documents.put(
      USER_APP_SHARES_NAMESPACE,
      offerMarkerKey(appId, offer.id),
      { appId, target, kind: 'offer' },
      { ownerId: target }
    );
    await this.documents.put(
      USER_APP_SHARES_NAMESPACE,
      offerSentMarkerKey(appId),
      { appId, kind: 'offerSent', senderId: offer.offeredBy.id },
      { ownerId: offerSenderIndex(offer.offeredBy.id) }
    );
  }

  async _removeOfferMarkers(appId, offer) {
    if (offer?.id) {
      await this.documents.delete(USER_APP_SHARES_NAMESPACE, offerMarkerKey(appId, offer.id));
    }
    await this.documents.delete(USER_APP_SHARES_NAMESPACE, offerSentMarkerKey(appId));
  }

  /** Remove the kept states of deleted apps of one owner that are past their time. */
  async _purgeDeletedStates(ownerId, { now = Date.now(), all = false } = {}) {
    const docs = await collect(this.documents, USER_APP_REVISIONS_NAMESPACE, {
      ownerId: deletedStatesIndex(ownerId)
    });
    let removed = 0;
    for (const doc of docs) {
      const deletedAt = Date.parse(doc.data?.deletedAt || '');
      if (all || !Number.isFinite(deletedAt) || now - deletedAt >= DELETED_STATE_TTL_MS) {
        await this.documents.delete(USER_APP_REVISIONS_NAMESPACE, doc.key);
        removed += 1;
      }
    }
    return removed;
  }

  async _mintFreeId() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this._mintId();
      if (!isUserAppId(id)) continue;
      if (this._isConfigAppId(id)) continue;
      if (await this.documents.get(USER_APPS_NAMESPACE, id)) continue;
      return id;
    }
    throw new StorageError('Could not mint a free app ID', { code: 'ID_UNAVAILABLE' });
  }

  /**
   * Run `fn` holding the lock of one person: what serializes the counts per
   * person. `create`, `setOffer` and `acceptOffer` take it themselves, so do
   * not call them inside `fn`.
   *
   * @template T
   * @param {string} ownerId - User ID.
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  withOwnerLock(ownerId, fn) {
    return this._withOwnerLock(String(ownerId), fn);
  }

  /**
   * Create a personal app owned by `owner`, and its first content state.
   *
   * The limit is counted under the owner's lock, so two parallel creates at
   * the limit yield one app. Promoted apps count too.
   *
   * @param {Object} options
   * @param {{id: string, name?: string}} options.owner - Owning user.
   * @param {Object} options.ownerPrincipal - The owner snapshot
   *   (`userAppOwnerSnapshot(req.user)`).
   * @param {Object} options.content - Validated content (`userAppContentSchema`).
   * @param {string} options.language - The content language at creation.
   * @param {'blank'|'template'|'generated'|'copy'} [options.origin='blank']
   * @param {number} [options.limit=0] - `limits.maxAppsPerUser`; zero means no limit.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The record, or null when it cannot be stored.
   * @throws {StorageError} Code `QUOTA_USER_APPS` when the owner is at the limit.
   */
  async create({
    owner,
    ownerPrincipal,
    content,
    language,
    origin = 'blank',
    limit = 0,
    now = new Date().toISOString()
  } = {}) {
    if (!this.isAvailable() || !owner?.id) return null;
    const actor = actorOf(owner);
    return this._withOwnerLock(actor.id, async () => {
      await this._purgeDeletedStates(actor.id, { now: Date.parse(now) }).catch(error =>
        this.logger.warn('Could not remove expired content states', {
          component: COMPONENT,
          error: error.message
        })
      );
      if (limit > 0 && (await this.countOwned(actor.id)) >= limit) {
        throw new StorageError('The limit of personal apps is reached', { code: QUOTA_APPS });
      }
      const id = await this._mintFreeId();
      const record = {
        version: USER_APP_VERSION,
        id,
        ownership: 'user',
        owner: actor,
        ownerPrincipal: ownerPrincipal || null,
        ownerPrincipalAt: now,
        pendingOwner: null,
        members: [],
        language: language || null,
        origin: USER_APP_ORIGINS.includes(origin) ? origin : 'blank',
        content,
        state: 'active',
        publishedAs: null,
        disabled: null,
        revision: 1,
        contentHash: contentHashOf(content),
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
        membersUpdatedAt: null,
        membersUpdatedBy: null,
        lastUsedAt: null
      };
      const stored = await this._write(record, null);
      await this._writeContentState(stored);
      return stored;
    });
  }

  /**
   * One personal app by ID.
   *
   * @param {string} appId
   * @returns {Promise<Object|null>} The record; null for an unknown ID and for
   *   an ID that does not have the personal shape.
   */
  async get(appId) {
    if (!this.isAvailable() || !isUserAppId(appId)) return null;
    return (await this._load(appId)).record;
  }

  /**
   * `get`, for the listings that read many apps: an app whose document
   * cannot be read is logged and answered with {@link UNREADABLE}, so the
   * caller can skip it, as `documents.list` skips a damaged document.
   *
   * @param {string} appId
   * @returns {Promise<Object|null|typeof UNREADABLE>}
   */
  async _getReadable(appId) {
    try {
      return await this.get(appId);
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      this.logger.warn('A personal app could not be read and is skipped', {
        component: COMPONENT,
        appId,
        code: error.code || null,
        error: error.message
      });
      return UNREADABLE;
    }
  }

  /**
   * Every app one user owns, promoted ones included.
   *
   * @param {string} ownerId
   * @returns {Promise<Object[]>}
   */
  async listOwned(ownerId) {
    if (!this.isAvailable() || !ownerId) return [];
    const docs = await collect(this.documents, USER_APPS_NAMESPACE, { ownerId: String(ownerId) });
    return docs.map(doc => doc.data);
  }

  /**
   * How many apps one user owns: what the limit counts.
   *
   * @param {string} ownerId
   * @returns {Promise<number>}
   */
  async countOwned(ownerId) {
    if (!this.isAvailable() || !ownerId) return 0;
    const docs = await collect(this.documents, USER_APPS_NAMESPACE, {
      ownerId: String(ownerId),
      includeData: false
    });
    return docs.length;
  }

  /**
   * The apps that reach any of `targetKeys` through a member entry or an
   * open offer, newest first.
   *
   * Answered from the markers, and checked against each document: a marker
   * without a matching member (or, for an offer marker, without that
   * receiver in `pendingOwner`) yields nothing and is removed. Whether the
   * caller may then use the app is still the permission function's answer.
   *
   * @param {string[]} targetKeys - `user:<id>`, `group:<name>`, `everyone`
   *   (`principalMemberKeys`).
   * @param {Object} [options]
   * @param {number} [options.limit=200] - Most apps returned.
   * @returns {Promise<Object[]>}
   */
  async listSharedWith(targetKeys, { limit = MAX_SHARED_LISTED } = {}) {
    if (!this.isAvailable()) return [];
    const keys = [...new Set(targetKeys || [])].filter(key => typeof key === 'string' && key);
    /** @type {Map<string, Array<{key: string, kind: string, target: string}>>} */
    const candidates = new Map();
    for (const targetKey of keys) {
      const docs = await collect(this.documents, USER_APP_SHARES_NAMESPACE, { ownerId: targetKey });
      for (const doc of docs) {
        const appId = doc.data?.appId;
        if (!isUserAppId(appId) || doc.data.target !== targetKey) continue;
        if (!candidates.has(appId)) candidates.set(appId, []);
        candidates.get(appId).push({ key: doc.key, kind: doc.data.kind, target: targetKey });
      }
      if (candidates.size >= MAX_SCANNED) break;
    }
    const records = [];
    for (const [appId, markers] of candidates) {
      // One unreadable app must not take every listing of its members down.
      // Its markers stay: the document may be repaired.
      const record = await this._getReadable(appId);
      if (record === UNREADABLE) continue;
      const memberKeys = new Set((record?.members || []).map(memberTargetKey));
      const offerTarget = record?.pendingOwner?.id
        ? memberTargetKey({ type: 'user', id: record.pendingOwner.id })
        : null;
      let backed = false;
      for (const marker of markers) {
        const holds =
          Boolean(record) &&
          (marker.kind === 'offer' ? marker.target === offerTarget : memberKeys.has(marker.target));
        if (holds) backed = true;
        // The document no longer backs this marker: tidy up rather than find
        // it again on every listing.
        else await this.documents.delete(USER_APP_SHARES_NAMESPACE, marker.key).catch(() => {});
      }
      if (backed) records.push(record);
    }
    records.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return limit > 0 ? records.slice(0, limit) : records;
  }

  /**
   * Walk every personal app, for the admin list. The cursor is the store's
   * own, so a following call continues without a gap or a repeat.
   *
   * @param {Object} [options]
   * @param {(record: Object) => boolean} [options.filter] - Keep only matches.
   * @param {number} [options.limit=50] - Most apps returned.
   * @param {string|null} [options.cursor] - `nextCursor` of the previous call.
   * @param {number} [options.maxScanned] - Most documents read in this call.
   * @returns {Promise<{items: Object[], nextCursor: string|null}>}
   * @throws {StorageError} Code `INVALID_CURSOR` for a cursor the store did not issue.
   */
  async scan({ filter = () => true, limit = 50, cursor = null, maxScanned = MAX_SCANNED } = {}) {
    if (!this.isAvailable()) return { items: [], nextCursor: null };
    const wanted = Math.max(1, Math.min(Number(limit) || 50, PAGE_SIZE));
    const items = [];
    let scanned = 0;
    let next = cursor || null;
    do {
      // Never ask for more than is still wanted: the page then cannot yield
      // more matches than fit, and its cursor is exactly where to go on.
      const page = await this.documents.list(USER_APPS_NAMESPACE, {
        limit: wanted - items.length,
        includeData: true,
        ...(next ? { cursor: next } : {})
      });
      for (const doc of page.items) {
        scanned += 1;
        if (doc?.data && filter(doc.data)) items.push(doc.data);
      }
      next = page.nextCursor;
    } while (next && items.length < wanted && scanned < maxScanned);
    return { items, nextCursor: next || null };
  }

  /**
   * The company-app IDs personal apps still hold: `publishedAs.appId` of a
   * promoted record and `publishing.appId` of a publish in progress, in
   * lower case. A publish never hands out one of them, so a released ID
   * cannot point an earlier record at somebody else's app.
   *
   * @param {Object} [options]
   * @param {string|null} [options.exceptAppId] - The record being published:
   *   its own mark does not count.
   * @returns {Promise<Set<string>>}
   */
  async heldCompanyAppIds({ exceptAppId = null } = {}) {
    const held = new Set();
    if (!this.isAvailable()) return held;
    const docs = await collect(this.documents, USER_APPS_NAMESPACE, { includeData: true });
    for (const doc of docs) {
      const record = doc.data;
      if (!record || record.id === exceptAppId) continue;
      const published = record.state === 'promoted' ? record.publishedAs?.appId : null;
      for (const id of [published, record.publishing?.appId]) {
        if (typeof id === 'string' && id) held.add(id.toLowerCase());
      }
    }
    return held;
  }

  /**
   * Change a record under its lock. For the changes that are not content,
   * members or an offer: switching an app off and on, the marks of a publish,
   * a release.
   *
   * `change` gets the stored record and returns the next one, or a falsy
   * value to leave it. `id`, `owner`, `members`, `pendingOwner`, `content`
   * and `contentHash` are taken from the stored record whatever `change`
   * returns: those have their own methods.
   *
   * @param {string} appId
   * @param {(record: Object) => Object|null|undefined} change
   * @param {Object} [options]
   * @param {(record: Object) => boolean} [options.authorize] - Access check,
   *   run on the record as loaded under the lock.
   * @param {number} [options.expectedRevision] - The revision of `If-Match`.
   * @param {boolean} [options.bumpRevision=true] - Whether the change is one a
   *   person can see.
   * @returns {Promise<Object|null>} The record, or null when there is none.
   * @throws {StorageError} `USER_APP_ACCESS_CHANGED`, `ETAG_MISMATCH`.
   */
  async mutate(appId, change, { authorize, expectedRevision, bumpRevision = true } = {}) {
    if (!this.isAvailable() || !isUserAppId(appId)) return null;
    return this._withLock(appId, async () => {
      const { record, etag } = await this._load(appId);
      if (!record) return null;
      assertAuthorized(authorize, record);
      assertRevision(expectedRevision, record);
      const changed = change({ ...record });
      if (!changed) return record;
      const next = {
        ...changed,
        id: record.id,
        version: USER_APP_VERSION,
        ownership: 'user',
        owner: record.owner,
        members: record.members,
        pendingOwner: record.pendingOwner,
        content: record.content,
        contentHash: record.contentHash,
        revision: bumpRevision ? (Number(record.revision) || 1) + 1 : record.revision
      };
      return this._write(next, etag);
    });
  }

  /**
   * Save new content. A save that changes nothing writes nothing, except the
   * owner snapshot when the owner saves.
   *
   * @param {string} appId
   * @param {Object} content - Validated content (`userAppContentSchema`).
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - Who saved.
   * @param {number} [options.expectedRevision] - The revision of `If-Match`.
   * @param {Object} [options.ownerPrincipal] - The owner snapshot; stored when
   *   the actor is the owner.
   * @param {boolean} [options.release=false] - Store that a promoted app whose
   *   company app is gone is `active` again.
   * @param {(record: Object) => boolean} [options.authorize] - Access check,
   *   run on the record as loaded under the lock.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The record, or null when there is none.
   * @throws {StorageError} `USER_APP_ACCESS_CHANGED`, `ETAG_MISMATCH`.
   */
  async update(
    appId,
    content,
    {
      actor,
      expectedRevision,
      ownerPrincipal,
      release = false,
      authorize,
      now = new Date().toISOString()
    } = {}
  ) {
    if (!this.isAvailable() || !isUserAppId(appId)) return null;
    return this._withLock(appId, async () => {
      const { record, etag } = await this._load(appId);
      if (!record) return null;
      assertAuthorized(authorize, record);
      assertRevision(expectedRevision, record);
      const who = actorOf(actor);
      const byOwner = who.id === String(record.owner.id);
      const contentHash = contentHashOf(content);
      const contentChanged = contentHash !== record.contentHash;
      const released = release && record.state === 'promoted';
      const snapshot = byOwner && ownerPrincipal ? ownerPrincipal : null;
      if (!contentChanged && !released && !snapshot) return record;
      const next = { ...record };
      if (snapshot) {
        next.ownerPrincipal = snapshot;
        next.ownerPrincipalAt = now;
      }
      if (released) {
        next.state = 'active';
        next.publishedAs = null;
      }
      if (contentChanged) {
        next.content = content;
        next.contentHash = contentHash;
        next.updatedAt = now;
        next.updatedBy = who;
      }
      if (contentChanged || released) next.revision = (Number(record.revision) || 1) + 1;
      const stored = await this._write(next, etag);
      if (contentChanged) await this._writeContentState(stored);
      return stored;
    });
  }

  /**
   * Replace the member list.
   *
   * The document is written first: it is the authority, so a target dropped
   * from the list loses access the moment this write lands. An entry that
   * names the owner is left out; an owner needs none.
   *
   * @param {string} appId
   * @param {Array<{type: string, id?: string|null, name?: string, role: string}>} members
   *   The complete new list, already validated and resolved.
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - Who changed it.
   * @param {number} [options.expectedRevision] - The revision of `If-Match`.
   * @param {(record: Object) => boolean} [options.authorize]
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<{record: Object, added: string[], removed: string[],
   *   changed: string[]}|null>} The record and the target keys that were
   *   added, removed and given another role.
   * @throws {StorageError} `USER_APP_ACCESS_CHANGED`, `ETAG_MISMATCH`.
   */
  async setMembers(
    appId,
    members,
    { actor, expectedRevision, authorize, now = new Date().toISOString() } = {}
  ) {
    if (!this.isAvailable() || !isUserAppId(appId)) return null;
    return this._withLock(appId, async () => {
      const { record, etag } = await this._load(appId);
      if (!record) return null;
      assertAuthorized(authorize, record);
      assertRevision(expectedRevision, record);
      const ownerKey = memberTargetKey({ type: 'user', id: String(record.owner.id) });
      const byKey = new Map();
      for (const member of members || []) {
        const entry = storedMember(member);
        const key = memberTargetKey(entry);
        if (key !== ownerKey) byKey.set(key, entry);
      }
      const before = new Map((record.members || []).map(m => [memberTargetKey(m), m]));
      const stored = await this._write(
        {
          ...record,
          members: [...byKey.values()],
          membersUpdatedAt: now,
          membersUpdatedBy: actorOf(actor),
          revision: (Number(record.revision) || 1) + 1
        },
        etag
      );
      const added = [...byKey.keys()].filter(key => !before.has(key));
      const removed = [...before.keys()].filter(key => !byKey.has(key));
      const changed = [...byKey.keys()].filter(
        key => before.has(key) && before.get(key).role !== byKey.get(key).role
      );
      // Every current target gets its marker rewritten, not only the new
      // ones: a marker lost to an earlier failure is repaired by the next save.
      await this._writeMemberMarkers(appId, [...byKey.keys()]);
      await this._removeMemberMarkers(appId, removed);
      return { record: stored, added, removed, changed };
    });
  }

  /**
   * Remove one member entry: a member leaves, or a deleted user is dropped
   * from the apps of others.
   *
   * @param {string} appId
   * @param {string} targetKey - `user:<id>`, `group:<name>` or `everyone`.
   * @param {Object} [options]
   * @param {{id: string, name?: string}} [options.actor]
   * @param {(record: Object) => boolean} [options.authorize]
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<{record: Object, removed: boolean}|null>}
   * @throws {StorageError} `USER_APP_ACCESS_CHANGED`.
   */
  async removeMember(appId, targetKey, { actor, authorize, now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !isUserAppId(appId)) return null;
    return this._withLock(appId, async () => {
      const { record, etag } = await this._load(appId);
      if (!record) return null;
      assertAuthorized(authorize, record);
      const members = (record.members || []).filter(m => memberTargetKey(m) !== targetKey);
      if (members.length === (record.members || []).length) {
        await this._removeMemberMarkers(appId, [targetKey]);
        return { record, removed: false };
      }
      const stored = await this._write(
        {
          ...record,
          members,
          membersUpdatedAt: now,
          membersUpdatedBy: actor ? actorOf(actor) : record.membersUpdatedBy,
          revision: (Number(record.revision) || 1) + 1
        },
        etag
      );
      await this._removeMemberMarkers(appId, [targetKey]);
      return { record: stored, removed: true };
    });
  }

  /**
   * How many offers one person has open, checked against each document.
   *
   * @param {string} senderId
   * @param {Object} [options]
   * @param {string} [options.exceptAppId] - An app whose offer is about to be replaced.
   * @param {number} [options.now] - Clock in milliseconds, for tests.
   * @returns {Promise<number>}
   */
  async countOpenOffers(senderId, { exceptAppId = null, now = Date.now() } = {}) {
    if (!this.isAvailable() || !senderId) return 0;
    const docs = await collect(this.documents, USER_APP_SHARES_NAMESPACE, {
      ownerId: offerSenderIndex(String(senderId))
    });
    let open = 0;
    for (const doc of docs) {
      const appId = doc.data?.appId;
      if (!isUserAppId(appId) || appId === exceptAppId) continue;
      // An unreadable app is not counted: nobody can accept its offer meanwhile.
      const record = await this._getReadable(appId);
      if (record === UNREADABLE) continue;
      const offer = openOffer(record, now);
      if (offer && String(offer.offeredBy?.id) === String(senderId)) open += 1;
    }
    return open;
  }

  /**
   * Offer an app to a new owner. The record keeps its owner and gains
   * `pendingOwner`; a second call replaces the offer.
   *
   * The sender's open offers are counted under the sender's lock.
   *
   * @param {string} appId
   * @param {{id: string, name?: string}} receiver - The user the app is offered to.
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - The sender: the owner or a full admin.
   * @param {number} [options.maxOpenOffers=0] - `limits.maxOpenOffersPerUser`; zero means no limit.
   * @param {number} [options.expectedRevision] - The revision of `If-Match`.
   * @param {(record: Object) => boolean} [options.authorize]
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The record with `pendingOwner`, or null when there is none.
   * @throws {StorageError} `QUOTA_USER_APP_OFFERS`, `USER_APP_ACCESS_CHANGED`, `ETAG_MISMATCH`.
   */
  async setOffer(
    appId,
    receiver,
    { actor, maxOpenOffers = 0, expectedRevision, authorize, now = new Date().toISOString() } = {}
  ) {
    if (!this.isAvailable() || !isUserAppId(appId) || !receiver?.id || !actor?.id) return null;
    const sender = actorOf(actor);
    return this._withOwnerLock(sender.id, async () => {
      if (maxOpenOffers > 0) {
        const open = await this.countOpenOffers(sender.id, {
          exceptAppId: appId,
          now: Date.parse(now)
        });
        if (open >= maxOpenOffers) {
          throw new StorageError('The limit of open offers is reached', { code: QUOTA_OFFERS });
        }
      }
      return this._withLock(appId, async () => {
        const { record, etag } = await this._load(appId);
        if (!record) return null;
        assertAuthorized(authorize, record);
        assertRevision(expectedRevision, record);
        const previous = record.pendingOwner;
        const offer = { ...actorOf(receiver), offeredAt: now, offeredBy: sender };
        const stored = await this._write(
          { ...record, pendingOwner: offer, revision: (Number(record.revision) || 1) + 1 },
          etag
        );
        if (previous?.id && String(previous.id) !== offer.id) {
          await this.documents.delete(
            USER_APP_SHARES_NAMESPACE,
            offerMarkerKey(appId, previous.id)
          );
        }
        await this._writeOfferMarkers(appId, offer);
        return stored;
      });
    });
  }

  /**
   * Remove an offer: withdrawn by the owner, declined by the receiver, or
   * found lapsed.
   *
   * @param {string} appId
   * @param {Object} [options]
   * @param {(record: Object) => boolean} [options.authorize]
   * @param {boolean} [options.bumpRevision=true] - False for an offer found lapsed on a read:
   *   a lapsed offer already reads as none, so nothing a client holds changes, and an
   *   `If-Match` of before the read stays valid.
   * @returns {Promise<{record: Object, offer: Object|null}|null>} The record
   *   and the offer that was removed (null when there was none).
   * @throws {StorageError} `USER_APP_ACCESS_CHANGED`.
   */
  async clearOffer(appId, { authorize, bumpRevision = true } = {}) {
    if (!this.isAvailable() || !isUserAppId(appId)) return null;
    return this._withLock(appId, async () => {
      const { record, etag } = await this._load(appId);
      if (!record) return null;
      assertAuthorized(authorize, record);
      const offer = record.pendingOwner || null;
      if (!offer) return { record, offer: null };
      const stored = await this._write(
        {
          ...record,
          pendingOwner: null,
          revision: (Number(record.revision) || 1) + (bumpRevision ? 1 : 0)
        },
        etag
      );
      await this._removeOfferMarkers(appId, offer);
      return { record: stored, offer };
    });
  }

  /**
   * The receiver accepts an open offer. In one write: the receiver becomes
   * the owner, the owner snapshot is theirs, their own membership is dropped,
   * every "Can edit" member becomes "Can use", the offer is cleared.
   *
   * Runs under the receiver's lock and the app's lock, so the receiver's
   * limit cannot be passed by two accepts at once.
   *
   * @param {string} appId
   * @param {Object} options
   * @param {{id: string, name?: string}} options.receiver - The caller.
   * @param {Object} options.ownerPrincipal - The receiver's owner snapshot.
   * @param {number} options.expectedRevision - The revision the receiver read. Required.
   * @param {number} [options.limit=0] - `limits.maxAppsPerUser`; zero means no limit.
   * @param {(record: Object) => boolean} [options.authorize]
   * @param {(record: Object) => boolean} [options.release] - Whether the same
   *   write stores that a promoted record whose company app is gone is
   *   `active` again.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<{record: Object, previousOwner: {id: string, name: string},
   *   downgraded: number}|null>} Null when there is no such app.
   * @throws {StorageError} `ETAG_MISMATCH`, `USER_APP_NO_OFFER`, `QUOTA_USER_APPS`,
   *   `USER_APP_ACCESS_CHANGED`; `INVALID_ARGUMENT` without `expectedRevision`.
   */
  async acceptOffer(
    appId,
    {
      receiver,
      ownerPrincipal,
      expectedRevision,
      limit = 0,
      authorize,
      release,
      now = new Date().toISOString()
    } = {}
  ) {
    if (!this.isAvailable() || !isUserAppId(appId) || !receiver?.id) return null;
    if (expectedRevision == null || !Number.isInteger(Number(expectedRevision))) {
      throw new StorageError('acceptOffer needs the revision the receiver read', {
        code: 'INVALID_ARGUMENT'
      });
    }
    const newOwner = actorOf(receiver);
    return this._withOwnerLock(newOwner.id, () =>
      this._withLock(appId, async () => {
        const { record, etag } = await this._load(appId);
        if (!record) return null;
        const offer = openOffer(record, Date.parse(now));
        if (!offer || String(offer.id) !== newOwner.id) {
          throw new StorageError('There is no open offer for you on this app', { code: NO_OFFER });
        }
        assertAuthorized(authorize, record);
        assertRevision(expectedRevision, record);
        if (limit > 0 && (await this.countOwned(newOwner.id)) >= limit) {
          throw new StorageError('The limit of personal apps is reached', { code: QUOTA_APPS });
        }
        const ownKey = memberTargetKey({ type: 'user', id: newOwner.id });
        const kept = (record.members || []).filter(m => memberTargetKey(m) !== ownKey);
        const droppedOwn = kept.length !== (record.members || []).length;
        const downgraded = kept.filter(m => m.role === 'editor').length;
        const previousOwner = record.owner;
        const stored = await this._write(
          {
            ...record,
            owner: newOwner,
            ownerPrincipal: ownerPrincipal || null,
            ownerPrincipalAt: now,
            members: kept.map(m => (m.role === 'editor' ? { ...m, role: 'user' } : m)),
            membersUpdatedAt: droppedOwn || downgraded > 0 ? now : record.membersUpdatedAt,
            membersUpdatedBy:
              droppedOwn || downgraded > 0 ? newOwner : record.membersUpdatedBy || null,
            pendingOwner: null,
            // The receiver read this content before accepting: it counts as
            // theirs for the approval mode until somebody else changes it.
            contentConfirmedBy: { id: newOwner.id, contentHash: record.contentHash || null },
            ...(typeof release === 'function' && release(record)
              ? { state: 'active', publishedAs: null }
              : {}),
            revision: (Number(record.revision) || 1) + 1
          },
          etag
        );
        // The owner index moved with the write above. What is left are the
        // markers the document no longer backs.
        if (droppedOwn) await this._removeMemberMarkers(appId, [ownKey]);
        await this._removeOfferMarkers(appId, offer);
        return { record: stored, previousOwner, downgraded };
      })
    );
  }

  /**
   * Record that a chat resolved the app. Writes at most once a day per app.
   *
   * @param {string} appId
   * @param {Object} [options]
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<boolean>} Whether `lastUsedAt` was written.
   */
  async touchLastUsed(appId, { now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !isUserAppId(appId)) return false;
    const fresh = record => {
      const last = Date.parse(record?.lastUsedAt || '');
      return Number.isFinite(last) && Date.parse(now) - last < LAST_USED_INTERVAL_MS;
    };
    const { record: seen } = await this._load(appId);
    if (!seen || fresh(seen)) return false;
    return this._withLock(appId, async () => {
      const { record, etag } = await this._load(appId);
      if (!record || fresh(record)) return false;
      await this._write({ ...record, lastUsedAt: now }, etag);
      return true;
    });
  }

  /**
   * Rewrite the owner snapshot of every app `user` owns whose snapshot
   * differs from the request or is older than a day (design 6.2). One call
   * refreshes all of the owner's apps; the revision does not change.
   *
   * @param {Object} user - `req.user` of the owner.
   * @param {Object} [options]
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<number>} How many apps were rewritten.
   */
  async refreshOwnerPrincipal(user, { now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !user?.id) return 0;
    const clock = Date.parse(now);
    const owned = await this.listOwned(user.id);
    const due = owned.filter(record => ownerSnapshotNeedsRefresh(record, user, clock));
    if (due.length === 0) return 0;
    const snapshot = this._snapshotOf(user);
    let written = 0;
    for (const { id } of due) {
      try {
        const done = await this._withLock(id, async () => {
          const { record, etag } = await this._load(id);
          // Handed over since the listing: the snapshot is the new owner's.
          if (!record || String(record.owner.id) !== String(user.id)) return false;
          if (!ownerSnapshotNeedsRefresh(record, user, clock)) return false;
          await this._write({ ...record, ownerPrincipal: snapshot, ownerPrincipalAt: now }, etag);
          return true;
        });
        if (done) written += 1;
      } catch (error) {
        this.logger.warn('Could not refresh the owner snapshot of a personal app', {
          component: COMPONENT,
          appId: id,
          error: error.message
        });
      }
    }
    return written;
  }

  /**
   * The stored content states of an app, newest first.
   *
   * @param {string} appId
   * @returns {Promise<Array<{appId: string, revision: number, contentHash: string,
   *   content: Object, ownerId: string, savedAt: string, savedBy: Object}>>}
   */
  async listRevisions(appId) {
    if (!this.isAvailable() || !isUserAppId(appId)) return [];
    const docs = await collect(this.documents, USER_APP_REVISIONS_NAMESPACE, { ownerId: appId });
    return docs.map(doc => doc.data).sort((a, b) => b.revision - a.revision);
  }

  /**
   * The kept states of the deleted apps of one owner, newest deletion first.
   *
   * @param {string} ownerId
   * @returns {Promise<Object[]>} Content states with `deletedAt`.
   */
  async listDeletedStates(ownerId) {
    if (!this.isAvailable() || !ownerId) return [];
    const docs = await collect(this.documents, USER_APP_REVISIONS_NAMESPACE, {
      ownerId: deletedStatesIndex(String(ownerId))
    });
    return docs
      .map(doc => doc.data)
      .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  }

  /**
   * Remove the kept states of the deleted apps of one owner.
   *
   * @param {string} ownerId
   * @param {Object} [options]
   * @param {boolean} [options.all=false] - Remove every one, not only those
   *   past their time: for deleting the user account.
   * @param {number} [options.now] - Clock in milliseconds, for tests.
   * @returns {Promise<number>} How many were removed.
   */
  async purgeDeletedStates(ownerId, { all = false, now = Date.now() } = {}) {
    if (!this.isAvailable() || !ownerId) return 0;
    return this._withOwnerLock(String(ownerId), () =>
      this._purgeDeletedStates(String(ownerId), { all, now })
    );
  }

  /**
   * Remove an app, its markers and its content states. The newest state is
   * kept for 90 days with `deletedAt`, unless `keepLastState` is false.
   *
   * The document goes first: it is what every listing resolves through, so a
   * failure part-way leaves unreachable markers and states rather than an app
   * that is half gone.
   *
   * @param {string} appId
   * @param {Object} [options]
   * @param {(record: Object) => boolean} [options.authorize] - Access check,
   *   run on the record as loaded under the lock.
   * @param {boolean} [options.keepLastState=true] - False when the owner's
   *   account is deleted: nothing of the app stays.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The record that was removed, or null.
   * @throws {StorageError} `USER_APP_ACCESS_CHANGED`.
   */
  async delete(appId, { authorize, keepLastState = true, now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !isUserAppId(appId)) return null;
    const removed = await this._withLock(appId, async () => {
      const { record } = await this._load(appId);
      if (!record) return null;
      assertAuthorized(authorize, record);
      await this.documents.delete(USER_APPS_NAMESPACE, appId);
      try {
        await this._removeMemberMarkers(appId, (record.members || []).map(memberTargetKey));
        await this._removeOfferMarkers(appId, record.pendingOwner);
        const states = await collect(this.documents, USER_APP_REVISIONS_NAMESPACE, {
          ownerId: appId
        });
        const newest = keepLastState ? states[states.length - 1] : null;
        for (const doc of states) {
          if (doc === newest) continue;
          await this.documents.delete(USER_APP_REVISIONS_NAMESPACE, doc.key);
        }
        if (newest) {
          // Filed under the owner from here on, so the owner's next create
          // or delete finds it when its time is up.
          await this.documents.put(
            USER_APP_REVISIONS_NAMESPACE,
            newest.key,
            { ...newest.data, ownerId: String(record.owner.id), deletedAt: now },
            { ownerId: deletedStatesIndex(String(record.owner.id)) }
          );
        }
      } catch (error) {
        this.logger.error('Removed a personal app but not all of its markers and states', {
          component: COMPONENT,
          appId,
          error: error.message
        });
      }
      return record;
    });
    if (removed) {
      // After the app's lock is released: an offer takes the owner's lock
      // first and the app's second, and the two must never wait on each other.
      await this.purgeDeletedStates(removed.owner.id, { now: Date.parse(now) }).catch(error =>
        this.logger.warn('Could not remove expired content states', {
          component: COMPONENT,
          error: error.message
        })
      );
    }
    return removed;
  }
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * The process-wide repository over the bootstrapped storage provider. A
 * minted ID is checked against every config app, disabled ones included.
 *
 * @returns {UserAppRepository}
 */
export function getUserAppRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new UserAppRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks'),
      logger,
      isConfigAppId: id => (configCache.getApps(true)?.data || []).some(app => app?.id === id)
    });
  }
  return cachedRepository;
}

export default UserAppRepository;
