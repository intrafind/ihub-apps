import { promises as fs } from 'fs';
import { join } from 'path';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getRootDir } from '../../pathUtils.js';
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import config from '../../config.js';
import { getTrackingMode, reloadConfig } from '../../usageTracker.js';
import {
  getDailyRollups,
  getMonthlyRollups,
  runRollups,
  sumRollupDimension
} from '../../services/UsageAggregator.js';
import { readEvents } from '../../services/UsageEventLog.js';
import { sendInternalError, sendBadRequest } from '../../utils/responseHelpers.js';
import { escapeCsvField } from '../../utils/csv.js';

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
    } catch (error) {
      return sendInternalError(res, error, 'load usage timeline');
    }
  });

  // Per-user breakdown over time
  app.get(buildServerPath('/api/admin/usage/users'), adminAuth, async (req, res) => {
    try {
      const { range = '30d' } = req.query;
      const parsed = parseRange(range);
      const rollups = await getDailyRollups(parsed.startDate, parsed.endDate);
      const users = sumRollupDimension(rollups, 'byUser', { countDays: true });
      res.json({ range, users });
    } catch (error) {
      return sendInternalError(res, error, 'load usage user data');
    }
  });

  // Per-app breakdown over time
  app.get(buildServerPath('/api/admin/usage/apps'), adminAuth, async (req, res) => {
    try {
      const { range = '30d' } = req.query;
      const parsed = parseRange(range);
      const rollups = await getDailyRollups(parsed.startDate, parsed.endDate);
      const apps = sumRollupDimension(rollups, 'byApp');
      res.json({ range, apps });
    } catch (error) {
      return sendInternalError(res, error, 'load usage app data');
    }
  });

  // Per-model breakdown over time
  app.get(buildServerPath('/api/admin/usage/models'), adminAuth, async (req, res) => {
    try {
      const { range = '30d' } = req.query;
      const parsed = parseRange(range);
      const rollups = await getDailyRollups(parsed.startDate, parsed.endDate);
      const models = sumRollupDimension(rollups, 'byModel');
      res.json({ range, models });
    } catch (error) {
      return sendInternalError(res, error, 'load usage model data');
    }
  });

  // Per-provider (adapter) breakdown over time. Only events recorded since the
  // provider was tracked carry one.
  app.get(buildServerPath('/api/admin/usage/providers'), adminAuth, async (req, res) => {
    try {
      const { range = '30d' } = req.query;
      const parsed = parseRange(range);
      const rollups = await getDailyRollups(parsed.startDate, parsed.endDate);
      const providers = sumRollupDimension(rollups, 'byProvider');
      res.json({ range, providers });
    } catch (error) {
      return sendInternalError(res, error, 'load usage provider data');
    }
  });

  // Tracking metadata endpoint - GET
  app.get(buildServerPath('/api/admin/usage/meta'), adminAuth, async (req, res) => {
    try {
      const mode = await getTrackingMode();
      res.json({ trackingMode: mode });
    } catch (error) {
      return sendInternalError(res, error, 'load usage metadata');
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

  // On-demand rollup generation
  app.post(buildServerPath('/api/admin/usage/_rollup'), adminAuth, async (req, res) => {
    try {
      const platform = configCache.getPlatform ? configCache.getPlatform() : {};
      const retentionConfig = platform?.usageTracking || {};
      const stats = await runRollups(retentionConfig);
      res.json({ message: 'Rollup generation completed successfully', ...stats });
    } catch (error) {
      return sendInternalError(res, error, 'generate rollups');
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
        // New columns are appended so scripts reading the export by position
        // keep working. The optional counters stay empty when the provider did
        // not report them, so "not reported" and "zero" stay apart.
        const optional = value => (Number.isFinite(value) ? value : '');
        const headers =
          'timestamp,type,userId,app,model,promptTokens,completionTokens,tokenSource,' +
          'provider,cacheReadTokens,cacheWriteTokens,reasoningTokens,webSearchRequests\n';
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
              escapeCsvField(e.src || 'estimate'),
              escapeCsvField(e.prov || ''),
              optional(e.cr),
              optional(e.cw),
              optional(e.rt),
              optional(e.ws)
            ].join(',')
          )
          .join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=usage-export.csv');
        res.send(headers + rows);
      } else {
        res.json({ range, events });
      }
    } catch (error) {
      return sendInternalError(res, error, 'export usage data');
    }
  });

  // Feedback entries endpoint - returns individual feedback with comments
  app.get(buildServerPath('/api/admin/usage/feedback'), adminAuth, async (req, res) => {
    try {
      const { limit = 100, offset = 0 } = req.query;
      const limitNum = parseInt(limit, 10);
      const offsetNum = parseInt(offset, 10);

      const rootDir = getRootDir();
      const contentsDir = config.CONTENTS_DIR;
      const feedbackFile = join(rootDir, contentsDir, 'data', 'feedback.jsonl');

      // Check if feedback file exists
      try {
        await fs.access(feedbackFile);
      } catch {
        // File doesn't exist yet
        return res.json({ feedbackEntries: [], total: 0, limit: limitNum, offset: offsetNum });
      }

      // Read the feedback.jsonl file
      const content = await fs.readFile(feedbackFile, 'utf8');
      const lines = content
        .trim()
        .split('\n')
        .filter(line => line.trim());

      // Parse all feedback entries
      const allEntries = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          allEntries.push(entry);
        } catch (e) {
          // Skip malformed lines
          continue;
        }
      }

      // Sort by timestamp (newest first)
      allEntries.sort((a, b) => {
        const dateA = new Date(a.timestamp || 0);
        const dateB = new Date(b.timestamp || 0);
        return dateB - dateA;
      });

      // Apply pagination
      const paginatedEntries = allEntries.slice(offsetNum, offsetNum + limitNum);

      res.json({
        feedbackEntries: paginatedEntries,
        total: allEntries.length,
        limit: limitNum,
        offset: offsetNum
      });
    } catch (error) {
      return sendInternalError(res, error, 'load feedback entries');
    }
  });
}
