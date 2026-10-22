// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Business rules of the user projects pages (#1036, spec 1 §2, §5.1, §6.3,
 * §9.4), kept out of the React components so they can be unit tested:
 *
 *  - the project list: filters (mine, shared with me, from apps) and search;
 *  - creating and editing: validation and the PATCH body;
 *  - quotas: usage against the limits, and whether a new project or item fits;
 *  - members: the member list as the share dialog's shares and back, and the
 *    caller's own entry (leave);
 *  - chats: where a chat opens, where a chat inside a project starts, which
 *    apps may start one, and which projects a chat may move to.
 *
 * Every function is pure.
 *
 * @module features/projects/utils/projectView
 */

import { localizedText } from './projectItems';

/** Prefix of user project ids (`prj_` + 22 url-safe characters). */
export const USER_PROJECT_ID_PREFIX = 'prj_';

/** Longest name, description and instructions the server accepts (`projectSchema.js`). */
export const MAX_PROJECT_NAME_LENGTH = 200;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 2000;
export const MAX_PROJECT_INSTRUCTIONS_LENGTH = 20000;
export const MAX_ITEM_NAME_LENGTH = 300;

/** The filters of the project list. */
export const PROJECT_LIST_FILTERS = Object.freeze(['all', 'mine', 'shared', 'apps']);

/** The filters of a project's chat list (`GET …/chats?filter=`). */
export const PROJECT_CHAT_FILTERS = Object.freeze(['all', 'mine']);

/** The URL query parameter a chat started from a project page carries. */
export const PROJECT_QUERY_PARAM = 'project';

/** Share of a quota from which the usage bar turns amber. */
const QUOTA_WARN_RATIO = 0.8;

/**
 * Whether an id names a user project.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isUserProjectId(id) {
  return typeof id === 'string' && id.startsWith(USER_PROJECT_ID_PREFIX);
}

/**
 * A project's display name (admin projects are localized records).
 *
 * @param {{id?: string, name?: string|Object}|null} project
 * @param {string} [language='en']
 * @returns {string}
 */
export function projectDisplayName(project, language = 'en') {
  return localizedText(project?.name, language) || project?.id || '';
}

/**
 * Which list filter a project belongs to.
 *
 * @param {{ownership?: string, permissions?: {isOwner?: boolean}}} project
 * @returns {'mine'|'shared'|'apps'}
 */
export function projectListGroup(project) {
  if (project?.ownership === 'admin') return 'apps';
  return project?.permissions?.isOwner ? 'mine' : 'shared';
}

/**
 * Filter and search the project list.
 *
 * @param {Array<Object>} projects - From `GET /api/projects`.
 * @param {{filter?: string, search?: string, language?: string}} [options]
 * @returns {Array<Object>}
 */
export function filterProjectList(projects, { filter = 'all', search = '', language = 'en' } = {}) {
  const query = search.trim().toLowerCase();
  return (projects || []).filter(project => {
    if (filter !== 'all' && projectListGroup(project) !== filter) return false;
    if (!query) return true;
    const haystack = [
      projectDisplayName(project, language),
      localizedText(project.description, language),
      project.owner?.name
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

/**
 * How many projects fall under each list filter.
 *
 * @param {Array<Object>} projects
 * @returns {{all: number, mine: number, shared: number, apps: number}}
 */
export function countProjectGroups(projects) {
  const counts = { all: 0, mine: 0, shared: 0, apps: 0 };
  for (const project of projects || []) {
    counts.all += 1;
    counts[projectListGroup(project)] += 1;
  }
  return counts;
}

// --- create and edit -----------------------------------------------------------

/**
 * The editable fields of a project, as strings.
 *
 * @param {Object|null} project
 * @returns {{name: string, description: string, instructions: string}}
 */
export function projectFormFrom(project) {
  return {
    name: typeof project?.name === 'string' ? project.name : '',
    description: typeof project?.description === 'string' ? project.description : '',
    instructions: typeof project?.instructions === 'string' ? project.instructions : ''
  };
}

/**
 * Validate the project form.
 *
 * @param {{name?: string, description?: string, instructions?: string}} form
 * @returns {Object<string, 'required'|'tooLong'>} Field → error code; empty when valid.
 */
export function validateProjectForm(form) {
  const errors = {};
  const name = (form?.name || '').trim();
  if (!name) errors.name = 'required';
  else if (name.length > MAX_PROJECT_NAME_LENGTH) errors.name = 'tooLong';
  if ((form?.description || '').trim().length > MAX_PROJECT_DESCRIPTION_LENGTH) {
    errors.description = 'tooLong';
  }
  if ((form?.instructions || '').length > MAX_PROJECT_INSTRUCTIONS_LENGTH) {
    errors.instructions = 'tooLong';
  }
  return errors;
}

/**
 * The body of `POST /api/projects`: the name, and the other fields when set.
 *
 * @param {{name: string, description?: string, instructions?: string}} form
 * @returns {{name: string, description?: string, instructions?: string}}
 */
export function buildCreateProjectBody(form) {
  const description = (form.description || '').trim();
  const instructions = form.instructions || '';
  return {
    name: (form.name || '').trim(),
    ...(description ? { description } : {}),
    ...(instructions.trim() ? { instructions } : {})
  };
}

/**
 * The body of `PATCH /api/projects/:id`: only what changed.
 *
 * @param {{name: string, description: string, instructions: string}} form
 * @param {Object} project - What the form started from: the project as
 *   loaded, or a form baseline (see {@link reconcileProjectForm}).
 * @returns {Object|null} `null` when nothing changed.
 */
export function buildProjectChanges(form, project) {
  const before = projectFormFrom(project);
  const changes = {};
  const name = (form.name || '').trim();
  if (name !== before.name) changes.name = name;
  const description = (form.description || '').trim();
  if (description !== before.description.trim()) changes.description = description;
  if ((form.instructions || '') !== before.instructions) changes.instructions = form.instructions;
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Bring a settings draft up to date with a newer copy of the same project
 * (a poll, or another editor's save): each field the user has not touched —
 * still equal to the copy the draft started from — takes the incoming value,
 * in the draft and in its baseline; a touched field keeps the user's text and
 * its old baseline, so it still counts as a change. Comparing the draft with
 * this baseline (not with the latest project) keeps an untouched field out of
 * the next PATCH, which would otherwise undo the other editor's update.
 *
 * @param {{name: string, description: string, instructions: string}} form - The draft.
 * @param {{name: string, description: string, instructions: string}} base - What the draft started from.
 * @param {Object} project - The newer copy of the project.
 * @returns {{form: Object, base: Object}}
 *
 * @example
 * const base = projectFormFrom(loaded);
 * const next = reconcileProjectForm({ ...base, name: 'Renamed' }, base, polled);
 * buildProjectChanges(next.form, next.base); // { name: 'Renamed' }
 */
export function reconcileProjectForm(form, base, project) {
  const incoming = projectFormFrom(project);
  const nextForm = { ...form };
  const nextBase = { ...base };
  for (const field of Object.keys(incoming)) {
    if (form[field] === base[field]) {
      nextForm[field] = incoming[field];
      nextBase[field] = incoming[field];
    }
  }
  return { form: nextForm, base: nextBase };
}

// --- quotas --------------------------------------------------------------------------

/**
 * One quota as the usage bar shows it.
 *
 * @param {number} used
 * @param {number} limit
 * @returns {{used: number, limit: number|null, ratio: number, level: 'ok'|'warn'|'full'}}
 */
export function quotaState(used, limit) {
  const value = Number.isFinite(used) && used > 0 ? used : 0;
  if (!Number.isFinite(limit) || limit <= 0)
    return { used: value, limit: null, ratio: 0, level: 'ok' };
  const ratio = Math.min(1, value / limit);
  const level = value >= limit ? 'full' : ratio >= QUOTA_WARN_RATIO ? 'warn' : 'ok';
  return { used: value, limit, ratio, level };
}

/**
 * The project's usage against the installation's limits (spec 1 §9.4).
 *
 * @param {{usage?: {items?: number, bytes?: number}, items?: Array}} project
 * @param {{limits?: {maxFiles?: number, maxProjectBytes?: number}}|null} config
 * @returns {{items: ReturnType<typeof quotaState>, bytes: ReturnType<typeof quotaState>}}
 */
export function projectUsage(project, config) {
  const usage = project?.usage || {};
  const items = Number.isFinite(usage.items) ? usage.items : (project?.items || []).length;
  return {
    items: quotaState(items, config?.limits?.maxFiles),
    bytes: quotaState(usage.bytes || 0, config?.limits?.maxProjectBytes)
  };
}

/**
 * Whether the caller may create a project now, and why not.
 *
 * @param {Object|null} config - From `GET /api/projects/_config`.
 * @returns {{allowed: boolean, reason: null|'disabled'|'permission'|'quota',
 *   used: number, limit: number|null}}
 */
export function projectCreation(config) {
  const user = config?.userProjects || {};
  const used = Number.isFinite(user.used) ? user.used : 0;
  const limit = Number.isFinite(user.maxProjects) ? user.maxProjects : null;
  if (!user.enabled) return { allowed: false, reason: 'disabled', used, limit };
  if (!user.canCreate) return { allowed: false, reason: 'permission', used, limit };
  if (limit !== null && used >= limit) return { allowed: false, reason: 'quota', used, limit };
  return { allowed: true, reason: null, used, limit };
}

/**
 * Whether the project can take another item.
 *
 * @param {Object} project
 * @param {Object|null} config
 * @returns {boolean}
 */
export function canAddItem(project, config) {
  return projectUsage(project, config).items.level !== 'full';
}

// --- members ---------------------------------------------------------------------------

/**
 * The project's members as the shares the share dialog edits (`role` →
 * `permission`: an editor can edit, a user can use).
 *
 * @param {Array<{type: string, id?: string|null, name?: string, role: string}>} members
 * @returns {Array<{type: string, id: string|null, name?: string, permission: 'use'|'edit'}>}
 */
export function membersToShares(members) {
  return (members || []).map(member => ({
    type: member.type,
    id: member.type === 'everyone' ? null : member.id,
    ...(member.name ? { name: member.name } : {}),
    permission: member.role === 'editor' ? 'edit' : 'use'
  }));
}

/**
 * The share dialog's shares as the body of `PUT …/members`.
 *
 * @param {Array<{type: string, id?: string|null, permission: string}>} shares
 * @returns {Array<{type: string, id?: string, role: 'user'|'editor'}>}
 */
export function sharesToMembers(shares) {
  return (shares || []).map(share => ({
    type: share.type,
    ...(share.type === 'everyone' ? {} : { id: share.id }),
    role: share.permission === 'edit' ? 'editor' : 'user'
  }));
}

/**
 * The caller's own direct member entry, when there is one — the one a
 * "Leave" removes. Memberships through a group or "everyone" cannot be left
 * by the member; the owner never appears in the list.
 *
 * @param {Object} project - With `members` (sent to those who may share).
 * @param {string|null} userId
 * @returns {Object|null}
 */
export function ownMemberEntry(project, userId) {
  if (!userId || !Array.isArray(project?.members)) return null;
  return (
    project.members.find(
      member => member.type === 'user' && String(member.id) === String(userId)
    ) || null
  );
}

/**
 * The member list without the caller (the body of a "Leave").
 *
 * @param {Object} project
 * @param {string} userId
 * @returns {Array<{type: string, id?: string, role: string}>}
 */
export function membersWithout(project, userId) {
  return sharesToMembers(
    membersToShares(
      (project?.members || []).filter(
        member => !(member.type === 'user' && String(member.id) === String(userId))
      )
    )
  );
}

/**
 * How many members a project has, whichever way the server sent them.
 *
 * @param {{members?: Array, memberCount?: number}} project
 * @returns {number}
 */
export function memberCountOf(project) {
  if (Array.isArray(project?.members)) return project.members.length;
  return Number.isFinite(project?.memberCount) ? project.memberCount : 0;
}

// --- chats -------------------------------------------------------------------------------

/**
 * Where a chat opens: inside its app, or the chat list when it has none.
 *
 * @param {{id: string, appId?: string|null}} chat
 * @returns {string}
 */
export function chatPath(chat) {
  return chat?.appId
    ? `/apps/${encodeURIComponent(chat.appId)}/c/${encodeURIComponent(chat.id)}`
    : '/chats';
}

/**
 * Where a chat inside a project starts: the app, with the project as a
 * query parameter the chat sends as `projectId` on its first turn (spec 1
 * §5.2, §6.3).
 *
 * @param {string} appId
 * @param {string} projectId
 * @returns {string}
 */
export function projectChatStartPath(appId, projectId) {
  const query = new URLSearchParams({ [PROJECT_QUERY_PARAM]: projectId });
  return `/apps/${encodeURIComponent(appId)}?${query}`;
}

/**
 * The apps a chat inside a project can start in: every app that does not
 * opt out with `features.userProjects: false` (spec 1 §6.1).
 *
 * @param {Array<{id: string, features?: Object}>} apps
 * @returns {Array<Object>}
 */
export function appsForProjectChats(apps) {
  return (apps || []).filter(app => app?.features?.userProjects !== false);
}

/**
 * The projects a chat may move into: user projects the caller may use,
 * except the one the chat is in (admin projects are not containers, the
 * server refuses them).
 *
 * @param {Array<Object>} projects
 * @param {string|null} currentProjectId
 * @returns {Array<Object>}
 */
export function chatMoveTargets(projects, currentProjectId) {
  return (projects || []).filter(
    project =>
      project?.ownership === 'user' &&
      project.permissions?.canUse !== false &&
      project.id !== currentProjectId
  );
}
