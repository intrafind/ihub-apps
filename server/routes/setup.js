import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';
import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';

// LLM providers that require API keys
const LLM_PROVIDER_IDS = ['openai', 'anthropic', 'google', 'mistral'];

/**
 * Check if at least one LLM provider API key is configured.
 * Checks both stored (encrypted) keys in providers.json and environment variables.
 */
async function isConfigured() {
  // Check providers config for stored API keys
  try {
    const { data: providers } = configCache.getProviders(true);
    const hasStoredKey = providers.filter(p => LLM_PROVIDER_IDS.includes(p.id)).some(p => p.apiKey);
    if (hasStoredKey) {
      return true;
    }
  } catch {
    // Fall through to env var check
  }

  // Check environment variables
  for (const providerId of LLM_PROVIDER_IDS) {
    const envVar = `${providerId.toUpperCase()}_API_KEY`;
    if (process.env[envVar]) {
      return true;
    }
  }

  return false;
}

export default function registerSetupRoutes(app) {
  /**
   * GET /api/setup/status
   * Returns whether at least one LLM provider has an API key configured.
   * Public endpoint — no authentication required.
   */
  app.get(buildServerPath('/api/setup/status'), async (req, res) => {
    try {
      const configured = await isConfigured();
      res.json({ configured });
    } catch (error) {
      logger.error('Error checking setup status:', { component: 'Setup', error });
      res.status(500).json({ error: 'Failed to check setup status' });
    }
  });

  /**
   * POST /api/setup/configure
   * Saves the first API key for a provider.
   * Only accessible when the system is unconfigured.
   */
  app.post(buildServerPath('/api/setup/configure'), async (req, res) => {
    try {
      // Only allow when not yet configured — prevents unauthorized key overwrite
      const configured = await isConfigured();
      if (configured) {
        return res.status(403).json({
          error: 'System is already configured. Use Admin › Providers to manage API keys.'
        });
      }

      const { providerId, apiKey } = req.body;

      if (!providerId || !apiKey) {
        return res.status(400).json({ error: 'providerId and apiKey are required' });
      }
      if (!LLM_PROVIDER_IDS.includes(providerId)) {
        return res.status(400).json({ error: 'Invalid provider ID' });
      }
      if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        return res.status(400).json({ error: 'API key must be a non-empty string' });
      }

      const trimmedKey = apiKey.trim();
      const encryptedKey = tokenStorageService.encryptString(trimmedKey);

      // Deep-copy providers from cache to avoid mutating cached data
      const { data: cachedProviders } = configCache.getProviders(true);
      const providers = cachedProviders.map(p => ({ ...p }));

      const providerIndex = providers.findIndex(p => p.id === providerId);
      if (providerIndex === -1) {
        return res.status(404).json({ error: 'Provider not found' });
      }

      providers[providerIndex] = {
        ...providers[providerIndex],
        apiKey: encryptedKey,
        enabled: true
      };

      const rootDir = getRootDir();
      const providersDir = join(rootDir, 'contents', 'config');
      const providersPath = join(providersDir, 'providers.json');

      await fs.mkdir(providersDir, { recursive: true });
      await fs.writeFile(providersPath, JSON.stringify({ providers }, null, 2));
      await configCache.refreshProvidersCache();

      logger.info(`Setup: API key configured for provider "${providerId}"`, {
        component: 'Setup'
      });

      res.json({ success: true });
    } catch (error) {
      logger.error('Error saving setup configuration:', { component: 'Setup', error });
      res.status(500).json({ error: 'Failed to save configuration' });
    }
  });
}
