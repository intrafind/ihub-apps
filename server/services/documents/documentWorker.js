// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { parentPort } from 'node:worker_threads';

/**
 * Worker thread entry: render one document (see `renderService.js`).
 *
 * Runs off the main thread so a large or pathological layout cannot block the
 * server's event loop; the service terminates the worker when it runs past
 * its time budget. Each format's renderer is imported only when needed.
 */

const RENDERERS = {
  pdf: async ({ spec, assets }) => {
    const { renderPdfSpec } = await import('./pdf/renderPdf.js');
    const { buffer, pages, warnings } = await renderPdfSpec(spec, assets);
    return { buffer, meta: { pages }, warnings };
  },
  docx: async ({ spec, assets }) => {
    const { renderDocx } = await import('./docx/renderDocx.js');
    return renderDocx(spec, assets);
  },
  pptx: async ({ spec, assets }) => {
    const { renderPptx } = await import('./pptx/renderPptx.js');
    return renderPptx(spec, assets);
  }
};

parentPort.once('message', async ({ format, payload }) => {
  try {
    const render = RENDERERS[format];
    if (!render) throw new Error(`Unknown document format: ${format}`);
    const { buffer, meta, warnings } = await render(payload);
    // Transfer the bytes instead of copying them.
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
    parentPort.postMessage({ ok: true, bytes, meta, warnings }, [bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message || String(error) });
  }
});
