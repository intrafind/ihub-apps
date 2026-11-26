// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import configCache from '../../../configCache.js';
import { resolveModelApiKey } from '../../../utils.js';
import logger from '../../../utils/logger.js';
import { completeJob, notifyClients } from '../jobStore.js';
import {
  DEFAULT_OCR_PROMPT,
  MIN_TEXT_CHARS,
  analyzePdfPages,
  detectImageFormat,
  extractTextFromPageImage,
  loadPdfDocument,
  pMap,
  renderPageToImage
} from '../../../services/ocr/pageRecognition.js';

// Re-exported: the OCR routes and their tests import the prompt from here.
export { DEFAULT_OCR_PROMPT };

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load a Unicode-capable font once at module init for PDF text layers. */
const UNICODE_FONT_BYTES = readFileSync(
  join(__dirname, '..', '..', '..', 'assets', 'fonts', 'LiberationSans-Regular.ttf')
);

/** Max concurrent VLM calls per job */
const OCR_PAGE_CONCURRENCY = 5;

// ─── PDFium singleton (pure WASM, no native binaries) ────────────────────────

// ─── LLM interaction ─────────────────────────────────────────────────────────

// ─── PDF building ────────────────────────────────────────────────────────────

/**
 * Draw visible text on a page with word-wrapping to fit within margins.
 */
function drawVisibleText(page, text, font, fontSize, margin) {
  const { width, height } = page.getSize();
  const lineHeight = fontSize * 1.4;
  const maxWidth = width - margin * 2;
  let y = height - margin;

  for (const rawLine of text.split('\n')) {
    if (y < margin) break;

    // Word-wrap long lines
    const words = rawLine.split(/(\s+)/);
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine + word;
      const testWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (testWidth > maxWidth && currentLine.length > 0) {
        page.drawText(currentLine, {
          x: margin,
          y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0)
        });
        y -= lineHeight;
        if (y < margin) break;
        currentLine = word.trimStart();
      } else {
        currentLine = testLine;
      }
    }

    if (y >= margin && currentLine.length > 0) {
      page.drawText(currentLine, {
        x: margin,
        y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0)
      });
      y -= lineHeight;
    }
  }
}

/**
 * Build a PDF with an invisible text layer overlaid on the original PDF pages.
 * When debugMode is true, a blank page with the visible extracted text is
 * inserted after each original page.
 */
async function buildOcrPdf(pageTexts, originalPdfBytes, debugMode) {
  const srcDoc = await PDFDocument.load(originalPdfBytes);
  srcDoc.registerFontkit(fontkit);
  const font = await srcDoc.embedFont(UNICODE_FONT_BYTES, { subset: true });
  const srcPages = srcDoc.getPages();

  // Collect debug pages to insert after iteration (inserting during would shift indices)
  const debugInserts = [];

  for (let i = 0; i < srcPages.length; i++) {
    const page = srcPages[i];
    const text = pageTexts[i]?.text || '';
    if (!text || text === '[BLANK PAGE]') continue;

    const { width, height } = page.getSize();
    const fontSize = 10;
    const lineHeight = fontSize * 1.2;

    const lines = text.split('\n');
    let y = height - 20;

    for (const line of lines) {
      if (y < 20) break;
      page.drawText(line, {
        x: 10,
        y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
        opacity: 0
      });
      y -= lineHeight;
    }

    if (debugMode) {
      debugInserts.push({ afterIndex: i, width, height, text });
    }
  }

  // Insert debug pages in reverse order so indices stay valid
  for (let d = debugInserts.length - 1; d >= 0; d--) {
    const { afterIndex, width, height, text } = debugInserts[d];
    const debugPage = srcDoc.insertPage(afterIndex + 1, [width, height]);
    drawVisibleText(debugPage, text, font, 9, 30);
  }

  return await srcDoc.save();
}

/**
 * Detect image format from a base64 string by inspecting the first bytes.
 * Returns 'png' or 'jpg'. Defaults to 'png' for unknown formats.
 */

/**
 * Build a new PDF from raw images with an invisible text layer.
 * Used when the user uploads images (not a PDF).
 * When debugMode is true, a blank page with the visible extracted text is
 * appended after each image page.
 */
async function buildOcrPdfFromImages(imageDataList, pageTexts, debugMode) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(UNICODE_FONT_BYTES, { subset: true });

  for (let i = 0; i < imageDataList.length; i++) {
    const base64 = imageDataList[i];
    const format = detectImageFormat(base64);
    const imageBytes = Buffer.from(base64, 'base64');

    let image;
    if (format === 'jpg') {
      image = await pdfDoc.embedJpg(imageBytes);
    } else {
      image = await pdfDoc.embedPng(imageBytes);
    }

    const { width, height } = image.scale(1);
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });

    // Overlay invisible text layer
    const text = pageTexts[i]?.text || '';
    if (text && text !== '[BLANK PAGE]') {
      const fontSize = 10;
      const lineHeight = fontSize * 1.2;
      const lines = text.split('\n');
      let y = height - 20;

      for (const line of lines) {
        if (y < 20) break;
        page.drawText(line, {
          x: 10,
          y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
          opacity: 0
        });
        y -= lineHeight;
      }

      if (debugMode) {
        const debugPage = pdfDoc.addPage([width, height]);
        drawVisibleText(debugPage, text, font, 9, 30);
      }
    }
  }

  return await pdfDoc.save();
}

/**
 * Find a suitable vision-capable model.
 */
function findVisionModel(models, preferredModelId) {
  if (preferredModelId) {
    const preferred = models.find(m => m.id === preferredModelId);
    if (preferred) return preferred;
  }

  return (
    models.find(m => (m.supportsImages || m.supportsVision) && m.enabled !== false) ||
    models.find(m => m.default) ||
    models[0]
  );
}

/**
 * The API key a whole OCR job runs with, decided once.
 *
 * A model on a local server needs none. That has to stay a decision: handed on
 * as `null`, every page call would look the key up again in the live
 * configuration, so a model edited while the job runs could send a new key to
 * the destination the job started with. An empty key is explicit — the model
 * call neither looks anything up nor sends an Authorization header.
 *
 * @param {{state: string, apiKey: string|null}} resolution - From `resolveModelApiKey`
 * @returns {string|null} The key, or '' for a model that runs without one
 */
export function ocrJobApiKey(resolution) {
  return resolution.state === 'keyless' ? '' : resolution.apiKey;
}

// ─── Main job processor ──────────────────────────────────────────────────────

/**
 * Process an OCR job: analyze pages, render images server-side, call LLM
 * in parallel, and build result PDF.
 */
export async function processOcrJob(job) {
  try {
    const ocrMode = job.data.ocrMode || 'full';

    // For text-only mode, we don't need a model
    let model = null;
    let apiKey = null;

    if (ocrMode !== 'text-only') {
      const { data: models } = configCache.getModels();
      if (!models || models.length === 0) {
        job.status = 'error';
        job.error = 'No AI models available';
        notifyClients(job);
        return;
      }

      model = findVisionModel(models, job.data.modelId);
      if (!model) {
        job.status = 'error';
        job.error = 'No suitable AI model found for OCR';
        notifyClients(job);
        return;
      }

      const keyResolution = await resolveModelApiKey(model.id);
      if (keyResolution.state !== 'ok' && keyResolution.state !== 'keyless') {
        job.status = 'error';
        job.error =
          keyResolution.state === 'undecryptable'
            ? `The API key stored for model ${model.id} cannot be decrypted. Enter it again in the admin UI.`
            : `No API key configured for model ${model.id}`;
        notifyClients(job);
        return;
      }
      apiKey = ocrJobApiKey(keyResolution);

      job.model = model.id;
    }

    const prompt = job.data.prompt || DEFAULT_OCR_PROMPT;
    const inputType = job.data.inputType;

    // ── PDF input: server-side rendering + optional smart detection ──
    if (inputType === 'pdf') {
      const pdfBuffer = job.data.fileBuffer;
      const pdfDoc = await loadPdfDocument(pdfBuffer);
      const numPages = pdfDoc.numPages;

      job.progress = { current: 0, total: numPages };
      job.status = 'processing';
      notifyClients(job);

      // Analyze pages for smart mode
      let pageAnalysis = null;
      if (ocrMode === 'smart' || ocrMode === 'text-only') {
        pageAnalysis = await analyzePdfPages(pdfDoc);

        const vlmPages = pageAnalysis.filter(p => p.needsVlm).length;
        const textPages = numPages - vlmPages;

        logger.info('PDF page analysis complete', {
          component: 'OcrProcessor',
          jobId: job.id,
          numPages,
          vlmPages,
          textPages,
          ocrMode
        });
      }

      // Build page processing tasks
      const pageIndices = Array.from({ length: numPages }, (_, i) => i);
      let completed = 0;
      const pageTexts = new Array(numPages);

      await pMap(
        pageIndices,
        async idx => {
          if (job.status === 'cancelled' || job.status === 'error') return;

          const pageNum = idx + 1;
          const analysis = pageAnalysis?.[idx];

          // text-only mode: always use extracted text
          if (ocrMode === 'text-only') {
            pageTexts[idx] = {
              text: analysis?.extractedText || '',
              pageNum,
              source: 'text-extraction'
            };
            completed++;
            job.progress = { current: completed, total: numPages };
            notifyClients(job);
            return;
          }

          // smart mode: skip VLM for text-rich pages without images/tables
          if (ocrMode === 'smart' && analysis && !analysis.needsVlm) {
            pageTexts[idx] = {
              text: analysis.extractedText,
              pageNum,
              source: 'text-extraction'
            };
            completed++;
            job.progress = { current: completed, total: numPages };
            notifyClients(job);
            return;
          }

          // VLM processing: render page to image, then call LLM
          try {
            const base64Image = await renderPageToImage(pdfBuffer, pageNum - 1);

            // For smart mode pages that have some text + visual elements,
            // prepend the extracted text to give context
            let pagePrompt = prompt;
            if (ocrMode === 'smart' && analysis?.extractedText?.length > MIN_TEXT_CHARS) {
              pagePrompt = `Existing embedded text on this page:\n${analysis.extractedText}\n\nNow analyze the visual elements (tables, charts, images, diagrams) and provide the complete structured output including both the text and visual content.\n\n${prompt}`;
            }

            const text = await extractTextFromPageImage(
              base64Image,
              model,
              apiKey,
              pageNum,
              pagePrompt
            );
            pageTexts[idx] = { text, pageNum, source: 'vlm' };

            logger.info('OCR completed for page', {
              component: 'OcrProcessor',
              jobId: job.id,
              page: pageNum,
              textLength: text.length,
              source: 'vlm'
            });
          } catch (err) {
            logger.error('OCR failed for page', {
              component: 'OcrProcessor',
              jobId: job.id,
              page: pageNum,
              error: err.message
            });

            // Non-retryable model error (4xx) — abort immediately
            // LLMError exposes the upstream HTTP status as `err.status`.
            const status = err.status ?? err.statusCode;
            if (status && status >= 400 && status < 500) {
              job.status = 'error';
              job.error =
                status === 404
                  ? 'Model not found. Please select a different model.'
                  : `Model error (${status}): The selected model rejected the request.`;
              notifyClients(job);
              return;
            }

            // Transient error — continue with next page
            pageTexts[idx] = { text: '', pageNum, error: err.message };
          }

          completed++;
          job.progress = { current: completed, total: numPages };
          notifyClients(job);
        },
        OCR_PAGE_CONCURRENCY
      );

      // Check if job was cancelled or errored during processing
      if (job.status === 'cancelled' || job.status === 'error') {
        job.data.fileBuffer = null;
        return;
      }

      // Build the result PDF
      job.status = 'building';
      notifyClients(job);

      const pdfBytes = await buildOcrPdf(pageTexts, pdfBuffer, job.data.debugMode);

      await completeJob(job, {
        result: Buffer.from(pdfBytes),
        contentType: 'application/pdf',
        filename: job.data.outputFilename || 'ocr-result.pdf'
      });

      // Free buffer data to save memory
      job.data.fileBuffer = null;

      notifyClients(job);

      logger.info('OCR job completed', {
        component: 'OcrProcessor',
        jobId: job.id,
        pages: numPages,
        ocrMode,
        resultSize: job.result.length
      });
    } else {
      // ── Image input mode (uploaded image files, one page each) ──
      const pageImages = job.data.pageImages;
      const pageTexts = [];
      let completed = 0;

      job.status = 'processing';
      notifyClients(job);

      await pMap(
        pageImages,
        async (base64Image, idx) => {
          if (job.status === 'cancelled' || job.status === 'error') return;

          const pageNum = idx + 1;

          try {
            const text = await extractTextFromPageImage(
              base64Image,
              model,
              apiKey,
              pageNum,
              prompt
            );
            pageTexts[idx] = { text, pageNum };

            logger.info('OCR completed for page', {
              component: 'OcrProcessor',
              jobId: job.id,
              page: pageNum,
              textLength: text.length
            });
          } catch (err) {
            logger.error('OCR failed for page', {
              component: 'OcrProcessor',
              jobId: job.id,
              page: pageNum,
              error: err.message
            });

            // LLMError exposes the upstream HTTP status as `err.status`.
            const status = err.status ?? err.statusCode;
            if (status && status >= 400 && status < 500) {
              job.status = 'error';
              job.error =
                status === 404
                  ? 'Model not found. Please select a different model.'
                  : `Model error (${status}): The selected model rejected the request.`;
              notifyClients(job);
              return;
            }

            pageTexts[idx] = { text: '', pageNum, error: err.message };
          }

          completed++;
          job.progress = { current: completed, total: pageImages.length };
          notifyClients(job);
        },
        OCR_PAGE_CONCURRENCY
      );

      if (job.status === 'cancelled' || job.status === 'error') {
        job.data.fileBuffer = null;
        return;
      }

      // Build the result PDF
      job.status = 'building';
      notifyClients(job);

      const pdfBytes = await buildOcrPdfFromImages(pageImages, pageTexts, job.data.debugMode);

      await completeJob(job, {
        result: Buffer.from(pdfBytes),
        contentType: 'application/pdf',
        filename: job.data.outputFilename || 'ocr-result.pdf'
      });

      // Free image data to save memory
      job.data.pageImages = null;

      notifyClients(job);

      logger.info('OCR job completed', {
        component: 'OcrProcessor',
        jobId: job.id,
        pages: pageImages.length,
        resultSize: job.result.length
      });
    }
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    notifyClients(job);

    logger.error('OCR job failed', {
      component: 'OcrProcessor',
      jobId: job.id,
      error: err.message
    });
  }
}
