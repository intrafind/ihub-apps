// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import express from 'express';
import { ServiceError } from '../../utils/ServiceError.js';
import multer from 'multer';
import { authRequired, authenticatedOnly } from '../../middleware/authRequired.js';
import configCache from '../../configCache.js';
import { createJob } from './jobStore.js';
import { processOcrJob } from './processors/ocrProcessor.js';
import { recordUpload } from '../../telemetry/metrics.js';
import { estimateTokens } from '../../../shared/tokenEstimator.js';

const router = express.Router();

// Custom prompt is bounded by tokens (matching the chat token estimator), not
// raw characters. Keep this in sync with the client-side limit in OcrPage.jsx.
const MAX_PROMPT_TOKENS = 4096;
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB per file
const MAX_FILES = 20;
const VALID_OCR_MODES = ['full', 'smart', 'text-only'];

const ACCEPTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp'
]);

// Configure multer for memory storage (files stay in RAM as Buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES
  },
  fileFilter(_req, file, cb) {
    if (ACCEPTED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  }
});

/**
 * POST /ocr/process
 * Start OCR job(s) from uploaded files.
 *
 * Multipart form fields:
 *   files:     File[] (one or more PDFs or images)
 *   modelId:   string (optional)
 *   prompt:    string (optional, max 2000 chars)
 *   ocrMode:   'full' | 'smart' | 'text-only' (default: 'full')
 *   debugMode: 'true' | 'false' (optional)
 *
 * Needs a signed-in user: a job belongs to the user who started it, and
 * anonymous visitors share one principal, so their jobs could never be
 * polled or downloaded.
 */
router.post(
  '/ocr/process',
  authenticatedOnly,
  (req, res, next) => {
    upload.array('files', MAX_FILES)(req, res, err => {
      if (err) {
        // Map multer's failure code to a label so dashboards can split
        // size-rejected from mime-rejected from generic.
        const outcome =
          err instanceof multer.MulterError
            ? err.code === 'LIMIT_FILE_SIZE'
              ? 'rejected_size'
              : 'rejected_other'
            : 'rejected_other';
        recordUpload('ocr', outcome);
        // A callback cannot throw into Express: hand the error to `next`.
        if (err instanceof multer.MulterError) {
          return next(new ServiceError('BAD_REQUEST', `Upload error: ${err.message}`));
        }
        return next(new ServiceError('BAD_REQUEST', err.message));
      }
      next();
    });
  },
  async (req, res) => {
    const files = req.files;
    if (!files || files.length === 0) {
      recordUpload('ocr', 'rejected_other');
      throw new ServiceError('BAD_REQUEST', 'At least one file is required');
    }
    for (const f of files) {
      recordUpload('ocr', 'accepted', f.size);
    }

    const { modelId, prompt, ocrMode = 'full', debugMode } = req.body;

    // Validate ocrMode
    if (!VALID_OCR_MODES.includes(ocrMode)) {
      throw new ServiceError(
        'BAD_REQUEST',
        `ocrMode must be one of: ${VALID_OCR_MODES.join(', ')}`
      );
    }

    // Validate prompt
    if (prompt !== undefined && typeof prompt !== 'string') {
      throw new ServiceError('BAD_REQUEST', 'prompt must be a string');
    }
    if (prompt && estimateTokens(prompt) > MAX_PROMPT_TOKENS) {
      throw new ServiceError('BAD_REQUEST', `prompt must be at most ${MAX_PROMPT_TOKENS} tokens`);
    }

    const jobs = [];

    for (const file of files) {
      const isPdf =
        file.mimetype === 'application/pdf' || file.originalname?.toLowerCase().endsWith('.pdf');

      // Derive output filename
      let outputFilename = 'ocr-result.pdf';
      if (file.originalname) {
        const sanitized = file.originalname.replace(/[^\w.\-() ]/g, '_');
        const ext = sanitized.split('.').pop()?.toLowerCase();
        outputFilename =
          ext === 'pdf' ? sanitized : sanitized.replace(/\.[^.]+$/, '.pdf') || sanitized + '.pdf';
      }

      if (isPdf) {
        const job = createJob('ocr', req.user?.id, {
          inputType: 'pdf',
          fileBuffer: file.buffer,
          modelId: modelId || null,
          prompt: prompt || null,
          ocrMode,
          outputFilename,
          debugMode: debugMode === 'true'
        });

        // We'll determine total pages during processing (server-side)
        job.progress = { current: 0, total: 0 };
        jobs.push({ jobId: job.id, fileName: file.originalname, totalPages: 0 });

        // Start processing asynchronously
        processOcrJob(job);
      } else {
        // Image file — convert to base64 for the existing image pipeline
        const base64 = file.buffer.toString('base64');

        const job = createJob('ocr', req.user?.id, {
          inputType: 'images',
          pageImages: [base64],
          modelId: modelId || null,
          prompt: prompt || null,
          ocrMode: 'full', // images always use full VLM
          outputFilename,
          debugMode: debugMode === 'true'
        });

        job.progress = { current: 0, total: 1 };
        jobs.push({ jobId: job.id, fileName: file.originalname, totalPages: 1 });

        processOcrJob(job);
      }
    }

    res.json({ items: jobs });
  }
);

/**
 * GET /ocr/models
 * Get list of models suitable for OCR (vision-capable).
 */
router.get('/ocr/models', authRequired, async (req, res) => {
  const { data: models } = await configCache.getModelsForUser(req.user);
  if (!models) {
    return res.json([]);
  }

  const ocrModels = models.map(m => ({
    id: m.id,
    name: m.name,
    supportsVision: !!(m.supportsImages || m.supportsVision),
    isDefault: !!m.default
  }));

  res.json(ocrModels);
});

export function registerOcrRoutes(parentRouter) {
  parentRouter.use('/', router);
}
