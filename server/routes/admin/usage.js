import { promises as fs } from 'fs';
import { join } from 'path';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { getTrackingMode, reloadConfig } from '../../usageTracker.js';
import { getDailyRollups, getMonthlyRollups, runRollups } from '../../services/UsageAggregator.js';
import { readEvents } from '../../services/UsageEventLog.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';

function parseRange(range) {
  if (!range) return { startDate: null, endDate: null, granularity: 'daily' };
  const now = new Date();
  const endDate = now.toISOString().substring(0, 10);

  const match = range.match(/^(\d+)(d|m)$/);
  if (!match) return { startDate: null, endDate, granularity: 'daily' };

  const num = parseInt(match[1]);
  const unit = match[2];

  if (unit === 'd') {
    const start = new Date(now);
    start.setDate(start.getDate() - num);
    return { startDate: start.toISOString().substring(0, 10), endDate, granularity: 'daily' };
  } else {
    const start = new Date(now);
    start.setMonth(start.getMonth() - num);
    return {
      startDate: start.toISOString().substring(0, 10),
      endDate,
      startMonth: start.toISOString().substring(0, 7),
      endMonth: now.toISOString().substring(0, 7),
      granularity: 'monthly'
    };
  }
}

function escapeCsvField(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default function registerAdminUsageRoutes(app) {
  // Timeline endpoint - daily or monthly aggregations
  app.get(buildServerPath('/api/admin/usage/timeline'), adminAuth, async (req, res) => {
    try {
      const { range = '30d', granularity: overrideGranularity } = req.query;
      const parsed = parseRange(range);
      const granularity = overrideGranularity || parsed.granularity;

      let data;
      if (granularity === 'monthly') {
        data = await getMonthlyRollups(parsed.startMonth, parsed.endMonth);
      } else {
        data = await getDailyRollups(parsed.startDate, parsed.endDate);
      }

      res.json({ granularity, range, data });
    } catch (e) {
      return sendInternalError(res, e, 'load usage timeline');
    }
  });

  // Per-user breakdown over time
  app.get(buildServerPath('/api/admin/usage/users'), adminAuth, async (req, res) => {
    try {
      const { range = '30d' } = req.query;
      const parsed = parseRange(range);
      const rollups = await getDailyRollups(parsed.startDate, parsed.endDate);

      const users = {};
      for (const rollup of rollups) {
        for (const [uid, data] of Object.entries(rollup.byUser || {})) {
          if (!users[uid])
            users[uid] = { messages: 0, promptTokens: 0, completionTokens: 0, days: 0 };
          users[uid].messages += data.messages;
          users[uid].promptTokens += data.promptTokens;
          users[uid].completionTokens += data.completionTokens;
          users[uid].days += 1;
        }
      }

      res.json({ range, users });
    } catch (e) {
      return sendInternalError(res, e, 'load usage user data');
    }
  });

  // Per-app breakdown over time
  app.get(buildServerPath('/api/admin/usage/apps'), adminAuth, async (req, res) => {
    try {
      const { range = '30d' } = req.query;
      const parsed = parseRange(range);
      const rollups = await getDailyRollups(parsed.startDate, parsed.endDate);

      const apps = {};
      for (const rollup of rollups) {
        for (const [appId, data] of Object.entries(rollup.byApp || {})) {
          if (!apps[appId]) apps[appId] = { messages: 0, promptTokens: 0, completionTokens: 0 };
          apps[appId].messages += data.messages;
          apps[appId].promptTokens += data.promptTokens;
          apps[appId].completionTokens += data.completionTokens;
        }
      }

      res.json({ range, apps });
    } catch (e) {
      return sendInternalError(res, e, 'load usage app data');
    }
  });

  // Per-model breakdown over time
  app.get(buildServerPath('/api/admin/usage/models'), adminAuth, async (req, res) => {
    try {
      const { range = '30d' } = req.query;
      const parsed = parseRange(range);
      const rollups = await getDailyRollups(parsed.startDate, parsed.endDate);

      const models = {};
      for (const rollup of rollups) {
        for (const [modelId, data] of Object.entries(rollup.byModel || {})) {
          if (!models[modelId])
            models[modelId] = { messages: 0, promptTokens: 0, completionTokens: 0 };
          models[modelId].messages += data.messages;
          models[modelId].promptTokens += data.promptTokens;
          models[modelId].completionTokens += data.completionTokens;
        }
      }

      res.json({ range, models });
    } catch (e) {
      return sendInternalError(res, e, 'load usage model data');
    }
  });

  // Tracking metadata endpoint - GET
  app.get(buildServerPath('/api/admin/usage/meta'), adminAuth, async (req, res) => {
    try {
      const mode = await getTrackingMode();
      res.json({ trackingMode: mode });
    } catch (e) {
      return sendInternalError(res, e, 'load usage metadata');
    }
  });

  // Tracking metadata endpoint - PUT (update tracking mode)
  app.put(buildServerPath('/api/admin/usage/meta'), adminAuth, async (req, res) => {
    try {
      const { trackingMode } = req.body;
      const validModes = ['anonymous', 'pseudonymous', 'identified'];
      if (!validModes.includes(trackingMode)) {
        return sendBadRequest(
          res,
          `Invalid tracking mode. Must be one of: ${validModes.join(', ')}`
        );
      }

      const rootDir = getRootDir();
      const platformPath = join(rootDir, 'contents', 'config', 'platform.json');
      let platform = {};
      try {
        const data = await fs.readFile(platformPath, 'utf8');
        platform = JSON.parse(data);
      } catch {
        // Start fresh if file doesn't exist
      }

      if (!platform.features) platform.features = {};
      platform.features.usageTrackingMode = trackingMode;
      await atomicWriteJSON(platformPath, platform);
      await configCache.refreshCacheEntry('config/platform.json');
      reloadConfig();

      res.json({ trackingMode, message: 'Tracking mode updated successfully' });
    } catch (e) {
      return sendInternalError(res, e, 'update tracking mode');
    }
  });

  // On-demand rollup generation
  app.post(buildServerPath('/api/admin/usage/_rollup'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform ? configCache.getPlatform() : {};
      const retentionConfig = platform?.usageTracking || {};
      const stats = await runRollups(retentionConfig);
      res.json({ message: 'Rollup generation completed successfully', ...stats });
    } catch (e) {
      return sendInternalError(res, e, 'generate rollups');
    }
  });

  // GET alias for rollup trigger (convenience)
  app.get(buildServerPath('/api/admin/usage/_rollup'), adminAuth, (req, res, next) => {
    req.method = 'POST';
    app._router.handle(req, res, next);
  });

  // Export endpoint
  app.get(buildServerPath('/api/admin/usage/export'), adminAuth, async (req, res) => {
    try {
      const { range = '90d', format = 'json' } = req.query;
      const parsed = parseRange(range);
      const events = await readEvents({
        startDate: parsed.startDate,
        endDate: parsed.endDate
      });

      if (format === 'csv') {
        const headers =
          'timestamp,type,userId,app,model,promptTokens,completionTokens,tokenSource\n';
        const rows = events
          .map(e =>
            [
              escapeCsvField(e.ts),
              escapeCsvField(e.type),
              escapeCsvField(e.uid),
              escapeCsvField(e.app),
              escapeCsvField(e.model),
              e.pt || 0,
              e.ct || 0,
              escapeCsvField(e.src || 'estimate')
            ].join(',')
          )
          .join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=usage-export.csv');
        res.send(headers + rows);
      } else {
        res.json({ range, events });
      }
    } catch (e) {
      return sendInternalError(res, e, 'export usage data');
    }
  });
}
