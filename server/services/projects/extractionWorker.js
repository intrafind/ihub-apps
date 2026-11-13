// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { parentPort } from 'node:worker_threads';

/**
 * Worker thread entry of the extraction pool (`extractionPool.js`, #3649).
 *
 * One message is one job: `{ task, payload }` where `payload.bytes` is the
 * file. The thread answers with a plain envelope — `{ ok, result | error,
 * format, durationMs }` — and never throws across the boundary, so the pool
 * can tell a failed file (an answer) from a dead thread (no answer).
 *
 * Nothing here reaches out: extraction reads the bytes it was given, so the
 * outbound-connection rules (SSL whitelist, proxy) have nothing to apply to,
 * and no main-thread config is needed — every limit arrives in the payload.
 * Keep it that way: a feature that needs the network does not belong here.
 */

const TASKS = {
  async extract({ bytes, contentType, name, options }) {
    const { extractTextCore } = await import('./extractText.js');
    let format = 'unknown';
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    try {
      const result = await extractTextCore(
        { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentType, name },
        options || {},
        found => {
          format = found;
        }
      );
      return { ok: true, result, format, durationMs: elapsed() };
    } catch (error) {
      return { ok: false, error: describeError(error), format, durationMs: elapsed() };
    }
  },

  async renderPdfPages({ bytes, maxPages }) {
    const { renderScannedPdfPagesInProcess } = await import('../documents/pdf/scannedPages.js');
    const started = performance.now();
    try {
      const result = await renderScannedPdfPagesInProcess(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        maxPages
      );
      return { ok: true, result, format: 'pdf', durationMs: performance.now() - started };
    } catch (error) {
      return {
        ok: false,
        error: describeError(error),
        format: 'pdf',
        durationMs: performance.now() - started
      };
    }
  }
};

/** An error as plain data; `name` and `code` let the pool rebuild an `ExtractionError`. */
function describeError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code,
    message: error?.message || String(error)
  };
}

parentPort.on('message', async ({ task, payload }) => {
  const run = TASKS[task];
  if (!run) {
    parentPort.postMessage({
      ok: false,
      error: { name: 'Error', message: `Unknown extraction task: ${task}` }
    });
    return;
  }
  try {
    parentPort.postMessage(await run(payload));
  } catch (error) {
    parentPort.postMessage({ ok: false, error: describeError(error) });
  }
});
