import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import configCache from '../../../configCache.js';
import { createCompletionRequest } from '../../../adapters/index.js';
import { getApiKeyForModel } from '../../../utils.js';
import { throttledFetch } from '../../../requestThrottler.js';
import logger from '../../../utils/logger.js';
import { notifyClients } from '../jobStore.js';
import { convertResponseToGeneric } from '../../../adapters/toolCalling/ToolCallingConverter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load a Unicode-capable font once at module init for PDF text layers. */
const UNICODE_FONT_BYTES = readFileSync(
  join(__dirname, '..', '..', '..', 'assets', 'fonts', 'LiberationSans-Regular.ttf')
);

/**
 * Default OCR prompt optimized for complex documents with tables, charts, and diagrams.
 * Designed so that each table row is self-contained (includes column context)
 * and visual elements get meaningful text representations for downstream LLM consumption.
 */
export const DEFAULT_OCR_PROMPT = `Extract ALL text from this document page into clean markdown. Output each content block exactly once.

IMPORTANT: All descriptive text you add (table summaries, chart descriptions, diagram descriptions) MUST be written in the same language as the document content. Detect the document language and use it consistently.

Rules:
- Headings: use # / ## / ### as appropriate.
- Paragraphs and lists: preserve as-is with line breaks.
- Tables: output as markdown tables with a brief description before each table in the document's language. Prefix every data row with an HTML comment restating the column headers for chunking context. After the table, add a **summary paragraph** that explains the key data points, notable values, trends, totals, or comparisons — so a reader can understand the table content without seeing it:
  Tabelle: Mitarbeiterverzeichnis.
  | Name | Alter | Stadt |
  |------|-------|-------|
  <!-- Spalten: Name, Alter, Stadt -->
  | Alice | 30 | Berlin |
  <!-- Spalten: Name, Alter, Stadt -->
  | Bob | 25 | München |

  Zusammenfassung: Die Tabelle listet zwei Mitarbeiter. Alice (30) arbeitet in Berlin, Bob (25) in München. Das Durchschnittsalter beträgt 27,5 Jahre.
- Multi-level table headers: flatten into single row (e.g., "Q1 - Revenue").
- Charts/graphs: [CHART: <type>] then write a **comprehensive description** that includes: the chart type, axis labels and units, all data points or series, the key trend or pattern, highest and lowest values, and any notable comparisons — all in the document's language.
- Diagrams/drawings: [DIAGRAM] then write a **comprehensive description** that explains: the overall purpose, all shapes/nodes and their labels, all arrows/connections and their direction, the process flow or relationships depicted, and any decision points or branches — all in the document's language.
- Process in reading order (top-to-bottom, left-to-right). Separate blocks with a blank line.
- Empty page: output exactly [BLANK PAGE].
- Do NOT duplicate content. Do NOT add commentary or preamble.`;

/**
 * Call the LLM with a page image and extract text via vision.
 */
async function extractTextFromPageImage(base64Image, model, apiKey, pageNum, prompt) {
  const messages = [
    {
      role: 'user',
      content: prompt,
      imageData: [
        {
          base64: base64Image,
          fileType: detectImageFormat(base64Image) === 'jpg' ? 'image/jpeg' : 'image/png'
        }
      ]
    }
  ];

  const request = createCompletionRequest(model, messages, apiKey, {
    temperature: 0.1,
    maxTokens: 8192,
    stream: false
  });

  const fetchOptions = {
    method: request.method || 'POST',
    headers: request.headers
  };

  if (fetchOptions.method === 'POST' && request.body) {
    fetchOptions.body = JSON.stringify(request.body);
  }

  const response = await throttledFetch(model.id, request.url, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    const err = new Error(`LLM API error (${response.status}) for page ${pageNum}: ${errorText}`);
    err.statusCode = response.status;
    throw err;
  }

  const data = await response.json();

  // Use the adapter converter to extract text — handles provider-specific
  // formats and filters out thinking/reasoning content automatically
  const genericResponse = convertResponseToGeneric(JSON.stringify(data), model.provider);

  if (genericResponse.content && genericResponse.content.length > 0) {
    return genericResponse.content.join('');
  }

  logger.warn('Could not extract text from LLM response', {
    component: 'OcrProcessor',
    pageNum,
    provider: model.provider,
    responseKeys: Object.keys(data)
  });
  return '';
}

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
function detectImageFormat(base64String) {
  // PNG magic bytes: 89 50 4E 47 → base64 starts with "iVBOR"
  if (base64String.startsWith('iVBOR')) return 'png';
  // JPEG magic bytes: FF D8 FF → base64 starts with "/9j/"
  if (base64String.startsWith('/9j/')) return 'jpg';
  // Default to PNG
  return 'png';
}

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
 * Process an OCR job: iterate over page images, call LLM, build result PDF.
 */
export async function processOcrJob(job) {
  try {
    const { data: models } = configCache.getModels();
    if (!models || models.length === 0) {
      job.status = 'error';
      job.error = 'No AI models available';
      notifyClients(job);
      return;
    }

    const model = findVisionModel(models, job.data.modelId);
    if (!model) {
      job.status = 'error';
      job.error = 'No suitable AI model found for OCR';
      notifyClients(job);
      return;
    }

    const apiKey = await getApiKeyForModel(model.id);
    if (!apiKey) {
      job.status = 'error';
      job.error = `No API key configured for model ${model.id}`;
      notifyClients(job);
      return;
    }

    job.model = model.id;
    const prompt = job.data.prompt || DEFAULT_OCR_PROMPT;
    const pageImages = job.data.pageImages;
    const pageTexts = [];

    for (let i = 0; i < pageImages.length; i++) {
      if (job.status === 'cancelled') return;

      job.progress = { current: i, total: pageImages.length };
      job.status = 'processing';
      notifyClients(job);

      try {
        const text = await extractTextFromPageImage(pageImages[i], model, apiKey, i + 1, prompt);
        pageTexts[i] = { text, pageNum: i + 1 };

        logger.info('OCR completed for page', {
          component: 'OcrProcessor',
          jobId: job.id,
          page: i + 1,
          textLength: text.length
        });
      } catch (err) {
        logger.error('OCR failed for page', {
          component: 'OcrProcessor',
          jobId: job.id,
          page: i + 1,
          error: err.message
        });

        // Non-retryable model error (4xx) — abort immediately
        if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
          job.status = 'error';
          job.error =
            err.statusCode === 404
              ? 'Model not found. Please select a different model.'
              : `Model error (${err.statusCode}): The selected model rejected the request.`;
          notifyClients(job);
          return;
        }

        // Transient error — continue with next page
        pageTexts[i] = { text: '', pageNum: i + 1, error: err.message };
      }

      job.progress = { current: i + 1, total: pageImages.length };
      notifyClients(job);
    }

    // Build the result PDF
    job.status = 'building';
    notifyClients(job);

    let pdfBytes;
    const debugMode = job.data.debugMode;
    if (job.data.inputType === 'images') {
      pdfBytes = await buildOcrPdfFromImages(pageImages, pageTexts, debugMode);
    } else {
      pdfBytes = await buildOcrPdf(pageTexts, job.data.originalPdf, debugMode);
    }

    job.result = Buffer.from(pdfBytes);
    job.resultContentType = 'application/pdf';
    job.resultFilename = job.data.outputFilename || 'ocr-result.pdf';
    job.status = 'completed';

    // Free image data to save memory
    job.data.pageImages = null;
    job.data.originalPdf = null;

    notifyClients(job);

    logger.info('OCR job completed', {
      component: 'OcrProcessor',
      jobId: job.id,
      pages: pageImages.length,
      resultSize: job.result.length
    });
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
