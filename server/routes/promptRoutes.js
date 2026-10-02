/**
 * The prompt library API — one `/api/prompts` for both kinds of prompt (#2519).
 *
 *  - **Global prompts** are configuration: JSON files under `contents/prompts/`,
 *    curated by admins under Admin → Prompts and filtered by the `prompts`
 *    group permission. This API only reads them.
 *  - **User prompts** are user data, written through the storage abstraction
 *    by `UserPromptRepository`: private by default, shareable with users,
 *    groups or everyone, as *can use* or *can edit*.
 *
 * `GET /api/prompts` returns both, each entry carrying its `scope`
 * (`global`, `mine`, `shared`) and the `permissions` the caller has on it;
 * `?scope=` narrows the list. A user prompt id always starts with `upr_`,
 * which is how every `/:promptId` route tells the two apart.
 *
 * Every ownership and share check runs here; the client only uses the
 * returned `permissions` to show or hide actions.
 *
 * @module routes/promptRoutes
 */
import configCache from '../configCache.js';
import { authRequired, authenticatedOnly } from '../middleware/authRequired.js';
import { requireFeature } from '../featureRegistry.js';
import { buildServerPath } from '../utils/basePath.js';
import { isValidId, validateIdForPath } from '../utils/pathSecurity.js';
import {
  enhanceUserWithPermissions,
  filterResourcesByPermissions,
  isAnonymousAccessAllowed,
  loadGroupsConfiguration
} from '../utils/authorization.js';
import {
  sendBadRequest,
  sendErrorResponse,
  sendFailedOperationError,
  sendNotFound
} from '../utils/responseHelpers.js';
import { logAudit } from '../services/AuditLogService.js';
import PromptService from '../services/PromptService.js';
import { loadUsers } from '../utils/userManager.js';
import { localUsersFile } from '../utils/contentsPath.js';
import { getLocalizedContent } from '../../shared/localize.js';
import { autoVariableNames } from '../../shared/promptVariables.js';
import { StorageError, storageHttpStatus } from '../storage/errors.js';
import {
  ACCESS_CHANGED,
  getUserPromptRepository,
  isUserPromptId
} from '../services/prompts/UserPromptRepository.js';
import {
  UNSHAREABLE_GROUPS,
  canHoldUserPrompts,
  effectiveGroups,
  isPromptAdmin,
  principalShareKeys,
  shareTargetKey,
  sharePermissionFor,
  userPromptPermissions
} from '../services/prompts/userPromptAccess.js';
import {
  PROMPTS_LIBRARY_FEATURE,
  allowedShareTargets,
  isUserPromptsConfigured,
  userPromptSettings
} from '../services/prompts/userPromptSettings.js';
import { serializeUserPrompt } from '../services/prompts/userPromptView.js';
import {
  describeIssues,
  duplicateSchema,
  preferencesUpdateSchema,
  sharesUpdateSchema,
  transferSchema,
  userPromptContentSchema,
  userPromptUpdateSchema
} from '../validators/userPromptSchema.js';

/** Scopes `GET /api/prompts?scope=` accepts. */
export const LIST_SCOPES = Object.freeze(['all', 'global', 'mine', 'shared', 'favorites']);

/** Users and groups one share-target lookup returns, and the query length users need. */
const LOOKUP_LIMIT = 10;
const LOOKUP_MIN_CHARS = 2;
const LOOKUP_MAX_CHARS = 100;

/**
 * Give the request a principal with resolved permissions: the signed-in user,
 * or — when anonymous access is on — the anonymous principal, the same one the
 * rest of the data routes build.
 *
 * @param {Object} req - Express request.
 */
function ensurePrincipal(req) {
  const platformConfig = configCache.getPlatform() || {};
  const authConfig = platformConfig.auth || {};
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
  }
  if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
    req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
  }
}

/** The global prompts this principal may see. */
function visibleGlobalPrompts(user) {
  const prompts = configCache.getPrompts()?.data || [];
  const allowed = user?.permissions?.prompts || new Set();
  return filterResourcesByPermissions(prompts, allowed);
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

/** Whether user prompts are switched on and can be stored. */
function userPromptsActive() {
  return (
    isUserPromptsConfigured(configCache.getFeatures(), configCache.getPlatform() || {}) &&
    getUserPromptRepository().isAvailable()
  );
}

/**
 * The caller's standing towards user prompts: their effective groups and
 * whether they administer the library.
 *
 * @param {Object} user - `req.user`.
 * @returns {{groups: string[], isAdmin: boolean, config: Object}}
 */
function callerContext(user) {
  const config = groupsConfig();
  return {
    config,
    groups: effectiveGroups(user, config),
    isAdmin: isPromptAdmin(user, config)
  };
}

/**
 * Gate for every route that reads or writes user prompts. Sends the refusal
 * itself and returns null when the request cannot go on.
 *
 * With user prompts switched off, users neither see nor change their prompts
 * until they are switched back on. Prompt admins still look after the ones
 * that exist — review, unshare, hand over, delete — so a route that manages
 * an existing prompt passes `manage` and lets them through.
 *
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @param {Object} [options]
 * @param {boolean} [options.manage] - The route manages an existing prompt.
 * @returns {{repo: import('../services/prompts/UserPromptRepository.js').UserPromptRepository,
 *   settings: ReturnType<typeof userPromptSettings>}|null}
 */
function requireUserPrompts(req, res, { manage = false } = {}) {
  if (!canHoldUserPrompts(req.user)) {
    sendErrorResponse(res, 403, 'This sign-in cannot hold user prompts', {
      details: { code: 'USER_PROMPTS_NOT_ALLOWED' }
    });
    return null;
  }
  if (!isUserPromptsConfigured(configCache.getFeatures(), configCache.getPlatform() || {})) {
    ensurePrincipal(req);
    if (!manage || !isPromptAdmin(req.user, groupsConfig())) {
      sendErrorResponse(res, 403, 'User prompts are switched off', {
        details: { code: 'USER_PROMPTS_DISABLED' }
      });
      return null;
    }
  }
  const repo = getUserPromptRepository();
  if (!repo.isAvailable()) {
    sendErrorResponse(res, 503, 'User prompts are unavailable', {
      details: { code: 'USER_PROMPTS_UNAVAILABLE' }
    });
    return null;
  }
  return { repo, settings: userPromptSettings(configCache.getPlatform() || {}) };
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

/**
 * Whether the caller may use an app — a prompt is only bound to an app its
 * author can open.
 */
function appIsUsable(appId, user) {
  const apps = configCache.getApps()?.data || [];
  const app = apps.find(entry => entry?.id === appId);
  if (!app) return false;
  const allowed = user?.permissions?.apps || new Set();
  return filterResourcesByPermissions([app], allowed).length > 0;
}

/** A parsed content payload with every optional field present. */
function normalizeContent(content) {
  return {
    ...content,
    description: content.description || '',
    icon: content.icon || null,
    category: content.category || null,
    appId: content.appId || null,
    variables: content.variables || []
  };
}

/** Normalize and check a content payload a user sent; sends the refusal itself. */
function checkedContent(content, user, res) {
  const normalized = normalizeContent(content);
  if (normalized.appId && !appIsUsable(normalized.appId, user)) {
    sendBadRequest(res, `Unknown app: ${normalized.appId}`);
    return null;
  }
  return normalized;
}

/** The client view of one global prompt: as configured, plus scope and permissions. */
function serializeGlobalPrompt(prompt, { canDuplicate }) {
  return {
    ...prompt,
    scope: 'global',
    owner: null,
    permissions: {
      canEdit: false,
      canShare: false,
      canDelete: false,
      canTransfer: false,
      canDuplicate
    }
  };
}

/**
 * Load one user prompt and what the caller may do with it. Sends a 404 —
 * never a 403, so an id nobody shared with the caller confirms nothing — and
 * returns null when the caller may not see it.
 */
async function loadUserPrompt(req, res, repo) {
  const { promptId } = req.params;
  const prompt = await repo.get(promptId);
  const context = callerContext(req.user);
  const ownerActive = prompt ? isActiveUser(usersDb(), prompt.ownerId) : true;
  const permissions = userPromptPermissions(prompt, req.user, {
    groups: context.groups,
    isAdmin: context.isAdmin,
    ownerActive
  });
  if (!prompt || !permissions.canView) {
    sendNotFound(res, 'Prompt');
    return null;
  }
  return { prompt, permissions, context, ownerActive };
}

/**
 * The same permission check again, for the repository to run on the prompt it
 * loads under its lock. The route's own check reads the prompt before the lock
 * is taken; a share revoked or a prompt handed over while this request waits
 * for the lock must still stop its write.
 *
 * @param {Object} req - Express request.
 * @param {{groups: string[], isAdmin: boolean}} context - The caller's context.
 * @param {'canEdit'|'canShare'|'canTransfer'|'canDelete'} permission - What the write needs.
 * @returns {(prompt: Object) => boolean}
 */
function stillAllowed(req, context, permission) {
  return prompt =>
    Boolean(
      userPromptPermissions(prompt, req.user, {
        groups: context.groups,
        isAdmin: context.isAdmin,
        ownerActive: isActiveUser(usersDb(), prompt.ownerId)
      })[permission]
    );
}

/** Refuse a write the caller's permissions do not cover. */
function refuse(res, message, code = 'PROMPT_FORBIDDEN') {
  return sendErrorResponse(res, 403, message, { details: { code } });
}

/**
 * Refuse giving a user one more prompt past the per-user limit — by creating,
 * duplicating or handing one over; true when refused.
 */
async function refuseOverLimit(res, repo, settings, ownerId, message) {
  if (settings.maxPromptsPerUser <= 0) return false;
  if ((await repo.countOwned(ownerId)) < settings.maxPromptsPerUser) return false;
  sendErrorResponse(
    res,
    409,
    message ||
      `You can keep at most ${settings.maxPromptsPerUser} prompts — delete one to make room`,
    { details: { code: 'PROMPT_LIMIT_REACHED', limit: settings.maxPromptsPerUser } }
  );
  return true;
}

/**
 * The user prompts the caller owns and those shared with them, each with its
 * permissions. A marker the prompt no longer backs — a share that was revoked
 * after the marker was written — lets nothing through: the share list on the
 * prompt decides.
 */
async function listUserPrompts(user, repo) {
  const context = callerContext(user);
  const owned = await repo.listOwned(String(user.id));
  const ownedIds = new Set(owned.map(prompt => prompt.id));
  const candidates = await repo.listSharedWith(principalShareKeys(user, context.groups));
  const users = candidates.length ? usersDb() : {};
  const items = owned.map(prompt =>
    serializeUserPrompt(
      prompt,
      userPromptPermissions(prompt, user, { groups: context.groups, isAdmin: context.isAdmin })
    )
  );
  for (const prompt of candidates) {
    if (ownedIds.has(prompt.id)) continue;
    // The share is what earns a place in "shared with me" — being an admin
    // does not put every prompt with a stale marker on the list.
    if (!sharePermissionFor(prompt, user, context.groups)) continue;
    const ownerActive = isActiveUser(users, prompt.ownerId);
    items.push(
      serializeUserPrompt(
        prompt,
        userPromptPermissions(prompt, user, {
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

/**
 * Validate a requested share list and resolve it into what is stored: known,
 * active users (never the owner), existing groups (never `anonymous`), and at
 * most one entry per target, the strongest permission winning. A target that
 * is new to the list must be one the caller may pick now; targets already on
 * it stay whatever the settings say today, so an editor with narrower rights
 * can still save a prompt the owner shared widely.
 *
 * @returns {{ok: true, shares: Object[]}|{ok: false, status: number, error: string,
 *   details?: Object}}
 */
export function resolveShares(requested, { prompt, allowed, users, groups }) {
  const existing = new Set((prompt.shares || []).map(shareTargetKey));
  const byKey = new Map();
  const unknown = [];
  for (const entry of requested) {
    const permission = entry.permission === 'edit' ? 'edit' : 'use';
    let share;
    if (entry.type === 'everyone') {
      share = { type: 'everyone', id: null, permission };
    } else if (entry.type === 'user') {
      const id = String(entry.id || '');
      const user = id ? findUser(users, id) : null;
      if (!user || user.active === false) {
        unknown.push(id);
        continue;
      }
      if (String(user.id ?? id) === String(prompt.ownerId) || id === String(prompt.ownerId)) {
        continue;
      }
      share = { type: 'user', id, name: displayName({ ...user, id }), permission };
    } else if (entry.type === 'group') {
      const id = String(entry.id || '');
      const group = id && Object.hasOwn(groups, id) ? groups[id] : null;
      if (!group || UNSHAREABLE_GROUPS.includes(id)) {
        unknown.push(id);
        continue;
      }
      share = { type: 'group', id, name: String(group.name || id), permission };
    } else {
      continue;
    }
    const key = shareTargetKey(share);
    const previous = byKey.get(key);
    if (!previous || (previous.permission === 'use' && share.permission === 'edit')) {
      byKey.set(key, share);
    }
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'Some share targets are not known users or groups',
      details: { unknown }
    };
  }
  for (const [key, share] of byKey) {
    if (!existing.has(key) && !allowed[share.type]) {
      return {
        ok: false,
        status: 403,
        error: `You cannot share prompts with ${share.type === 'everyone' ? 'everyone' : `this ${share.type}`}`,
        details: { code: 'SHARE_TARGET_NOT_ALLOWED', type: share.type }
      };
    }
  }
  return { ok: true, shares: [...byKey.values()] };
}

/** What `/share-targets` and `/shares` let this caller pick. */
function allowedTargetsFor(settings, context) {
  if (context.isAdmin) {
    return {
      user: settings.sharing.allowUsers,
      group: settings.sharing.allowGroups,
      everyone: settings.sharing.allowEveryone
    };
  }
  return allowedShareTargets(settings, context.groups);
}

function contentOfGlobalPrompt(prompt, language) {
  return {
    name: getLocalizedContent(prompt.name, language),
    description: getLocalizedContent(prompt.description, language),
    prompt: getLocalizedContent(prompt.prompt, language),
    icon: prompt.icon || null,
    category: prompt.category || null,
    appId: prompt.appId || null,
    variables: Array.isArray(prompt.variables) ? prompt.variables : []
  };
}

export default function registerPromptRoutes(app) {
  const gate = [requireFeature(PROMPTS_LIBRARY_FEATURE)];

  /**
   * @swagger
   * /api/prompts:
   *   get:
   *     summary: List the prompt library — global and user prompts
   *     description: |
   *       Returns the global prompts the caller's groups may see (the `prompts`
   *       permission) together with the caller's own user prompts and those
   *       shared with them. Each entry carries `scope` (`global`, `mine`,
   *       `shared`) and the `permissions` the caller has on it. Anonymous
   *       callers only ever receive global prompts.
   *     tags:
   *       - Prompts
   *     parameters:
   *       - in: query
   *         name: scope
   *         schema:
   *           type: string
   *           enum: [all, global, mine, shared, favorites]
   *         description: Narrow the list. Defaults to `all`.
   *     responses:
   *       200:
   *         description: The prompts
   *       304:
   *         description: Not modified (the ETag matched)
   *       401:
   *         description: Authentication required
   */
  app.get(buildServerPath('/api/prompts'), ...gate, authRequired, async (req, res) => {
    try {
      ensurePrincipal(req);
      const scope = LIST_SCOPES.includes(req.query.scope) ? req.query.scope : 'all';
      const holdsUserPrompts = canHoldUserPrompts(req.user);
      const userPromptsOn = holdsUserPrompts && userPromptsActive();

      let items = [];
      if (scope === 'all' || scope === 'global' || scope === 'favorites') {
        items = visibleGlobalPrompts(req.user).map(prompt =>
          serializeGlobalPrompt(prompt, { canDuplicate: userPromptsOn })
        );
      }
      if (userPromptsOn && scope !== 'global') {
        const userItems = await listUserPrompts(req.user, getUserPromptRepository());
        items = items.concat(
          scope === 'mine' || scope === 'shared'
            ? userItems.filter(item => item.scope === scope)
            : userItems
        );
      }
      if (scope === 'favorites') {
        const repo = getUserPromptRepository();
        const favorites = holdsUserPrompts
          ? new Set((await repo.getPreferences(String(req.user.id))).favorites)
          : new Set();
        items = items.filter(item => favorites.has(item.id));
      }

      // Express derives the ETag from the response body and answers a
      // matching If-None-Match with 304 itself. The body differs per caller —
      // permissions, own prompts, shares — so the ETag does too, and `private`
      // keeps shared caches from handing one user another's list.
      res.setHeader('Cache-Control', 'private, no-cache');
      res.json(items);
    } catch (error) {
      sendStorageError(res, error, 'fetch prompts');
    }
  });

  /**
   * @swagger
   * /api/prompts/variables:
   *   get:
   *     summary: Resolved global prompt variables for the caller
   *     description: |
   *       The values `{{user_name}}`, `{{date}}` and the admin-defined global
   *       variables take for this user right now, and the names that fill
   *       themselves in — what the fill-in dialog uses for its preview.
   *     tags:
   *       - Prompts
   *     responses:
   *       200:
   *         description: "`{ autoNames: string[], values: object }`"
   */
  app.get(buildServerPath('/api/prompts/variables'), ...gate, authRequired, (req, res) => {
    try {
      ensurePrincipal(req);
      const platform = configCache.getPlatform() || {};
      const language =
        typeof req.query.lang === 'string' && /^[a-zA-Z-]{2,10}$/.test(req.query.lang)
          ? req.query.lang
          : platform.defaultLanguage || 'en';
      const user = req.user && req.user.id !== 'anonymous' ? req.user : null;
      const values = PromptService.resolveGlobalPromptVariables(user, null, language, null);
      delete values.tone;
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        autoNames: autoVariableNames(platform.globalPromptVariables?.variables || {}),
        values
      });
    } catch (error) {
      sendFailedOperationError(res, 'resolve prompt variables', error);
    }
  });

  /**
   * @swagger
   * /api/prompts/preferences:
   *   get:
   *     summary: The caller's prompt favorites and recents
   *     tags:
   *       - Prompts
   *     responses:
   *       200:
   *         description: "`{ favorites: string[], recents: {id, at}[], stored: boolean }`"
   *   put:
   *     summary: Replace the caller's favorites (and merge in recents)
   *     tags:
   *       - Prompts
   */
  app.get(
    buildServerPath('/api/prompts/preferences'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        const repo = getUserPromptRepository();
        if (!canHoldUserPrompts(req.user) || !repo.isAvailable()) {
          return res.json({ favorites: [], recents: [], stored: false, available: false });
        }
        const preferences = await repo.getPreferences(String(req.user.id));
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ ...preferences, available: true });
      } catch (error) {
        sendStorageError(res, error, 'load prompt preferences');
      }
    }
  );

  app.put(
    buildServerPath('/api/prompts/preferences'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        // Favorites are bookkeeping, not content: keep them out of the audit log.
        req._auditLogged = true;
        const repo = getUserPromptRepository();
        if (!canHoldUserPrompts(req.user)) {
          return refuse(res, 'This sign-in cannot keep preferences', 'USER_PROMPTS_NOT_ALLOWED');
        }
        if (!repo.isAvailable()) {
          return sendErrorResponse(res, 503, 'Prompt preferences are unavailable', {
            details: { code: 'USER_PROMPTS_UNAVAILABLE' }
          });
        }
        const body = parseBody(preferencesUpdateSchema, req, res);
        if (!body) return;
        await repo.setPreferences(String(req.user.id), body);
        const preferences = await repo.getPreferences(String(req.user.id));
        res.json({ ...preferences, available: true });
      } catch (error) {
        sendStorageError(res, error, 'save prompt preferences');
      }
    }
  );

  /**
   * @swagger
   * /api/prompts/share-targets:
   *   get:
   *     summary: Users and groups the caller may share a prompt with
   *     tags:
   *       - Prompts
   *     parameters:
   *       - in: query
   *         name: q
   *         schema:
   *           type: string
   *         description: |
   *           Search text; users need at least two characters. At most ten
   *           users and ten groups are returned.
   */
  app.get(buildServerPath('/api/prompts/share-targets'), ...gate, authenticatedOnly, (req, res) => {
    try {
      const deps = requireUserPrompts(req, res, { manage: true });
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
          .sort((a, b) => a.name.localeCompare(b.name))
          // Capped like users: with many groups the dialog offers what matches
          // the search, never the whole directory.
          .slice(0, LOOKUP_LIMIT);
      }
      res.json({ allowed, users, groups });
    } catch (error) {
      sendFailedOperationError(res, 'look up share targets', error);
    }
  });

  /**
   * @swagger
   * /api/prompts:
   *   post:
   *     summary: Create a user prompt
   *     description: |
   *       Creates a prompt owned by the caller, private until it is shared.
   *       Text placeholders use `{{name}}`; `variables` optionally describes
   *       them (label, description, type, default, required, options).
   *     tags:
   *       - Prompts
   *     responses:
   *       201:
   *         description: The created prompt
   *       409:
   *         description: The per-user prompt limit is reached
   */
  app.post(buildServerPath('/api/prompts'), ...gate, authenticatedOnly, async (req, res) => {
    try {
      const deps = requireUserPrompts(req, res);
      if (!deps) return;
      ensurePrincipal(req);
      const body = parseBody(userPromptContentSchema, req, res);
      if (!body) return;
      const content = checkedContent(body, req.user, res);
      if (!content) return;
      if (await refuseOverLimit(res, deps.repo, deps.settings, String(req.user.id))) return;
      const prompt = await deps.repo.create({
        owner: actorOf(req.user),
        content,
        maxVersions: deps.settings.maxVersions
      });
      if (!prompt) {
        return sendErrorResponse(res, 503, 'User prompts are unavailable', {
          details: { code: 'USER_PROMPTS_UNAVAILABLE' }
        });
      }
      logAudit({
        req,
        action: 'create',
        resource: 'userPrompt',
        resourceId: prompt.id,
        summary: `Created user prompt "${prompt.name}"`
      });
      const context = callerContext(req.user);
      res.status(201).json(
        serializeUserPrompt(
          prompt,
          userPromptPermissions(prompt, req.user, {
            groups: context.groups,
            isAdmin: context.isAdmin
          })
        )
      );
    } catch (error) {
      sendStorageError(res, error, 'create prompt');
    }
  });

  /**
   * @swagger
   * /api/prompts/{promptId}:
   *   get:
   *     summary: One prompt, global or user
   *     tags:
   *       - Prompts
   *     parameters:
   *       - in: path
   *         name: promptId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The prompt with its scope and permissions
   *       404:
   *         description: No such prompt, or not visible to the caller
   *   put:
   *     summary: Update a user prompt (saved as a new revision)
   *     tags:
   *       - Prompts
   *   delete:
   *     summary: Delete a user prompt (owner or admin)
   *     tags:
   *       - Prompts
   */
  app.get(buildServerPath('/api/prompts/:promptId'), ...gate, authRequired, async (req, res) => {
    try {
      const { promptId } = req.params;
      if (!validateIdForPath(promptId, 'prompt', res)) return;
      ensurePrincipal(req);
      if (!isUserPromptId(promptId)) {
        const prompt = visibleGlobalPrompts(req.user).find(entry => entry.id === promptId);
        if (!prompt) return sendNotFound(res, 'Prompt');
        return res.json(
          serializeGlobalPrompt(prompt, {
            canDuplicate: canHoldUserPrompts(req.user) && userPromptsActive()
          })
        );
      }
      if (!canHoldUserPrompts(req.user)) return sendNotFound(res, 'Prompt');
      const deps = requireUserPrompts(req, res, { manage: true });
      if (!deps) return;
      const loaded = await loadUserPrompt(req, res, deps.repo);
      if (!loaded) return;
      res.json(
        serializeUserPrompt(loaded.prompt, loaded.permissions, {
          ownerActive: loaded.ownerActive
        })
      );
    } catch (error) {
      sendStorageError(res, error, 'fetch prompt');
    }
  });

  app.put(
    buildServerPath('/api/prompts/:promptId'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { promptId } = req.params;
        if (!validateIdForPath(promptId, 'prompt', res)) return;
        if (!isUserPromptId(promptId)) {
          return refuse(
            res,
            'Global prompts are managed under Admin → Prompts',
            'GLOBAL_PROMPT_READ_ONLY'
          );
        }
        const deps = requireUserPrompts(req, res, { manage: true });
        if (!deps) return;
        ensurePrincipal(req);
        const loaded = await loadUserPrompt(req, res, deps.repo);
        if (!loaded) return;
        if (!loaded.permissions.canEdit) {
          return refuse(
            res,
            loaded.permissions.readOnly
              ? "This prompt is read-only: its owner's account is no longer active"
              : 'You can use this prompt but not change it'
          );
        }
        const body = parseBody(userPromptUpdateSchema, req, res);
        if (!body) return;
        const { expectedRevision, ...rest } = body;
        // The app is checked only when it changes: an editor who cannot open
        // the app the owner chose can still fix a typo in the text.
        const content =
          (rest.appId || null) === (loaded.prompt.appId || null)
            ? normalizeContent(rest)
            : checkedContent(rest, req.user, res);
        if (!content) return;
        const updated = await deps.repo.update(promptId, content, {
          actor: actorOf(req.user),
          expectedRevision,
          maxVersions: deps.settings.maxVersions,
          authorize: stillAllowed(req, loaded.context, 'canEdit')
        });
        if (!updated) return sendNotFound(res, 'Prompt');
        if (updated.revision !== loaded.prompt.revision) {
          logAudit({
            req,
            action: 'update',
            resource: 'userPrompt',
            resourceId: promptId,
            summary: `Updated user prompt "${updated.name}" (revision ${updated.revision})`
          });
        }
        res.json(
          serializeUserPrompt(
            updated,
            userPromptPermissions(updated, req.user, {
              groups: loaded.context.groups,
              isAdmin: loaded.context.isAdmin,
              ownerActive: loaded.ownerActive
            }),
            { ownerActive: loaded.ownerActive }
          )
        );
      } catch (error) {
        sendStorageError(res, error, 'update prompt');
      }
    }
  );

  app.delete(
    buildServerPath('/api/prompts/:promptId'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { promptId } = req.params;
        if (!validateIdForPath(promptId, 'prompt', res)) return;
        if (!isUserPromptId(promptId)) {
          return refuse(
            res,
            'Global prompts are managed under Admin → Prompts',
            'GLOBAL_PROMPT_READ_ONLY'
          );
        }
        const deps = requireUserPrompts(req, res, { manage: true });
        if (!deps) return;
        ensurePrincipal(req);
        const loaded = await loadUserPrompt(req, res, deps.repo);
        if (!loaded) return;
        if (!loaded.permissions.canDelete) {
          return refuse(res, 'Only the owner can delete this prompt');
        }
        const removed = await deps.repo.delete(promptId, {
          authorize: stillAllowed(req, loaded.context, 'canDelete')
        });
        if (!removed) return sendNotFound(res, 'Prompt');
        logAudit({
          req,
          action: 'delete',
          resource: 'userPrompt',
          resourceId: promptId,
          summary: loaded.permissions.isOwner
            ? `Deleted user prompt "${removed.name}"`
            : `Deleted user prompt "${removed.name}" owned by ${removed.ownerName || removed.ownerId}`
        });
        res.json({ message: 'Prompt deleted', id: promptId });
      } catch (error) {
        sendStorageError(res, error, 'delete prompt');
      }
    }
  );

  /**
   * @swagger
   * /api/prompts/{promptId}/duplicate:
   *   post:
   *     summary: Copy a global or shared prompt into the caller's own prompts
   *     tags:
   *       - Prompts
   */
  app.post(
    buildServerPath('/api/prompts/:promptId/duplicate'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { promptId } = req.params;
        if (!validateIdForPath(promptId, 'prompt', res)) return;
        const deps = requireUserPrompts(req, res);
        if (!deps) return;
        ensurePrincipal(req);
        const body = parseBody(duplicateSchema, req, res);
        if (!body) return;
        const language = body.language || configCache.getPlatform()?.defaultLanguage || 'en';

        let source;
        let copiedFrom;
        if (isUserPromptId(promptId)) {
          const loaded = await loadUserPrompt(req, res, deps.repo);
          if (!loaded) return;
          source = loaded.prompt;
          copiedFrom = { scope: 'user', id: promptId };
        } else {
          const prompt = visibleGlobalPrompts(req.user).find(entry => entry.id === promptId);
          if (!prompt) return sendNotFound(res, 'Prompt');
          source = contentOfGlobalPrompt(prompt, language);
          copiedFrom = { scope: 'global', id: promptId };
        }

        const candidate = {
          name: (body.name || source.name || '').slice(0, 200),
          description: (source.description || '').slice(0, 2000),
          prompt: source.prompt || '',
          icon: source.icon || null,
          category: source.category || null,
          appId: source.appId && appIsUsable(source.appId, req.user) ? source.appId : null,
          variables: source.variables || []
        };
        let parsed = userPromptContentSchema.safeParse(candidate);
        if (!parsed.success) {
          // A global prompt's variables may carry shapes a user prompt does
          // not accept; the text is what matters, keep that.
          parsed = userPromptContentSchema.safeParse({ ...candidate, variables: [] });
        }
        if (!parsed.success) {
          return sendBadRequest(
            res,
            `This prompt cannot be copied: ${describeIssues(parsed.error)}`
          );
        }
        if (await refuseOverLimit(res, deps.repo, deps.settings, String(req.user.id))) return;
        const prompt = await deps.repo.create({
          owner: actorOf(req.user),
          content: normalizeContent(parsed.data),
          copiedFrom,
          maxVersions: deps.settings.maxVersions
        });
        if (!prompt) {
          return sendErrorResponse(res, 503, 'User prompts are unavailable', {
            details: { code: 'USER_PROMPTS_UNAVAILABLE' }
          });
        }
        logAudit({
          req,
          action: 'create',
          resource: 'userPrompt',
          resourceId: prompt.id,
          summary: `Duplicated ${copiedFrom.scope} prompt ${promptId} as "${prompt.name}"`
        });
        const context = callerContext(req.user);
        res.status(201).json(
          serializeUserPrompt(
            prompt,
            userPromptPermissions(prompt, req.user, {
              groups: context.groups,
              isAdmin: context.isAdmin
            })
          )
        );
      } catch (error) {
        sendStorageError(res, error, 'duplicate prompt');
      }
    }
  );

  /**
   * @swagger
   * /api/prompts/{promptId}/shares:
   *   put:
   *     summary: Replace who a user prompt is shared with
   *     description: |
   *       Owners, admins and anyone the prompt is shared with as *can edit*
   *       may change the list. Each entry is `{ type: user|group|everyone,
   *       id, permission: use|edit }`. Revoking takes effect immediately.
   *     tags:
   *       - Prompts
   */
  app.put(
    buildServerPath('/api/prompts/:promptId/shares'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { promptId } = req.params;
        if (!validateIdForPath(promptId, 'prompt', res)) return;
        if (!isUserPromptId(promptId)) {
          return refuse(res, 'Global prompts are shared through groups', 'GLOBAL_PROMPT_READ_ONLY');
        }
        const deps = requireUserPrompts(req, res, { manage: true });
        if (!deps) return;
        ensurePrincipal(req);
        const loaded = await loadUserPrompt(req, res, deps.repo);
        if (!loaded) return;
        if (!loaded.permissions.canShare) {
          return refuse(res, 'You cannot change who this prompt is shared with');
        }
        const body = parseBody(sharesUpdateSchema, req, res);
        if (!body) return;
        const resolved = resolveShares(body.shares, {
          prompt: loaded.prompt,
          allowed: allowedTargetsFor(deps.settings, loaded.context),
          users: usersDb(),
          groups: loaded.context.config.groups || {}
        });
        if (!resolved.ok) {
          return sendErrorResponse(res, resolved.status, resolved.error, {
            details: resolved.details
          });
        }
        const result = await deps.repo.setShares(promptId, resolved.shares, {
          actor: actorOf(req.user),
          authorize: stillAllowed(req, loaded.context, 'canShare')
        });
        if (!result) return sendNotFound(res, 'Prompt');
        if (result.added.length || result.removed.length) {
          const everyone = result.prompt.shares.some(share => share.type === 'everyone');
          logAudit({
            req,
            action: 'update',
            resource: 'userPromptShare',
            resourceId: promptId,
            summary:
              `Changed sharing of user prompt "${result.prompt.name}": ` +
              `${result.added.length} added, ${result.removed.length} removed` +
              `${everyone ? ' (shared with everyone)' : ''}`
          });
        }
        res.json(
          serializeUserPrompt(
            result.prompt,
            userPromptPermissions(result.prompt, req.user, {
              groups: loaded.context.groups,
              isAdmin: loaded.context.isAdmin,
              ownerActive: loaded.ownerActive
            }),
            { ownerActive: loaded.ownerActive }
          )
        );
      } catch (error) {
        sendStorageError(res, error, 'share prompt');
      }
    }
  );

  /**
   * @swagger
   * /api/prompts/{promptId}/owner:
   *   put:
   *     summary: Hand a user prompt to another user (owner or admin)
   *     tags:
   *       - Prompts
   */
  app.put(
    buildServerPath('/api/prompts/:promptId/owner'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { promptId } = req.params;
        if (!validateIdForPath(promptId, 'prompt', res)) return;
        if (!isUserPromptId(promptId)) return sendNotFound(res, 'Prompt');
        const deps = requireUserPrompts(req, res, { manage: true });
        if (!deps) return;
        ensurePrincipal(req);
        const loaded = await loadUserPrompt(req, res, deps.repo);
        if (!loaded) return;
        if (!loaded.permissions.canTransfer) {
          return refuse(res, 'Only the owner can hand this prompt over');
        }
        const body = parseBody(transferSchema, req, res);
        if (!body) return;
        const users = usersDb();
        const target = findUser(users, body.ownerId);
        if (!target || target.active === false) {
          return sendBadRequest(res, 'The new owner is not a known, active user');
        }
        if (body.ownerId === String(loaded.prompt.ownerId)) {
          return res.json(
            serializeUserPrompt(loaded.prompt, loaded.permissions, {
              ownerActive: loaded.ownerActive
            })
          );
        }
        if (
          await refuseOverLimit(
            res,
            deps.repo,
            deps.settings,
            body.ownerId,
            `The new owner already has ${deps.settings.maxPromptsPerUser} prompts, the most one user can keep`
          )
        ) {
          return;
        }
        const transferred = await deps.repo.transfer(
          promptId,
          { id: body.ownerId, name: displayName({ ...target, id: body.ownerId }) },
          { actor: actorOf(req.user), authorize: stillAllowed(req, loaded.context, 'canTransfer') }
        );
        if (!transferred) return sendNotFound(res, 'Prompt');
        logAudit({
          req,
          action: 'update',
          resource: 'userPrompt',
          resourceId: promptId,
          summary: `Handed user prompt "${transferred.name}" to ${transferred.ownerName}`
        });
        res.json(
          serializeUserPrompt(
            transferred,
            userPromptPermissions(transferred, req.user, {
              groups: loaded.context.groups,
              isAdmin: loaded.context.isAdmin,
              ownerActive: true
            })
          )
        );
      } catch (error) {
        sendStorageError(res, error, 'transfer prompt');
      }
    }
  );

  /**
   * @swagger
   * /api/prompts/{promptId}/versions:
   *   get:
   *     summary: Saved revisions of a user prompt, newest first
   *     description: Visible to those who may edit the prompt.
   *     tags:
   *       - Prompts
   */
  app.get(
    buildServerPath('/api/prompts/:promptId/versions'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { promptId } = req.params;
        if (!validateIdForPath(promptId, 'prompt', res)) return;
        if (!isUserPromptId(promptId)) return sendNotFound(res, 'Prompt');
        const deps = requireUserPrompts(req, res, { manage: true });
        if (!deps) return;
        ensurePrincipal(req);
        const loaded = await loadUserPrompt(req, res, deps.repo);
        if (!loaded) return;
        // History can hold text the owner has since taken out; it is for the
        // people who may change the prompt, not for everyone who may use it.
        if (!loaded.permissions.canEdit && !loaded.permissions.isOwner) {
          return refuse(res, 'You cannot see the history of this prompt');
        }
        const versions = await deps.repo.listVersions(promptId);
        res.json({
          revision: loaded.prompt.revision,
          versions: versions.map(version => ({
            revision: version.revision,
            name: version.name,
            description: version.description,
            prompt: version.prompt,
            icon: version.icon,
            category: version.category,
            appId: version.appId,
            variables: version.variables,
            savedAt: version.savedAt,
            savedBy: version.savedBy?.name || '',
            restoredFrom: version.restoredFrom ?? null
          }))
        });
      } catch (error) {
        sendStorageError(res, error, 'list prompt versions');
      }
    }
  );

  app.post(
    buildServerPath('/api/prompts/:promptId/versions/:revision/restore'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        const { promptId } = req.params;
        if (!validateIdForPath(promptId, 'prompt', res)) return;
        if (!isUserPromptId(promptId)) return sendNotFound(res, 'Prompt');
        const revision = Number.parseInt(req.params.revision, 10);
        if (
          !Number.isInteger(revision) ||
          revision < 1 ||
          String(revision) !== req.params.revision
        ) {
          return sendBadRequest(res, 'Invalid revision');
        }
        const deps = requireUserPrompts(req, res, { manage: true });
        if (!deps) return;
        ensurePrincipal(req);
        const loaded = await loadUserPrompt(req, res, deps.repo);
        if (!loaded) return;
        if (!loaded.permissions.canEdit) {
          return refuse(res, 'You can use this prompt but not change it');
        }
        const version = await deps.repo.getVersion(promptId, revision);
        if (!version) return sendNotFound(res, 'Revision');
        const restored = await deps.repo.update(promptId, version, {
          actor: actorOf(req.user),
          restoredFrom: revision,
          maxVersions: deps.settings.maxVersions,
          authorize: stillAllowed(req, loaded.context, 'canEdit')
        });
        if (!restored) return sendNotFound(res, 'Prompt');
        logAudit({
          req,
          action: 'update',
          resource: 'userPrompt',
          resourceId: promptId,
          summary: `Restored user prompt "${restored.name}" to revision ${revision}`
        });
        res.json(
          serializeUserPrompt(
            restored,
            userPromptPermissions(restored, req.user, {
              groups: loaded.context.groups,
              isAdmin: loaded.context.isAdmin,
              ownerActive: loaded.ownerActive
            }),
            { ownerActive: loaded.ownerActive }
          )
        );
      } catch (error) {
        sendStorageError(res, error, 'restore prompt version');
      }
    }
  );

  /**
   * @swagger
   * /api/prompts/{promptId}/usage:
   *   post:
   *     summary: Record that the caller used a prompt (drives "recent")
   *     tags:
   *       - Prompts
   */
  app.post(
    buildServerPath('/api/prompts/:promptId/usage'),
    ...gate,
    authenticatedOnly,
    async (req, res) => {
      try {
        req._auditLogged = true;
        const { promptId } = req.params;
        if (!isValidId(promptId)) return sendBadRequest(res, 'Invalid prompt ID');
        const repo = getUserPromptRepository();
        if (!canHoldUserPrompts(req.user) || !repo.isAvailable()) {
          return res.status(204).end();
        }
        const preferences = await repo.recordUsage(String(req.user.id), promptId);
        res.json({ recents: preferences?.recents || [] });
      } catch (error) {
        sendStorageError(res, error, 'record prompt usage');
      }
    }
  );
}
