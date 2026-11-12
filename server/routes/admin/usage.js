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
 *   GET  /api/admin/usage/calls              — request log: call records, filtered, paged
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
import { ServiceError } from '../../utils/ServiceError.js';
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
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
  clearUsageQueryCache
} from '../../services/usage/usageQuery.js';
import { readFeedbackPage } from '../../feedbackStorage.js';
import { queryCalls } from '../../services/usage/callLog.js';
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
    order: pick(query.order),
    user: pick(query.user),
    app: pick(query.app),
    model: pick(query.model),
    surface: pick(query.surface),
    outcome: pick(query.outcome),
    limit: pick(query.limit),
    cursor: pick(query.cursor)
  };
}

/** A GET handler for one usage query: 400 on a bad range, 500 otherwise. */
function queryRoute(query) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await query(rangeParams(req.query)));
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
    queryRoute(async params => ({
      ...(await getUsageSummary(params)),
      dataStart: await getDataStart()
    }))
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
  app.get(buildServerPath('/api/admin/usage/breakdown'), adminAuth, queryRoute(getUsageBreakdown));

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
    queryRoute(getUsageReliability)
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
    queryRoute(getFeedbackSummary)
  );

  /**
   * @swagger
   * /admin/usage/calls:
   *   get:
   *     summary: Request log — individual model calls, newest first
   *     description: |
   *       Call records of the range (metadata only: tokens, outcome, error code,
   *       latency, tool calls; never prompt or response text), filtered by user,
   *       app, model, surface and outcome. Page with `cursor` (`nextCursor` of the
   *       previous page). Kept for `usageTracking.eventRetentionDays`.
   *     tags: [Admin - Usage]
   *     parameters:
   *       - { in: query, name: range, schema: { type: string } }
   *       - { in: query, name: user, schema: { type: string } }
   *       - { in: query, name: app, schema: { type: string } }
   *       - { in: query, name: model, schema: { type: string } }
   *       - { in: query, name: surface, schema: { type: string, enum: [chat, agent, workflow, task, api, magic, system] } }
   *       - { in: query, name: outcome, schema: { type: string, enum: [ok, error, aborted, quota, rate_limited] } }
   *       - { in: query, name: limit, schema: { type: integer, maximum: 200 } }
   *       - { in: query, name: cursor, schema: { type: string } }
   *     responses:
   *       200: { description: "{ items, nextCursor }" }
   *       400: { description: Invalid parameters }
   */
  app.get(buildServerPath('/api/admin/usage/calls'), adminAuth, queryRoute(queryCalls));

  app.get(buildServerPath('/api/admin/usage/meta'), adminAuth, (req, res) => {
    res.json({ trackingMode: getUsageTrackingMode() });
  });

  app.put(buildServerPath('/api/admin/usage/meta'), adminAuth, async (req, res) => {
    const { trackingMode } = req.body || {};
    const validModes = ['anonymous', 'pseudonymous', 'identified'];
    if (!validModes.includes(trackingMode)) {
      throw new ServiceError(
        'BAD_REQUEST',
        `Invalid tracking mode. Must be one of: ${validModes.join(', ')}`
      );
    }
    // Only a missing platform.json starts fresh. One that exists but cannot be
    // read or parsed makes `updateJson` throw: readJson cannot tell that from
    // "missing", and writing a file built from `{}` over it would wipe every
    // other platform setting on a transient read error.
    await configStore.updateJson('config/platform.json', current => {
      const platform = current && typeof current === 'object' ? current : {};
      platform.features = { ...(platform.features || {}), usageTrackingMode: trackingMode };
      return platform;
    });
    await configCache.refreshCacheEntry('config/platform.json');
    res.json({ trackingMode });
  });

  // Roll up now (normally hourly). `?all=1` rebuilds every day.
  app.post(buildServerPath('/api/admin/usage/_rollup'), adminAuth, async (req, res) => {
    const retention = configCache.getPlatform?.()?.usageTracking || {};
    const stats = await runRollups(retention, { all: req.query.all === '1' });
    clearUsageQueryCache();
    res.json({ ...stats });
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
    resolved = resolveRange(rangeParams(req.query));
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
      // Part of the body is on the wire: all that is left is to end the response.
      if (res.headersSent) return res.end();
      throw error;
    }
  });

  // Stored feedback entries (with comments), newest first, one page at a time.
  app.get(buildServerPath('/api/admin/usage/feedback'), adminAuth, async (req, res) => {
    res.json(await readFeedbackPage({ limit: req.query.limit, cursor: req.query.cursor }));
  });
}
