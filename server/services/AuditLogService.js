import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { getRootDir } from '../pathUtils.js';
import logger from '../utils/logger.js';
import configCache from '../configCache.js';
import { getContext } from '../utils/requestContext.js';
import { anonymizeIp } from '../utils/ipAnonymizer.js';
import { validateAuditEntry } from '../validators/auditEntrySchema.js';

const AUDIT_LOG_DIR = 'data/audit-log';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 365;
const FLUSH_INTERVAL_MS = 5000;
// Hard cap so a failing disk + high write volume can't exhaust memory. When
// exceeded we drop the oldest entries and emit a single overflow warning.
const MAX_QUEUE = 10000;

// Linear-time email-shape detection. A regex like /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// backtracks polynomially on attacker-supplied login usernames (CodeQL ReDoS),
// so we use string scanning instead.
function isEmailShaped(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (/\s/.test(value)) return false; // single linear test, no backtracking
  const at = value.indexOf('@');
  if (at <= 0) return false; // need a non-empty local part
  if (value.indexOf('@', at + 1) !== -1) return false; // exactly one '@'
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  // dot must be present and neither leading nor trailing in the domain
  return dot > 0 && dot < domain.length - 1;
}

// In-memory write buffer. High-volume middleware writes are batched and
// flushed on an interval (and on shutdown) so we don't hit the disk on every
// request. queryAuditLog() flushes first so reads stay consistent.
let queue = [];
let flushTimer = null;
let overflowed = false;

function getAuditConfig() {
  try {
    const platform = configCache.getPlatform ? configCache.getPlatform() : {};
    return platform?.audit || {};
  } catch {
    return {};
  }
}

function maskEmail(value) {
  if (isEmailShaped(value)) {
    return value.slice(0, value.indexOf('@'));
  }
  return value;
}

/**
 * Build the actor object for an audit entry. Prefers an explicit actor (used
 * for pre-auth events such as a failed login) and otherwise reads from
 * req.user. Honors audit.includeEmail (default false) by masking email-shaped
 * identifiers.
 */
function buildActor(req, explicitActor) {
  const includeEmail = getAuditConfig().includeEmail === true;
  const src = explicitActor || req?.user || {};
  let id = src.id ?? 'unknown';
  let username = src.username ?? src.name ?? src.id ?? 'unknown';
  // Mask email-shaped identifiers in BOTH id and username so includeEmail:false
  // actually prevents email storage (login actors set id = the attempted email).
  if (!includeEmail) {
    id = maskEmail(id);
    username = maskEmail(username);
  }
  const authenticated =
    typeof src.authenticated === 'boolean'
      ? src.authenticated
      : Boolean(src.id && src.id !== 'anonymous');
  return {
    id,
    username,
    groups: Array.isArray(src.groups) ? src.groups : [],
    authenticated
  };
}

/**
 * Derive the audit source from the request when not provided explicitly.
 */
function deriveSource(req) {
  if (!req) return 'web';
  if (req.user?.isOAuthClient || req.user?.authMethod === 'oauth') return 'api';
  const url = req.originalUrl || req.baseUrl || req.url || '';
  if (url.includes('/api/admin/')) return 'admin';
  return 'web';
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAuditLog().catch(error =>
      logger.error('Failed to flush audit log', {
        component: 'AuditLogService',
        error: error.message
      })
    );
  }, FLUSH_INTERVAL_MS);
  // Don't let a pending flush keep the process alive on shutdown.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

// Periodic safety-net flush. The one-shot scheduleFlush() timer clears itself
// before running, so if a flush throws and re-buffers, nothing re-arms it —
// this interval guarantees re-buffered entries eventually drain even with no
// further audit activity. Mirrors UsageEventLog. unref so it never blocks exit.
const periodicFlush = setInterval(() => {
  if (queue.length > 0) {
    flushAuditLog().catch(error =>
      logger.error('Audit periodic flush error', {
        component: 'AuditLogService',
        error: error.message
      })
    );
  }
}, FLUSH_INTERVAL_MS);
if (typeof periodicFlush.unref === 'function') periodicFlush.unref();

/**
 * Flush the buffered audit entries to their daily JSONL files. Entries are
 * grouped by date so a flush spanning midnight lands in the correct files.
 *
 * @returns {Promise<number>} number of entries written
 */
export async function flushAuditLog() {
  if (queue.length === 0) return 0;
  const pending = queue;
  queue = [];

  const byDate = new Map();
  for (const entry of pending) {
    const date = entry.ts.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(entry);
  }

  let count = 0;
  let firstError = null;
  // Write each date independently and only re-buffer the dates that failed, so
  // a partial failure (e.g. a flush spanning midnight) can't re-write — and
  // thereby duplicate — entries that already landed on disk.
  for (const [date, entries] of byDate) {
    try {
      const filePath = join(getRootDir(), 'contents', AUDIT_LOG_DIR, `${date}.jsonl`);
      await fs.mkdir(dirname(filePath), { recursive: true });
      const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(filePath, lines, 'utf8');
      count += entries.length;
    } catch (error) {
      firstError = firstError || error;
      // Re-buffer only this date's entries so the next flush retries just them.
      queue = entries.concat(queue);
    }
  }
  if (firstError) throw firstError;
  return count;
}

/**
 * Log an audit event to the append-only audit log. Entries are buffered and
 * flushed every few seconds (and on shutdown). Each day gets its own JSONL
 * file at contents/data/audit-log/YYYY-MM-DD.jsonl.
 *
 * @param {Object} options
 * @param {Object} [options.req] - Express request object
 * @param {string} options.action - 'create' | 'update' | 'delete' | 'toggle' | 'import' | 'export' | 'login' | 'logout'
 * @param {string} options.resource - Affected resource type (e.g. 'app', 'auth', 'user', 'oauthClient')
 * @param {string} [options.resourceId] - ID of the affected resource
 * @param {string} [options.summary] - Human-readable summary of the action
 * @param {'success'|'failure'} [options.result='success'] - Outcome of the action
 * @param {string} [options.source] - 'web' | 'mcp' | 'api' | 'admin' (derived from req when omitted)
 * @param {Object} [options.actor] - Explicit actor for pre-auth events (e.g. failed login)
 * @param {string} [options.requestId] - Explicit request id (used by the middleware,
 *   whose res 'finish' callback may run outside the request's async context)
 * @returns {Object|null} the buffered entry, or null on failure
 */
export function logAudit({
  req,
  action,
  resource,
  resourceId,
  summary,
  result = 'success',
  source,
  actor,
  requestId
} = {}) {
  try {
    const auditCfg = getAuditConfig();
    const includeEmail = auditCfg.includeEmail === true;
    // resourceId can carry the attempted identifier (e.g. a login id that is an
    // email), so honor the same masking as the actor.
    const safeResourceId = includeEmail ? resourceId || '' : maskEmail(resourceId || '');
    // Honor audit.anonymizeIp:
    //   true / 'mask' -> mask the host bits (/24 IPv4, /48 IPv6)
    //   'drop'        -> omit the `ip` property from the entry entirely
    //   anything else -> store verbatim
    const rawIp = req?.ip;
    const entry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      actor: buildActor(req, actor),
      action,
      resource,
      resourceId: safeResourceId,
      summary: summary || '',
      result,
      source: source || deriveSource(req),
      requestId: requestId || getContext()?.requestId || randomUUID()
    };
    if (auditCfg.anonymizeIp !== 'drop') {
      entry.ip =
        auditCfg.anonymizeIp === true || auditCfg.anonymizeIp === 'mask'
          ? anonymizeIp(rawIp)
          : rawIp;
    }

    const validation = validateAuditEntry(entry);
    if (!validation.success) {
      logger.warn('Audit entry failed validation; writing anyway', {
        component: 'AuditLogService',
        error: validation.error
      });
    }

    queue.push(entry);
    // Bound memory: if the buffer is overflowing (e.g. disk wedged), drop the
    // oldest entries rather than grow without limit. Warn once per overflow.
    if (queue.length > MAX_QUEUE) {
      queue.splice(0, queue.length - MAX_QUEUE);
      if (!overflowed) {
        overflowed = true;
        logger.error('Audit log buffer overflow — dropping oldest entries', {
          component: 'AuditLogService',
          max: MAX_QUEUE
        });
      }
    } else {
      overflowed = false;
    }
    scheduleFlush();

    // Mark the request so the global audit middleware doesn't emit a duplicate
    // coarse entry for the same request — explicit calls are authoritative.
    if (req) req._auditLogged = true;

    if (getAuditConfig().winstonMirror === true) {
      logger.info('audit', {
        component: 'audit',
        audit: true,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        result: entry.result,
        source: entry.source,
        actor: { id: entry.actor.id, authenticated: entry.actor.authenticated },
        requestId: entry.requestId
      });
    }

    return entry;
  } catch (error) {
    // Audit logging should never break the request
    logger.error('Failed to record audit log entry', {
      component: 'AuditLogService',
      action,
      resource,
      resourceId,
      error: error.message
    });
    return null;
  }
}

/**
 * Query audit log entries with optional filters and pagination.
 *
 * @param {Object} options
 * @param {string} [options.from] - Start date (YYYY-MM-DD), defaults to 7 days ago
 * @param {string} [options.to] - End date (YYYY-MM-DD), defaults to today
 * @param {string} [options.actor] - Filter by actor username
 * @param {string} [options.resource] - Filter by resource type
 * @param {string} [options.action] - Filter by action type
 * @param {string} [options.result] - Filter by outcome ('success' | 'failure')
 * @param {string} [options.source] - Filter by source ('web' | 'mcp' | 'api' | 'admin')
 * @param {number} [options.limit=50] - Max entries to return
 * @param {number} [options.offset=0] - Number of entries to skip
 * @returns {Promise<{entries: Array, total: number}>}
 */
export async function queryAuditLog({
  from,
  to,
  actor,
  resource,
  action,
  result,
  source,
  limit = 50,
  offset = 0
} = {}) {
  // Flush buffered entries so reads reflect everything logged so far.
  try {
    await flushAuditLog();
  } catch {
    // A flush failure is logged elsewhere; continue with what's on disk.
  }

  const now = new Date();
  const toDate = to || now.toISOString().slice(0, 10);
  const fromDate =
    from || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const auditDir = join(getRootDir(), 'contents', AUDIT_LOG_DIR);

  // Collect all matching JSONL files
  let files;
  try {
    files = await fs.readdir(auditDir);
  } catch {
    return { entries: [], total: 0 };
  }

  const jsonlFiles = files
    .filter(f => f.endsWith('.jsonl'))
    .filter(f => {
      const date = f.replace('.jsonl', '');
      return date >= fromDate && date <= toDate;
    })
    .sort()
    .reverse(); // newest first

  // Read and parse all entries
  const allEntries = [];
  for (const file of jsonlFiles) {
    try {
      const content = await fs.readFile(join(auditDir, file), 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          allEntries.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Sort newest first
  allEntries.sort((a, b) => b.ts.localeCompare(a.ts));

  // Apply filters. Entries written before the actor migration carry a legacy
  // `admin` string instead of `actor`, so match both when filtering by actor.
  let filtered = allEntries;
  if (actor) {
    filtered = filtered.filter(e => (e.actor?.username ?? e.admin) === actor);
  }
  if (resource) {
    filtered = filtered.filter(e => e.resource === resource);
  }
  if (action) {
    filtered = filtered.filter(e => e.action === action);
  }
  if (result) {
    filtered = filtered.filter(e => (e.result ?? 'success') === result);
  }
  if (source) {
    filtered = filtered.filter(e => e.source === source);
  }

  const total = filtered.length;
  const entries = filtered.slice(offset, offset + limit);

  return { entries, total };
}

/**
 * Delete audit log files older than `retentionDays`.
 *
 * A daily JSONL file is considered expired when its date is strictly older
 * than `today − retentionDays`. Pass a non-positive number to disable
 * cleanup. Returns the list of file names that were deleted so the scheduler
 * can log the result.
 *
 * @param {number} retentionDays
 * @returns {Promise<{deleted: string[], retainedFrom: string|null}>}
 */
export async function cleanupAuditLog(retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { deleted: [], retainedFrom: null };
  }

  const auditDir = join(getRootDir(), 'contents', AUDIT_LOG_DIR);
  let files;
  try {
    files = await fs.readdir(auditDir);
  } catch {
    return { deleted: [], retainedFrom: null };
  }

  const cutoffMs = Date.now() - retentionDays * DAY_MS;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);

  const deleted = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const date = file.replace('.jsonl', '');
    // String comparison on YYYY-MM-DD is sound because the format is lexicographic.
    if (date < cutoffDate) {
      try {
        await fs.unlink(join(auditDir, file));
        deleted.push(file);
      } catch (error) {
        logger.warn('Failed to delete audit log file', {
          component: 'AuditLogService',
          file,
          error: error.message
        });
      }
    }
  }

  return { deleted, retainedFrom: cutoffDate };
}

let cleanupInterval = null;
const CLEANUP_INTERVAL_MS = DAY_MS; // run once per day

/**
 * Start the audit-log cleanup scheduler.
 *
 * Reads `retentionDays` from the passed config (falls back to the default).
 * Runs once on startup, then daily. A non-positive `retentionDays` (or
 * `cleanupEnabled: false`) disables cleanup entirely.
 *
 * @param {{ retentionDays?: number, cleanupEnabled?: boolean }} [config]
 */
export function startAuditCleanupScheduler(config = {}) {
  if (cleanupInterval) return;
  const enabled = config.cleanupEnabled !== false;
  const retentionDays = enabled
    ? Number.isFinite(config.retentionDays)
      ? config.retentionDays
      : DEFAULT_RETENTION_DAYS
    : -1;

  const run = () => {
    cleanupAuditLog(retentionDays)
      .then(({ deleted, retainedFrom }) => {
        if (deleted.length > 0) {
          logger.info('Audit log cleanup removed expired files', {
            component: 'AuditLogService',
            removed: deleted.length,
            retainedFrom
          });
        }
      })
      .catch(error =>
        logger.error('Audit log cleanup failed', {
          component: 'AuditLogService',
          error: error.message
        })
      );
  };

  run();
  cleanupInterval = setInterval(run, CLEANUP_INTERVAL_MS);
}

export function stopAuditCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export function getAuditLogRetentionDefault() {
  return DEFAULT_RETENTION_DAYS;
}
