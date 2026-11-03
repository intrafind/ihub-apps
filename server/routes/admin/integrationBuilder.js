// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { sendBadRequest, sendInternalError } from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import integrationBuilderService, {
  BuilderError,
  IntegrationError
} from '../../services/integrations/builder/IntegrationBuilderService.js';
import { builderImportSchema } from '../../validators/integrationBuilderSchema.js';

/**
 * Routes of the integration builder (**Admin → Integrations → Add
 * manually**, Unified Integrations concept 04 §4). They replace the Tools
 * admin routes (`/api/admin/tools*`, removed without an alias): a custom
 * integration is a definition folder plus an installation, written through
 * the existing integration services.
 *
 * | Route                                                | Purpose                                     |
 * | ---------------------------------------------------- | ------------------------------------------- |
 * | `POST /api/admin/integrations/builder`               | create a custom integration from a draft    |
 * | `GET  /api/admin/integrations/builder/:id`           | the draft of a custom integration           |
 * | `PUT  /api/admin/integrations/builder/:id`           | save a custom integration                   |
 * | `POST /api/admin/integrations/builder/_import`       | list the actions of an OpenAPI, MCP or A2A source |
 * | `POST /api/admin/integrations/builder/_export/:id`   | the package a registry serves               |
 * | `GET  /api/admin/integrations/tools`                 | every tool id the admin pickers offer       |
 *
 * Every route is admin-only.
 */

function languageOf(req) {
  const raw =
    req.query?.lang || req.headers['accept-language']?.split(',')[0]?.split(';')[0] || 'en';
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(raw) ? raw : 'en';
}

function sendBuilderError(res, error, context) {
  if (error instanceof BuilderError || error instanceof IntegrationError) {
    return res.status(error.status || 400).json({
      success: false,
      error: error.message,
      code: error.code,
      details: error.details
    });
  }
  return sendInternalError(res, error, context);
}

/** A tool as the admin pickers list it. */
export function toolCatalogEntry(tool) {
  const integration = tool._integration
    ? {
        instanceId: tool._integration.instanceId,
        label: tool._integration.instanceLabel,
        action: tool._integration.action
      }
    : null;
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    ...(integration ? { integration } : {})
  };
}

export default function registerAdminIntegrationBuilderRoutes(app) {
  /**
   * @swagger
   * /api/admin/integrations/tools:
   *   get:
   *     summary: Every tool an app, workflow or agent can name
   *     description: |
   *       The tool ids the admin pickers offer (app and agent editors, workflow tool and
   *       prompt nodes, agent memory): the platform tools of workflows and agents, tool files
   *       left in `contents/tools/`, and every available action of the enabled installed
   *       integrations (custom ones included), each with the installation it belongs to.
   *       Not filtered by the admin's own group grants.
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   */
  app.get(buildServerPath('/api/admin/integrations/tools'), adminAuth, async (req, res) => {
    try {
      const { loadTools } = await import('../../toolLoader.js');
      const tools = await loadTools(languageOf(req));
      res.json((tools || []).map(toolCatalogEntry));
    } catch (error) {
      sendInternalError(res, error, 'list tools');
    }
  });

  /**
   * @swagger
   * /api/admin/integrations/builder/_import:
   *   post:
   *     summary: List the actions of a source before a custom integration is saved
   *     description: |
   *       `kind: openapi` fetches (SSRF-guarded) or parses the document and lists its
   *       operations, with the side effect each method suggests, and returns the parsed
   *       document. `kind: mcp` connects to the server and lists its tools; `kind: a2a`
   *       reads the agent card and lists its skills.
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   */
  app.post(
    buildServerPath('/api/admin/integrations/builder/_import'),
    adminAuth,
    async (req, res) => {
      const parsed = builderImportSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return sendBadRequest(res, 'Invalid import request', parsed.error.issues);
      }
      try {
        const result = await integrationBuilderService.importActions(parsed.data, {
          user: req.user,
          language: languageOf(req)
        });
        res.json(result);
      } catch (error) {
        sendBuilderError(res, error, 'import integration actions');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/integrations/builder/_export/{id}:
   *   post:
   *     summary: Export a custom integration as a registry package
   *     description: |
   *       Answers with `{ format, formatVersion, catalogItem, files }`: the catalog item for a
   *       registry's `catalog.json` and the files of the definition folder (`integration.json`
   *       and its companions). Tool ids the integration kept from a tool file are left out;
   *       every code file carries its `source.integrity` hash. A local MCP process cannot be
   *       exported (409 `NOT_PUBLISHABLE`).
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   */
  app.post(
    buildServerPath('/api/admin/integrations/builder/_export/:id'),
    adminAuth,
    async (req, res) => {
      const id = req.params.id;
      if (!validateIdForPath(id, 'integration', res)) return;
      try {
        const pkg = await integrationBuilderService.exportPackage(id);
        logAudit({
          req,
          action: 'export',
          resource: 'integration',
          resourceId: id,
          summary: `Exported custom integration "${id}"`
        });
        res.json(pkg);
      } catch (error) {
        sendBuilderError(res, error, 'export custom integration');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/integrations/builder:
   *   post:
   *     summary: Create a custom integration
   *     description: |
   *       Writes the definition `custom/<id>` under `contents/integration-definitions/` and
   *       installs it as `<id>`. The body is the builder draft (name, description, icon,
   *       sign-in, source settings, actions with side effect, data flow and approval).
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   */
  app.post(buildServerPath('/api/admin/integrations/builder'), adminAuth, async (req, res) => {
    try {
      const { instance, definition } = await integrationBuilderService.create(req.body, {
        language: languageOf(req)
      });
      logAudit({
        req,
        action: 'create',
        resource: 'integration',
        resourceId: instance.id,
        summary: `Built custom integration "${instance.id}" (${definition.protocol.type})`
      });
      res.status(201).json({ success: true, instance, definitionId: definition.id });
    } catch (error) {
      sendBuilderError(res, error, 'create custom integration');
    }
  });

  /**
   * @swagger
   * /api/admin/integrations/builder/{id}:
   *   get:
   *     summary: The builder draft of a custom integration
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   */
  app.get(buildServerPath('/api/admin/integrations/builder/:id'), adminAuth, async (req, res) => {
    const id = req.params.id;
    if (!validateIdForPath(id, 'integration', res)) return;
    try {
      res.json(await integrationBuilderService.load(id, { language: languageOf(req) }));
    } catch (error) {
      sendBuilderError(res, error, 'load custom integration');
    }
  });

  /**
   * @swagger
   * /api/admin/integrations/builder/{id}:
   *   put:
   *     summary: Save a custom integration
   *     description: |
   *       Writes the definition folder with the next patch version and saves the
   *       installation against it; when the installation is refused, the previous
   *       folder is put back.
   *     tags:
   *       - Admin - Integrations
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   */
  app.put(buildServerPath('/api/admin/integrations/builder/:id'), adminAuth, async (req, res) => {
    const id = req.params.id;
    if (!validateIdForPath(id, 'integration', res)) return;
    try {
      const { instance, definition } = await integrationBuilderService.update(id, req.body, {
        language: languageOf(req)
      });
      logAudit({
        req,
        action: 'update',
        resource: 'integration',
        resourceId: id,
        summary: `Saved custom integration "${id}" (${definition.version})`
      });
      res.json({ success: true, instance, definitionId: definition.id });
    } catch (error) {
      sendBuilderError(res, error, 'save custom integration');
    }
  });
}
