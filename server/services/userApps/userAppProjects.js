// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The projects a personal app links (`capabilities.projects`): who may use each
 * one, looked up for the ceiling.
 *
 * A personal app never gives anyone access to a project. A project is used in a
 * run only when the owner and the person chatting may use it, each in their own
 * right (design 07, section 2.4). The ceiling is pure, so the lookup happens here
 * and its result travels in the catalog (`catalog.projects`).
 *
 * "May use" is what the projects themselves decide (`permissionsFor`, the same
 * function that `resolveProjectScope` applies on every chat request): a member
 * or owner of a user project, a project shared with everyone, an admin project
 * the person reaches in their own right. A personal app is not in the app cache,
 * so it grants nobody an admin project (`linkedProjectIds`).
 *
 * @module services/userApps/userAppProjects
 */
import { callerContext, permissionsFor } from '../../middleware/projectAccess.js';
import { getProjectRepository } from '../projects/ProjectRepository.js';
import { canHoldProjects, memberRoleFor, principalMemberKeys } from '../projects/projectAccess.js';
import { loadProjectFor } from '../projects/projectLoader.js';
import { projectDescription, projectName } from '../projects/projectView.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'UserAppProjects';

/**
 * The IDs of the projects a content object links, each once, in order.
 *
 * @param {Object|null|undefined} content - The content of a personal app, or a draft of one.
 * @returns {string[]}
 */
export function linkedProjectIdsOf(content) {
  const list = content?.capabilities?.projects;
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** What one principal may do with one project: whether it exists for them and whether they may use it. */
async function lookup(principal, id, context) {
  if (!principal) return { exists: false, canUse: false };
  try {
    const loaded = await loadProjectFor(principal, id);
    if (loaded.status !== 'ok' || !loaded.project) return { exists: false, canUse: false };
    const permissions = permissionsFor(loaded.project, principal, context);
    return { exists: true, canUse: permissions.canUse === true, project: loaded.project };
  } catch (error) {
    // A failed lookup grants nothing.
    logger.warn('Could not look up a project a personal app links; granting none', {
      component: COMPONENT,
      projectId: id,
      error: error.message
    });
    return { exists: false, canUse: false };
  }
}

/**
 * Who may use each project of `ids`.
 *
 * @param {string[]} ids
 * @param {Object} principals
 * @param {Object|null} principals.owner - The owner's principal, or null.
 * @param {Object} principals.runner - The person chatting, or the person saving.
 * @returns {Promise<Record<string, {exists: boolean, ownership: 'user'|'admin'|null,
 *   name: string, owner: boolean, runner: boolean}>>}
 *
 * @example
 * await projectAccessFor(['prj_abc'], { owner: anna, runner: ben });
 * // → { prj_abc: { exists: true, ownership: 'user', name: 'Handbook', owner: true, runner: false } }
 */
export async function projectAccessFor(ids, { owner, runner }) {
  const access = {};
  if (!Array.isArray(ids) || ids.length === 0) return access;
  const same = Boolean(owner) && owner === runner;
  const ownerContext = owner ? callerContext(owner) : null;
  const runnerContext = same ? ownerContext : runner ? callerContext(runner) : null;
  for (const id of ids) {
    const forOwner = await lookup(owner, id, ownerContext);
    const forRunner = same ? forOwner : await lookup(runner, id, runnerContext);
    const project = forOwner.project || forRunner.project;
    access[id] = {
      exists: forOwner.exists || forRunner.exists,
      ownership: project?.ownership === 'admin' ? 'admin' : project ? 'user' : null,
      name: project ? projectName(project) : '',
      owner: forOwner.canUse,
      runner: forRunner.canUse
    };
  }
  return access;
}

/** The most projects the builder is told about. */
export const MAX_LISTED_PROJECTS = 20;

/**
 * The user projects the caller may use, owned or shared with them, as the builder
 * lists them: ID, name and a short description. At most {@link MAX_LISTED_PROJECTS}.
 * The admin projects a person reaches through apps are not listed; the editor offers
 * them, and the builder does not propose them.
 *
 * @param {Object} user - The caller, with resolved permissions.
 * @param {string} [language]
 * @returns {Promise<Array<{id: string, name: string, description: string}>>}
 */
export async function usableProjectsFor(user, language = 'en') {
  if (!user || !canHoldProjects(user)) return [];
  const repository = getProjectRepository();
  if (!repository.isAvailable()) return [];
  try {
    const context = callerContext(user);
    const owned = await repository.listOwned(String(user.id));
    const shared = (
      await repository.listSharedWith(principalMemberKeys(user, context.groups))
    ).filter(project => memberRoleFor(project, user, context.groups));
    const listed = [];
    const seen = new Set();
    for (const project of [...owned, ...shared]) {
      if (listed.length >= MAX_LISTED_PROJECTS) break;
      if (!project?.id || seen.has(project.id)) continue;
      seen.add(project.id);
      if (!permissionsFor(project, user, context).canUse) continue;
      listed.push({
        id: project.id,
        name: projectName(project, language),
        description: projectDescription(project, language, 200)
      });
    }
    return listed;
  } catch (error) {
    logger.warn('Could not list the projects of a person for the app builder; offering none', {
      component: COMPONENT,
      error: error.message
    });
    return [];
  }
}
