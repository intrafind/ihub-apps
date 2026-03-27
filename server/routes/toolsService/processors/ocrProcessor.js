import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import configCache from '../../../configCache.js';
import { createCompletionRequest } from '../../../adapters/index.js';
import { getApiKeyForModel } from '../../../utils.js';
import { throttledFetch } from '../../../requestThrottler.js';
import logger from '../../../utils/logger.js';
import { notifyClients } from '../jobStore.js';
import { convertResponseToGeneric } from '../../../adapters/toolCalling/ToolCallingConverter.js';

// canvas is an optional dependency (native module requiring system libraries).
// It is loaded lazily so the server can start even when canvas is not installed.
let _createCanvas;
async function getCreateCanvas() {
  if (!_createCanvas) {
    try {
      const canvasModule = await import('canvas');
      _createCanvas = canvasModule.createCanvas;
    } catch {
      throw new Error(
        'The "canvas" package is not available. ' +
          'Install system libraries (cairo, pango, pixman) and run "npm install canvas" to enable OCR.'
      );
    }
  }
  return _createCanvas;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load a Unicode-capable font once at module init for PDF text layers. */
const UNICODE_FONT_BYTES = readFileSync(
  join(__dirname, '..', '..', '..', 'assets', 'fonts', 'LiberationSans-Regular.ttf')
);

/** Max concurrent VLM calls per job */
const OCR_PAGE_CONCURRENCY = 5;

/**
 * Default OCR prompt optimized for complex documents with tables, charts, and diagrams.
 * Designed so that each table row is self-contained (includes column context)
 * and visual elements get meaningful text representations for downstream LLM consumption.
 */
export const DEFAULT_OCR_PROMPT2 = `Extract ALL text from this document page into clean markdown. Output each content block exactly once.

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

export const DEFAULT_OCR_PROMPT = `You are a production-grade document extraction system optimized for Retrieval-Augmented Generation (RAG) and full-text search indexing. Convert this document page image into structured, annotated Markdown following these rules precisely.

### GLOBAL RULES & NEGATIVE CONSTRAINTS:
- Transcribe ALL visible text exactly as it appears—omit nothing.
- Transcribe all text in its original language.
- Do NOT add commentary, preamble, interpretation, or information not visible in the image.
- Do NOT skip headers, footers, page numbers, or footnotes (transcribe them accurately).
- If text is partially or completely illegible, transcribe what is visible and mark unclear portions exactly with '[ILLEGIBLE]'.

### METADATA & ANNOTATIONS:
Start the extraction with page-level metadata using HTML comments. Generate a 1-2 sentence summary of the page to aid contextual retrieval:
<!-- page_summary:[Brief summary of page content in the document's language] -->
<!-- primary_language: [ISO language code, e.g., en, de, fr] -->

### STRUCTURE & FORMATTING:
- **Reading Order:** Follow the logical human reading order (e.g., left-to-right, top-to-bottom for Western documents; process full columns before moving to the next).
- **Hierarchy:** Use Markdown heading levels ('#', '##', '###') to preserve the document's section hierarchy.
- **Math & Equations:** Use LaTeX formatting ('$...$' for inline, '$$...$$' for block) for mathematical formulas.
- **Forms:** Keep form labels and values clearly associated. For checkboxes, strictly use '[x]' for checked/selected and '[ ]' for unchecked/empty.
- **Authentication:** Explicitly tag signatures as '[SIGNATURE: <Name/Role or "Unreadable">]' and stamps as '[STAMP: <Description of text/graphic>]'.

### TABLES (DUAL-CHUNK STRATEGY):
You MUST use HTML '<table>' tags for all tables to preserve merged cells ('colspan') and multi-level headers ('rowspan'). Markdown pipe-tables destroy complex structures.
1. **Pre-annotate:** Above every table, add:
   '<!-- content_type: table -->'
   '<!-- chunk_hint: keep_together -->'
2. **Extract:** Output the precise HTML '<table>' structure.
3. **Summarize:** Immediately following the '</table>' tag, add a **summary paragraph** prefixed with 'Table Summary: '. Explain the key data points, notable values, trends, totals, or comparisons — so a human reader or AI agent can fully understand the table content and answer complex questions without ever seeing the table itself. Write this summary in the document's language.

### VISUAL DATA (CHARTS, DIAGRAMS, IMAGES):
Before ANY visual data description, add the annotation:
'<!-- content_type: figure -->'
'<!-- chunk_hint: keep_together -->'
Then, process the visual based on its type:

- **Charts/Graphs:** Output '[FIGURE: <type>]' then write a **comprehensive description** that includes: the chart type, axis labels and units, all data points or series, the key trend or pattern, highest and lowest values, and any notable comparisons — all in the document's language.
- **Diagrams/Drawings:** Output '[DIAGRAM]' then write a **comprehensive description** that explains: the overall purpose, all shapes/nodes and their labels, all arrows/connections and their direction, the process flow or relationships depicted, and any decision points or branches — all in the document's language.
- **Photographs/Scans:** Output '[IMAGE: <subject>]' then write a **factual, detailed visual description** of everything shown in the document's language.

### HEADERS, FOOTERS & MARGINALIA:
To prevent vector pollution while preserving data, isolate repeating page numbers, document IDs, or legal footer disclaimers by wrapping them in:
'<!-- content_type: header -->' or '<!-- content_type: footer -->'.

### EMPTY PAGES:
If the page contains no meaningful text or visuals, output exactly '[BLANK PAGE]'.

Output ONLY the final annotated Markdown content. Do NOT include any explanatory text, apologies, or preambles.`;

// ─── Server-side PDF rendering ───────────────────────────────────────────────

/**
 * Render a single PDF page to a base64 JPEG using pdfjs-dist + node-canvas.
 * Targets ~1600px on the long edge for good OCR quality.
 */
async function renderPageToImage(pdfDoc, pageNum) {
  const createCanvas = await getCreateCanvas();
  const page = await pdfDoc.getPage(pageNum);
  const defaultViewport = page.getViewport({ scale: 1 });
  const longEdge = Math.max(defaultViewport.width, defaultViewport.height);

  const TARGET_LONG_EDGE = 1600;
  const scale = Math.min(2, TARGET_LONG_EDGE / longEdge);
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;

  // JPEG at 85% quality — good balance of quality vs size
  const jpegBuffer = canvas.toBuffer('image/jpeg', { quality: 0.85 });
  return jpegBuffer.toString('base64');
}

/**
 * Load a PDF from a Buffer and return a pdfjs document.
 */
async function loadPdfDocument(pdfBuffer) {
  const createCanvas = await getCreateCanvas();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    verbosity: 0,
    // Provide a canvas factory for node-canvas
    canvasFactory: {
      create(width, height) {
        const canvas = createCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
      },
      reset(canvasAndContext, width, height) {
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
      },
      destroy(canvasAndContext) {
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
      }
    }
  });
  return loadingTask.promise;
}

// ─── Smart text detection (page analysis) ────────────────────────────────────

/** Minimum chars of extracted text to consider a page "text-rich" */
const MIN_TEXT_CHARS = 50;

/** pdfjs operator list opcodes for image drawing */
const IMAGE_OPS = new Set(
  [
    pdfjs.OPS?.paintImageXObject,
    pdfjs.OPS?.paintJpegXObject,
    pdfjs.OPS?.paintImageXObjectRepeat
  ].filter(Boolean)
);

/**
 * Analyze all pages of a PDF to determine which need VLM and which have
 * enough embedded text to skip VLM.
 *
 * Returns an array of per-page analysis results.
 */
async function analyzePdfPages(pdfDoc) {
  const numPages = pdfDoc.numPages;
  const results = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDoc.getPage(i);

    // Extract embedded text
    const textContent = await page.getTextContent();
    const extractedText = textContent.items
      .map(item => item.str)
      .join(' ')
      .trim();

    // Check for images and complex drawings via operator list
    const opList = await page.getOperatorList();
    let hasImages = false;
    let pathCount = 0;

    for (let j = 0; j < opList.fnArray.length; j++) {
      const op = opList.fnArray[j];
      if (IMAGE_OPS.has(op)) {
        hasImages = true;
      }
      // constructPath / rectangle ops suggest tables or diagrams
      if (op === pdfjs.OPS?.constructPath || op === pdfjs.OPS?.rectangle) {
        pathCount++;
      }
    }

    // Heuristic: >20 path ops in a grid-like pattern suggests tables
    const hasTables = pathCount > 20;

    // Decision logic
    let needsVlm;
    if (hasImages || hasTables) {
      needsVlm = true;
    } else if (extractedText.length > MIN_TEXT_CHARS) {
      needsVlm = false;
    } else {
      // Very little text and no visuals — likely scanned
      needsVlm = true;
    }

    results.push({
      pageNum: i,
      extractedText,
      hasImages,
      hasTables,
      pathCount,
      needsVlm
    });
  }

  return results;
}

// ─── Concurrent page processing ──────────────────────────────────────────────

/**
 * Process items concurrently with a max concurrency limit.
 * Like p-map but inline — no external dependency.
 */
async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─── LLM interaction ─────────────────────────────────────────────────────────

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

      apiKey = await getApiKeyForModel(model.id);
      if (!apiKey) {
        job.status = 'error';
        job.error = `No API key configured for model ${model.id}`;
        notifyClients(job);
        return;
      }

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
            const base64Image = await renderPageToImage(pdfDoc, pageNum);

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

      job.result = Buffer.from(pdfBytes);
      job.resultContentType = 'application/pdf';
      job.resultFilename = job.data.outputFilename || 'ocr-result.pdf';
      job.status = 'completed';

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
      // ── Image input mode (legacy base64 path) ──
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

            if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
              job.status = 'error';
              job.error =
                err.statusCode === 404
                  ? 'Model not found. Please select a different model.'
                  : `Model error (${err.statusCode}): The selected model rejected the request.`;
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

      job.result = Buffer.from(pdfBytes);
      job.resultContentType = 'application/pdf';
      job.resultFilename = job.data.outputFilename || 'ocr-result.pdf';
      job.status = 'completed';

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
