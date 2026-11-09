// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
import { isValidId, assertValidId } from '../utils/pathSecurity.js';
import {
  enhanceUserWithPermissions,
  isContentAdmin,
  loadGroupsConfiguration
} from '../utils/authorization.js';
import { ServiceError } from '../utils/ServiceError.js';
import { logAudit } from '../services/AuditLogService.js';
import { loadUsers } from '../utils/userManager.js';
import { localUsersFile } from '../utils/contentsPath.js';
import { getSkillContent, getSkillResource } from '../services/skillLoader.js';
import { getUserSkillRepository, isUserSkillId } from '../services/skills/UserSkillRepository.js';
import {
  UNSHAREABLE_GROUPS,
  canHoldUserPrompts as canHoldUserSkills,
  effectiveGroups,
  principalShareKeys,
  sharePermissionFor,
  userPromptPermissions as userSkillPermissions
} from '../services/prompts/userPromptAccess.js';
import {
  SKILLS_FEATURE,
  allowedSkillShareTargets,
  isUserSkillMarketplaceConfigured,
  isUserSkillsConfigured,
  userSkillSettings
} from '../services/skills/userSkillSettings.js';
import { serializeUserSkill, skillSize } from '../services/skills/userSkillView.js';
import {
  buildUserSkillFromMarketplace,
  getMarketplaceSkill,
  listMarketplaceSkills,
  marketplaceCopiedFrom,
  marketplaceCopiesByItem,
  marketplaceSkillView
} from '../services/skills/marketplaceSkills.js';
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
import { resolveShares, shareRefusal } from './promptRoutes.js';

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
  return { config, groups: effectiveGroups(user, config), isAdmin: isContentAdmin(user) };
}

/**
 * Gate for every route that reads or writes user skills. Throws the refusal when the request
 * cannot go on. With user skills switched off, admins still look after the ones that exist
 * (`manage`).
 *
 * @throws {ServiceError} `USER_SKILLS_NOT_ALLOWED`, `USER_SKILLS_DISABLED` or `USER_SKILLS_UNAVAILABLE`
 */
function requireUserSkills(req, { manage = false } = {}) {
  if (!canHoldUserSkills(req.user)) {
    throw new ServiceError('USER_SKILLS_NOT_ALLOWED', 'This sign-in cannot hold user skills');
  }
  ensurePrincipal(req);
  if (!isUserSkillsConfigured(configCache.getFeatures(), configCache.getPlatform() || {})) {
    if (!manage || !isContentAdmin(req.user)) {
      throw new ServiceError('USER_SKILLS_DISABLED', 'User skills are switched off');
    }
  }
  const repo = getUserSkillRepository();
  if (!repo.isAvailable()) {
    throw new ServiceError('USER_SKILLS_UNAVAILABLE', 'User skills are unavailable');
  }
  return { repo, settings: userSkillSettings(configCache.getPlatform() || {}) };
}

/** The parsed body; a body that does not match the schema is a 400 `VALIDATION_FAILED`. */
function parseBody(schema, req) {
  return schema.parse(req.body || {});
}

/** Throw `SKILL_TOO_LARGE` for content beyond the size and file limits. */
function assertNotTooLarge(content, settings) {
  const files = content.files || [];
  if (files.length > settings.maxFilesPerSkill) {
    throw new ServiceError(
      'SKILL_TOO_LARGE',
      `A skill can have at most ${settings.maxFilesPerSkill} files`,
      { details: { maxFilesPerSkill: settings.maxFilesPerSkill } }
    );
  }
  if (skillSize(content) > settings.maxSkillSizeKB * 1024) {
    throw new ServiceError(
      'SKILL_TOO_LARGE',
      `A skill can be at most ${settings.maxSkillSizeKB} KB, instructions and files together`,
      { details: { maxSkillSizeKB: settings.maxSkillSizeKB } }
    );
  }
}

/** Throw `SKILL_LIMIT_REACHED` for one more skill past the per-user limit. */
async function assertUnderLimit(repo, settings, ownerId, message) {
  if (settings.maxSkillsPerUser <= 0) return;
  if ((await repo.countOwned(ownerId)) < settings.maxSkillsPerUser) return;
  throw new ServiceError(
    'SKILL_LIMIT_REACHED',
    message || `You can keep at most ${settings.maxSkillsPerUser} skills — delete one to make room`,
    { details: { limit: settings.maxSkillsPerUser } }
  );
}

/** The refusal of a write the caller's permissions do not cover. */
function refusal(message, code = 'SKILL_FORBIDDEN') {
  return new ServiceError(code, message);
}

/**
 * Gate for the marketplace routes: everything `requireUserSkills` asks, plus
 * the `marketplace` feature and `userSkills.allowMarketplace`. Throws the refusal
 * when the request cannot go on.
 */
function requireMarketplace(req) {
  const deps = requireUserSkills(req);
  if (
    !isUserSkillMarketplaceConfigured(configCache.getFeatures(), configCache.getPlatform() || {})
  ) {
    throw new ServiceError(
      'MARKETPLACE_SKILLS_DISABLED',
      'Adding skills from the marketplace is switched off'
    );
  }
  return deps;
}

/** A registry id and a catalog name from the path, both path-safe; throws a 400 or 404 otherwise. */
function marketplaceItemParams(req) {
  const { registryId, name } = req.params;
  assertValidId(registryId, 'registry');
  if (!isValidId(name)) throw new ServiceError('NOT_FOUND', 'Skill not found');
  return { registryId, name };
}

/**
 * Load one user skill and what the caller may do with it. Throws a 404 —
 * never a 403, so an id nobody shared with the caller confirms nothing.
 */
async function loadUserSkill(req, repo) {
  const skill = await repo.get(req.params.skillId);
  const context = callerContext(req.user);
  const ownerActive = skill ? isActiveUser(usersDb(), skill.ownerId) : true;
  const permissions = userSkillPermissions(skill, req.user, {
    groups: context.groups,
    isAdmin: context.isAdmin,
    ownerActive
  });
  if (!skill || !permissions.canView) throw new ServiceError('NOT_FOUND', 'Skill not found');
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

/**
 * Copy of a skill, owned by the caller; sends the success response itself. `extra`
 * is added to the response body (e.g. the files a marketplace copy left out).
 */
async function createCopy(req, res, deps, content, copiedFrom, auditSummary, extra = {}) {
  assertNotTooLarge(content, deps.settings);
  await assertUnderLimit(deps.repo, deps.settings, String(req.user.id));
  const skill = await deps.repo.create({
    owner: actorOf(req.user),
    content,
    copiedFrom,
    maxVersions: deps.settings.maxVersions
  });
  if (!skill) throw new ServiceError('USER_SKILLS_UNAVAILABLE', 'User skills are unavailable');
  logAudit({
    req,
    action: 'create',
    resource: 'userSkill',
    resourceId: skill.id,
    summary: auditSummary(skill)
  });
  res
    .status(201)
    .json({ ...view(skill, req, callerContext(req.user), { includeContent: true }), ...extra });
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
    const deps = requireUserSkills(req, { manage: true });
    const scope = LIST_SCOPES.includes(req.query.scope) ? req.query.scope : 'all';
    const items = await listUserSkills(req.user, deps.repo);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(scope === 'all' ? items : items.filter(item => item.scope === scope));
  });

  app.post(buildServerPath('/api/user-skills'), ...gate, async (req, res) => {
    const deps = requireUserSkills(req);
    const body = parseBody(userSkillContentSchema, req);
    await createCopy(
      req,
      res,
      deps,
      normalizeContent(body),
      null,
      skill => `Created user skill "${skill.name}"`
    );
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
    const deps = requireUserSkills(req, { manage: true });
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
          group => !q || group.name.toLowerCase().includes(q) || group.id.toLowerCase().includes(q)
        )
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json({ allowed, users, groups });
  });

  /**
   * @swagger
   * /api/user-skills/marketplace:
   *   get:
   *     summary: Skills the marketplace offers to add to one's own skills
   *     description: |
   *       Lists the skills of the enabled marketplace registries (their
   *       fetched catalogs), so a user can copy one into their own skills
   *       without an admin installing it for everyone. Needs the
   *       `marketplace` feature and `platform.userSkills.allowMarketplace`.
   *       Each item says whether the caller already added it (`added`) and
   *       whether a global skill of that name is available to them.
   *     tags:
   *       - Skills
   *     parameters:
   *       - in: query
   *         name: search
   *         schema:
   *           type: string
   *       - in: query
   *         name: registry
   *         schema:
   *           type: string
   *       - in: query
   *         name: category
   *         schema:
   *           type: string
   *       - in: query
   *         name: cursor
   *         schema:
   *           type: string
   *         description: The `nextCursor` of the previous page
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           maximum: 60
   */
  app.get(buildServerPath('/api/user-skills/marketplace'), ...gate, async (req, res) => {
    const deps = requireMarketplace(req);
    const query = req.query || {};
    const result = await listMarketplaceSkills({
      search: typeof query.search === 'string' ? query.search.slice(0, 200) : '',
      registry: typeof query.registry === 'string' ? query.registry : '',
      category: typeof query.category === 'string' ? query.category : '',
      cursor: query.cursor,
      limit: query.limit
    });
    const copies = marketplaceCopiesByItem(await deps.repo.listOwned(String(req.user.id)));
    const { data: visible } = await configCache.getSkillsForUser(req.user);
    const globalNames = new Set((visible || []).map(skill => skill.name));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ...result,
      items: result.items.map(item => ({
        ...marketplaceSkillView(item),
        added: copies.get(`${item.registryId}:${item.name}`) || null,
        availableAsGlobal: globalNames.has(item.name)
      }))
    });
  });

  /**
   * @swagger
   * /api/user-skills/marketplace/{registryId}/{name}:
   *   get:
   *     summary: One marketplace skill with a preview of its instructions
   *     tags:
   *       - Skills
   */
  app.get(
    buildServerPath('/api/user-skills/marketplace/:registryId/:name'),
    ...gate,
    async (req, res) => {
      const params = marketplaceItemParams(req);
      const deps = requireMarketplace(req);
      const skill = await getMarketplaceSkill(params.registryId, params.name);
      const copies = marketplaceCopiesByItem(await deps.repo.listOwned(String(req.user.id)));
      const { data: visible } = await configCache.getSkillsForUser(req.user);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        ...skill,
        added: copies.get(`${params.registryId}:${params.name}`) || null,
        availableAsGlobal: (visible || []).some(global => global.name === params.name)
      });
    }
  );

  /**
   * @swagger
   * /api/user-skills/marketplace/{registryId}/{name}/add:
   *   post:
   *     summary: Copy a marketplace skill into the caller's own skills
   *     description: |
   *       Fetches the skill from its registry and saves it as a user skill
   *       owned by the caller, private until shared. Body `{ name? }` names
   *       the copy; it defaults to the catalog name. Only text files one
   *       folder deep that fit the limits of `platform.userSkills` are kept;
   *       the response lists the others in `skippedFiles`
   *       (`{ path, reason: unsupported|fileLimit|sizeLimit }`).
   *     tags:
   *       - Skills
   *     responses:
   *       201:
   *         description: The new user skill
   *       404:
   *         description: The registry is off or does not list the skill
   *       422:
   *         description: The item is not a valid skill
   *       502:
   *         description: The registry could not be reached
   */
  app.post(
    buildServerPath('/api/user-skills/marketplace/:registryId/:name/add'),
    ...gate,
    async (req, res) => {
      const params = marketplaceItemParams(req);
      const deps = requireMarketplace(req);
      const body = parseBody(skillDuplicateSchema, req);
      // Refuse before fetching anything when there is no room for one more.
      await assertUnderLimit(deps.repo, deps.settings, String(req.user.id));
      const built = await buildUserSkillFromMarketplace(
        params.registryId,
        params.name,
        deps.settings,
        { requestedName: body.name }
      );
      const parsed = userSkillContentSchema.safeParse(built.content);
      if (!parsed.success) {
        throw new ServiceError(
          'MARKETPLACE_SKILL_INVALID',
          `This skill cannot be added: ${describeIssues(parsed.error)}`
        );
      }
      await createCopy(
        req,
        res,
        deps,
        normalizeContent(parsed.data),
        marketplaceCopiedFrom(built.item),
        copy =>
          `Added marketplace skill "${params.name}" from registry ${params.registryId} ` +
          `as user skill "${copy.name}"`,
        { skippedFiles: built.skipped }
      );
    }
  );

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
    const { skillId } = req.params;
    assertValidId(skillId, 'skill');
    if (!isUserSkillId(skillId)) throw new ServiceError('NOT_FOUND', 'Skill not found');
    const deps = requireUserSkills(req, { manage: true });
    const loaded = await loadUserSkill(req, deps.repo);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(
      serializeUserSkill(loaded.skill, loaded.permissions, {
        ownerActive: loaded.ownerActive,
        includeContent: true
      })
    );
  });

  app.put(buildServerPath('/api/user-skills/:skillId'), ...gate, async (req, res) => {
    const { skillId } = req.params;
    assertValidId(skillId, 'skill');
    if (!isUserSkillId(skillId)) {
      throw refusal('Global skills are managed by admins', 'GLOBAL_SKILL_READ_ONLY');
    }
    const deps = requireUserSkills(req, { manage: true });
    const loaded = await loadUserSkill(req, deps.repo);
    if (!loaded.permissions.canEdit) throw refusal('You cannot change this skill');
    const body = parseBody(userSkillUpdateSchema, req);
    const { expectedRevision, ...rest } = body;
    const content = normalizeContent(rest);
    assertNotTooLarge(content, deps.settings);
    const skill = await deps.repo.update(skillId, content, {
      actor: actorOf(req.user),
      expectedRevision,
      maxVersions: deps.settings.maxVersions,
      authorize: stillAllowed(req, loaded.context, 'canEdit')
    });
    if (!skill) throw new ServiceError('NOT_FOUND', 'Skill not found');
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
  });

  app.delete(buildServerPath('/api/user-skills/:skillId'), ...gate, async (req, res) => {
    const { skillId } = req.params;
    assertValidId(skillId, 'skill');
    if (!isUserSkillId(skillId)) throw new ServiceError('NOT_FOUND', 'Skill not found');
    const deps = requireUserSkills(req, { manage: true });
    const loaded = await loadUserSkill(req, deps.repo);
    if (!loaded.permissions.canDelete) throw refusal('You cannot delete this skill');
    const removed = await deps.repo.delete(skillId, {
      authorize: stillAllowed(req, loaded.context, 'canDelete')
    });
    if (!removed) throw new ServiceError('NOT_FOUND', 'Skill not found');
    logAudit({
      req,
      action: 'delete',
      resource: 'userSkill',
      resourceId: skillId,
      summary: `Deleted user skill "${removed.name}"`
    });
    res.json({ success: true });
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
    const { skillId } = req.params;
    assertValidId(skillId, 'skill');
    if (!isUserSkillId(skillId)) {
      throw refusal('Global skills are shared through groups', 'GLOBAL_SKILL_READ_ONLY');
    }
    const deps = requireUserSkills(req, { manage: true });
    const loaded = await loadUserSkill(req, deps.repo);
    if (!loaded.permissions.canShare) {
      throw refusal('You cannot change who this skill is shared with');
    }
    const body = parseBody(skillSharesUpdateSchema, req);
    const resolved = resolveShares(body.shares, {
      prompt: loaded.skill,
      allowed: allowedTargetsFor(deps.settings, loaded.context),
      users: usersDb(),
      groups: loaded.context.config.groups || {},
      noun: 'skills'
    });
    if (!resolved.ok) throw shareRefusal(resolved);
    const result = await deps.repo.setShares(skillId, resolved.shares, {
      actor: actorOf(req.user),
      authorize: stillAllowed(req, loaded.context, 'canShare')
    });
    if (!result) throw new ServiceError('NOT_FOUND', 'Skill not found');
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
    const { skillId } = req.params;
    assertValidId(skillId, 'skill');
    if (!isUserSkillId(skillId)) throw new ServiceError('NOT_FOUND', 'Skill not found');
    const deps = requireUserSkills(req, { manage: true });
    const loaded = await loadUserSkill(req, deps.repo);
    if (!loaded.permissions.canTransfer) {
      throw refusal('You cannot hand this skill to someone else');
    }
    const body = parseBody(skillTransferSchema, req);
    const users = usersDb();
    const target = findUser(users, body.ownerId);
    if (!target || target.active === false) {
      throw new ServiceError('BAD_REQUEST', 'The new owner must be an active user');
    }
    if (String(body.ownerId) === String(loaded.skill.ownerId)) {
      return res.json(view(loaded.skill, req, loaded.context, { ownerActive: true }));
    }
    await assertUnderLimit(
      deps.repo,
      deps.settings,
      String(body.ownerId),
      'The new owner already keeps the most skills allowed'
    );
    const skill = await deps.repo.transfer(
      skillId,
      { id: String(body.ownerId), name: displayName({ ...target, id: body.ownerId }) },
      { actor: actorOf(req.user), authorize: stillAllowed(req, loaded.context, 'canTransfer') }
    );
    if (!skill) throw new ServiceError('NOT_FOUND', 'Skill not found');
    logAudit({
      req,
      action: 'update',
      resource: 'userSkill',
      resourceId: skillId,
      summary: `Handed user skill "${skill.name}" to ${skill.ownerName || skill.ownerId}`
    });
    res.json(view(skill, req, loaded.context, { ownerActive: true }));
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
    const { skillId } = req.params;
    assertValidId(skillId, 'skill');
    if (!isUserSkillId(skillId)) throw new ServiceError('NOT_FOUND', 'Skill not found');
    const deps = requireUserSkills(req);
    const loaded = await loadUserSkill(req, deps.repo);
    const body = parseBody(skillDuplicateSchema, req);
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
    const { name } = req.params;
    if (!SKILL_NAME_PATTERN.test(name || ''))
      throw new ServiceError('NOT_FOUND', 'Skill not found');
    const deps = requireUserSkills(req);
    const { data: visible } = await configCache.getSkillsForUser(req.user);
    if (!visible.some(skill => skill.name === name))
      throw new ServiceError('NOT_FOUND', 'Skill not found');
    const body = parseBody(skillDuplicateSchema, req);
    const content = await contentOfGlobalSkill(name, deps.settings);
    if (!content) throw new ServiceError('NOT_FOUND', 'Skill not found');
    if (body.name) content.name = body.name;
    await createCopy(
      req,
      res,
      deps,
      content,
      { scope: 'global', id: name },
      copy => `Copied global skill "${name}" to user skill "${copy.name}"`
    );
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
    const { skillId } = req.params;
    assertValidId(skillId, 'skill');
    if (!isUserSkillId(skillId)) throw new ServiceError('NOT_FOUND', 'Skill not found');
    const deps = requireUserSkills(req, { manage: true });
    await loadUserSkill(req, deps.repo); // a 404 unless the caller may see the skill
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
  });

  app.get(
    buildServerPath('/api/user-skills/:skillId/versions/:revision'),
    ...gate,
    async (req, res) => {
      const { skillId } = req.params;
      assertValidId(skillId, 'skill');
      if (!isUserSkillId(skillId)) throw new ServiceError('NOT_FOUND', 'Skill not found');
      const deps = requireUserSkills(req, { manage: true });
      await loadUserSkill(req, deps.repo); // a 404 unless the caller may see the skill
      const version = await deps.repo.getVersion(skillId, Number(req.params.revision));
      if (!version) throw new ServiceError('NOT_FOUND', 'Version not found');
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
      const { skillId } = req.params;
      assertValidId(skillId, 'skill');
      if (!isUserSkillId(skillId)) throw new ServiceError('NOT_FOUND', 'Skill not found');
      const deps = requireUserSkills(req, { manage: true });
      const loaded = await loadUserSkill(req, deps.repo);
      if (!loaded.permissions.canEdit) throw refusal('You cannot change this skill');
      const revision = Number(req.params.revision);
      const version = await deps.repo.getVersion(skillId, revision);
      if (!version) throw new ServiceError('NOT_FOUND', 'Version not found');
      const skill = await deps.repo.update(skillId, version, {
        actor: actorOf(req.user),
        restoredFrom: revision,
        maxVersions: deps.settings.maxVersions,
        authorize: stillAllowed(req, loaded.context, 'canEdit')
      });
      if (!skill) throw new ServiceError('NOT_FOUND', 'Skill not found');
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
    }
  );
}
