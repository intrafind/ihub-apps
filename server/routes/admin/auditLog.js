// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { nextOffsetCursor, offsetFromCursor } from '../../utils/pagination.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import {
  queryAuditLog,
  cleanupAuditLog,
  getAuditLogRetentionDefault,
  logAudit
} from '../../services/AuditLogService.js';
import { MAX_PAGE_SIZE, clampInt, isFlagSet, parseAuditLogQuery } from './auditLogQueryParams.js';
import { buildCsv } from '../../utils/csv.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';

// Accept the platform.json shape exactly: 'off' | 'mask' | 'drop'. Anything
// else is a 400 — we don't want the UI accidentally writing something the
// runtime would ignore.
const VALID_ANONYMIZE_IP = new Set(['off', 'mask', 'drop']);

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
    anonymizeIp: cfg.anonymizeIp ?? 'off'
  };
}

export default function registerAdminAuditLogRoutes(app) {
  /**
   * GET /api/admin/audit-log
   * Query audit log entries with optional filters and cursor pagination (`limit`, `cursor`).
   * Answers `{ items, nextCursor, total, facets? }`.
   *
   * Each of actor/resource/action/result/source accepts an include parameter
   * and a `<field>Exclude` parameter subtracted from it, with `*` meaning
   * "every value". `?q=` is a free-text search over the summary, resource id,
   * IP, request id and actor name. `?facets=1` additionally returns the value
   * counts per field over the date range, which is what the filter UI renders
   * its checkbox lists from.
   */
  app.get(buildServerPath('/api/admin/audit-log'), adminAuth, async (req, res) => {
    const filters = parseAuditLogQuery(req.query);

    const limit = clampInt(req.query.limit, 50, 1, MAX_PAGE_SIZE);
    const offset = offsetFromCursor(req.query.cursor);
    const { entries, total, facets } = await queryAuditLog({
      ...filters,
      facets: isFlagSet(req.query.facets),
      limit,
      offset
    });

    res.json({
      items: entries,
      nextCursor: nextOffsetCursor({ offset, limit, total }),
      total,
      ...(facets ? { facets } : {})
    });
  });

  /**
   * GET /api/admin/audit-log/export
   * Export audit log entries as CSV using the current filters.
   */
  app.get(buildServerPath('/api/admin/audit-log/export'), adminAuth, async (req, res) => {
    const filters = parseAuditLogQuery(req.query);

    // Cap the export so a wide date range can't build an unbounded CSV string
    // in memory. Admins can narrow the date range to export more granularly.
    const { entries, total } = await queryAuditLog({
      ...filters,
      limit: MAX_EXPORT_ROWS,
      offset: 0
    });
    if (total > MAX_EXPORT_ROWS) {
      res.setHeader('X-Audit-Export-Truncated', `${total - MAX_EXPORT_ROWS}`);
    }

    const headers = [
      'ts',
      'actor',
      'actorId',
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
      e.actor?.displayName ?? e.actor?.username ?? e.admin ?? '',
      e.actor?.id ?? '',
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
  });

  /**
   * GET /api/admin/audit-log/retention
   * Return the current audit-log retention policy (resolved from platform.json
   * with defaults filled in).
   */
  app.get(buildServerPath('/api/admin/audit-log/retention'), adminAuth, async (_req, res) => {
    res.json(getAuditSettings());
  });

  /**
   * POST /api/admin/audit-log/retention/_run
   * Manually trigger an audit log cleanup pass using the current retention.
   */
  app.post(buildServerPath('/api/admin/audit-log/retention/_run'), adminAuth, async (_req, res) => {
    const { retentionDays } = getAuditSettings();
    const result = await cleanupAuditLog(retentionDays);
    res.json({ ...result });
  });

  /**
   * GET /api/admin/audit-log/settings
   * Return the editable audit-log policy (retention + privacy). Combined into
   * a single read so the admin UI can prefill the form with one round-trip.
   */
  app.get(buildServerPath('/api/admin/audit-log/settings'), adminAuth, async (_req, res) => {
    res.json(getAuditSettings());
  });

  /**
   * PUT /api/admin/audit-log/settings
   * Update audit policy fields in platform.json. Currently scoped to the
   * `anonymizeIp` toggle; retention/email/verbosity continue to be edited
   * through the platform config form. Only fields explicitly provided in the
   * body are written — `undefined` keys leave the existing value alone.
   */
  app.put(buildServerPath('/api/admin/audit-log/settings'), adminAuth, async (req, res) => {
    const { anonymizeIp } = req.body || {};
    if (anonymizeIp !== undefined && !VALID_ANONYMIZE_IP.has(anonymizeIp)) {
      throw new ServiceError(
        'BAD_REQUEST',
        "Invalid anonymizeIp value; expected one of 'off' | 'mask' | 'drop'"
      );
    }

    await updatePlatform(platformConfig => {
      if (!platformConfig.audit) platformConfig.audit = {};
      if (anonymizeIp !== undefined) {
        platformConfig.audit.anonymizeIp = anonymizeIp;
      }
    });
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

    res.json(getAuditSettings());
  });
}
