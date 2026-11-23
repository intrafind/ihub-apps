// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Why a group or a user can or cannot use an app or a model, and how to take
 * one item out of the groups that grant it through a wildcard.
 *
 * Everything here is pure: the routes hand in `groups.json`, the configured
 * apps and models, the feature flags and the platform settings, and get back
 * plain objects. The rules are the server's own:
 *
 * - group grants: the `permissions.<type>` lists with `*` and `inherits`, read
 *   the way `resolveGroupInheritance` + `getPermissionsForUser` read them
 *   (see `describeGrantRoutes` in `contentAccess.js`); a model list's
 *   `@default` grants the platform's current default model;
 * - an app is offered only while it is enabled and its required features and
 *   integrations are on (`configCache.getApps`);
 * - a chat app answers only with a model the app allows, that is enabled and
 *   that the user's groups grant (`filterModelsForApp` + `filterModelsForUser`
 *   in `RequestBuilder.js`).
 *
 * Nothing here introduces an audience on the item: access stays a property of
 * the groups.
 *
 * @module utils/accessCheck
 */

import {
  canonicalGrantListType,
  collectAncestorPaths,
  describeAudience,
  describeContentAccess,
  describeGrantRoutes
} from './contentAccess.js';
import { ServiceError } from './ServiceError.js';
import { effectiveDefaultModelId } from './resourceDependants.js';
import { grantsAsDefaultModel } from '../../shared/modelPermissions.js';

/** The item types the access check answers for. */
export const ACCESS_CHECK_TYPES = Object.freeze(['apps', 'models']);

/**
 * The item types the restrict action rewrites wildcards for: the lists whose
 * items have an `id` the explicit list can name.
 */
export const RESTRICT_TYPES = Object.freeze(['apps', 'models', 'prompts']);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Who the check is about, as the groups their requests carry.
 *
 * - A group: its members are signed in, so they also carry the group of every
 *   signed-in user (`auth.authenticatedGroup`). Asking about that group alone
 *   means "someone who is signed in and in no other group".
 * - The anonymous group (or one of `anonymousAuth.defaultGroups`): people who
 *   are not signed in. With anonymous access off they get nothing.
 * - A user: the groups recorded for them in `users.json` (`internalGroups`),
 *   plus the group of every signed-in user. Groups an identity provider sends
 *   at sign-in are not known here; the result says so in `notes`.
 *
 * @param {object} options
 * @param {Object<string, object>} options.groups - `groups` map from groups.json
 * @param {string} [options.groupId] - The group to check
 * @param {object} [options.userRecord] - The user's record from users.json (with `id`)
 * @param {string} [options.authenticatedGroup='authenticated']
 * @param {boolean} [options.anonymousAllowed=false] - Anonymous access is on
 * @param {string[]} [options.anonymousGroups=[]] - `anonymousAuth.defaultGroups`
 * @returns {{kind: 'group'|'anonymous'|'user', id: string, name: string, groups: string[],
 *   active: boolean, anonymousOff: boolean, notes: string[]}}
 */
export function resolveSubject({
  groups,
  groupId,
  userRecord,
  authenticatedGroup = 'authenticated',
  anonymousAllowed = false,
  anonymousGroups = []
}) {
  const map = groups || {};
  const existing = ids =>
    [...new Set(ids)].filter(id => typeof id === 'string' && Object.hasOwn(map, id));
  const anonymousIds = new Set(['anonymous', ...(anonymousGroups || [])]);

  if (userRecord) {
    const internal = Array.isArray(userRecord.internalGroups)
      ? userRecord.internalGroups.map(String)
      : ['users'];
    const methods = Array.isArray(userRecord.authMethods) ? userRecord.authMethods : [];
    const external = methods.some(method => method !== 'local');
    return {
      kind: 'user',
      id: String(userRecord.id),
      name: String(userRecord.name || userRecord.username || userRecord.id),
      groups: existing([...internal, authenticatedGroup]),
      active: userRecord.active !== false,
      anonymousOff: false,
      notes: external ? ['identityProviderGroupsUnknown'] : []
    };
  }

  const group = map[groupId];
  const name = typeof group?.name === 'string' && group.name ? group.name : groupId;
  if (anonymousIds.has(groupId) && groupId !== authenticatedGroup) {
    return {
      kind: 'anonymous',
      id: groupId,
      name,
      groups: anonymousAllowed ? existing(anonymousGroups) : [],
      active: true,
      anonymousOff: !anonymousAllowed,
      notes: []
    };
  }
  return {
    kind: 'group',
    id: groupId,
    name,
    groups: existing([groupId, authenticatedGroup]),
    active: true,
    anonymousOff: false,
    notes: []
  };
}

/**
 * The routes by which any of `subjectGroups` gets one item, shortest chain
 * first, each granting group once with its shortest chain (two of the
 * subject's groups may share an ancestor).
 *
 * @param {object} options
 * @param {Object<string, object>} options.groups
 * @param {string} options.type
 * @param {string} options.contentId
 * @param {string[]} options.subjectGroups
 * @param {string|null} [options.defaultModelId] - The platform's current default model
 * @returns {Array<{groupId: string, kind: 'explicit'|'wildcard'|'default', path: string[]}>}
 */
export function subjectGrantRoutes({
  groups,
  type,
  contentId,
  subjectGroups,
  defaultModelId = null
}) {
  const all = subjectGroups
    .flatMap(groupId => describeGrantRoutes({ groups, type, contentId, groupId, defaultModelId }))
    // Stable: equally short routes keep the order of the subject's groups.
    .sort((a, b) => a.path.length - b.path.length);
  const seen = new Set();
  return all.filter(route => {
    if (seen.has(route.groupId)) return false;
    seen.add(route.groupId);
    return true;
  });
}

const lower = value => String(value).toLowerCase();

/**
 * Why a model the app could use does not reach the subject: disabled, not
 * configured, not allowed for the app, or not granted to the subject's groups.
 */
function modelCause({ modelId, models, appModelIds, grantedTo }) {
  const model = models.find(candidate => lower(candidate?.id) === lower(modelId));
  if (!model) return 'missing';
  if (model.enabled === false) return 'disabled';
  if (!appModelIds.has(lower(model.id))) return 'notAllowedForApp';
  if (!grantedTo(model.id)) return 'notGranted';
  return null;
}

/**
 * The verdict for one app or model and one subject, with the reasons in the
 * order a user meets them. Every reason has a `code`, a `status` (`ok`,
 * `blocked`, `warning`) and the values a client needs to say it in words.
 *
 * Reason codes:
 * - `anonymousAccessOff` (blocked): the anonymous group was asked about while
 *   anonymous access is off.
 * - `userInactive` (blocked): the account is deactivated.
 * - `itemEnabled` (ok) / `itemDisabled` (blocked)
 * - `featureOn` (ok) / `featureOff` (blocked, `featureId`) — apps only
 * - `integrationOff` (blocked, `integrationIds`) — apps only
 * - `granted` (ok, `routes`) / `notGranted` (blocked)
 * - `modelsAvailable` (ok, `modelIds`) / `noUsableModel` (blocked, `models`:
 *   `[{ id, cause }]`, empty when no chat model is configured) — chat apps only
 * - `preferredModelUnavailable` (warning, `modelId`, `cause`) — chat apps only
 *
 * @param {object} options
 * @param {'apps'|'models'} options.type
 * @param {object} options.item - The app or model as configured (disabled ones too)
 * @param {object} options.subject - From {@link resolveSubject}
 * @param {Object<string, object>} options.groups - `groups` map from groups.json
 * @param {object[]} [options.models=[]] - All configured models, disabled ones too
 * @param {string[]} [options.featuresOff=[]] - The app's required features that are off
 * @param {string[]} [options.integrationsOff=[]] - The app's integrations that are off
 * @param {(models: object[], app: object) => object[]} [options.filterModelsForApp] -
 *   The server's model filter for an app (`RequestBuilder.filterModelsForApp`)
 * @param {string|null} [options.defaultModelId] - The platform's current default
 *   model, for `@default` grants; worked out from `models` when not given
 * @returns {{verdict: 'available'|'unavailable', reasons: object[]}}
 */
export function checkAccess({
  type,
  item,
  subject,
  groups,
  models = [],
  featuresOff = [],
  integrationsOff = [],
  filterModelsForApp = list => list,
  defaultModelId = effectiveDefaultModelId(models)
}) {
  const reasons = [];
  const add = (code, status, values = {}) => reasons.push({ code, status, ...values });

  if (subject.anonymousOff) add('anonymousAccessOff', 'blocked');
  if (!subject.active) add('userInactive', 'blocked');

  add(
    item.enabled === false ? 'itemDisabled' : 'itemEnabled',
    item.enabled === false ? 'blocked' : 'ok'
  );

  if (type === 'apps') {
    const required = Array.isArray(item.requiredFeatures) ? item.requiredFeatures : [];
    for (const featureId of featuresOff) add('featureOff', 'blocked', { featureId });
    if (required.length > 0 && featuresOff.length === 0) {
      add('featureOn', 'ok', { featureIds: required });
    }
    if (integrationsOff.length > 0) {
      add('integrationOff', 'blocked', { integrationIds: [...integrationsOff] });
    }
  }

  const subjectGroups = subject.groups;
  const routes = subjectGrantRoutes({
    groups,
    type,
    contentId: item.id,
    subjectGroups,
    defaultModelId
  });
  if (routes.length > 0) add('granted', 'ok', { routes });
  else add('notGranted', 'blocked');

  if (type === 'apps' && (item.type || 'chat') === 'chat') {
    const grantedTo = modelId =>
      subjectGrantRoutes({
        groups,
        type: 'models',
        contentId: modelId,
        subjectGroups,
        defaultModelId
      }).length > 0;
    const enabledModels = models.filter(model => model && model.enabled !== false);
    const forApp = filterModelsForApp(enabledModels, item);
    const appModelIds = new Set(forApp.map(model => lower(model.id)));
    const usable = forApp.filter(model => grantedTo(model.id));

    if (usable.length > 0) {
      add('modelsAvailable', 'ok', { modelIds: usable.map(model => model.id) });
    } else {
      // The models the app names, or else every chat model configured: each
      // with why it drops out (disabled, not suitable for the app, not granted).
      const named = Array.isArray(item.allowedModels) && item.allowedModels.length > 0;
      const candidates = named
        ? item.allowedModels
        : models
            .filter(model => model && (model.modelType || 'chat') === 'chat')
            .map(model => model.id);
      add('noUsableModel', 'blocked', {
        models: candidates.map(id => ({
          id,
          cause: modelCause({ modelId: id, models, appModelIds, grantedTo }) || 'notGranted'
        }))
      });
    }

    if (typeof item.preferredModel === 'string' && item.preferredModel) {
      const cause = modelCause({
        modelId: item.preferredModel,
        models,
        appModelIds,
        grantedTo
      });
      if (cause)
        add('preferredModelUnavailable', 'warning', { modelId: item.preferredModel, cause });
    }
  }

  const blocked = reasons.some(reason => reason.status === 'blocked');
  return { verdict: blocked ? 'unavailable' : 'available', reasons };
}

/**
 * A group's own list for a type, as an array.
 */
function ownList(group, key) {
  const list = group?.permissions?.[key];
  return Array.isArray(list) ? list : [];
}

/**
 * The groups whose own list grants every item of the type (`*`), in the file's
 * order.
 *
 * @param {Object<string, object>} groups
 * @param {string} type
 * @returns {string[]}
 */
export function wildcardGroupIds(groups, type) {
  const key = canonicalGrantListType(type);
  if (key === undefined) return [];
  return Object.keys(groups || {}).filter(groupId => ownList(groups[groupId], key).includes('*'));
}

/**
 * The explicit list that replaces `*` in one group: every configured item of
 * the type except the one being restricted, plus whatever else the list held
 * besides `*` (an id of an item that is not configured yet keeps working once
 * it is). The configured spelling of each id is kept.
 *
 * @param {string[]} list - The group's own list, holding `*`
 * @param {string[]} allIds - Every configured item of the type, disabled ones too
 * @param {string} contentId - The item to leave out
 * @returns {string[]}
 */
export function explicitListWithout(list, allIds, contentId) {
  const target = lower(contentId);
  const result = [];
  const seen = new Set();
  for (const id of [...allIds, ...list]) {
    if (typeof id !== 'string' || id === '*' || lower(id) === target) continue;
    if (seen.has(lower(id))) continue;
    seen.add(lower(id));
    result.push(id);
  }
  return result;
}

/**
 * What restricting one item would do, and the groups as they would be.
 *
 * The admin picks which wildcard groups to convert (`groupIds`, default: all
 * of them). Each picked group's `*` becomes an explicit list of every current
 * item except this one. Optionally the item is then granted by name to other
 * groups (`grantGroupIds`), so "only HR" is one step.
 *
 * Converting changes what the group gets tomorrow too: an item added later is
 * no longer visible in that group by default. The plan carries that fact for
 * the client to say; it does not decide it.
 *
 * The default-model token (`@default`) is left alone: a converted list keeps
 * it, and so does every other group. When the model being restricted is the
 * platform's default model, the groups whose own list (after the change)
 * holds the token still grant it; `defaultModelGroups` names them so the
 * client can say so.
 *
 * @param {object} options
 * @param {Object<string, object>} options.groups - `groups` map; not changed
 * @param {string} options.type - One of {@link RESTRICT_TYPES}
 * @param {string} options.contentId - The item's configured id
 * @param {string[]} options.allIds - Every configured item of the type
 * @param {string[]} [options.groupIds] - Wildcard groups to convert; default all
 * @param {string[]} [options.grantGroupIds=[]] - Groups to grant the item to afterwards
 * @param {string[]} [options.implicitGroups=[]] - Groups people carry without
 *   being members, marked on the rows of `groupsAfter`
 * @param {string} [options.authenticatedGroup='authenticated']
 * @param {string[]} [options.anonymousGroups=[]]
 * @param {string|null} [options.defaultModelId] - The platform's current default model
 * @returns {{
 *   candidates: Array<{id: string, name: string, itemCount: number, currentCount: number,
 *     passesTo: string[], selected: boolean}>,
 *   selected: string[],
 *   grantGroupIds: string[],
 *   groupsAfter: Array<{id: string, name: string, before: boolean, after: boolean,
 *     via: object[], implicit?: true}>,
 *   audienceBefore: {allSignedIn: boolean, anonymous: boolean},
 *   audienceAfter: {allSignedIn: boolean, anonymous: boolean},
 *   updatedGroups: Object<string, object>,
 *   changes: Array<{groupId: string, action: 'restrict'|'grant'}>,
 *   defaultModelGroups: string[]
 * }} `updatedGroups` is a changed copy of `groups`, ready to write
 * @throws {ServiceError} 400 for a group in `groupIds` that holds no wildcard
 *   or a malformed list, 404 for an unknown group
 */
export function planRestriction({
  groups,
  type,
  contentId,
  allIds,
  groupIds,
  grantGroupIds = [],
  implicitGroups = [],
  authenticatedGroup = 'authenticated',
  anonymousGroups = [],
  defaultModelId = null
}) {
  const key = RESTRICT_TYPES.find(candidate => candidate === type);
  if (key === undefined) {
    throw new ServiceError('BAD_REQUEST', `Restricting is not available for '${type}'`);
  }
  const map = groups || {};
  const wildcards = wildcardGroupIds(map, key);

  const checkIds = (ids, field) => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || id.length === 0)) {
      throw new ServiceError('VALIDATION_FAILED', `'${field}' must be an array of group ids`, {
        details: [{ path: field, code: 'invalid_type', message: 'Expected an array of group ids' }]
      });
    }
    for (const id of ids) {
      if (DANGEROUS_KEYS.has(id)) throw new ServiceError('BAD_REQUEST', `Invalid group id '${id}'`);
      if (!Object.hasOwn(map, id)) throw new ServiceError('NOT_FOUND', `Group '${id}' not found`);
    }
  };

  const selected = groupIds === undefined ? wildcards : [...new Set(groupIds)];
  checkIds(selected, 'groupIds');
  checkIds(grantGroupIds, 'grantGroupIds');
  const notWildcard = selected.find(id => !wildcards.includes(id));
  if (notWildcard !== undefined) {
    throw new ServiceError(
      'BAD_REQUEST',
      `Group '${notWildcard}' does not grant all ${key} through a wildcard`
    );
  }
  const describe = groupMap =>
    describeContentAccess({
      groups: groupMap,
      type: key,
      contentId,
      groupIds: Object.keys(groupMap),
      implicitGroups,
      defaultModelId
    });
  const audienceOf = groupMap =>
    describeAudience({
      groups: groupMap,
      type: key,
      contentId,
      authenticatedGroup,
      anonymousGroups,
      defaultModelId
    });

  const before = describe(map);

  // A wildcard group passes the item on to every group that inherits from it.
  const candidates = wildcards.map(groupId => {
    const group = map[groupId];
    const passesTo = Object.keys(map).filter(
      other =>
        other !== groupId &&
        collectAncestorPaths(map, other).some(ancestor => ancestor.groupId === groupId)
    );
    return {
      id: groupId,
      name: typeof group?.name === 'string' && group.name ? group.name : groupId,
      itemCount: explicitListWithout(ownList(group, key), allIds, contentId).length,
      currentCount: allIds.length,
      passesTo,
      selected: selected.includes(groupId)
    };
  });

  const updatedGroups = structuredClone(map);
  const changes = [];
  for (const groupId of selected) {
    const group = updatedGroups[groupId];
    group.permissions = {
      ...group.permissions,
      [key]: explicitListWithout(ownList(group, key), allIds, contentId)
    };
    changes.push({ groupId, action: 'restrict' });
  }
  const target = lower(contentId);
  for (const groupId of [...new Set(grantGroupIds)]) {
    const group = updatedGroups[groupId];
    const list = ownList(group, key);
    if (list.includes('*') || list.some(id => typeof id === 'string' && lower(id) === target)) {
      continue;
    }
    group.permissions = { ...group.permissions, [key]: [...list, contentId] };
    changes.push({ groupId, action: 'grant' });
  }

  const after = describe(updatedGroups);
  const groupsAfter = after.map((row, index) => ({
    id: row.id,
    name: row.name,
    before: before[index].effective,
    after: row.effective,
    via: row.via,
    ...(row.implicit ? { implicit: true } : {})
  }));

  return {
    candidates,
    selected,
    grantGroupIds: [...new Set(grantGroupIds)],
    groupsAfter,
    audienceBefore: audienceOf(map),
    audienceAfter: audienceOf(updatedGroups),
    updatedGroups,
    changes,
    defaultModelGroups:
      key === 'models'
        ? Object.keys(updatedGroups).filter(groupId =>
            grantsAsDefaultModel(ownList(updatedGroups[groupId], key), contentId, defaultModelId)
          )
        : []
  };
}
