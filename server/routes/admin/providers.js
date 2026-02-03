import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import tokenStorageService from '../../services/TokenStorageService.js';

export default function registerAdminProvidersRoutes(app, basePath = '') {
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
  app.get(buildServerPath('/api/admin/providers', basePath), adminAuth, async (req, res) => {
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
      console.error('Error fetching all providers:', error);
      res.status(500).json({ error: 'Failed to fetch providers' });
    }
  });

  app.get(
    buildServerPath('/api/admin/providers/:providerId', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { providerId } = req.params;

        // Validate providerId for security
        if (!validateIdForPath(providerId, 'provider', res)) {
          return;
        }

        const { data: providers, etag: providersEtag } = configCache.getProviders(true);
        const provider = providers.find(p => p.id === providerId);
        if (!provider) {
          return res.status(404).json({ error: 'Provider not found' });
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
        console.error('Error fetching provider:', error);
        res.status(500).json({ error: 'Failed to fetch provider' });
      }
    }
  );

  app.put(
    buildServerPath('/api/admin/providers/:providerId', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { providerId } = req.params;
        const updatedProvider = req.body;

        // Validate providerId for security
        if (!validateIdForPath(providerId, 'provider', res)) {
          return;
        }

        if (updatedProvider.id !== providerId) {
          return res.status(400).json({ error: 'Provider ID cannot be changed' });
        }

        // Define paths once at the top
        const rootDir = getRootDir();
        const providersPath = join(rootDir, 'contents', 'config', 'providers.json');
        const providersDir = join(rootDir, 'contents', 'config');

        // Handle API key encryption
        if (updatedProvider.apiKey) {
          // Check if this is a new key or unchanged masked value
          if (updatedProvider.apiKey !== '••••••••') {
            // New key provided - encrypt it
            try {
              updatedProvider.apiKey = tokenStorageService.encryptString(updatedProvider.apiKey);
            } catch (error) {
              console.error('Error encrypting API key:', error);
              return res.status(500).json({ error: 'Failed to encrypt API key' });
            }
          } else {
            // Masked value - need to preserve existing key
            // CRITICAL FIX: Read from disk, not cache, to ensure we have the apiKey field
            // The cache might not have the apiKey due to TTL expiration or race conditions
            try {
              if (existsSync(providersPath)) {
                const providersFromDisk = JSON.parse(await fs.readFile(providersPath, 'utf8'));
                const existingProvider = providersFromDisk.providers?.find(
                  p => p.id === providerId
                );
                if (existingProvider && existingProvider.apiKey) {
                  // Preserve the existing encrypted API key from disk
                  updatedProvider.apiKey = existingProvider.apiKey;
                } else {
                  // No existing key on disk, remove the masked placeholder
                  delete updatedProvider.apiKey;
                }
              } else {
                // File doesn't exist yet, remove the masked placeholder
                delete updatedProvider.apiKey;
              }
            } catch (error) {
              console.error('Error reading existing providers from disk:', error);
              // Fallback to removing the masked placeholder
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
          return res.status(404).json({ error: 'Provider not found' });
        }

        providers[index] = updatedProvider;

        // Ensure the directory exists before writing
        await fs.mkdir(providersDir, { recursive: true });

        // Save updated providers
        await fs.writeFile(providersPath, JSON.stringify({ providers }, null, 2));
        await configCache.refreshProvidersCache();

        res.json({ message: 'Provider updated successfully', provider: updatedProvider });
      } catch (error) {
        console.error('Error updating provider:', error);
        res.status(500).json({ error: 'Failed to update provider' });
      }
    }
  );

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
        description: Provider created successfully
      400:
        description: Invalid request or provider already exists
      401:
        description: Admin authentication required
      500:
        description: Internal server error
   */
  app.post(buildServerPath('/api/admin/providers'), adminAuth, async (req, res) => {
    try {
      const newProvider = req.body;

      // Validate required fields
      if (!newProvider.id || !newProvider.name || !newProvider.description) {
        return res.status(400).json({
          error: 'Missing required fields: id, name, and description are required'
        });
      }

      // Validate providerId for security
      if (!validateIdForPath(newProvider.id, 'provider', res)) {
        return;
      }

      const rootDir = getRootDir();
      const providersPath = join(rootDir, 'contents', 'config', 'providers.json');
      const providersDir = join(rootDir, 'contents', 'config');

      // Load current providers
      let providers = [];
      try {
        if (existsSync(providersPath)) {
          const providersFromDisk = JSON.parse(await fs.readFile(providersPath, 'utf8'));
          providers = providersFromDisk.providers || [];
        }
      } catch (error) {
        console.error('Error reading providers file:', error);
        // Continue with empty array
      }

      // Check if provider with this ID already exists
      if (providers.find(p => p.id === newProvider.id)) {
        return res
          .status(400)
          .json({ error: `Provider with id '${newProvider.id}' already exists` });
      }

      // Handle API key encryption
      if (newProvider.apiKey && newProvider.apiKey !== '••••••••') {
        try {
          newProvider.apiKey = tokenStorageService.encryptString(newProvider.apiKey);
        } catch (error) {
          console.error('Error encrypting API key:', error);
          return res.status(500).json({ error: 'Failed to encrypt API key' });
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

      // Ensure the directory exists before writing
      await fs.mkdir(providersDir, { recursive: true });

      // Save updated providers
      await fs.writeFile(providersPath, JSON.stringify({ providers }, null, 2));
      await configCache.refreshProvidersCache();

      res.status(201).json({ message: 'Provider created successfully', provider: newProvider });
    } catch (error) {
      console.error('Error creating provider:', error);
      res.status(500).json({ error: 'Failed to create provider' });
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
        return res.status(400).json({
          error: `Cannot delete built-in provider '${providerId}'. Only custom providers can be deleted.`
        });
      }

      const rootDir = getRootDir();
      const providersPath = join(rootDir, 'contents', 'config', 'providers.json');

      // Load current providers
      let providers = [];
      try {
        if (existsSync(providersPath)) {
          const providersFromDisk = JSON.parse(await fs.readFile(providersPath, 'utf8'));
          providers = providersFromDisk.providers || [];
        }
      } catch (error) {
        console.error('Error reading providers file:', error);
        return res.status(500).json({ error: 'Failed to read providers configuration' });
      }

      // Find provider index
      const index = providers.findIndex(p => p.id === providerId);
      if (index === -1) {
        return res.status(404).json({ error: 'Provider not found' });
      }

      // Remove provider
      providers.splice(index, 1);

      // Save updated providers
      await fs.writeFile(providersPath, JSON.stringify({ providers }, null, 2));
      await configCache.refreshProvidersCache();

      res.json({ message: 'Provider deleted successfully' });
    } catch (error) {
      console.error('Error deleting provider:', error);
      res.status(500).json({ error: 'Failed to delete provider' });
    }
  });
}
