/**
 * UserPromptRepository — prompts users write themselves, on top of the storage
 * abstraction.
 *
 * Four kinds of documents:
 *
 *   `user-prompts/<promptId>`                 the prompt: text, variables, shares
 *   `user-prompt-versions/<promptId>.<rev>`   one per saved revision
 *   `user-prompt-shares/<promptId>.<h>`       one marker per share target
 *   `prompt-preferences/<h(userId)>`          a user's favorites and recents
 *
 * The prompt document is filed under its **owner** as the document owner, so
 * "my prompts" is an index read. A version is filed under its prompt, so the
 * history of one prompt is an index read too, and deleting a prompt can take
 * its history with it.
 *
 * The share markers follow the recipient-marker pattern of
 * `ChatShareRepository`: each is filed under the principal it reaches —
 * `user:<id>`, `group:<name>` or `everyone` — so "shared with me" is a handful
 * of index reads (one per group the caller is in) rather than a scan of every
 * prompt. The markers are an index, never the authority: the share list on
 * the prompt document decides, and a marker the document no longer backs is
 * ignored and pruned. That is also what makes revoking immediate — the
 * document is rewritten first, the markers go after.
 *
 * Every read-modify-write runs under `locks.withLock('user-prompt:<id>')`.
 *
 * @module services/prompts/UserPromptRepository
 */
import { createHash, randomBytes } from 'crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { StorageError } from '../../storage/errors.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { shareTargetKey } from './userPromptAccess.js';

const COMPONENT = 'UserPromptRepository';

/** Namespace holding the prompt documents. */
export const USER_PROMPTS_NAMESPACE = RUNTIME_NAMESPACES.userPrompts;

/** Namespace holding the saved revisions. */
export const USER_PROMPT_VERSIONS_NAMESPACE = RUNTIME_NAMESPACES.userPromptVersions;

/** Namespace holding the share markers. */
export const USER_PROMPT_SHARES_NAMESPACE = RUNTIME_NAMESPACES.userPromptShares;

/** Namespace holding per-user favorites and recents. */
export const PROMPT_PREFERENCES_NAMESPACE = RUNTIME_NAMESPACES.promptPreferences;

/** Schema version stamped on every document written here. */
export const USER_PROMPT_VERSION = 1;

/** Prefix on every user prompt id — what tells one apart from a global prompt id. */
export const USER_PROMPT_ID_PREFIX = 'upr_';

/** Random bytes in a user prompt id: 16 bytes, 22 URL-safe characters. */
const ID_BYTES = 16;

/** The fields of a prompt that make up a revision. */
export const CONTENT_FIELDS = Object.freeze([
  'name',
  'description',
  'prompt',
  'icon',
  'category',
  'appId',
  'variables'
]);

/** Most favorites one user keeps. */
export const MAX_FAVORITES = 500;

/** Most recents one user keeps, and how long one counts as recent. */
export const MAX_RECENTS = 20;
export const RECENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Documents per `list` call while walking an index. */
const PAGE_SIZE = 200;

/** Hard bound on documents walked for one listing. */
const MAX_SCANNED = 5000;

/** Lock lease for one prompt write — the same shape the chat repositories use. */
const LOCK_OPTIONS = { ttlMs: 15000, waitMs: 5000 };

/**
 * Mint a user prompt id.
 *
 * @returns {string}
 */
export function mintUserPromptId() {
  return `${USER_PROMPT_ID_PREFIX}${randomBytes(ID_BYTES).toString('base64url')}`;
}

/**
 * Whether a string can be a user prompt id: key-safe and shaped like one this
 * module mints. Checked before any lookup so an arbitrary path segment never
 * reaches the store, and so a global prompt id is never looked up here.
 *
 * @param {unknown} id - Candidate.
 * @returns {boolean}
 */
export function isUserPromptId(id) {
  return (
    typeof id === 'string' &&
    id.startsWith(USER_PROMPT_ID_PREFIX) &&
    id.length > USER_PROMPT_ID_PREFIX.length &&
    isValidId(id)
  );
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

/**
 * Key of one share marker: the prompt id plus a digest of the target key.
 * Digested because user ids and group names are external strings that are
 * not key-safe; the raw target is the marker's document owner and its data.
 *
 * @param {string} promptId - Prompt id.
 * @param {string} targetKey - `user:<id>`, `group:<name>` or `everyone`.
 * @returns {string}
 */
export function shareMarkerKey(promptId, targetKey) {
  return `${promptId}.${digest(targetKey)}`;
}

/**
 * Key of one saved revision. Zero-padded so the index lists them in order.
 *
 * @param {string} promptId - Prompt id.
 * @param {number} revision - Revision number.
 * @returns {string}
 */
export function versionKey(promptId, revision) {
  return `${promptId}.${String(revision).padStart(8, '0')}`;
}

/**
 * Key of one user's preferences document.
 *
 * @param {string} userId - User id.
 * @returns {string}
 */
export function preferencesKey(userId) {
  return `pp_${digest(userId)}`;
}

/**
 * Just the revisioned fields of a prompt.
 *
 * @param {Object} source - A prompt or a content payload.
 * @returns {Object}
 */
export function pickContent(source = {}) {
  return {
    name: String(source.name || ''),
    description: String(source.description || ''),
    prompt: String(source.prompt || ''),
    icon: source.icon ? String(source.icon) : null,
    category: source.category ? String(source.category) : null,
    appId: source.appId ? String(source.appId) : null,
    variables: Array.isArray(source.variables) ? source.variables : []
  };
}

function contentEquals(a, b) {
  return JSON.stringify(pickContent(a)) === JSON.stringify(pickContent(b));
}

function actorOf(actor) {
  return { id: String(actor?.id ?? ''), name: String(actor?.name || actor?.id || '') };
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
 * Durable user prompt storage.
 */
export class UserPromptRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet; null makes every method a no-op.
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   *   Lock facet; null makes every method a no-op.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   * @param {() => string} [options.mintId] - Id minter, for tests.
   */
  constructor({ documents = null, locks = null, logger: log, mintId = mintUserPromptId } = {}) {
    this.documents = documents || null;
    this.locks = locks || null;
    this.logger = log || logger;
    this._mintId = mintId;
  }

  /**
   * Whether this repository can actually store anything.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.documents && this.locks);
  }

  _withLock(promptId, fn) {
    return this.locks.withLock(`user-prompt:${promptId}`, fn, LOCK_OPTIONS);
  }

  async _load(promptId) {
    const doc = await this.documents.get(USER_PROMPTS_NAMESPACE, promptId);
    return { prompt: doc?.data || null, etag: doc ? doc.etag : null };
  }

  async _write(prompt, etag) {
    if (etag === undefined) {
      throw new StorageError('_write needs the etag the matching read returned', {
        code: 'INVALID_ARGUMENT'
      });
    }
    const doc = await this.documents.put(USER_PROMPTS_NAMESPACE, prompt.id, prompt, {
      ownerId: prompt.ownerId,
      etag
    });
    return doc.data;
  }

  async _writeVersion(prompt, maxVersions) {
    await this.documents.put(
      USER_PROMPT_VERSIONS_NAMESPACE,
      versionKey(prompt.id, prompt.revision),
      {
        version: USER_PROMPT_VERSION,
        promptId: prompt.id,
        revision: prompt.revision,
        ...pickContent(prompt),
        savedAt: prompt.updatedAt,
        savedBy: prompt.updatedBy,
        ...(prompt.restoredFrom ? { restoredFrom: prompt.restoredFrom } : {})
      },
      { ownerId: prompt.id }
    );
    if (maxVersions > 0 && prompt.revision > maxVersions) {
      // Keys sort by revision, so everything before the newest `maxVersions`
      // is the oldest part of the list.
      const docs = await collect(this.documents, USER_PROMPT_VERSIONS_NAMESPACE, {
        ownerId: prompt.id,
        includeData: false
      });
      const stale = docs.slice(0, Math.max(0, docs.length - maxVersions));
      for (const doc of stale) {
        await this.documents.delete(USER_PROMPT_VERSIONS_NAMESPACE, doc.key);
      }
    }
  }

  async _writeMarkers(prompt, targetKeys) {
    for (const targetKey of targetKeys) {
      await this.documents.put(
        USER_PROMPT_SHARES_NAMESPACE,
        shareMarkerKey(prompt.id, targetKey),
        { promptId: prompt.id, target: targetKey },
        { ownerId: targetKey }
      );
    }
  }

  async _removeMarkers(promptId, targetKeys) {
    for (const targetKey of targetKeys) {
      await this.documents.delete(
        USER_PROMPT_SHARES_NAMESPACE,
        shareMarkerKey(promptId, targetKey)
      );
    }
  }

  /**
   * Create a prompt owned by `owner`, and its first revision.
   *
   * @param {Object} options
   * @param {{id: string, name?: string}} options.owner - Owning user.
   * @param {Object} options.content - Revisioned fields.
   * @param {Object|null} [options.copiedFrom] - `{ scope, id }` of the prompt
   *   this one was duplicated from.
   * @param {number} [options.maxVersions] - Revisions kept per prompt.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The prompt, or null when it cannot be stored.
   */
  async create({
    owner,
    content,
    copiedFrom = null,
    maxVersions = 0,
    now = new Date().toISOString()
  } = {}) {
    if (!this.isAvailable() || !owner?.id) return null;
    let id = this._mintId();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await this.documents.get(USER_PROMPTS_NAMESPACE, id))) break;
      id = this._mintId();
    }
    const actor = actorOf(owner);
    const prompt = {
      version: USER_PROMPT_VERSION,
      id,
      ownerId: actor.id,
      ownerName: actor.name,
      ...pickContent(content),
      shares: [],
      revision: 1,
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
      copiedFrom: copiedFrom || null,
      promotedTo: null
    };
    const stored = await this._write(prompt, null);
    await this._writeVersion(stored, maxVersions);
    return stored;
  }

  /**
   * One prompt by id.
   *
   * @param {string} promptId - Prompt id.
   * @returns {Promise<Object|null>}
   */
  async get(promptId) {
    if (!this.isAvailable() || !isUserPromptId(promptId)) return null;
    return (await this._load(promptId)).prompt;
  }

  /**
   * Every prompt one user owns.
   *
   * @param {string} ownerId - Owner user id.
   * @returns {Promise<Object[]>}
   */
  async listOwned(ownerId) {
    if (!this.isAvailable() || !ownerId) return [];
    const docs = await collect(this.documents, USER_PROMPTS_NAMESPACE, {
      ownerId: String(ownerId)
    });
    return docs.map(doc => doc.data);
  }

  /**
   * How many prompts one user owns.
   *
   * @param {string} ownerId - Owner user id.
   * @returns {Promise<number>}
   */
  async countOwned(ownerId) {
    return (await this.listOwned(ownerId)).length;
  }

  /**
   * The prompts that have a share marker filed under any of `targetKeys`.
   *
   * Whether a marker's prompt still carries that share is for the caller's
   * access check to decide — the document is the authority. A marker whose
   * prompt is gone is pruned on the way.
   *
   * @param {string[]} targetKeys - `user:<id>`, `group:<name>`, `everyone`.
   * @returns {Promise<Object[]>}
   */
  async listSharedWith(targetKeys) {
    if (!this.isAvailable()) return [];
    const promptIds = new Set();
    for (const targetKey of [...new Set(targetKeys || [])]) {
      if (typeof targetKey !== 'string' || !targetKey) continue;
      const docs = await collect(this.documents, USER_PROMPT_SHARES_NAMESPACE, {
        ownerId: targetKey
      });
      for (const doc of docs) {
        if (isUserPromptId(doc.data?.promptId)) promptIds.add(doc.data.promptId);
      }
      if (promptIds.size >= MAX_SCANNED) break;
    }
    const prompts = [];
    for (const promptId of promptIds) {
      const prompt = await this.get(promptId);
      if (prompt) {
        prompts.push(prompt);
        continue;
      }
      // The prompt went, its markers did not: tidy up rather than find the
      // same dangling marker on every listing.
      for (const targetKey of targetKeys) {
        await this.documents
          .delete(USER_PROMPT_SHARES_NAMESPACE, shareMarkerKey(promptId, targetKey))
          .catch(() => {});
      }
    }
    return prompts;
  }

  /**
   * Walk every prompt — for the admin page only. Bounded, and the bound is
   * reported so the page can say the list is cut.
   *
   * @param {Object} [options]
   * @param {(prompt: Object) => boolean} [options.filter] - Keep only matches.
   * @param {number} [options.max] - Most prompts to return.
   * @returns {Promise<{prompts: Object[], truncated: boolean}>}
   */
  async scan({ filter = () => true, max = MAX_SCANNED } = {}) {
    if (!this.isAvailable()) return { prompts: [], truncated: false };
    const prompts = [];
    let cursor = null;
    let truncated = false;
    do {
      const page = await this.documents.list(USER_PROMPTS_NAMESPACE, {
        limit: PAGE_SIZE,
        includeData: true,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) {
        if (doc?.data && filter(doc.data)) prompts.push(doc.data);
      }
      cursor = page.nextCursor;
      if (cursor && prompts.length >= max) truncated = true;
    } while (cursor && !truncated);
    return { prompts, truncated };
  }

  /**
   * Save new content as the next revision. A save that changes nothing
   * writes nothing.
   *
   * @param {string} promptId - Prompt id.
   * @param {Object} content - Revisioned fields.
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - Who saved.
   * @param {number} [options.expectedRevision] - Refuse the save when the
   *   stored revision differs — two editors must not silently overwrite each
   *   other.
   * @param {number|null} [options.restoredFrom] - Revision this save restores.
   * @param {number} [options.maxVersions] - Revisions kept per prompt.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The prompt, or null when there is none.
   * @throws {StorageError} Code `REVISION_CONFLICT` when `expectedRevision` is stale.
   */
  async update(
    promptId,
    content,
    { actor, expectedRevision, restoredFrom = null, maxVersions = 0, now } = {}
  ) {
    if (!this.isAvailable() || !isUserPromptId(promptId)) return null;
    return this._withLock(promptId, async () => {
      const { prompt, etag } = await this._load(promptId);
      if (!prompt) return null;
      if (Number.isInteger(expectedRevision) && expectedRevision !== prompt.revision) {
        throw new StorageError('The prompt was changed by someone else', {
          code: 'REVISION_CONFLICT'
        });
      }
      if (contentEquals(prompt, content) && restoredFrom === null) return prompt;
      const next = {
        ...prompt,
        ...pickContent(content),
        revision: (Number(prompt.revision) || 1) + 1,
        updatedAt: now || new Date().toISOString(),
        updatedBy: actorOf(actor)
      };
      delete next.restoredFrom;
      if (restoredFrom !== null) next.restoredFrom = restoredFrom;
      const stored = await this._write(next, etag);
      await this._writeVersion(stored, maxVersions);
      return stored;
    });
  }

  /**
   * Replace the share list.
   *
   * The prompt document is written first: it is the authority, so a target
   * dropped from the list loses access the moment this write lands, and a
   * failure afterwards only leaves a marker that no longer opens anything.
   * New markers go in after it for the same reason.
   *
   * @param {string} promptId - Prompt id.
   * @param {Array<Object>} shares - The complete new list, already validated.
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - Who changed it.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<{prompt: Object, added: string[], removed: string[]}|null>}
   */
  async setShares(promptId, shares, { actor, now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !isUserPromptId(promptId)) return null;
    return this._withLock(promptId, async () => {
      const { prompt, etag } = await this._load(promptId);
      if (!prompt) return null;
      const before = new Set((prompt.shares || []).map(shareTargetKey));
      const after = new Set(shares.map(shareTargetKey));
      const stored = await this._write(
        { ...prompt, shares, sharesUpdatedAt: now, sharesUpdatedBy: actorOf(actor) },
        etag
      );
      const added = [...after].filter(key => !before.has(key));
      const removed = [...before].filter(key => !after.has(key));
      // Every current target gets its marker rewritten, not only the new
      // ones: a marker lost to an earlier failure is repaired by the next save.
      await this._writeMarkers(stored, [...after]);
      await this._removeMarkers(promptId, removed);
      return { prompt: stored, added, removed };
    });
  }

  /**
   * Hand a prompt to another user. A share to the new owner is dropped — an
   * owner needs none.
   *
   * @param {string} promptId - Prompt id.
   * @param {{id: string, name?: string}} newOwner - The new owner.
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - Who handed it over.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>}
   */
  async transfer(promptId, newOwner, { actor, now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !isUserPromptId(promptId) || !newOwner?.id) return null;
    return this._withLock(promptId, async () => {
      const { prompt, etag } = await this._load(promptId);
      if (!prompt) return null;
      const owner = actorOf(newOwner);
      const ownerKey = shareTargetKey({ type: 'user', id: owner.id });
      const shares = (prompt.shares || []).filter(share => shareTargetKey(share) !== ownerKey);
      const dropped = shares.length !== (prompt.shares || []).length;
      const stored = await this._write(
        {
          ...prompt,
          ownerId: owner.id,
          ownerName: owner.name,
          shares,
          transferredAt: now,
          transferredBy: actorOf(actor)
        },
        etag
      );
      if (dropped) await this._removeMarkers(promptId, [ownerKey]);
      return stored;
    });
  }

  /**
   * Record that an admin promoted this prompt to a global one.
   *
   * @param {string} promptId - Prompt id.
   * @param {{promptId: string, at: string, by: Object}} promotion
   * @returns {Promise<Object|null>}
   */
  async markPromoted(promptId, promotion) {
    if (!this.isAvailable() || !isUserPromptId(promptId)) return null;
    return this._withLock(promptId, async () => {
      const { prompt, etag } = await this._load(promptId);
      if (!prompt) return null;
      return this._write({ ...prompt, promotedTo: promotion }, etag);
    });
  }

  /**
   * Every saved revision of a prompt, newest first.
   *
   * @param {string} promptId - Prompt id.
   * @returns {Promise<Object[]>}
   */
  async listVersions(promptId) {
    if (!this.isAvailable() || !isUserPromptId(promptId)) return [];
    const docs = await collect(this.documents, USER_PROMPT_VERSIONS_NAMESPACE, {
      ownerId: promptId
    });
    return docs.map(doc => doc.data).sort((a, b) => b.revision - a.revision);
  }

  /**
   * One saved revision.
   *
   * @param {string} promptId - Prompt id.
   * @param {number} revision - Revision number.
   * @returns {Promise<Object|null>}
   */
  async getVersion(promptId, revision) {
    if (!this.isAvailable() || !isUserPromptId(promptId)) return null;
    if (!Number.isInteger(revision) || revision < 1) return null;
    const doc = await this.documents.get(
      USER_PROMPT_VERSIONS_NAMESPACE,
      versionKey(promptId, revision)
    );
    return doc?.data || null;
  }

  /**
   * Remove a prompt, its share markers and its history.
   *
   * Prompt document first: it is what every listing resolves through, so a
   * failure part-way leaves unreachable markers and versions rather than a
   * prompt that is half gone.
   *
   * @param {string} promptId - Prompt id.
   * @returns {Promise<Object|null>} The prompt that was removed, or null.
   */
  async delete(promptId) {
    if (!this.isAvailable() || !isUserPromptId(promptId)) return null;
    return this._withLock(promptId, async () => {
      const { prompt } = await this._load(promptId);
      if (!prompt) return null;
      await this.documents.delete(USER_PROMPTS_NAMESPACE, promptId);
      try {
        await this._removeMarkers(promptId, (prompt.shares || []).map(shareTargetKey));
        const versions = await collect(this.documents, USER_PROMPT_VERSIONS_NAMESPACE, {
          ownerId: promptId,
          includeData: false
        });
        for (const doc of versions) {
          await this.documents.delete(USER_PROMPT_VERSIONS_NAMESPACE, doc.key);
        }
      } catch (error) {
        this.logger.error('Removed a user prompt but not all of its markers and versions', {
          component: COMPONENT,
          promptId,
          error: error.message
        });
      }
      return prompt;
    });
  }

  /**
   * One user's favorites and recents. `stored` says whether the user has any
   * server-side preferences yet — the client uses it to carry over what the
   * browser remembered before they moved to the server.
   *
   * @param {string} userId - User id.
   * @param {Object} [options]
   * @param {number} [options.now] - Clock, for tests.
   * @returns {Promise<{favorites: string[], recents: Array<{id: string, at: string}>,
   *   stored: boolean}>}
   */
  async getPreferences(userId, { now = Date.now() } = {}) {
    const empty = { favorites: [], recents: [], stored: false };
    if (!this.isAvailable() || !userId) return empty;
    const doc = await this.documents.get(PROMPT_PREFERENCES_NAMESPACE, preferencesKey(userId));
    if (!doc?.data || String(doc.data.userId) !== String(userId)) return empty;
    return {
      favorites: Array.isArray(doc.data.favorites) ? doc.data.favorites : [],
      recents: (Array.isArray(doc.data.recents) ? doc.data.recents : []).filter(entry => {
        const at = Date.parse(entry?.at || '');
        return Number.isFinite(at) && now - at < RECENT_TTL_MS;
      }),
      stored: true
    };
  }

  async _updatePreferences(userId, mutate) {
    const key = preferencesKey(userId);
    return this.locks.withLock(
      `prompt-preferences:${key}`,
      async () => {
        const doc = await this.documents.get(PROMPT_PREFERENCES_NAMESPACE, key);
        const current =
          doc?.data && String(doc.data.userId) === String(userId)
            ? doc.data
            : { version: USER_PROMPT_VERSION, userId: String(userId), favorites: [], recents: [] };
        const next = mutate({
          ...current,
          favorites: Array.isArray(current.favorites) ? current.favorites : [],
          recents: Array.isArray(current.recents) ? current.recents : []
        });
        await this.documents.put(PROMPT_PREFERENCES_NAMESPACE, key, next, {
          ownerId: String(userId),
          etag: doc ? doc.etag : null
        });
        return next;
      },
      LOCK_OPTIONS
    );
  }

  /**
   * Replace one user's favorites, and optionally their recents — the
   * one-time carry-over from the browser sends both.
   *
   * @param {string} userId - User id.
   * @param {Object} update
   * @param {string[]} [update.favorites] - Prompt ids, global or user.
   * @param {Array<{id: string, at: string}>} [update.recents] - Recents to merge in.
   * @returns {Promise<Object|null>}
   */
  async setPreferences(userId, { favorites, recents } = {}) {
    if (!this.isAvailable() || !userId) return null;
    return this._updatePreferences(userId, current => {
      const next = { ...current };
      if (Array.isArray(favorites)) {
        next.favorites = [...new Set(favorites.filter(isValidId))].slice(0, MAX_FAVORITES);
      }
      if (Array.isArray(recents)) {
        next.recents = mergeRecents(current.recents, recents);
      }
      return next;
    });
  }

  /**
   * Record one use of a prompt.
   *
   * @param {string} userId - User id.
   * @param {string} promptId - Prompt id, global or user.
   * @param {Object} [options]
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>}
   */
  async recordUsage(userId, promptId, { now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !userId || !isValidId(promptId)) return null;
    return this._updatePreferences(userId, current => ({
      ...current,
      recents: mergeRecents(current.recents, [{ id: promptId, at: now }])
    }));
  }
}

/**
 * Merge recents: newest use of each id wins, newest first, capped.
 *
 * @param {Array<{id: string, at: string}>} current
 * @param {Array<{id: string, at: string}>} incoming
 * @returns {Array<{id: string, at: string}>}
 */
export function mergeRecents(current = [], incoming = []) {
  const latest = new Map();
  for (const entry of [...current, ...incoming]) {
    if (!entry || !isValidId(entry.id)) continue;
    const at = Date.parse(entry.at || '');
    if (!Number.isFinite(at)) continue;
    const previous = latest.get(entry.id);
    if (!previous || at > previous) latest.set(entry.id, at);
  }
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RECENTS)
    .map(([id, at]) => ({ id, at: new Date(at).toISOString() }));
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * The process-wide repository over the bootstrapped storage provider.
 *
 * @returns {UserPromptRepository}
 */
export function getUserPromptRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new UserPromptRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks'),
      logger
    });
  }
  return cachedRepository;
}

export default UserPromptRepository;
