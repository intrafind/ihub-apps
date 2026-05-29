import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { getRootDir } from '../pathUtils.js';
import logger from '../utils/logger.js';

const AUDIT_LOG_DIR = 'data/audit-log';

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
