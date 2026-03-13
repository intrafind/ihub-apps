import express from 'express';
import crypto from 'crypto';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { authRequired } from '../middleware/authRequired.js';
import configCache from '../configCache.js';
import { createCompletionRequest } from '../adapters/index.js';
import { getApiKeyForModel } from '../utils.js';
import { throttledFetch } from '../requestThrottler.js';
import logger from '../utils/logger.js';
import { sendBadRequest, sendInternalError, sendNotFound } from '../utils/responseHelpers.js';

// In-memory job store
const jobs = new Map();

// Clean up old jobs after 1 hour
const JOB_TTL_MS = 60 * 60 * 1000;

setInterval(
  () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.createdAt > JOB_TTL_MS) {
        jobs.delete(id);
      }
    }
  },
  5 * 60 * 1000
);

/**
 * Call the LLM with a page image and extract text via vision
 */
async function extractTextFromPageImage(base64Image, model, apiKey, pageNum) {
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You are an OCR engine. Extract ALL text from this scanned document page exactly as it appears. Preserve the original layout, line breaks, paragraphs, and formatting as closely as possible. Output ONLY the extracted text with no commentary, no explanations, and no markdown formatting. If there is no text on the page, output exactly: [BLANK PAGE]`
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${base64Image}`,
            detail: 'high'
          }
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
    throw new Error(`LLM API error (${response.status}) for page ${pageNum}: ${errorText}`);
  }

  const data = await response.json();

  // Extract text from response — handle different provider formats
  if (data.choices?.[0]?.message?.content) {
    return data.choices[0].message.content;
  }
  if (data.content?.[0]?.text) {
    return data.content[0].text;
  }
  if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }

  logger.warn('Could not extract text from LLM response', {
    component: 'PdfOcr',
    pageNum,
    responseKeys: Object.keys(data)
  });
  return '';
}

/**
 * Build a PDF with an invisible text layer for each page.
 * Takes the original page dimensions and the extracted text per page,
 * then overlays a transparent text layer so the PDF becomes searchable.
 */
async function buildOcrPdf(pages, originalPdfBytes) {
  // Load the original PDF to preserve its visual content
  const srcDoc = await PDFDocument.load(originalPdfBytes);
  const srcPages = srcDoc.getPages();

  // Embed a standard font for the text layer
  const font = await srcDoc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < srcPages.length; i++) {
    const page = srcPages[i];
    const text = pages[i]?.text || '';
    if (!text || text === '[BLANK PAGE]') continue;

    const { width, height } = page.getSize();
    const fontSize = 10;
    const lineHeight = fontSize * 1.2;

    // Split text into lines and draw them invisibly on the page
    const lines = text.split('\n');
    let y = height - 20; // Start near top

    for (const line of lines) {
      if (y < 20) break; // Stop near bottom
      page.drawText(line, {
        x: 10,
        y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
        opacity: 0 // Invisible text layer
      });
      y -= lineHeight;
    }
  }

  return await srcDoc.save();
}

/**
 * Process a job: iterate over page images, call LLM, build PDF
 */
async function processJob(job) {
  try {
    const { data: models } = configCache.getModels();
    if (!models || models.length === 0) {
      job.status = 'error';
      job.error = 'No AI models available';
      notifyClients(job);
      return;
    }

    // Find a vision-capable model. Prefer the requested model if specified.
    let model;
    if (job.modelId) {
      model = models.find(m => m.id === job.modelId);
    }
    if (!model) {
      // Fall back to any vision-capable model, or the default model
      model =
        models.find(m => m.supportsVision && m.enabled !== false) ||
        models.find(m => m.default) ||
        models[0];
    }

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

    for (let i = 0; i < job.pageImages.length; i++) {
      if (job.status === 'cancelled') return;

      job.currentPage = i + 1;
      job.status = 'processing';
      notifyClients(job);

      try {
        const text = await extractTextFromPageImage(job.pageImages[i], model, apiKey, i + 1);
        job.pageTexts[i] = { text, pageNum: i + 1 };

        logger.info('OCR completed for page', {
          component: 'PdfOcr',
          jobId: job.id,
          page: i + 1,
          textLength: text.length
        });
      } catch (err) {
        logger.error('OCR failed for page', {
          component: 'PdfOcr',
          jobId: job.id,
          page: i + 1,
          error: err.message
        });
        job.pageTexts[i] = { text: '', pageNum: i + 1, error: err.message };
      }

      job.completedPages = i + 1;
      notifyClients(job);
    }

    // Build the OCR PDF with text layer
    job.status = 'building';
    notifyClients(job);

    const pdfBytes = await buildOcrPdf(job.pageTexts, job.originalPdf);
    job.resultPdf = Buffer.from(pdfBytes);
    job.status = 'completed';

    // Free page images to save memory
    job.pageImages = null;
    job.originalPdf = null;

    notifyClients(job);

    logger.info('OCR job completed', {
      component: 'PdfOcr',
      jobId: job.id,
      pages: job.totalPages,
      resultSize: job.resultPdf.length
    });
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    notifyClients(job);

    logger.error('OCR job failed', {
      component: 'PdfOcr',
      jobId: job.id,
      error: err.message
    });
  }
}

/**
 * Send SSE update to all connected clients for a job
 */
function notifyClients(job) {
  if (!job.clients) return;
  const data = {
    status: job.status,
    currentPage: job.currentPage,
    totalPages: job.totalPages,
    completedPages: job.completedPages,
    error: job.error || null,
    model: job.model || null
  };
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of job.clients) {
    res.write(message);
    if (job.status === 'completed' || job.status === 'error') {
      res.end();
    }
  }
  if (job.status === 'completed' || job.status === 'error') {
    job.clients = [];
  }
}

export default function registerPdfOcrRoutes(app) {
  const router = express.Router();

  /**
   * POST /api/pdf-ocr/process
   * Start an OCR job. Body: { pageImages: string[], originalPdf: string, modelId?: string }
   * pageImages: array of base64-encoded page images
   * originalPdf: base64-encoded original PDF
   */
  router.post('/process', authRequired, async (req, res) => {
    try {
      const { pageImages, originalPdf, modelId } = req.body;

      if (!pageImages || !Array.isArray(pageImages) || pageImages.length === 0) {
        return sendBadRequest(res, 'pageImages array is required');
      }

      if (!originalPdf) {
        return sendBadRequest(res, 'originalPdf is required');
      }

      if (pageImages.length > 200) {
        return sendBadRequest(res, 'Maximum 200 pages allowed');
      }

      const jobId = crypto.randomUUID();

      const job = {
        id: jobId,
        status: 'queued',
        totalPages: pageImages.length,
        currentPage: 0,
        completedPages: 0,
        pageImages,
        originalPdf: Buffer.from(originalPdf, 'base64'),
        pageTexts: [],
        resultPdf: null,
        modelId: modelId || null,
        model: null,
        error: null,
        clients: [],
        createdAt: Date.now()
      };

      jobs.set(jobId, job);

      res.json({ jobId, totalPages: pageImages.length });

      // Start processing asynchronously
      processJob(job);
    } catch (err) {
      return sendInternalError(res, err, 'start PDF OCR job');
    }
  });

  /**
   * GET /api/pdf-ocr/progress/:jobId
   * SSE endpoint for real-time progress updates
   */
  router.get('/progress/:jobId', authRequired, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return sendNotFound(res, 'Job');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Send current status immediately
    const data = {
      status: job.status,
      currentPage: job.currentPage,
      totalPages: job.totalPages,
      completedPages: job.completedPages,
      error: job.error || null,
      model: job.model || null
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);

    // If already done, close
    if (job.status === 'completed' || job.status === 'error') {
      res.end();
      return;
    }

    // Register this client for updates
    job.clients.push(res);

    req.on('close', () => {
      if (job.clients) {
        job.clients = job.clients.filter(c => c !== res);
      }
    });
  });

  /**
   * GET /api/pdf-ocr/download/:jobId
   * Download the OCR'd PDF
   */
  router.get('/download/:jobId', authRequired, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return sendNotFound(res, 'Job');
    }

    if (job.status !== 'completed' || !job.resultPdf) {
      return sendBadRequest(res, 'Job is not completed yet');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ocr-result.pdf"`);
    res.setHeader('Content-Length', job.resultPdf.length);
    res.send(job.resultPdf);
  });

  /**
   * GET /api/pdf-ocr/models
   * Get list of models suitable for OCR (vision-capable)
   */
  router.get('/models', authRequired, (req, res) => {
    try {
      const { data: models } = configCache.getModels();
      if (!models) {
        return res.json([]);
      }

      const ocrModels = models
        .filter(m => m.enabled !== false)
        .map(m => ({
          id: m.id,
          name: m.name,
          supportsVision: !!m.supportsVision,
          isDefault: !!m.default
        }));

      res.json(ocrModels);
    } catch (err) {
      return sendInternalError(res, err, 'list OCR models');
    }
  });

  app.use('/api/pdf-ocr', router);
}
