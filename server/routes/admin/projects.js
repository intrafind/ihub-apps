// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin projects API — `/api/admin/projects` (#1036, spec 1 §5.3).
 *
 * Admin projects are configuration under `contents/projects/`, the successor
 * of `config/sources.json`: knowledge an admin links to apps, workflows and
 * agents. Content admins create and change them here. Full admins also see
 * every user project, for compliance, and may delete one.
 *
 * @module routes/admin/projects
 */
import configCache from '../../configCache.js';
import { isAdminAuthRequired } from '../../middleware/adminAuth.js';
import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { requireFeature } from '../../featureRegistry.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendFailedOperationError,
  sendNotFound
} from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import { getChatRepository } from '../../services/chat/ChatRepository.js';
import {
  getProjectRepository,
  isAdminProjectId,
  isUserProjectId
} from '../../services/projects/ProjectRepository.js';
import { getProjectService } from '../../services/projects/ProjectService.js';
import { NO_ACCESS } from '../../services/projects/projectAccess.js';
import { findDependencies } from '../../services/projects/projectLinks.js';
import { PROJECTS_FEATURE, projectSettings } from '../../services/projects/projectSettings.js';
import { enabledItemKinds, listItemKinds } from '../../services/projects/kinds/registry.js';
import {
  projectName,
  serializeItem,
  serializeProject
} from '../../services/projects/projectView.js';
import {
  addItemSchema,
  adminProjectSchema,
  adminProjectUpdateSchema,
  describeIssues,
  itemUpdateSchema,
  toggleSchema
} from '../../validators/projectSchema.js';
import { sendProjectError } from '../projectRoutes.js';

const ADMIN_PERMISSIONS = Object.freeze({
  ...NO_ACCESS,
  canView: true,
  canUse: true,
  canEdit: true,
  canDelete: true,
  role: 'admin'
});

async function snapshot(req, id, before, after) {
  try {
    await saveSnapshot({
      resource: 'project',
      id,
      before,
      after,
      admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
    });
  } catch {
    // Change history is best-effort; the write already landed.
  }
}

function parseBody(schema, req, res) {
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    sendBadRequest(res, `Invalid request: ${describeIssues(parsed.error)}`);
    return null;
  }
  return parsed.data;
}

function adminView(project) {
  return serializeProject(project, ADMIN_PERMISSIONS, { adminView: true });
}

/** Load an admin project by `:id`, 404 when missing. */
async function loadAdminProject(req, res) {
  const { id } = req.params;
  if (!validateIdForPath(id, 'project', res)) return null;
  if (!isAdminProjectId(id)) {
    sendNotFound(res, 'Project');
    return null;
  }
  const project = await getProjectRepository().get(id);
  if (!project || project.ownership !== 'admin') {
    sendNotFound(res, 'Project');
    return null;
  }
  return project;
}

/**
 * Register the `/api/admin/projects` endpoints.
 *
 * @param {import('express').Application} app
 */
export default function registerAdminProjectsRoutes(app) {
  const gate = [requireFeature(PROJECTS_FEATURE)];
  const route = suffix => buildServerPath(`/api/admin/projects${suffix}`);

  /**
   * @swagger
   * /api/admin/projects:
   *   get:
   *     summary: List projects
   *     description: Admin projects by default; `?ownership=user` lists every user project (full admins only).
   *     tags: [Admin Projects]
   */
  app.get(route(''), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const repo = getProjectRepository();
      if (req.query.ownership === 'user') {
        // Compliance view: full admins only, even though the page is reachable
        // by content admins.
        if (isAdminAuthRequired(req)) {
          return sendErrorResponse(res, 403, 'Full admin access required to list user projects', {
            details: { code: 'PERMISSION_DENIED' }
          });
        }
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
        const { projects, truncated, nextCursor } = await repo.scanUser({
          max: limit,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null
        });
        return res.json({
          items: projects.map(project =>
            serializeProject(
              project,
              { ...ADMIN_PERMISSIONS, canEdit: false },
              {
                adminView: true,
                includeItems: false
              }
            )
          ),
          truncated,
          nextCursor
        });
      }
      const projects = await repo.listAdmin({ includeDisabled: true });
      return res.json(projects.map(adminView));
    } catch (error) {
      return sendFailedOperationError(res, 'list projects', error);
    }
  });

  app.get(route('/_stats'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const repo = getProjectRepository();
      const admin = await repo.listAdmin({ includeDisabled: true });
      const byKind = {};
      for (const project of admin) {
        for (const item of project.items || []) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
      }
      const users = await repo.scanUserAll();
      const owners = new Set(users.map(project => project.owner?.id).filter(Boolean));
      res.json({
        admin: {
          total: admin.length,
          enabled: admin.filter(project => project.enabled !== false).length,
          disabled: admin.filter(project => project.enabled === false).length,
          byKind
        },
        user: {
          total: users.length,
          items: users.reduce((sum, project) => sum + (project.items || []).length, 0),
          bytes: users.reduce((sum, project) => sum + (project.usage?.bytes || 0), 0),
          owners: owners.size
        },
        limits: projectSettings(configCache.getPlatform() || {}).limits
      });
    } catch (error) {
      sendFailedOperationError(res, 'load project statistics', error);
    }
  });

  app.get(route('/_kinds'), ...gate, contentAdminAuth, (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const features = configCache.getFeatures();
      const settings = projectSettings(platform);
      const enabled = new Set(
        enabledItemKinds({ platform, features, settings }).map(kind => kind.id)
      );
      res.json(
        listItemKinds().map(kind => ({
          id: kind.id,
          name: kind.name,
          icon: kind.icon || null,
          picker: kind.picker,
          storage: kind.storage.ihub,
          credentials: kind.credentials,
          enabled: enabled.has(kind.id)
        }))
      );
    } catch (error) {
      sendFailedOperationError(res, 'list item kinds', error);
    }
  });

  app.get(route('/_dependencies/:id'), ...gate, contentAdminAuth, (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'project', res)) return;
      res.json({ projectId: id, dependencies: findDependencies(id) });
    } catch (error) {
      sendFailedOperationError(res, 'find project dependencies', error);
    }
  });

  app.post(route('/_toggle'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const body = parseBody(toggleSchema, req, res);
      if (!body) return;
      const service = getProjectService();
      let changed = 0;
      for (const id of body.ids) {
        if (!isAdminProjectId(id)) continue;
        const project = await service.updateProject(
          id,
          { enabled: body.enabled },
          { actor: req.user }
        );
        if (project) changed += 1;
      }
      logAudit({
        req,
        action: 'toggle',
        resource: 'project',
        resourceId: body.ids.join(','),
        summary: `${body.enabled ? 'Enabled' : 'Disabled'} ${changed} admin projects`
      });
      res.json({
        message: `${changed} projects ${body.enabled ? 'enabled' : 'disabled'}`,
        changed
      });
    } catch (error) {
      sendProjectError(res, error, 'toggle projects');
    }
  });

  /**
   * @swagger
   * /api/admin/projects:
   *   post:
   *     summary: Create an admin project
   *     tags: [Admin Projects]
   *     responses:
   *       201:
   *         description: The created project
   *       409:
   *         description: A project with this id exists
   */
  app.post(route(''), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const body = parseBody(adminProjectSchema, req, res);
      if (!body) return;
      if (isUserProjectId(body.id) || !isAdminProjectId(body.id)) {
        sendBadRequest(res, 'Admin project ids may not start with "prj_"');
        return;
      }
      // The stored model knows the iFinder tier; nothing backs it yet, so a
      // project cannot be created in it (phase 2 of the epic).
      if (body.tier !== 'ihub') {
        sendBadRequest(res, `The "${body.tier}" tier is not available yet; use "ihub"`);
        return;
      }
      const project = await getProjectService().createAdminProject(body, { actor: req.user });
      logAudit({
        req,
        action: 'create',
        resource: 'project',
        resourceId: project.id,
        summary: `Created admin project "${projectName(project)}"`
      });
      await snapshot(req, project.id, null, project);
      res.status(201).json({ project: adminView(project) });
    } catch (error) {
      sendProjectError(res, error, 'create admin project');
    }
  });

  app.get(route('/:id'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'project', res)) return;
      const project = await getProjectRepository().get(id);
      if (!project) return sendNotFound(res, 'Project');
      if (project.ownership === 'user') {
        if (isAdminAuthRequired(req)) return sendNotFound(res, 'Project');
        return res.json(
          serializeProject(project, { ...ADMIN_PERMISSIONS, canEdit: false }, { adminView: true })
        );
      }
      res.json(adminView(project));
    } catch (error) {
      sendFailedOperationError(res, 'get project', error);
    }
  });

  app.put(route('/:id'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const before = await loadAdminProject(req, res);
      if (!before) return;
      const body = parseBody(adminProjectSchema, req, res);
      if (!body) return;
      if (body.id !== before.id) return sendBadRequest(res, 'Project ID mismatch');
      // A metadata request: items change through the item endpoints, which
      // keep the server-only text block. A document that carries `items` is
      // refused rather than quietly keeping the stored ones.
      if (req.body?.items !== undefined) {
        return sendErrorResponse(
          res,
          400,
          'Items are changed through the item endpoints, not the project document',
          { details: { code: 'ITEMS_NOT_EDITABLE' } }
        );
      }
      const service = getProjectService();
      const project = await service.updateProject(
        before.id,
        {
          name: body.name,
          description: body.description,
          instructions: body.instructions,
          enabled: body.enabled,
          category: body.category,
          tags: body.tags
        },
        { actor: req.user }
      );
      if (!project) return sendNotFound(res, 'Project');
      logAudit({
        req,
        action: 'update',
        resource: 'project',
        resourceId: project.id,
        summary: `Updated admin project "${projectName(project)}"`
      });
      await snapshot(req, project.id, before, project);
      res.json({ project: adminView(project) });
    } catch (error) {
      sendProjectError(res, error, 'update admin project');
    }
  });

  app.patch(route('/:id'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const before = await loadAdminProject(req, res);
      if (!before) return;
      const body = parseBody(adminProjectUpdateSchema, req, res);
      if (!body) return;
      const project = await getProjectService().updateProject(before.id, body, { actor: req.user });
      if (!project) return sendNotFound(res, 'Project');
      logAudit({
        req,
        action: 'update',
        resource: 'project',
        resourceId: project.id,
        summary: `Updated admin project "${projectName(project)}" (${Object.keys(body).join(', ')})`
      });
      await snapshot(req, project.id, before, project);
      res.json({ project: adminView(project) });
    } catch (error) {
      sendProjectError(res, error, 'update admin project');
    }
  });

  app.delete(route('/:id'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'project', res)) return;
      const repo = getProjectRepository();
      const project = await repo.get(id);
      if (!project) return sendNotFound(res, 'Project');
      if (project.ownership === 'user' && isAdminAuthRequired(req)) {
        return sendNotFound(res, 'Project');
      }
      // A linked admin project answers PROJECT_IN_USE from the service.
      const chats = getChatRepository();
      const deleted = await getProjectService().deleteProject(id, {
        detachChat: chatId => (chats.isAvailable() ? chats.moveProjectIf(chatId, id, null) : null)
      });
      if (!deleted) return sendNotFound(res, 'Project');
      logAudit({
        req,
        action: 'delete',
        resource: 'project',
        resourceId: id,
        summary: `Deleted ${deleted.ownership} project "${projectName(deleted)}"${
          deleted.ownership === 'user'
            ? ` of ${deleted.owner?.name || deleted.owner?.id} (admin)`
            : ''
        }`
      });
      // Admin projects are configuration and keep a change history. A user
      // project deleted here is someone's data: the audit event above is the
      // record, the document itself is not kept.
      if (deleted.ownership === 'admin') await snapshot(req, id, deleted, null);
      res.status(204).end();
    } catch (error) {
      sendProjectError(res, error, 'delete project');
    }
  });

  // --- items of admin projects ---------------------------------------------

  app.post(route('/:id/items'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const project = await loadAdminProject(req, res);
      if (!project) return;
      const body = parseBody(addItemSchema, req, res);
      if (!body) return;
      const { item } = await getProjectService().addItem(project.id, body, { user: req.user });
      logAudit({
        req,
        action: 'create',
        resource: 'projectItem',
        resourceId: project.id,
        summary: `Added ${item.kind} item "${item.name}" to admin project "${projectName(project)}"`
      });
      res.status(item.status === 'ready' ? 201 : 202).json({ item: serializeItem(item) });
    } catch (error) {
      sendProjectError(res, error, 'add project item');
    }
  });

  app.patch(route('/:id/items/:itemId'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const project = await loadAdminProject(req, res);
      if (!project) return;
      const { itemId } = req.params;
      if (!validateIdForPath(itemId, 'item', res)) return;
      const body = parseBody(itemUpdateSchema, req, res);
      if (!body) return;
      const result = await getProjectService().updateItem(project.id, itemId, body, {
        user: req.user
      });
      if (!result) return sendNotFound(res, 'Project');
      res.json({ item: serializeItem(result.item) });
    } catch (error) {
      sendProjectError(res, error, 'update project item');
    }
  });

  app.delete(route('/:id/items/:itemId'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const project = await loadAdminProject(req, res);
      if (!project) return;
      const { itemId } = req.params;
      if (!validateIdForPath(itemId, 'item', res)) return;
      const before = (project.items || []).find(entry => entry.id === itemId);
      const after = await getProjectService().removeItem(project.id, itemId, { user: req.user });
      if (!after) return sendNotFound(res, 'Project');
      logAudit({
        req,
        action: 'delete',
        resource: 'projectItem',
        resourceId: project.id,
        summary: `Removed ${before?.kind || 'item'} "${before?.name || itemId}" from admin project "${projectName(project)}"`
      });
      res.status(204).end();
    } catch (error) {
      sendProjectError(res, error, 'remove project item');
    }
  });
}
