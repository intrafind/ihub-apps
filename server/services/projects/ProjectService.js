// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ProjectService — the rules on top of the repository: quotas, the item
 * kind registry, the delete cascade and chat membership.
 *
 * Every entry point takes the acting user and an `authorize` callback the
 * route built from the permissions it already checked; the repository
 * re-runs the callback under the lock. Errors are {@link ProjectError}s with
 * the codes of spec 1 §5.4, which the routes map to HTTP.
 *
 * @module services/projects/ProjectService
 */
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { StorageError } from '../../storage/errors.js';
import {
  ACCESS_CHANGED,
  getProjectRepository,
  isAdminProjectId,
  isUserProjectId,
  mintItemId
} from './ProjectRepository.js';
import { getItemKind, isItemKindEnabled } from './kinds/registry.js';
// Registering the built-in link kinds is a side effect of loading them.
import './kinds/linkKinds.js';
import { projectSettings } from './projectSettings.js';

const COMPONENT = 'ProjectService';

/** HTTP status per error code. */
const STATUS_BY_CODE = Object.freeze({
  FEATURE_DISABLED: 403,
  USER_PROJECTS_DISABLED: 403,
  PROJECTS_NOT_ALLOWED: 403,
  PERMISSION_DENIED: 403,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ACCESS_CHANGED: 403,
  PROJECT_EXISTS: 409,
  PROJECT_IN_USE: 400,
  PROJECT_MISMATCH: 409,
  QUOTA_PROJECTS: 409,
  QUOTA_FILES: 413,
  QUOTA_FILE_BYTES: 413,
  QUOTA_PROJECT_BYTES: 413,
  KIND_DISABLED: 400,
  KIND_UNKNOWN: 400,
  INVALID_REF: 400,
  UNSUPPORTED_TYPE: 415,
  EXTRACTION_FAILED: 422,
  NO_TEXT: 422,
  SCAN_REJECTED: 422,
  SOURCE_FORBIDDEN: 403,
  SOURCE_GONE: 404,
  SHARE_TARGET_INVALID: 400,
  ITEM_NOT_FOUND: 404,
  INGEST_UNAVAILABLE: 501,
  STORAGE_UNAVAILABLE: 503
});

/**
 * An error the routes know how to answer.
 */
export class ProjectError extends Error {
  /**
   * @param {string} code - One of the codes of spec 1 §5.4.
   * @param {string} message
   * @param {Object} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 400;
    if (details) this.details = details;
  }
}

function actorOf(user) {
  return {
    id: String(user?.id ?? ''),
    name: String(user?.name || user?.displayName || user?.username || user?.id || '')
  };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Translate a repository error into a project error where one applies.
 *
 * @param {unknown} error
 * @returns {Error}
 */
export function translateError(error) {
  if (error instanceof ProjectError) return error;
  if (error instanceof StorageError) {
    if (error.code === ACCESS_CHANGED)
      return new ProjectError('PROJECT_ACCESS_CHANGED', error.message);
    if (error.code === 'PROJECT_EXISTS') return new ProjectError('PROJECT_EXISTS', error.message);
  }
  return error;
}

/**
 * The service. One instance per process (see {@link getProjectService});
 * tests build their own over a repository of their choosing.
 */
export class ProjectService {
  /**
   * @param {Object} [options]
   * @param {import('./ProjectRepository.js').ProjectRepository} [options.repository]
   * @param {() => Object} [options.platform] - Returns the platform configuration.
   * @param {() => Object} [options.features] - Returns the saved feature flags.
   * @param {Object|null} [options.ingest] - The ingest pipeline for text kinds
   *   (spec 3); `null` until slice 3 wires it, so a text kind is refused with
   *   `INGEST_UNAVAILABLE`.
   * @param {Object} [options.logger]
   */
  constructor({ repository, platform, features, ingest = null, logger: log } = {}) {
    this.repository = repository || getProjectRepository();
    this._platform = platform || (() => ({}));
    this._features = features || (() => ({}));
    this.ingest = ingest;
    this.logger = log || logger;
    /** Hooks a later slice registers: called after a project is deleted. */
    this.onDeleted = [];
  }

  settings() {
    return projectSettings(this._platform());
  }

  kindContext() {
    return { platform: this._platform(), features: this._features(), settings: this.settings() };
  }

  // --- projects -------------------------------------------------------------

  /**
   * Create a user project, within the per-user cap.
   *
   * @param {Object} options
   * @param {Object} options.owner - The creating user.
   * @param {{name: string, description?: string, instructions?: string}} options.content
   * @returns {Promise<Object>}
   */
  async createUserProject({ owner, content }) {
    if (!this.repository.isAvailable()) {
      throw new ProjectError(
        'STORAGE_UNAVAILABLE',
        'Projects are unavailable on this installation'
      );
    }
    const { limits } = this.settings();
    if (limits.maxProjectsPerUser > 0) {
      const owned = await this.repository.countOwned(String(owner.id));
      if (owned >= limits.maxProjectsPerUser) {
        throw new ProjectError(
          'QUOTA_PROJECTS',
          `You can keep at most ${limits.maxProjectsPerUser} projects — delete one to make room`,
          { limit: limits.maxProjectsPerUser, used: owned }
        );
      }
    }
    const project = await this.repository.createUser({ owner: actorOf(owner), content });
    if (!project) throw new ProjectError('STORAGE_UNAVAILABLE', 'The project could not be stored');
    return project;
  }

  /**
   * Create an admin project from a validated document.
   *
   * @param {Object} project
   * @param {{actor: Object}} options
   * @returns {Promise<Object>}
   */
  async createAdminProject(project, { actor }) {
    const { limits } = this.settings();
    if ((project.items || []).length > limits.maxFiles) {
      throw new ProjectError('QUOTA_FILES', `A project holds at most ${limits.maxFiles} items`, {
        limit: limits.maxFiles
      });
    }
    for (const item of project.items || [])
      this._checkKindRef(item.kind, item.ref, { admin: true });
    try {
      return await this.repository.createAdmin(project, { actor: actorOf(actor) });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Change name, description, instructions (and, on admin projects, enabled,
   * category and tags).
   *
   * @param {string} projectId
   * @param {Object} patch
   * @param {{actor: Object, authorize?: Function}} options
   * @returns {Promise<Object|null>}
   */
  async updateProject(projectId, patch, { actor, authorize }) {
    const allowed = isAdminProjectId(projectId)
      ? ['name', 'description', 'instructions', 'enabled', 'category', 'tags']
      : ['name', 'description', 'instructions'];
    try {
      return await this.repository.mutate(
        projectId,
        project => {
          let changed = false;
          for (const key of allowed) {
            if (
              patch[key] !== undefined &&
              JSON.stringify(patch[key]) !== JSON.stringify(project[key])
            ) {
              project[key] = patch[key];
              changed = true;
            }
          }
          return changed ? project : null;
        },
        { actor: actorOf(actor), authorize, touchActivity: false }
      );
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Delete a project and everything it owns (spec 1 §9.1): the document and
   * member markers, every text blob, the chat markers (with `projectId`
   * cleared on each chat), then whatever later slices registered.
   *
   * @param {string} projectId
   * @param {{authorize?: Function, detachChat?: (chatId: string) => Promise<unknown>}} [options]
   * @returns {Promise<Object|null>} The project as it was, or null.
   */
  async deleteProject(projectId, { authorize, detachChat } = {}) {
    let project;
    try {
      project = await this.repository.delete(projectId, { authorize });
    } catch (error) {
      throw translateError(error);
    }
    if (!project) return null;
    const where = { component: COMPONENT, projectId };
    await attempt(() => this.repository.deleteBlobs(projectId), 'text blobs', where);
    await attempt(
      async () => {
        const chatIds = await this.repository.removeAllChatMarkers(projectId);
        if (typeof detachChat === 'function') {
          for (const chatId of chatIds)
            await attempt(() => detachChat(chatId), `chat ${chatId}`, where);
        }
      },
      'chat markers',
      where
    );
    for (const hook of this.onDeleted) {
      await attempt(() => hook(project), 'a delete hook', where);
    }
    return project;
  }

  // --- items ----------------------------------------------------------------

  _checkKindRef(kindId, ref, { admin = false } = {}) {
    const kind = getItemKind(kindId);
    if (!kind) throw new ProjectError('KIND_UNKNOWN', `Unknown item kind: ${kindId}`);
    // An admin editing an existing item of a kind that is switched off may
    // still save the project; a new item of that kind is refused for everyone.
    if (!admin && !isItemKindEnabled(kindId, this.kindContext())) {
      throw new ProjectError('KIND_DISABLED', `Item kind "${kindId}" is not available`);
    }
    const parsed = kind.refSchema.safeParse(ref || {});
    if (!parsed.success) {
      throw new ProjectError(
        'INVALID_REF',
        `Invalid reference for ${kindId}: ${parsed.error.issues.map(i => `${i.path.join('.') || 'ref'}: ${i.message}`).join('; ')}`
      );
    }
    return { kind, ref: parsed.data };
  }

  _checkItemQuota(project, { bytes = 0 } = {}) {
    const { limits } = this.settings();
    const items = project.items || [];
    if (items.length >= limits.maxFiles) {
      throw new ProjectError('QUOTA_FILES', `A project holds at most ${limits.maxFiles} items`, {
        limit: limits.maxFiles,
        used: items.length
      });
    }
    if (bytes > limits.maxFileBytes) {
      throw new ProjectError(
        'QUOTA_FILE_BYTES',
        `A file may be at most ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB`,
        { limit: limits.maxFileBytes, size: bytes }
      );
    }
    const used = project.usage?.bytes || 0;
    if (bytes > 0 && used + bytes > limits.maxProjectBytes) {
      throw new ProjectError(
        'QUOTA_PROJECT_BYTES',
        `This project may hold at most ${Math.floor(limits.maxProjectBytes / (1024 * 1024))} MB`,
        { limit: limits.maxProjectBytes, used, size: bytes }
      );
    }
  }

  /**
   * Add an item. A link kind is `ready` as soon as its reference validates;
   * a text kind goes through the ingest pipeline (spec 3), which is not wired
   * before slice 3 and answers `INGEST_UNAVAILABLE` until then.
   *
   * @param {string} projectId
   * @param {{kind: string, ref?: Object, name?: string, pinned?: boolean, text?: string}} input
   * @param {{user: Object, authorize?: Function, origin?: string, run?: Object}} options
   * @returns {Promise<{project: Object, item: Object}>}
   */
  async addItem(projectId, input, { user, authorize, origin, run = null }) {
    const { kind, ref } = this._checkKindRef(input.kind, input.ref);
    const described = typeof kind.describe === 'function' ? kind.describe(ref, user?.language) : {};
    const now = nowIso();
    const item = {
      id: mintItemId(),
      kind: kind.id,
      name: String(input.name || described.name || kind.id).slice(0, 300),
      ref,
      storage: kind.storage.ihub,
      pinned: input.pinned === true,
      status: kind.storage.ihub === 'link' ? 'ready' : 'pending',
      error: null,
      provenance: {
        origin: origin || (kind.storage.ihub === 'link' ? 'linked' : 'picked'),
        by: actorOf(user),
        at: now,
        run,
        source:
          described.url || described.site ? { site: described.site, url: described.url } : null
      },
      snapshotAt: null,
      createdAt: now,
      updatedAt: now
    };
    if (kind.storage.ihub === 'link') {
      item.cache = { ttlSeconds: 7200 };
    }
    let stored;
    try {
      stored = await this.repository.mutate(
        projectId,
        project => {
          this._checkItemQuota(project);
          project.items = [...(project.items || []), item];
          return project;
        },
        { actor: actorOf(user), authorize }
      );
    } catch (error) {
      throw translateError(error);
    }
    if (!stored) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
    const storedItem = stored.items.find(entry => entry.id === item.id) || item;
    if (kind.storage.ihub === 'text') {
      if (!this.ingest) {
        await this.removeItem(projectId, item.id, { user, authorize }).catch(() => {});
        throw new ProjectError(
          'INGEST_UNAVAILABLE',
          'Uploads and picked documents are not available yet on this installation'
        );
      }
      await this.ingest.start(stored, storedItem, input, { user, authorize });
    }
    return { project: stored, item: storedItem };
  }

  /**
   * Rename or pin an item.
   *
   * @param {string} projectId
   * @param {string} itemId
   * @param {{name?: string, pinned?: boolean}} patch
   * @param {{user: Object, authorize?: Function}} options
   * @returns {Promise<{project: Object, item: Object}|null>}
   */
  async updateItem(projectId, itemId, patch, { user, authorize }) {
    let stored;
    try {
      stored = await this.repository.mutate(
        projectId,
        project => {
          const item = (project.items || []).find(entry => entry.id === itemId);
          if (!item) throw new ProjectError('ITEM_NOT_FOUND', 'Item not found');
          let changed = false;
          if (patch.name !== undefined && patch.name !== item.name) {
            item.name = patch.name;
            changed = true;
          }
          if (patch.pinned !== undefined && patch.pinned !== item.pinned) {
            item.pinned = patch.pinned;
            changed = true;
          }
          if (!changed) return null;
          item.updatedAt = nowIso();
          return project;
        },
        { actor: actorOf(user), authorize, touchActivity: false }
      );
    } catch (error) {
      throw translateError(error);
    }
    if (!stored) return null;
    return { project: stored, item: stored.items.find(entry => entry.id === itemId) };
  }

  /**
   * Remove an item and its text blob.
   *
   * @param {string} projectId
   * @param {string} itemId
   * @param {{user: Object, authorize?: Function}} options
   * @returns {Promise<Object|null>} The project after the removal, or null.
   */
  async removeItem(projectId, itemId, { user, authorize }) {
    let stored;
    let found = false;
    try {
      stored = await this.repository.mutate(
        projectId,
        project => {
          const before = (project.items || []).length;
          project.items = (project.items || []).filter(entry => entry.id !== itemId);
          found = project.items.length !== before;
          return found ? project : null;
        },
        { actor: actorOf(user), authorize }
      );
    } catch (error) {
      throw translateError(error);
    }
    if (!stored) return null;
    if (!found) throw new ProjectError('ITEM_NOT_FOUND', 'Item not found');
    await attempt(() => this.repository.deleteBlobs(projectId, itemId), 'item blob', {
      component: COMPONENT,
      projectId,
      itemId
    });
    return stored;
  }

  /**
   * Change an item's status from the ingest pipeline or a refresh.
   *
   * @param {string} projectId
   * @param {string} itemId
   * @param {(item: Object) => void} update - Mutates the item in place.
   * @returns {Promise<Object|null>} The item as stored, or null when gone.
   */
  async patchItem(projectId, itemId, update) {
    const stored = await this.repository.mutate(
      projectId,
      project => {
        const item = (project.items || []).find(entry => entry.id === itemId);
        if (!item) return null;
        update(item);
        item.updatedAt = nowIso();
        return project;
      },
      { touchActivity: true }
    );
    return stored?.items?.find(entry => entry.id === itemId) || null;
  }

  // --- members --------------------------------------------------------------

  /**
   * Replace the member list of a user project.
   *
   * @param {string} projectId
   * @param {Array<Object>} members - Validated and resolved (names filled in).
   * @param {{user: Object, authorize?: Function}} options
   * @returns {Promise<{project: Object, added: string[], removed: string[]}|null>}
   */
  async setMembers(projectId, members, { user, authorize }) {
    if (!isUserProjectId(projectId)) {
      throw new ProjectError('PERMISSION_DENIED', 'Admin projects have no members');
    }
    try {
      return await this.repository.setMembers(projectId, members, {
        actor: actorOf(user),
        authorize
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Hand a user project to another user, within that user's cap.
   *
   * @param {string} projectId
   * @param {Object} newOwner - `{ id, name }` of a known, active user.
   * @param {{user: Object, authorize?: Function}} options
   * @returns {Promise<Object|null>}
   */
  async transfer(projectId, newOwner, { user, authorize }) {
    if (!isUserProjectId(projectId)) {
      throw new ProjectError('PERMISSION_DENIED', 'Admin projects cannot be transferred');
    }
    const { limits } = this.settings();
    if (limits.maxProjectsPerUser > 0) {
      const owned = await this.repository.countOwned(String(newOwner.id));
      if (owned >= limits.maxProjectsPerUser) {
        throw new ProjectError(
          'QUOTA_PROJECTS',
          `${newOwner.name || newOwner.id} already keeps ${limits.maxProjectsPerUser} projects`,
          { limit: limits.maxProjectsPerUser, used: owned }
        );
      }
    }
    try {
      return await this.repository.transfer(projectId, newOwner, {
        actor: actorOf(user),
        authorize
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  // --- chats ----------------------------------------------------------------

  /**
   * Record a chat inside a project and bump the project's activity.
   *
   * @param {string} projectId
   * @param {string} chatId
   * @param {{ownerId?: string|null}} [options]
   */
  async attachChat(projectId, chatId, { ownerId = null } = {}) {
    await this.repository.addChatMarker(projectId, chatId, { ownerId });
    await attempt(
      () => this.repository.mutate(projectId, () => null, { touchActivity: true }),
      'project activity',
      { component: COMPONENT, projectId }
    );
  }

  /** Forget a chat's membership. */
  async detachChat(projectId, chatId) {
    return this.repository.removeChatMarker(projectId, chatId);
  }

  /** Touch a project's `lastActivityAt` (a chat turn ran inside it). */
  async touchActivity(projectId) {
    return attempt(
      () => this.repository.mutate(projectId, project => ({ ...project }), { touchActivity: true }),
      'project activity',
      { component: COMPONENT, projectId }
    );
  }
}

/**
 * Run one cascade step without letting it strand the rest.
 */
async function attempt(step, what, where) {
  try {
    return await step();
  } catch (error) {
    logger.error(`Failed to cascade a project change into ${what}`, {
      ...where,
      error: error.message
    });
    return undefined;
  }
}

let cachedService = null;
let cachedRepository = null;

/**
 * The process-wide service over the process-wide repository.
 *
 * @returns {ProjectService}
 */
export function getProjectService() {
  const repository = getProjectRepository();
  if (!cachedService || cachedRepository !== repository) {
    cachedRepository = repository;
    const previous = cachedService;
    cachedService = new ProjectService({
      repository,
      platform: () => platformOf(),
      features: () => featuresOf(),
      ingest: previous?.ingest || null,
      logger
    });
    if (previous) cachedService.onDeleted = previous.onDeleted;
  }
  return cachedService;
}

function platformOf() {
  return configCache.getPlatform?.() || {};
}
function featuresOf() {
  return configCache.getFeatures?.() || {};
}

export default ProjectService;
