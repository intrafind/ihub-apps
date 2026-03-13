import crypto from 'crypto';

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
 * Create a new job with common fields and insert into the store.
 * @param {string} toolType - Tool identifier (e.g. 'ocr', 'websearch')
 * @param {object} data - Tool-specific data
 * @returns {object} The created job
 */
export function createJob(toolType, data = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    toolType,
    status: 'queued',
    progress: { current: 0, total: 0 },
    result: null,
    resultContentType: null,
    resultFilename: null,
    error: null,
    model: null,
    clients: [],
    createdAt: Date.now(),
    data
  };
  jobs.set(id, job);
  return job;
}

/**
 * Retrieve a job by ID.
 */
export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Send SSE update to all connected clients for a job.
 */
export function notifyClients(job) {
  if (!job.clients || job.clients.length === 0) return;

  const payload = {
    status: job.status,
    toolType: job.toolType,
    progress: job.progress,
    error: job.error || null,
    model: job.model || null
  };
  const message = `data: ${JSON.stringify(payload)}\n\n`;

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
