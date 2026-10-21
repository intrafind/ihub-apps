// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ProjectIngestService — how text enters a project (spec 3 §1):
 *
 *     receive ─► scan hook ─► extract ─► encrypt ─► blobs.put ─► item ready
 *
 * One pipeline for every entry: an upload (a temp file multer wrote), a
 * picked cloud document (a `fetch` the kind supplies, run with the picking
 * user's token), a refresh of such an item, a write-back from a workflow
 * (`text`), and an admin's pasted text. Jobs run on a per-worker queue
 * (concurrency from `projects.ingest.concurrency`, 2 by default) on the
 * worker that received the file: the temp file is local. A job holds no HTTP
 * connection; `item.status` moves `pending → extracting → ready | failed`
 * under the project lock, so a client polling the item sees progress and a
 * crashed worker leaves a visible state the reconciler (§8) settles.
 *
 * The original is gone in every outcome: the temp file is unlinked and the
 * fetched bytes dropped once the text is stored.
 *
 * @module services/projects/ProjectIngestService
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../utils/logger.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import { recordUpload } from '../../telemetry/metrics.js';
import { OAuthRefreshError } from '../integrations/oauthRefreshError.js';
import { KnowledgeError } from '../knowledge/types.js';
import { PROJECT_FILES_NAMESPACE, getProjectRepository, usageOf } from './ProjectRepository.js';
import { ProjectError } from './projectErrors.js';
import { projectSettings } from './projectSettings.js';
import { ExtractionError, MAX_TEXT_CHARS, extractText, normalizeText } from './extractText.js';
import { storeText, evictItemKeys } from './ItemTextStore.js';
import { scannerFor } from './scan/MalwareScanner.js';

const COMPONENT = 'ProjectIngestService';

/** Where uploads wait for extraction: a private directory per request. */
export const UPLOAD_TEMP_DIR = ['data', 'tmp', 'project-uploads'];

/** Temp directories and orphan blobs older than this are swept. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

/** The error code of an item whose job never finished. */
export const INTERRUPTED = 'INTERRUPTED';

/**
 * The temp directory of the upload pipeline.
 *
 * @returns {string}
 */
export function uploadTempDir() {
  return getContentsPath(...UPLOAD_TEMP_DIR);
}

function errorOf(error) {
  if (
    error instanceof ProjectError ||
    error instanceof ExtractionError ||
    error instanceof KnowledgeError
  ) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof OAuthRefreshError) {
    return { code: 'SOURCE_FORBIDDEN', message: error.message };
  }
  const message = String(error?.message || 'ingest failed');
  if (/\b(404|410)\b|not found|gone|no longer/i.test(message)) {
    return { code: 'SOURCE_GONE', message };
  }
  if (/\b(401|403)\b|forbidden|denied|reconnect|unauthori[sz]ed/i.test(message)) {
    return { code: 'SOURCE_FORBIDDEN', message };
  }
  return { code: 'EXTRACTION_FAILED', message };
}

function outcomeOf(code) {
  switch (code) {
    case 'QUOTA_FILES':
    case 'QUOTA_PROJECT_BYTES':
    case 'QUOTA_FILE_BYTES':
      return 'rejected_quota';
    case 'UNSUPPORTED_TYPE':
      return 'rejected_type';
    case 'SCAN_REJECTED':
      return 'rejected_scan';
    default:
      return 'failed';
  }
}

async function removeQuietly(target) {
  if (!target) return;
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // Already gone, or never created.
  }
}

/** The minted time of a blob version (`ItemTextStore.mintVersionId`). */
function versionTimeOf(blobKey) {
  const versionId = String(blobKey || '').split('__')[2] || '';
  const stamp = parseInt(versionId.slice(0, 9), 36);
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * The pipeline.
 */
export class ProjectIngestService {
  /**
   * @param {Object} options
   * @param {import('./ProjectService.js').ProjectService} options.service
   * @param {import('./ProjectRepository.js').ProjectRepository} [options.repository]
   * @param {() => Object} [options.platform] - Returns the platform configuration.
   * @param {Object} [options.scanner] - A `MalwareScanner`; built from the settings when absent.
   * @param {string} [options.tempDir]
   * @param {(projectId: string, item: Object) => void} [options.onReady] - Cache eviction hook.
   */
  constructor({ service, repository, platform, scanner, tempDir, onReady } = {}) {
    // Both may be functions: the process-wide service and repository are
    // rebuilt when the storage provider changes (tests), so a long-lived
    // pipeline resolves them per job.
    this._service = service;
    this._repository = repository || null;
    this._platform = platform || (() => ({}));
    this._scanner = scanner || null;
    this.tempDir = tempDir || uploadTempDir();
    this.onReady = onReady || (() => {});
    this.queue = [];
    this.active = new Map();
    this.running = 0;
  }

  get service() {
    return typeof this._service === 'function' ? this._service() : this._service;
  }

  get repository() {
    if (typeof this._repository === 'function') return this._repository();
    return this._repository || this.service?.repository || getProjectRepository();
  }

  settings() {
    return projectSettings(this._platform());
  }

  scanner() {
    if (this._scanner) return this._scanner;
    return scannerFor(this.settings().scan);
  }

  /** A fresh private directory for one upload. */
  async newTempDir() {
    await fs.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    return fs.mkdtemp(path.join(this.tempDir, 'u-'));
  }

  // --- jobs -------------------------------------------------------------------

  /**
   * Queue (or, for text handed in, run at once) the job of one item.
   *
   * @param {Object} project - As stored, with the item already `pending`.
   * @param {Object} item
   * @param {Object} input - One of `{path}`, `{bytes}`, `{text}` or `{fetch}`,
   *   with `contentType`, `name` and `bytes` (a size) as known; `previousBlobKey`
   *   on a refresh; `purpose` (`upload`, `pick`, `refresh`, `write`, `import`).
   * @param {{user?: Object, authorize?: Function, wait?: boolean}} [options]
   * @returns {Promise<{item: Object}|null>} The finished item when the job ran
   *   inline, otherwise null (the caller polls).
   */
  async start(project, item, input, { user, wait } = {}) {
    const job = {
      projectId: project.id,
      itemId: item.id,
      input,
      user,
      startedAt: Date.now()
    };
    const inline = wait === true || typeof input.text === 'string';
    const promise = inline ? this._run(job) : this._enqueue(job);
    if (!inline) return null;
    return promise;
  }

  _enqueue(job) {
    return new Promise(resolve => {
      this.queue.push({ job, resolve });
      this._pump();
    });
  }

  _pump() {
    const limit = this.settings().ingest.concurrency;
    while (this.running < limit && this.queue.length) {
      const { job, resolve } = this.queue.shift();
      this.running += 1;
      void this._run(job)
        .catch(() => null)
        .then(result => {
          this.running -= 1;
          resolve(result);
          this._pump();
        });
    }
  }

  /** Whether a job for this item is queued or running on this worker. */
  isActive(itemId) {
    return this.active.has(itemId) || this.queue.some(entry => entry.job.itemId === itemId);
  }

  async _run(job) {
    this.active.set(job.itemId, job);
    const { projectId, itemId, input } = job;
    const where = { component: COMPONENT, projectId, itemId };
    let bytes = null;
    let name = input.name;
    let contentType = input.contentType;
    let storedBlobKey = null;
    const refresh = input.purpose === 'refresh' && Boolean(input.previousBlobKey);
    try {
      const extracting = await this.service.patchItem(projectId, itemId, item => {
        // A refresh keeps the old snapshot readable while the new one is
        // fetched (spec 3 §4): the status stays, `refreshingAt` marks the run.
        if (refresh) item.refreshingAt = new Date().toISOString();
        else item.status = 'extracting';
        item.error = null;
      });
      if (!extracting) return null; // The item was removed while queued.

      // 1. Bytes: from the temp file, the picker's fetch, or handed in.
      let text = null;
      if (typeof input.text === 'string') {
        text = input.text;
        contentType = contentType || 'text/markdown';
      } else if (typeof input.fetch === 'function') {
        const fetched = await input.fetch();
        bytes = Buffer.isBuffer(fetched.bytes) ? fetched.bytes : Buffer.from(fetched.bytes || '');
        name = fetched.name || name;
        contentType = fetched.contentType || contentType;
        job.lastModified = fetched.lastModified || null;
        job.source = fetched.source || null;
        const previousVersion = input.previousLastModified || input.previousSnapshotAt;
        if (
          previousVersion &&
          job.lastModified &&
          Date.parse(job.lastModified) <= Date.parse(previousVersion)
        ) {
          // Nothing changed at the source: keep the text, clear `stale`.
          const unchanged = await this.service.patchItem(projectId, itemId, item => {
            item.status = item.text ? 'ready' : 'failed';
            item.error = null;
            delete item.refreshingAt;
          });
          return unchanged ? { item: unchanged, unchanged: true } : null;
        }
      } else if (Buffer.isBuffer(input.bytes)) {
        bytes = input.bytes;
      } else if (input.path) {
        bytes = await fs.readFile(input.path);
      } else {
        throw new ProjectError('INVALID_REF', 'Nothing to ingest');
      }

      // 2. The real size against the quota (the receive-side check used the
      //    declared length; a fetched document had none).
      const size = bytes ? bytes.length : Buffer.byteLength(text, 'utf8');
      const project = await this.repository.get(projectId);
      if (!project) return null;
      const others = (project.items || []).filter(entry => entry.id !== itemId);
      this.service._checkItemQuota(
        { ...project, items: others, usage: usageOf(others) },
        { bytes: size }
      );

      // 3. Scan, on the temp file (the command scanner needs a path).
      if (bytes) {
        let scanPath = input.path || null;
        let scratch = null;
        if (!scanPath && this.scanner().id !== 'none') {
          scratch = await this.newTempDir();
          scanPath = path.join(scratch, 'fetched');
          await fs.writeFile(scanPath, bytes, { mode: 0o600 });
        }
        try {
          await this._scan({ path: scanPath, bytes, contentType, name });
        } finally {
          await removeQuietly(scratch);
        }
      }

      // 4. Extract.
      let extracted;
      if (text !== null) {
        const normalized = normalizeText(text, { maxChars: MAX_TEXT_CHARS });
        extracted = { text: normalized.text, contentType, truncated: normalized.truncated };
        if (!extracted.text) throw new ExtractionError('NO_TEXT', 'The text is empty');
      } else {
        const started = Date.now();
        extracted = await extractText({ bytes, contentType, name });
        logger.debug('Extracted a project item', {
          ...where,
          contentType: extracted.contentType,
          chars: extracted.text.length,
          ms: Date.now() - started
        });
      }

      // 5. Encrypt and store; then the item, under the lock.
      const block = await storeText({
        projectId,
        itemId,
        text: extracted.text,
        original: { contentType: extracted.contentType, bytes: size, pages: extracted.pages },
        truncated: extracted.truncated,
        platform: this._platform(),
        repository: this.repository
      });
      storedBlobKey = block.blobKey;
      const now = new Date().toISOString();
      const stored = await this.service.patchItem(projectId, itemId, item => {
        item.status = 'ready';
        item.error = null;
        delete item.refreshingAt;
        item.text = block;
        if (input.purpose === 'pick' || input.purpose === 'refresh' || job.lastModified) {
          item.snapshotAt = block.extractedAt;
        }
        if (job.source) {
          item.provenance = {
            ...(item.provenance || {}),
            source: { ...(item.provenance?.source || {}), ...job.source }
          };
        }
        if (
          extracted.contentType &&
          item.ref &&
          typeof item.ref === 'object' &&
          item.kind === 'upload'
        ) {
          item.ref = { ...item.ref, contentType: extracted.contentType, bytes: size };
        }
        item.updatedAt = now;
      });
      if (!stored) {
        // Removed while extracting: the blob has no item, drop it.
        await this.repository.blobs
          .delete(PROJECT_FILES_NAMESPACE, block.blobKey)
          .catch(() => false);
        return null;
      }
      if (input.previousBlobKey && input.previousBlobKey !== block.blobKey) {
        await this.repository.blobs
          .delete(PROJECT_FILES_NAMESPACE, input.previousBlobKey)
          .catch(() => false);
        evictItemKeys(input.previousBlobKey);
      }
      recordUpload('project', 'ready', size);
      this.onReady(projectId, stored, { previousBlobKey: input.previousBlobKey || null });
      return { item: stored };
    } catch (error) {
      const failure = errorOf(error);
      logger.warn('A project item could not be ingested', { ...where, ...failure });
      recordUpload('project', outcomeOf(failure.code), bytes ? bytes.length : undefined);
      if (storedBlobKey) {
        await this.repository.blobs
          .delete(PROJECT_FILES_NAMESPACE, storedBlobKey)
          .catch(() => false);
      }
      await this.service
        .patchItem(projectId, itemId, item => {
          // A refresh that fails keeps the old text readable (spec 3 §4).
          item.status = input.previousBlobKey && item.text ? 'stale' : 'failed';
          item.error = { code: failure.code, message: failure.message.slice(0, 2000) };
          delete item.refreshingAt;
        })
        .catch(patchError =>
          logger.error('Could not record an ingest failure', {
            ...where,
            error: patchError.message
          })
        );
      return { item: null, error: failure };
    } finally {
      this.active.delete(itemId);
      // An upload's private directory goes; an import under `contents/` stays.
      if (input.cleanupDir) await removeQuietly(input.cleanupDir);
    }
  }

  async _scan(file) {
    const scanner = this.scanner();
    if (scanner.id === 'none') return;
    const result = await scanner.scan(file);
    if (result.verdict === 'clean') return;
    if (result.verdict === 'infected') {
      throw new ProjectError(
        'SCAN_REJECTED',
        `Rejected by the malware scanner: ${result.detail || 'infected'}`
      );
    }
    const { onError } = this.settings().scan;
    if (onError === 'allow') {
      logger.warn('Malware scan errored; the file is let through (projects.scan.onError: allow)', {
        component: COMPONENT,
        name: file.name,
        detail: result.detail
      });
      return;
    }
    throw new ProjectError(
      'SCAN_REJECTED',
      `The malware scanner could not scan the file: ${result.detail || 'scanner error'}`
    );
  }

  // --- the reconciler (spec 3 §8) ---------------------------------------------

  /**
   * Settle what a crash left behind: items `pending` or `extracting` for
   * longer than `projects.ingest.staleAfterMinutes` become `failed` with
   * `INTERRUPTED`; blobs no item names and older than an hour are deleted.
   *
   * @param {{now?: number}} [options]
   * @returns {Promise<{scanned: number, interrupted: number, orphans: number}>}
   */
  async reconcile({ now = Date.now() } = {}) {
    const staleMs = this.settings().ingest.staleAfterMinutes * 60 * 1000;
    const projects = [];
    try {
      projects.push(...(await this.repository.listAdmin({ includeDisabled: true })));
    } catch (error) {
      logger.warn('Could not list admin projects for reconciliation', {
        component: COMPONENT,
        error: error.message
      });
    }
    let complete = true;
    if (this.repository.isAvailable()) {
      const { projects: users, truncated } = await this.repository.scanUser({
        max: 10000,
        maxScanned: 10000
      });
      projects.push(...users);
      complete = !truncated;
    }
    let interrupted = 0;
    let orphans = 0;
    for (const project of projects) {
      const stuck = (project.items || []).filter(item => {
        const refreshing = typeof item.refreshingAt === 'string';
        if (!refreshing && item.status !== 'pending' && item.status !== 'extracting') return false;
        if (this.isActive(item.id)) return false;
        const since = refreshing
          ? Date.parse(item.refreshingAt) || 0
          : Date.parse(item.updatedAt || item.createdAt || '') || 0;
        return now - since > staleMs;
      });
      for (const item of stuck) {
        try {
          await this.service.patchItem(project.id, item.id, entry => {
            if (typeof entry.refreshingAt === 'string') {
              // An interrupted refresh: the old snapshot is still there.
              delete entry.refreshingAt;
              entry.status = entry.text ? 'stale' : 'failed';
              entry.error = {
                code: INTERRUPTED,
                message: 'The server restarted during the refresh. Refresh the document again.'
              };
              return;
            }
            if (entry.status !== 'pending' && entry.status !== 'extracting') return;
            entry.status = 'failed';
            entry.error = {
              code: INTERRUPTED,
              message: 'The server restarted during extraction. Upload the file again.'
            };
          });
          interrupted += 1;
        } catch (error) {
          logger.warn('Could not mark an interrupted item', {
            component: COMPONENT,
            projectId: project.id,
            itemId: item.id,
            error: error.message
          });
        }
      }
    }
    orphans += await this._sweepOrphans(projects, now, { complete });
    if (interrupted || orphans) {
      logger.info('Project ingest reconciled', {
        component: COMPONENT,
        scanned: projects.length,
        interrupted,
        orphans
      });
    }
    return { scanned: projects.length, interrupted, orphans };
  }

  /**
   * Delete blobs no item names, across the whole namespace: a blob left by
   * a crash between `blobs.put` and the document write, and a blob of a
   * project that no longer exists (an interrupted delete cascade) alike.
   * Only when every project could be scanned, so a blob of an unscanned
   * project is never mistaken for an orphan.
   */
  async _sweepOrphans(projects, now, { complete = true } = {}) {
    if (!this.repository.hasBlobs() || !complete) return 0;
    const named = new Set();
    for (const project of projects) {
      for (const item of project.items || []) if (item.text?.blobKey) named.add(item.text.blobKey);
    }
    let removed = 0;
    let cursor = null;
    try {
      do {
        const page = await this.repository.blobs.list(PROJECT_FILES_NAMESPACE, {
          limit: 200,
          ...(cursor ? { cursor } : {})
        });
        for (const blob of page.items) {
          if (named.has(blob.key)) continue;
          const itemId = blob.key.split('__')[1];
          if (this.isActive(itemId)) continue;
          if (now - versionTimeOf(blob.key) < ORPHAN_AGE_MS) continue;
          if (await this.repository.blobs.delete(PROJECT_FILES_NAMESPACE, blob.key)) removed += 1;
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) {
      logger.warn('Orphan blob sweep failed', { component: COMPONENT, error: error.message });
    }
    return removed;
  }

  /**
   * Remove upload directories older than an hour (startup).
   *
   * @param {{now?: number}} [options]
   * @returns {Promise<number>}
   */
  async cleanTempDir({ now = Date.now() } = {}) {
    let removed = 0;
    let entries;
    try {
      entries = await fs.readdir(this.tempDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.tempDir, entry.name);
      try {
        const stat = await fs.stat(dir);
        if (now - stat.mtimeMs < ORPHAN_AGE_MS) continue;
        await fs.rm(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Raced with a job, or already gone.
      }
    }
    return removed;
  }
}

let reconcileTimer = null;

/**
 * Run the reconciler now and every fifteen minutes.
 *
 * @param {ProjectIngestService} ingest
 * @param {{intervalMs?: number}} [options]
 */
export function startIngestReconciler(ingest, { intervalMs = 15 * 60 * 1000 } = {}) {
  if (reconcileTimer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await ingest.reconcile();
    } catch (error) {
      logger.error('Project ingest reconciliation failed', {
        component: COMPONENT,
        error: error.message
      });
    } finally {
      running = false;
    }
  };
  reconcileTimer = setInterval(tick, intervalMs);
  reconcileTimer.unref?.();
  setTimeout(tick, 3000).unref?.();
}

/** Stop the reconciler (shutdown and tests). */
export function stopIngestReconciler() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}

export default ProjectIngestService;
