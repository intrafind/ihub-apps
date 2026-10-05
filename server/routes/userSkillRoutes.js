/**
 * User skills API — `/api/user-skills`: skills users write themselves.
 *
 * The same ownership model as user prompts (`promptRoutes.js`): a skill is
 * private to its owner until it is shared with users, groups or everyone
 * signed in, as *can use* or *can edit*; owners and admins delete it or hand
 * it to someone else; every change is a revision that can be restored. Admins
 * (full or content admins) manage user skills through the same routes, and
 * promote one to a global skill under `/api/admin/user-skills`.
 *
 * Global skills (folders under `contents/skills/`) keep their read-only API
 * under `/api/skills`; user skills live under their own path so a global skill
 * name can never collide with a route. A user skill id always starts with
 * `usk_`.
 *
 * Every ownership and share check runs here; the client only uses the
 * returned `permissions` to show or hide actions.
 *
 * @module routes/userSkillRoutes
 */
import configCache from '../configCache.js';
import { authenticatedOnly } from '../middleware/authRequired.js';
import { requireFeature } from '../featureRegistry.js';
import { buildServerPath } from '../utils/basePath.js';
import { validateIdForPath } from '../utils/pathSecurity.js';
import { enhanceUserWithPermissions, loadGroupsConfiguration } from '../utils/authorization.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendFailedOperationError,
  sendNotFound
} from '../utils/responseHelpers.js';
import { logAudit } from '../services/AuditLogService.js';
import { loadUsers } from '../utils/userManager.js';
import { localUsersFile } from '../utils/contentsPath.js';
import { StorageError, storageHttpStatus } from '../storage/errors.js';
import { getSkillContent, getSkillResource } from '../services/skillLoader.js';
import {
  ACCESS_CHANGED,
  getUserSkillRepository,
  isUserSkillId
} from '../services/skills/UserSkillRepository.js';
import {
  UNSHAREABLE_GROUPS,
  canHoldUserPrompts as canHoldUserSkills,
  effectiveGroups,
  isPromptAdmin as isSkillAdmin,
  principalShareKeys,
  sharePermissionFor,
  userPromptPermissions as userSkillPermissions
} from '../services/prompts/userPromptAccess.js';
import {
  SKILLS_FEATURE,
  allowedSkillShareTargets,
  isUserSkillsConfigured,
  userSkillSettings
} from '../services/skills/userSkillSettings.js';
import { serializeUserSkill, skillSize } from '../services/skills/userSkillView.js';
import {
  SKILL_FILE_PATH_PATTERN,
  SKILL_NAME_PATTERN,
  describeIssues,
  skillDuplicateSchema,
  skillSharesUpdateSchema,
  skillTransferSchema,
  userSkillContentSchema,
  userSkillUpdateSchema
} from '../validators/userSkillSchema.js';
import { resolveShares } from './promptRoutes.js';

/** Scopes `GET /api/user-skills?scope=` accepts. */
export const LIST_SCOPES = Object.freeze(['all', 'mine', 'shared']);

/** Users one share-target lookup returns, and the query length it needs. */
const LOOKUP_LIMIT = 10;
const LOOKUP_MIN_CHARS = 2;
const LOOKUP_MAX_CHARS = 100;

function ensurePrincipal(req) {
  const platformConfig = configCache.getPlatform() || {};
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, platformConfig.auth || {}, platformConfig);
  }
}

function groupsConfig() {
  try {
    return loadGroupsConfiguration();
  } catch {
    return { groups: {} };
  }
}

function usersDb() {
  const platform = configCache.getPlatform() || {};
  return loadUsers(localUsersFile(platform.localAuth)).users || {};
}

function findUser(users, id) {
  return Object.hasOwn(users, id) ? users[id] : null;
}

function isActiveUser(users, id) {
  const user = findUser(users, id);
  return Boolean(user) && user.active !== false;
}

function displayName(user) {
  return String(user?.name || user?.displayName || user?.username || user?.id || '');
}

function actorOf(user) {
  return { id: String(user.id), name: displayName(user) };
}

/** The caller's effective groups and whether they administer skills. */
function callerContext(user) {
  const config = groupsConfig();
  return { config, groups: effectiveGroups(user, config), isAdmin: isSkillAdmin(user, config) };
}

/**
 * Gate for every route that reads or writes user skills. Sends the refusal
 * itself and returns null when the request cannot go on. With user skills
 * switched off, admins still look after the ones that exist (`manage`).
 */
function requireUserSkills(req, res, { manage = false } = {}) {
  if (!canHoldUserSkills(req.user)) {
    sendErrorResponse(res, 403, 'This sign-in cannot hold user skills', {
      details: { code: 'USER_SKILLS_NOT_ALLOWED' }
    });
    return null;
  }
  ensurePrincipal(req);
  if (!isUserSkillsConfigured(configCache.getFeatures(), configCache.getPlatform() || {})) {
    if (!manage || !isSkillAdmin(req.user, groupsConfig())) {
      sendErrorResponse(res, 403, 'User skills are switched off', {
        details: { code: 'USER_SKILLS_DISABLED' }
      });
      return null;
    }
  }
  const repo = getUserSkillRepository();
  if (!repo.isAvailable()) {
    sendErrorResponse(res, 503, 'User skills are unavailable', {
      details: { code: 'USER_SKILLS_UNAVAILABLE' }
    });
    return null;
  }
  return { repo, settings: userSkillSettings(configCache.getPlatform() || {}) };
}

function sendStorageError(res, error, operation) {
  if (error instanceof StorageError) {
    if (error.code === 'REVISION_CONFLICT') {
      return sendErrorResponse(res, 409, error.message, { details: { code: error.code } });
    }
    if (error.code === ACCESS_CHANGED) {
      return sendErrorResponse(res, 403, error.message, { details: { code: error.code } });
    }
    const status = storageHttpStatus(error);
    if (status) {
      return sendErrorResponse(res, status, error.message, { details: { code: error.code } });
    }
  }
  return sendFailedOperationError(res, operation, error);
}

function parseBody(schema, req, res) {
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    sendBadRequest(res, `Invalid request: ${describeIssues(parsed.error)}`);
    return null;
  }
  return parsed.data;
}

/** Refuse content beyond the size and file limits; true when refused. */
function refuseTooLarge(res, content, settings) {
  const files = content.files || [];
  if (files.length > settings.maxFilesPerSkill) {
    sendErrorResponse(res, 400, `A skill can have at most ${settings.maxFilesPerSkill} files`, {
      details: { code: 'SKILL_TOO_LARGE', maxFilesPerSkill: settings.maxFilesPerSkill }
    });
    return true;
  }
  if (skillSize(content) > settings.maxSkillSizeKB * 1024) {
    sendErrorResponse(
      res,
      400,
      `A skill can be at most ${settings.maxSkillSizeKB} KB, instructions and files together`,
      { details: { code: 'SKILL_TOO_LARGE', maxSkillSizeKB: settings.maxSkillSizeKB } }
    );
    return true;
  }
  return false;
}

/** Refuse one more skill for a user past the per-user limit; true when refused. */
async function refuseOverLimit(res, repo, settings, ownerId, message) {
  if (settings.maxSkillsPerUser <= 0) return false;
  if ((await repo.countOwned(ownerId)) < settings.maxSkillsPerUser) return false;
  sendErrorResponse(
    res,
    409,
    message || `You can keep at most ${settings.maxSkillsPerUser} skills — delete one to make room`,
    { details: { code: 'SKILL_LIMIT_REACHED', limit: settings.maxSkillsPerUser } }
  );
  return true;
}

function refuse(res, message, code = 'SKILL_FORBIDDEN') {
  return sendErrorResponse(res, 403, message, { details: { code } });
}

/**
 * Load one user skill and what the caller may do with it. Sends a 404 —
 * never a 403, so an id nobody shared with the caller confirms nothing.
 */
async function loadUserSkill(req, res, repo) {
  const skill = await repo.get(req.params.skillId);
  const context = callerContext(req.user);
  const ownerActive = skill ? isActiveUser(usersDb(), skill.ownerId) : true;
  const permissions = userSkillPermissions(skill, req.user, {
    groups: context.groups,
    isAdmin: context.isAdmin,
    ownerActive
  });
  if (!skill || !permissions.canView) {
    sendNotFound(res, 'Skill');
    return null;
  }
  return { skill, permissions, context, ownerActive };
}

/** The permission check again, for the repository to run under its lock. */
function stillAllowed(req, context, permission) {
  return skill =>
    Boolean(
      userSkillPermissions(skill, req.user, {
        groups: context.groups,
        isAdmin: context.isAdmin,
        ownerActive: isActiveUser(usersDb(), skill.ownerId)
      })[permission]
    );
}

function view(skill, req, context, { ownerActive = true, includeContent = false } = {}) {
  return serializeUserSkill(
    skill,
    userSkillPermissions(skill, req.user, {
      groups: context.groups,
      isAdmin: context.isAdmin,
      ownerActive
    }),
    { ownerActive, includeContent }
  );
}

/**
 * The user skills the caller owns and those shared with them, each with its
 * permissions. The share list on the skill decides, not the marker.
 */
async function listUserSkills(user, repo) {
  const context = callerContext(user);
  const owned = await repo.listOwned(String(user.id));
  const ownedIds = new Set(owned.map(skill => skill.id));
  const candidates = await repo.listSharedWith(principalShareKeys(user, context.groups));
  const users = candidates.length ? usersDb() : {};
  const items = owned.map(skill =>
    serializeUserSkill(
      skill,
      userSkillPermissions(skill, user, { groups: context.groups, isAdmin: context.isAdmin })
    )
  );
  for (const skill of candidates) {
    if (ownedIds.has(skill.id)) continue;
    if (!sharePermissionFor(skill, user, context.groups)) continue;
    const ownerActive = isActiveUser(users, skill.ownerId);
    items.push(
      serializeUserSkill(
        skill,
        userSkillPermissions(skill, user, {
          groups: context.groups,
          isAdmin: context.isAdmin,
          ownerActive
        }),
        { ownerActive }
      )
    );
  }
  return items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function allowedTargetsFor(settings, context) {
  if (context.isAdmin) {
    return {
      user: settings.sharing.allowUsers,
      group: settings.sharing.allowGroups,
      everyone: settings.sharing.allowEveryone
    };
  }
  return allowedSkillShareTargets(settings, context.groups);
}

/** A content payload with every optional field present. */
function normalizeContent(content) {
  return { ...content, files: content.files || [] };
}

/**
 * The content of a global skill as a user skill: its instructions and the
 * text files a user skill can hold. Binary files and nested folders are left
 * out — a user skill keeps text files one folder deep.
 */
async function contentOfGlobalSkill(name, settings) {
  const content = await getSkillContent(name);
  if (!content) return null;
  const files = [];
  for (const path of [...content.references, ...content.scripts, ...content.assets]) {
    if (files.length >= settings.maxFilesPerSkill) break;
    if (!SKILL_FILE_PATH_PATTERN.test(path)) continue;
    const text = await getSkillResource(name, path);
    if (typeof text === 'string') files.push({ path, content: text });
  }
  return {
    name,
    description: String(content.description || '').slice(0, 1024),
    body: content.body || '',
    files
  };
}

/** Copy of a skill, owned by the caller; sends the response itself. */
async function createCopy(req, res, deps, content, copiedFrom, auditSummary) {
  if (refuseTooLarge(res, content, deps.settings)) return;
  if (await refuseOverLimit(res, deps.repo, deps.settings, String(req.user.id))) return;
  const skill = await deps.repo.create({
    owner: actorOf(req.user),
    content,
    copiedFrom,
    maxVersions: deps.settings.maxVersions
  });
  if (!skill) {
    return sendErrorResponse(res, 503, 'User skills are unavailable', {
      details: { code: 'USER_SKILLS_UNAVAILABLE' }
    });
  }
  logAudit({
    req,
    action: 'create',
    resource: 'userSkill',
    resourceId: skill.id,
    summary: auditSummary(skill)
  });
  res.status(201).json(view(skill, req, callerContext(req.user), { includeContent: true }));
}

export default function registerUserSkillRoutes(app) {
  const gate = [requireFeature(SKILLS_FEATURE), authenticatedOnly];

  /**
   * @swagger
   * /api/user-skills:
   *   get:
   *     summary: The caller's own and shared user skills
   *     tags:
   *       - Skills
   *     parameters:
   *       - in: query
   *         name: scope
   *         schema:
   *           type: string
   *           enum: [all, mine, shared]
   *   post:
   *     summary: Create a user skill
   *     description: |
   *       Creates a skill owned by the caller, private until it is shared.
   *       Body `{ name, description, body, files? }` — `files` are text files
   *       under `references/`, `assets/` or `scripts/`.
   *     tags:
   *       - Skills
   */
  app.get(buildServerPath('/api/user-skills'), ...gate, async (req, res) => {
    try {
      const deps = requireUserSkills(req, res, { manage: true });
      if (!deps) return;
      const scope = LIST_SCOPES.includes(req.query.scope) ? req.query.scope : 'all';
      const items = await listUserSkills(req.user, deps.repo);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(scope === 'all' ? items : items.filter(item => item.scope === scope));
    } catch (error) {
      sendStorageError(res, error, 'list user skills');
    }
  });

  app.post(buildServerPath('/api/user-skills'), ...gate, async (req, res) => {
    try {
      const deps = requireUserSkills(req, res);
      if (!deps) return;
      const body = parseBody(userSkillContentSchema, req, res);
      if (!body) return;
      await createCopy(
        req,
        res,
        deps,
        normalizeContent(body),
        null,
        skill => `Created user skill "${skill.name}"`
      );
    } catch (error) {
      sendStorageError(res, error, 'create skill');
    }
  });

  /**
   * @swagger
   * /api/user-skills/share-targets:
   *   get:
   *     summary: Users and groups the caller may share a skill with
   *     tags:
   *       - Skills
   */
  app.get(buildServerPath('/api/user-skills/share-targets'), ...gate, (req, res) => {
    try {
      const deps = requireUserSkills(req, res, { manage: true });
      if (!deps) return;
      const context = callerContext(req.user);
      const allowed = allowedTargetsFor(deps.settings, context);
      const raw = typeof req.query.q === 'string' ? req.query.q : '';
      const q = raw.trim().slice(0, LOOKUP_MAX_CHARS).toLowerCase();

      let users = [];
      if (allowed.user && q.length >= LOOKUP_MIN_CHARS) {
        const me = String(req.user.id);
        users = Object.entries(usersDb())
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
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      res.json({ allowed, users, groups });
    } catch (error) {
      sendFailedOperationError(res, 'look up share targets', error);
    }
  });

  /**
   * @swagger
   * /api/user-skills/{skillId}:
   *   get:
   *     summary: One user skill with its instructions and files
   *     tags:
   *       - Skills
   *   put:
   *     summary: Update a user skill (saved as a new revision)
   *     tags:
   *       - Skills
   *   delete:
   *     summary: Delete a user skill (owner or admin)
   *     tags:
   *       - Skills
   */
  app.get(buildServerPath('/api/user-skills/:skillId'), ...gate, async (req, res) => {
    try {
      const { skillId } = req.params;
      if (!validateIdForPath(skillId, 'skill', res)) return;
      if (!isUserSkillId(skillId)) return sendNotFound(res, 'Skill');
      const deps = requireUserSkills(req, res, { manage: true });
      if (!deps) return;
      const loaded = await loadUserSkill(req, res, deps.repo);
      if (!loaded) return;
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(
        serializeUserSkill(loaded.skill, loaded.permissions, {
          ownerActive: loaded.ownerActive,
          includeContent: true
        })
      );
    } catch (error) {
      sendStorageError(res, error, 'read skill');
    }
  });

  app.put(buildServerPath('/api/user-skills/:skillId'), ...gate, async (req, res) => {
    try {
      const { skillId } = req.params;
      if (!validateIdForPath(skillId, 'skill', res)) return;
      if (!isUserSkillId(skillId)) {
        return refuse(res, 'Global skills are managed by admins', 'GLOBAL_SKILL_READ_ONLY');
      }
      const deps = requireUserSkills(req, res, { manage: true });
      if (!deps) return;
      const loaded = await loadUserSkill(req, res, deps.repo);
      if (!loaded) return;
      if (!loaded.permissions.canEdit) return refuse(res, 'You cannot change this skill');
      const body = parseBody(userSkillUpdateSchema, req, res);
      if (!body) return;
      const { expectedRevision, ...rest } = body;
      const content = normalizeContent(rest);
      if (refuseTooLarge(res, content, deps.settings)) return;
      const skill = await deps.repo.update(skillId, content, {
        actor: actorOf(req.user),
        expectedRevision,
        maxVersions: deps.settings.maxVersions,
        authorize: stillAllowed(req, loaded.context, 'canEdit')
      });
      if (!skill) return sendNotFound(res, 'Skill');
      if (skill.revision !== loaded.skill.revision) {
        logAudit({
          req,
          action: 'update',
          resource: 'userSkill',
          resourceId: skillId,
          summary: `Updated user skill "${skill.name}" (revision ${skill.revision})`
        });
      }
      res.json(
        view(skill, req, loaded.context, { ownerActive: loaded.ownerActive, includeContent: true })
      );
    } catch (error) {
      sendStorageError(res, error, 'update skill');
    }
  });

  app.delete(buildServerPath('/api/user-skills/:skillId'), ...gate, async (req, res) => {
    try {
      const { skillId } = req.params;
      if (!validateIdForPath(skillId, 'skill', res)) return;
      if (!isUserSkillId(skillId)) return sendNotFound(res, 'Skill');
      const deps = requireUserSkills(req, res, { manage: true });
      if (!deps) return;
      const loaded = await loadUserSkill(req, res, deps.repo);
      if (!loaded) return;
      if (!loaded.permissions.canDelete) return refuse(res, 'You cannot delete this skill');
      const removed = await deps.repo.delete(skillId, {
        authorize: stillAllowed(req, loaded.context, 'canDelete')
      });
      if (!removed) return sendNotFound(res, 'Skill');
      logAudit({
        req,
        action: 'delete',
        resource: 'userSkill',
        resourceId: skillId,
        summary: `Deleted user skill "${removed.name}"`
      });
      res.json({ success: true });
    } catch (error) {
      sendStorageError(res, error, 'delete skill');
    }
  });

  /**
   * @swagger
   * /api/user-skills/{skillId}/shares:
   *   put:
   *     summary: Replace who a user skill is shared with
   *     description: |
   *       Owners, admins and anyone the skill is shared with as *can edit*
   *       may change the list. Each entry is `{ type: user|group|everyone,
   *       id, permission: use|edit }`. Revoking takes effect immediately.
   *     tags:
   *       - Skills
   */
  app.put(buildServerPath('/api/user-skills/:skillId/shares'), ...gate, async (req, res) => {
    try {
      const { skillId } = req.params;
      if (!validateIdForPath(skillId, 'skill', res)) return;
      if (!isUserSkillId(skillId)) {
        return refuse(res, 'Global skills are shared through groups', 'GLOBAL_SKILL_READ_ONLY');
      }
      const deps = requireUserSkills(req, res, { manage: true });
      if (!deps) return;
      const loaded = await loadUserSkill(req, res, deps.repo);
      if (!loaded) return;
      if (!loaded.permissions.canShare) {
        return refuse(res, 'You cannot change who this skill is shared with');
      }
      const body = parseBody(skillSharesUpdateSchema, req, res);
      if (!body) return;
      const resolved = resolveShares(body.shares, {
        prompt: loaded.skill,
        allowed: allowedTargetsFor(deps.settings, loaded.context),
        users: usersDb(),
        groups: loaded.context.config.groups || {},
        noun: 'skills'
      });
      if (!resolved.ok) {
        return sendErrorResponse(res, resolved.status, resolved.error, {
          details: resolved.details
        });
      }
      const result = await deps.repo.setShares(skillId, resolved.shares, {
        actor: actorOf(req.user),
        authorize: stillAllowed(req, loaded.context, 'canShare')
      });
      if (!result) return sendNotFound(res, 'Skill');
      if (result.added.length || result.removed.length) {
        const everyone = result.skill.shares.some(share => share.type === 'everyone');
        logAudit({
          req,
          action: 'update',
          resource: 'userSkillShare',
          resourceId: skillId,
          summary:
            `Changed sharing of user skill "${result.skill.name}": ` +
            `${result.added.length} added, ${result.removed.length} removed` +
            `${everyone ? ' (shared with everyone)' : ''}`
        });
      }
      res.json(view(result.skill, req, loaded.context, { ownerActive: loaded.ownerActive }));
    } catch (error) {
      sendStorageError(res, error, 'share skill');
    }
  });

  /**
   * @swagger
   * /api/user-skills/{skillId}/owner:
   *   put:
   *     summary: Hand a user skill to another user (owner or admin)
   *     tags:
   *       - Skills
   */
  app.put(buildServerPath('/api/user-skills/:skillId/owner'), ...gate, async (req, res) => {
    try {
      const { skillId } = req.params;
      if (!validateIdForPath(skillId, 'skill', res)) return;
      if (!isUserSkillId(skillId)) return sendNotFound(res, 'Skill');
      const deps = requireUserSkills(req, res, { manage: true });
      if (!deps) return;
      const loaded = await loadUserSkill(req, res, deps.repo);
      if (!loaded) return;
      if (!loaded.permissions.canTransfer) {
        return refuse(res, 'You cannot hand this skill to someone else');
      }
      const body = parseBody(skillTransferSchema, req, res);
      if (!body) return;
      const users = usersDb();
      const target = findUser(users, body.ownerId);
      if (!target || target.active === false) {
        return sendBadRequest(res, 'The new owner must be an active user');
      }
      if (String(body.ownerId) === String(loaded.skill.ownerId)) {
        return res.json(view(loaded.skill, req, loaded.context, { ownerActive: true }));
      }
      if (
        await refuseOverLimit(
          res,
          deps.repo,
          deps.settings,
          String(body.ownerId),
          'The new owner already keeps the most skills allowed'
        )
      ) {
        return;
      }
      const skill = await deps.repo.transfer(
        skillId,
        { id: String(body.ownerId), name: displayName({ ...target, id: body.ownerId }) },
        { actor: actorOf(req.user), authorize: stillAllowed(req, loaded.context, 'canTransfer') }
      );
      if (!skill) return sendNotFound(res, 'Skill');
      logAudit({
        req,
        action: 'update',
        resource: 'userSkill',
        resourceId: skillId,
        summary: `Handed user skill "${skill.name}" to ${skill.ownerName || skill.ownerId}`
      });
      res.json(view(skill, req, loaded.context, { ownerActive: true }));
    } catch (error) {
      sendStorageError(res, error, 'transfer skill');
    }
  });

  /**
   * @swagger
   * /api/user-skills/{skillId}/duplicate:
   *   post:
   *     summary: Copy a user skill into the caller's skills
   *     tags:
   *       - Skills
   */
  app.post(buildServerPath('/api/user-skills/:skillId/duplicate'), ...gate, async (req, res) => {
    try {
      const { skillId } = req.params;
      if (!validateIdForPath(skillId, 'skill', res)) return;
      if (!isUserSkillId(skillId)) return sendNotFound(res, 'Skill');
      const deps = requireUserSkills(req, res);
      if (!deps) return;
      const loaded = await loadUserSkill(req, res, deps.repo);
      if (!loaded) return;
      const body = parseBody(skillDuplicateSchema, req, res);
      if (!body) return;
      const { skill } = loaded;
      await createCopy(
        req,
        res,
        deps,
        {
          name: body.name || skill.name,
          description: skill.description,
          body: skill.body,
          files: skill.files || []
        },
        { scope: 'user', id: skill.id },
        copy => `Copied user skill "${skill.name}" to "${copy.name}"`
      );
    } catch (error) {
      sendStorageError(res, error, 'copy skill');
    }
  });

  /**
   * @swagger
   * /api/skills/{name}/duplicate:
   *   post:
   *     summary: Copy a global skill into the caller's skills
   *     tags:
   *       - Skills
   */
  app.post(buildServerPath('/api/skills/:name/duplicate'), ...gate, async (req, res) => {
    try {
      const { name } = req.params;
      if (!SKILL_NAME_PATTERN.test(name || '')) return sendNotFound(res, 'Skill');
      const deps = requireUserSkills(req, res);
      if (!deps) return;
      const { data: visible } = await configCache.getSkillsForUser(req.user);
      if (!visible.some(skill => skill.name === name)) return sendNotFound(res, 'Skill');
      const body = parseBody(skillDuplicateSchema, req, res);
      if (!body) return;
      const content = await contentOfGlobalSkill(name, deps.settings);
      if (!content) return sendNotFound(res, 'Skill');
      if (body.name) content.name = body.name;
      await createCopy(
        req,
        res,
        deps,
        content,
        { scope: 'global', id: name },
        copy => `Copied global skill "${name}" to user skill "${copy.name}"`
      );
    } catch (error) {
      sendStorageError(res, error, 'copy skill');
    }
  });

  /**
   * @swagger
   * /api/user-skills/{skillId}/versions:
   *   get:
   *     summary: Saved revisions of a user skill, newest first
   *     tags:
   *       - Skills
   */
  app.get(buildServerPath('/api/user-skills/:skillId/versions'), ...gate, async (req, res) => {
    try {
      const { skillId } = req.params;
      if (!validateIdForPath(skillId, 'skill', res)) return;
      if (!isUserSkillId(skillId)) return sendNotFound(res, 'Skill');
      const deps = requireUserSkills(req, res, { manage: true });
      if (!deps) return;
      const loaded = await loadUserSkill(req, res, deps.repo);
      if (!loaded) return;
      const versions = await deps.repo.listVersions(skillId);
      res.json(
        versions.map(version => ({
          revision: version.revision,
          name: version.name,
          description: version.description,
          savedAt: version.savedAt,
          savedBy: version.savedBy,
          ...(version.restoredFrom ? { restoredFrom: version.restoredFrom } : {})
        }))
      );
    } catch (error) {
      sendStorageError(res, error, 'list skill versions');
    }
  });

  app.get(
    buildServerPath('/api/user-skills/:skillId/versions/:revision'),
    ...gate,
    async (req, res) => {
      try {
        const { skillId } = req.params;
        if (!validateIdForPath(skillId, 'skill', res)) return;
        if (!isUserSkillId(skillId)) return sendNotFound(res, 'Skill');
        const deps = requireUserSkills(req, res, { manage: true });
        if (!deps) return;
        const loaded = await loadUserSkill(req, res, deps.repo);
        if (!loaded) return;
        const version = await deps.repo.getVersion(skillId, Number(req.params.revision));
        if (!version) return sendNotFound(res, 'Version');
        res.json({
          revision: version.revision,
          name: version.name,
          description: version.description,
          body: version.body,
          files: version.files || [],
          savedAt: version.savedAt,
          savedBy: version.savedBy,
          ...(version.restoredFrom ? { restoredFrom: version.restoredFrom } : {})
        });
      } catch (error) {
        sendStorageError(res, error, 'read skill version');
      }
    }
  );

  /**
   * @swagger
   * /api/user-skills/{skillId}/versions/{revision}/restore:
   *   post:
   *     summary: Save an earlier revision as the newest one
   *     tags:
   *       - Skills
   */
  app.post(
    buildServerPath('/api/user-skills/:skillId/versions/:revision/restore'),
    ...gate,
    async (req, res) => {
      try {
        const { skillId } = req.params;
        if (!validateIdForPath(skillId, 'skill', res)) return;
        if (!isUserSkillId(skillId)) return sendNotFound(res, 'Skill');
        const deps = requireUserSkills(req, res, { manage: true });
        if (!deps) return;
        const loaded = await loadUserSkill(req, res, deps.repo);
        if (!loaded) return;
        if (!loaded.permissions.canEdit) return refuse(res, 'You cannot change this skill');
        const revision = Number(req.params.revision);
        const version = await deps.repo.getVersion(skillId, revision);
        if (!version) return sendNotFound(res, 'Version');
        const skill = await deps.repo.update(skillId, version, {
          actor: actorOf(req.user),
          restoredFrom: revision,
          maxVersions: deps.settings.maxVersions,
          authorize: stillAllowed(req, loaded.context, 'canEdit')
        });
        if (!skill) return sendNotFound(res, 'Skill');
        logAudit({
          req,
          action: 'update',
          resource: 'userSkill',
          resourceId: skillId,
          summary: `Restored user skill "${skill.name}" to revision ${revision}`
        });
        res.json(
          view(skill, req, loaded.context, {
            ownerActive: loaded.ownerActive,
            includeContent: true
          })
        );
      } catch (error) {
        sendStorageError(res, error, 'restore skill version');
      }
    }
  );
}
