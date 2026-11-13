// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Worker } from 'node:worker_threads';
import configCache from '../../configCache.js';
import { renderScannedPdfPagesInProcess } from '../documents/pdf/scannedPages.js';
import { projectSettings } from './projectSettings.js';

/**
 * A small pool of worker threads that read uploaded files off the event loop
 * (#3649).
 *
 * Reading a file is CPU work — SheetJS, mammoth, pdfium — that used to
 * run on the server's event loop, so every other request, chat streams
 * included, waited for it. The pool follows the document renderer
 * (`documents/renderService.js`): a worker thread, a time budget and a memory
 * cap, and the thread is terminated when the budget runs out. Unlike the
 * renderer the threads are reused, because a thread's start costs more than a
 * small file's extraction (it loads mammoth and pdf.js on first use).
 *
 * One job runs on one thread at a time; the rest wait in a queue, and the time
 * budget starts when the job does. A thread that times out, crashes or runs
 * out of memory is replaced by the next job. Settings are `projects.extraction`
 * in platform.json (`threads`, `timeoutMs`, `memoryMb`); `threads: 0` turns the
 * pool off and callers read on the event loop, as before.
 *
 * @module services/projects/extractionPool
 */

const WORKER_URL = new URL('./extractionWorker.js', import.meta.url);

/** Why a job did not get an answer from its thread. */
export class ExtractionPoolError extends Error {
  /** @param {'timeout'|'crashed'|'memory'|'shutdown'} code */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExtractionPoolError';
    this.code = code;
    Object.assign(this, details);
  }
}

const slots = new Set();
const queue = [];
let closed = false;
let override = null;

/** The effective `projects.extraction` settings. */
export function extractionSettings() {
  if (override) return override;
  return projectSettings(configCache.getPlatform?.() || {}).extraction;
}

/** Whether files are read in threads (`projects.extraction.threads` > 0). */
export function extractionThreadsEnabled() {
  return extractionSettings().threads > 0;
}

/**
 * Refuse new extraction and rendering work once shutdown has started, before
 * a caller can take the in-process path, which has no time budget.
 *
 * @throws {ExtractionPoolError} `shutdown`
 */
export function assertAcceptingJobs() {
  if (closed) {
    throw new ExtractionPoolError(
      'shutdown',
      'The server is shutting down; try again in a moment.'
    );
  }
}

/**
 * Replace the settings (tests). Pass `null` to read platform.json again.
 *
 * @param {{threads: number, timeoutMs: number, memoryMb: number}|null} settings
 */
export function configureExtractionPool(settings) {
  override = settings;
  closed = false;
}

/** Threads running and jobs waiting, for tests and diagnostics. */
export function extractionPoolStats() {
  return {
    threads: slots.size,
    busy: [...slots].filter(slot => slot.job).length,
    queued: queue.length
  };
}

/**
 * The bytes as an `ArrayBuffer` the thread may own. A buffer that owns its
 * whole `ArrayBuffer` and that the caller gives up (`transfer`) moves without
 * a copy; any other — a slice of Node's shared pool, or bytes the caller still
 * needs, which is every caller that stores the original — is copied once, so
 * the caller's buffer is never detached.
 */
function ownedBytes(bytes, transfer) {
  const buffer = bytes.buffer;
  const whole =
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength;
  if (transfer && whole) return new Uint8Array(buffer, 0, bytes.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * Run one job on a thread.
 *
 * @param {'extract'|'renderPdfPages'} task
 * @param {Object} payload - Plain data for the task, without the file.
 * @param {Object} file
 * @param {Buffer|Uint8Array} file.bytes
 * @param {boolean} [file.transfer=false] - The caller gives the buffer up: it is
 *   moved to the thread, not copied, and is empty afterwards.
 * @param {number} [file.timeoutMs] - Override of the configured time budget.
 * @returns {Promise<{envelope: Object, queueMs: number}>} The thread's answer
 *   (`{ ok, result | error, format, durationMs }`) and the time the job waited.
 * @throws {ExtractionPoolError} The thread timed out, died, ran out of memory
 *   or the pool is shutting down.
 */
export function runInThread(task, payload, { bytes, transfer = false, timeoutMs } = {}) {
  if (closed) {
    return Promise.reject(
      new ExtractionPoolError('shutdown', 'The server is shutting down; try again in a moment.')
    );
  }
  return new Promise((resolve, reject) => {
    queue.push({
      task,
      payload,
      bytes,
      transfer,
      timeoutMs,
      enqueuedAt: performance.now(),
      resolve,
      reject
    });
    dispatch();
  });
}

function spawn() {
  const { memoryMb } = extractionSettings();
  const worker = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: memoryMb } });
  const slot = { worker, job: null, timer: null };
  worker.on('message', envelope => {
    const { job } = slot;
    if (!job) return;
    clearTimeout(slot.timer);
    slot.job = null;
    job.resolve({ envelope, queueMs: job.queueMs });
    dispatch();
  });
  worker.on('error', error => {
    const memory = error?.code === 'ERR_WORKER_OUT_OF_MEMORY';
    retire(
      slot,
      new ExtractionPoolError(
        memory ? 'memory' : 'crashed',
        memory
          ? 'The file needs too much memory to read.'
          : `The extraction thread failed: ${error?.message || error}`
      )
    );
  });
  worker.on('exit', code => {
    retire(
      slot,
      new ExtractionPoolError('crashed', `The extraction thread exited (code ${code}).`)
    );
  });
  // An idle thread must not keep the process alive; a running job does, by its
  // timer. After the listeners: adding a 'message' listener references the port again.
  worker.unref();
  slots.add(slot);
  return slot;
}

/** Remove a thread that is gone or must go, and fail the job it was running. */
function retire(slot, error) {
  if (!slots.delete(slot)) return;
  clearTimeout(slot.timer);
  slot.worker.removeAllListeners('message');
  // A listener stays so a late 'error' of the dying thread is not unhandled.
  slot.worker.on('error', () => {});
  slot.worker.terminate().catch(() => {});
  const { job } = slot;
  slot.job = null;
  if (job) job.reject(error);
  dispatch();
}

function start(slot, job) {
  const { timeoutMs: configured } = extractionSettings();
  const timeoutMs = job.timeoutMs ?? configured;
  job.queueMs = performance.now() - job.enqueuedAt;
  slot.job = job;
  slot.timer = setTimeout(() => {
    retire(
      slot,
      new ExtractionPoolError(
        'timeout',
        `Reading the file took longer than ${Math.round(timeoutMs / 100) / 10} s.`,
        { timeoutMs }
      )
    );
  }, timeoutMs);
  const input = ownedBytes(job.bytes, job.transfer);
  slot.worker.postMessage({ task: job.task, payload: { ...job.payload, bytes: input } }, [
    input.buffer
  ]);
}

function dispatch() {
  while (queue.length > 0 && !closed) {
    let slot = [...slots].find(candidate => !candidate.job);
    if (!slot) {
      if (slots.size >= Math.max(1, extractionSettings().threads)) return;
      try {
        slot = spawn();
      } catch (error) {
        queue.shift().reject(error);
        continue;
      }
    }
    start(slot, queue.shift());
  }
}

/**
 * Stop the threads for a server shutdown: queued jobs are rejected, running
 * ones are terminated. Later jobs are refused.
 */
export async function shutdownExtractionPool() {
  closed = true;
  while (queue.length > 0) {
    queue.shift().reject(new ExtractionPoolError('shutdown', 'The server is shutting down.'));
  }
  const stopping = [...slots].map(slot => {
    slots.delete(slot);
    clearTimeout(slot.timer);
    slot.worker.removeAllListeners('message');
    slot.worker.on('error', () => {});
    const { job } = slot;
    slot.job = null;
    if (job) job.reject(new ExtractionPoolError('shutdown', 'The server is shutting down.'));
    return slot.worker.terminate().catch(() => {});
  });
  await Promise.all(stopping);
}

/**
 * Render the first pages of a scanned PDF as base64 PNGs, in a thread when the
 * pool is on.
 *
 * @param {Buffer} bytes
 * @param {number} maxPages
 * @returns {Promise<{pageImages: string[], pages: number}>}
 */
export async function renderScannedPdfPages(bytes, maxPages) {
  assertAcceptingJobs();
  if (!extractionThreadsEnabled()) return renderScannedPdfPagesInProcess(bytes, maxPages);
  const { envelope } = await runInThread('renderPdfPages', { maxPages }, { bytes });
  if (!envelope.ok) throw new Error(envelope.error?.message || 'The PDF could not be rendered');
  return envelope.result;
}
