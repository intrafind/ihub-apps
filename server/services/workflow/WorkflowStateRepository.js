/**
 * WorkflowStateRepository — workflow execution state on the storage provider.
 *
 * Every reader of a workflow checkpoint used to build its own
 * `path.join(stateDir, executionId, 'latest.json')`: the state manager's lazy
 * read, the resume manager, the orphan sweeper and the execution registry's
 * rescan. Four copies of the same path meant four places to change and four
 * chances to disagree. They all go through this repository now, and the
 * repository is the only thing that knows where a state actually lives.
 *
 * **Two locations, on purpose.** The storage provider's namespace directory
 * for `workflow-state` *is* the installation's existing
 * `contents/data/workflow-state/`: a document is `<executionId>.json` sitting
 * beside the legacy `<executionId>/latest.json` directories. They coexist
 * rather than one replacing the other, because an upgrade must not lose runs
 * that were checkpointed by the previous release and an import can be
 * interrupted half way. So:
 *
 *   - a **read** prefers the document and falls back to the legacy directory,
 *   - a **scan** returns the union of both, document winning on a duplicate,
 *   - a **write** goes to the document when a provider is available, and to
 *     the legacy directory when one is not,
 *   - a **remove** takes both, so a delete really deletes.
 *
 * That union is what stops a half-imported installation from looking empty to
 * the orphan sweeper — which would otherwise conclude that nothing is running
 * and, on the next boot, that everything failed.
 *
 * **A private directory with no provider is supported; the shared store losing
 * its provider is not.** A `StateManager` pointed at a directory of its own
 * (tests, tooling) deliberately gets a legacy-only repository — see
 * {@link resolveWorkflowStateRepository} — because a caller that redirected its
 * state must not have its writes land in the shared namespace. There, legacy
 * directories and atomic `latest.json` writes are the whole story.
 *
 * The shared repository is different. Once its states are documents, a boot
 * that cannot bring the provider up **refuses to write** rather than falling
 * back to `latest.json`, because falling back forks the store: `read()` prefers
 * the document unconditionally, so a checkpoint written to the legacy copy
 * while the provider was away is shadowed the moment it returns. Answering a
 * human checkpoint then resumes from several nodes back and re-runs
 * side-effecting nodes, with nothing anywhere saying so. A workflow that cannot
 * checkpoint fails where someone can see it; one that checkpoints into a copy
 * nobody will read again does not.
 *
 * @module services/workflow/WorkflowStateRepository
 */
import fs from 'fs/promises';
import path from 'path';
import config from '../../config.js';
import { getRootDir } from '../../pathUtils.js';
import logger from '../../utils/logger.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { StorageError } from '../../storage/errors.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';

const COMPONENT = 'WorkflowStateRepository';

/** Namespace holding one document per workflow execution state. */
export const WORKFLOW_STATE_NAMESPACE = RUNTIME_NAMESPACES.workflowState;

/** File a legacy execution directory keeps its newest checkpoint in. */
export const LEGACY_STATE_FILE = 'latest.json';

/**
 * The installation's workflow state directory.
 *
 * `'data'` is hard-coded, matching `StateManager` and `ExecutionRegistry`:
 * this is where the legacy directories already are, and an installation with
 * `DATA_DIR` overridden still has them here.
 */
export const DEFAULT_STATE_DIR = path.join(
  getRootDir(),
  config.CONTENTS_DIR,
  'data',
  'workflow-state'
);

/** Namespace holding the "this import already ran" markers. */
export const IMPORT_STATE_NAMESPACE = RUNTIME_NAMESPACES.runtimeImports;

/** Key of the workflow-state import marker within {@link IMPORT_STATE_NAMESPACE}. */
export const IMPORT_STATE_KEY = 'workflow-states';

/** Hard bound on how many legacy states one import carries over. */
export const MAX_IMPORT_STATES = 5000;

/**
 * Hard ceiling on how many states one scan considers.
 *
 * A scan that tried to hold an unbounded directory in memory would fail on the
 * installation that needs it most. Truncation is reported to the caller so it
 * can be logged with the context of whatever asked for the scan — a silently
 * short list reads as "that is all there is".
 */
export const MAX_SCAN_STATES = 20_000;

/** Documents fetched per `list` call while scanning the namespace. */
const SCAN_PAGE_SIZE = 200;

/**
 * Keys in this namespace that are not execution states.
 *
 * `execution-registry.json` has lived in this directory since long before it
 * became a storage namespace, and the document store would happily surface it
 * as a document called `execution-registry`. Reading it as a state is
 * harmless; *deleting* it as one would take the whole registry with it, so the
 * name is refused at every entry point rather than filtered at one.
 */
const RESERVED_KEYS = new Set(['execution-registry']);

/**
 * Directories the document store keeps its own bookkeeping in. They live
 * inside the namespace directory and must never be mistaken for executions.
 */
const RESERVED_DIRS = new Set(['.owners', '.locks']);

/**
 * Lease for the whole import. Long, because the import is the critical
 * section: a sibling worker that cannot take the lock skips the import
 * entirely rather than racing it.
 */
const IMPORT_LOCK_OPTIONS = { ttlMs: 300_000, waitMs: 1000 };

/**
 * Whether a parsed value looks like a workflow execution state.
 *
 * Deliberately loose: the shape has grown over releases and a state written by
 * an older version must still be readable. What it rules out is the other JSON
 * that shares this directory — the execution registry, a stray file, a
 * document envelope whose body never got written.
 *
 * @param {unknown} value - Parsed JSON.
 * @returns {boolean} True when the value can be treated as a state.
 */
export function isWorkflowState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.status === 'string' || typeof value.workflowId === 'string';
}

/**
 * The principal that owns an execution, in the registry's own vocabulary.
 *
 * Agent runs are owned by their service principal (`agent:<profileId>`) and
 * plain runs by the user who started them — the same two values
 * `ExecutionRegistry` stores as `userId`, so an owner-scoped listing of states
 * and an owner-scoped listing of run summaries agree.
 *
 * @param {Object} state - Execution state.
 * @returns {string|null} Owning principal id, or null when the state predates
 *   the fields that carry it.
 */
export function workflowStateOwnerId(state) {
  const profileId = state?.data?._agent?.profileId;
  if (typeof profileId === 'string' && profileId.length > 0) return `agent:${profileId}`;
  const startedBy = state?.data?._workflow?.startedBy;
  if (typeof startedBy === 'string' && startedBy.length > 0) return startedBy;
  return null;
}

/**
 * Whether an execution id can be used as a document key and a directory name.
 *
 * @param {string} executionId - Candidate id.
 * @returns {boolean}
 */
function isStorableId(executionId) {
  // `isValidId` already rejects traversal; the explicit `..` check keeps the
  // barrier visible to static analysis at the filesystem sink.
  if (!isValidId(executionId) || executionId.includes('..')) return false;
  return !RESERVED_KEYS.has(executionId);
}

/**
 * Milliseconds since the epoch for a timestamp that may be missing or junk.
 *
 * @param {unknown} value - ISO timestamp or anything else.
 * @returns {number} Parsed time, or `NaN` when it cannot be established.
 */
function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Workflow execution state, read and written through the storage provider
 * with the legacy on-disk layout as its fallback.
 */
export class WorkflowStateRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   *   Document facet; null keeps everything in the legacy directories.
   * @param {import('../../storage/LockManager.js').LockManager|null} [options.locks]
   *   Lock facet, used only to serialize the one-time legacy import.
   * @param {string} [options.stateDir] - Directory holding the legacy
   *   `<executionId>/latest.json` layout.
   * @param {Object} [options.logger] - Logger; defaults to the shared one.
   */
  constructor({
    documents = null,
    locks = null,
    stateDir = DEFAULT_STATE_DIR,
    shared = false,
    logger: log
  } = {}) {
    this.documents = documents || null;
    this.locks = locks || null;
    this.stateDir = stateDir || DEFAULT_STATE_DIR;
    // Set only by `getWorkflowStateRepository`. It is what separates "this
    // installation's store, whose provider is missing" from "a caller that
    // asked for a private directory", and only the first may not fall back.
    this.shared = shared === true;
    this.logger = log || logger;
  }

  /**
   * Whether states are stored as documents rather than legacy directories.
   *
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.documents);
  }

  /**
   * Read one execution's state.
   *
   * The document wins when there is one; the legacy directory answers for
   * everything the import has not carried over yet. An unreadable or
   * unparseable state reads as absent, which is what every caller already
   * expected from its own `try { JSON.parse } catch { null }`.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {Promise<Object|null>} The state, or null when there is none.
   */
  async read(executionId) {
    if (!isStorableId(executionId)) {
      this.logger.warn('Invalid executionId for workflow state read', {
        component: COMPONENT,
        executionId: String(executionId).slice(0, 64)
      });
      return null;
    }

    if (this.documents) {
      try {
        const doc = await this.documents.get(WORKFLOW_STATE_NAMESPACE, executionId);
        if (isWorkflowState(doc?.data)) return doc.data;
      } catch (error) {
        // Falling through to the legacy copy is strictly better than failing
        // the read: the state may well still be on disk in the old layout.
        this.logger.warn('Could not read workflow state document', {
          component: COMPONENT,
          executionId,
          error: error.message
        });
      }
    }

    return this._readLegacy(executionId);
  }

  /**
   * Persist an execution's state.
   *
   * @param {string} executionId - Execution identifier.
   * @param {Object} state - The state to store.
   * @param {Object} [options]
   * @param {string|null} [options.ownerId] - Owning principal; see
   *   {@link workflowStateOwnerId}.
   * @returns {Promise<void>}
   * @throws {Error} When `executionId` cannot be used as a key.
   */
  async write(executionId, state, { ownerId = null } = {}) {
    if (!isStorableId(executionId)) {
      throw new Error(
        `Invalid executionId for workflow state: ${String(executionId).slice(0, 64)}`
      );
    }

    if (this.documents) {
      await this.documents.put(WORKFLOW_STATE_NAMESPACE, executionId, state, {
        ownerId: typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : null
      });
      return;
    }

    if (this.shared) {
      // Not a fallback — a fork. See the module header: the legacy copy this
      // would write is shadowed by the stale document as soon as the provider
      // is back, and the run silently resumes from where the document left
      // off. Failing here is the only outcome anybody notices.
      throw new StorageError(
        `Cannot checkpoint workflow state for ${executionId}: the storage provider is unavailable`,
        { code: 'STORAGE_UNAVAILABLE' }
      );
    }

    const dir = this._legacyDir(executionId);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteJSON(this._legacyFile(executionId), state);
  }

  /**
   * Remove an execution's state from both locations.
   *
   * Both are attempted even when one fails: leaving half a state behind would
   * let a scan resurrect a run that was explicitly deleted.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {Promise<boolean>} True when something was actually removed.
   */
  async remove(executionId) {
    if (!isStorableId(executionId)) {
      this.logger.warn('Invalid executionId for workflow state removal', {
        component: COMPONENT,
        executionId: String(executionId).slice(0, 64)
      });
      return false;
    }

    let removed = false;
    if (this.documents) {
      try {
        removed = (await this.documents.delete(WORKFLOW_STATE_NAMESPACE, executionId)) || removed;
      } catch (error) {
        this.logger.warn('Could not remove workflow state document', {
          component: COMPONENT,
          executionId,
          error: error.message
        });
      }
    }

    try {
      // No `force`, so a missing directory is distinguishable from a removed
      // one and the caller's count means something.
      await fs.rm(this._legacyDir(executionId), { recursive: true });
      removed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('Could not remove legacy workflow state directory', {
          component: COMPONENT,
          executionId,
          error: error.message
        });
      }
    }

    return removed;
  }

  /**
   * Every known execution, as metadata only.
   *
   * Cheap enough to run over the whole namespace: document bodies are not
   * read, so a state carrying a whole workflow definition costs one directory
   * entry rather than hundreds of kilobytes. Callers that then need the state
   * itself read only the entries they care about.
   *
   * @param {Object} [options]
   * @param {string} [options.prefix] - Keep only ids starting with this.
   * @param {number} [options.max] - Hard record bound.
   * @returns {Promise<{items: Array<{executionId: string, updatedAt: number,
   *   legacy: boolean}>, truncated: boolean}>} The scan and whether the bound
   *   cut it short.
   */
  async listSummaries({ prefix = null, max = MAX_SCAN_STATES } = {}) {
    return this._scan({ prefix, max, includeData: false, legacyOnly: false });
  }

  /**
   * Every known execution together with its state.
   *
   * Entries whose state cannot be read are dropped, matching what the raw
   * `JSON.parse` in each of the previous scanners did.
   *
   * @param {Object} [options]
   * @param {string} [options.prefix] - Keep only ids starting with this.
   * @param {number} [options.max] - Hard record bound.
   * @returns {Promise<{items: Array<{executionId: string, state: Object,
   *   updatedAt: number, legacy: boolean}>, truncated: boolean}>}
   */
  async list({ prefix = null, max = MAX_SCAN_STATES } = {}) {
    const scan = await this._scan({ prefix, max, includeData: true, legacyOnly: false });
    return { items: scan.items.filter(item => item.state), truncated: scan.truncated };
  }

  /**
   * Executions that exist only in the legacy directory layout, as metadata.
   *
   * This is what the one-time import walks; nothing else should need it.
   *
   * @param {Object} [options]
   * @param {string} [options.prefix] - Keep only ids starting with this.
   * @param {number} [options.max] - Hard record bound.
   * @returns {Promise<{items: Array<{executionId: string, updatedAt: number,
   *   legacy: boolean}>, truncated: boolean}>}
   */
  async listLegacy({ prefix = null, max = MAX_SCAN_STATES } = {}) {
    return this._scan({ prefix, max, includeData: false, legacyOnly: true });
  }

  /**
   * Walk both locations into one deduplicated list.
   *
   * The document copy wins over the legacy copy of the same execution: after
   * an import the two are the same state, and after a write they are not — the
   * document is the newer one.
   *
   * @param {Object} options
   * @param {string|null} options.prefix - Id prefix filter, or null.
   * @param {number} options.max - Hard record bound.
   * @param {boolean} options.includeData - Whether to read the states.
   * @param {boolean} options.legacyOnly - Skip the document namespace.
   * @returns {Promise<{items: Object[], truncated: boolean}>}
   * @private
   */
  async _scan({ prefix, max, includeData, legacyOnly }) {
    const bound = Number.isFinite(max) && max > 0 ? max : MAX_SCAN_STATES;
    const found = new Map();
    let truncated = false;

    if (this.documents && !legacyOnly) {
      let cursor = null;
      do {
        let page;
        try {
          page = await this.documents.list(WORKFLOW_STATE_NAMESPACE, {
            limit: SCAN_PAGE_SIZE,
            includeData,
            ...(prefix ? { prefix } : {}),
            ...(cursor ? { cursor } : {})
          });
        } catch (error) {
          this.logger.warn('Could not list the workflow state namespace', {
            component: COMPONENT,
            error: error.message
          });
          break;
        }
        for (const doc of page.items) {
          if (RESERVED_KEYS.has(doc.key)) continue;
          if (includeData && !isWorkflowState(doc.data)) continue;
          found.set(doc.key, {
            executionId: doc.key,
            updatedAt: parseTime(doc.updatedAt),
            legacy: false,
            ...(includeData ? { state: doc.data } : {})
          });
        }
        cursor = page.nextCursor;
      } while (cursor && found.size < bound);
      if (cursor) truncated = true;
    }

    for (const entry of await this._readdirLegacy()) {
      if (found.size >= bound) {
        truncated = true;
        break;
      }
      if (!entry.isDirectory()) continue;
      if (RESERVED_DIRS.has(entry.name) || !isStorableId(entry.name)) continue;
      if (prefix && !entry.name.startsWith(prefix)) continue;
      if (found.has(entry.name)) continue;

      const state = includeData ? await this._readLegacy(entry.name) : null;
      if (includeData && !state) continue;
      found.set(entry.name, {
        executionId: entry.name,
        updatedAt: state ? this._stateTime(state) : await this._legacyModifiedAt(entry.name),
        legacy: true,
        ...(includeData ? { state } : {})
      });
    }

    return { items: [...found.values()], truncated };
  }

  /** Legacy directory of one execution. @private */
  _legacyDir(executionId) {
    return path.join(this.stateDir, executionId);
  }

  /** Legacy checkpoint file of one execution. @private */
  _legacyFile(executionId) {
    return path.join(this.stateDir, executionId, LEGACY_STATE_FILE);
  }

  /**
   * Parse an execution's legacy checkpoint, or null when there is not a
   * readable one.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {Promise<Object|null>}
   * @private
   */
  async _readLegacy(executionId) {
    try {
      const raw = await fs.readFile(this._legacyFile(executionId), 'utf8');
      const parsed = JSON.parse(raw);
      return isWorkflowState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * When a legacy checkpoint was last written, for a scan that did not read it.
   *
   * @param {string} executionId - Execution identifier.
   * @returns {Promise<number>} Milliseconds since the epoch, or `NaN`.
   * @private
   */
  async _legacyModifiedAt(executionId) {
    try {
      return (await fs.stat(this._legacyFile(executionId))).mtimeMs;
    } catch {
      return NaN;
    }
  }

  /**
   * The most recent timestamp a state carries.
   *
   * @param {Object} state - Execution state.
   * @returns {number} Milliseconds since the epoch, or `NaN`.
   * @private
   */
  _stateTime(state) {
    for (const candidate of [state?.completedAt, state?.updatedAt, state?.createdAt]) {
      const parsed = parseTime(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
    return NaN;
  }

  /**
   * Entries of the legacy state directory, reporting a missing one as empty.
   *
   * A directory that cannot be read is logged and treated as empty rather than
   * thrown: both callers run at boot, and refusing to start because one
   * directory is unreadable is worse than starting without resuming.
   *
   * @returns {Promise<import('fs').Dirent[]>}
   * @private
   */
  async _readdirLegacy() {
    try {
      return await fs.readdir(this.stateDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('Cannot read the workflow state directory', {
          component: COMPONENT,
          stateDir: this.stateDir,
          error: error.message
        });
      }
      return [];
    }
  }
}

/** @type {WorkflowStateRepository|null} */
let cachedRepository = null;
/** @type {Object|null|undefined} */
let cachedProvider;

/**
 * The process-wide workflow state repository over the bootstrapped storage
 * provider.
 *
 * Rebuilt when the provider changes (a test swapping one in, a shutdown
 * followed by a fresh bootstrap). Before storage is up — or when it failed to
 * come up — it returns a repository that keeps using the legacy directories,
 * so callers never branch on initialization order.
 *
 * @returns {WorkflowStateRepository}
 */
export function getWorkflowStateRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new WorkflowStateRepository({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks'),
      shared: true,
      logger
    });
  }
  return cachedRepository;
}

/**
 * The repository serving a given state directory.
 *
 * The installation's own directory is served by the shared, provider-backed
 * repository. Any other directory gets a legacy-only repository bound to it:
 * a caller that pointed its state somewhere private (a test's temporary
 * directory, a maintenance script) is asking for that directory to be the
 * whole store, and silently writing into the shared namespace instead would
 * scatter its data across two installations' worth of paths.
 *
 * @param {string} [stateDir] - Directory the caller stores state in.
 * @returns {WorkflowStateRepository}
 */
export function resolveWorkflowStateRepository(stateDir) {
  if (!stateDir || stateDir === DEFAULT_STATE_DIR) return getWorkflowStateRepository();
  return new WorkflowStateRepository({ stateDir });
}

/**
 * Import the legacy `<executionId>/latest.json` directories into the
 * `workflow-state` namespace, once.
 *
 * Safe to call on every boot, and safe to interrupt:
 *
 *   - **Idempotent.** A state that already has a document is left alone, so a
 *     retry finishes the job rather than overwriting newer data with an older
 *     copy of itself, and the marker short-circuits the whole thing afterwards.
 *   - **Never destructive.** The legacy directories stay exactly where they
 *     are. A later release removes them; until then they remain the fallback
 *     for everything this import could not carry over, and every read and scan
 *     in this module still consults them.
 *   - **Bounded.** A very large directory is imported newest-first up to
 *     `maxStates` and the truncation is logged. What is left behind is still
 *     readable through the legacy path.
 *
 * @param {Object} [options]
 * @param {WorkflowStateRepository} [options.repository] - Repository to write
 *   through; defaults to the process-wide one.
 * @param {number} [options.maxStates] - Import bound.
 * @param {boolean} [options.force=false] - Import again even though the marker
 *   says it already ran (tests, a manual re-import).
 * @param {Object} [options.logger] - Logger.
 * @returns {Promise<{ran: boolean, reason?: string, imported: number,
 *   skipped: number, truncated: boolean, candidates: number}>} What the import
 *   did. `ran: false` means it decided there was nothing for it to do, never
 *   that it failed.
 */
export async function importLegacyWorkflowStates({
  repository,
  maxStates = MAX_IMPORT_STATES,
  force = false,
  logger: log = logger
} = {}) {
  const repo = repository || getWorkflowStateRepository();
  const idle = { ran: false, imported: 0, skipped: 0, truncated: false, candidates: 0 };
  if (!repo.isAvailable()) {
    log.debug?.('No storage provider; legacy workflow states stay where they are', {
      component: COMPONENT
    });
    return { ...idle, reason: 'storage-unavailable' };
  }

  const documents = repo.documents;

  /**
   * Whether the import has already completed.
   *
   * Read twice: once before the lock, so a later boot costs one document
   * read, and once inside it, because on the *first* boot every worker passes
   * the outer check at the same moment and would otherwise each rescan the
   * whole legacy directory behind the lock to import nothing.
   *
   * @returns {Promise<boolean>}
   */
  const alreadyImported = async () => {
    if (force) return false;
    const marker = await documents.get(IMPORT_STATE_NAMESPACE, IMPORT_STATE_KEY);
    return Boolean(marker?.data?.completedAt);
  };

  if (await alreadyImported()) return { ...idle, reason: 'already-imported' };

  const run = async () => {
    if (await alreadyImported()) return { ...idle, reason: 'already-imported' };
    const scan = await repo.listLegacy({ max: MAX_SCAN_STATES });
    // Newest first, so a bound that cuts the import keeps the runs a user is
    // most likely to go looking for. An unknown timestamp sorts last rather
    // than crowding out states whose age is known.
    const ordered = [...scan.items].sort((a, b) => {
      const left = Number.isFinite(a.updatedAt) ? a.updatedAt : 0;
      const right = Number.isFinite(b.updatedAt) ? b.updatedAt : 0;
      if (left !== right) return right - left;
      return a.executionId < b.executionId ? -1 : 1;
    });
    const truncated = scan.truncated || ordered.length > maxStates;
    const selected = ordered.length > maxStates ? ordered.slice(0, maxStates) : ordered;

    let imported = 0;
    let skipped = 0;
    for (const { executionId } of selected) {
      if (await documents.get(WORKFLOW_STATE_NAMESPACE, executionId)) {
        skipped += 1;
        continue;
      }
      // The legacy copy specifically, not `read()`: by the time the import
      // reaches a state a concurrent checkpoint may have written a document
      // for it, and `read()` would hand back that newer copy to be written
      // over itself.
      const state = await repo._readLegacy(executionId);
      if (!state) {
        skipped += 1;
        continue;
      }
      try {
        await repo.write(executionId, state, { ownerId: workflowStateOwnerId(state) });
        imported += 1;
      } catch (error) {
        skipped += 1;
        log.warn('Could not import a legacy workflow state', {
          component: COMPONENT,
          executionId,
          error: error.message
        });
      }
    }

    await documents.put(IMPORT_STATE_NAMESPACE, IMPORT_STATE_KEY, {
      completedAt: new Date().toISOString(),
      imported,
      skipped,
      truncated,
      candidates: ordered.length
    });

    const result = { ran: true, imported, skipped, truncated, candidates: ordered.length };
    if (ordered.length === 0) {
      log.debug?.('No legacy workflow states to import', { component: COMPONENT });
    } else {
      log.info('Imported legacy workflow states into the workflow-state namespace', {
        component: COMPONENT,
        ...result,
        ...(truncated ? { bound: maxStates } : {})
      });
    }
    return result;
  };

  if (!repo.locks) return run();
  try {
    return await repo.locks.withLock('runtime-import:workflow-states', run, IMPORT_LOCK_OPTIONS);
  } catch (error) {
    if (error?.code === 'LOCK_TIMEOUT') {
      // Another worker is importing the same states; there is nothing useful
      // this one could add by waiting.
      log.debug?.('Legacy workflow state import is already running elsewhere', {
        component: COMPONENT
      });
      return { ...idle, reason: 'in-progress' };
    }
    throw error;
  }
}

export default WorkflowStateRepository;
