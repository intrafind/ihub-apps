import { parentPort } from 'node:worker_threads';
import { renderPdfSpec } from './renderPdf.js';

/**
 * Worker thread entry: build and render one document spec.
 *
 * Runs off the main thread so a large or pathological layout cannot block the
 * server's event loop; `PdfService` terminates the worker when it runs past
 * its time budget.
 */
parentPort.once('message', async ({ spec }) => {
  try {
    const { buffer, pages, warnings } = await renderPdfSpec(spec);
    // Transfer the bytes instead of copying them.
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
    parentPort.postMessage({ ok: true, bytes, pages, warnings }, [bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message || String(error) });
  }
});
