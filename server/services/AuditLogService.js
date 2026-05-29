import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { getRootDir } from '../pathUtils.js';
import logger from '../utils/logger.js';

const AUDIT_LOG_DIR = 'data/audit-log';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 365;

/**
 * Log an admin action to the append-only audit log.
 * Each day gets its own JSONL file at contents/data/audit-log/YYYY-MM-DD.jsonl.
 *
 * @param {Object} options
 * @param {Object} options.req - Express request object
 * @param {string} options.action - 'create' | 'update' | 'delete' | 'toggle' | 'import' | 'export'
 * @param {string} options.resource - 'app' | 'group' | 'model' | 'prompt' | 'platform' | 'backup' | 'source' | 'feature' | 'provider'
 * @param {string} options.resourceId - ID of the affected resource
 * @param {string} options.summary - Human-readable summary of the action
 */
export async function logAdminAction({ req, action, resource, resourceId, summary }) {
  try {
    const entry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown',
      action,
      resource,
      resourceId: resourceId || '',
      summary,
      ip: req.ip
    };

    const date = entry.ts.slice(0, 10);
    const filePath = join(getRootDir(), 'contents', AUDIT_LOG_DIR, `${date}.jsonl`);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (error) {
    // Audit logging should never break the request
    logger.error('Failed to write audit log entry', {
      component: 'AuditLogService',
      action,
      resource,
      resourceId,
      error: error.message
    });
  }
}

/**
 * Query audit log entries with optional filters and pagination.
 *
 * @param {Object} options
 * @param {string} [options.from] - Start date (YYYY-MM-DD), defaults to 7 days ago
 * @param {string} [options.to] - End date (YYYY-MM-DD), defaults to today
 * @param {string} [options.admin] - Filter by admin username
 * @param {string} [options.resource] - Filter by resource type
 * @param {string} [options.action] - Filter by action type
 * @param {number} [options.limit=50] - Max entries to return
 * @param {number} [options.offset=0] - Number of entries to skip
 * @returns {Promise<{entries: Array, total: number}>}
 */
export async function queryAuditLog({
  from,
  to,
  admin,
  resource,
  action,
  limit = 50,
  offset = 0
} = {}) {
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

  // Apply filters
  let filtered = allEntries;
  if (admin) {
    filtered = filtered.filter(e => e.admin === admin);
  }
  if (resource) {
    filtered = filtered.filter(e => e.resource === resource);
  }
  if (action) {
    filtered = filtered.filter(e => e.action === action);
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
