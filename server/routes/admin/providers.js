import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import { getProviderConfigSchema } from '../../adapters/index.js';
import { sendInternalError, sendNotFound, sendBadRequest } from '../../utils/responseHelpers.js';

/** The provider configuration, as a path relative to `contents/`. */
const PROVIDERS_FILE = 'config/providers.json';

export default function registerAdminProvidersRoutes(app) {
  /**
   * @swagger
   * /admin/providers:
   *   get:
   *     summary: Get all providers (Admin)
   *     description: Retrieves all configured providers with API key status
   *     tags:
   *       - Admin - Providers
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: List of all providers
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/providers'), adminAuth, async (req, res) => {
    try {
      const { data: providers, etag: providersEtag } = configCache.getProviders(true);

      // Mask API keys in the response for security
      const maskedProviders = providers.map(provider => {
        const maskedProvider = { ...provider };
        if (maskedProvider.apiKey) {
          // Show masked value to indicate a key is set
          maskedProvider.apiKeyMasked = '••••••••';
          maskedProvider.apiKeySet = true;
          // Remove the actual encrypted key from response
          delete maskedProvider.apiKey;
        } else {
          maskedProvider.apiKeySet = false;
        }
        return maskedProvider;
      });

      res.setHeader('ETag', providersEtag);
      res.json(maskedProviders);
    } catch (error) {
      return sendInternalError(res, error, 'fetch providers');
    }
  });

  /**
   * Adapter-declared provider config schema. Drives dynamic field rendering
   * in the admin Model Form Editor for provider-specific knobs (e.g. AWS
   * Bedrock region). Returns `{ fields: [] }` for providers that don't
   * declare a schema, so callers can safely render an empty section.
   */
  app.get(
    buildServerPath('/api/admin/providers/:providerId/schema'),
    adminAuth,
    async (req, res) => {
      try {
        const { providerId } = req.params;
        if (!validateIdForPath(providerId, 'provider', res)) return;
        const schema = await getProviderConfigSchema(providerId);
        res.json(schema || { fields: [] });
      } catch (error) {
        return sendInternalError(res, error, 'fetch provider schema');
      }
    }
  );

  app.get(buildServerPath('/api/admin/providers/:providerId'), adminAuth, async (req, res) => {
    try {
      const { providerId } = req.params;

      // Validate providerId for security
      if (!validateIdForPath(providerId, 'provider', res)) {
        return;
      }

      const { data: providers, etag: providersEtag } = configCache.getProviders(true);
      const provider = providers.find(p => p.id === providerId);
      if (!provider) {
        return sendNotFound(res, 'Provider');
      }

      // Mask API key in the response for security
      const maskedProvider = { ...provider };
      if (maskedProvider.apiKey) {
        // Show masked value to indicate a key is set
        maskedProvider.apiKeyMasked = '••••••••';
        maskedProvider.apiKeySet = true;
        // Remove the actual encrypted key from response
        delete maskedProvider.apiKey;
      } else {
        maskedProvider.apiKeySet = false;
      }

      res.setHeader('ETag', providersEtag);
      res.json(maskedProvider);
    } catch (error) {
      return sendInternalError(res, error, 'fetch provider');
    }
  });

  app.put(buildServerPath('/api/admin/providers/:providerId'), adminAuth, async (req, res) => {
    try {
      const { providerId } = req.params;
      const updatedProvider = req.body;

      // Validate providerId for security
      if (!validateIdForPath(providerId, 'provider', res)) {
        return;
      }

      if (updatedProvider.id !== providerId) {
        return sendBadRequest(res, 'Provider ID cannot be changed');
      }

      // Define paths once at the top
      // Handle API key encryption
      if (updatedProvider.apiKey) {
        // Check if this is a new key or unchanged masked value
        if (updatedProvider.apiKey !== '••••••••') {
          // New key provided - encrypt it
          try {
            updatedProvider.apiKey = tokenStorageService.encryptString(updatedProvider.apiKey);
          } catch (error) {
            return sendInternalError(res, error, 'encrypt API key');
          }
        } else {
          // Masked value - need to preserve existing key
          // CRITICAL FIX: Read the stored file, not the cache, to ensure we have
          // the apiKey field. The cache might not have it due to TTL expiration
          // or race conditions.
          const stored = await configStore.readJson(PROVIDERS_FILE);
          const existingProvider = Array.isArray(stored?.providers)
            ? stored.providers.find(p => p.id === providerId)
            : undefined;
          if (existingProvider?.apiKey) {
            // Preserve the existing encrypted API key
            updatedProvider.apiKey = existingProvider.apiKey;
          } else {
            // Nothing stored to preserve, drop the masked placeholder
            delete updatedProvider.apiKey;
          }
        }
      }

      // Remove client-side helper fields
      delete updatedProvider.apiKeySet;
      delete updatedProvider.apiKeyMasked;

      // Load current providers and create a deep copy to avoid cache mutation
      const { data: cachedProviders } = configCache.getProviders(true);

      // Create a deep copy of the providers array to avoid mutating the cache
      const providers = cachedProviders.map(p => ({ ...p }));

      // Find and update the provider
      const index = providers.findIndex(p => p.id === providerId);
      if (index === -1) {
        return sendNotFound(res, 'Provider');
      }

      providers[index] = updatedProvider;

      // Save updated providers
      await configStore.writeJson(PROVIDERS_FILE, { providers });
      await configCache.refreshProvidersCache();

      res.json({ message: 'Provider updated successfully', provider: updatedProvider });
    } catch (error) {
      return sendInternalError(res, error, 'update provider');
    }
  });

  /**
   * @swagger
   * /admin/providers:
   *   post:
   *     summary: Create a new provider (Admin)
   *     description: Creates a new provider configuration
   *     tags:
   *       - Admin - Providers
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       201:
   *         description: Provider created successfully
   *       400:
   *         description: Invalid request or provider already exists
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/admin/providers'), adminAuth, async (req, res) => {
    try {
      const newProvider = req.body;

      // Validate required fields
      if (!newProvider.id || !newProvider.name || !newProvider.description) {
        return sendBadRequest(
          res,
          'Missing required fields: id, name, and description are required'
        );
      }

      // Validate providerId for security
      if (!validateIdForPath(newProvider.id, 'provider', res)) {
        return;
      }

      // Load current providers. Nothing readable means nothing configured yet,
      // which is the first-run case for a custom provider.
      const storedProviders = await configStore.readJson(PROVIDERS_FILE);
      const providers = Array.isArray(storedProviders?.providers) ? storedProviders.providers : [];

      // Check if provider with this ID already exists
      if (providers.find(p => p.id === newProvider.id)) {
        return sendBadRequest(res, `Provider with id '${newProvider.id}' already exists`);
      }

      // Handle API key encryption
      if (newProvider.apiKey && newProvider.apiKey !== '••••••••') {
        try {
          newProvider.apiKey = tokenStorageService.encryptString(newProvider.apiKey);
        } catch (error) {
          return sendInternalError(res, error, 'encrypt API key');
        }
      } else {
        delete newProvider.apiKey;
      }

      // Remove client-side helper fields
      delete newProvider.apiKeySet;
      delete newProvider.apiKeyMasked;

      // Set defaults
      if (newProvider.enabled === undefined) {
        newProvider.enabled = true;
      }
      if (!newProvider.category) {
        newProvider.category = 'custom';
      }

      // Add new provider
      providers.push(newProvider);

      // Save updated providers
      await configStore.writeJson(PROVIDERS_FILE, { providers });
      await configCache.refreshProvidersCache();

      res.status(201).json({ message: 'Provider created successfully', provider: newProvider });
    } catch (error) {
      return sendInternalError(res, error, 'create provider');
    }
  });

  /**
   * @swagger
   * /admin/providers/{providerId}:
   *   delete:
   *     summary: Delete a provider (Admin)
   *     description: Deletes a provider configuration. Cannot delete built-in LLM providers.
   *     tags:
   *       - Admin - Providers
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - name: providerId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Provider deleted successfully
   *       400:
   *         description: Cannot delete built-in provider
   *       404:
   *         description: Provider not found
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.delete(buildServerPath('/api/admin/providers/:providerId'), adminAuth, async (req, res) => {
    try {
      const { providerId } = req.params;

      // Validate providerId for security
      if (!validateIdForPath(providerId, 'provider', res)) {
        return;
      }

      // Prevent deletion of built-in LLM providers
      const builtInProviders = ['openai', 'anthropic', 'google', 'mistral', 'local'];
      if (builtInProviders.includes(providerId)) {
        return sendBadRequest(
          res,
          `Cannot delete built-in provider '${providerId}'. Only custom providers can be deleted.`
        );
      }

      // Load current providers
      const storedProviders = await configStore.readJson(PROVIDERS_FILE);
      const providers = Array.isArray(storedProviders?.providers) ? storedProviders.providers : [];

      // Find provider index
      const index = providers.findIndex(p => p.id === providerId);
      if (index === -1) {
        return sendNotFound(res, 'Provider');
      }

      // Remove provider
      providers.splice(index, 1);

      // Save updated providers
      await configStore.writeJson(PROVIDERS_FILE, { providers });
      await configCache.refreshProvidersCache();

      res.json({ message: 'Provider deleted successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'delete provider');
    }
  });
}
