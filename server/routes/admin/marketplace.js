/**
 * Admin Marketplace Routes
 *
 * REST endpoints for the marketplace admin panel. All routes are guarded by:
 * - adminAuth: ensures the caller is an authenticated administrator
 * - requireFeature('marketplace'): returns 403 if the marketplace feature is disabled
 *
 * Route groups:
 * - Registry management (CRUD + test + refresh)
 * - Catalog browsing (list items across all registries, get item detail)
 * - Item actions (install, update, uninstall, detach)
 * - Installation tracking (list all, check for updates)
 *
 * @module routes/admin/marketplace
 */

import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { requireFeature } from '../../featureRegistry.js';
import registryService from '../../services/marketplace/RegistryService.js';
import contentInstaller from '../../services/marketplace/ContentInstaller.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'AdminMarketplaceRoutes';

/**
 * Send a structured JSON error response.
 *
 * @param {import('express').Response} res - Express response object
 * @param {number} status - HTTP status code
 * @param {string} message - Human-readable error description
 * @param {string} [code] - Optional machine-readable error code
 * @returns {import('express').Response}
 */
function sendError(res, status, message, code) {
  return res.status(status).json({ error: message, ...(code ? { code } : {}) });
}

/**
 * Register all marketplace admin routes on the Express app.
 *
 * @param {import('express').Application} app - Express application instance
 */
export default function registerAdminMarketplaceRoutes(app) {
  const featureGuard = requireFeature('marketplace');

  // ==========================================================================
  // Registry Management
  // ==========================================================================

  /**
   * GET /api/admin/marketplace/registries
   * List all configured registries with auth secrets redacted.
   */
  app.get(
    buildServerPath('/api/admin/marketplace/registries'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const registries = await registryService.listRegistries();
        res.json(registries);
      } catch (error) {
        logger.error('Error listing registries', { component: COMPONENT, error: error.message });
        sendError(res, 500, error.message);
      }
    }
  );

  /**
   * POST /api/admin/marketplace/registries
   * Create a new registry. Attempts an initial catalog refresh after creation.
   * Body: registryConfig (see registryConfigSchema)
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const registry = await registryService.createRegistry(req.body);

        // Attempt initial catalog refresh — failure is non-fatal
        try {
          await registryService.refreshRegistry(registry.id);
        } catch (refreshError) {
          logger.warn(`Initial registry refresh failed: ${refreshError.message}`, {
            component: COMPONENT
          });
        }

        res.status(201).json(registry);
      } catch (error) {
        logger.error('Error creating registry', { component: COMPONENT, error: error.message });
        const status = error.message.includes('already exists') ? 409 : 400;
        sendError(res, status, error.message);
      }
    }
  );

  /**
   * GET /api/admin/marketplace/registries/:registryId
   * Get a single registry with its cached catalog (if available).
   */
  app.get(
    buildServerPath('/api/admin/marketplace/registries/:registryId'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { registryId } = req.params;
        const registries = await registryService.listRegistries();
        const registry = registries.find(r => r.id === registryId);
        if (!registry) return sendError(res, 404, `Registry '${registryId}' not found`);

        const cached = await registryService.getCachedCatalogAsync(registryId);
        res.json({ ...registry, catalog: cached?.catalog || null });
      } catch (error) {
        logger.error('Error getting registry', { component: COMPONENT, error: error.message });
        sendError(res, 500, error.message);
      }
    }
  );

  /**
   * PUT /api/admin/marketplace/registries/:registryId
   * Update an existing registry's configuration.
   * Body: partial registry config (REDACTED secrets are preserved from existing config)
   */
  app.put(
    buildServerPath('/api/admin/marketplace/registries/:registryId'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { registryId } = req.params;
        const updated = await registryService.updateRegistry(registryId, req.body);
        res.json(updated);
      } catch (error) {
        logger.error('Error updating registry', { component: COMPONENT, error: error.message });
        const status = error.message.includes('not found') ? 404 : 400;
        sendError(res, status, error.message);
      }
    }
  );

  /**
   * DELETE /api/admin/marketplace/registries/:registryId
   * Remove a registry configuration and its cached catalog.
   */
  app.delete(
    buildServerPath('/api/admin/marketplace/registries/:registryId'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { registryId } = req.params;
        await registryService.deleteRegistry(registryId);
        res.json({ success: true });
      } catch (error) {
        logger.error('Error deleting registry', { component: COMPONENT, error: error.message });
        const status = error.message.includes('not found') ? 404 : 500;
        sendError(res, status, error.message);
      }
    }
  );

  /**
   * POST /api/admin/marketplace/registries/:registryId/_refresh
   * Re-fetch and cache the registry's catalog.json from the remote source.
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries/:registryId/_refresh'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { registryId } = req.params;
        const catalog = await registryService.refreshRegistry(registryId);
        res.json({ success: true, itemCount: (catalog.items || []).length });
      } catch (error) {
        logger.error('Error refreshing registry', { component: COMPONENT, error: error.message });
        const status = error.message.includes('not found') ? 404 : 500;
        sendError(res, status, error.message);
      }
    }
  );

  /**
   * POST /api/admin/marketplace/registries/:registryId/_test
   * Test connectivity to a registry.
   * If the request body contains a `source` URL, tests that config directly
   * (useful for validating a new registry before saving it).
   * Otherwise tests the existing saved registry config.
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries/:registryId/_test'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        if (req.body && req.body.source) {
          // Test an unsaved / draft registry config from the request body
          const result = await registryService.testRegistry(req.body);
          res.json(result);
        } else {
          // Test the saved registry (with decrypted auth)
          const registry = await registryService.getRegistryWithAuth(req.params.registryId);
          const result = await registryService.testRegistry(registry);
          res.json(result);
        }
      } catch (error) {
        logger.error('Error testing registry', { component: COMPONENT, error: error.message });
        // Always return 200 with success:false so the UI can display the message
        res.json({ success: false, itemCount: 0, message: error.message });
      }
    }
  );

  // ==========================================================================
  // Catalog Browsing
  // ==========================================================================

  /**
   * GET /api/admin/marketplace
   * Browse all items across all enabled registries.
   * Query params: type, search, category, registry, status, page, limit
   */
  app.get(buildServerPath('/api/admin/marketplace'), adminAuth, featureGuard, async (req, res) => {
    try {
      const filters = {
        type: req.query.type,
        search: req.query.search,
        category: req.query.category,
        registry: req.query.registry,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit
      };
      const result = await registryService.getAllItems(filters);
      res.json(result);
    } catch (error) {
      logger.error('Error browsing marketplace', { component: COMPONENT, error: error.message });
      sendError(res, 500, error.message);
    }
  });

  /**
   * GET /api/admin/marketplace/registries/:registryId/items/:type/:name
   * Get full details for a specific catalog item including content preview.
   */
  app.get(
    buildServerPath('/api/admin/marketplace/registries/:registryId/items/:type/:name'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { registryId, type, name } = req.params;
        const item = await registryService.getItemDetail(registryId, type, name);
        res.json(item);
      } catch (error) {
        logger.error('Error getting item detail', { component: COMPONENT, error: error.message });
        const status = error.message.includes('not found') ? 404 : 500;
        sendError(res, status, error.message);
      }
    }
  );

  // ==========================================================================
  // Item Actions
  // ==========================================================================

  /**
   * POST /api/admin/marketplace/registries/:registryId/items/:type/:name/_install
   * Install a catalog item into the local iHub instance.
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries/:registryId/items/:type/:name/_install'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { registryId, type, name } = req.params;
        const installedBy = req.user?.email || req.user?.username || 'admin';
        const manifest = await contentInstaller.install(registryId, type, name, installedBy);
        res.status(201).json(manifest);
      } catch (error) {
        logger.error('Error installing item', { component: COMPONENT, error: error.message });
        const status = error.message.includes('already installed') ? 409 : 500;
        sendError(res, status, error.message);
      }
    }
  );

  /**
   * POST /api/admin/marketplace/registries/:registryId/items/:type/:name/_update
   * Update an already-installed item to the latest version in the registry.
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries/:registryId/items/:type/:name/_update'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { type, name } = req.params;
        const updatedBy = req.user?.email || req.user?.username || 'admin';
        const manifest = await contentInstaller.update(type, name, updatedBy);
        res.json(manifest);
      } catch (error) {
        logger.error('Error updating item', { component: COMPONENT, error: error.message });
        const status = error.message.includes('not installed') ? 404 : 500;
        sendError(res, status, error.message);
      }
    }
  );

  /**
   * POST /api/admin/marketplace/registries/:registryId/items/:type/:name/_uninstall
   * Uninstall an item: remove its files and the installation manifest entry.
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries/:registryId/items/:type/:name/_uninstall'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { type, name } = req.params;
        await contentInstaller.uninstall(type, name);
        res.json({ success: true });
      } catch (error) {
        logger.error('Error uninstalling item', { component: COMPONENT, error: error.message });
        const status = error.message.includes('not installed') ? 404 : 500;
        sendError(res, status, error.message);
      }
    }
  );

  /**
   * POST /api/admin/marketplace/registries/:registryId/items/:type/:name/_detach
   * Remove an item from marketplace tracking without deleting its content files.
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries/:registryId/items/:type/:name/_detach'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const { type, name } = req.params;
        await contentInstaller.detach(type, name);
        res.json({ success: true });
      } catch (error) {
        logger.error('Error detaching item', { component: COMPONENT, error: error.message });
        sendError(res, 500, error.message);
      }
    }
  );

  // ==========================================================================
  // Installation Tracking
  // ==========================================================================

  /**
   * GET /api/admin/marketplace/installations
   * Return the full installations manifest (all tracked marketplace items).
   */
  app.get(
    buildServerPath('/api/admin/marketplace/installations'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const cc = (await import('../../configCache.js')).default;
        const { data } = cc.getInstallations();
        res.json(data?.installations || {});
      } catch (error) {
        logger.error('Error getting installations', { component: COMPONENT, error: error.message });
        sendError(res, 500, error.message);
      }
    }
  );

  /**
   * GET /api/admin/marketplace/updates
   * Check all installed items for available updates by comparing their recorded
   * version against the version advertised in the latest cached catalog.
   *
   * Returns an array of items where the catalog version differs from the installed version.
   */
  app.get(
    buildServerPath('/api/admin/marketplace/updates'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const cc = (await import('../../configCache.js')).default;
        const { data: installationsData } = cc.getInstallations();
        const installations = installationsData?.installations || {};

        const updates = [];

        for (const [key, manifest] of Object.entries(installations)) {
          const cached = await registryService.getCachedCatalogAsync(manifest.registryId);
          if (!cached) continue;

          const item = (cached.catalog?.items || []).find(
            i => i.type === manifest.type && i.name === manifest.itemId
          );
          if (!item) continue;

          // Only flag as updateable when both versions are known and differ
          if (item.version && manifest.version && item.version !== manifest.version) {
            updates.push({
              key,
              ...manifest,
              latestVersion: item.version,
              updateAvailable: true
            });
          }
        }

        res.json(updates);
      } catch (error) {
        logger.error('Error checking updates', { component: COMPONENT, error: error.message });
        sendError(res, 500, error.message);
      }
    }
  );
}
