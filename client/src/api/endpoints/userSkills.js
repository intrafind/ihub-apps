import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import cache from '../../utils/cache';

/**
 * Personal skills — the skills users write for themselves and share with
 * other users, groups or everyone signed in. They follow the ownership model
 * of user prompts (see `./prompts.js`): every view carries its `scope`
 * (`mine`, `shared`), the caller's `access` and the `permissions` the server
 * computed; the UI only uses those to show or hide actions.
 *
 * Global skills (`contents/skills/<name>/`) stay admin-managed and are listed
 * by `fetchSkills` in `./skills.js`. That list is the `/` picker's source and
 * also carries the personal skills the caller may use, so every write below
 * drops its cached copy — a skill someone just created, shared or revoked
 * shows up (or goes) the next time the picker opens.
 *
 * Errors keep the server's `details.code` (`REVISION_CONFLICT`,
 * `SKILL_LIMIT_REACHED`, …); `features/skills/utils/skillErrors.js` turns them
 * into messages.
 */

/** Cache keys of the picker list: `skills` and `skills?language=…`. */
const PICKER_CACHE_PATTERN = /^skills(\?|$)/;

/**
 * Drop the cached `/api/skills` picker list.
 *
 * @returns {number} How many cache entries were dropped.
 */
export const invalidateSkillsPickerCache = () => cache.invalidateByPattern(PICKER_CACHE_PATTERN);

const read = call => handleApiResponse(call, null, null, false);

const write = async call => {
  try {
    return await handleApiResponse(call, null, null, false);
  } finally {
    invalidateSkillsPickerCache();
  }
};

const skillPath = id => `/user-skills/${encodeURIComponent(id)}`;

/**
 * The personal skills the caller may see, newest first, without body and files.
 *
 * @param {'all'|'mine'|'shared'} [scope='all'] - Which skills to list.
 * @returns {Promise<Object[]>} `UserSkillView[]`
 */
export const fetchUserSkills = async (scope = 'all') =>
  read(() => apiClient.get('/user-skills', { params: { scope } }));

/**
 * One personal skill with its body and files (and, for those who may share
 * it, its share list).
 *
 * @param {string} skillId - User skill id (`usk_…`).
 * @returns {Promise<Object>} `UserSkillView` (detail)
 */
export const fetchUserSkill = async skillId => read(() => apiClient.get(skillPath(skillId)));

/**
 * Create a skill owned by the caller — private until shared.
 *
 * @param {{name: string, description: string, body: string, files?: Array<{path: string, content: string}>}} data
 * @returns {Promise<Object>} The created skill (detail).
 */
export const createUserSkill = async data => write(() => apiClient.post('/user-skills', data));

/**
 * Save a personal skill as a new revision. `expectedRevision` makes the save
 * fail with 409 `REVISION_CONFLICT` when someone else saved in between.
 *
 * @param {string} skillId - User skill id.
 * @param {Object} data - `{ name, description, body, files?, expectedRevision? }`
 * @returns {Promise<Object>} The saved skill (detail).
 */
export const updateUserSkill = async (skillId, data) =>
  write(() => apiClient.put(skillPath(skillId), data));

/**
 * Delete a personal skill (owner or admin).
 *
 * @param {string} skillId - User skill id.
 * @returns {Promise<{success: boolean}>}
 */
export const deleteUserSkill = async skillId => write(() => apiClient.delete(skillPath(skillId)));

/**
 * Replace who a personal skill is shared with.
 *
 * @param {string} skillId - User skill id.
 * @param {Array<{type: 'user'|'group'|'everyone', id?: string, permission: 'use'|'edit'}>} shares
 * @returns {Promise<Object>} The skill with its new share list.
 */
export const updateUserSkillShares = async (skillId, shares) =>
  write(() => apiClient.put(`${skillPath(skillId)}/shares`, { shares }));

/**
 * Hand a personal skill to another user.
 *
 * @param {string} skillId - User skill id.
 * @param {string} ownerId - The new owner's user id.
 * @returns {Promise<Object>} The skill with its new owner.
 */
export const transferUserSkill = async (skillId, ownerId) =>
  write(() => apiClient.put(`${skillPath(skillId)}/owner`, { ownerId }));

/**
 * Copy a personal skill (own or shared) into the caller's own skills.
 *
 * @param {string} skillId - User skill id.
 * @param {{name?: string}} [body] - Optional name of the copy.
 * @returns {Promise<Object>} The copy (detail).
 */
export const duplicateUserSkill = async (skillId, body = {}) =>
  write(() => apiClient.post(`${skillPath(skillId)}/duplicate`, body));

/**
 * Copy a global skill into the caller's own skills ("Copy to my skills").
 *
 * @param {string} skillName - Global skill name.
 * @param {{name?: string}} [body] - Optional name of the copy.
 * @returns {Promise<Object>} The copy (detail).
 */
export const duplicateGlobalSkill = async (skillName, body = {}) =>
  write(() => apiClient.post(`/skills/${encodeURIComponent(skillName)}/duplicate`, body));

/**
 * Saved revisions of a personal skill, newest first, without body and files.
 *
 * @param {string} skillId - User skill id.
 * @returns {Promise<Array<{revision: number, name: string, description: string, savedAt: string, savedBy: {id: string, name: string}, restoredFrom?: number}>>}
 */
export const fetchUserSkillVersions = async skillId =>
  read(() => apiClient.get(`${skillPath(skillId)}/versions`));

/**
 * One saved revision with its body and files.
 *
 * @param {string} skillId - User skill id.
 * @param {number} revision - Revision number.
 * @returns {Promise<Object>}
 */
export const fetchUserSkillVersion = async (skillId, revision) =>
  read(() => apiClient.get(`${skillPath(skillId)}/versions/${encodeURIComponent(revision)}`));

/**
 * Restore an old revision — saved as a new one.
 *
 * @param {string} skillId - User skill id.
 * @param {number} revision - Revision to restore.
 * @returns {Promise<Object>} The skill (detail).
 */
export const restoreUserSkillVersion = async (skillId, revision) =>
  write(() =>
    apiClient.post(`${skillPath(skillId)}/versions/${encodeURIComponent(revision)}/restore`)
  );

/**
 * Users and groups the caller may share skills with, and which audiences are
 * open. Users are only searched from two characters on.
 *
 * @param {string} query - Search text.
 * @returns {Promise<{allowed: Object, users: Object[], groups: Object[]}>}
 */
export const fetchUserSkillShareTargets = async query =>
  read(() => apiClient.get('/user-skills/share-targets', { params: { q: query || '' } }));

/* -------------------------------------------------------------------------- */
/*  Admin (full admin or content admin; settings: full admins only)           */
/* -------------------------------------------------------------------------- */

/**
 * The personal skills users shared with a group or everyone, as admins see
 * them (owner id and shares included).
 *
 * @returns {Promise<{skills: Object[], truncated: boolean, available: boolean}>}
 */
export const fetchAdminUserSkills = async () => read(() => apiClient.get('/admin/user-skills'));

/**
 * Promote a personal skill to a global skill (`contents/skills/<name>/`).
 * Fails with 409 `SKILL_NAME_TAKEN` when a global skill has that name.
 *
 * @param {string} skillId - User skill id.
 * @param {{name?: string}} [body] - Name of the global skill; defaults to the skill's name.
 * @returns {Promise<{name: string, promotedTo: Object}>}
 */
export const promoteUserSkill = async (skillId, body = {}) =>
  write(() => apiClient.post(`/admin/user-skills/${encodeURIComponent(skillId)}/promote`, body));

/**
 * The settings for personal skills (full admins only).
 *
 * @returns {Promise<{settings: Object, storageAvailable: boolean}>}
 */
export const fetchUserSkillSettings = async () =>
  read(() => apiClient.get('/admin/user-skills/settings'));

/**
 * Save the settings for personal skills (full admins only). The body may be
 * partial (any subset of the keys; `sharing` may be partial too).
 *
 * @param {Object} settings - `{ enabled?, maxSkillsPerUser?, maxVersions?, maxSkillSizeKB?, maxFilesPerSkill?, sharing? }`
 * @returns {Promise<{settings: Object, storageAvailable: boolean}>}
 */
export const saveUserSkillSettings = async settings =>
  write(() => apiClient.put('/admin/user-skills/settings', settings));
