// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin Marketplace Routes
 *
 * REST endpoints for the marketplace admin panel. All routes are guarded by:
 * - adminAuth: ensures the caller is an authenticated administrator
 * - requireFeature('marketplace'): returns 403 if the marketplace feature is disabled
 *
 * Route groups:
 * - Registry management (CRUD + test + refresh)
 * - Catalog browsing (list items across all registries, get item detail,
 *   a Markdown companion file of an integration item such as its release notes)
 * - Item actions (install, update, uninstall, detach)
 * - Installation tracking (list all, check for updates)
 *
 * @module routes/admin/marketplace
 */

import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { requireFeature } from '../../featureRegistry.js';
import { assertValidId, isValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import registryService from '../../services/marketplace/RegistryService.js';
import contentInstaller, {
  fetchIntegrationCompanion
} from '../../services/marketplace/ContentInstaller.js';
import logger from '../../utils/logger.js';
import { logAudit } from '../../services/AuditLogService.js';
import configStore from '../../services/config/ConfigStore.js';
import { dirNameToDefinitionId } from '../../validators/integrationDefinitionSchema.js';
import { previewDefinitionUpdate } from '../../services/integrations/definitions/migrationPreview.js';
import { isUpdate, offeredVersion } from '../../services/marketplace/versionPolicy.js';

const COMPONENT = 'AdminMarketplaceRoutes';

/** A version the client may name on install or update: up to 64 characters of a version. */
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * The optional `version` of an install or update body: undefined when absent,
 * false when it is not a version string.
 *
 * @param {object|undefined} body
 * @returns {string|undefined|false}
 */
function versionFromBody(body) {
  const version = body?.version;
  if (version === undefined || version === null || version === '') return undefined;
  return typeof version === 'string' && VERSION_PATTERN.test(version) ? version : false;
}

/**
 * What updating an integration item would do to the installations of its
 * definition, planned from the catalog item's releases and migrations
 * (`migrationPreview.js`); null when the definition has no installation.
 * Nothing is written.
 *
 * @param {string} name - catalog item name (the definition folder name)
 * @param {object} item - the catalog item (version, releases, migrations)
 * @returns {Promise<object|null>}
 */
async function integrationUpdatePreview(name, item) {
  const definitionId = dirNameToDefinitionId(name);
  const [{ default: installedIntegrationService }, { default: integrationRegistry }] =
    await Promise.all([
      import('../../services/integrations/InstalledIntegrationService.js'),
      import('../../services/integrations/definitions/IntegrationRegistry.js')
    ]);
  await integrationRegistry.ensureLoaded();
  const instances = installedIntegrationService.instancesOf(definitionId);
  if (instances.length === 0) return null;
  const apps = (await configStore.listDocuments('apps')).map(doc => ({
    path: doc.path,
    data: doc.data
  }));
  return previewDefinitionUpdate({
    definitionId,
    item,
    instances,
    apps,
    entry: integrationRegistry.get(definitionId)
  });
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
      const registries = await registryService.listRegistries();
      res.json(registries);
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
      const registry = await registryService.createRegistry(req.body);

      // Attempt initial catalog refresh — failure is non-fatal
      try {
        await registryService.refreshRegistry(registry.id);
      } catch (refreshError) {
        logger.warn('Initial registry refresh failed', {
          component: COMPONENT,
          error: refreshError.message
        });
      }

      logAudit({
        req,
        action: 'create',
        resource: 'marketplaceRegistry',
        resourceId: registry.id,
        summary: `Created marketplace registry ${registry.id}`
      });

      res.status(201).json(registry);
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
      const { registryId } = req.params;
      assertValidId(registryId, 'registryId');
      const registries = await registryService.listRegistries();
      const registry = registries.find(r => r.id === registryId);
      if (!registry) throw new ServiceError('NOT_FOUND', `Registry '${registryId}' not found`);

      const cached = await registryService.getCachedCatalogAsync(registryId);
      res.json({ ...registry, catalog: cached?.catalog || null });
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
      const { registryId } = req.params;
      assertValidId(registryId, 'registryId');
      const updated = await registryService.updateRegistry(registryId, req.body);
      logAudit({
        req,
        action: 'update',
        resource: 'marketplaceRegistry',
        resourceId: registryId,
        summary: `Updated marketplace registry ${registryId}`
      });
      res.json(updated);
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
      const { registryId } = req.params;
      assertValidId(registryId, 'registryId');
      await registryService.deleteRegistry(registryId);
      logAudit({
        req,
        action: 'delete',
        resource: 'marketplaceRegistry',
        resourceId: registryId,
        summary: `Deleted marketplace registry ${registryId}`
      });
      res.json({ success: true });
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
      const { registryId } = req.params;
      assertValidId(registryId, 'registryId');
      const catalog = await registryService.refreshRegistry(registryId);
      logAudit({
        req,
        action: 'update',
        resource: 'marketplaceRegistryCatalog',
        resourceId: registryId,
        summary: `Refreshed catalog for marketplace registry ${registryId}`
      });
      res.json({ success: true, itemCount: (catalog.items || []).length });
    }
  );

  /**
   * POST /api/admin/marketplace/registries/_test
   * Test an unsaved / draft registry config from the request body.
   * Must be registered BEFORE /:registryId/_test so Express doesn't capture
   * "_test" as the registryId parameter.
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries/_test'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      try {
        const result = await registryService.testRegistry(req.body);
        res.json(result);
      } catch (error) {
        logger.error('Error testing registry', { component: COMPONENT, error: error.message });
        res.json({ success: false, itemCount: 0, message: error.message });
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
      const { registryId } = req.params;
      assertValidId(registryId, 'registryId');
      try {
        if (req.body && req.body.source) {
          // Test an unsaved / draft registry config from the request body
          const result = await registryService.testRegistry(req.body);
          res.json(result);
        } else {
          // Test the saved registry (with decrypted auth)
          const registry = await registryService.getRegistryWithAuth(registryId);
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
  });

  /**
   * GET /api/admin/marketplace/registries/:registryId/items/:type/:name
   * Get full details for a specific catalog item including content preview.
   * An integration item whose definition is installed also carries
   * `migrationPreview`: per installation, what updating to the item's
   * version would change (`summary`), the warnings and the collisions,
   * planned from the catalog's releases and migrations; `planFromCatalog`
   * is false when an installation is older than the releases the catalog
   * lists (the plan then runs at update time). Nothing is written.
   */
  app.get(
    buildServerPath('/api/admin/marketplace/registries/:registryId/items/:type/:name'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      const { registryId, type, name } = req.params;
      assertValidId(registryId, 'registryId');
      if (!isValidId(name)) throw new ServiceError('BAD_REQUEST', 'Invalid item name');
      const item = await registryService.getItemDetail(registryId, type, name);
      if (type === 'integration') {
        try {
          // Planned to the version the update installs: the offered one
          // (channel and pin applied), which may be older than the current.
          item.migrationPreview = await integrationUpdatePreview(name, {
            ...item,
            version: item.offeredVersion || item.version
          });
        } catch (error) {
          logger.warn('Could not plan the migrations of an integration update', {
            component: COMPONENT,
            name,
            error: error.message
          });
          item.migrationPreview = null;
        }
      }
      res.json(item);
    }
  );

  /**
   * GET /api/admin/marketplace/registries/:registryId/items/integration/:name/_file?path=<companion>
   * A Markdown companion file of an integration item (a release's notes, the
   * README), fetched from the registry without installing the item. Only
   * paths the catalog lists for the item are served; anything else is 404.
   */
  app.get(
    buildServerPath('/api/admin/marketplace/registries/:registryId/items/integration/:name/_file'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      const { registryId, name } = req.params;
      assertValidId(registryId, 'registryId');
      if (!isValidId(name)) throw new ServiceError('BAD_REQUEST', 'Invalid item name');
      const relPath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!relPath || relPath.length > 255) {
        throw new ServiceError('BAD_REQUEST', 'Missing or invalid path');
      }
      const text = await fetchIntegrationCompanion(registryId, name, relPath);
      if (text === null) throw new ServiceError('NOT_FOUND', 'Companion file not found');
      res.type('text/markdown; charset=utf-8').send(text);
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
      const { registryId, type, name } = req.params;
      assertValidId(registryId, 'registryId');
      if (!isValidId(name)) throw new ServiceError('BAD_REQUEST', 'Invalid item name');
      const installedBy = req.user?.email || req.user?.username || 'admin';
      // Replacing an item that already exists here must be asked for explicitly
      const replaceLocal = req.body?.replaceLocal === true;
      const version = versionFromBody(req.body);
      if (version === false) throw new ServiceError('INVALID_VERSION', 'Invalid version');
      const manifest = await contentInstaller.install(registryId, type, name, installedBy, {
        replaceLocal,
        version
      });
      logAudit({
        req,
        action: 'create',
        resource: 'marketplaceItem',
        resourceId: `${type}/${name}`,
        summary: `Installed marketplace item ${type}/${name} from registry ${registryId}`
      });
      res.status(201).json(manifest);
    }
  );

  /**
   * POST /api/admin/marketplace/registries/:registryId/items/:type/:name/_update
   * Update an already-installed item to the latest version in the registry.
   * For an integration the installations of the definition are migrated in
   * the same commit as the new folder; the answer carries
   * `integrationMigrations`, one result per installation. 409 with
   * `MIGRATION_LOCKED` while a migration of one of them runs.
   */
  app.post(
    buildServerPath('/api/admin/marketplace/registries/:registryId/items/:type/:name/_update'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      const { type, name } = req.params;
      if (!isValidId(name)) throw new ServiceError('BAD_REQUEST', 'Invalid item name');
      const updatedBy = req.user?.email || req.user?.username || 'admin';
      const version = versionFromBody(req.body);
      if (version === false) throw new ServiceError('INVALID_VERSION', 'Invalid version');
      const manifest = await contentInstaller.update(type, name, updatedBy, { version });
      logAudit({
        req,
        action: 'update',
        resource: 'marketplaceItem',
        resourceId: `${type}/${name}`,
        summary: `Updated marketplace item ${type}/${name}`
      });
      res.json(manifest);
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
      const { type, name } = req.params;
      if (!isValidId(name)) throw new ServiceError('BAD_REQUEST', 'Invalid item name');
      await contentInstaller.uninstall(type, name);
      logAudit({
        req,
        action: 'delete',
        resource: 'marketplaceItem',
        resourceId: `${type}/${name}`,
        summary: `Uninstalled marketplace item ${type}/${name}`
      });
      res.json({ success: true });
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
      const { type, name } = req.params;
      if (!isValidId(name)) throw new ServiceError('BAD_REQUEST', 'Invalid item name');
      await contentInstaller.detach(type, name);
      logAudit({
        req,
        action: 'update',
        resource: 'marketplaceItem',
        resourceId: `${type}/${name}`,
        summary: `Detached marketplace item ${type}/${name} from tracking`
      });
      res.json({ success: true });
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
      const cc = (await import('../../configCache.js')).default;
      const { data } = cc.getInstallations();
      res.json(data?.installations || {});
    }
  );

  /**
   * GET /api/admin/marketplace/updates
   * Check all installed items for available updates by comparing their recorded
   * version against the version their registry offers in the latest cached
   * catalog: the newest listed version that passes the registry's channel and
   * the item's pin (`versionPolicy.js`).
   *
   * Returns an array of items whose offered version is newer than the installed one.
   */
  app.get(
    buildServerPath('/api/admin/marketplace/updates'),
    adminAuth,
    featureGuard,
    async (req, res) => {
      const cc = (await import('../../configCache.js')).default;
      const { data: installationsData } = cc.getInstallations();
      const installations = installationsData?.installations || {};
      const registries = cc.getRegistries()?.data?.registries || [];

      const updates = [];

      for (const [key, manifest] of Object.entries(installations)) {
        const cached = await registryService.getCachedCatalogAsync(manifest.registryId);
        if (!cached) continue;

        const item = (cached.catalog?.items || []).find(
          i => i.type === manifest.type && i.name === manifest.itemId
        );
        if (!item) continue;

        // Only flag as updateable when the offered version is newer than the installed one
        const registry = registries.find(r => r.id === manifest.registryId) || null;
        const offered = offeredVersion(item, registry);
        if (isUpdate(offered, manifest.version)) {
          updates.push({
            key,
            ...manifest,
            latestVersion: offered,
            updateAvailable: true
          });
        }
      }

      res.json(updates);
    }
  );
}
