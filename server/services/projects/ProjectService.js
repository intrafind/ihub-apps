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
import { randomUUID } from 'node:crypto';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { StorageError } from '../../storage/errors.js';
import {
  ACCESS_CHANGED,
  DELETING,
  PROJECT_FILES_NAMESPACE,
  getProjectRepository,
  isAdminProjectId,
  isUserProjectId,
  mintItemId
} from './ProjectRepository.js';
import { evictItemKeys, readText, storeText } from './ItemTextStore.js';
import { getItemKind, isItemKindEnabled } from './kinds/registry.js';
import { ProjectError } from './projectErrors.js';
// Registering the built-in kinds is a side effect of loading them.
import './kinds/linkKinds.js';
import './kinds/uploadKind.js';
import './kinds/cloudKinds.js';
import { projectSettings } from './projectSettings.js';
import { findDependencies } from './projectLinks.js';
import { relinkProjects } from './projectRelink.js';
import { MAX_ITEM_TEXT_CHARS } from './projectConstants.js';

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
    // A project whose delete has begun is gone for every other purpose.
    if (error.code === DELETING) return new ProjectError('PROJECT_NOT_FOUND', error.message);
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
    /** Hooks called with `(projectId, itemId, item)` after an item arrived by a copy or move. */
    this.onItemAdded = [];
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
    // A new project is made of new items, built here exactly as the item
    // endpoints build them: the request names the kind, the reference, a
    // name and whether it is pinned; storage, status and provenance are the
    // kind's. Content that has to be fetched and extracted (uploads, picked
    // documents) goes through the item endpoints, which run the ingestion.
    const items = (project.items || []).map(input => {
      const { kind, ref } = this._checkKindRef(input.kind, input.ref);
      if (kind.storage.ihub !== 'link') {
        throw new ProjectError(
          'INVALID_REF',
          `Items of kind "${kind.id}" are added through the item endpoints after the project exists`
        );
      }
      return buildItem(kind, ref, input, { user: actor, origin: 'linked' });
    });
    try {
      return await this.repository.createAdmin({ ...project, items }, { actor: actorOf(actor) });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Change name, description, instructions (and, on user projects, the default
   * app — `null` clears it; on admin projects, enabled, category and tags).
   *
   * @param {string} projectId
   * @param {Object} patch
   * @param {{actor: Object, authorize?: Function}} options
   * @returns {Promise<Object|null>}
   */
  async updateProject(projectId, patch, { actor, authorize }) {
    const allowed = isAdminProjectId(projectId)
      ? ['name', 'description', 'instructions', 'enabled', 'category', 'tags']
      : ['name', 'description', 'instructions', 'defaultAppId'];
    try {
      return await this.repository.mutate(
        projectId,
        project => {
          let changed = false;
          for (const key of allowed) {
            if (patch[key] === undefined) continue;
            // A cleared optional field is absent from the stored document.
            if (patch[key] === null) {
              if (project[key] !== undefined) {
                delete project[key];
                changed = true;
              }
            } else if (JSON.stringify(patch[key]) !== JSON.stringify(project[key])) {
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
    // The delete begins under the project's lock: `authorize` is judged
    // there and the project is marked `deleting`, so from here on no chat can
    // join it and no edit or transfer can land. The chats are detached while
    // the project still exists (outside its lock: the lock order is chat,
    // then project, see `moveChatToProject`); a detach that fails keeps the
    // marked project, its marker and the chat's association, and the same
    // delete can be retried. The document goes only once every chat is gone.
    let project = null;
    try {
      project = await this.repository.markDeleting(projectId, { authorize });
    } catch (error) {
      throw translateError(error);
    }
    if (!project) return null;
    const where = { component: COMPONENT, projectId };
    const failed = await this._detachChats(projectId, detachChat, where);
    if (failed.length > 0) {
      throw new ProjectError(
        'CASCADE_INCOMPLETE',
        `The project is kept: ${failed.length} chat(s) could not be detached from it`,
        { project: { id: projectId, ownership: project.ownership }, deleted: false, chats: failed }
      );
    }
    let removed = null;
    try {
      removed = await this.repository.delete(projectId, { authorize });
    } catch (error) {
      throw translateError(error);
    }
    // Gone meanwhile: another delete of the same project finished first.
    if (!removed) return null;
    await attempt(() => this.repository.deleteBlobs(projectId), 'text blobs', where);
    for (const hook of this.onDeleted) {
      await attempt(() => hook(removed), 'a delete hook', where);
    }
    return removed;
  }

  /**
   * Detach every chat the project's markers name; a marker goes only once its
   * chat is detached, so a failure leaves the record of what is still to do.
   * Only the chat id is reported: the storage error is in the log.
   *
   * @returns {Promise<Array<{chatId: string}>>} The chats still attached.
   */
  async _detachChats(projectId, detachChat, where) {
    let markers = [];
    try {
      markers = await this.repository.listChatMarkers(projectId, { all: true });
    } catch (error) {
      throw translateError(error);
    }
    const failed = [];
    for (const marker of markers) {
      try {
        if (typeof detachChat === 'function') await detachChat(marker.chatId);
        await this.repository.removeChatMarker(projectId, marker.chatId);
      } catch (error) {
        logger.error('Failed to detach a chat from a project being deleted', {
          ...where,
          chatId: marker.chatId,
          error: error.message
        });
        failed.push({ chatId: marker.chatId });
      }
    }
    return failed;
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
   *   `wait`: `true` waits for any text kind, `false` never waits (not even for
   *   `text`), omitted waits for `text` only (see `ProjectIngestService.start`).
   * @returns {Promise<{project: Object, item: Object}>}
   */
  async addItem(projectId, input, { user, authorize, origin, run = null, wait }) {
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
    } else {
      // The job of this item: only the run holding this attempt may record
      // its outcome (see `ProjectIngestService._run`).
      item.ingestAttempt = randomUUID();
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
            attempt: storedItem.ingestAttempt,
            purpose: 'upload'
          }
        : text !== null
          ? {
              text,
              contentType: ref.contentType || 'text/markdown',
              name: storedItem.name,
              attempt: storedItem.ingestAttempt,
              purpose: origin === 'written' ? 'write' : 'text'
            }
          : {
              fetch: ({ signal } = {}) => kind.fetch(storedItem, { user, purpose: 'pick', signal }),
              contentType: ref.mimeType,
              name: storedItem.name,
              attempt: storedItem.ingestAttempt,
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
          // `ingestAttempt` names this run: the job must still find it on
          // the item to install its text or record its failure.
          const now = nowIso();
          item.error = null;
          item.refreshingAt = now;
          item.ingestAttempt = randomUUID();
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
        fetch: ({ signal } = {}) =>
          target.kind.fetch(storedItem, { user, purpose: 'refresh', signal }),
        contentType: storedItem.ref?.mimeType,
        name: storedItem.name,
        previousBlobKey: storedItem.text?.blobKey || null,
        previousSnapshotAt: storedItem.snapshotAt || null,
        // The version the last fetch saw, so a change between that fetch
        // and the end of extraction is not mistaken for "unchanged".
        previousLastModified: storedItem.provenance?.source?.lastModified || null,
        attempt: storedItem.ingestAttempt,
        purpose: 'refresh'
      },
      { user, wait }
    );
    if (result?.error) throw new ProjectError(result.error.code, result.error.message);
    return { project: stored, item: result?.item || storedItem };
  }

  /**
   * Replace the stored text of a document the user wrote, uploaded or that
   * the migration imported: the successor of editing a source file in the
   * admin editor. The new text runs through the pipeline like written text
   * (scan, normalize, encrypt), the old blob goes once the new one is
   * installed, and the item is marked as written by the caller.
   *
   * @param {string} projectId
   * @param {string} itemId
   * @param {string} text
   * @param {{user: Object, authorize?: Function}} options
   * @returns {Promise<{project: Object, item: Object}>}
   * @throws {ProjectError} `INVALID_REF` for an item whose text is not
   *   editable (a link, a picked document) or an empty text,
   *   `PROJECT_MISMATCH` while the item is being processed
   */
  async replaceItemText(projectId, itemId, text, { user, authorize }) {
    if (!this.ingest) {
      throw new ProjectError(
        'INGEST_UNAVAILABLE',
        'Editing text is not available on this installation'
      );
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new ProjectError('INVALID_REF', 'The text is empty');
    }
    let stored = null;
    try {
      stored = await this.repository.mutate(
        projectId,
        project => {
          const item = (project.items || []).find(entry => entry.id === itemId);
          if (!item) throw new ProjectError('ITEM_NOT_FOUND', 'Item not found');
          if (!isItemTextEditable(item)) {
            throw new ProjectError(
              'INVALID_REF',
              'Only the text of an uploaded, written or imported document can be edited'
            );
          }
          // An imported text may be longer than an edit may be (20 000 000 against
          // 10 000 000 characters): saving a cut text would silently drop its end.
          if (Number(item.text?.chars) > MAX_ITEM_TEXT_CHARS) {
            throw new ProjectError(
              'INVALID_REF',
              'This text is longer than the editor takes; replace the document instead'
            );
          }
          if (item.status === 'pending' || item.status === 'extracting' || item.refreshingAt) {
            throw new ProjectError('PROJECT_MISMATCH', 'The item is still being processed');
          }
          // Reserved under the project's lock like a refresh: a second edit
          // or a refresh is refused until the job has installed the text.
          const now = nowIso();
          item.error = null;
          item.refreshingAt = now;
          item.ingestAttempt = randomUUID();
          item.updatedAt = now;
          return project;
        },
        { actor: actorOf(user), authorize, touchActivity: true }
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
        text,
        contentType: 'text/markdown',
        name: storedItem.name,
        previousBlobKey: storedItem.text?.blobKey || null,
        provenance: { origin: 'written', by: actorOf(user), at: nowIso() },
        attempt: storedItem.ingestAttempt,
        purpose: 'write'
      },
      { user, wait: true }
    );
    if (!result) throw new ProjectError('ITEM_NOT_FOUND', 'Item not found');
    if (result.error) throw new ProjectError(result.error.code, result.error.message);
    return { project: stored, item: result.item };
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
   * @param {{user: Object, authorize?: Function, expectUpdatedAt?: string}} options
   *   `expectUpdatedAt`: remove only an item still stamped so (`PROJECT_MISMATCH` otherwise).
   * @returns {Promise<Object|null>} The project after the removal, or null.
   */
  async removeItem(projectId, itemId, { user, authorize, expectUpdatedAt }) {
    let stored = null;
    let found = false;
    let removed = null;
    try {
      stored = await this.repository.mutate(
        projectId,
        project => {
          const before = (project.items || []).length;
          removed = (project.items || []).find(entry => entry.id === itemId) || null;
          // A move removes the item it copied: if it was changed meanwhile
          // (a refresh, an edit, a rename) the copy is stale and the item stays.
          if (expectUpdatedAt !== undefined && removed && removed.updatedAt !== expectUpdatedAt) {
            throw new ProjectError('PROJECT_MISMATCH', 'The item changed while it was being moved');
          }
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
   * @param {(item: Object) => void|false} update - Mutates the item in place;
   *   returning `false` leaves the project unwritten (the item is not what the
   *   caller expected any more).
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
        if (update(item) === false) return null;
        item.updatedAt = nowIso();
        return project;
      },
      { touchActivity: true }
    );
    return stored?.items?.find(entry => entry.id === itemId) || null;
  }

  // --- moving items ---------------------------------------------------------

  /**
   * Copy or move items of one project into another of the same ownership.
   *
   * A stored text is bound to its project and item by its encryption's
   * associated data, so the blob cannot simply change owner: the text is
   * decrypted, then encrypted again under the target (a fresh data key), with
   * everything else about the item (kind, reference, pin, provenance, the
   * original file's metadata) carried over. A link item is copied as is.
   *
   * Items go one at a time and each is independent: one that cannot go (not
   * ready yet, over the target's quota, unreadable text) is reported in
   * `failed` and the rest continue. A move writes the target first and
   * removes the source's item afterwards, so an interruption leaves a copy
   * rather than nothing; a source that cannot be changed rolls the target's
   * copy back.
   *
   * @param {string} sourceId
   * @param {string[]} itemIds
   * @param {string} targetId
   * @param {Object} options
   * @param {'copy'|'move'} [options.mode='copy']
   * @param {Object} options.user - The acting user.
   * @param {Function} [options.authorizeSource]
   * @param {Function} [options.authorizeTarget]
   * @returns {Promise<{mode: string, source: Object, target: Object,
   *   transferred: Array<{itemId: string, newItemId: string, name: string}>,
   *   failed: Array<{itemId: string, name?: string, code: string, message: string}>}>}
   * @throws {ProjectError} `PROJECT_NOT_FOUND`, `PROJECT_MISMATCH` (same
   *   project, or an admin and a user project)
   */
  async transferItems(
    sourceId,
    itemIds,
    targetId,
    { mode = 'copy', user, authorizeSource, authorizeTarget } = {}
  ) {
    if (mode !== 'copy' && mode !== 'move') {
      throw new ProjectError('INVALID_REF', `Unknown transfer mode: ${mode}`);
    }
    if (sourceId === targetId) {
      throw new ProjectError('PROJECT_MISMATCH', 'Choose a different project as the target');
    }
    const [source, target] = await Promise.all([
      this.repository.get(sourceId),
      this.repository.get(targetId)
    ]);
    if (!source || !target) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
    if (source.ownership !== target.ownership) {
      throw new ProjectError(
        'PROJECT_MISMATCH',
        'Items move between admin projects or between user projects, not across'
      );
    }
    const transferred = [];
    const failed = [];
    for (const itemId of new Set(itemIds || [])) {
      const name = (source.items || []).find(entry => entry.id === itemId)?.name;
      try {
        transferred.push(
          await this._transferItem(sourceId, itemId, targetId, {
            mode,
            user,
            authorizeSource,
            authorizeTarget
          })
        );
      } catch (error) {
        const translated = translateError(error);
        if (!(translated instanceof ProjectError)) {
          logger.warn('A project item could not be transferred', {
            component: COMPONENT,
            sourceId,
            targetId,
            itemId,
            code: translated.code,
            error: translated.message
          });
        }
        failed.push({
          itemId,
          ...(name ? { name } : {}),
          code: translated.code || 'ERROR',
          message: translated.message
        });
      }
    }
    const [after, targetAfter] = await Promise.all([
      this.repository.get(sourceId),
      this.repository.get(targetId)
    ]);
    return { mode, source: after || source, target: targetAfter || target, transferred, failed };
  }

  async _transferItem(
    sourceId,
    itemId,
    targetId,
    { mode, user, authorizeSource, authorizeTarget }
  ) {
    // Read again: an earlier item of the same call changed both projects.
    const source = await this.repository.get(sourceId);
    const target = await this.repository.get(targetId);
    if (!source || !target) throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
    const item = (source.items || []).find(entry => entry.id === itemId);
    if (!item) throw new ProjectError('ITEM_NOT_FOUND', 'Item not found');
    const isText = item.storage === 'text';
    if (
      item.refreshingAt ||
      (isText && !item.text?.blobKey) ||
      !['ready', 'stale'].includes(item.status)
    ) {
      throw new ProjectError(
        'ITEM_NOT_READY',
        'The item is still being processed or failed; wait for it or retry it first'
      );
    }
    const newId = (target.items || []).some(entry => entry.id === item.id) ? mintItemId() : item.id;
    // Refuse before the text is decrypted and encrypted again: a full target
    // would otherwise cost every item a round trip through the blob store.
    // The binding check runs again under the target's lock below.
    this._checkItemQuota(target, { bytes: Number(item.text?.original?.bytes) || 0 });
    const now = nowIso();

    let block = null;
    if (isText) {
      const text = await readText(source, item, {
        platform: this._platform(),
        repository: this.repository
      });
      block = await storeText({
        projectId: targetId,
        itemId: newId,
        text,
        original: item.text.original || {},
        truncated: item.text.truncated === true,
        platform: this._platform(),
        repository: this.repository,
        tenant: item.text.tenant || 'default'
      });
      // The text is the same text: it keeps the age of the extraction.
      if (item.text.extractedAt) block.extractedAt = item.text.extractedAt;
    }

    const copy = structuredClone(item);
    copy.id = newId;
    delete copy.ingestAttempt;
    delete copy.refreshingAt;
    delete copy.import;
    // The shipped documentation keeps syncing wherever it lives; a copy of it
    // is an independent document.
    if (mode === 'copy') {
      delete copy.managedFile;
      delete copy.managedSha256;
    }
    if (block) copy.text = block;
    copy.provenance = {
      ...(copy.provenance || {}),
      transferredFrom: { projectId: sourceId, itemId, mode, by: actorOf(user), at: now }
    };
    copy.updatedAt = now;

    const dropBlob = async () => {
      if (!block) return;
      await this.repository.blobs.delete(PROJECT_FILES_NAMESPACE, block.blobKey).catch(() => false);
      evictItemKeys(block.blobKey);
    };
    let stored = null;
    try {
      stored = await this.repository.mutate(
        targetId,
        project => {
          if ((project.items || []).some(entry => entry.id === newId)) {
            throw new ProjectError('PROJECT_MISMATCH', 'The target project changed; try again');
          }
          this._checkItemQuota(project, { bytes: Number(item.text?.original?.bytes) || 0 });
          project.items = [...(project.items || []), copy];
          return project;
        },
        { actor: actorOf(user), authorize: authorizeTarget }
      );
    } catch (error) {
      await dropBlob();
      throw translateError(error);
    }
    if (!stored) {
      await dropBlob();
      throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
    }
    for (const hook of this.onItemAdded) {
      await attempt(() => hook(targetId, newId, copy), 'an item hook', {
        component: COMPONENT,
        projectId: targetId,
        itemId: newId
      });
    }

    if (mode === 'move') {
      let removed = null;
      try {
        removed = await this.removeItem(sourceId, itemId, {
          user,
          authorize: authorizeSource,
          expectUpdatedAt: item.updatedAt
        });
      } catch (error) {
        await this.removeItem(targetId, newId, { user }).catch(() => null);
        throw translateError(error);
      }
      if (!removed) {
        await this.removeItem(targetId, newId, { user }).catch(() => null);
        throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
      }
    }
    return { itemId, newItemId: newId, name: copy.name };
  }

  /**
   * Merge admin projects into one: every item of each source is moved into
   * the target, the apps, workflows and agents that linked the source link
   * the target instead, and, when asked, the emptied source is deleted.
   *
   * A source whose items did not all move (an item still being processed, a
   * quota) is left as it is, with its links: its remaining items stay
   * reachable where they were, and the same merge can be run again.
   *
   * @param {string[]} sourceIds
   * @param {string} targetId
   * @param {Object} options
   * @param {Object} options.user
   * @param {boolean} [options.deleteSources=false]
   * @returns {Promise<{target: Object, sources: Array<Object>}>} One entry per
   *   source: `{id, moved, failed, relinked, merged, deleted}`.
   */
  async mergeProjects(sourceIds, targetId, { user, deleteSources = false } = {}) {
    if (!isAdminProjectId(targetId)) {
      throw new ProjectError('PROJECT_MISMATCH', 'Only admin projects can be merged');
    }
    const ids = [...new Set(sourceIds || [])];
    if (ids.includes(targetId)) {
      throw new ProjectError('PROJECT_MISMATCH', 'The target cannot also be a source');
    }
    for (const id of ids) {
      if (!isAdminProjectId(id)) {
        throw new ProjectError('PROJECT_MISMATCH', 'Only admin projects can be merged');
      }
      if (!(await this.repository.get(id))) {
        throw new ProjectError('PROJECT_NOT_FOUND', `Project not found: ${id}`);
      }
    }
    if (!(await this.repository.get(targetId))) {
      throw new ProjectError('PROJECT_NOT_FOUND', 'Project not found');
    }
    const sources = [];
    for (const id of ids) {
      let result;
      try {
        const source = await this.repository.get(id);
        result = await this.transferItems(
          id,
          (source?.items || []).map(entry => entry.id),
          targetId,
          { mode: 'move', user }
        );
      } catch (cause) {
        // A source deleted meanwhile, a storage error: this source is
        // reported and the others are still merged.
        const translated = translateError(cause);
        logger.error('Merging a project could not start', {
          component: COMPONENT,
          sourceId: id,
          targetId,
          error: translated.message
        });
        sources.push({
          id,
          moved: 0,
          failed: [],
          relinked: [],
          merged: false,
          deleted: false,
          error: translated.message
        });
        continue;
      }
      const merged = result.failed.length === 0 && (result.source.items || []).length === 0;
      let relinked = [];
      let deleted = false;
      let error = null;
      if (merged) {
        try {
          relinked = await relinkProjects([id], targetId);
          // An emptied source nothing links any more is only clutter.
          if (deleteSources) deleted = Boolean(await this.deleteProject(id));
        } catch (cause) {
          // The items are in the target already; what is left is the links
          // (or the delete), which the same merge can finish.
          logger.error('Merging a project could not finish', {
            component: COMPONENT,
            sourceId: id,
            targetId,
            error: cause.message
          });
          error = cause.message;
        }
      }
      sources.push({
        id,
        moved: result.transferred.length,
        failed: result.failed,
        relinked,
        merged,
        deleted,
        ...(error ? { error } : {})
      });
    }
    return { target: await this.repository.get(targetId), sources };
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
  async attachChat(projectId, chatId, { ownerId = null, authorize } = {}) {
    // Under the project's lock, so a deletion that lists the markers cannot
    // slip between the existence check and the marker; a project that is
    // gone answers null and gets no marker, and `authorize` is judged again
    // against the project as it is now (PROJECT_ACCESS_CHANGED).
    let stored;
    try {
      stored = await this.repository.mutate(
        projectId,
        async project => {
          await this.repository.addChatMarker(projectId, chatId, { ownerId });
          return project;
        },
        { authorize, touchActivity: true, touchUpdated: false }
      );
    } catch (error) {
      const translated = translateError(error);
      // A project whose delete has begun takes no chat: gone, like a missing one.
      if (translated.code === 'PROJECT_NOT_FOUND') return false;
      throw translated;
    }
    return Boolean(stored);
  }

  /** Forget a chat's membership. */
  async detachChat(projectId, chatId) {
    return this.repository.removeChatMarker(projectId, chatId);
  }

  /** Touch a project's `lastActivityAt` (a chat turn ran inside it). */
  touchActivity(projectId) {
    return attempt(
      () =>
        this.repository.mutate(projectId, project => ({ ...project }), {
          touchActivity: true,
          touchUpdated: false
        }),
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
/** The origins whose stored text an editor may replace in the dialog. */
export const EDITABLE_TEXT_ORIGINS = Object.freeze(['written', 'uploaded', 'imported']);

/**
 * Whether the text of an item can be edited in place: a stored text that
 * came from the user (written, uploaded) or from the sources migration, not
 * a link and not a document picked from a cloud drive or iFinder, whose text
 * is the source's.
 *
 * @param {Object} item
 * @returns {boolean}
 */
export function isItemTextEditable(item) {
  return (
    item?.storage === 'text' &&
    Boolean(item.text?.blobKey) &&
    EDITABLE_TEXT_ORIGINS.includes(item.provenance?.origin)
  );
}

/**
 * A new item of `kind`, as every creation path stores it.
 *
 * @param {Object} kind
 * @param {Object} ref
 * @param {{id?: string, name?: string, pinned?: boolean, cache?: Object}} input
 * @param {{user: Object, origin?: string, run?: string|null}} context
 * @returns {Object}
 */
function buildItem(kind, ref, input, { user, origin, run = null }) {
  const described = typeof kind.describe === 'function' ? kind.describe(ref, user?.language) : {};
  const now = nowIso();
  const link = kind.storage.ihub === 'link';
  const source =
    described.url || described.site ? { site: described.site, url: described.url } : null;
  return {
    id: input.id || mintItemId(),
    kind: kind.id,
    name: String(input.name || described.name || kind.id).slice(0, 300),
    ref,
    storage: kind.storage.ihub,
    pinned: input.pinned === true,
    status: link ? 'ready' : 'pending',
    error: null,
    provenance: {
      origin: origin || (link ? 'linked' : 'picked'),
      by: actorOf(user),
      at: now,
      run,
      source
    },
    snapshotAt: null,
    createdAt: now,
    updatedAt: now,
    ...(link ? { cache: input.cache || { ttlSeconds: 7200 } } : {})
  };
}

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
      cachedService.onItemAdded = previous.onItemAdded;
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
