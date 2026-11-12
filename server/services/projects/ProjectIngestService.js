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
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../utils/logger.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import { recordUpload } from '../../telemetry/metrics.js';
import { OAuthRefreshError } from '../integrations/oauthRefreshError.js';
import { isIntegrationAuthRequired } from '../integrations/auth/integrationAuthRequired.js';
import { KnowledgeError } from '../knowledge/types.js';
import { PROJECT_FILES_NAMESPACE, getProjectRepository, usageOf } from './ProjectRepository.js';
import { ProjectError } from './projectErrors.js';
import { projectSettings } from './projectSettings.js';
import {
  ExtractionError,
  MAX_IMPORT_TEXT_CHARS,
  MAX_TEXT_CHARS,
  extractText,
  normalizeText
} from './extractText.js';
import { storeText, evictItemKeys } from './ItemTextStore.js';
import { applyItemInfo, infoFromText } from './itemInfo.js';
import { scannerFor } from './scan/MalwareScanner.js';
import { isRefreshDue, refreshesOnSchedule } from './refreshTtl.js';
import { getItemKind } from './kinds/registry.js';

const COMPONENT = 'ProjectIngestService';

/** Where uploads wait for extraction: a private directory per request. */
export const UPLOAD_TEMP_DIR = ['data', 'tmp', 'project-uploads'];

/** Temp directories and orphan blobs older than this are swept. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * How long a fetched document (a pick or a refresh) may take, metadata and
 * body together. Well below `staleAfterMinutes`, so a stalled source fails
 * its own job and frees its queue slot before any reconciler steps in.
 */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

/** User projects read per page of the reconciler's inventory. */
const INVENTORY_PAGE_SIZE = 10000;

/**
 * Most expired files one reconciler tick queues for a refresh; the rest wait
 * for the next tick. The queue's `ingest.concurrency` bounds how many run.
 */
export const MAX_SCHEDULED_REFRESHES = 50;

/**
 * Most first fetches one reconciler tick queues (#3622): web pages converted
 * from links, or created with an admin project. More than refreshes, since an
 * item without its first snapshot is not usable at all; the queue's
 * background slot still runs them one after the other.
 */
export const MAX_FIRST_FETCHES = 200;

/**
 * A web page stored as a live link before #3622 (`storage: 'link'`): the
 * reconciler converts it to a snapshot waiting for its first fetch.
 *
 * @param {Object} item
 * @returns {boolean}
 */
export function isLinkedWebPage(item) {
  return item?.kind === 'url' && item.storage === 'link';
}

/**
 * Turn a web page link into a snapshot waiting for its first fetch, in place:
 * what the item is, its name, its settings (pinned, refresh TTL) stay.
 *
 * @param {Object} item
 */
export function convertLinkedWebPage(item) {
  item.storage = 'text';
  item.status = 'pending';
  item.error = null;
  item.snapshotAt = null;
  delete item.cache;
  delete item.checkedAt;
  delete item.refreshingAt;
  delete item.ingestAttempt;
}

/**
 * Whether an item waits for its first fetch with no job reserved for it: a
 * kind that fetches with nobody's credentials (a web page, a file from a
 * website), `pending`, without an `ingestAttempt`. A converted link and a page
 * created with an admin project are; an item a request added has its attempt
 * from the start.
 *
 * @param {Object} item
 * @returns {boolean}
 */
export function isWaitingForFetch(item) {
  return (
    item?.status === 'pending' &&
    !item.ingestAttempt &&
    !item.refreshingAt &&
    item.storage === 'text' &&
    refreshesOnSchedule(getItemKind(item.kind))
  );
}

/**
 * The ingest input of an item's first fetch by its kind (a picked document, a
 * file or a page from a website): the kind's `fetch` with nobody's or the
 * picker's credentials, fenced by the item's `ingestAttempt`.
 *
 * @param {Object} kind
 * @param {Object} item - As stored, with its `ingestAttempt`.
 * @param {{user?: Object|null, prefetched?: Object|null, nameFromTitle?: boolean,
 *   scheduled?: boolean}} [options] - `prefetched`: the response the kind's
 *   `prepare` already read (a web page), handed to its `fetch` instead of a new
 *   request; `nameFromTitle`: the item takes the extracted title as its name
 *   while it still has the one it was given; `scheduled`: a background job
 *   nobody waits for (the reconciler).
 * @returns {Object}
 */
export function fetchInput(
  kind,
  item,
  { user = null, prefetched = null, nameFromTitle = false, scheduled = false } = {}
) {
  return {
    fetch: ({ signal } = {}) =>
      kind.fetch(item, { user, purpose: 'pick', signal, ...(prefetched ? { prefetched } : {}) }),
    contentType: item.ref?.mimeType,
    name: item.name,
    attempt: item.ingestAttempt,
    purpose: 'pick',
    ...(nameFromTitle ? { nameFromTitle: true } : {}),
    ...(scheduled ? { scheduled: true } : {})
  };
}

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
  if (error instanceof OAuthRefreshError || isIntegrationAuthRequired(error)) {
    return { code: 'SOURCE_FORBIDDEN', message: error.message };
  }
  const message = String(error?.message || 'ingest failed');
  if (/\b(404|410)\b|not found|gone|no longer/i.test(message)) {
    return { code: 'SOURCE_GONE', message };
  }
  if (/\b(401|403)\b|forbidden|denied|reconnect|unauthori[sz]ed|not authenticated/i.test(message)) {
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

/** The project without one item, as the quota of that item is judged against. */
function withoutItem(project, itemId) {
  const others = (project.items || []).filter(entry => entry.id !== itemId);
  return { ...project, items: others, usage: usageOf(others) };
}

async function removeQuietly(target) {
  if (!target) return;
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // Already gone, or never created.
  }
}

/** A version id as `ItemTextStore.mintVersionId` mints it: base36 time, random hex. */
const VERSION_ID = /^([0-9a-z]{9})[0-9a-f]{8}$/;

/**
 * A blob key `<projectId>__<itemId>__<versionId>`, parsed from the right:
 * project and item ids may hold `__` themselves (an admin project id, the
 * base64url of a minted id), the version id never does.
 *
 * @param {string} blobKey
 * @returns {{scope: string, mintedAt: number}|null} `scope` is the key
 *   without its version (`<projectId>__<itemId>`); null when the key is not
 *   one this pipeline wrote
 */
function parseBlobKey(blobKey) {
  const key = String(blobKey || '');
  const at = key.lastIndexOf('__');
  if (at <= 0) return null;
  const match = VERSION_ID.exec(key.slice(at + 2));
  const scope = key.slice(0, at);
  if (!match || !scope.includes('__')) return null;
  const mintedAt = parseInt(match[1], 36);
  return Number.isFinite(mintedAt) ? { scope, mintedAt } : null;
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
   * @param {number} [options.fetchTimeoutMs] - Deadline of a fetch (tests).
   */
  constructor({ service, repository, platform, scanner, tempDir, onReady, fetchTimeoutMs } = {}) {
    // Both may be functions: the process-wide service and repository are
    // rebuilt when the storage provider changes (tests), so a long-lived
    // pipeline resolves them per job.
    this._service = service;
    this._repository = repository || null;
    this._platform = platform || (() => ({}));
    this._scanner = scanner || null;
    this.tempDir = tempDir || uploadTempDir();
    this.onReady = onReady || (() => {});
    this.fetchTimeoutMs = fetchTimeoutMs || FETCH_TIMEOUT_MS;
    this.queue = [];
    /** The jobs running on this worker; two may share an item (a released refresh and its successor). */
    this.active = new Set();
    this.running = 0;
    /** Background jobs (scheduled refreshes) running now. */
    this.runningBackground = 0;
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
   *   on a refresh; `provenance` to merge into the item's once installed (an
   *   edit); `purpose` (`upload`, `pick`, `refresh`, `write`, `import`).
   * @param {{user?: Object, authorize?: Function, wait?: boolean}} [options] - `wait`:
   *   `true` waits for the job, `false` never does, omitted waits for `{text}` only.
   * @returns {Promise<{item: Object}|null>} The finished item when the job ran
   *   inline, otherwise null (the caller polls).
   */
  async start(project, item, input, { user, wait } = {}) {
    const job = {
      projectId: project.id,
      itemId: item.id,
      input,
      user,
      // A scheduled refresh waits behind every job someone is waiting for.
      background: input.scheduled === true,
      startedAt: Date.now()
    };
    // Every job goes through the queue, so `ingest.concurrency` bounds the
    // downloads, scans and extractions of this worker whatever the route;
    // `inline` only decides whether the caller waits for the result.
    // An explicit `wait: false` wins even for text handed in.
    const inline = wait === true || (wait !== false && typeof input.text === 'string');
    const promise = this._enqueue(job);
    if (!inline) return null;
    return promise;
  }

  _enqueue(job) {
    return new Promise(resolve => {
      this.queue.push({ job, resolve });
      this._pump();
    });
  }

  /**
   * Start queued jobs while slots are free. Jobs someone is waiting for (an
   * upload, a pick, a refresh by hand) go first, in order; background jobs
   * (scheduled refreshes) only when none of those waits, and with more than
   * one slot never in the last one, so an upload always finds a slot within
   * one job's time however many files a tick queued.
   */
  _pump() {
    const limit = this.settings().ingest.concurrency;
    const backgroundLimit = Math.max(1, limit - 1);
    while (this.running < limit && this.queue.length) {
      let index = this.queue.findIndex(entry => !entry.job.background);
      if (index < 0) {
        if (this.runningBackground >= backgroundLimit) return;
        index = 0;
      }
      const [{ job, resolve }] = this.queue.splice(index, 1);
      this.running += 1;
      if (job.background) this.runningBackground += 1;
      void this._run(job)
        .catch(() => null)
        .then(result => {
          this.running -= 1;
          if (job.background) this.runningBackground -= 1;
          resolve(result);
          this._pump();
        });
    }
  }

  /** The items with a job queued or running on this worker. */
  _busyItemIds() {
    return [...this.active, ...this.queue.map(entry => entry.job)].map(job => job.itemId);
  }

  /** Whether a job for this item is queued or running on this worker. */
  isActive(itemId) {
    return this._busyItemIds().includes(itemId);
  }

  async _run(job) {
    this.active.add(job);
    const { projectId, itemId, input } = job;
    const where = { component: COMPONENT, projectId, itemId };
    let bytes = null;
    let name = input.name;
    let contentType = input.contentType;
    let storedBlobKey = null;
    const refresh = input.purpose === 'refresh' && Boolean(input.previousBlobKey);
    // A job owns its item only while the item still carries the attempt the
    // service reserved with the item (`addItem`) or the refresh
    // (`refreshItem`): the reconciler of any worker may release a job that
    // ran too long, and a new refresh mints a new attempt. A job that lost
    // its attempt writes nothing, so an older snapshot can never overwrite a
    // newer one, nor a late failure a newer state.
    const fenced = typeof input.attempt === 'string';
    // A scheduled refresh is nobody using the project: it must not count as
    // activity, or retention would never find the project abandoned.
    const patch = (update, options = {}) =>
      this.service.patchItem(projectId, itemId, update, {
        ...options,
        ...(input.scheduled ? { touchActivity: false, touchUpdated: false } : {})
      });
    let lost = false;
    const owns = item => {
      if (!fenced || item.ingestAttempt === input.attempt) return true;
      lost = true;
      return false;
    };
    const assertOwned = () => {
      if (lost) {
        throw new ProjectError(
          'PROJECT_MISMATCH',
          'The job was released or taken over by a newer one; its result is discarded'
        );
      }
    };
    try {
      const extracting = await patch(item => {
        if (!owns(item)) return false;
        // A refresh keeps the old snapshot readable while the new one is
        // fetched (spec 3 §4): the status stays, `refreshingAt` marks the run.
        // `refreshItem` reserved it before queueing; that reservation is kept,
        // not restamped, so the reconciler counts from the request (as it
        // counts a queued upload from its `updatedAt`).
        if (refresh) item.refreshingAt = item.refreshingAt || new Date().toISOString();
        else item.status = 'extracting';
        item.error = null;
      });
      if (!extracting) return null; // The item was removed while queued.
      assertOwned();

      // 1. Bytes: from the temp file, the picker's fetch, or handed in.
      let text = null;
      if (typeof input.text === 'string') {
        text = input.text;
        contentType = contentType || 'text/markdown';
      } else if (typeof input.fetch === 'function') {
        const fetched = await this._fetchWithDeadline(input.fetch);
        job.lastModified = fetched.lastModified || null;
        job.source = fetched.source || null;
        const previousVersion = input.previousLastModified || input.previousSnapshotAt;
        // Nothing changed at the source: it said so to a conditional request
        // (304), it names the version the text was taken from (ETag), or it
        // was last modified before that.
        // An ETag on both sides decides alone: a server evaluates
        // If-None-Match first, and a changed ETag with an unchanged
        // Last-Modified (an edit within the second, a kept mtime) is a change.
        const bothTagged = Boolean(input.previousEtag) && Boolean(fetched.etag);
        // The same bytes are the same document, whatever the source says
        // about its version (a page that names none, #3622).
        const sameBytes =
          Boolean(input.previousSha256) && fetched.source?.sha256 === input.previousSha256;
        const sameVersion =
          refresh &&
          (fetched.notModified === true ||
            sameBytes ||
            (bothTagged
              ? fetched.etag === input.previousEtag
              : Boolean(previousVersion) &&
                Boolean(job.lastModified) &&
                Date.parse(job.lastModified) <= Date.parse(previousVersion)));
        if (sameVersion) {
          // Keep the text, clear `stale`, note the check.
          const checkedAt = new Date().toISOString();
          const unchanged = await patch(item => {
            if (!owns(item)) return false;
            item.status = item.text ? 'ready' : 'failed';
            item.error = null;
            item.checkedAt = checkedAt;
            if (job.source) {
              item.provenance = {
                ...(item.provenance || {}),
                source: { ...(item.provenance?.source || {}), ...job.source }
              };
            }
            delete item.refreshingAt;
            delete item.ingestAttempt;
          });
          assertOwned();
          return unchanged ? { item: unchanged, unchanged: true } : null;
        }
        if (fetched.notModified === true) {
          // A 304 to an unconditional request, or with no text to keep.
          throw new ProjectError('SOURCE_GONE', 'The source sent no document');
        }
        bytes = Buffer.isBuffer(fetched.bytes) ? fetched.bytes : Buffer.from(fetched.bytes || '');
        name = fetched.name || name;
        contentType = fetched.contentType || contentType;
      } else if (Buffer.isBuffer(input.bytes)) {
        bytes = input.bytes;
      } else if (input.path) {
        bytes = await fs.readFile(input.path);
      } else {
        throw new ProjectError('INVALID_REF', 'Nothing to ingest');
      }

      // 2. The real size against the quota (the receive-side check used the
      //    declared length; a fetched document had none). An early refusal
      //    before the scan and the extraction; the binding check runs again
      //    under the project's lock when the text is installed (step 5).
      const size = bytes ? bytes.length : Buffer.byteLength(text, 'utf8');
      const project = await this.repository.get(projectId);
      if (!project) return null;
      this.service._checkItemQuota(withoutItem(project, itemId), { bytes: size });

      // 3. Scan, on the temp file (the command scanner needs a path). Text
      //    handed in is scanned as the bytes it will be stored as.
      {
        const scanBytes = bytes || Buffer.from(text, 'utf8');
        let scanPath = bytes ? input.path || null : null;
        let scratch = null;
        if (!scanPath && this.scanner().id !== 'none') {
          scratch = await this.newTempDir();
          job.scratchDir = scratch;
          scanPath = path.join(scratch, 'fetched');
          await fs.writeFile(scanPath, scanBytes, { mode: 0o600 });
        }
        try {
          await this._scan({ path: scanPath, bytes: scanBytes, contentType, name });
        } finally {
          await removeQuietly(scratch);
        }
      }

      // 4. Extract.
      const maxChars = input.purpose === 'import' ? MAX_IMPORT_TEXT_CHARS : MAX_TEXT_CHARS;
      let extracted = null;
      if (text !== null) {
        const normalized = normalizeText(text, { maxChars });
        extracted = {
          text: normalized.text,
          contentType,
          truncated: normalized.truncated,
          ...infoFromText(normalized.text)
        };
        if (!extracted.text) throw new ExtractionError('NO_TEXT', 'The text is empty');
      } else {
        const started = Date.now();
        extracted = await extractText({ bytes, contentType, name }, { maxChars });
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
      // Under the project's lock, against what the project holds right now:
      // two uploads cannot both pass on the same free room.
      const quota = current =>
        this.service._checkItemQuota(withoutItem(current, itemId), { bytes: size });
      const stored = await patch(
        item => {
          if (!owns(item)) return false;
          item.status = 'ready';
          item.error = null;
          delete item.refreshingAt;
          delete item.ingestAttempt;
          item.text = block;
          // What the document is about, read from this text: a new version
          // replaces what the old one said.
          applyItemInfo(item, { title: extracted.title, description: extracted.description });
          // A web page added without a name is named by its title, unless
          // someone renamed it while it was fetched.
          if (input.nameFromTitle && item.title && item.name === input.name) {
            item.name = String(item.title).slice(0, 300);
          }
          if (input.purpose === 'pick' || input.purpose === 'refresh' || job.lastModified) {
            item.snapshotAt = block.extractedAt;
            item.checkedAt = block.extractedAt;
          }
          if (job.source) {
            item.provenance = {
              ...(item.provenance || {}),
              source: { ...(item.provenance?.source || {}), ...job.source }
            };
          }
          if (input.provenance) {
            // An edit: the text is the caller's now, whatever it was before.
            item.provenance = { ...(item.provenance || {}), ...input.provenance };
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
        },
        { check: quota }
      );
      assertOwned(); // The stored blob is dropped on the way out.
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
      await patch(item => {
        if (!owns(item)) return false;
        // A refresh that fails keeps the old text readable (spec 3 §4).
        item.status = input.previousBlobKey && item.text ? 'stale' : 'failed';
        item.error = { code: failure.code, message: failure.message.slice(0, 2000) };
        // A fetched document was checked, if in vain: a scheduled refresh
        // tries again after its TTL, not on the next tick.
        if (typeof input.fetch === 'function') item.checkedAt = new Date().toISOString();
        delete item.refreshingAt;
        delete item.ingestAttempt;
      }).catch(patchError =>
        logger.error('Could not record an ingest failure', {
          ...where,
          error: patchError.message
        })
      );
      return { item: null, error: failure };
    } finally {
      this.active.delete(job);
      // An upload's private directory goes; an import under `contents/` stays.
      if (input.cleanupDir) await removeQuietly(input.cleanupDir);
    }
  }

  /**
   * Run a kind's fetch with a deadline: its `signal` aborts the requests
   * (headers and body), and the job fails at the deadline even when a fetch
   * ignores the signal, so a stalled source never holds a queue slot.
   *
   * @param {(options: {signal: AbortSignal}) => Promise<Object>} fetch
   * @returns {Promise<Object>}
   * @throws {ProjectError} `SOURCE_TIMEOUT`
   */
  async _fetchWithDeadline(fetch) {
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ProjectError(
          'SOURCE_TIMEOUT',
          `The source did not deliver the document within ${Math.round(this.fetchTimeoutMs / 1000)} seconds`
        );
        controller.abort(error);
        reject(error);
      }, this.fetchTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => fetch({ signal: controller.signal })),
        deadline
      ]);
    } finally {
      clearTimeout(timer);
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
   * @param {{now?: number, pageSize?: number}} [options] - `pageSize`: user
   *   projects read per inventory page (tests).
   * @returns {Promise<{scanned: number, interrupted: number, orphans: number}>}
   */
  async reconcile({ now = Date.now(), pageSize = INVENTORY_PAGE_SIZE } = {}) {
    const staleMs = this.settings().ingest.staleAfterMinutes * 60 * 1000;
    const projects = [];
    let complete = true;
    try {
      // Strict: a project file that cannot be read makes the inventory
      // incomplete, and an incomplete inventory sweeps no blob.
      projects.push(...(await this.repository.listAdmin({ includeDisabled: true, strict: true })));
    } catch (error) {
      complete = false;
      logger.warn('Could not list every admin project; orphan blobs are kept this time', {
        component: COMPONENT,
        error: error.message
      });
    }
    if (this.repository.isAvailable()) {
      // Page by page to the end, so every project is settled and the
      // inventory can be complete however many there are.
      let cursor = null;
      let skipped = 0;
      do {
        const page = await this.repository.scanUser({
          max: pageSize,
          maxScanned: pageSize,
          cursor
        });
        projects.push(...page.projects);
        skipped += page.skipped || 0;
        const next = page.truncated ? page.nextCursor : null;
        if (page.truncated && (!next || next === cursor)) {
          // A page that ends without a way on: the rest is unknown.
          complete = false;
          break;
        }
        cursor = next;
      } while (cursor);
      // A project document that could not be read still names blobs.
      if (skipped > 0) {
        complete = false;
        logger.warn('Some user projects could not be read; orphan blobs are kept this time', {
          component: COMPONENT,
          skipped
        });
      }
    }
    let interrupted = 0;
    let orphans = 0;
    for (const project of projects) {
      const stuck = (project.items || []).filter(item => {
        // Waiting for its first fetch is not stuck: `fetchWaiting` queues it.
        if (isWaitingForFetch(item)) return false;
        const refreshing = typeof item.refreshingAt === 'string';
        if (!refreshing && item.status !== 'pending' && item.status !== 'extracting') return false;
        if (this.isActive(item.id)) return false;
        const since = refreshing
          ? Date.parse(item.refreshingAt) || 0
          : Date.parse(item.updatedAt || item.createdAt || '') || 0;
        return now - since > staleMs;
      });
      for (const item of stuck) {
        let settled = false;
        try {
          await this.service.patchItem(project.id, item.id, entry => {
            // The decision above was taken on the inventory; under the lock
            // the item must still be the one inventoried. A changed
            // reservation or update means another worker settled it, its job
            // moved on, or a new refresh owns it now: leave it alone.
            if (entry.refreshingAt !== item.refreshingAt || entry.updatedAt !== item.updatedAt) {
              return false;
            }
            if (typeof entry.refreshingAt === 'string') {
              settled = true;
              // An interrupted refresh: the old snapshot is still there. Its
              // attempt goes with it, so a job still running somewhere can
              // no longer install or fail it.
              delete entry.refreshingAt;
              delete entry.ingestAttempt;
              entry.status = entry.text ? 'stale' : 'failed';
              entry.error = {
                code: INTERRUPTED,
                message: 'The server restarted during the refresh. Refresh the document again.'
              };
              return;
            }
            if (entry.status !== 'pending' && entry.status !== 'extracting') return false;
            settled = true;
            // Its attempt goes too: a job still running elsewhere is fenced out.
            delete entry.ingestAttempt;
            entry.status = 'failed';
            entry.error = {
              code: INTERRUPTED,
              message: 'The server restarted during extraction. Upload the file again.'
            };
          });
          if (settled) interrupted += 1;
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
    const refreshed = await this.refreshExpired(projects, { now });
    const fetched = await this.fetchWaiting(projects);
    if (interrupted || orphans || refreshed || fetched) {
      logger.info('Project ingest reconciled', {
        component: COMPONENT,
        scanned: projects.length,
        interrupted,
        orphans,
        refreshed,
        fetched
      });
    }
    return { scanned: projects.length, interrupted, orphans, refreshed, fetched };
  }

  /**
   * Convert web page links to snapshots and queue the first fetch of every
   * item waiting for one (#3622): pages stored as live links before, and
   * pages created with an admin project. Each project is changed under its
   * lock, and an item is reserved there (`ingestAttempt`) for this worker:
   * every worker runs the reconciler, and only the one whose reservation
   * lands fetches the page; the others find it reserved. At most
   * {@link MAX_FIRST_FETCHES} per call; the rest wait for the next tick. A
   * disabled admin project or one being deleted is converted, not fetched.
   *
   * @param {Object[]} projects - As inventoried; each is read again under its lock.
   * @param {{max?: number}} [options]
   * @returns {Promise<number>} Fetches queued.
   */
  async fetchWaiting(projects, { max = MAX_FIRST_FETCHES } = {}) {
    let queued = 0;
    for (const project of projects || []) {
      const fetches = !project.deleting && project.enabled !== false;
      const candidates = (project.items || []).filter(
        item => isLinkedWebPage(item) || (fetches && isWaitingForFetch(item))
      );
      if (!candidates.length) continue;
      const room = fetches ? Math.max(0, max - queued) : 0;
      const reserved = [];
      let stored = null;
      try {
        stored = await this.repository.mutate(
          project.id,
          current => {
            let changed = false;
            const now = new Date().toISOString();
            for (const item of current.items || []) {
              if (isLinkedWebPage(item)) {
                convertLinkedWebPage(item);
                changed = true;
              }
              if (reserved.length >= room || this.isActive(item.id)) continue;
              if (!isWaitingForFetch(item)) continue;
              item.ingestAttempt = randomUUID();
              item.updatedAt = now;
              reserved.push(item.id);
              changed = true;
            }
            return changed ? current : null;
          },
          { touchActivity: false, touchUpdated: false }
        );
      } catch (error) {
        logger.warn('Could not queue the first fetch of project items', {
          component: COMPONENT,
          projectId: project.id,
          error: error?.message
        });
        continue;
      }
      if (!stored) continue;
      for (const itemId of reserved) {
        const item = (stored.items || []).find(entry => entry.id === itemId);
        const kind = getItemKind(item?.kind);
        if (!item || !kind) continue;
        await this.start(
          stored,
          item,
          fetchInput(kind, item, { nameFromTitle: item.name === item.ref?.url, scheduled: true }),
          { wait: false }
        );
        queued += 1;
      }
    }
    return queued;
  }

  /**
   * Queue a refresh of every file from a website whose snapshot is older
   * than its refresh TTL (#3536), through `ProjectService.refreshItem`: the
   * same reservation, the same conditional download, the same queue (so
   * `ingest.concurrency` bounds it). At most {@link MAX_SCHEDULED_REFRESHES}
   * per call. Items of a disabled admin project, a project being deleted, or
   * an item set to `never` are left alone; an item another worker reserved
   * meanwhile is skipped (`PROJECT_MISMATCH`).
   *
   * @param {Object[]} projects
   * @param {{now?: number, max?: number}} [options]
   * @returns {Promise<number>} Refreshes queued.
   */
  async refreshExpired(projects, { now = Date.now(), max = MAX_SCHEDULED_REFRESHES } = {}) {
    const settings = this.settings();
    let queued = 0;
    for (const project of projects || []) {
      if (queued >= max) break;
      if (project.deleting || project.enabled === false) continue;
      for (const item of project.items || []) {
        if (queued >= max) break;
        if (this.isActive(item.id) || !isRefreshDue(item, project, settings, now)) continue;
        try {
          await this.service.refreshItem(project.id, item.id, { scheduled: true, wait: false });
          queued += 1;
        } catch (error) {
          if (error?.code === 'PROJECT_MISMATCH' || error?.code === 'ITEM_NOT_FOUND') continue;
          logger.warn('Could not schedule the refresh of a project item', {
            component: COMPONENT,
            projectId: project.id,
            itemId: item.id,
            error: error?.message
          });
        }
      }
    }
    return queued;
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
        const busy = this._busyItemIds();
        for (const blob of page.items) {
          if (named.has(blob.key)) continue;
          // A key that does not parse is kept: its age and owner are unknown.
          const parsed = parseBlobKey(blob.key);
          if (!parsed) continue;
          if (busy.some(itemId => parsed.scope.endsWith(`__${itemId}`))) continue;
          if (now - parsed.mintedAt < ORPHAN_AGE_MS) continue;
          if (await this.repository.blobs.delete(PROJECT_FILES_NAMESPACE, blob.key)) removed += 1;
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) {
      logger.warn('Orphan blob sweep failed', { component: COMPONENT, error: error.message });
    }
    return removed;
  }

  /** The temp directories the jobs queued or running on this worker still need. */
  _busyTempDirs() {
    const busy = new Set();
    const jobs = [...this.active, ...this.queue.map(entry => entry.job)];
    for (const job of jobs) {
      const { input = {} } = job;
      if (input.cleanupDir) busy.add(path.resolve(input.cleanupDir));
      if (input.path) busy.add(path.resolve(path.dirname(input.path)));
      if (job.scratchDir) busy.add(path.resolve(job.scratchDir));
    }
    return busy;
  }

  /**
   * Remove upload directories older than an hour (startup and every
   * reconciler tick). A directory a job of this worker has queued or is
   * processing is kept whatever its age; one still being received, or one
   * of another worker sharing the directory, is younger than the hour (its
   * modification time is the moment the file landed in it).
   *
   * @param {{now?: number}} [options]
   * @returns {Promise<number>}
   */
  async cleanTempDir({ now = Date.now() } = {}) {
    let removed = 0;
    let entries = [];
    try {
      entries = await fs.readdir(this.tempDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    const busy = this._busyTempDirs();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.tempDir, entry.name);
      if (busy.has(path.resolve(dir))) continue;
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
 * Run the reconciler, and the sweep of abandoned upload directories, now and
 * every fifteen minutes.
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
    }
    try {
      // A worker that crashed mid-upload and restarted within the hour kept
      // its plaintext original past the startup sweep; this one catches it.
      const removed = await ingest.cleanTempDir();
      if (removed) {
        logger.info('Removed abandoned project upload directories', {
          component: COMPONENT,
          removed
        });
      }
    } catch (error) {
      logger.warn('Could not sweep the project upload directory', {
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
