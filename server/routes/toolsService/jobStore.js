import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { isAnonymousUser } from '../../services/loop/runIdentity.js';
import {
  createPresenceMap,
  gather,
  hasRemote,
  isClusterBusActive,
  request,
  respond
} from '../../clusterBus.js';
import config from '../../config.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import logger from '../../utils/logger.js';

/**
 * Jobs live in the memory of the worker that runs them — the uploaded file,
 * the progress, the result PDF. Requests about a job (progress, download,
 * cancel, the job list) reach whichever cluster worker a connection lands on,
 * so ownership is announced over the cluster bus and other workers ask the
 * owner: a snapshot, a cancellation, its share of the list. The result is
 * written to the shared data directory when clustered, so any worker can
 * serve the download without shipping megabytes over IPC.
 */
const JOB_PRESENCE = 'tool-job';
const BUS_GET = 'tool-job:get';
const BUS_CANCEL = 'tool-job:cancel';
const BUS_LIST = 'tool-job:list';

// In-memory job store; its keys are announced to the other workers.
const jobs = createPresenceMap(JOB_PRESENCE);

// Clean up old jobs after 1 hour
const JOB_TTL_MS = 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set(['completed', 'error', 'cancelled']);

/** Where results are written for other workers to serve. */
const RESULTS_DIR = getContentsPath('data', 'tool-jobs');

async function removeResultFile(file) {
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Could not remove tool job result', {
        component: 'JobStore',
        error: error.message
      });
    }
  }
}

/** Results nobody owns any more: their worker died before its sweep ran. */
async function sweepOrphanedResults(now) {
  let names;
  try {
    names = await fs.readdir(RESULTS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(RESULTS_DIR, name);
    try {
      const stat = await fs.stat(file);
      if (now - stat.mtimeMs > JOB_TTL_MS * 2) await removeResultFile(file);
    } catch {
      // Removed by another worker's sweep meanwhile.
    }
  }
}

// unref: the sweep alone must not keep the process alive.
setInterval(
  () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.createdAt > JOB_TTL_MS) {
        jobs.delete(id);
        void removeResultFile(job.resultFile);
      }
    }
    if (isClusterBusActive()) void sweepOrphanedResults(now);
  },
  5 * 60 * 1000
).unref();

/** What other workers may know about a job: everything but the bytes. */
function snapshotOf(job) {
  return {
    id: job.id,
    toolType: job.toolType,
    userId: job.userId,
    status: job.status,
    progress: job.progress,
    error: job.error || null,
    model: job.model || null,
    resultFilename: job.resultFilename,
    resultContentType: job.resultContentType,
    resultFile: job.resultFile || null,
    createdAt: job.createdAt
  };
}

// Answers for the other workers. `undefined` = not mine, stay silent.
respond(BUS_GET, ({ jobId } = {}) => {
  const job = jobs.get(jobId);
  return job ? { job: snapshotOf(job) } : undefined;
});
respond(BUS_CANCEL, ({ jobId } = {}) => {
  const job = jobs.get(jobId);
  return job ? cancelJob(job) : undefined;
});
respond(BUS_LIST, ({ userId, isAdmin, filters } = {}) => ({
  jobs: listJobs(userId, isAdmin, filters)
}));

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
 * Find a job on this worker or the one running it.
 *
 * @param {string} jobId
 * @returns {Promise<{job: object, local: boolean}|null>} The live job when it
 *   runs here, otherwise the owner's snapshot (no result bytes, no clients).
 */
export async function findJob(jobId) {
  const job = jobs.get(jobId);
  if (job) return { job, local: true };
  if (typeof jobId !== 'string' || !hasRemote(JOB_PRESENCE, jobId)) return null;
  const reply = await request(BUS_GET, { jobId }, { route: { kind: JOB_PRESENCE, key: jobId } });
  return reply?.job ? { job: reply.job, local: false } : null;
}

/** Whether another worker still announces it holds the job. */
export function isJobOwnedElsewhere(jobId) {
  return typeof jobId === 'string' && hasRemote(JOB_PRESENCE, jobId);
}

/** Whether a job's status is final. */
export function isTerminal(job) {
  return TERMINAL_STATUSES.has(job?.status);
}

/**
 * Cancel a job running on this worker.
 * @returns {{status: string}|{error: string}}
 */
export function cancelJob(job) {
  if (isTerminal(job)) return { error: `Job is already ${job.status}` };
  job.status = 'cancelled';
  notifyClients(job);
  return { status: 'cancelled' };
}

/**
 * Cancel a job wherever it runs.
 * @returns {Promise<{status: string}|{error: string}|null>} null when no worker has it
 */
export async function cancelJobAnywhere(jobId) {
  const job = jobs.get(jobId);
  if (job) return cancelJob(job);
  if (!hasRemote(JOB_PRESENCE, jobId)) return null;
  return request(BUS_CANCEL, { jobId }, { route: { kind: JOB_PRESENCE, key: jobId } });
}

/**
 * Store a finished job's result and mark it completed.
 *
 * When clustered the result is also written to the shared data directory, so
 * a download reaching another worker can be served from there.
 *
 * @param {object} job
 * @param {{result: Buffer, contentType: string, filename: string}} result
 */
export async function completeJob(job, { result, contentType, filename }) {
  job.result = result;
  job.resultContentType = contentType;
  job.resultFilename = filename;
  if (isClusterBusActive()) {
    const file = path.join(RESULTS_DIR, `${job.id}.result`);
    // Written beside the final name and renamed, so a crash never leaves a
    // truncated result behind under that name.
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(RESULTS_DIR, { recursive: true });
      await fs.writeFile(temp, result);
      await fs.rename(temp, file);
      job.resultFile = file;
    } catch (error) {
      await removeResultFile(temp);
      logger.warn('Could not store tool job result for other workers', {
        component: 'JobStore',
        jobId: job.id,
        error: error.message
      });
    }
  }
  job.status = 'completed';
}

/**
 * List jobs from every worker, with the same filtering as {@link listJobs}.
 */
export async function listJobsEverywhere(userId, isAdmin, filters = {}) {
  const local = listJobs(userId, isAdmin, filters);
  if (!isClusterBusActive()) return local;
  const replies = await gather(
    BUS_LIST,
    { userId, isAdmin, filters },
    { expected: Math.max(0, (Number(config.WORKERS) || 1) - 1), timeoutMs: 1000 }
  );
  const byId = new Map(local.map(job => [job.id, job]));
  for (const reply of replies) {
    for (const job of reply?.jobs || []) {
      if (!byId.has(job.id)) byId.set(job.id, job);
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Check if a user can access a job.
 * Admins can access all jobs; regular users can only access their own.
 */
export function canAccessJob(job, user) {
  if (!job || !user) return false;
  if (user.permissions?.adminAccess === true) return true;
  // Anonymous visitors share one principal id, so no job belongs to them.
  if (isAnonymousUser(user)) return false;
  return job.userId === user.id;
}

/**
 * List jobs with optional filtering.
 * Admins see all jobs; regular users only see their own.
 */
export function listJobs(userId, isAdmin, filters = {}) {
  const result = [];
  // Anonymous visitors share one principal id, so no job belongs to them.
  if (!isAdmin && isAnonymousUser({ id: userId })) return result;
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
 *
 * Wraps each client's write/end in its own try/catch — without this, the first
 * dead socket throws and aborts iteration, so every later client misses the
 * update AND the `job.clients = []` reset below is skipped (causing repeated
 * notifyClients() calls to spam errors against the same dead sockets).
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
  const isTerminal =
    job.status === 'completed' || job.status === 'error' || job.status === 'cancelled';

  const survivors = [];
  for (const res of job.clients) {
    try {
      res.write(message);
      if (isTerminal) {
        res.end();
      } else {
        survivors.push(res);
      }
    } catch {
      // Dead socket — drop this client. The HTTP layer will reclaim the
      // connection slot on its own; we just stop trying to write to it.
    }
  }

  job.clients = isTerminal ? [] : survivors;
}
