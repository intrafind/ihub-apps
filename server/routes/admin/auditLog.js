import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { queryAuditLog } from '../../services/AuditLogService.js';
import { sendInternalError } from '../../utils/responseHelpers.js';

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
}
