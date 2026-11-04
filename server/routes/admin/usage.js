// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin usage reporting, all over one pipeline (daily rollups plus a live
 * "today"; services/usage/usageQuery.js) and one range selector:
 *
 *   GET  /api/admin/usage/summary            — KPIs vs previous period, series, top models/apps
 *   GET  /api/admin/usage/breakdown          — rows per user|group|app|model|provider|surface
 *   GET  /api/admin/usage/reliability        — errors over time, by code/provider, latency
 *   GET  /api/admin/usage/feedback/summary   — ratings per user/app/model
 *   GET  /api/admin/usage/export             — raw call records (CSV or JSON)
 *   GET  /api/admin/usage/feedback           — stored feedback entries, newest first
 *   GET/PUT /api/admin/usage/meta            — tracking mode
 *   POST /api/admin/usage/_rollup            — roll up now
 *
 * Range params everywhere: `range` = today|24h|7d|30d|90d|12m|custom, with
 * `from`/`to` (`YYYY-MM-DD`, inclusive) for custom.
 */
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { reloadConfig } from '../../usageTracker.js';
import { runRollups } from '../../services/UsageAggregator.js';
import { readDayEvents, flushQueue } from '../../services/UsageEventLog.js';
import { getUsageTrackingMode } from '../../services/usage/usageRecorder.js';
import {
  resolveRange,
  getUsageSummary,
  getUsageBreakdown,
  getUsageReliability,
  getFeedbackSummary,
  getDataStart,
  clearUsageQueryCache,
  UsageQueryError
} from '../../services/usage/usageQuery.js';
import { readFeedbackPage } from '../../feedbackStorage.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';
import { escapeCsvField } from '../../utils/csv.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function rangeParams(query) {
  const pick = v => (typeof v === 'string' ? v : undefined);
  return {
    range: pick(query.range) || '7d',
    from: pick(query.from),
    to: pick(query.to),
    dimension: pick(query.dimension),
    sort: pick(query.sort),
    order: pick(query.order)
  };
}

/** A GET handler for one usage query: 400 on a bad range, 500 otherwise. */
function queryRoute(query, label) {
  return async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await query(rangeParams(req.query)));
    } catch (error) {
      if (error instanceof UsageQueryError) return sendBadRequest(res, error.message);
      return sendInternalError(res, error, label);
    }
  };
}

const CSV_COLUMNS = [
  ['timestamp', e => e.ts],
  ['type', e => e.type],
  ['surface', e => e.surf],
  ['userId', e => e.uid],
  ['groups', e => (e.grp || []).join(' ')],
  ['app', e => e.app],
  ['model', e => e.model],
  ['provider', e => e.prov],
  ['conversationId', e => e.cid],
  ['requestId', e => e.rid],
  ['outcome', e => e.st],
  ['errorCode', e => e.err],
  ['promptTokens', e => e.pt],
  ['completionTokens', e => e.ct],
  ['cacheReadTokens', e => e.cr],
  ['cacheWriteTokens', e => e.cw],
  ['reasoningTokens', e => e.rt],
  ['webSearchRequests', e => e.ws],
  ['tokenSource', e => e.src],
  ['latencyMs', e => e.lat],
  ['ttftMs', e => e.ttft],
  ['toolCalls', e => e.tc],
  ['rating', e => e.rating]
];

function csvRow(event) {
  return CSV_COLUMNS.map(([, get]) => {
    const value = get(event);
    if (value === undefined || value === null) return '';
    return typeof value === 'number' ? String(value) : escapeCsvField(String(value));
  }).join(',');
}

export default function registerAdminUsageRoutes(app) {
  /**
   * @swagger
   * /admin/usage/summary:
   *   get:
   *     summary: Usage KPIs, time series and top models/apps for a range
   *     description: |
   *       Requests, tokens by kind, error rate, latency p50/p95 and active users for the
   *       range and for the previous period of equal length, the series (hourly for
   *       today/24h, daily otherwise), and the top five models and apps by tokens.
   *     tags: [Admin - Usage]
   *     parameters:
   *       - { in: query, name: range, schema: { type: string, enum: [today, 24h, 7d, 30d, 90d, 12m, custom] } }
   *       - { in: query, name: from, schema: { type: string, format: date } }
   *       - { in: query, name: to, schema: { type: string, format: date } }
   *     responses:
   *       200: { description: Summary }
   *       400: { description: Invalid range }
   */
  app.get(
    buildServerPath('/api/admin/usage/summary'),
    adminAuth,
    queryRoute(
      async params => ({ ...(await getUsageSummary(params)), dataStart: await getDataStart() }),
      'load usage summary'
    )
  );

  /**
   * @swagger
   * /admin/usage/breakdown:
   *   get:
   *     summary: Usage per user, group, app, model, provider or surface
   *     tags: [Admin - Usage]
   *     parameters:
   *       - { in: query, name: dimension, schema: { type: string, enum: [user, group, app, model, provider, surface] } }
   *       - { in: query, name: sort, schema: { type: string } }
   *       - { in: query, name: order, schema: { type: string, enum: [asc, desc] } }
   *       - { in: query, name: range, schema: { type: string } }
   *     responses:
   *       200: { description: Rows with per-model sub-rows }
   *       400: { description: Invalid parameters }
   */
  app.get(
    buildServerPath('/api/admin/usage/breakdown'),
    adminAuth,
    queryRoute(getUsageBreakdown, 'load usage breakdown')
  );

  /**
   * @swagger
   * /admin/usage/reliability:
   *   get:
   *     summary: Error rate over time, errors by code and provider, latency per model
   *     tags: [Admin - Usage]
   *     responses:
   *       200: { description: Reliability figures }
   */
  app.get(
    buildServerPath('/api/admin/usage/reliability'),
    adminAuth,
    queryRoute(getUsageReliability, 'load usage reliability')
  );

  /**
   * @swagger
   * /admin/usage/feedback/summary:
   *   get:
   *     summary: Feedback ratings in a range, in total and per user, app and model
   *     tags: [Admin - Usage]
   *     responses:
   *       200: { description: Ratings }
   */
  app.get(
    buildServerPath('/api/admin/usage/feedback/summary'),
    adminAuth,
    queryRoute(getFeedbackSummary, 'load feedback summary')
  );

  app.get(buildServerPath('/api/admin/usage/meta'), adminAuth, (req, res) => {
    res.json({ trackingMode: getUsageTrackingMode() });
  });

  app.put(buildServerPath('/api/admin/usage/meta'), adminAuth, async (req, res) => {
    try {
      const { trackingMode } = req.body || {};
      const validModes = ['anonymous', 'pseudonymous', 'identified'];
      if (!validModes.includes(trackingMode)) {
        return sendBadRequest(
          res,
          `Invalid tracking mode. Must be one of: ${validModes.join(', ')}`
        );
      }
      // An unreadable platform.json starts fresh here, as it always has: the
      // tracking mode is a single flag and refusing to set it would strand the
      // admin with no way to turn tracking off.
      const platform = (await configStore.readJson('config/platform.json')) || {};
      if (!platform.features) platform.features = {};
      platform.features.usageTrackingMode = trackingMode;
      await configStore.writeJson('config/platform.json', platform);
      await configCache.refreshCacheEntry('config/platform.json');
      reloadConfig();
      res.json({ trackingMode, message: 'Tracking mode updated successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'update tracking mode');
    }
  });

  // Roll up now (normally hourly). `?all=1` rebuilds every day.
  app.post(buildServerPath('/api/admin/usage/_rollup'), adminAuth, async (req, res) => {
    try {
      const retention = configCache.getPlatform?.()?.usageTracking || {};
      const stats = await runRollups(retention, { all: req.query.all === '1' });
      clearUsageQueryCache();
      res.json({ message: 'Rollup generation completed successfully', ...stats });
    } catch (error) {
      return sendInternalError(res, error, 'generate rollups');
    }
  });

  /**
   * @swagger
   * /admin/usage/export:
   *   get:
   *     summary: Raw usage records of a range (call records and feedback)
   *     description: Metadata only — tokens, outcome, timing; never prompt or response text.
   *     tags: [Admin - Usage]
   *     parameters:
   *       - { in: query, name: format, schema: { type: string, enum: [csv, json] } }
   *       - { in: query, name: range, schema: { type: string } }
   *     responses:
   *       200: { description: Records }
   *       400: { description: Invalid range }
   */
  app.get(buildServerPath('/api/admin/usage/export'), adminAuth, async (req, res) => {
    let resolved;
    try {
      resolved = resolveRange(rangeParams(req.query));
    } catch (error) {
      if (error instanceof UsageQueryError) return sendBadRequest(res, error.message);
      return sendInternalError(res, error, 'export usage data');
    }
    try {
      await flushQueue().catch(() => {});
      const fromIso = new Date(resolved.from).toISOString();
      const toIso = new Date(resolved.to).toISOString();
      const days = [];
      for (let t = Date.parse(fromIso.slice(0, 10)); t <= resolved.to; t += DAY_MS) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      const csv = req.query.format === 'csv';
      const name = `usage-export-${fromIso.slice(0, 10)}_${toIso.slice(0, 10)}`;
      res.setHeader('Cache-Control', 'no-store');
      if (csv) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${name}.csv`);
        res.write(`${CSV_COLUMNS.map(([h]) => h).join(',')}\n`);
      } else {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.write(
          `{"range":${JSON.stringify(resolved.range)},"from":"${fromIso}","to":"${toIso}","events":[`
        );
      }
      let first = true;
      for (const day of days) {
        const events = (await readDayEvents(day)).filter(e => e.ts >= fromIso && e.ts <= toIso);
        if (!events.length) continue;
        if (csv) {
          res.write(`${events.map(csvRow).join('\n')}\n`);
        } else {
          res.write((first ? '' : ',') + events.map(e => JSON.stringify(e)).join(','));
          first = false;
        }
      }
      if (!csv) res.write(']}');
      res.end();
    } catch (error) {
      if (res.headersSent) return res.end();
      return sendInternalError(res, error, 'export usage data');
    }
  });

  // Stored feedback entries (with comments), newest first, one page at a time.
  app.get(buildServerPath('/api/admin/usage/feedback'), adminAuth, async (req, res) => {
    try {
      res.json(await readFeedbackPage({ limit: req.query.limit, offset: req.query.offset }));
    } catch (error) {
      return sendInternalError(res, error, 'load feedback entries');
    }
  });
}
