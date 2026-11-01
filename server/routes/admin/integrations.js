// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { sendBadRequest, sendInternalError, sendNotFound } from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import installedIntegrationService, {
  IntegrationError
} from '../../services/integrations/InstalledIntegrationService.js';
import {
  getProtocolAdapter,
  supportedProtocols
} from '../../services/integrations/protocols/index.js';
import { INTEGRATION_ID_PATTERN } from '../../validators/integrationDefinitionSchema.js';
import { localized } from '../../services/integrations/definitions/installedValues.js';
import logger from '../../utils/logger.js';

/**
 * Admin API of the integrations platform (#3061):
 *
 *   GET  /api/admin/integrations/catalog                      definitions (shipped + installed from registries)
 *   GET  /api/admin/integrations/catalog/:definitionId         one definition with its install fields and actions
 *   POST /api/admin/integrations/catalog/:definitionId/_test   test an unsaved instance
 *   GET  /api/admin/integrations/installed                     installed instances
 *   POST /api/admin/integrations/installed                     install (create an instance)
 *   GET  /api/admin/integrations/installed/:id                 instance with its live actions
 *   PUT  /api/admin/integrations/installed/:id                 update
 *   DELETE /api/admin/integrations/installed/:id               uninstall the instance
 *   POST /api/admin/integrations/installed/:id/_test           test the saved instance
 *   POST /api/admin/integrations/installed/:id/_enable|_disable
 *
 * The `catalog` and `installed` segments keep these routes apart from the
 * older `/api/admin/integrations/ifinder/*` and `.../iassistant/*` endpoints.
 */

const COMPONENT = 'AdminIntegrationsRoutes';

function languageOf(req) {
  const raw =
    req.query.lang || req.headers['accept-language']?.split(',')[0]?.split(';')[0] || 'en';
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(raw) ? raw : 'en';
}

function definitionIdOf(req, res) {
  // Definition ids may carry one "/", so they travel URL-encoded.
  const id = req.params.definitionId || '';
  if (!INTEGRATION_ID_PATTERN.test(id)) {
    sendBadRequest(res, 'Invalid definition id');
    return null;
  }
  return id;
}

function catalogEntryView(entry, language, instances) {
  const def = entry.definition;
  return {
    id: def.id,
    version: def.version,
    name: localized(def.name, language, def.id),
    description: localized(def.description, language),
    publisher: def.publisher,
    categories: def.categories,
    docsUrl: def.docsUrl,
    icon: def.icon,
    runs: def.runs,
    protocol: def.protocol.type,
    supported: Boolean(getProtocolAdapter(def.protocol.type)),
    authModes: def.auth.modes,
    defaultAuthMode: def.auth.default,
    capabilities: def.capabilities,
    actionCount: def.actions.length,
    source: entry.source,
    installedInstances: instances.filter(i => i.definition === def.id).map(i => i.id)
  };
}

function definitionDetailView(entry, language, instances) {
  const def = entry.definition;
  return {
    ...catalogEntryView(entry, language, instances),
    nameLocalized: def.name,
    descriptionLocalized: def.description,
    auth: def.auth,
    install: def.install,
    scopes: def.scopes
      ? {
          label: localized(def.scopes.label, language),
          action: def.scopes.action,
          strict: def.scopes.strict
        }
      : null,
    health: def.health || null,
    instructions: localized(def.instructions, language),
    actions: def.actions.map(a => ({
      name: a.name,
      operationId: a.operationId,
      title: localized(a.title, language, a.name),
      description: localized(a.description, language),
      sideEffect: a.sideEffect,
      dataFlow: a.dataFlow,
      enabledByDefault: a.enabledByDefault,
      connection: a.connection,
      requires: a.requires,
      guidance: localized(a.guidance, language),
      examples: (a.examples || []).map(e => localized(e, language)).filter(Boolean),
      hasSources: Boolean(def.sources?.[a.name])
    }))
  };
}

function instanceView(instance, resolved, language) {
  return {
    ...instance,
    label: resolved?.label || instance.id,
    definitionName: resolved?.definition ? localized(resolved.definition.name, language) : null,
    definitionMissing: !resolved?.definition,
    protocol: resolved?.definition?.protocol?.type || null
  };
}

function sendIntegrationError(res, error, context) {
  if (error instanceof IntegrationError) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
      code: error.code,
      details: error.details
    });
  }
  return sendInternalError(res, error, context);
}

function adminName(req) {
  return req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown';
}

export default function registerAdminIntegrationsRoutes(app) {
  // --- Catalog ------------------------------------------------------------

  app.get(buildServerPath('/api/admin/integrations/catalog'), adminAuth, async (req, res) => {
    try {
      await integrationRegistry.ensureLoaded();
      const language = languageOf(req);
      const instances = installedIntegrationService.list();
      const items = integrationRegistry
        .list()
        .map(entry => catalogEntryView(entry, language, instances))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ success: true, items, supportedProtocols: supportedProtocols() });
    } catch (error) {
      sendInternalError(res, error, 'list integration catalog');
    }
  });

  app.post(
    buildServerPath('/api/admin/integrations/catalog/_reload'),
    adminAuth,
    async (req, res) => {
      try {
        await integrationRegistry.reload();
        res.json({ success: true, count: integrationRegistry.list().length });
      } catch (error) {
        sendInternalError(res, error, 'reload integration catalog');
      }
    }
  );

  app.get(
    buildServerPath('/api/admin/integrations/catalog/:definitionId'),
    adminAuth,
    async (req, res) => {
      const id = definitionIdOf(req, res);
      if (!id) return;
      try {
        await integrationRegistry.ensureLoaded();
        const entry = integrationRegistry.get(id);
        if (!entry) return sendNotFound(res, 'Integration definition');
        res.json({
          success: true,
          definition: definitionDetailView(
            entry,
            languageOf(req),
            installedIntegrationService.list()
          )
        });
      } catch (error) {
        sendInternalError(res, error, 'read integration definition');
      }
    }
  );

  app.post(
    buildServerPath('/api/admin/integrations/catalog/:definitionId/_test'),
    adminAuth,
    async (req, res) => {
      const id = definitionIdOf(req, res);
      if (!id) return;
      try {
        const payload = { ...(req.body || {}), definition: id, id: req.body?.id || 'draft' };
        const result = await installedIntegrationService.test(payload, {
          language: languageOf(req)
        });
        logAudit({
          req,
          action: 'execute',
          resource: 'integration',
          resourceId: payload.id,
          summary: `Tested integration draft of ${id} (${result.success ? 'ok' : 'failed'})`,
          result: result.success ? 'success' : 'failure'
        });
        res.json({ success: true, result });
      } catch (error) {
        sendIntegrationError(res, error, 'test integration draft');
      }
    }
  );

  // --- Installed instances -------------------------------------------------

  app.get(buildServerPath('/api/admin/integrations/installed'), adminAuth, async (req, res) => {
    try {
      const language = languageOf(req);
      const items = [];
      for (const instance of installedIntegrationService.list()) {
        const resolved = await installedIntegrationService.resolve(instance, language);
        items.push(instanceView(instance, resolved, language));
      }
      res.json({ success: true, items, security: installedIntegrationService.security() });
    } catch (error) {
      sendInternalError(res, error, 'list installed integrations');
    }
  });

  app.post(buildServerPath('/api/admin/integrations/installed'), adminAuth, async (req, res) => {
    try {
      const instance = await installedIntegrationService.create(req.body, {
        language: languageOf(req)
      });
      logAudit({
        req,
        action: 'create',
        resource: 'integration',
        resourceId: instance.id,
        summary: `Installed integration "${instance.id}" from ${instance.definition}`
      });
      logger.info('Integration installed', {
        component: COMPONENT,
        instanceId: instance.id,
        definition: instance.definition,
        admin: adminName(req)
      });
      res.status(201).json({ success: true, instance });
    } catch (error) {
      sendIntegrationError(res, error, 'install integration');
    }
  });

  app.get(buildServerPath('/api/admin/integrations/installed/:id'), adminAuth, async (req, res) => {
    const id = req.params.id;
    if (!validateIdForPath(id, 'integration', res)) return;
    try {
      const language = languageOf(req);
      const resolved = await installedIntegrationService.resolve(id, language);
      if (!resolved) return sendNotFound(res, 'Integration');
      let actions = [];
      if (resolved.definition) {
        const adapter = getProtocolAdapter(resolved.definition.protocol.type);
        if (adapter) {
          actions = await adapter.discoverActions({
            definition: resolved.definition,
            instance: resolved.instance,
            document: resolved.document,
            security: resolved.security,
            language,
            includeUnavailable: true
          });
        }
      }
      res.json({
        success: true,
        instance: instanceView(resolved.instance, resolved, language),
        values: resolved.values,
        actions: actions.map(a => ({ ...a, parameters: a.parameters, sources: undefined })),
        definition: resolved.definition
          ? definitionDetailView(
              integrationRegistry.get(resolved.definition.id),
              language,
              installedIntegrationService.list()
            )
          : null
      });
    } catch (error) {
      sendInternalError(res, error, 'read installed integration');
    }
  });

  app.put(buildServerPath('/api/admin/integrations/installed/:id'), adminAuth, async (req, res) => {
    const id = req.params.id;
    if (!validateIdForPath(id, 'integration', res)) return;
    try {
      const instance = await installedIntegrationService.update(id, req.body, {
        language: languageOf(req)
      });
      logAudit({
        req,
        action: 'update',
        resource: 'integration',
        resourceId: id,
        summary: `Updated installed integration "${id}"`
      });
      res.json({ success: true, instance });
    } catch (error) {
      sendIntegrationError(res, error, 'update installed integration');
    }
  });

  app.delete(
    buildServerPath('/api/admin/integrations/installed/:id'),
    adminAuth,
    async (req, res) => {
      const id = req.params.id;
      if (!validateIdForPath(id, 'integration', res)) return;
      try {
        await installedIntegrationService.remove(id);
        logAudit({
          req,
          action: 'delete',
          resource: 'integration',
          resourceId: id,
          summary: `Uninstalled integration "${id}"`
        });
        res.status(204).end();
      } catch (error) {
        sendIntegrationError(res, error, 'uninstall integration');
      }
    }
  );

  for (const [suffix, enabled] of [
    ['_enable', true],
    ['_disable', false]
  ]) {
    app.post(
      buildServerPath(`/api/admin/integrations/installed/:id/${suffix}`),
      adminAuth,
      async (req, res) => {
        const id = req.params.id;
        if (!validateIdForPath(id, 'integration', res)) return;
        try {
          const instance = await installedIntegrationService.setEnabled(id, enabled);
          logAudit({
            req,
            action: 'toggle',
            resource: 'integration',
            resourceId: id,
            summary: `${enabled ? 'Enabled' : 'Disabled'} integration "${id}"`
          });
          res.json({ success: true, instance });
        } catch (error) {
          sendIntegrationError(res, error, 'toggle integration');
        }
      }
    );
  }

  app.post(
    buildServerPath('/api/admin/integrations/installed/:id/_test'),
    adminAuth,
    async (req, res) => {
      const id = req.params.id;
      if (!validateIdForPath(id, 'integration', res)) return;
      try {
        const existing = installedIntegrationService.get(id);
        if (!existing) return sendNotFound(res, 'Integration');
        const payload = req.body && Object.keys(req.body).length ? { ...req.body, id } : existing;
        const result = await installedIntegrationService.test(payload, {
          language: languageOf(req)
        });
        logAudit({
          req,
          action: 'execute',
          resource: 'integration',
          resourceId: id,
          summary: `Tested integration "${id}" (${result.success ? 'ok' : 'failed'})`,
          result: result.success ? 'success' : 'failure'
        });
        res.json({ success: true, result });
      } catch (error) {
        sendIntegrationError(res, error, 'test installed integration');
      }
    }
  );
}
