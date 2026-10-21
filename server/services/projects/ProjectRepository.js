// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ProjectRepository — projects of both ownerships behind one class.
 *
 * Four kinds of documents (spec 1 §8.1):
 *
 *   `projects/<id>.json`                      admin projects: configuration under `contents/`,
 *                                             read and written through `ConfigStore`
 *   `user-projects/<prj_…>`                   user projects, filed under the owner
 *   `user-project-shares/<prj_…>.<h(target)>` one marker per member target, filed under the
 *                                             principal it reaches (the prompt-share pattern)
 *   `project-chats/<projectId>__<chatId>`     one marker per chat inside a project, filed under
 *                                             the project id
 *
 * and the `project-files` blob namespace, keyed `<projectId>__<itemId>__<version>`.
 *
 * The markers are an index, never the authority: the member list on the
 * project and the `projectId` on the chat decide, and a marker the document
 * no longer backs is ignored and pruned. Every read-modify-write of a user
 * project runs under `locks.withLock('project:<id>')` with the etag of the
 * read; an admin project goes through `ConfigStore.updateJson`, which is
 * compare-and-set across workers.
 *
 * Authorization is the caller's: a mutation takes an `authorize(project)`
 * callback that is re-run on the project as loaded under the lock, as
 * `UserPromptRepository` does.
 *
 * @module services/projects/ProjectRepository
 */
import { createHash, randomBytes } from 'node:crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { StorageError } from '../../storage/errors.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { BLOB_NAMESPACES, RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import configStore from '../config/ConfigStore.js';
import configCache from '../../configCache.js';
import { memberTargetKey } from './projectAccess.js';

const COMPONENT = 'ProjectRepository';

/** Namespace holding user projects. */
export const USER_PROJECTS_NAMESPACE = RUNTIME_NAMESPACES.userProjects;

/** Namespace holding the member markers of user projects. */
export const USER_PROJECT_SHARES_NAMESPACE = RUNTIME_NAMESPACES.userProjectShares;

/** Namespace holding the chat markers of projects. */
export const PROJECT_CHATS_NAMESPACE = RUNTIME_NAMESPACES.projectChats;

/** Blob namespace holding the encrypted item text. */
export const PROJECT_FILES_NAMESPACE = BLOB_NAMESPACES.projectFiles;

/** Directory under `contents/` holding admin projects. */
export const ADMIN_PROJECTS_DIR = 'projects';

/** Schema version stamped on every project document written here. */
export const PROJECT_VERSION = 1;

/** Prefix on every user project id — what tells one apart from an admin project id. */
export const USER_PROJECT_ID_PREFIX = 'prj_';

/** Prefix on every item id. */
export const ITEM_ID_PREFIX = 'itm_';

/** Random bytes in a minted id: 16 bytes, 22 URL-safe characters. */
const ID_BYTES = 16;

/** Documents per `list` call while walking an index. */
const PAGE_SIZE = 200;

/** Hard bound on documents walked for one listing. */
const MAX_SCANNED = 5000;

/** Lock lease for one project write — the shape the chat repositories use. */
const LOCK_OPTIONS = { ttlMs: 15000, waitMs: 5000 };

/**
 * Code of the error a write throws when its `authorize` check fails on the
 * project loaded under the lock — the caller's access changed between the
 * route's own check and the write.
 */
export const ACCESS_CHANGED = 'PROJECT_ACCESS_CHANGED';

function assertAuthorized(authorize, project) {
  if (typeof authorize === 'function' && !authorize(project)) {
    throw new StorageError('Your access to this project changed', { code: ACCESS_CHANGED });
  }
}

/** Mint a user project id. */
export function mintProjectId() {
  return `${USER_PROJECT_ID_PREFIX}${randomBytes(ID_BYTES).toString('base64url')}`;
}

/** Mint an item id. */
export function mintItemId() {
  return `${ITEM_ID_PREFIX}${randomBytes(ID_BYTES).toString('base64url')}`;
}

/**
 * Whether a string can be a user project id: key-safe and shaped like one
 * this module mints.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isUserProjectId(id) {
  return (
    typeof id === 'string' &&
    id.startsWith(USER_PROJECT_ID_PREFIX) &&
    id.length > USER_PROJECT_ID_PREFIX.length &&
    isValidId(id)
  );
}

/**
 * Whether a string can be an admin project id: a safe id that is not shaped
 * like a user project id, at most 50 characters (the source id rule).
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isAdminProjectId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 50 &&
    isValidId(id) &&
    !id.startsWith(USER_PROJECT_ID_PREFIX)
  );
}

/** Whether a string is a possible project id of either ownership. */
export function isProjectId(id) {
  return isUserProjectId(id) || isAdminProjectId(id);
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

/**
 * Key of one member marker: the project id plus a digest of the target key.
 *
 * @param {string} projectId
 * @param {string} targetKey - `user:<id>`, `group:<name>` or `everyone`.
 * @returns {string}
 */
export function memberMarkerKey(projectId, targetKey) {
  return `${projectId}.${digest(targetKey)}`;
}

/**
 * Key of one chat marker.
 *
 * @param {string} projectId
 * @param {string} chatId
 * @returns {string}
 */
export function chatMarkerKey(projectId, chatId) {
  return `${projectId}__${chatId}`;
}

/** Prefix of every blob key of one project. */
export function blobPrefix(projectId) {
  return `${projectId}__`;
}

function actorOf(actor) {
  return { id: String(actor?.id ?? ''), name: String(actor?.name || actor?.id || '') };
}

function adminPath(id) {
  return `${ADMIN_PROJECTS_DIR}/${id}.json`;
}

/**
 * Every document of one index walk, bounded.
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
 * Durable project storage.
 */
export class ProjectRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   * @param {import('../../storage/BlobStore.js').BlobStore|null} [options.blobs]
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   * @param {Object} [options.config] - Config store for admin projects; defaults to `configStore`.
   * @param {() => Promise<void>} [options.onAdminChange] - Called after an admin project write.
   * @param {Object} [options.logger]
   * @param {() => string} [options.mintId]
   */
  constructor({
    documents = null,
    blobs = null,
    locks = null,
    config = configStore,
    onAdminChange = null,
    logger: log,
    mintId = mintProjectId
  } = {}) {
    this.documents = documents || null;
    this.blobs = blobs || null;
    this.locks = locks || null;
    this.config = config;
    this.onAdminChange = onAdminChange;
    this.logger = log || logger;
    this._mintId = mintId;
  }

  /** Whether user projects can be stored. Admin projects need only the config store. */
  isAvailable() {
    return Boolean(this.documents && this.locks);
  }

  /** Whether item text can be stored. */
  hasBlobs() {
    return Boolean(this.blobs);
  }

  _withLock(projectId, fn) {
    if (!this.locks) return fn();
    return this.locks.withLock(`project:${projectId}`, fn, LOCK_OPTIONS);
  }

  /**
   * Run `fn` holding the lock of one owner: what serializes the per-user
   * project count with the create or transfer it gates. Taken before any
   * project lock, never inside one.
   *
   * @param {string} ownerId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  withOwnerLock(ownerId, fn) {
    if (!this.locks) return fn();
    return this.locks.withLock(`project-owner:${ownerId}`, fn, LOCK_OPTIONS);
  }

  async _loadUser(projectId) {
    const doc = await this.documents.get(USER_PROJECTS_NAMESPACE, projectId);
    return { project: doc?.data || null, etag: doc ? doc.etag : null };
  }

  async _writeUser(project, etag) {
    if (etag === undefined) {
      throw new StorageError('_writeUser needs the etag the matching read returned', {
        code: 'INVALID_ARGUMENT'
      });
    }
    const doc = await this.documents.put(USER_PROJECTS_NAMESPACE, project.id, project, {
      ownerId: project.owner?.id ?? null,
      etag
    });
    return doc.data;
  }

  async _loadAdmin(projectId) {
    const data = await this.config.readJson(adminPath(projectId));
    return { project: data && typeof data === 'object' ? data : null };
  }

  async _afterAdminChange() {
    if (typeof this.onAdminChange === 'function') {
      try {
        await this.onAdminChange();
      } catch (error) {
        this.logger.warn('Admin project cache refresh failed', {
          component: COMPONENT,
          error: error.message
        });
      }
    }
  }

  /**
   * One project by id, whichever ownership.
   *
   * @param {string} projectId
   * @returns {Promise<Object|null>}
   */
  async get(projectId) {
    if (isUserProjectId(projectId)) {
      if (!this.isAvailable()) return null;
      return (await this._loadUser(projectId)).project;
    }
    if (isAdminProjectId(projectId)) return (await this._loadAdmin(projectId)).project;
    return null;
  }

  /**
   * Create a user project owned by `owner`.
   *
   * @param {Object} options
   * @param {{id: string, name?: string}} options.owner
   * @param {{name: string, description?: string, instructions?: string}} options.content
   * @param {string} [options.now]
   * @returns {Promise<Object|null>}
   */
  async createUser({ owner, content, now = new Date().toISOString() } = {}) {
    if (!this.isAvailable() || !owner?.id) return null;
    let id = this._mintId();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await this.documents.get(USER_PROJECTS_NAMESPACE, id))) break;
      id = this._mintId();
    }
    const actor = actorOf(owner);
    const project = {
      version: PROJECT_VERSION,
      id,
      ownership: 'user',
      tier: 'ihub',
      name: String(content?.name || ''),
      description: String(content?.description || ''),
      instructions: String(content?.instructions || ''),
      owner: actor,
      members: [],
      items: [],
      usage: { items: 0, bytes: 0 },
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
      lastActivityAt: now
    };
    return this._writeUser(project, null);
  }

  /**
   * Create an admin project (create-only: an existing id is refused).
   *
   * @param {Object} project - Validated admin project document.
   * @param {Object} [options]
   * @param {{id: string, name?: string}} [options.actor]
   * @param {string} [options.now]
   * @returns {Promise<Object>}
   * @throws {StorageError} Code `PROJECT_EXISTS`.
   */
  async createAdmin(project, { actor = null, now = new Date().toISOString() } = {}) {
    if (!isAdminProjectId(project?.id)) {
      throw new StorageError('Invalid admin project id', { code: 'INVALID_KEY' });
    }
    const stored = {
      version: PROJECT_VERSION,
      tier: 'ihub',
      instructions: '',
      enabled: true,
      tags: [],
      items: [],
      ...project,
      id: project.id,
      ownership: 'admin',
      usage: usageOf(project.items || []),
      createdAt: project.createdAt || now,
      createdBy: actor ? actorOf(actor) : project.createdBy || null,
      updatedAt: now,
      updatedBy: actor ? actorOf(actor) : null,
      lastActivityAt: now
    };
    try {
      await this.config.createJson(adminPath(project.id), stored);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new StorageError(`Project "${project.id}" already exists`, {
          code: 'PROJECT_EXISTS'
        });
      }
      throw error;
    }
    await this._afterAdminChange();
    return stored;
  }

  /**
   * Every user project one user owns.
   *
   * @param {string} ownerId
   * @returns {Promise<Object[]>}
   */
  async listOwned(ownerId) {
    if (!this.isAvailable() || !ownerId) return [];
    const docs = await collect(this.documents, USER_PROJECTS_NAMESPACE, {
      ownerId: String(ownerId)
    });
    return docs.map(doc => doc.data);
  }

  /** How many projects one user owns. */
  async countOwned(ownerId) {
    return (await this.listOwned(ownerId)).length;
  }

  /**
   * The user projects that have a member marker filed under any of
   * `targetKeys`. Whether the project still carries that member is for the
   * caller's access check to decide. A marker whose project is gone is pruned.
   *
   * @param {string[]} targetKeys
   * @returns {Promise<Object[]>}
   */
  async listSharedWith(targetKeys) {
    if (!this.isAvailable()) return [];
    const projectIds = new Set();
    for (const targetKey of [...new Set(targetKeys || [])]) {
      if (typeof targetKey !== 'string' || !targetKey) continue;
      const docs = await collect(this.documents, USER_PROJECT_SHARES_NAMESPACE, {
        ownerId: targetKey
      });
      for (const doc of docs) {
        if (isUserProjectId(doc.data?.projectId)) projectIds.add(doc.data.projectId);
      }
      if (projectIds.size >= MAX_SCANNED) break;
    }
    const projects = [];
    for (const projectId of projectIds) {
      const project = await this.get(projectId);
      if (project) {
        projects.push(project);
        continue;
      }
      for (const targetKey of targetKeys) {
        await this.documents
          .delete(USER_PROJECT_SHARES_NAMESPACE, memberMarkerKey(projectId, targetKey))
          .catch(() => {});
      }
    }
    return projects;
  }

  /**
   * Every admin project, from the configuration store.
   *
   * @param {Object} [options]
   * @param {boolean} [options.includeDisabled=true]
   * @returns {Promise<Object[]>}
   */
  async listAdmin({ includeDisabled = true } = {}) {
    const docs = await this.config.listDocuments(ADMIN_PROJECTS_DIR);
    const projects = [];
    for (const doc of docs) {
      const project = doc?.data;
      if (!project || typeof project !== 'object' || !isAdminProjectId(project.id)) continue;
      if (project.id !== doc.key) {
        this.logger.warn('Admin project id differs from its file name; skipping', {
          component: COMPONENT,
          key: doc.key,
          id: project.id
        });
        continue;
      }
      if (!includeDisabled && project.enabled === false) continue;
      projects.push(project);
    }
    return projects;
  }

  /**
   * Walk every user project — for the admin compliance view and the
   * retention sweep. Bounded by documents read and projects returned.
   *
   * @param {Object} [options]
   * @param {(project: Object) => boolean} [options.filter]
   * @param {number} [options.max]
   * @param {number} [options.maxScanned]
   * @param {string|null} [options.cursor]
   * @returns {Promise<{projects: Object[], truncated: boolean, nextCursor: string|null}>}
   */
  async scanUser({
    filter = () => true,
    max = MAX_SCANNED,
    maxScanned = MAX_SCANNED,
    cursor = null
  } = {}) {
    if (!this.isAvailable()) return { projects: [], truncated: false, nextCursor: null };
    const projects = [];
    let scanned = 0;
    let next = cursor;
    do {
      const page = await this.documents.list(USER_PROJECTS_NAMESPACE, {
        limit: PAGE_SIZE,
        includeData: true,
        ...(next ? { cursor: next } : {})
      });
      for (const doc of page.items) {
        if (scanned >= maxScanned || projects.length >= max) {
          return { projects, truncated: true, nextCursor: next };
        }
        scanned += 1;
        if (doc?.data && filter(doc.data)) projects.push(doc.data);
      }
      next = page.nextCursor;
    } while (next);
    return { projects, truncated: false, nextCursor: null };
  }

  /**
   * Change one project under its lock.
   *
   * `fn` receives a copy of the project as loaded and returns the next
   * document, or `null` to write nothing. `updatedAt`, `updatedBy`, `usage`
   * and `lastActivityAt` are stamped here, so a caller only changes what it
   * means to.
   *
   * @param {string} projectId
   * @param {(project: Object) => Object|null|Promise<Object|null>} fn
   * @param {Object} [options]
   * @param {{id: string, name?: string}} [options.actor]
   * @param {(project: Object) => boolean} [options.authorize]
   * @param {string} [options.now]
   * @param {boolean} [options.touchActivity=true]
   * @returns {Promise<Object|null>} The stored project, or null when there is none.
   * @throws {StorageError} Code `PROJECT_ACCESS_CHANGED` when `authorize` refuses.
   */
  async mutate(projectId, fn, { actor, authorize, now, touchActivity = true } = {}) {
    const stamp = project => {
      const next = { ...project, usage: usageOf(project.items || []) };
      next.updatedAt = now || new Date().toISOString();
      if (actor) next.updatedBy = actorOf(actor);
      if (touchActivity) next.lastActivityAt = next.updatedAt;
      return next;
    };
    if (isUserProjectId(projectId)) {
      if (!this.isAvailable()) return null;
      return this._withLock(projectId, async () => {
        const { project, etag } = await this._loadUser(projectId);
        if (!project) return null;
        assertAuthorized(authorize, project);
        const next = await fn(structuredClone(project));
        if (!next) return project;
        return this._writeUser(stamp(next), etag);
      });
    }
    if (!isAdminProjectId(projectId)) return null;
    let result = null;
    let missing = false;
    const run = async () => {
      const { data } = await this.config.updateJson(adminPath(projectId), async current => {
        if (!current || typeof current !== 'object') {
          missing = true;
          return undefined;
        }
        assertAuthorized(authorize, current);
        const next = await fn(structuredClone(current));
        if (!next) {
          result = current;
          return undefined;
        }
        result = stamp(next);
        return result;
      });
      return data;
    };
    await this._withLock(projectId, run);
    if (missing) return null;
    await this._afterAdminChange();
    return result;
  }

  /**
   * Replace the member list of a user project and its markers.
   *
   * The project document is written first: it is the authority, so a member
   * dropped from the list loses access the moment this write lands.
   *
   * @param {string} projectId
   * @param {Array<Object>} members - Complete new list, already validated.
   * @param {Object} [options]
   * @param {{id: string, name?: string}} [options.actor]
   * @param {(project: Object) => boolean} [options.authorize]
   * @param {string} [options.now]
   * @returns {Promise<{project: Object, added: string[], removed: string[]}|null>}
   */
  async setMembers(projectId, members, { actor, authorize, now } = {}) {
    if (!this.isAvailable() || !isUserProjectId(projectId)) return null;
    return this._withLock(projectId, async () => {
      const { project, etag } = await this._loadUser(projectId);
      if (!project) return null;
      assertAuthorized(authorize, project);
      const before = new Set((project.members || []).map(member => memberTargetKey(member)));
      const after = new Set(members.map(member => memberTargetKey(member)));
      const stamp = now || new Date().toISOString();
      const stored = await this._writeUser(
        {
          ...project,
          members,
          membersUpdatedAt: stamp,
          membersUpdatedBy: actor ? actorOf(actor) : project.membersUpdatedBy || null,
          updatedAt: stamp,
          updatedBy: actor ? actorOf(actor) : project.updatedBy
        },
        etag
      );
      await this._writeMemberMarkers(projectId, [...after]);
      await this._removeMemberMarkers(
        projectId,
        [...before].filter(key => !after.has(key))
      );
      return {
        project: stored,
        added: [...after].filter(key => !before.has(key)),
        removed: [...before].filter(key => !after.has(key))
      };
    });
  }

  /**
   * Drop one member from a user project, under the project's lock and against
   * the list stored right now (a deleted user's cleanup; the members route
   * replaces the whole list).
   *
   * @param {string} projectId
   * @param {string} targetKey - `memberTargetKey` of the member to drop.
   * @param {Object} [options]
   * @param {{id: string, name?: string}} [options.actor]
   * @param {string} [options.now]
   * @returns {Promise<Object|null>} The stored project, or null when there is
   *   no such project or member.
   */
  async removeMember(projectId, targetKey, { actor, now } = {}) {
    if (!this.isAvailable() || !isUserProjectId(projectId)) return null;
    return this._withLock(projectId, async () => {
      const { project, etag } = await this._loadUser(projectId);
      if (!project) return null;
      const members = (project.members || []).filter(m => memberTargetKey(m) !== targetKey);
      if (members.length === (project.members || []).length) return null;
      const stamp = now || new Date().toISOString();
      const stored = await this._writeUser(
        {
          ...project,
          members,
          membersUpdatedAt: stamp,
          membersUpdatedBy: actor ? actorOf(actor) : project.membersUpdatedBy || null,
          updatedAt: stamp,
          updatedBy: actor ? actorOf(actor) : project.updatedBy
        },
        etag
      );
      await this._removeMemberMarkers(projectId, [targetKey]);
      return stored;
    });
  }

  async _writeMemberMarkers(projectId, targetKeys) {
    for (const targetKey of targetKeys) {
      await this.documents.put(
        USER_PROJECT_SHARES_NAMESPACE,
        memberMarkerKey(projectId, targetKey),
        { projectId, target: targetKey },
        { ownerId: targetKey }
      );
    }
  }

  async _removeMemberMarkers(projectId, targetKeys) {
    for (const targetKey of targetKeys) {
      await this.documents.delete(
        USER_PROJECT_SHARES_NAMESPACE,
        memberMarkerKey(projectId, targetKey)
      );
    }
  }

  /**
   * Hand a user project to another user. A membership of the new owner is
   * dropped — an owner does not need one.
   *
   * @param {string} projectId
   * @param {{id: string, name?: string}} newOwner
   * @param {Object} [options]
   * @returns {Promise<Object|null>}
   */
  async transfer(projectId, newOwner, { actor, authorize, now } = {}) {
    if (!this.isAvailable() || !isUserProjectId(projectId)) return null;
    return this._withLock(projectId, async () => {
      const { project, etag } = await this._loadUser(projectId);
      if (!project) return null;
      assertAuthorized(authorize, project);
      const owner = actorOf(newOwner);
      const ownerKey = memberTargetKey({ type: 'user', id: owner.id });
      const members = (project.members || []).filter(m => memberTargetKey(m) !== ownerKey);
      const dropped = members.length !== (project.members || []).length;
      const stamp = now || new Date().toISOString();
      const stored = await this._writeUser(
        {
          ...project,
          owner,
          members,
          updatedAt: stamp,
          updatedBy: actor ? actorOf(actor) : project.updatedBy
        },
        etag
      );
      // The owner index moved: the old etag-bound write above already carried
      // the new owner id through `put`, so only the dropped marker is left.
      if (dropped) await this._removeMemberMarkers(projectId, [ownerKey]);
      return stored;
    });
  }

  /**
   * Remove a project document and its member markers. Chat markers and
   * blobs are removed by the service's cascade, which calls back here.
   *
   * @param {string} projectId
   * @param {Object} [options]
   * @param {(project: Object) => boolean} [options.authorize]
   * @returns {Promise<Object|null>} The project as it was, or null.
   */
  async delete(projectId, { authorize } = {}) {
    if (isUserProjectId(projectId)) {
      if (!this.isAvailable()) return null;
      return this._withLock(projectId, async () => {
        const { project } = await this._loadUser(projectId);
        if (!project) return null;
        assertAuthorized(authorize, project);
        await this.documents.delete(USER_PROJECTS_NAMESPACE, projectId);
        await this._removeMemberMarkers(
          projectId,
          (project.members || []).map(member => memberTargetKey(member))
        );
        return project;
      });
    }
    if (!isAdminProjectId(projectId)) return null;
    const { project } = await this._loadAdmin(projectId);
    if (!project) return null;
    assertAuthorized(authorize, project);
    await this.config.remove(adminPath(projectId));
    await this._afterAdminChange();
    return project;
  }

  // --- chat markers ---------------------------------------------------------

  /** Record that a chat lives inside a project. */
  async addChatMarker(projectId, chatId, { ownerId = null } = {}) {
    if (!this.documents || !isProjectId(projectId) || !isValidId(chatId)) return false;
    await this.documents.put(
      PROJECT_CHATS_NAMESPACE,
      chatMarkerKey(projectId, chatId),
      { projectId, chatId, ownerId },
      { ownerId: projectId }
    );
    return true;
  }

  /** Forget a chat's membership in a project. */
  async removeChatMarker(projectId, chatId) {
    if (!this.documents || !isProjectId(projectId) || !isValidId(chatId)) return false;
    return this.documents.delete(PROJECT_CHATS_NAMESPACE, chatMarkerKey(projectId, chatId));
  }

  /**
   * The chat markers of one project.
   *
   * @param {string} projectId
   * @returns {Promise<Array<{chatId: string, ownerId: string|null}>>}
   */
  async listChatMarkers(projectId) {
    if (!this.documents || !isProjectId(projectId)) return [];
    const docs = await collect(this.documents, PROJECT_CHATS_NAMESPACE, { ownerId: projectId });
    return docs
      .map(doc => doc.data)
      .filter(data => data && isValidId(data.chatId))
      .map(data => ({ chatId: data.chatId, ownerId: data.ownerId ?? null }));
  }

  /** Remove every chat marker of a project; returns the chat ids it had. */
  async removeAllChatMarkers(projectId) {
    const markers = await this.listChatMarkers(projectId);
    for (const marker of markers) await this.removeChatMarker(projectId, marker.chatId);
    return markers.map(marker => marker.chatId);
  }

  // --- blobs ----------------------------------------------------------------

  /**
   * Delete every blob of a project (or of one item). Best-effort and
   * idempotent: a blob that is already gone counts as removed.
   *
   * @param {string} projectId
   * @param {string} [itemId]
   * @returns {Promise<number>} Blobs removed.
   */
  async deleteBlobs(projectId, itemId) {
    if (!this.blobs || !isProjectId(projectId)) return 0;
    const prefix = itemId ? `${blobPrefix(projectId)}${itemId}__` : blobPrefix(projectId);
    let removed = 0;
    let cursor = null;
    do {
      const page = await this.blobs.list(PROJECT_FILES_NAMESPACE, {
        prefix,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {})
      });
      for (const blob of page.items) {
        if (await this.blobs.delete(PROJECT_FILES_NAMESPACE, blob.key)) removed += 1;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return removed;
  }
}

/**
 * The denormalised usage of a project: items and the original bytes of the
 * text items.
 *
 * @param {Object[]} items
 * @returns {{items: number, bytes: number}}
 */
export function usageOf(items = []) {
  let bytes = 0;
  for (const item of items) {
    const original = Number(item?.text?.original?.bytes);
    if (Number.isFinite(original) && original > 0) bytes += original;
  }
  return { items: items.length, bytes };
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * The process-wide repository over the configured storage provider. Rebuilt
 * when the provider changes (tests bring providers up and down).
 *
 * @returns {ProjectRepository}
 */
export function getProjectRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new ProjectRepository({
      documents: readFacet(provider, 'documents'),
      blobs: readFacet(provider, 'blobs'),
      locks: readFacet(provider, 'locks'),
      logger,
      onAdminChange: () => configCache.refreshProjectsCache()
    });
  }
  return cachedRepository;
}

export default ProjectRepository;
