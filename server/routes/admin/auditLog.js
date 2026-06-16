import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import {
  queryAuditLog,
  cleanupAuditLog,
  getAuditLogRetentionDefault
} from '../../services/AuditLogService.js';
import { sendInternalError } from '../../utils/responseHelpers.js';
import { buildCsv } from '../../utils/csv.js';
import configCache from '../../configCache.js';

// Upper bound on rows returned by the CSV export to keep memory bounded.
const MAX_EXPORT_ROWS = 100000;

function getRetentionSettings() {
  const platform = configCache.getPlatform ? configCache.getPlatform() : {};
  const cfg = platform?.auditLog || {};
  return {
    retentionDays: Number.isFinite(cfg.retentionDays)
      ? cfg.retentionDays
      : getAuditLogRetentionDefault(),
    cleanupEnabled: cfg.cleanupEnabled !== false
  };
}

export default function registerAdminAuditLogRoutes(app) {
  /**
   * GET /api/admin/audit-log
   * Query audit log entries with optional filters and pagination.
   */
  app.get(buildServerPath('/api/admin/audit-log'), adminAuth, async (req, res) => {
    try {
      const {
        from,
        to,
        actor,
        resource,
        action,
        result: outcome,
        source,
        limit,
        offset
      } = req.query;

      const result = await queryAuditLog({
        from,
        to,
        actor,
        resource,
        action,
        result: outcome,
        source,
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0
      });

      res.json(result);
    } catch (error) {
      return sendInternalError(res, error, 'query audit log');
    }
  });

  /**
   * GET /api/admin/audit-log/export
   * Export audit log entries as CSV using the current filters.
   */
  app.get(buildServerPath('/api/admin/audit-log/export'), adminAuth, async (req, res) => {
    try {
      const { from, to, actor, resource, action, result: outcome, source } = req.query;

      // Cap the export so a wide date range can't build an unbounded CSV string
      // in memory. Admins can narrow the date range to export more granularly.
      const { entries, total } = await queryAuditLog({
        from,
        to,
        actor,
        resource,
        action,
        result: outcome,
        source,
        limit: MAX_EXPORT_ROWS,
        offset: 0
      });
      if (total > MAX_EXPORT_ROWS) {
        res.setHeader('X-Audit-Export-Truncated', `${total - MAX_EXPORT_ROWS}`);
      }

      const headers = [
        'ts',
        'actor',
        'authenticated',
        'action',
        'resource',
        'resourceId',
        'result',
        'source',
        'ip',
        'requestId',
        'summary'
      ];
      const rows = entries.map(e => [
        e.ts,
        e.actor?.username ?? e.admin ?? '',
        e.actor?.authenticated ?? '',
        e.action,
        e.resource,
        e.resourceId,
        e.result ?? 'success',
        e.source ?? '',
        e.ip ?? '',
        e.requestId ?? '',
        e.summary ?? ''
      ]);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
      res.send(buildCsv(headers, rows));
    } catch (error) {
      return sendInternalError(res, error, 'export audit log');
    }
  });

  /**
   * GET /api/admin/audit-log/retention
   * Return the current audit-log retention policy (resolved from platform.json
   * with defaults filled in).
   */
  app.get(buildServerPath('/api/admin/audit-log/retention'), adminAuth, async (_req, res) => {
    try {
      res.json(getRetentionSettings());
    } catch (error) {
      return sendInternalError(res, error, 'read audit log retention');
    }
  });

  /**
   * POST /api/admin/audit-log/retention/run
   * Manually trigger an audit log cleanup pass using the current retention.
   */
  app.post(buildServerPath('/api/admin/audit-log/retention/run'), adminAuth, async (_req, res) => {
    try {
      const { retentionDays } = getRetentionSettings();
      const result = await cleanupAuditLog(retentionDays);
      res.json({ ok: true, ...result });
    } catch (error) {
      return sendInternalError(res, error, 'run audit log cleanup');
    }
  });
}
