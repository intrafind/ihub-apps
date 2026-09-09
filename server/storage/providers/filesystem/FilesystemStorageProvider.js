/**
 * The filesystem storage provider — the default backend, and the reference
 * implementation of the storage contract.
 *
 * Everything lives under one base directory (`contents/data` unless configured
 * otherwise) and the four facets divide it up:
 *
 *   <base>/<ns>/…      documents and their per-owner index
 *   <base>/logs/…      append-only streams and their blobs
 *   <base>/locks/…     lease files
 *
 * It is deliberately single-instance: exclusion reaches the cluster workers
 * that share the volume (`advisory-single-machine`) and change events reach
 * this process only (`in-process`). Running two installations against one
 * directory is not supported — that is what a database-backed provider is for,
 * and `getCapabilities().multiInstance` says so rather than leaving callers to
 * guess.
 *
 * Nothing in the running server uses this yet; it is the foundation for
 * durable chats and ships inert.
 *
 * @module storage/providers/filesystem/FilesystemStorageProvider
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getRootDir } from '../../../pathUtils.js';
import serverConfig from '../../../config.js';
import logger from '../../../utils/logger.js';
import { StorageProvider } from '../../StorageProvider.js';
import { StorageError } from '../../errors.js';
import { FilesystemChangeNotifier } from './FilesystemChangeNotifier.js';
import { FilesystemDocumentStore } from './FilesystemDocumentStore.js';
import { FilesystemAppendLog } from './FilesystemAppendLog.js';
import { FilesystemLockManager } from './FilesystemLockManager.js';

const COMPONENT = 'FilesystemStorageProvider';

/** Registry name; also reported by `healthCheck()`. */
const PROVIDER_NAME = 'filesystem';

/** Debounce for buffered append-log writes when the config says nothing. */
const DEFAULT_FLUSH_INTERVAL_MS = 2000;

/** Namespace the health probe writes to, kept apart from any real data. */
const HEALTH_NS = '_health';

/**
 * Resolve the provider's base directory from its configuration.
 *
 * Three sources, most explicit first: an absolute `baseDir` (what tests pass),
 * a `dataDir` relative to `contents/` (what an administrator sets in
 * `platform.json`), and otherwise the installation default `contents/data`
 * built from the same `CONTENTS_DIR`/`DATA_DIR` settings the rest of the
 * server uses. `dataDir` is joined rather than resolved so that a value that
 * looks absolute still lands under `contents/` — an absolute location is
 * requested with `baseDir`, deliberately.
 *
 * @param {Object} [config={}] - Provider configuration
 * @param {string} [config.baseDir] - Absolute directory to use as-is
 * @param {string} [config.dataDir] - Directory under `contents/`
 * @returns {string} Absolute base directory
 */
export function resolveFilesystemBaseDir(config = {}) {
  if (typeof config.baseDir === 'string' && config.baseDir.length > 0) {
    return path.resolve(config.baseDir);
  }
  const contentsDir = path.join(getRootDir(), serverConfig.CONTENTS_DIR);
  if (typeof config.dataDir === 'string' && config.dataDir.length > 0) {
    return path.join(contentsDir, config.dataDir);
  }
  return path.join(contentsDir, serverConfig.DATA_DIR);
}

/**
 * Filesystem {@link StorageProvider}.
 */
export class FilesystemStorageProvider extends StorageProvider {
  /**
   * @param {Object} [config={}] - Provider configuration, from
   *   `platform.json → storage.filesystem`
   * @param {string} [config.baseDir] - Absolute base directory (tests)
   * @param {string} [config.dataDir='data'] - Base directory under `contents/`
   * @param {number} [config.flushIntervalMs=2000] - Append-log flush debounce
   */
  constructor(config = {}) {
    super(config);
    this._baseDir = resolveFilesystemBaseDir(config);
    const flushIntervalMs =
      typeof config.flushIntervalMs === 'number' && config.flushIntervalMs > 0
        ? config.flushIntervalMs
        : DEFAULT_FLUSH_INTERVAL_MS;

    // The notifier is constructed first because the document store publishes
    // through it: one notifier per provider, so every facet's events reach the
    // same subscribers.
    this._notifier = new FilesystemChangeNotifier();
    this._documents = new FilesystemDocumentStore({
      baseDir: this._baseDir,
      notifier: this._notifier
    });
    this._logs = new FilesystemAppendLog({ baseDir: this._baseDir, flushIntervalMs });
    this._locks = new FilesystemLockManager({ baseDir: this._baseDir });

    this._initialized = false;
    this._shutdownStarted = false;
  }

  /**
   * Registry name of this provider.
   * @returns {string}
   */
  get name() {
    return PROVIDER_NAME;
  }

  /**
   * Absolute directory every facet stores under.
   * @returns {string}
   */
  get baseDir() {
    return this._baseDir;
  }

  /**
   * The document facet.
   * @returns {FilesystemDocumentStore}
   */
  get documents() {
    return this._documents;
  }

  /**
   * The append-log facet.
   * @returns {FilesystemAppendLog}
   */
  get logs() {
    return this._logs;
  }

  /**
   * The change-notification facet.
   * @returns {FilesystemChangeNotifier}
   */
  get notifier() {
    return this._notifier;
  }

  /**
   * The locking facet.
   * @returns {FilesystemLockManager}
   */
  get locks() {
    return this._locks;
  }

  /**
   * Create the base directory. Idempotent — the registry and a test harness
   * may both initialize the same instance.
   *
   * Only the base directory is created here: namespaces, the log tree and the
   * lock directory are created on first write by the facet that owns them, so
   * an installation that never uses a facet never grows an empty directory for it.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;
    await fs.mkdir(this._baseDir, { recursive: true });
    this._initialized = true;
    logger.debug('Filesystem storage provider initialized', {
      component: COMPONENT,
      baseDir: this._baseDir
    });
  }

  /**
   * Flush and stop the append log, then close the notifier.
   *
   * Nothing may keep the event loop alive afterwards: the append log's
   * debounce and safety-net timers are the only handles this provider owns,
   * and a leaked one hangs `node --test`. Idempotent, and never throws — a
   * shutdown that reports an I/O failure by rejecting would mask the reason
   * the process is shutting down in the first place.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this._shutdownStarted) return;
    this._shutdownStarted = true;
    try {
      await this._logs.flush();
    } catch (error) {
      logger.error('Failed to flush storage append log during shutdown', {
        component: COMPONENT,
        error
      });
    }
    // Stopping the timers is not part of the AppendLog contract — buffering is
    // a filesystem implementation detail — so whichever teardown hook the log
    // exposes is called here.
    if (typeof this._logs.stop === 'function') {
      this._logs.stop();
    } else if (typeof this._logs.close === 'function') {
      await this._logs.close();
    }
    await this._notifier.close();
  }

  /**
   * Round-trip a probe document and report how long it took.
   *
   * A real write plus a real read, because that is the failure this is meant
   * to catch: a base directory that is read-only, full, or on a network mount
   * that stopped answering. The probe lives in its own `_health` namespace and
   * is always removed again — including when the write succeeded and the read
   * failed, which is exactly the case that would otherwise leave litter behind.
   * Its put/delete raise ordinary `document.*` events, so subscribers that care
   * about real data filter on the namespace.
   *
   * @returns {Promise<import('../../StorageProvider.js').HealthCheckResult>}
   */
  async healthCheck() {
    const startedAt = Date.now();
    const key = `probe-${crypto.randomUUID()}`;
    try {
      const written = await this._documents.put(HEALTH_NS, key, { at: new Date().toISOString() });
      const read = await this._documents.get(HEALTH_NS, key);
      if (!read || read.etag !== written.etag) {
        throw new StorageError('Health probe document did not read back', {
          code: 'HEALTH_PROBE_FAILED'
        });
      }
      return {
        status: 'ok',
        provider: PROVIDER_NAME,
        latencyMs: Date.now() - startedAt,
        details: { baseDir: this._baseDir }
      };
    } catch (error) {
      logger.error('Filesystem storage health check failed', {
        component: COMPONENT,
        baseDir: this._baseDir,
        error
      });
      return {
        status: 'error',
        provider: PROVIDER_NAME,
        latencyMs: Date.now() - startedAt,
        details: { baseDir: this._baseDir, code: error?.code, message: error?.message }
      };
    } finally {
      try {
        await this._documents.delete(HEALTH_NS, key);
      } catch (error) {
        logger.warn('Failed to remove storage health probe document', {
          component: COMPONENT,
          error
        });
      }
    }
  }

  /**
   * What this provider supports.
   *
   * @returns {import('../../StorageProvider.js').Capabilities}
   */
  getCapabilities() {
    return {
      transactions: false,
      notifications: 'in-process',
      locking: 'advisory-single-machine',
      search: false,
      multiInstance: false,
      blobs: true,
      conditionalWrites: true
    };
  }
}

export default FilesystemStorageProvider;
