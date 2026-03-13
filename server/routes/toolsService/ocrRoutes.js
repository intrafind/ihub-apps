import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import configCache from '../../configCache.js';
import { createJob } from './jobStore.js';
import { processOcrJob } from './processors/ocrProcessor.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';

const router = express.Router();

const MAX_PAGES = 200;
const MAX_PROMPT_LENGTH = 2000;

/**
 * POST /ocr/process
 * Start an OCR job.
 *
 * Body for PDF input:
 *   { inputType: 'pdf', pageImages: string[], originalPdf: string, modelId?: string, prompt?: string }
 *
 * Body for image input:
 *   { inputType: 'images', images: string[], modelId?: string, prompt?: string }
 */
router.post('/ocr/process', authRequired, async (req, res) => {
  try {
    const { inputType = 'pdf', pageImages, originalPdf, images, modelId, prompt } = req.body;

    // Validate prompt
    if (prompt && (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH)) {
      return sendBadRequest(
        res,
        `prompt must be a string of at most ${MAX_PROMPT_LENGTH} characters`
      );
    }

    let jobPageImages;
    let jobOriginalPdf = null;

    if (inputType === 'images') {
      // Image input mode
      if (!images || !Array.isArray(images) || images.length === 0) {
        return sendBadRequest(res, 'images array is required for inputType "images"');
      }
      if (images.length > MAX_PAGES) {
        return sendBadRequest(res, `Maximum ${MAX_PAGES} images allowed`);
      }
      jobPageImages = images;
    } else {
      // PDF input mode (default)
      if (!pageImages || !Array.isArray(pageImages) || pageImages.length === 0) {
        return sendBadRequest(res, 'pageImages array is required');
      }
      if (!originalPdf) {
        return sendBadRequest(res, 'originalPdf is required for inputType "pdf"');
      }
      if (pageImages.length > MAX_PAGES) {
        return sendBadRequest(res, `Maximum ${MAX_PAGES} pages allowed`);
      }
      jobPageImages = pageImages;
      jobOriginalPdf = Buffer.from(originalPdf, 'base64');
    }

    const job = createJob('ocr', {
      inputType,
      pageImages: jobPageImages,
      originalPdf: jobOriginalPdf,
      modelId: modelId || null,
      prompt: prompt || null
    });

    job.progress = { current: 0, total: jobPageImages.length };

    res.json({ jobId: job.id, totalPages: jobPageImages.length });

    // Start processing asynchronously
    processOcrJob(job);
  } catch (err) {
    return sendInternalError(res, err, 'start OCR job');
  }
});

/**
 * GET /ocr/models
 * Get list of models suitable for OCR (vision-capable).
 */
router.get('/ocr/models', authRequired, (req, res) => {
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
        supportsVision: !!(m.supportsImages || m.supportsVision),
        isDefault: !!m.default
      }));

    res.json(ocrModels);
  } catch (err) {
    return sendInternalError(res, err, 'list OCR models');
  }
});

export function registerOcrRoutes(parentRouter) {
  parentRouter.use('/', router);
}
