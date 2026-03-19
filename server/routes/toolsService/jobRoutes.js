import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import { getJob, canAccessJob, listJobs, notifyClients } from './jobStore.js';
import { sendBadRequest, sendNotFound } from '../../utils/responseHelpers.js';

const router = express.Router();

/**
 * GET /jobs
 * List jobs for the current user (admins see all).
 * Query params: ?status=completed&toolType=ocr
 */
router.get('/jobs', authRequired, (req, res) => {
  const isAdmin = req.user?.permissions?.adminAccess === true;
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.toolType) filters.toolType = req.query.toolType;

  const result = listJobs(req.user?.id, isAdmin, filters);
  res.json(result);
});

/**
 * GET /jobs/:jobId/progress
 * SSE endpoint for real-time progress updates (shared across all tools).
 */
router.get('/jobs/:jobId/progress', authRequired, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || !canAccessJob(job, req.user)) {
    return sendNotFound(res, 'Job');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send current status immediately
  const payload = {
    status: job.status,
    toolType: job.toolType,
    progress: job.progress,
    error: job.error || null,
    model: job.model || null
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // If already done, close
  if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
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
 * GET /jobs/:jobId/download
 * Download the result of a completed job (shared across all tools).
 */
router.get('/jobs/:jobId/download', authRequired, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || !canAccessJob(job, req.user)) {
    return sendNotFound(res, 'Job');
  }

  if (job.status !== 'completed' || !job.result) {
    return sendBadRequest(res, 'Job is not completed yet');
  }

  res.setHeader('Content-Type', job.resultContentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${job.resultFilename || 'result'}"`);
  res.setHeader('Content-Length', job.result.length);
  res.send(job.result);
});

/**
 * PATCH /jobs/:jobId/cancel
 * Cancel a running job.
 */
router.patch('/jobs/:jobId/cancel', authRequired, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || !canAccessJob(job, req.user)) {
    return sendNotFound(res, 'Job');
  }

  if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
    return sendBadRequest(res, `Job is already ${job.status}`);
  }

  job.status = 'cancelled';
  notifyClients(job);

  res.json({ success: true, status: 'cancelled' });
});

export function registerJobRoutes(parentRouter) {
  parentRouter.use('/', router);
}
