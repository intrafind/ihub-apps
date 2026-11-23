// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Says in words why a group can use an item and why a check came out as it
 * did. Pure: the server's access view or verdict goes in, message keys with
 * their values come out; components translate them with `t`.
 *
 * The server decides the facts (`via` on every group row of the access views,
 * `reasons` of a verdict); this module only words them. It is shared by the
 * app editor's group access, the model's access card, the access check and the
 * restrict dialog, so "through all apps, inherited from Authenticated" reads
 * the same everywhere.
 *
 * @module features/admin/components/access/accessExplanation
 */

/** The item types, as the plural the sentences name ("all apps"). */
export const ITEM_KEYS = Object.freeze({
  apps: 'admin.access.items.apps',
  models: 'admin.access.items.models',
  prompts: 'admin.access.items.prompts',
  skills: 'admin.access.items.skills',
  workflows: 'admin.access.items.workflows'
});

/** The sentences about one grant route. Written out so the i18n test finds them. */
export const ROUTE_KEYS = Object.freeze({
  ownWildcard: 'admin.access.explain.ownWildcard',
  inheritedWildcard: 'admin.access.explain.inheritedWildcard',
  ownExplicit: 'admin.access.explain.ownExplicit',
  inheritedExplicit: 'admin.access.explain.inheritedExplicit',
  ownDefault: 'admin.access.explain.ownDefault',
  inheritedDefault: 'admin.access.explain.inheritedDefault'
});

/** The route kinds, by the word that names them in {@link ROUTE_KEYS}. */
const ROUTE_KIND_NAMES = Object.freeze({
  wildcard: 'Wildcard',
  explicit: 'Explicit',
  default: 'Default'
});

/** The sentences of the access check, by reason code. */
export const REASON_KEYS = Object.freeze({
  anonymousAccessOff: 'admin.access.check.reasons.anonymousAccessOff',
  userInactive: 'admin.access.check.reasons.userInactive',
  itemEnabled: 'admin.access.check.reasons.itemEnabled',
  itemDisabled: 'admin.access.check.reasons.itemDisabled',
  featureOn: 'admin.access.check.reasons.featureOn',
  featureOff: 'admin.access.check.reasons.featureOff',
  integrationOff: 'admin.access.check.reasons.integrationOff',
  granted: 'admin.access.check.reasons.granted',
  notGranted: 'admin.access.check.reasons.notGranted',
  modelsAvailable: 'admin.access.check.reasons.modelsAvailable',
  noUsableModel: 'admin.access.check.reasons.noUsableModel',
  preferredModelUnavailable: 'admin.access.check.reasons.preferredModelUnavailable'
});

/** Why one model drops out of a chat app, for the sentences above. */
export const MODEL_CAUSE_KEYS = Object.freeze({
  missing: 'admin.access.check.modelCause.missing',
  disabled: 'admin.access.check.modelCause.disabled',
  notAllowedForApp: 'admin.access.check.modelCause.notAllowedForApp',
  notGranted: 'admin.access.check.modelCause.notGranted'
});

/** Said below "no usable model" when no chat model is configured at all. */
export const NO_MODELS_KEY = 'admin.access.check.noModelsConfigured';

const CHAIN_SEPARATOR = ' → ';
const LIST_SEPARATOR = ', ';

/**
 * A lookup from group id to the name an admin reads.
 *
 * @param {Array<{id: string, name?: string}>|null|undefined} rows - Group rows of an access view
 * @returns {(groupId: string) => string}
 */
export function groupNamer(rows) {
  const names = new Map(
    (Array.isArray(rows) ? rows : [])
      .filter(row => row && typeof row.id === 'string')
      .map(row => [row.id, typeof row.name === 'string' && row.name ? row.name : row.id])
  );
  return groupId => names.get(groupId) || groupId;
}

/**
 * The route a group's sentence is about: its nearest wildcard route when
 * `wildcardOnly`, else its first route (its own list before inherited ones).
 *
 * @param {{via?: object[]}} row
 * @param {boolean} [wildcardOnly=false]
 * @returns {{groupId: string, kind: 'explicit'|'wildcard'|'default', path: string[]}|null}
 */
export function primaryRoute(row, wildcardOnly = false) {
  const routes = Array.isArray(row?.via) ? row.via : [];
  const route = wildcardOnly ? routes.find(entry => entry?.kind === 'wildcard') : routes[0];
  return route && Array.isArray(route.path) ? route : null;
}

/**
 * The sentence for one route of one group. A `default` route is a model list
 * holding `@default` while the model is the platform's default model: the
 * sentence says the group gets it "as the default model".
 *
 * @param {object} options
 * @param {string} options.groupName - The group the sentence is about
 * @param {{groupId: string, kind: string, path: string[]}} options.route
 * @param {string} options.type - The item type (`apps`, `models`, …)
 * @param {(groupId: string) => string} options.nameOf
 * @returns {{key: string, values: {group: string, source: string, chain: string}, itemsKey: string}}
 *
 * @example
 * routeSentence({
 *   groupName: 'Users',
 *   route: { groupId: 'authenticated', kind: 'wildcard', path: ['users', 'authenticated'] },
 *   type: 'apps',
 *   nameOf: id => ({ users: 'Users', authenticated: 'Authenticated' })[id]
 * });
 * // → { key: 'admin.access.explain.inheritedWildcard',
 * //     values: { group: 'Users', source: 'Authenticated', chain: 'Users → Authenticated' },
 * //     itemsKey: 'admin.access.items.apps' }
 */
export function routeSentence({ groupName, route, type, nameOf }) {
  const inherited = route.path.length > 1;
  const kindName = ROUTE_KIND_NAMES[route.kind] || ROUTE_KIND_NAMES.explicit;
  const name = `${inherited ? 'inherited' : 'own'}${kindName}`;
  return {
    key: ROUTE_KEYS[name],
    values: {
      group: groupName,
      source: nameOf(route.groupId),
      chain: route.path.map(nameOf).join(CHAIN_SEPARATOR)
    },
    itemsKey: ITEM_KEYS[type] || ITEM_KEYS.apps
  };
}

/**
 * The sentences that say which groups get an item through a wildcard, one per
 * group, for the groups the view lists.
 *
 * @param {object|null|undefined} view - An access view (`groups` with `via`)
 * @param {string} type - The item type
 * @returns {Array<{groupId: string, key: string, values: object, itemsKey: string}>}
 */
export function wildcardSentences(view, type) {
  const rows = Array.isArray(view?.groups) ? view.groups : [];
  const nameOf = groupNamer(rows);
  return rows
    .map(row => ({ row, route: primaryRoute(row, true) }))
    .filter(({ row, route }) => row?.effective && route)
    .map(({ row, route }) => ({
      groupId: row.id,
      ...routeSentence({ groupName: nameOf(row.id), route, type, nameOf })
    }));
}

/**
 * Whether any group gets the item through a wildcard, so that restricting it
 * means converting wildcards.
 *
 * @param {object|null|undefined} view
 * @returns {boolean}
 */
export function coveredByWildcard(view) {
  const rows = Array.isArray(view?.groups) ? view.groups : [];
  return rows.some(row => row?.effective && primaryRoute(row, true));
}

/**
 * The groups that, per the server's plan, keep granting a model as the
 * platform's default model (`@default`) after a restrict: the restrict leaves
 * the token alone, so the admin is told the model stays reachable that way.
 *
 * @param {{defaultModelGroups?: string[], groupsAfter?: object[]}|null|undefined} plan
 * @returns {string[]} The groups' names, in the plan's order
 */
export function defaultModelGroupNames(plan) {
  const ids = Array.isArray(plan?.defaultModelGroups) ? plan.defaultModelGroups : [];
  const nameOf = groupNamer(plan?.groupsAfter);
  return ids.map(nameOf);
}

/**
 * Translates a sentence of this module.
 *
 * @param {{key: string, values?: object, itemsKey?: string}} sentence
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
export function formatSentence(sentence, t) {
  const items = sentence.itemsKey ? t(sentence.itemsKey) : undefined;
  return t(sentence.key, { ...sentence.values, ...(items ? { items } : {}) });
}

/**
 * The words for one reason of a verdict.
 *
 * @param {object} reason - One entry of `reasons` (`code`, `status`, values)
 * @param {object} options
 * @param {string} options.type - The item type
 * @param {(groupId: string) => string} options.nameOf
 * @returns {{key: string, values: object, itemsKey?: string,
 *   details: Array<{key: string, values: object, itemsKey?: string}>}|null}
 *   `details` are the lines below the reason (the routes of a grant, the
 *   models of a chat app); null for a code this client does not know
 */
export function reasonSentence(reason, { type, nameOf }) {
  const key = REASON_KEYS[reason?.code];
  if (!key) return null;
  const list = values => (Array.isArray(values) ? values.join(LIST_SEPARATOR) : '');

  switch (reason.code) {
    case 'featureOn':
      return { key, values: { features: list(reason.featureIds) }, details: [] };
    case 'featureOff':
      return { key, values: { feature: reason.featureId }, details: [] };
    case 'integrationOff':
      return { key, values: { integrations: list(reason.integrationIds) }, details: [] };
    case 'granted': {
      const routes = Array.isArray(reason.routes) ? reason.routes : [];
      return {
        key,
        values: {},
        details: routes.map(route =>
          routeSentence({ groupName: nameOf(route.path[0]), route, type, nameOf })
        )
      };
    }
    case 'modelsAvailable':
      return { key, values: { models: list(reason.modelIds) }, details: [] };
    case 'noUsableModel': {
      const models = Array.isArray(reason.models) ? reason.models : [];
      return {
        key,
        values: {},
        details:
          models.length > 0
            ? models.map(model => ({
                key: MODEL_CAUSE_KEYS[model.cause] || MODEL_CAUSE_KEYS.notGranted,
                values: { model: model.id }
              }))
            : [{ key: NO_MODELS_KEY, values: {} }]
      };
    }
    case 'preferredModelUnavailable':
      return {
        key,
        values: { model: reason.modelId },
        details: [
          {
            key: MODEL_CAUSE_KEYS[reason.cause] || MODEL_CAUSE_KEYS.notGranted,
            values: { model: reason.modelId }
          }
        ]
      };
    default:
      return { key, values: {}, itemsKey: ITEM_KEYS[type], details: [] };
  }
}
