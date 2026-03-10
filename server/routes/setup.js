import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';
import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import { buildServerPath } from '../utils/basePath.js';
import { atomicWriteJSON } from '../utils/atomicWrite.js';
import logger from '../utils/logger.js';
import { adminAuth } from '../middleware/adminAuth.js';

// Cloud LLM providers that require API keys
const LLM_PROVIDER_IDS = ['openai', 'anthropic', 'google', 'mistral'];

/**
 * Mark setup as completed by setting setup.configured = true in platform.json.
 */
async function markSetupConfigured() {
  const rootDir = getRootDir();
  const platformPath = join(rootDir, 'contents', 'config', 'platform.json');
  const raw = await fs.readFile(platformPath, 'utf8');
  const platform = JSON.parse(raw);
  platform.setup = { ...(platform.setup || {}), configured: true };
  await atomicWriteJSON(platformPath, platform);
  await configCache.refreshCacheEntry('config/platform.json');
}

export default function registerSetupRoutes(app) {
  /**
   * GET /api/setup/status
   * Returns whether initial setup has been completed.
   * Public endpoint — no authentication required.
   * NOTE: The same flag is also included in GET /api/auth/status so clients
   * can avoid a separate API call on every page load.
   */
  app.get(buildServerPath('/api/setup/status'), (req, res) => {
    const platform = configCache.getPlatform() || {};
    // Default true so that existing installs without the flag are never blocked
    const configured = platform.setup?.configured ?? true;
    res.json({ configured });
  });

  /**
   * POST /api/setup/configure
   * Completes initial setup by saving the first API key (cloud providers) or
   * simply marking setup done (local providers). Blocked once already configured.
   * Always requires admin authentication — never allowed anonymously.
   */
  app.post(buildServerPath('/api/setup/configure'), adminAuth, async (req, res) => {
    try {
      // Only allow when not yet configured
      const platform = configCache.getPlatform() || {};
      if (platform.setup?.configured) {
        return res.status(403).json({
          error: 'System is already configured. Use Admin › Providers to manage API keys.'
        });
      }

      const { providerId, apiKey } = req.body;

      if (!providerId) {
        return res.status(400).json({ error: 'providerId is required' });
      }

      // Local provider: no API key needed — just mark setup as complete
      if (providerId === 'local') {
        await markSetupConfigured();
        logger.info('Setup: configured with local provider', { component: 'Setup' });
        return res.json({ success: true });
      }

      // Cloud provider: validate and save API key
      if (!LLM_PROVIDER_IDS.includes(providerId)) {
        return res.status(400).json({ error: 'Invalid provider ID' });
      }
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
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

      // Mark setup as complete in platform.json
      await markSetupConfigured();

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
