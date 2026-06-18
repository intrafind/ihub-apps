import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import {
  queryAuditLog,
  cleanupAuditLog,
  getAuditLogRetentionDefault,
  logAudit
} from '../../services/AuditLogService.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';
import { buildCsv } from '../../utils/csv.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';

// Accept the platform.json shape exactly: false (off), true (mask),
// or one of 'off' | 'mask' | 'drop'. Anything else is a 400 — we don't
// want the UI accidentally writing something the runtime would ignore.
const VALID_ANONYMIZE_IP = new Set([false, true, 'off', 'mask', 'drop']);

function normalizeAnonymizeIp(value) {
  // Legacy aliases: treat `true` and `false` as their string equivalents so
  // the UI only has to deal with one shape.
  if (value === false) return 'off';
  if (value === true) return 'mask';
  return value;
}

// Upper bound on rows returned by the CSV export to keep memory bounded.
const MAX_EXPORT_ROWS = 100000;

function getAuditSettings() {
  const platform = configCache.getPlatform ? configCache.getPlatform() : {};
  const cfg = platform?.audit || {};
  return {
    retentionDays: Number.isFinite(cfg.retentionDays)
      ? cfg.retentionDays
      : getAuditLogRetentionDefault(),
    cleanupEnabled: cfg.cleanupEnabled !== false,
    anonymizeIp: normalizeAnonymizeIp(cfg.anonymizeIp ?? false)
  };
}

// Backward-compat alias — the retention badge in AdminAuditLogPage reads this.
const getRetentionSettings = getAuditSettings;

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

  /**
   * GET /api/admin/audit-log/settings
   * Return the editable audit-log policy (retention + privacy). Combined into
   * a single read so the admin UI can prefill the form with one round-trip.
   */
  app.get(buildServerPath('/api/admin/audit-log/settings'), adminAuth, async (_req, res) => {
    try {
      res.json(getAuditSettings());
    } catch (error) {
      return sendInternalError(res, error, 'read audit log settings');
    }
  });

  /**
   * PUT /api/admin/audit-log/settings
   * Update audit policy fields in platform.json. Currently scoped to the
   * `anonymizeIp` toggle; retention/email/verbosity continue to be edited
   * through the platform config form. Only fields explicitly provided in the
   * body are written — `undefined` keys leave the existing value alone.
   */
  app.put(buildServerPath('/api/admin/audit-log/settings'), adminAuth, async (req, res) => {
    try {
      const { anonymizeIp } = req.body || {};
      if (anonymizeIp !== undefined && !VALID_ANONYMIZE_IP.has(anonymizeIp)) {
        return sendBadRequest(
          res,
          "Invalid anonymizeIp value; expected one of 'off' | 'mask' | 'drop' (or boolean)"
        );
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const platformPath = join(rootDir, contentsDir, 'config', 'platform.json');

      const platformContent = await fs.readFile(platformPath, 'utf8');
      const platformConfig = JSON.parse(platformContent);

      if (!platformConfig.audit) platformConfig.audit = {};
      if (anonymizeIp !== undefined) {
        platformConfig.audit.anonymizeIp = anonymizeIp;
      }

      await atomicWriteJSON(platformPath, platformConfig);
      await configCache.refreshCacheEntry('config/platform.json');

      logAudit({
        req,
        action: 'update',
        resource: 'platform',
        resourceId: 'audit',
        summary: `audit.anonymizeIp -> ${anonymizeIp}`
      });
      logger.info('Audit log settings updated', {
        component: 'AdminAuditLog',
        anonymizeIp
      });

      res.json({ ok: true, settings: getAuditSettings() });
    } catch (error) {
      return sendInternalError(res, error, 'update audit log settings');
    }
  });
}
