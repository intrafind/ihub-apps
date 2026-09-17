import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { getAzureSpeechToken } from '../services/azureSpeechToken.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';

/**
 * User-facing voice / speech-to-text routes.
 *
 * `/api/voice/azure/token` brokers a short-lived Azure Speech authorization
 * token so the browser SDK never receives the subscription key. Requires
 * authentication; the key is read (decrypted) from platform.speech.azure.
 */
export default function registerVoiceRoutes(app) {
  app.get(buildServerPath('/api/voice/azure/token'), authRequired, async (req, res) => {
    try {
      const azure = (configCache.getPlatform() || {}).speech?.azure || {};
      if (!azure.enabled) {
        return res.status(503).json({ error: 'Azure Speech is not enabled' });
      }
      const result = await getAzureSpeechToken({
        subscriptionKey: azure.subscriptionKey, // decrypted by configCache on load
        region: azure.region
      });
      if (!result.ok) {
        return res.status(502).json({ error: result.error });
      }
      return res.json({ token: result.token, region: result.region });
    } catch (error) {
      logger.error('Failed to issue Azure Speech token', {
        component: 'VoiceRoutes',
        error: error.message
      });
      return res.status(500).json({ error: 'Failed to issue Azure Speech token' });
    }
  });
}
