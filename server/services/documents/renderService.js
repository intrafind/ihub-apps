// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Worker } from 'node:worker_threads';

/**
 * Renders documents (PDF, Word, PowerPoint) in worker threads.
 *
 * Layout and packaging are CPU-bound and the content may come from a model,
 * so every document gets a fresh worker, a time budget and a memory cap, and
 * a small concurrency limit — shared by all formats — keeps a burst of
 * documents from starving chat traffic. The worker (`documentWorker.js`)
 * dispatches on the format.
 */

const WORKER_URL = new URL('./documentWorker.js', import.meta.url);

export const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT = 2;
const MAX_QUEUED = 20;
const WORKER_MEMORY_MB = 512;

const FORMAT_LABELS = { pdf: 'PDF', docx: 'Word document', pptx: 'presentation' };

export class DocumentGenerationError extends Error {
  /**
   * @param {string} message
   * @param {string} code - `invalid`, `timeout`, `busy`, `failed`
   */
  constructor(message, code = 'failed') {
    super(message);
    this.name = 'DocumentGenerationError';
    this.code = code;
  }
}

let running = 0;
const queue = [];

function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  if (queue.length >= MAX_QUEUED) {
    return Promise.reject(
      new DocumentGenerationError('The document service is busy. Try again in a moment.', 'busy')
    );
  }
  return new Promise(resolve => queue.push(resolve));
}

function release() {
  const next = queue.shift();
  if (next) next();
  else running -= 1;
}

function runWorker(format, payload, timeoutMs) {
  const label = FORMAT_LABELS[format] || 'document';
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB }
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new DocumentGenerationError(
          `Rendering the ${label} took longer than ${Math.round(timeoutMs / 1000)} s. Simplify or split it.`,
          'timeout'
        )
      );
    }, timeoutMs);
    worker.once('message', message => {
      if (message?.ok) {
        finish(resolve, {
          buffer: Buffer.from(
            message.bytes.buffer,
            message.bytes.byteOffset,
            message.bytes.byteLength
          ),
          meta: message.meta || {},
          warnings: message.warnings || []
        });
      } else {
        finish(
          reject,
          new DocumentGenerationError(message?.error || `Rendering the ${label} failed`, 'invalid')
        );
      }
    });
    worker.once('error', error => {
      const outOfMemory = error?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish(
        reject,
        new DocumentGenerationError(
          outOfMemory
            ? `The ${label} needs too much memory to render. Split it into smaller documents.`
            : `Rendering the ${label} failed: ${error?.message || error}`,
          outOfMemory ? 'invalid' : 'failed'
        )
      );
    });
    worker.once('exit', code => {
      if (!settled) {
        finish(
          reject,
          new DocumentGenerationError(`The ${label} renderer exited (code ${code})`, 'failed')
        );
      }
    });
    worker.postMessage({ format, payload });
  });
}

/**
 * Render a document in a worker thread.
 *
 * @param {'pdf'|'docx'|'pptx'} format
 * @param {{ spec: Object, assets?: Object }} payload - Plain data; template
 *   files travel as buffers in `assets`.
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ buffer: Buffer, meta: Object, warnings: string[] }>}
 */
export async function renderInWorker(format, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!payload?.spec || typeof payload.spec !== 'object') {
    throw new DocumentGenerationError('A document spec is required.', 'invalid');
  }
  await acquire();
  try {
    return await runWorker(format, payload, timeoutMs);
  } finally {
    release();
  }
}
