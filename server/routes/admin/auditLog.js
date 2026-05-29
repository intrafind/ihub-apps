import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import {
  queryAuditLog,
  cleanupAuditLog,
  getAuditLogRetentionDefault
} from '../../services/AuditLogService.js';
import { sendInternalError } from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';

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
      const { from, to, admin, resource, action, limit, offset } = req.query;

      const result = await queryAuditLog({
        from,
        to,
        admin,
        resource,
        action,
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0
      });

      res.json(result);
    } catch (error) {
      return sendInternalError(res, error, 'query audit log');
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
