// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Page recognition with a vision model: the building blocks the OCR tool
 * (`routes/toolsService/processors/ocrProcessor.js`) and text recognition at
 * upload (`services/ocr/textRecognition.js`) share. PDF pages are rendered
 * with pdfium, analysed with pdf.js, and sent to the model one page at a time.
 *
 * @module services/ocr/pageRecognition
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PNG } from 'pngjs';
import llmClient from '../loop/LLMClient.js';
import logger from '../../utils/logger.js';

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

let _pdfiumLib = null;

async function getPdfiumLibrary() {
  if (!_pdfiumLib) {
    const { PDFiumLibrary } = await import('@hyzyla/pdfium');
    _pdfiumLib = await PDFiumLibrary.init();
  }
  return _pdfiumLib;
}

// ─── Server-side PDF rendering ───────────────────────────────────────────────

/**
 * Render a single PDF page to a base64 PNG using @hyzyla/pdfium (pure WASM).
 * Renders at scale 2 (~1190px wide for A4) for good OCR quality.
 *
 * @param {Buffer} pdfBuffer - raw PDF bytes
 * @param {number} pageIndex - 0-based page index
 */
export async function renderPageToImage(pdfBuffer, pageIndex) {
  const library = await getPdfiumLibrary();
  const doc = await library.loadDocument(pdfBuffer);
  try {
    const pages = [...doc.pages()];
    const page = pages[pageIndex];

    const image = await page.render({ scale: 2, render: 'bitmap' });

    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data);
    const pngBuffer = PNG.sync.write(png);
    return pngBuffer.toString('base64');
  } finally {
    doc.destroy();
  }
}

/**
 * Load a PDF from a Buffer and return a pdfjs document.
 * pdfjs is used exclusively for text extraction and page analysis —
 * rendering is handled by pdfium.
 */
export async function loadPdfDocument(pdfBuffer) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    verbosity: 0
  });
  return loadingTask.promise;
}

// ─── Smart text detection (page analysis) ────────────────────────────────────

/** Minimum chars of extracted text to consider a page "text-rich" */
export const MIN_TEXT_CHARS = 50;

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
export async function analyzePdfPages(pdfDoc) {
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
export async function pMap(items, fn, concurrency) {
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

/**
 * Call the vision model with one rendered page image and return the extracted
 * markdown text.
 *
 * Goes through `LLMClient.complete()` (non-streaming) so throttling, transient
 * retries, response parsing for every provider and the run-ledger envelope are
 * shared with the rest of the server. Provider failures surface as `LLMError`
 * (`err.code`, `err.status`); the job loop treats upstream 4xx as fatal.
 *
 * @param {string} base64Image - Page image (PNG or JPEG) as base64
 * @param {Object} model - Resolved vision-capable model config
 * @param {string|null} apiKey - API key resolved once per job
 * @param {number} pageNum - 1-based page number (logging only)
 * @param {string} prompt - OCR instruction prompt
 * @param {string|null} [mimeType] - The image's type; guessed (PNG or JPEG) when not given
 * @returns {Promise<string>} Extracted text ('' when the model returned none)
 */
export async function extractTextFromPageImage(
  base64Image,
  model,
  apiKey,
  pageNum,
  prompt,
  mimeType = null
) {
  const messages = [
    {
      role: 'user',
      content: prompt,
      imageData: [
        {
          base64: base64Image,
          fileType:
            mimeType || (detectImageFormat(base64Image) === 'jpg' ? 'image/jpeg' : 'image/png')
        }
      ]
    }
  ];

  const result = await llmClient.complete({
    model,
    apiKey,
    messages,
    options: { maxTokens: 8192 },
    telemetry: { kind: 'utility', purpose: 'ocr', refs: {} }
  });

  if (result.content) {
    return result.content;
  }

  logger.warn('Could not extract text from LLM response', {
    component: 'OcrProcessor',
    pageNum,
    provider: model.provider,
    finishReason: result.finishReason
  });
  return '';
}

export function detectImageFormat(base64String) {
  // PNG magic bytes: 89 50 4E 47 → base64 starts with "iVBOR"
  if (base64String.startsWith('iVBOR')) return 'png';
  // JPEG magic bytes: FF D8 FF → base64 starts with "/9j/"
  if (base64String.startsWith('/9j/')) return 'jpg';
  // Default to PNG
  return 'png';
}
