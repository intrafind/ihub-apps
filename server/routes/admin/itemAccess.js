// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import {
  currentDefaultModelId,
  getDefaultAnonymousGroups,
  isAnonymousAccessAllowed
} from '../../utils/authorization.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { assertValidId, isValidId } from '../../utils/pathSecurity.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import logger from '../../utils/logger.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import { assertGroupsResolvable } from '../../utils/adminGuards.js';
import {
  GRANT_LIST_TYPES,
  canonicalGrantListType,
  describeAudience,
  describeContentAccess
} from '../../utils/contentAccess.js';
import {
  ACCESS_CHECK_TYPES,
  RESTRICT_TYPES,
  checkAccess,
  planRestriction,
  resolveSubject,
  wildcardGroupIds
} from '../../utils/accessCheck.js';
import { FEATURE_IDS, isFeatureEnabled } from '../../featureRegistry.js';
import { missingAppIntegrations } from '../../integrationRegistry.js';
import { filterModelsForApp } from '../../services/chat/RequestBuilder.js';
import { findUserByIdentifier, loadUsers } from '../../utils/userManager.js';
import { localUsersFile } from '../../utils/contentsPath.js';

/**
 * Admin views of who can use an app, model, prompt, skill or workflow, an
 * access check ("why can't this group see it?") and the restrict action that
 * replaces a group's wildcard with an explicit list.
 *
 * Full admins only: the views list every group, the check reads user records,
 * and the restrict action rewrites groups the way the group editor does.
 * Content admins keep `/api/admin/content-access`.
 */

/** The group configuration, as a path relative to `contents/`. */
const GROUPS_FILE = 'config/groups.json';

/**
 * Every configured item of a type, disabled ones too.
 * @param {string} type - One of GRANT_LIST_TYPES
 * @returns {object[]}
 */
function allItems(type) {
  switch (type) {
    case 'apps':
      return configCache.getApps(true)?.data || [];
    case 'models':
      return configCache.getModels(true)?.data || [];
    case 'prompts':
      return configCache.getPrompts(true)?.data || [];
    case 'workflows':
      return configCache.getWorkflows(true)?.data || [];
    case 'skills':
      // Skills are named, not numbered; the permission entry is the name.
      return (configCache.getSkills()?.data || [])
        .filter(skill => typeof skill?.name === 'string')
        .map(skill => ({ ...skill, id: skill.name }));
    default:
      return [];
  }
}

/** The id of every configured item of a type, as configured. */
const allIds = type =>
  allItems(type)
    .map(item => item?.id)
    .filter(id => typeof id === 'string' && id.length > 0);

/**
 * Validate `:type` against `allowed` and `:id`, and find the item.
 * @param {object} req
 * @param {readonly string[]} allowed - The types this route answers for
 * @returns {{ type: string, item: object }}
 */
function resolveItem(req, allowed) {
  const type = canonicalGrantListType(req.params.type);
  if (type === undefined || !allowed.includes(type)) {
    throw new ServiceError(
      'BAD_REQUEST',
      `Unknown type '${req.params.type}'. Expected one of: ${allowed.join(', ')}`
    );
  }
  assertValidId(req.params.id, type.slice(0, -1));
  const item = findByIdCaseInsensitive(allItems(type), req.params.id);
  if (!item) {
    throw new ServiceError('NOT_FOUND', `${type.slice(0, -1)} '${req.params.id}' not found`);
  }
  return { type, item };
}

/** The platform settings the views need, read once per request. */
function platformContext() {
  const platform = configCache.getPlatform() || {};
  const authenticatedGroup = platform.auth?.authenticatedGroup || 'authenticated';
  const anonymousAllowed = isAnonymousAccessAllowed(platform);
  const anonymousGroups = anonymousAllowed ? getDefaultAnonymousGroups(platform) : [];
  return {
    platform,
    // The model `@default` in a group's model list grants right now.
    defaultModelId: currentDefaultModelId(),
    authenticatedGroup,
    anonymousAllowed,
    anonymousGroups,
    implicitGroups: Array.from(new Set([authenticatedGroup, 'authenticated', 'anonymous']))
  };
}

async function readGroups() {
  const groupsData = await configStore.readJsonStrict(GROUPS_FILE);
  if (!groupsData?.groups) throw new ServiceError('NOT_FOUND', 'Groups file not found');
  return groupsData;
}

/**
 * The access view of one item: every group with how it gets the item, who gets
 * it without being in a particular group, and which groups grant it through a
 * wildcard (the groups the restrict action can convert).
 */
function buildView(groups, type, contentId, context) {
  const wildcards = wildcardGroupIds(groups, type);
  return {
    type,
    id: contentId,
    groups: describeContentAccess({
      groups,
      type,
      contentId,
      groupIds: Object.keys(groups),
      implicitGroups: context.implicitGroups,
      defaultModelId: context.defaultModelId
    }),
    audience: describeAudience({
      groups,
      type,
      contentId,
      authenticatedGroup: context.authenticatedGroup,
      anonymousGroups: context.anonymousGroups,
      defaultModelId: context.defaultModelId
    }),
    wildcardGroups: wildcards,
    restrictable: RESTRICT_TYPES.includes(type) && wildcards.length > 0
  };
}

/** The body of a restrict request, checked. */
function restrictBody(req) {
  const { groupIds, grantGroupIds = [] } = req.body || {};
  const checkList = (list, field) => {
    if (list === undefined) return;
    if (!Array.isArray(list) || list.some(id => !isValidId(id))) {
      throw new ServiceError('VALIDATION_FAILED', `'${field}' must be an array of group ids`, {
        details: [{ path: field, code: 'invalid_type', message: 'Expected an array of group ids' }]
      });
    }
  };
  checkList(groupIds, 'groupIds');
  checkList(grantGroupIds, 'grantGroupIds');
  return { groupIds, grantGroupIds };
}

/** The plan as the client reads it: without the rewritten groups. */
function planBody(type, contentId, plan) {
  const { updatedGroups: _updatedGroups, ...rest } = plan;
  return { type, id: contentId, ...rest };
}

/**
 * @swagger
 * components:
 *   schemas:
 *     GrantRoute:
 *       type: object
 *       description: One way members of a group get an item
 *       properties:
 *         groupId:
 *           type: string
 *           description: The group whose own list grants the item
 *         kind:
 *           type: string
 *           enum: [explicit, wildcard, default]
 *           description: >-
 *             The list names the item, holds `*`, or holds `@default` while the
 *             item (a model) is the platform's default model
 *         path:
 *           type: array
 *           items:
 *             type: string
 *           description: The inheritance chain from the asked group to `groupId`
 *           example: ["admins", "users", "authenticated"]
 *     ItemAccess:
 *       type: object
 *       properties:
 *         type:
 *           type: string
 *           enum: [apps, models, prompts, skills, workflows]
 *         id:
 *           type: string
 *         groups:
 *           type: array
 *           items:
 *             allOf:
 *               - $ref: '#/components/schemas/ContentAccessGroup'
 *               - type: object
 *                 properties:
 *                   via:
 *                     type: array
 *                     items:
 *                       $ref: '#/components/schemas/GrantRoute'
 *         audience:
 *           $ref: '#/components/schemas/ContentAccessAudience'
 *         wildcardGroups:
 *           type: array
 *           items:
 *             type: string
 *           description: Groups whose own list grants every item of the type
 *         restrictable:
 *           type: boolean
 *           description: The restrict action can convert a wildcard for this item
 *     AccessVerdict:
 *       type: object
 *       properties:
 *         type:
 *           type: string
 *           enum: [apps, models]
 *         id:
 *           type: string
 *         subject:
 *           type: object
 *           properties:
 *             kind:
 *               type: string
 *               enum: [group, anonymous, user]
 *             id:
 *               type: string
 *             name:
 *               type: string
 *             groups:
 *               type: array
 *               items:
 *                 type: string
 *               description: The groups the subject's requests carry
 *             notes:
 *               type: array
 *               items:
 *                 type: string
 *                 enum: [identityProviderGroupsUnknown]
 *         verdict:
 *           type: string
 *           enum: [available, unavailable]
 *         reasons:
 *           type: array
 *           description: >
 *             In the order a user meets them. `code` is one of anonymousAccessOff,
 *             userInactive, itemEnabled, itemDisabled, featureOn, featureOff,
 *             integrationOff, granted, notGranted, modelsAvailable, noUsableModel,
 *             preferredModelUnavailable; the other fields are the values of that code.
 *           items:
 *             type: object
 *             properties:
 *               code:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [ok, blocked, warning]
 *     RestrictionPlan:
 *       type: object
 *       properties:
 *         type:
 *           type: string
 *           enum: [apps, models, prompts]
 *         id:
 *           type: string
 *         candidates:
 *           type: array
 *           description: Every group holding `*` for the type
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *               name:
 *                 type: string
 *               itemCount:
 *                 type: integer
 *                 description: Items in the explicit list that would replace `*`
 *               currentCount:
 *                 type: integer
 *                 description: Items configured today
 *               passesTo:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Groups that inherit from this one
 *               selected:
 *                 type: boolean
 *         selected:
 *           type: array
 *           items:
 *             type: string
 *         grantGroupIds:
 *           type: array
 *           items:
 *             type: string
 *         groupsAfter:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *               name:
 *                 type: string
 *               before:
 *                 type: boolean
 *               after:
 *                 type: boolean
 *               via:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/GrantRoute'
 *         audienceBefore:
 *           $ref: '#/components/schemas/ContentAccessAudience'
 *         audienceAfter:
 *           $ref: '#/components/schemas/ContentAccessAudience'
 *         changes:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               groupId:
 *                 type: string
 *               action:
 *                 type: string
 *                 enum: [restrict, grant]
 *         defaultModelGroups:
 *           type: array
 *           description: >-
 *             Groups whose model list holds `@default` while the restricted model is
 *             the default model: they keep granting it, the restrict leaves `@default` alone
 *           items:
 *             type: string
 *     RestrictRequest:
 *       type: object
 *       properties:
 *         groupIds:
 *           type: array
 *           description: Wildcard groups to convert; all of them when left out
 *           items:
 *             type: string
 *         grantGroupIds:
 *           type: array
 *           description: Groups to grant the item to by name afterwards
 *           items:
 *             type: string
 *       example:
 *         groupIds: ["users", "authenticated"]
 *         grantGroupIds: ["hr"]
 */
export default function registerAdminItemAccessRoutes(app) {
  /**
   * @swagger
   * /api/admin/access/{type}/{id}:
   *   get:
   *     summary: Which groups can use an app, model, prompt, skill or workflow, and why
   *     description: |
   *       Every group with the routes by which its members get the item: its own
   *       list or the list of a group it inherits from, naming the item or
   *       holding `*`. Read-only; models are included, which the content-access
   *       view leaves out.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: type
   *         required: true
   *         schema:
   *           type: string
   *           enum: [apps, models, prompts, skills, workflows]
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The access view
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ItemAccess'
   *       400:
   *         description: Unknown type or invalid id
   *       401:
   *         description: Not signed in
   *       403:
   *         description: Admin access required
   *       404:
   *         description: No such item
   */
  app.get(buildServerPath('/api/admin/access/:type/:id'), adminAuth, async (req, res) => {
    const { type, item } = resolveItem(req, GRANT_LIST_TYPES);
    const { groups } = await readGroups();
    res.json(buildView(groups, type, item.id, platformContext()));
  });

  /**
   * @swagger
   * /api/admin/access/{type}/{id}/verdict:
   *   get:
   *     summary: Whether a group or a user can use an app or a model, with the reasons
   *     description: |
   *       Answers "why can't users see this?" with the server's own rules: the
   *       item is enabled, the app's required features and integrations are on,
   *       a group of the subject grants it (by name, by `*`, through
   *       inheritance), and a chat app has a model that is enabled, allowed for
   *       the app and granted to the subject.
   *
   *       Give exactly one of `groupId` and `userId`. A group is checked as its
   *       members are: signed in, so with the group of every signed-in user. A
   *       user is checked with the groups recorded in `users.json`; groups an
   *       identity provider sends at sign-in are not known (`notes`).
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: type
   *         required: true
   *         schema:
   *           type: string
   *           enum: [apps, models]
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: groupId
   *         schema:
   *           type: string
   *         example: "users"
   *       - in: query
   *         name: userId
   *         description: User id, username or email of a user in users.json
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The verdict and its reasons
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AccessVerdict'
   *       400:
   *         description: Unknown type, invalid id, or not exactly one of groupId and userId
   *       401:
   *         description: Not signed in
   *       403:
   *         description: Admin access required
   *       404:
   *         description: No such item, group or user
   */
  app.get(buildServerPath('/api/admin/access/:type/:id/verdict'), adminAuth, async (req, res) => {
    const { type, item } = resolveItem(req, ACCESS_CHECK_TYPES);
    const { groupId, userId } = req.query;
    const hasGroup = typeof groupId === 'string' && groupId.length > 0;
    const hasUser = typeof userId === 'string' && userId.length > 0;
    if (hasGroup === hasUser) {
      throw new ServiceError('VALIDATION_FAILED', 'Give exactly one of groupId and userId', {
        details: [
          { path: 'groupId', code: 'invalid_value', message: 'Exactly one of groupId, userId' }
        ]
      });
    }

    const context = platformContext();
    const { groups } = await readGroups();

    let userRecord;
    if (hasGroup) {
      assertValidId(groupId, 'group');
      if (!Object.hasOwn(groups, groupId)) {
        throw new ServiceError('NOT_FOUND', `Group '${groupId}' not found`);
      }
    } else {
      if (userId.length > 320 || ['__proto__', 'constructor', 'prototype'].includes(userId)) {
        throw new ServiceError('BAD_REQUEST', 'Invalid user id');
      }
      const usersConfig = loadUsers(localUsersFile(context.platform.localAuth)) || {};
      const users = usersConfig.users || {};
      userRecord = Object.hasOwn(users, userId)
        ? { ...users[userId], id: userId }
        : findUserByIdentifier(usersConfig, userId);
      if (!userRecord) throw new ServiceError('NOT_FOUND', `User '${userId}' not found`);
    }

    const subject = resolveSubject({
      groups,
      groupId: hasGroup ? groupId : undefined,
      userRecord,
      authenticatedGroup: context.authenticatedGroup,
      anonymousAllowed: context.anonymousAllowed,
      anonymousGroups: context.anonymousGroups
    });

    const features = configCache.getFeatures?.() || {};
    const required = Array.isArray(item.requiredFeatures) ? item.requiredFeatures : [];
    const result = checkAccess({
      type,
      item,
      subject,
      groups,
      models: allItems('models'),
      featuresOff:
        type === 'apps'
          ? required.filter(
              featureId =>
                !FEATURE_IDS.includes(featureId) || !isFeatureEnabled(featureId, features)
            )
          : [],
      integrationsOff:
        type === 'apps'
          ? missingAppIntegrations(item, configCache.getIntegrationContext?.() || {})
          : [],
      filterModelsForApp,
      defaultModelId: context.defaultModelId
    });

    res.json({
      type,
      id: item.id,
      subject: {
        kind: subject.kind,
        id: subject.id,
        name: subject.name,
        groups: subject.groups,
        notes: subject.notes
      },
      ...result
    });
  });

  /**
   * @swagger
   * /api/admin/access/{type}/{id}/_preview-restrict:
   *   post:
   *     summary: Preview replacing wildcards so that an item is no longer granted to everyone
   *     description: |
   *       What `_restrict` would do with the same body, without writing: which
   *       groups hold `*`, the explicit list each would get (every current item
   *       but this one), and which groups can use the item afterwards. Items
   *       added later are not visible by default in a converted group.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: type
   *         required: true
   *         schema:
   *           type: string
   *           enum: [apps, models, prompts]
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RestrictRequest'
   *     responses:
   *       200:
   *         description: The plan
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/RestrictionPlan'
   *       400:
   *         description: Unknown type, invalid id or body, or a group without a wildcard in groupIds
   *       401:
   *         description: Not signed in
   *       403:
   *         description: Admin access required
   *       404:
   *         description: No such item or group
   */
  app.post(
    buildServerPath('/api/admin/access/:type/:id/_preview-restrict'),
    adminAuth,
    async (req, res) => {
      const { type, item } = resolveItem(req, RESTRICT_TYPES);
      const body = restrictBody(req);
      const context = platformContext();
      const { groups } = await readGroups();
      const plan = planRestriction({
        groups,
        type,
        contentId: item.id,
        allIds: allIds(type),
        ...body,
        implicitGroups: context.implicitGroups,
        authenticatedGroup: context.authenticatedGroup,
        anonymousGroups: context.anonymousGroups,
        defaultModelId: context.defaultModelId
      });
      res.json(planBody(type, item.id, plan));
    }
  );

  /**
   * @swagger
   * /api/admin/access/{type}/{id}/_restrict:
   *   post:
   *     summary: Replace wildcards with explicit lists that leave one item out
   *     description: |
   *       In each named group (all groups holding `*` when `groupIds` is left
   *       out) the wildcard for the type becomes an explicit list of every item
   *       configured now except this one; then the item is granted by name to
   *       `grantGroupIds`. The plan is recomputed from the groups as stored when
   *       the write happens.
   *
   *       Each changed group gets a change-history snapshot and an audit entry,
   *       exactly as an edit in the group editor would. Items added later are no
   *       longer visible by default in a converted group.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: type
   *         required: true
   *         schema:
   *           type: string
   *           enum: [apps, models, prompts]
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RestrictRequest'
   *     responses:
   *       200:
   *         description: The access view after the change, plus the ids of the groups that changed
   *         content:
   *           application/json:
   *             schema:
   *               allOf:
   *                 - $ref: '#/components/schemas/ItemAccess'
   *                 - type: object
   *                   properties:
   *                     changed:
   *                       type: array
   *                       items:
   *                         type: string
   *       400:
   *         description: Unknown type, invalid id or body, or a group without a wildcard in groupIds
   *       401:
   *         description: Not signed in
   *       403:
   *         description: Admin access required
   *       404:
   *         description: No such item or group
   */
  app.post(
    buildServerPath('/api/admin/access/:type/:id/_restrict'),
    adminAuth,
    async (req, res) => {
      const { type, item } = resolveItem(req, RESTRICT_TYPES);
      const body = restrictBody(req);
      const context = platformContext();
      const ids = allIds(type);

      // Plan, change and write on the body read under the lock, so a group
      // edit landing in between is neither reverted nor lost.
      let changed = [];
      const { data: groupsData } = await configStore.updateJson(GROUPS_FILE, groupsData => {
        if (!groupsData?.groups) throw new ServiceError('NOT_FOUND', 'Groups file not found');
        const groupsBefore = structuredClone(groupsData);
        const plan = planRestriction({
          groups: groupsData.groups,
          type,
          contentId: item.id,
          allIds: ids,
          ...body,
          implicitGroups: context.implicitGroups,
          authenticatedGroup: context.authenticatedGroup,
          anonymousGroups: context.anonymousGroups,
          defaultModelId: context.defaultModelId
        });
        changed = plan.changes.map(change => ({
          ...change,
          before: structuredClone(groupsBefore.groups[change.groupId]),
          after: plan.updatedGroups[change.groupId]
        }));
        if (changed.length === 0) return undefined;
        const next = { ...groupsData, groups: plan.updatedGroups };
        // Like every groups.json writer: never store a body that does not resolve.
        assertGroupsResolvable(next, groupsBefore);
        next.metadata = { ...groupsData.metadata, lastModified: new Date().toISOString() };
        return next;
      });

      if (changed.length > 0) {
        await configCache.refreshCacheEntry(GROUPS_FILE);
        const admin = req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown';
        const noun = type.slice(0, -1);
        // One snapshot and one audit entry per group, whatever happened to it.
        const byGroup = new Map();
        for (const change of changed) {
          const entry = byGroup.get(change.groupId) || { ...change, actions: [] };
          entry.actions.push(change.action);
          entry.after = change.after;
          byGroup.set(change.groupId, entry);
        }
        for (const [groupId, entry] of byGroup) {
          await saveSnapshot({
            resource: 'group',
            id: groupId,
            before: entry.before,
            after: entry.after,
            admin
          });
          const summaries = entry.actions.map(action =>
            action === 'restrict'
              ? `Replaced all ${type} with an explicit list without ${noun} ${item.id} in group ${groupId}`
              : `Granted ${noun} ${item.id} to group ${groupId}`
          );
          await logAudit({
            req,
            action: 'update',
            resource: 'group',
            resourceId: groupId,
            summary: summaries.join('; ')
          });
        }
        logger.info('Restricted item access', {
          component: 'AdminItemAccess',
          type,
          contentId: item.id,
          changed: changed.map(change => `${change.action}:${change.groupId}`)
        });
      }

      const view = buildView(groupsData.groups, type, item.id, context);
      res.json({ ...view, changed: [...new Set(changed.map(change => change.groupId))] });
    }
  );
}
