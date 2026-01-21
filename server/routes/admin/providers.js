import { promises as fs } from 'fs';
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
            // Masked value - keep existing key from database
            const { data: providers } = configCache.getProviders(true);
            const existingProvider = providers.find(p => p.id === providerId);
            if (existingProvider && existingProvider.apiKey) {
              updatedProvider.apiKey = existingProvider.apiKey;
            } else {
              // No existing key, remove the masked placeholder
              delete updatedProvider.apiKey;
            }
          }
        }

        // Remove client-side helper fields
        delete updatedProvider.apiKeySet;
        delete updatedProvider.apiKeyMasked;

        const rootDir = getRootDir();
        const providersPath = join(rootDir, 'contents', 'config', 'providers.json');

        // Load current providers
        const { data: providers } = configCache.getProviders(true);

        // Find and update the provider
        const index = providers.findIndex(p => p.id === providerId);
        if (index === -1) {
          return res.status(404).json({ error: 'Provider not found' });
        }

        providers[index] = updatedProvider;

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
}
