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
import fs from 'node:fs/promises';
import path from 'node:path';
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
import { defaultsDir } from '../../services/projects/projectImport.js';
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
  adminProjectCreateSchema,
  adminProjectSchema,
  adminProjectUpdateSchema,
  describeIssues,
  itemTransferSchema,
  itemUpdateSchema,
  projectMergeSchema,
  toggleSchema
} from '../../validators/projectSchema.js';
import {
  addUploadedItem,
  isMultipart,
  receiveUpload,
  refreshItem,
  replaceItemText,
  sendItemText,
  sendProjectError
} from '../projectItemRoutes.js';
import { getItemText } from '../../services/knowledge/ItemTextService.js';
import { estimateProject } from '../../services/projects/projectEstimate.js';
import { ACCEPTED_TYPES } from '../../services/projects/extractText.js';
import { RESULT_BUDGET_CHARS } from '../../sources/documentRetrieval.js';

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

/** Whether iHub ships a default project with this id. */
async function isShippedProject(id) {
  try {
    await fs.access(path.join(defaultsDir(), 'projects', `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** The apps, workflows and agents a merge re-pointed, for the audit entry. */
function relinkedSummary(sources) {
  const changed = new Set();
  for (const entry of sources) {
    for (const link of entry.relinked || []) changed.add(`${link.type}:${link.id}`);
  }
  return changed.size ? `; re-pointed links of ${[...changed].join(', ')}` : '';
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

  app.get(route('/_config'), ...gate, contentAdminAuth, (req, res) => {
    try {
      const platform = configCache.getPlatform() || {};
      const settings = projectSettings(platform);
      const repo = getProjectRepository();
      res.json({
        upload: {
          available: Boolean(getProjectService().ingest) && repo.hasBlobs(),
          accept: ACCEPTED_TYPES.extensions,
          mimeTypes: ACCEPTED_TYPES.mimeTypes,
          summary: ACCEPTED_TYPES.summary
        },
        scan: { provider: settings.scan.provider },
        limits: settings.limits,
        loadAllMaxTokens: settings.loadAllMaxTokens
      });
    } catch (error) {
      sendFailedOperationError(res, 'load project configuration', error);
    }
  });

  // The sizes the app editor shows beside a linked project (the successor
  // of `/api/admin/sources/_tokens`).
  app.get(route('/_tokens'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const settings = projectSettings(configCache.getPlatform() || {});
      const admin = await getProjectRepository().listAdmin({ includeDisabled: true });
      const projects = {};
      for (const project of admin) {
        const items = project.items || [];
        // A link item is fetched at request time and a pending import has no
        // text yet: their size is not known, so the total is not either (the
        // editor shows "size not known" rather than a too-small number).
        const measured = items.every(item => Number.isFinite(item.text?.tokens));
        projects[project.id] = {
          tokens: measured ? items.reduce((sum, item) => sum + item.text.tokens, 0) : null,
          items: items.length,
          bytes: project.usage?.bytes || 0,
          pending: items.filter(item => item.status === 'pending' || item.status === 'extracting')
            .length,
          links: items.filter(item => item.storage === 'link').length
        };
      }
      res.json({
        loadAllBudgetTokens: settings.loadAllMaxTokens,
        toolResultBudgetTokens: Math.floor(RESULT_BUDGET_CHARS / 4),
        projects
      });
    } catch (error) {
      sendFailedOperationError(res, 'load project token counts', error);
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
   * /api/admin/projects/_merge:
   *   post:
   *     summary: Merge admin projects into one
   *     description: >
   *       Moves every item of the source projects into the target, re-points the
   *       apps, workflows and agents that linked a source to the target and, with
   *       `deleteSources`, deletes the emptied sources. A source whose items did
   *       not all move is left as it is, with its links.
   *     tags: [Admin Projects]
   */
  app.post(route('/_merge'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const body = parseBody(projectMergeSchema, req, res);
      if (!body) return;
      const repo = getProjectRepository();
      const before = new Map();
      for (const id of [body.targetId, ...body.sourceIds]) {
        if (!validateIdForPath(id, 'project', res)) return;
        const project = await repo.get(id);
        if (!project || project.ownership !== 'admin') return sendNotFound(res, 'Project');
        before.set(id, project);
      }
      const result = await getProjectService().mergeProjects(body.sourceIds, body.targetId, {
        user: req.user,
        deleteSources: body.deleteSources
      });
      logAudit({
        req,
        action: 'update',
        resource: 'project',
        resourceId: body.targetId,
        summary: `Merged ${result.sources.length} admin project(s) into "${projectName(result.target)}": ${result.sources
          .map(entry => `${entry.id} (${entry.moved} moved${entry.deleted ? ', deleted' : ''})`)
          .join(', ')}${relinkedSummary(result.sources)}`
      });
      await snapshot(req, body.targetId, before.get(body.targetId), result.target);
      for (const entry of result.sources) {
        const after = entry.deleted ? null : await repo.get(entry.id);
        await snapshot(req, entry.id, before.get(entry.id), after);
      }
      // A project that ships with iHub is copied back at the next start once
      // it is deleted (`copyDefaultConfiguration`); the page says so.
      const sources = await Promise.all(
        result.sources.map(async entry => ({
          ...entry,
          shipped: entry.deleted && (await isShippedProject(entry.id))
        }))
      );
      res.json({ target: adminView(result.target), sources });
    } catch (error) {
      sendProjectError(res, error, 'merge projects');
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
      const body = parseBody(adminProjectCreateSchema, req, res);
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
      // `import` and `managedFile` point the startup importer at a file it
      // reads into the project and then deletes: only the sources migration
      // and the shipped defaults may write them. The strict creation schema
      // refuses them (and every other stored-only field) for API callers.
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

  app.post(
    route('/:id/items'),
    ...gate,
    contentAdminAuth,
    async (req, res, next) => {
      if (!isMultipart(req)) return next();
      const project = await loadAdminProject(req, res);
      if (!project) return;
      req.project = project;
      receiveUpload(req, res, next);
    },
    async (req, res) => {
      if (isMultipart(req)) {
        return addUploadedItem(req, res, { project: req.project, admin: true });
      }
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
    }
  );

  /**
   * @swagger
   * /api/admin/projects/_move:
   *   post:
   *     summary: Move items into another admin project
   *     description: >
   *       Body `{ sourceId, targetId, itemIds }`. The answer lists what
   *       `transferred` and what `failed` (an item still being processed, over the
   *       target's quota, ...); the items that could go went, whatever the others
   *       did. `POST /api/admin/projects/_copy` takes the same body and leaves the
   *       items in the source.
   *     tags: [Admin Projects]
   */
  for (const mode of ['move', 'copy']) {
    app.post(route(`/_${mode}`), ...gate, contentAdminAuth, async (req, res) => {
      try {
        const body = parseBody(itemTransferSchema, req, res);
        if (!body) return;
        if (!validateIdForPath(body.sourceId, 'project', res)) return;
        if (!validateIdForPath(body.targetId, 'project', res)) return;
        const repo = getProjectRepository();
        const [source, target] = await Promise.all([
          repo.get(body.sourceId),
          repo.get(body.targetId)
        ]);
        if (!source || source.ownership !== 'admin') return sendNotFound(res, 'Project');
        if (!target || target.ownership !== 'admin') return sendNotFound(res, 'Target project');
        const result = await getProjectService().transferItems(source.id, body.itemIds, target.id, {
          mode,
          user: req.user
        });
        logAudit({
          req,
          action: 'update',
          resource: 'projectItem',
          resourceId: source.id,
          summary: `${mode === 'move' ? 'Moved' : 'Copied'} ${result.transferred.length} item(s) from admin project "${projectName(source)}" to "${projectName(target)}"${
            result.failed.length ? `; ${result.failed.length} could not be transferred` : ''
          }`
        });
        await snapshot(req, target.id, target, result.target);
        if (mode === 'move') await snapshot(req, source.id, source, result.source);
        res.json({
          transferred: result.transferred,
          failed: result.failed,
          source: adminView(result.source),
          target: adminView(result.target)
        });
      } catch (error) {
        sendProjectError(res, error, `${mode} project items`);
      }
    });
  }

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
      logAudit({
        req,
        action: 'update',
        resource: 'projectItem',
        resourceId: project.id,
        summary: `Changed ${result.item.kind} "${result.item.name || itemId}" (${Object.keys(body).join(', ')}) in admin project "${projectName(project)}"`
      });
      res.json({ item: serializeItem(result.item) });
    } catch (error) {
      sendProjectError(res, error, 'update project item');
    }
  });

  app.get(route('/:id/items/:itemId/text'), ...gate, contentAdminAuth, async (req, res) => {
    const project = await loadAdminProject(req, res);
    if (!project) return;
    return sendItemText(req, res, { project });
  });

  app.put(route('/:id/items/:itemId/text'), ...gate, contentAdminAuth, async (req, res) => {
    const project = await loadAdminProject(req, res);
    if (!project) return;
    return replaceItemText(req, res, { project });
  });

  app.post(route('/:id/items/:itemId/refresh'), ...gate, contentAdminAuth, async (req, res) => {
    const project = await loadAdminProject(req, res);
    if (!project) return;
    return refreshItem(req, res, { project });
  });

  // Read every item the way a chat would, with the admin's own credentials
  // for link kinds: the successor of the sources test button.
  app.post(route('/:id/test'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const project = await loadAdminProject(req, res);
      if (!project) return;
      const started = Date.now();
      const items = [];
      for (const item of project.items || []) {
        const at = Date.now();
        try {
          const { text } = await getItemText(project, item, {
            user: req.user,
            chatId: `admin-project-test-${project.id}-${item.id}`,
            language: req.user?.language || 'en',
            purpose: 'test'
          });
          items.push({
            id: item.id,
            name: item.name,
            kind: item.kind,
            ok: true,
            chars: text.length,
            tokens: item.text?.tokens ?? Math.ceil(text.length / 4),
            duration: Date.now() - at
          });
        } catch (error) {
          items.push({
            id: item.id,
            name: item.name,
            kind: item.kind,
            ok: false,
            error: error.message,
            code: error.code || 'ERROR',
            duration: Date.now() - at
          });
        }
      }
      res.json({
        success: items.every(entry => entry.ok),
        duration: Date.now() - started,
        items
      });
    } catch (error) {
      sendFailedOperationError(res, 'test project', error);
    }
  });

  // Load every item, count its tokens and say whether the text belongs in
  // the prompt (link items are fetched, iFinder ones with the admin's rights).
  app.post(route('/:id/estimate'), ...gate, contentAdminAuth, async (req, res) => {
    try {
      const project = await loadAdminProject(req, res);
      if (!project) return;
      const settings = projectSettings(configCache.getPlatform() || {});
      res.json(
        await estimateProject(project, {
          user: req.user,
          language: req.user?.language || 'en',
          budgetTokens: settings.loadAllMaxTokens,
          toolResultBudgetTokens: Math.floor(RESULT_BUDGET_CHARS / 4)
        })
      );
    } catch (error) {
      sendFailedOperationError(res, 'estimate project tokens', error);
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
