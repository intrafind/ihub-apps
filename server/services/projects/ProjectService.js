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
import { ProjectError } from './projectErrors.js';
// Registering the built-in kinds is a side effect of loading them.
import './kinds/linkKinds.js';
import './kinds/uploadKind.js';
import './kinds/cloudKinds.js';
import { projectSettings } from './projectSettings.js';
import { findDependencies } from './projectLinks.js';

const COMPONENT = 'ProjectService';
/** How often one project's activity is refreshed by chat turns at most. */
export const ACTIVITY_THROTTLE_MS = 5 * 60 * 1000;

export { ProjectError, STATUS_BY_CODE } from './projectErrors.js';

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
    /** Hooks called with `(projectId, itemId, item)` after an item's text is gone or replaced. */
    this.onItemRemoved = [];
    /** projectId -> when a chat turn last refreshed its activity. */
    this.activityTouched = new Map();
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
    // The count and the write share the owner's lock: two creates with one
    // slot left cannot both see it free.
    return this.repository.withOwnerLock(String(owner.id), async () => {
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
      if (!project) {
        throw new ProjectError('STORAGE_UNAVAILABLE', 'The project could not be stored');
      }
      return project;
    });
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
    // A new project is made of new items: a kind that is switched off is
    // refused here exactly as the item endpoints refuse it.
    for (const item of project.items || []) this._checkKindRef(item.kind, item.ref);
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
        { actor: actorOf(actor), authorize, touchActivity: true }
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
    // An admin project that apps, workflows or agents link stays: the links
    // would dangle. Checked here, not only in the admin API, so every route
    // that may delete one keeps the invariant.
    if (isAdminProjectId(projectId)) {
      const dependencies = findDependencies(projectId);
      if (dependencies.length > 0) {
        throw new ProjectError(
          'PROJECT_IN_USE',
          'Cannot delete a project that apps, workflows or agents link',
          { dependencies }
        );
      }
    }
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
   * a text kind goes through the ingest pipeline (spec 3): an upload hands
   * in `file` (the temp file multer wrote), a workflow or an admin hands in
   * `text`, and a cloud kind is fetched with the caller's token. The route
   * answers `202` with the `pending` item; `text` runs inline and returns
   * the finished item.
   *
   * @param {string} projectId
   * @param {{kind: string, ref?: Object, name?: string, pinned?: boolean, text?: string,
   *   file?: {path: string, contentType?: string, name?: string, bytes?: number, cleanupDir?: string}}} input
   * @param {{user: Object, authorize?: Function, origin?: string, run?: Object, wait?: boolean}} options
   * @returns {Promise<{project: Object, item: Object}>}
   */
  async addItem(projectId, input, { user, authorize, origin, run = null, wait = false }) {
    const { kind, ref } = this._checkKindRef(input.kind, input.ref);
    const isText = kind.storage.ihub === 'text';
    const file = isText && input.file && typeof input.file === 'object' ? input.file : null;
    const text = isText && typeof input.text === 'string' ? input.text : null;
    if (isText && !file && text === null && typeof kind.fetch !== 'function') {
      throw new ProjectError('INVALID_REF', `An item of kind ${kind.id} needs a file or text`);
    }
    const described = typeof kind.describe === 'function' ? kind.describe(ref, user?.language) : {};
    const now = nowIso();
    const declaredBytes = file
      ? Number(file.bytes) || 0
      : text !== null
        ? Buffer.byteLength(text, 'utf8')
        : Number(ref.size) || 0;
    const item = {
      id: mintItemId(),
      kind: kind.id,
      name: String(input.name || file?.name || described.name || kind.id).slice(0, 300),
      ref,
      storage: kind.storage.ihub,
      pinned: input.pinned === true,
      status: isText ? 'pending' : 'ready',
      error: null,
      provenance: {
        origin:
          origin || (!isText ? 'linked' : file ? 'uploaded' : text !== null ? 'written' : 'picked'),
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
    if (!isText) {
      item.cache = { ttlSeconds: 7200 };
    }
    let stored = null;
    try {
      stored = await this.repository.mutate(
        projectId,
        project => {
          this._checkItemQuota(project, { bytes: declaredBytes });
          project.items = [...(project.items || []), item];
          return project;
        },
        { actor: actorOf(user), authorize }
      );
    } catch (error) {
      throw translateError(error);
    }
    if (!stored) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
    let storedItem = stored.items.find(entry => entry.id === item.id) || item;
    if (isText) {
      if (!this.ingest) {
        await this.removeItem(projectId, item.id, { user, authorize }).catch(() => {
          // The INGEST_UNAVAILABLE error below is what the caller needs to see.
        });
        throw new ProjectError(
          'INGEST_UNAVAILABLE',
          'Uploads and picked documents are not available on this installation'
        );
      }
      const ingestInput = file
        ? {
            path: file.path,
            cleanupDir: file.cleanupDir,
            contentType: file.contentType,
            // The file's own name decides the type; the item's name is the
            // display title the uploader chose.
            name: file.name || storedItem.name,
            bytes: declaredBytes,
            purpose: 'upload'
          }
        : text !== null
          ? {
              text,
              contentType: ref.contentType || 'text/markdown',
              name: storedItem.name,
              purpose: origin === 'written' ? 'write' : 'text'
            }
          : {
              fetch: () => kind.fetch(storedItem, { user, purpose: 'pick' }),
              contentType: ref.mimeType,
              name: storedItem.name,
              purpose: 'pick'
            };
      const result = await this.ingest.start(stored, storedItem, ingestInput, { user, wait });
      if (result) {
        if (!result.item) {
          // An inline job failed: nothing to keep, the caller gets the error.
          await this.removeItem(projectId, item.id, { user, authorize }).catch(() => {
            // The failure the job recorded is what the caller gets.
          });
          throw new ProjectError(result.error.code, result.error.message);
        }
        storedItem = result.item;
      }
    }
    return { project: stored, item: storedItem };
  }

  /**
   * Fetch a picked item again (spec 3 §4): the kind downloads with the
   * caller's token, the old text stays readable until the new one is
   * stored, and a source that did not change since `snapshotAt` leaves the
   * item as it was.
   *
   * @param {string} projectId
   * @param {string} itemId
   * @param {{user: Object, authorize?: Function, wait?: boolean}} options
   * @returns {Promise<{project: Object, item: Object}>} Without `wait`, the
   *   item as reserved — carrying `refreshingAt` — while the job runs
   * @throws {ProjectError} `PROJECT_MISMATCH` while the item is being
   *   processed, a refresh included
   */
  async refreshItem(projectId, itemId, { user, authorize, wait = false }) {
    if (!this.ingest) {
      throw new ProjectError(
        'INGEST_UNAVAILABLE',
        'Refreshing items is not available on this installation'
      );
    }
    let stored = null;
    let target = null;
    try {
      stored = await this.repository.mutate(
        projectId,
        project => {
          const item = (project.items || []).find(entry => entry.id === itemId);
          if (!item) throw new ProjectError('ITEM_NOT_FOUND', 'Item not found');
          const kind = getItemKind(item.kind);
          if (!kind || kind.storage.ihub !== 'text' || typeof kind.fetch !== 'function') {
            throw new ProjectError('INVALID_REF', 'Only picked documents can be refreshed');
          }
          if (item.status === 'pending' || item.status === 'extracting' || item.refreshingAt) {
            throw new ProjectError('PROJECT_MISMATCH', 'The item is still being processed');
          }
          this._checkKindRef(item.kind, item.ref, { admin: true });
          // The old snapshot stays readable until the new one is stored, so
          // the status is left alone. `refreshingAt` is reserved here, under
          // the project's lock and before the job is queued: a second refresh
          // is refused while it is set, so two queued downloads can never
          // race to install an older snapshot over a newer one. The job
          // clears it when it finishes, fails or finds nothing changed.
          const now = nowIso();
          item.error = null;
          item.refreshingAt = now;
          item.updatedAt = now;
          target = { item, kind };
          return project;
        },
        { actor: actorOf(user), authorize }
      );
    } catch (error) {
      throw translateError(error);
    }
    if (!stored) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
    const storedItem = stored.items.find(entry => entry.id === itemId);
    const result = await this.ingest.start(
      stored,
      storedItem,
      {
        fetch: () => target.kind.fetch(storedItem, { user, purpose: 'refresh' }),
        contentType: storedItem.ref?.mimeType,
        name: storedItem.name,
        previousBlobKey: storedItem.text?.blobKey || null,
        previousSnapshotAt: storedItem.snapshotAt || null,
        // The version the last fetch saw, so a change between that fetch
        // and the end of extraction is not mistaken for "unchanged".
        previousLastModified: storedItem.provenance?.source?.lastModified || null,
        purpose: 'refresh'
      },
      { user, wait }
    );
    if (result?.error) throw new ProjectError(result.error.code, result.error.message);
    return { project: stored, item: result?.item || storedItem };
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
    let stored = null;
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
        // Someone renaming or pinning a document is using the project:
        // retention must not count the project as abandoned.
        { actor: actorOf(user), authorize, touchActivity: true }
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
    let stored = null;
    let found = false;
    let removed = null;
    try {
      stored = await this.repository.mutate(
        projectId,
        project => {
          const before = (project.items || []).length;
          removed = (project.items || []).find(entry => entry.id === itemId) || null;
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
    for (const hook of this.onItemRemoved) {
      await attempt(() => hook(projectId, itemId, removed), 'an item hook', {
        component: COMPONENT,
        projectId,
        itemId
      });
    }
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
  async patchItem(projectId, itemId, update, { check } = {}) {
    const stored = await this.repository.mutate(
      projectId,
      project => {
        const item = (project.items || []).find(entry => entry.id === itemId);
        if (!item) return null;
        // A check against the project as stored right now (a quota), under
        // the lock the write holds; what it throws aborts the write.
        if (typeof check === 'function') check(project, item);
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
    // The new owner's count and the hand-over share that owner's lock, with
    // the creates that count against the same cap.
    return this.repository.withOwnerLock(String(newOwner.id), async () => {
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
    });
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
    await this.touchActivity(projectId);
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

  /**
   * A chat turn ran inside the project: refresh its activity, at most once
   * per {@link ACTIVITY_THROTTLE_MS} per project so a busy chat does not
   * rewrite the project document on every message. Never throws; the turn
   * must not fail because the project could not be touched.
   *
   * @param {string} projectId
   * @returns {Promise<boolean>} Whether the project was touched.
   */
  async noteChatTurn(projectId) {
    if (!projectId || !this.repository.isAvailable()) return false;
    const last = this.activityTouched.get(projectId) || 0;
    const at = Date.now();
    if (at - last < ACTIVITY_THROTTLE_MS) return false;
    this.activityTouched.set(projectId, at);
    const touched = await this.touchActivity(projectId);
    if (!touched) this.activityTouched.delete(projectId);
    return Boolean(touched);
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
    if (previous) {
      cachedService.onDeleted = previous.onDeleted;
      cachedService.onItemRemoved = previous.onItemRemoved;
    }
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
