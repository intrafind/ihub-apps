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
 * @param {string} userId - ID of the user who created the job
 * @param {object} data - Tool-specific data
 * @returns {object} The created job
 */
export function createJob(toolType, userId, data = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    toolType,
    userId,
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
 * Check if a user can access a job.
 * Admins can access all jobs; regular users can only access their own.
 */
export function canAccessJob(job, user) {
  if (!job || !user) return false;
  if (user.permissions?.adminAccess === true) return true;
  return job.userId === user.id;
}

/**
 * List jobs with optional filtering.
 * Admins see all jobs; regular users only see their own.
 */
export function listJobs(userId, isAdmin, filters = {}) {
  const result = [];
  for (const [id, job] of jobs) {
    if (!isAdmin && job.userId !== userId) continue;
    if (filters.status && job.status !== filters.status) continue;
    if (filters.toolType && job.toolType !== filters.toolType) continue;
    result.push({
      id,
      toolType: job.toolType,
      userId: job.userId,
      status: job.status,
      progress: job.progress,
      error: job.error,
      model: job.model,
      resultFilename: job.resultFilename,
      createdAt: job.createdAt
    });
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
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
    if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
      res.end();
    }
  }

  if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
    job.clients = [];
  }
}
