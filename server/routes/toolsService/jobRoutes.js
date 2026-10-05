import express from 'express';
import { createReadStream } from 'fs';
import { authRequired } from '../../middleware/authRequired.js';
import {
  canAccessJob,
  cancelJobAnywhere,
  findJob,
  isTerminal,
  listJobsEverywhere
} from './jobStore.js';
import { sendBadRequest, sendNotFound } from '../../utils/responseHelpers.js';

/** How often a progress stream for a job on another worker asks for news. */
const REMOTE_PROGRESS_POLL_MS = 1000;

function progressPayload(job) {
  return {
    status: job.status,
    toolType: job.toolType,
    progress: job.progress,
    error: job.error || null,
    model: job.model || null
  };
}

const router = express.Router();

/**
 * GET /jobs
 * List jobs for the current user (admins see all).
 * Query params: ?status=completed&toolType=ocr
 */
router.get('/jobs', authRequired, async (req, res) => {
  const isAdmin = req.user?.permissions?.adminAccess === true;
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.toolType) filters.toolType = req.query.toolType;

  // Jobs started on other cluster workers are listed too.
  const result = await listJobsEverywhere(req.user?.id, isAdmin, filters);
  res.json(result);
});

/**
 * GET /jobs/:jobId/progress
 * SSE endpoint for real-time progress updates (shared across all tools).
 *
 * Deliberately NOT migrated to createSseChannel (server/utils/sseChannel.js):
 * jobs support multiple concurrent listeners per id (`job.clients` is an
 * array, not a single pinned entry), progress pushes happen synchronously
 * from notifyClients() rather than via the actionTracker 'fire-sse' bus, and
 * jobs are short-lived with their own TTL sweep (jobStore.js), so a
 * heartbeat/dead-client sweep would be redundant.
 */
router.get('/jobs/:jobId/progress', authRequired, async (req, res) => {
  const found = await findJob(req.params.jobId);
  const job = found?.job;
  if (!job || !canAccessJob(job, req.user)) {
    return sendNotFound(res, 'Job');
  }

  // `Connection: keep-alive` is intentionally absent — hop-by-hop headers are
  // forbidden in HTTP/2 (RFC 9113 §8.2.2) and break proxies that forward them.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no'
  });

  // Send current status immediately
  let lastSent = JSON.stringify(progressPayload(job));
  res.write(`data: ${lastSent}\n\n`);

  // If already done, close
  if (isTerminal(job)) {
    res.end();
    return;
  }

  if (!found.local) {
    // The job runs on another worker, which writes to its own clients only.
    // Ask it for news until the job ends or the browser goes away.
    const timer = setInterval(async () => {
      const latest = await findJob(job.id);
      if (res.writableEnded) return;
      if (!latest) {
        // The owning worker is gone, and the job with it.
        res.write(
          `data: ${JSON.stringify({ ...progressPayload(job), status: 'error', error: 'Job is no longer available' })}\n\n`
        );
        clearInterval(timer);
        res.end();
        return;
      }
      const next = JSON.stringify(progressPayload(latest.job));
      if (next !== lastSent) {
        lastSent = next;
        res.write(`data: ${next}\n\n`);
      }
      if (isTerminal(latest.job)) {
        clearInterval(timer);
        res.end();
      }
    }, REMOTE_PROGRESS_POLL_MS);
    req.on('close', () => clearInterval(timer));
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
router.get('/jobs/:jobId/download', authRequired, async (req, res) => {
  const found = await findJob(req.params.jobId);
  const job = found?.job;
  if (!job || !canAccessJob(job, req.user)) {
    return sendNotFound(res, 'Job');
  }

  // A job on another worker is served from the result file it wrote.
  const hasResult = found.local ? Boolean(job.result) : Boolean(job.resultFile);
  if (job.status !== 'completed' || !hasResult) {
    return sendBadRequest(res, 'Job is not completed yet');
  }

  res.setHeader('Content-Type', job.resultContentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${job.resultFilename || 'result'}"`);
  if (found.local) {
    res.setHeader('Content-Length', job.result.length);
    res.send(job.result);
    return;
  }
  const stream = createReadStream(job.resultFile);
  stream.on('error', () => {
    if (!res.headersSent) sendNotFound(res, 'Job result');
    else res.destroy();
  });
  stream.pipe(res);
});

/**
 * PATCH /jobs/:jobId/cancel
 * Cancel a running job.
 */
router.patch('/jobs/:jobId/cancel', authRequired, async (req, res) => {
  const found = await findJob(req.params.jobId);
  const job = found?.job;
  if (!job || !canAccessJob(job, req.user)) {
    return sendNotFound(res, 'Job');
  }

  if (isTerminal(job)) {
    return sendBadRequest(res, `Job is already ${job.status}`);
  }

  // Cancelled where it runs, so its processing loop sees it.
  const outcome = await cancelJobAnywhere(job.id);
  if (!outcome) return sendNotFound(res, 'Job');
  if (outcome.error) return sendBadRequest(res, outcome.error);

  res.json({ success: true, status: 'cancelled' });
});

export function registerJobRoutes(parentRouter) {
  parentRouter.use('/', router);
}
