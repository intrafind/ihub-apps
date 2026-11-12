// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { httpFetch } from '../utils/httpConfig.js';
import configCache from '../configCache.js';
import configStore from '../services/config/ConfigStore.js';
import tokenStorageService from '../services/TokenStorageService.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import logger from '../utils/logger.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { updatePlatform } from '../utils/platformConfigStore.js';

// Cloud LLM providers that require API keys
const LLM_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'mistral']);

/** Platform configuration, relative to `contents/`. */
const PLATFORM_FILE = 'config/platform.json';

/** Provider configuration, relative to `contents/`. */
const PROVIDERS_FILE = 'config/providers.json';

/**
 * Test an API key by making a lightweight call to the provider's API.
 * Returns { valid: boolean, error?: string }.
 */
async function testApiKey(providerId, apiKey) {
  try {
    let response;
    if (providerId === 'openai') {
      response = await httpFetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
    } else if (providerId === 'anthropic') {
      response = await httpFetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      });
    } else if (providerId === 'google') {
      response = await httpFetch('https://generativelanguage.googleapis.com/v1/models', {
        headers: { 'x-goog-api-key': apiKey }
      });
    } else if (providerId === 'mistral') {
      response = await httpFetch('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
    } else {
      return { valid: false, error: 'Unknown provider' };
    }

    if (response.ok) {
      return { valid: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API key' };
    }
    return { valid: false, error: `Provider returned status ${response.status}` };
  } catch (error) {
    return { valid: false, error: 'Could not reach provider API' };
  }
}

/**
 * Mark setup as completed by setting setup.configured = true in platform.json.
 */
async function markSetupConfigured() {
  await updatePlatform(platform => {
    platform.setup = { ...platform.setup, configured: true };
  });
  await configCache.refreshCacheEntry(PLATFORM_FILE);
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
    res.json({ configured, disabled: platform.setup?.disabled === true });
  });

  /**
   * POST /api/setup/_disable
   * Persists "don't show the onboarding again" (setup.disabled = true) so the
   * redirect to /setup stops for every user. Admin only.
   */
  app.post(buildServerPath('/api/setup/_disable'), adminAuth, async (req, res) => {
    await updatePlatform(platform => {
      platform.setup = { ...platform.setup, disabled: true };
    });
    await configCache.refreshCacheEntry(PLATFORM_FILE);
    logger.info('Setup: onboarding disabled', { component: 'Setup' });
    res.status(204).end();
  });

  /**
   * POST /api/setup/_test
   * Tests whether the provided API key is valid for the given provider.
   * Returns { valid: boolean, error?: string }.
   * Always requires admin authentication.
   */
  app.post(buildServerPath('/api/setup/_test'), adminAuth, async (req, res) => {
    const { providerId, apiKey } = req.body;

    if (!providerId || !LLM_PROVIDER_IDS.has(providerId)) {
      throw new ServiceError('BAD_REQUEST', 'Invalid provider ID');
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new ServiceError('BAD_REQUEST', 'API key is required');
    }

    const result = await testApiKey(providerId, apiKey.trim());
    logger.info('Setup test for provider', {
      component: 'Setup',
      providerId,
      valid: result.valid
    });
    res.json(result);
  });

  /**
   * POST /api/setup/configure
   * Completes initial setup by saving the first API key (cloud providers) or
   * simply marking setup done (local providers). Blocked once already configured.
   * Always requires admin authentication — never allowed anonymously.
   */
  app.post(buildServerPath('/api/setup/configure'), adminAuth, async (req, res) => {
    // Only allow when not yet configured
    const platform = configCache.getPlatform() || {};
    if (platform.setup?.configured) {
      throw new ServiceError(
        'FORBIDDEN',
        'System is already configured. Use Admin › Providers to manage API keys.'
      );
    }

    const { providerId, apiKey } = req.body;

    if (!providerId) {
      throw new ServiceError('BAD_REQUEST', 'providerId is required');
    }

    // Local provider: no API key needed — just mark setup as complete
    if (providerId === 'local') {
      await markSetupConfigured();
      logger.info('Setup: configured with local provider', { component: 'Setup' });
      return res.status(204).end();
    }

    // Cloud provider: validate and save API key
    if (!LLM_PROVIDER_IDS.has(providerId)) {
      throw new ServiceError('BAD_REQUEST', 'Invalid provider ID');
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new ServiceError('BAD_REQUEST', 'API key must be a non-empty string');
    }

    const trimmedKey = apiKey.trim();
    const encryptedKey = tokenStorageService.encryptString(trimmedKey);

    // Deep-copy providers from cache to avoid mutating cached data
    const { data: cachedProviders } = configCache.getProviders(true);
    const providers = cachedProviders.map(p => ({ ...p }));

    const providerIndex = providers.findIndex(p => p.id === providerId);
    if (providerIndex === -1) {
      throw new ServiceError('NOT_FOUND', 'Provider not found');
    }

    providers[providerIndex] = {
      ...providers[providerIndex],
      apiKey: encryptedKey,
      enabled: true
    };

    await configStore.writeJson(PROVIDERS_FILE, { providers });
    await configCache.refreshProvidersCache();

    // Mark setup as complete in platform.json
    await markSetupConfigured();

    logger.info('Setup: API key configured for provider', {
      component: 'Setup',
      providerId
    });

    res.status(204).end();
  });
}
