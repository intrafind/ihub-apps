// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Rules of the workflow project steps (#1036, slice 6) that the visual editor
 * and the run dialog share, kept out of the React components so they can be
 * unit tested on their own:
 *
 *  - the three step types (`project-items`, `project-read`, `project-write`)
 *    and the state key each writes when the author names none;
 *  - the `project` field: a literal project id or a `$.data.<name>` reference
 *    (for instance a start input of type `project`);
 *  - the `project-items` filter (`kinds`, `status`, `pinned`, `origin`) as the
 *    form edits it, with the defaults the server applies;
 *  - the run dialog's project picker: the user's projects grouped like the
 *    project list (mine, shared with me, from apps).
 *
 * The server side lives in `server/services/workflow/projectNodes.js` and the
 * executors `server/services/workflow/executors/Project*NodeExecutor.js`; the
 * defaults here mirror the ones there.
 *
 * Every function is pure.
 *
 * @module features/workflows/utils/projectNodeConfig
 */

import { projectDisplayName, projectListGroup } from '../../projects/utils/projectView';

/** The workflow step types that work on a project. */
export const PROJECT_NODE_TYPES = Object.freeze(['project-items', 'project-read', 'project-write']);

/** Start-node input variable type whose value is a project id. */
export const PROJECT_INPUT_TYPE = 'project';

/**
 * State key each project step writes when `outputVariable` is empty
 * (mirrors the executors' defaults).
 */
export const PROJECT_NODE_DEFAULT_OUTPUT = Object.freeze({
  'project-items': '_projectItems',
  'project-read': '_projectDocument',
  'project-write': '_writtenDocument'
});

/** Item states a `project-items` filter can select, in display order. */
export const PROJECT_ITEM_STATUSES = Object.freeze([
  'ready',
  'stale',
  'pending',
  'extracting',
  'failed'
]);

/** States `project-items` keeps when its filter names none: the readable ones. */
export const DEFAULT_PROJECT_ITEM_STATUSES = Object.freeze(['ready', 'stale']);

/** `provenance.origin` values a `project-items` filter can select. */
export const PROJECT_ITEM_ORIGINS = Object.freeze([
  'uploaded',
  'written',
  'picked',
  'linked',
  'migrated'
]);

/** Choices of the tri-state "pinned" filter. */
export const PINNED_CHOICES = Object.freeze(['any', 'pinned', 'unpinned']);

/** Most documents one `project-items` step returns (the loop cap). */
export const MAX_PROJECT_ITEMS = 500;

/** Content types the `project-write` form suggests (any string is accepted). */
export const PROJECT_WRITE_CONTENT_TYPES = Object.freeze([
  'text/markdown',
  'text/plain',
  'text/html',
  'application/json'
]);

/** Prefix of a state reference in a step config. */
const STATE_REFERENCE_PREFIX = '$.';

/**
 * Whether a step's `project` value is a state reference (`$.data.<name>`)
 * rather than a literal project id.
 *
 * @param {*} value
 * @returns {boolean}
 *
 * @example
 * isProjectReference('$.data.project'); // true
 * isProjectReference('handbook');       // false
 */
export function isProjectReference(value) {
  return typeof value === 'string' && value.trim().startsWith(STATE_REFERENCE_PREFIX);
}

/**
 * The variables visible to a step as `$.data.<name>` references, for the
 * suggestions of the project field.
 *
 * @param {Array<{value: string, label?: string}>|undefined} variables - From
 *   `collectUpstreamVariables`.
 * @returns {Array<{value: string, label: string}>}
 */
export function referenceSuggestions(variables) {
  return (Array.isArray(variables) ? variables : [])
    .filter(variable => variable && typeof variable.value === 'string' && variable.value)
    .map(variable => ({ value: `$.data.${variable.value}`, label: variable.label || '' }));
}

/**
 * The names of a start node's inputs of type `project`.
 *
 * @param {Array<{name?: string, type?: string}>|undefined} inputVariables
 * @returns {string[]}
 */
export function projectInputNames(inputVariables) {
  return (Array.isArray(inputVariables) ? inputVariables : [])
    .filter(variable => variable?.type === PROJECT_INPUT_TYPE && variable.name)
    .map(variable => variable.name);
}

// --- project-items filter --------------------------------------------------------

/**
 * Keep a list in the order of its options, so the stored config does not
 * depend on the order the boxes were ticked in.
 *
 * @param {string[]} values
 * @param {string[]} order
 * @returns {string[]}
 */
function inOptionOrder(values, order) {
  const known = order.filter(option => values.includes(option));
  const unknown = values.filter(value => !order.includes(value));
  return [...known, ...unknown];
}

/**
 * Add a value to a list or take it out.
 *
 * @param {string[]|undefined} list
 * @param {string} value
 * @param {string[]} [order=[]] - Option order the result follows.
 * @returns {string[]}
 */
export function toggleListValue(list, value, order = []) {
  const current = Array.isArray(list) ? list : [];
  const next = current.includes(value)
    ? current.filter(entry => entry !== value)
    : [...current, value];
  return inOptionOrder(next, order);
}

/**
 * Set or remove one key of a step's `filter`. The filter itself is removed
 * once it is empty, so an untouched step keeps a clean config.
 *
 * @param {Object} config - The step config.
 * @param {string} key - `kinds`, `status`, `pinned` or `origin`.
 * @param {*} value - `undefined` removes the key.
 * @returns {Object} A new config.
 */
export function withFilterKey(config, key, value) {
  const filter = { ...(config?.filter || {}) };
  if (value === undefined) delete filter[key];
  else filter[key] = value;
  const next = { ...(config || {}) };
  if (Object.keys(filter).length > 0) next.filter = filter;
  else delete next.filter;
  return next;
}

/**
 * Set a list filter (`kinds`, `origin`) where no selection means "any". An
 * empty list is removed: the server would read `[]` as "match nothing".
 *
 * @param {Object} config
 * @param {'kinds'|'origin'} key
 * @param {string[]} values
 * @returns {Object}
 */
export function withListFilter(config, key, values) {
  return withFilterKey(config, key, values.length > 0 ? values : undefined);
}

/**
 * The statuses a `project-items` step keeps: its own list, else the default.
 *
 * @param {{status?: string[]|string}|undefined} filter
 * @returns {string[]}
 */
export function effectiveStatuses(filter) {
  if (Array.isArray(filter?.status)) return filter.status;
  if (typeof filter?.status === 'string' && filter.status.trim()) return [filter.status.trim()];
  return [...DEFAULT_PROJECT_ITEM_STATUSES];
}

/**
 * Set the status filter. The default selection is stored as no key at all;
 * an empty list is kept, because the server reads it as "every status".
 *
 * @param {Object} config
 * @param {string[]} statuses
 * @returns {Object}
 */
export function withStatuses(config, statuses) {
  const isDefault =
    statuses.length === DEFAULT_PROJECT_ITEM_STATUSES.length &&
    DEFAULT_PROJECT_ITEM_STATUSES.every(status => statuses.includes(status));
  return withFilterKey(config, 'status', isDefault ? undefined : statuses);
}

/**
 * The tri-state choice of the pinned filter.
 *
 * @param {{pinned?: boolean}|undefined} filter
 * @returns {'any'|'pinned'|'unpinned'}
 */
export function pinnedChoice(filter) {
  if (filter?.pinned === true) return 'pinned';
  if (filter?.pinned === false) return 'unpinned';
  return 'any';
}

/**
 * Set the pinned filter from a tri-state choice.
 *
 * @param {Object} config
 * @param {'any'|'pinned'|'unpinned'} choice
 * @returns {Object}
 */
export function withPinnedChoice(config, choice) {
  const value = choice === 'pinned' ? true : choice === 'unpinned' ? false : undefined;
  return withFilterKey(config, 'pinned', value);
}

// --- summaries and defaults --------------------------------------------------------

/**
 * The state key a project step writes.
 *
 * @param {string} type - A project step type.
 * @param {{outputVariable?: string}|undefined} config
 * @returns {string}
 */
export function projectNodeOutput(type, config) {
  const own = typeof config?.outputVariable === 'string' ? config.outputVariable.trim() : '';
  return own || PROJECT_NODE_DEFAULT_OUTPUT[type] || '';
}

/**
 * A one-line, language-neutral summary of a project step for its canvas card:
 * which project, and what the step produces or writes.
 *
 * @param {string} type
 * @param {Object} config
 * @returns {string} Empty when there is nothing to show yet.
 *
 * @example
 * projectNodeSummary('project-items', { project: '$.data.project' });
 * // '$.data.project → _projectItems'
 */
export function projectNodeSummary(type, config = {}) {
  const project = typeof config.project === 'string' ? config.project.trim() : '';
  if (type === 'project-items') {
    return project ? `${project} → ${projectNodeOutput(type, config)}` : '';
  }
  if (type === 'project-read') {
    const document = typeof config.document === 'string' ? config.document.trim() : '';
    return document ? `${document} → ${projectNodeOutput(type, config)}` : project;
  }
  if (type === 'project-write') {
    const name = typeof config.name === 'string' ? config.name.trim() : '';
    return name && project ? `${name} → ${project}` : name || project;
  }
  return '';
}

// --- run dialog ------------------------------------------------------------------

/** Group order of the run dialog's project picker (the project list's filters). */
export const PROJECT_PICKER_GROUPS = Object.freeze(['mine', 'shared', 'apps']);

/**
 * The projects a user may pick for a workflow input, grouped like the project
 * list and sorted by name within each group. Empty groups are left out.
 *
 * @param {Array<Object>|undefined} projects - From `GET /api/projects`.
 * @param {string} [language='en']
 * @returns {Array<{group: 'mine'|'shared'|'apps', options: Array<{id: string, name: string}>}>}
 */
export function groupProjectOptions(projects, language = 'en') {
  const groups = new Map(PROJECT_PICKER_GROUPS.map(group => [group, []]));
  for (const project of projects || []) {
    if (!project?.id) continue;
    groups.get(projectListGroup(project)).push({
      id: project.id,
      name: projectDisplayName(project, language)
    });
  }
  return PROJECT_PICKER_GROUPS.map(group => ({
    group,
    options: groups.get(group).sort((a, b) => a.name.localeCompare(b.name, language))
  })).filter(entry => entry.options.length > 0);
}

/**
 * The display name of a project id among the user's projects, or the id
 * itself when the project is not (or no longer) in the list.
 *
 * @param {string} projectId
 * @param {Array<Object>|undefined} projects
 * @param {string} [language='en']
 * @returns {string}
 */
export function projectNameFor(projectId, projects, language = 'en') {
  const project = (projects || []).find(entry => entry?.id === projectId);
  return project ? projectDisplayName(project, language) : String(projectId ?? '');
}
