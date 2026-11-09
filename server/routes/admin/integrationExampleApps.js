// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { logAudit } from '../../services/AuditLogService.js';
import configCache from '../../configCache.js';
import configStore from '../../services/config/ConfigStore.js';
import { appConfigSchema } from '../../validators/appConfigSchema.js';
import { describeIssues } from '../../validators/userPromptSchema.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import installedIntegrationService from '../../services/integrations/InstalledIntegrationService.js';
import { mayUseIntegration } from '../../services/integrations/integrationAccess.js';
import {
  GENERATED_TEMPLATE,
  buildExampleApp,
  generatedExampleApp,
  isValidAppId,
  suggestAppId,
  templateView
} from '../../services/integrations/exampleApps.js';
import logger from '../../utils/logger.js';

/**
 * Example apps of an installation (issue #3128, concept "Example apps and
 * chat test for integrations"):
 *
 *   GET  /api/admin/integrations/installed/:id/example-apps   the templates and suggested ids
 *   POST /api/admin/integrations/installed/:id/example-apps   create one for this installation
 *
 * The templates are the definition's `exampleApps` (companion JSON files),
 * or one generated from the definition when it ships none. Creating writes
 * an ordinary app (`contents/apps/<id>.json`), bound to the installation,
 * the same create-only way as `POST /api/admin/apps`.
 */

const COMPONENT = 'AdminIntegrationExampleAppsRoutes';

function languageOf(req) {
  const raw =
    req.query.lang || req.headers['accept-language']?.split(',')[0]?.split(';')[0] || 'en';
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(raw) ? raw : 'en';
}

/** Whether an app id is in use (ids are compared case-insensitively). */
function appIdTaken() {
  const { data: apps = [] } = configCache.getApps(true) || {};
  const ids = new Set(apps.map(app => String(app.id).toLowerCase()));
  return id => ids.has(String(id).toLowerCase());
}

/**
 * The templates of an installation: the definition's example apps that can
 * be read, else the generated one.
 *
 * @param {{ definition: Object, instance: Object }} resolved
 * @returns {Promise<Array<{ key: string, template: Object }>>}
 */
async function templatesOf(resolved) {
  const { definition, instance } = resolved;
  const out = [];
  for (const { file } of definition.exampleApps || []) {
    const template = await integrationRegistry.readExampleApp(definition.id, file);
    if (template) out.push({ key: file, template });
  }
  if (out.length === 0) {
    out.push({ key: GENERATED_TEMPLATE, template: generatedExampleApp(definition, instance) });
  }
  return out;
}

/** The installation, resolved; throws a 404 / 409 ServiceError otherwise. */
async function resolveInstallation(req) {
  const id = req.params.id;
  assertValidId(id, 'integration');
  const resolved = await installedIntegrationService.resolve(id, languageOf(req));
  if (!resolved) {
    throw new ServiceError('NOT_FOUND', 'Integration not found');
  }
  if (!resolved.definition) {
    throw new ServiceError('CONFLICT', 'The definition of this installation is not loaded');
  }
  return resolved;
}

export default function registerAdminIntegrationExampleAppsRoutes(app) {
  app.get(
    buildServerPath('/api/admin/integrations/installed/:id/example-apps'),
    adminAuth,
    async (req, res) => {
      const resolved = await resolveInstallation(req);
      const language = languageOf(req);
      const isTaken = appIdTaken();
      const templates = (await templatesOf(resolved)).map(({ key, template }) =>
        templateView(
          key,
          template,
          language,
          suggestAppId(template.id, resolved.instance.id, isTaken)
        )
      );
      // api-guidelines-ignore: existing success body, changed in its own API change
      res.json({
        success: true,
        templates,
        // Whether the calling admin's own groups grant the installation:
        // without it the test chat runs without its actions.
        grantedToYou: mayUseIntegration(resolved.instance, req.user),
        enabled: resolved.instance.enabled !== false
      });
    }
  );

  app.post(
    buildServerPath('/api/admin/integrations/installed/:id/example-apps'),
    adminAuth,
    async (req, res) => {
      const resolved = await resolveInstallation(req);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const templates = await templatesOf(resolved);
      const chosen =
        typeof body.template === 'string'
          ? templates.find(entry => entry.key === body.template)
          : templates[0];
      if (!chosen) throw new ServiceError('BAD_REQUEST', 'Unknown example app');

      const isTaken = appIdTaken();
      const suggested = suggestAppId(chosen.template.id, resolved.instance.id, isTaken);
      const appId =
        typeof body.appId === 'string' && body.appId.trim() ? body.appId.trim() : suggested;
      if (!isValidAppId(appId)) {
        throw new ServiceError(
          'BAD_REQUEST',
          'Invalid app id: lowercase letters, digits, dots, underscores and hyphens, at most 50 characters'
        );
      }
      if (isTaken(appId)) {
        throw new ServiceError('CONFLICT', 'App with this ID already exists');
      }

      const newApp = buildExampleApp({
        template: chosen.template,
        definition: resolved.definition,
        instance: resolved.instance,
        appId,
        enabled: body.enabled !== false,
        renamed: Boolean(chosen.template.id) && isTaken(chosen.template.id)
      });
      const validation = appConfigSchema.safeParse(newApp);
      if (!validation.success) {
        logger.warn('Example app does not pass the app schema', {
          component: COMPONENT,
          integration: resolved.instance.id,
          template: chosen.key,
          error: describeIssues(validation.error)
        });
        throw new ServiceError(
          'BAD_REQUEST',
          `Invalid app configuration: ${describeIssues(validation.error)}`
        );
      }

      try {
        await configStore.createJson(`apps/${appId}.json`, newApp);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new ServiceError('CONFLICT', 'App with this ID already exists');
      }
      await configCache.refreshAppsCache();
      await logAudit({
        req,
        action: 'create',
        resource: 'app',
        resourceId: appId,
        summary: `Created app ${appId} from the example app of integration "${resolved.instance.id}"`
      });
      // api-guidelines-ignore: existing success body, changed in its own API change
      res.status(201).json({ success: true, app: newApp });
    }
  );
}
