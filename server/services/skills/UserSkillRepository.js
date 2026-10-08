/**
 * UserSkillRepository — skills users write themselves, on top of the storage
 * abstraction. The same design as `UserPromptRepository`:
 *
 *   `user-skills/<skillId>`                 the skill: instructions, files, shares
 *   `user-skill-versions/<skillId>.<rev>`   one per saved revision
 *   `user-skill-shares/<skillId>.<h>`       one marker per share target
 *
 * A skill document is filed under its **owner**, so "my skills" is an index
 * read; a version under its skill, so a skill's history is an index read and
 * goes with the skill when it is deleted. Share markers are filed under the
 * principal they reach (`user:<id>`, `group:<name>`, `everyone`); they are an
 * index, never the authority — the share list on the skill decides, and the
 * document is rewritten before markers are removed, so revoking is immediate.
 *
 * A global skill is a folder (`SKILL.md` plus reference files). A user skill
 * keeps the same parts in one document — `name`, `description`, `body` and
 * `files` — so a revision snapshots all of them at once. The routes cap the
 * size, which keeps a document small.
 *
 * Every read-modify-write runs under `locks.withLock('user-skill:<id>')`.
 *
 * @module services/skills/UserSkillRepository
 */
import { createHash, randomBytes } from 'node:crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { StorageError } from '../../storage/errors.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { shareTargetKey } from '../prompts/userPromptAccess.js';

const COMPONENT = 'UserSkillRepository';

/** Namespace holding the skill documents. */
export const USER_SKILLS_NAMESPACE = RUNTIME_NAMESPACES.userSkills;

/** Namespace holding the saved revisions. */
export const USER_SKILL_VERSIONS_NAMESPACE = RUNTIME_NAMESPACES.userSkillVersions;

/** Namespace holding the share markers. */
export const USER_SKILL_SHARES_NAMESPACE = RUNTIME_NAMESPACES.userSkillShares;

/** Schema version stamped on every document written here. */
export const USER_SKILL_VERSION = 1;

/** Prefix on every user skill id — what tells one apart from a global skill name. */
export const USER_SKILL_ID_PREFIX = 'usk_';

/** Random bytes in a user skill id: 16 bytes, 22 URL-safe characters. */
const ID_BYTES = 16;

/** Documents per `list` call while walking an index. */
const PAGE_SIZE = 200;

/** Hard bound on documents walked for one listing. */
const MAX_SCANNED = 5000;

/** Lock lease for one skill write. */
const LOCK_OPTIONS = { ttlMs: 15000, waitMs: 5000 };

/**
 * Code of the error a write throws when its `authorize` check fails on the
 * skill loaded under the lock — the caller's access changed between the
 * route's own check and the write.
 */
export const ACCESS_CHANGED = 'SKILL_ACCESS_CHANGED';

function assertAuthorized(authorize, skill) {
  if (typeof authorize === 'function' && !authorize(skill)) {
    throw new StorageError('Your access to this skill changed', { code: ACCESS_CHANGED });
  }
}

/**
 * Mint a user skill id.
 *
 * @returns {string}
 */
export function mintUserSkillId() {
  return `${USER_SKILL_ID_PREFIX}${randomBytes(ID_BYTES).toString('base64url')}`;
}

/**
 * Whether a string can be a user skill id: key-safe and shaped like one this
 * module mints. Checked before any lookup so an arbitrary path segment never
 * reaches the store, and so a global skill name is never looked up here.
 *
 * @param {unknown} id - Candidate.
 * @returns {boolean}
 */
export function isUserSkillId(id) {
  return (
    typeof id === 'string' &&
    id.startsWith(USER_SKILL_ID_PREFIX) &&
    id.length > USER_SKILL_ID_PREFIX.length &&
    isValidId(id)
  );
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

/**
 * Key of one share marker: the skill id plus a digest of the target key.
 *
 * @param {string} skillId - Skill id.
 * @param {string} targetKey - `user:<id>`, `group:<name>` or `everyone`.
 * @returns {string}
 */
export function shareMarkerKey(skillId, targetKey) {
  return `${skillId}.${digest(targetKey)}`;
}

/**
 * Key of one saved revision. Zero-padded so the index lists them in order.
 *
 * @param {string} skillId - Skill id.
 * @param {number} revision - Revision number.
 * @returns {string}
 */
export function versionKey(skillId, revision) {
  return `${skillId}.${String(revision).padStart(8, '0')}`;
}

/**
 * Just the revisioned fields of a skill.
 *
 * @param {Object} source - A skill or a content payload.
 * @returns {{name: string, description: string, body: string,
 *   files: Array<{path: string, content: string}>}}
 */
export function pickContent(source = {}) {
  return {
    name: String(source.name || ''),
    description: String(source.description || ''),
    body: String(source.body || ''),
    files: Array.isArray(source.files)
      ? source.files.map(file => ({ path: String(file.path), content: String(file.content ?? '') }))
      : []
  };
}

function contentEquals(a, b) {
  return JSON.stringify(pickContent(a)) === JSON.stringify(pickContent(b));
}

function actorOf(actor) {
  return { id: String(actor?.id ?? ''), name: String(actor?.name || actor?.id || '') };
}

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
 * Durable user skill storage.
 */
export class UserSkillRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet; null makes every method a no-op.
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   *   Lock facet; null makes every method a no-op.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   * @param {() => string} [options.mintId] - Id minter, for tests.
   */
  constructor({ documents = null, locks = null, logger: log, mintId = mintUserSkillId } = {}) {
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

  _withLock(skillId, fn) {
    return this.locks.withLock(`user-skill:${skillId}`, fn, LOCK_OPTIONS);
  }

  async _load(skillId) {
    const doc = await this.documents.get(USER_SKILLS_NAMESPACE, skillId);
    return { skill: doc?.data || null, etag: doc ? doc.etag : null };
  }

  async _write(skill, etag) {
    if (etag === undefined) {
      throw new StorageError('_write needs the etag the matching read returned', {
        code: 'INVALID_ARGUMENT'
      });
    }
    const doc = await this.documents.put(USER_SKILLS_NAMESPACE, skill.id, skill, {
      ownerId: skill.ownerId,
      etag
    });
    return doc.data;
  }

  async _writeVersion(skill, maxVersions) {
    await this.documents.put(
      USER_SKILL_VERSIONS_NAMESPACE,
      versionKey(skill.id, skill.revision),
      {
        version: USER_SKILL_VERSION,
        skillId: skill.id,
        revision: skill.revision,
        ...pickContent(skill),
        savedAt: skill.updatedAt,
        savedBy: skill.updatedBy,
        ...(skill.restoredFrom ? { restoredFrom: skill.restoredFrom } : {})
      },
      { ownerId: skill.id }
    );
    if (maxVersions > 0 && skill.revision > maxVersions) {
      const docs = await collect(this.documents, USER_SKILL_VERSIONS_NAMESPACE, {
        ownerId: skill.id,
        includeData: false
      });
      const stale = docs.slice(0, Math.max(0, docs.length - maxVersions));
      for (const doc of stale) {
        await this.documents.delete(USER_SKILL_VERSIONS_NAMESPACE, doc.key);
      }
    }
  }

  async _writeMarkers(skill, targetKeys) {
    for (const targetKey of targetKeys) {
      await this.documents.put(
        USER_SKILL_SHARES_NAMESPACE,
        shareMarkerKey(skill.id, targetKey),
        { skillId: skill.id, target: targetKey },
        { ownerId: targetKey }
      );
    }
  }

  async _removeMarkers(skillId, targetKeys) {
    for (const targetKey of targetKeys) {
      await this.documents.delete(USER_SKILL_SHARES_NAMESPACE, shareMarkerKey(skillId, targetKey));
    }
  }

  /**
   * Create a skill owned by `owner`, and its first revision.
   *
   * @param {Object} options
   * @param {{id: string, name?: string}} options.owner - Owning user.
   * @param {Object} options.content - Revisioned fields.
   * @param {Object|null} [options.copiedFrom] - `{ scope, id }` of the skill this one copies.
   * @param {number} [options.maxVersions] - Revisions kept per skill.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>} The skill, or null when it cannot be stored.
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
      if (!(await this.documents.get(USER_SKILLS_NAMESPACE, id))) break;
      id = this._mintId();
    }
    const actor = actorOf(owner);
    const skill = {
      version: USER_SKILL_VERSION,
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
    const stored = await this._write(skill, null);
    await this._writeVersion(stored, maxVersions);
    return stored;
  }

  /**
   * One skill by id.
   *
   * @param {string} skillId - Skill id.
   * @returns {Promise<Object|null>}
   */
  async get(skillId) {
    if (!this.isAvailable() || !isUserSkillId(skillId)) return null;
    return (await this._load(skillId)).skill;
  }

  /**
   * Every skill one user owns.
   *
   * @param {string} ownerId - Owner user id.
   * @returns {Promise<Object[]>}
   */
  async listOwned(ownerId) {
    if (!this.isAvailable() || !ownerId) return [];
    const docs = await collect(this.documents, USER_SKILLS_NAMESPACE, {
      ownerId: String(ownerId)
    });
    return docs.map(doc => doc.data);
  }

  /**
   * How many skills one user owns.
   *
   * @param {string} ownerId - Owner user id.
   * @returns {Promise<number>}
   */
  async countOwned(ownerId) {
    return (await this.listOwned(ownerId)).length;
  }

  /**
   * The skills that have a share marker filed under any of `targetKeys`. The
   * caller's access check decides whether a share still holds; a marker whose
   * skill is gone is pruned on the way.
   *
   * @param {string[]} targetKeys - `user:<id>`, `group:<name>`, `everyone`.
   * @returns {Promise<Object[]>}
   */
  async listSharedWith(targetKeys) {
    if (!this.isAvailable()) return [];
    const skillIds = new Set();
    for (const targetKey of [...new Set(targetKeys || [])]) {
      if (typeof targetKey !== 'string' || !targetKey) continue;
      const docs = await collect(this.documents, USER_SKILL_SHARES_NAMESPACE, {
        ownerId: targetKey
      });
      for (const doc of docs) {
        if (isUserSkillId(doc.data?.skillId)) skillIds.add(doc.data.skillId);
      }
      if (skillIds.size >= MAX_SCANNED) break;
    }
    const skills = [];
    for (const skillId of skillIds) {
      const skill = await this.get(skillId);
      if (skill) {
        skills.push(skill);
        continue;
      }
      for (const targetKey of targetKeys) {
        await this.documents
          .delete(USER_SKILL_SHARES_NAMESPACE, shareMarkerKey(skillId, targetKey))
          .catch(() => {});
      }
    }
    return skills;
  }

  /**
   * Walk every skill — for the admin page only, bounded by documents read and
   * skills returned; hitting either bound is reported.
   *
   * @param {Object} [options]
   * @param {(skill: Object) => boolean} [options.filter] - Keep only matches.
   * @param {number} [options.max] - Most skills to return.
   * @param {number} [options.maxScanned] - Most documents to read.
   * @returns {Promise<{skills: Object[], truncated: boolean}>}
   */
  async scan({ filter = () => true, max = MAX_SCANNED, maxScanned = MAX_SCANNED } = {}) {
    if (!this.isAvailable()) return { skills: [], truncated: false };
    const skills = [];
    let scanned = 0;
    let cursor = null;
    do {
      const page = await this.documents.list(USER_SKILLS_NAMESPACE, {
        limit: PAGE_SIZE,
        includeData: true,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items) {
        if (scanned >= maxScanned || skills.length >= max) return { skills, truncated: true };
        scanned += 1;
        if (doc?.data && filter(doc.data)) skills.push(doc.data);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { skills, truncated: false };
  }

  /**
   * Save new content as the next revision. A save that changes nothing writes
   * nothing.
   *
   * @param {string} skillId - Skill id.
   * @param {Object} content - Revisioned fields.
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - Who saved.
   * @param {number} [options.expectedRevision] - Refuse the save when the stored revision differs.
   * @param {number|null} [options.restoredFrom] - Revision this save restores.
   * @param {number} [options.maxVersions] - Revisions kept per skill.
   * @param {(skill: Object) => boolean} [options.authorize] - Access check under the lock.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>}
   * @throws {StorageError} `REVISION_CONFLICT`, `SKILL_ACCESS_CHANGED`.
   */
  async update(
    skillId,
    content,
    { actor, expectedRevision, restoredFrom = null, maxVersions = 0, authorize, now } = {}
  ) {
    if (!this.isAvailable() || !isUserSkillId(skillId)) return null;
    return this._withLock(skillId, async () => {
      const { skill, etag } = await this._load(skillId);
      if (!skill) return null;
      assertAuthorized(authorize, skill);
      if (Number.isInteger(expectedRevision) && expectedRevision !== skill.revision) {
        throw new StorageError('The skill was changed by someone else', {
          code: 'REVISION_CONFLICT'
        });
      }
      if (contentEquals(skill, content) && restoredFrom === null) return skill;
      const next = {
        ...skill,
        ...pickContent(content),
        revision: (Number(skill.revision) || 1) + 1,
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
   * Replace the share list — document first, then markers.
   *
   * @param {string} skillId - Skill id.
   * @param {Array<Object>} shares - The complete new list, already validated.
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - Who changed it.
   * @param {(skill: Object) => boolean} [options.authorize] - Access check under the lock.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<{skill: Object, added: string[], removed: string[]}|null>}
   */
  async setShares(skillId, shares, { actor, authorize, now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !isUserSkillId(skillId)) return null;
    return this._withLock(skillId, async () => {
      const { skill, etag } = await this._load(skillId);
      if (!skill) return null;
      assertAuthorized(authorize, skill);
      const before = new Set((skill.shares || []).map(shareTargetKey));
      const after = new Set(shares.map(share => shareTargetKey(share)));
      const stored = await this._write(
        { ...skill, shares, sharesUpdatedAt: now, sharesUpdatedBy: actorOf(actor) },
        etag
      );
      const added = [...after].filter(key => !before.has(key));
      const removed = [...before].filter(key => !after.has(key));
      await this._writeMarkers(stored, [...after]);
      await this._removeMarkers(skillId, removed);
      return { skill: stored, added, removed };
    });
  }

  /**
   * Hand a skill to another user. A share to the new owner is dropped.
   *
   * @param {string} skillId - Skill id.
   * @param {{id: string, name?: string}} newOwner - The new owner.
   * @param {Object} options
   * @param {{id: string, name?: string}} options.actor - Who handed it over.
   * @param {(skill: Object) => boolean} [options.authorize] - Access check under the lock.
   * @param {string} [options.now] - ISO clock, for tests.
   * @returns {Promise<Object|null>}
   */
  async transfer(skillId, newOwner, { actor, authorize, now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !isUserSkillId(skillId) || !newOwner?.id) return null;
    return this._withLock(skillId, async () => {
      const { skill, etag } = await this._load(skillId);
      if (!skill) return null;
      assertAuthorized(authorize, skill);
      const owner = actorOf(newOwner);
      const ownerKey = shareTargetKey({ type: 'user', id: owner.id });
      const shares = (skill.shares || []).filter(share => shareTargetKey(share) !== ownerKey);
      const dropped = shares.length !== (skill.shares || []).length;
      const stored = await this._write(
        {
          ...skill,
          ownerId: owner.id,
          ownerName: owner.name,
          shares,
          transferredAt: now,
          transferredBy: actorOf(actor)
        },
        etag
      );
      if (dropped) await this._removeMarkers(skillId, [ownerKey]);
      return stored;
    });
  }

  /**
   * Record that an admin promoted this skill to a global one.
   *
   * @param {string} skillId - Skill id.
   * @param {{skillName: string, at: string, by: Object}} promotion
   * @returns {Promise<Object|null>}
   */
  async markPromoted(skillId, promotion) {
    if (!this.isAvailable() || !isUserSkillId(skillId)) return null;
    return this._withLock(skillId, async () => {
      const { skill, etag } = await this._load(skillId);
      if (!skill) return null;
      return this._write({ ...skill, promotedTo: promotion }, etag);
    });
  }

  /**
   * Every saved revision of a skill, newest first.
   *
   * @param {string} skillId - Skill id.
   * @returns {Promise<Object[]>}
   */
  async listVersions(skillId) {
    if (!this.isAvailable() || !isUserSkillId(skillId)) return [];
    const docs = await collect(this.documents, USER_SKILL_VERSIONS_NAMESPACE, {
      ownerId: skillId
    });
    return docs.map(doc => doc.data).sort((a, b) => b.revision - a.revision);
  }

  /**
   * One saved revision.
   *
   * @param {string} skillId - Skill id.
   * @param {number} revision - Revision number.
   * @returns {Promise<Object|null>}
   */
  async getVersion(skillId, revision) {
    if (!this.isAvailable() || !isUserSkillId(skillId)) return null;
    if (!Number.isInteger(revision) || revision < 1) return null;
    const doc = await this.documents.get(
      USER_SKILL_VERSIONS_NAMESPACE,
      versionKey(skillId, revision)
    );
    return doc?.data || null;
  }

  /**
   * Remove a skill, its share markers and its history — document first.
   *
   * @param {string} skillId - Skill id.
   * @param {Object} [options]
   * @param {(skill: Object) => boolean} [options.authorize] - Access check under the lock.
   * @returns {Promise<Object|null>} The skill that was removed, or null.
   */
  async delete(skillId, { authorize } = {}) {
    if (!this.isAvailable() || !isUserSkillId(skillId)) return null;
    return this._withLock(skillId, async () => {
      const { skill } = await this._load(skillId);
      if (!skill) return null;
      assertAuthorized(authorize, skill);
      await this.documents.delete(USER_SKILLS_NAMESPACE, skillId);
      try {
        await this._removeMarkers(skillId, (skill.shares || []).map(shareTargetKey));
        const versions = await collect(this.documents, USER_SKILL_VERSIONS_NAMESPACE, {
          ownerId: skillId,
          includeData: false
        });
        for (const doc of versions) {
          await this.documents.delete(USER_SKILL_VERSIONS_NAMESPACE, doc.key);
        }
      } catch (error) {
        this.logger.error('Removed a user skill but not all of its markers and versions', {
          component: COMPONENT,
          skillId,
          error: error.message
        });
      }
      return skill;
    });
  }
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * The process-wide repository over the bootstrapped storage provider.
 *
 * @returns {UserSkillRepository}
 */
export function getUserSkillRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new UserSkillRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks'),
      logger
    });
  }
  return cachedRepository;
}

export default UserSkillRepository;
