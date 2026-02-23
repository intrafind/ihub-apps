import { logNewSession } from '../utils.js';
import { authOptional } from '../middleware/authRequired.js';
import validate from '../validators/validate.js';
import { startSessionSchema } from '../validators/index.js';
import { buildServerPath } from '../utils/basePath.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

export default function registerSessionRoutes(app) {
  app.post(
    buildServerPath('/api/session/start'),
    authOptional,
    validate(startSessionSchema),
    async (req, res) => {
      try {
        const { sessionId, type, metadata } = req.body;
        if (!sessionId) {
          return res.status(400).json({ error: 'Session ID is required' });
        }
        const enrichedMetadata = {
          ...metadata,
          userAgent: req.headers['user-agent'] || metadata?.userAgent || 'unknown',
          ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
          language:
            req.headers['accept-language'] ||
            metadata?.language ||
            configCache.getPlatform()?.defaultLanguage ||
            'en',
          referrer: req.headers['referer'] || metadata?.referrer || 'direct'
        };
        logger.info(
          `[APP LOADED] New session started: ${sessionId} | IP: ${enrichedMetadata.ipAddress.split(':').pop()}`
        );
        await logNewSession(sessionId, type || 'app_loaded', enrichedMetadata);
        res.status(200).json({ success: true });
      } catch (error) {
        logger.error('Error logging session start:', error);
        res.status(500).json({ error: 'Failed to log session start' });
      }
    }
  );
}
