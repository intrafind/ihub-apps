// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The projects API — `/api/projects` (#1036, spec 1 §5.1).
 *
 * A **project** is the one container for documents, instructions and chats.
 * User projects are user data, private until shared with users, groups or
 * everyone as *editor* or *user*; admin projects are configuration an admin
 * links to apps, workflows and agents, readable through those links. Both
 * come out of this API with the `permissions` the caller has on them; every
 * ownership and member check runs on the server, through
 * `projectAccessRequired`, and the client only uses `permissions` to show or
 * hide actions.
 *
 * @module routes/projectRoutes
 */
import configCache from '../configCache.js';
import { authenticatedOnly } from '../middleware/authRequired.js';
import {
  callerContext,
  ensurePrincipal,
  isActiveUser,
  permissionsFor,
  projectAccessRequired,
  usersDb
} from '../middleware/projectAccess.js';
import { requireFeature } from '../featureRegistry.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendFailedOperationError,
  sendNotFound
} from '../utils/responseHelpers.js';
import { logAudit } from '../services/AuditLogService.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { resolvePrincipal } from '../services/loop/runIdentity.js';
import { resolveShares } from './promptRoutes.js';
import { getProjectRepository, isUserProjectId } from '../services/projects/ProjectRepository.js';
import { getProjectService } from '../services/projects/ProjectService.js';
import {
  addUploadedItem,
  isMultipart,
  receiveUpload,
  refreshItem,
  registerProjectPickerRoutes,
  sendItemText,
  sendProjectError
} from './projectItemRoutes.js';
import {
  UNSHAREABLE_GROUPS,
  canHoldProjects,
  mayCreateProjects,
  mayShareProjects,
  memberRoleFor,
  principalMemberKeys
} from '../services/projects/projectAccess.js';
import {
  PROJECTS_FEATURE,
  isUserProjectsConfigured,
  projectSettings,
  projectsClientConfig
} from '../services/projects/projectSettings.js';
import { enabledItemKinds } from '../services/projects/kinds/registry.js';
import { ACCEPTED_TYPES } from '../services/projects/extractText.js';
import { projectName, serializeItem, serializeProject } from '../services/projects/projectView.js';
import {
  addItemSchema,
  adminProjectUpdateSchema,
  describeIssues,
  itemUpdateSchema,
  membersUpdateSchema,
  transferSchema,
  userProjectCreateSchema,
  userProjectUpdateSchema
} from '../validators/projectSchema.js';

/** Scopes `GET /api/projects?scope=` accepts. */
export const LIST_SCOPES = Object.freeze(['all', 'mine', 'shared', 'admin']);

const LOOKUP_LIMIT = 10;
const LOOKUP_MIN_CHARS = 2;
const LOOKUP_MAX_CHARS = 100;

function displayName(user) {
  return String(user?.name || user?.displayName || user?.username || user?.id || '');
}

function parseBody(schema, req, res) {
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    sendBadRequest(res, `Invalid request: ${describeIssues(parsed.error)}`);
    return null;
  }
  return parsed.data;
}

export { sendProjectError };

/**
 * Gate for every route that reads or writes user projects. Sends the refusal
 * itself and returns null when the request cannot go on.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {{manage?: boolean}} [options] - The route manages an existing
 *   project; admins pass even when user projects are switched off.
 * @returns {{repo: import('../services/projects/ProjectRepository.js').ProjectRepository,
 *   service: import('../services/projects/ProjectService.js').ProjectService,
 *   settings: ReturnType<typeof projectSettings>}|null}
 */
function requireUserProjects(req, res, { manage = false } = {}) {
  ensurePrincipal(req);
  if (!canHoldProjects(req.user)) {
    sendErrorResponse(res, 403, 'This sign-in cannot hold projects', {
      details: { code: 'PROJECTS_NOT_ALLOWED' }
    });
    return null;
  }
  if (!isUserProjectsConfigured(configCache.getFeatures())) {
    if (!manage || !callerContext(req.user).isAdmin) {
      sendErrorResponse(res, 403, 'User projects are switched off', {
        details: { code: 'USER_PROJECTS_DISABLED' }
      });
      return null;
    }
  }
  const repo = getProjectRepository();
  if (!repo.isAvailable()) {
    sendErrorResponse(res, 503, 'Projects are unavailable on this installation', {
      details: { code: 'STORAGE_UNAVAILABLE' }
    });
    return null;
  }
  return {
    repo,
    service: getProjectService(),
    settings: projectSettings(configCache.getPlatform() || {})
  };
}

/** What a caller may share with right now. */
function allowedTargetsFor(settings, user) {
  const may = mayShareProjects(user);
  return {
    user: may && settings.sharing.allowUsers,
    group: may && settings.sharing.allowGroups,
    everyone: may && settings.sharing.allowEveryone
  };
}

function serializeFor(project, user, context, options = {}) {
  const permissions = permissionsFor(project, user, context);
  const ownerActive =
    project.ownership === 'user' && project.owner?.id
      ? isActiveUser(context.users, project.owner.id)
      : true;
  return serializeProject(project, permissions, { ownerActive, ...options });
}

/**
 * The projects the caller may use: owned, shared with them, and admin
 * projects reached through their apps, workflows and agents.
 */
async function listProjects(user, repo, scope) {
  const context = callerContext(user);
  const items = [];
  if (scope === 'all' || scope === 'mine') {
    for (const project of await repo.listOwned(String(user.id))) {
      items.push(serializeFor(project, user, context, { includeItems: false }));
    }
  }
  if (scope === 'all' || scope === 'shared') {
    const candidates = await repo.listSharedWith(principalMemberKeys(user, context.groups));
    for (const project of candidates) {
      if (String(project.owner?.id) === String(user.id)) continue;
      // The membership is what earns a place in "shared with me".
      if (!memberRoleFor(project, user, context.groups)) continue;
      items.push(serializeFor(project, user, context, { includeItems: false }));
    }
  }
  if (scope === 'all' || scope === 'admin') {
    for (const project of await repo.listAdmin({ includeDisabled: false })) {
      if (!context.linked.has(project.id) && !context.isContentAdmin) continue;
      items.push(serializeFor(project, user, context, { includeItems: false }));
    }
  }
  return items.sort((a, b) =>
    String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''))
  );
}

/**
 * Register the `/api/projects` endpoints.
 *
 * @param {import('express').Application} app
 */
export default function registerProjectRoutes(app) {
  const gate = [requireFeature(PROJECTS_FEATURE)];
  const route = suffix => buildServerPath(`/api/projects${suffix}`);
  // `/api/projects/pickers/*` must be registered before `/:projectId`.
  registerProjectPickerRoutes(app);

  /**
   * @swagger
   * /api/projects/_config:
   *   get:
   *     summary: What projects this installation offers
   *     tags: [Projects]
   *     responses:
   *       200:
   *         description: Flags, limits, sharing audiences and the enabled item kinds
   */
  app.get(route('/_config'), ...gate, authenticatedOnly, async (req, res) => {
    try {
      ensurePrincipal(req);
      const platform = configCache.getPlatform() || {};
      const features = configCache.getFeatures();
      const repo = getProjectRepository();
      const settings = projectSettings(platform);
      const base = projectsClientConfig(features, platform, {
        storageAvailable: repo.isAvailable()
      });
      const used = base.userProjects ? await repo.countOwned(String(req.user.id)) : 0;
      res.json({
        ...base,
        userProjects: {
          enabled: base.userProjects,
          canCreate: base.userProjects && mayCreateProjects(req.user),
          canShare: base.userProjects && mayShareProjects(req.user),
          maxProjects: settings.limits.maxProjectsPerUser,
          used
        },
        kinds: enabledItemKinds({ platform, features, settings }),
        upload: {
          available: Boolean(getProjectService().ingest) && repo.hasBlobs(),
          accept: ACCEPTED_TYPES.extensions,
          mimeTypes: ACCEPTED_TYPES.mimeTypes,
          summary: ACCEPTED_TYPES.summary
        }
      });
    } catch (error) {
      sendFailedOperationError(res, 'load project configuration', error);
    }
  });

  /**
   * @swagger
   * /api/projects/share-targets:
   *   get:
   *     summary: Users and groups a project can be shared with
   *     tags: [Projects]
   */
  app.get(route('/share-targets'), ...gate, authenticatedOnly, (req, res) => {
    try {
      const deps = requireUserProjects(req, res, { manage: true });
      if (!deps) return;
      const context = callerContext(req.user);
      const allowed = allowedTargetsFor(deps.settings, req.user);
      const raw = typeof req.query.q === 'string' ? req.query.q : '';
      const q = raw.trim().slice(0, LOOKUP_MAX_CHARS).toLowerCase();
      let users = [];
      if (allowed.user && q.length >= LOOKUP_MIN_CHARS) {
        const me = String(req.user.id);
        users = Object.entries(context.users)
          .map(([id, user]) => ({ ...user, id: String(user?.id ?? id) }))
          .filter(user => user && user.active !== false && user.id !== me)
          .filter(user =>
            [user.name, user.username, user.email].some(
              field => typeof field === 'string' && field.toLowerCase().includes(q)
            )
          )
          .map(user => ({
            id: user.id,
            name: displayName(user),
            email: user.email ? String(user.email) : null
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, LOOKUP_LIMIT);
      }
      let groups = [];
      if (allowed.group) {
        groups = Object.entries(context.config.groups || {})
          .filter(([id]) => !UNSHAREABLE_GROUPS.includes(id))
          .map(([id, group]) => ({
            id,
            name: String(group?.name || id),
            description: group?.description ? String(group.description) : ''
          }))
          .filter(
            group =>
              !q || group.name.toLowerCase().includes(q) || group.id.toLowerCase().includes(q)
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, LOOKUP_LIMIT);
      }
      res.json({ allowed, users, groups });
    } catch (error) {
      sendFailedOperationError(res, 'look up share targets', error);
    }
  });

  /**
   * @swagger
   * /api/projects:
   *   get:
   *     summary: The projects the caller may use
   *     tags: [Projects]
   *     parameters:
   *       - in: query
   *         name: scope
   *         schema: { type: string, enum: [all, mine, shared, admin] }
   */
  app.get(route(''), ...gate, authenticatedOnly, async (req, res) => {
    try {
      ensurePrincipal(req);
      const scope = LIST_SCOPES.includes(req.query.scope) ? req.query.scope : 'all';
      const repo = getProjectRepository();
      if (!canHoldProjects(req.user)) return res.json({ items: [], nextCursor: null });
      const userProjectsOn =
        isUserProjectsConfigured(configCache.getFeatures()) && repo.isAvailable();
      // Without user projects there is nothing owned or shared: those scopes
      // answer empty rather than the admin projects the caller did not ask for.
      if (!userProjectsOn && (scope === 'mine' || scope === 'shared')) {
        return res.json({ items: [], nextCursor: null });
      }
      const effectiveScope = userProjectsOn ? scope : 'admin';
      const items = await listProjects(req.user, repo, effectiveScope);
      res.json({ items, nextCursor: null });
    } catch (error) {
      sendFailedOperationError(res, 'list projects', error);
    }
  });

  /**
   * @swagger
   * /api/projects:
   *   post:
   *     summary: Create a project
   *     tags: [Projects]
   *     responses:
   *       201:
   *         description: The created project
   *       409:
   *         description: The per-user project limit is reached
   */
  app.post(route(''), ...gate, authenticatedOnly, async (req, res) => {
    try {
      const deps = requireUserProjects(req, res);
      if (!deps) return;
      if (!mayCreateProjects(req.user)) {
        return sendErrorResponse(res, 403, 'You may not create projects', {
          details: { code: 'PERMISSION_DENIED' }
        });
      }
      const body = parseBody(userProjectCreateSchema, req, res);
      if (!body) return;
      const project = await deps.service.createUserProject({ owner: req.user, content: body });
      logAudit({
        req,
        action: 'create',
        resource: 'project',
        resourceId: project.id,
        summary: `Created project "${project.name}"`
      });
      const context = callerContext(req.user);
      res.status(201).json(serializeFor(project, req.user, context));
    } catch (error) {
      sendProjectError(res, error, 'create project');
    }
  });

  app.get(
    route('/:projectId'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('use'),
    (req, res) => {
      try {
        res.json(serializeFor(req.project, req.user, req.projectContext));
      } catch (error) {
        sendFailedOperationError(res, 'get project', error);
      }
    }
  );

  app.patch(
    route('/:projectId'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('edit'),
    async (req, res) => {
      try {
        // An admin project keeps the admin document's shape (localized
        // names), whoever edits it.
        const schema =
          req.project.ownership === 'admin' ? adminProjectUpdateSchema : userProjectUpdateSchema;
        const body = parseBody(schema, req, res);
        if (!body) return;
        const service = getProjectService();
        const project = await service.updateProject(req.project.id, body, {
          actor: req.user,
          authorize: req.projectContext.authorize('edit')
        });
        if (!project) return sendNotFound(res, 'Project');
        logAudit({
          req,
          action: 'update',
          resource: 'project',
          resourceId: project.id,
          summary: `Updated project "${projectName(project)}" (${Object.keys(body).join(', ')})`
        });
        res.json(serializeFor(project, req.user, req.projectContext));
      } catch (error) {
        sendProjectError(res, error, 'update project');
      }
    }
  );

  app.delete(
    route('/:projectId'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('own'),
    async (req, res) => {
      try {
        const service = getProjectService();
        const chats = getChatRepository();
        const project = await service.deleteProject(req.project.id, {
          authorize: req.projectContext.authorize('own'),
          detachChat: chatId =>
            chats.isAvailable() ? chats.moveProjectIf(chatId, req.project.id, null) : null
        });
        if (!project) return sendNotFound(res, 'Project');
        logAudit({
          req,
          action: 'delete',
          resource: 'project',
          resourceId: project.id,
          summary: `Deleted ${project.ownership} project "${projectName(project)}" with ${(project.items || []).length} items`
        });
        res.status(204).end();
      } catch (error) {
        sendProjectError(res, error, 'delete project');
      }
    }
  );

  // --- items --------------------------------------------------------------

  app.get(
    route('/:projectId/items'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('use'),
    (req, res) => {
      res.json({ items: (req.project.items || []).map(serializeItem) });
    }
  );

  app.post(
    route('/:projectId/items'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('edit'),
    (req, res, next) => (isMultipart(req) ? receiveUpload(req, res, next) : next()),
    async (req, res) => {
      if (isMultipart(req)) {
        return addUploadedItem(req, res, {
          project: req.project,
          authorize: req.projectContext.authorize('edit')
        });
      }
      try {
        const body = parseBody(addItemSchema, req, res);
        if (!body) return;
        const service = getProjectService();
        const { item } = await service.addItem(req.project.id, body, {
          user: req.user,
          authorize: req.projectContext.authorize('edit')
        });
        logAudit({
          req,
          action: 'create',
          resource: 'projectItem',
          resourceId: req.project.id,
          summary: `Added ${item.kind} item "${item.name}" (${item.provenance.origin}) to project "${projectName(req.project)}"`
        });
        res.status(item.status === 'ready' ? 201 : 202).json({ item: serializeItem(item) });
      } catch (error) {
        sendProjectError(res, error, 'add project item');
      }
    }
  );

  app.get(
    route('/:projectId/items/:itemId'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('use'),
    (req, res) => {
      const { itemId } = req.params;
      if (!validateIdForPath(itemId, 'item', res)) return;
      const item = (req.project.items || []).find(entry => entry.id === itemId);
      if (!item) return sendNotFound(res, 'Item');
      res.json(serializeItem(item));
    }
  );

  app.patch(
    route('/:projectId/items/:itemId'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('edit'),
    async (req, res) => {
      try {
        const { itemId } = req.params;
        if (!validateIdForPath(itemId, 'item', res)) return;
        const body = parseBody(itemUpdateSchema, req, res);
        if (!body) return;
        const result = await getProjectService().updateItem(req.project.id, itemId, body, {
          user: req.user,
          authorize: req.projectContext.authorize('edit')
        });
        if (!result) return sendNotFound(res, 'Project');
        logAudit({
          req,
          action: 'update',
          resource: 'projectItem',
          resourceId: req.project.id,
          summary: `Changed ${result.item.kind} "${result.item.name || itemId}" (${Object.keys(body).join(', ')}) in project "${projectName(req.project)}"`
        });
        res.json(serializeItem(result.item));
      } catch (error) {
        sendProjectError(res, error, 'update project item');
      }
    }
  );

  app.get(
    route('/:projectId/items/:itemId/text'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('use'),
    (req, res) => sendItemText(req, res, { project: req.project })
  );

  app.post(
    route('/:projectId/items/:itemId/refresh'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('edit'),
    (req, res) =>
      refreshItem(req, res, {
        project: req.project,
        authorize: req.projectContext.authorize('edit')
      })
  );

  app.delete(
    route('/:projectId/items/:itemId'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('edit'),
    async (req, res) => {
      try {
        const { itemId } = req.params;
        if (!validateIdForPath(itemId, 'item', res)) return;
        const before = (req.project.items || []).find(entry => entry.id === itemId);
        const project = await getProjectService().removeItem(req.project.id, itemId, {
          user: req.user,
          authorize: req.projectContext.authorize('edit')
        });
        if (!project) return sendNotFound(res, 'Project');
        logAudit({
          req,
          action: 'delete',
          resource: 'projectItem',
          resourceId: project.id,
          summary: `Removed ${before?.kind || 'item'} "${before?.name || itemId}" from project "${projectName(project)}"`
        });
        res.status(204).end();
      } catch (error) {
        sendProjectError(res, error, 'remove project item');
      }
    }
  );

  // --- members --------------------------------------------------------------

  app.put(
    route('/:projectId/members'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('share'),
    async (req, res) => {
      try {
        const deps = requireUserProjects(req, res, { manage: true });
        if (!deps) return;
        if (!isUserProjectId(req.project.id)) {
          return sendErrorResponse(res, 403, 'Admin projects have no members', {
            details: { code: 'PERMISSION_DENIED' }
          });
        }
        const body = parseBody(membersUpdateSchema, req, res);
        if (!body) return;
        // `resolveShares` wants `permission`; members carry `role`. Same
        // resolution (known active users, existing groups, never the owner),
        // then the role is put back.
        const resolved = resolveShares(
          body.members.map(member => ({
            ...member,
            permission: member.role === 'editor' ? 'edit' : 'use'
          })),
          {
            prompt: {
              ownerId: req.project.owner?.id,
              shares: (req.project.members || []).map(m => ({
                ...m,
                permission: m.role === 'editor' ? 'edit' : 'use'
              }))
            },
            allowed: allowedTargetsFor(deps.settings, req.user),
            users: usersDb(),
            groups: req.projectContext.config.groups || {},
            noun: 'projects'
          }
        );
        if (!resolved.ok) {
          return sendErrorResponse(res, resolved.status, resolved.error, {
            details: { code: 'SHARE_TARGET_INVALID', ...(resolved.details || {}) }
          });
        }
        const members = resolved.shares.map(({ permission, ...share }) => ({
          ...share,
          role: permission === 'edit' ? 'editor' : 'user'
        }));
        const result = await deps.service.setMembers(req.project.id, members, {
          user: req.user,
          authorize: req.projectContext.authorize('share')
        });
        if (!result) return sendNotFound(res, 'Project');
        const changed = result.changed || [];
        if (result.added.length || result.removed.length || changed.length) {
          const everyone = result.project.members.some(member => member.type === 'everyone');
          logAudit({
            req,
            action: 'share',
            resource: 'projectShare',
            resourceId: result.project.id,
            summary:
              `Changed members of project "${result.project.name}": ` +
              `${result.added.length} added, ${result.removed.length} removed, ` +
              `${changed.length} role${changed.length === 1 ? '' : 's'} changed` +
              `${everyone ? ' (shared with everyone)' : ''}`
          });
        }
        res.json(serializeFor(result.project, req.user, req.projectContext));
      } catch (error) {
        sendProjectError(res, error, 'change project members');
      }
    }
  );

  app.post(
    route('/:projectId/transfer'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('own'),
    async (req, res) => {
      try {
        const deps = requireUserProjects(req, res, { manage: true });
        if (!deps) return;
        const body = parseBody(transferSchema, req, res);
        if (!body) return;
        const users = usersDb();
        const target = Object.hasOwn(users, body.ownerId) ? users[body.ownerId] : null;
        if (!target || target.active === false) {
          return sendBadRequest(res, 'The new owner is not a known, active user');
        }
        if (String(body.ownerId) === String(req.project.owner?.id)) {
          return sendBadRequest(res, 'This user already owns the project');
        }
        const project = await deps.service.transfer(
          req.project.id,
          { id: body.ownerId, name: displayName({ ...target, id: body.ownerId }) },
          { user: req.user, authorize: req.projectContext.authorize('own') }
        );
        if (!project) return sendNotFound(res, 'Project');
        logAudit({
          req,
          action: 'update',
          resource: 'projectShare',
          resourceId: project.id,
          summary: `Transferred project "${project.name}" to ${project.owner.name || project.owner.id}`
        });
        // The caller may no longer see it; answer with what they have left.
        const context = callerContext(req.user);
        const permissions = permissionsFor(project, req.user, context);
        res.json(
          permissions.canView
            ? serializeFor(project, req.user, context)
            : { id: project.id, transferred: true }
        );
      } catch (error) {
        sendProjectError(res, error, 'transfer project');
      }
    }
  );

  // --- chats ----------------------------------------------------------------

  /**
   * @swagger
   * /api/projects/{projectId}/chats:
   *   get:
   *     summary: The chats inside a project
   *     tags: [Projects]
   *     parameters:
   *       - in: query
   *         name: filter
   *         schema: { type: string, enum: [all, mine, others] }
   */
  app.get(
    route('/:projectId/chats'),
    ...gate,
    authenticatedOnly,
    projectAccessRequired('use'),
    async (req, res) => {
      try {
        const chats = getChatRepository();
        if (!chats.isAvailable()) return res.json({ items: [], nextCursor: null });
        const filter = ['all', 'mine', 'others'].includes(req.query.filter)
          ? req.query.filter
          : 'all';
        const markers = await getProjectRepository().listChatMarkers(req.project.id);
        const me = String(req.user.id);
        // A chat records its owner in the identity mode of its day (a
        // pseudonymized chat keeps a fingerprint), so the caller is resolved
        // per chat the way `authorizeChat` does, not compared by raw id.
        const principals = new Map();
        const principalIdFor = async mode => {
          const key = mode || 'default';
          if (!principals.has(key)) {
            principals.set(key, (await resolvePrincipal(req.user, { mode: key })).id);
          }
          return principals.get(key);
        };
        const items = [];
        for (const marker of markers) {
          const chat = await chats.getChat(marker.chatId);
          // The chat decides; a marker it no longer backs is pruned on the
          // way, judged again under the chat's lock so a move that is still
          // settling (or has moved the chat back since) keeps its marker.
          if (!chat || chat.projectId !== req.project.id) {
            await chats
              .unlessInProject(marker.chatId, req.project.id, () =>
                getProjectRepository().removeChatMarker(req.project.id, marker.chatId)
              )
              .catch(() => {});
            continue;
          }
          const principalId = await principalIdFor(chat.identityMode);
          const mine =
            String(chat.ownerId) === principalId || String(marker.ownerId) === principalId;
          if ((filter === 'mine' && !mine) || (filter === 'others' && mine)) continue;
          items.push({
            id: chat.id,
            title: chat.title || '',
            appId: chat.appId || null,
            createdAt: chat.createdAt,
            lastMessageAt: chat.lastMessageAt || chat.updatedAt || chat.createdAt,
            messageCount: chat.messageCount || 0,
            status: chat.status || 'active',
            owner: { id: mine ? me : null, name: chat.ownerName || '', mine }
          });
        }
        items.sort((a, b) =>
          String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''))
        );
        res.json({ items, nextCursor: null });
      } catch (error) {
        sendFailedOperationError(res, 'list project chats', error);
      }
    }
  );
}
