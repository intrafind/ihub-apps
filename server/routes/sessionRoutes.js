import { logNewSession } from '../utils.js';
import validate from '../validators/validate.js';
import { startSessionSchema } from '../validators/index.js';

export default function registerSessionRoutes(app) {
  app.post('/api/session/start', validate(startSessionSchema), async(req, res) => {
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
      console.log(
        `[APP LOADED] New session started: ${sessionId} | IP: ${enrichedMetadata.ipAddress.split(':').pop()}`
      );
      await logNewSession(sessionId, type || 'app_loaded', enrichedMetadata);
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error logging session start:', error);
      res.status(500).json({ error: 'Failed to log session start' });
    }
  });
}
