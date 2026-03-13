import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import configCache from '../../../configCache.js';
import { createCompletionRequest } from '../../../adapters/index.js';
import { getApiKeyForModel } from '../../../utils.js';
import { throttledFetch } from '../../../requestThrottler.js';
import logger from '../../../utils/logger.js';
import { notifyClients } from '../jobStore.js';
import { convertResponseToGeneric } from '../../../adapters/toolCalling/ToolCallingConverter.js';

/**
 * Default OCR prompt optimized for complex documents with tables, charts, and diagrams.
 * Designed so that each table row is self-contained (includes column context)
 * and visual elements get meaningful text representations for downstream LLM consumption.
 */
export const DEFAULT_OCR_PROMPT = `You are a precision OCR engine. Extract ALL content from this scanned document page exactly as it appears.

## General Text
- Preserve the original layout, line breaks, paragraphs, and formatting.
- Reproduce headings, subheadings, lists (bulleted and numbered), and captions faithfully.
- Do not add commentary, explanations, or markdown formatting unless the original document uses it.

## Tables
- Before each table, add a brief descriptive sentence summarizing what the table contains (e.g., "Table: Quarterly revenue by region for fiscal year 2024.").
- Reproduce tables in markdown table format.
- Prefix each data row with a comment restating the column headers so rows remain self-contained when chunked:
  Table: Employee directory listing name, age, and city of residence.
  | Name | Age | City |
  |------|-----|------|
  <!-- Columns: Name, Age, City -->
  | Alice | 30 | Berlin |
  <!-- Columns: Name, Age, City -->
  | Bob | 25 | Munich |
- For complex multi-level header tables, flatten headers into a single row with full header paths (e.g., "Q1 - Revenue").
- If the table has a visible caption or title in the document, use that as the descriptive text.

## Charts and Graphs
- Format as: [CHART: <type>] followed by a description.
- Include: chart type (bar, line, pie, scatter, etc.), axis labels, units, scale, data points or series values when readable, and a one-sentence key trend summary.

## Drawings and Diagrams
- Format as: [DIAGRAM] followed by a description.
- Describe: shapes, labels, arrows, connections, flow direction, and spatial relationships.
- Preserve all text labels exactly as written.

## Mixed Content
- Process each content block (text, table, chart, diagram) in reading order (top-to-bottom, left-to-right).
- Separate distinct content blocks with a blank line.

## Empty Pages
- If there is no text or visual content on the page, output exactly: [BLANK PAGE]

Output ONLY the extracted and described content. No preamble, no closing remarks.`;

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
          fileType: 'image/png'
        }
      ]
    }
  ];

  const request = createCompletionRequest(model, messages, apiKey, {
    temperature: 0.1,
    maxTokens: 4096,
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
 * Build a PDF with an invisible text layer overlaid on the original PDF pages.
 */
async function buildOcrPdf(pageTexts, originalPdfBytes) {
  const srcDoc = await PDFDocument.load(originalPdfBytes);
  const srcPages = srcDoc.getPages();
  const font = await srcDoc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < srcPages.length; i++) {
    const page = srcPages[i];
    const text = pageTexts[i]?.text || '';
    if (!text || text === '[BLANK PAGE]') continue;

    const { height } = page.getSize();
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
 */
async function buildOcrPdfFromImages(imageDataList, pageTexts) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

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
    if (job.data.inputType === 'images') {
      pdfBytes = await buildOcrPdfFromImages(pageImages, pageTexts);
    } else {
      pdfBytes = await buildOcrPdf(pageTexts, job.data.originalPdf);
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
