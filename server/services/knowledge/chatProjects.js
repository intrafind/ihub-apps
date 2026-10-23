// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a chat request says about projects (spec 1 §5.2, §6.4): the
 * container project (`projectId`, accepted on the first turn and fixed for
 * the chat: a different value, `null` included, on a chat that already runs
 * inside a project or already has messages answers `409 PROJECT_MISMATCH`)
 * and the projects attached from the chat-input picker (`projects`, their
 * union persisted on the chat).
 *
 * @module services/knowledge/chatProjects
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { callerContext, ensurePrincipal, permissionsFor } from '../../middleware/projectAccess.js';
import { getProjectRepository, isProjectId } from '../projects/ProjectRepository.js';
import { getProjectService } from '../projects/ProjectService.js';
import { isProjectsConfigured, isUserProjectsConfigured } from '../projects/projectSettings.js';
import { canHoldProjects } from '../projects/projectAccess.js';
import { MAX_ATTACHED_PROJECTS } from '../projects/projectConstants.js';

/** Most projects a chat may have attached, stored ones included. */
export const MAX_ATTACHED = MAX_ATTACHED_PROJECTS;

/**
 * What a turn writes about projects, under the chat lock.
 *
 * @typedef {Object} ProjectPatch
 * @property {string} [claimContainer] - The container this first turn opens
 *   the chat in; refused when the chat has another one or messages by then.
 * @property {string|null} [expectedContainer] - The container the turn
 *   asserted (`projectId` given and unchanged); refused when it differs by then.
 * @property {string[]} attach - Projects this turn adds to the stored ones.
 * @property {number} maxAttached - Most attached projects the union may hold.
 */

/**
 * Resolve the request's project fields against the stored chat and the
 * caller's access.
 *
 * @param {Object} options
 * @param {Object} options.req - Express request (the user is read from it).
 * @param {Object|null} options.chat - The stored chat, when there is one.
 * @param {Object} options.app - The app configuration.
 * @param {unknown} options.projectId - `req.body.projectId`: omitted (`undefined`) says
 *   nothing, `null` asks for a chat outside any project
 * @param {unknown} options.projects - `req.body.projects`
 * The container and the attachments are checked here against the chat as
 * read before the turn is prepared, but written with the turn's question
 * under the chat lock (`projectPatch`, applied by
 * `ChatRepository.updateChatProjects`): a container is claimed there only
 * while the chat still has none and no messages, and the attachments are
 * added to the ids stored by then, so two overlapping turns can neither
 * swap a chat's container nor drop each other's attachments.
 *
 * @returns {Promise<{ok: true, containerId: string|null, attachedIds: string[],
 *   projectPatch: ProjectPatch|null, newContainer: boolean}|{ok: false, status: number, code: string, message: string}>}
 */
export async function resolveChatProjects({ req, chat, app, projectId, projects }) {
  // An omitted `projectId` says nothing; an explicit `null` (or empty
  // string) asks for a chat outside any project, which is a change too when
  // the chat already runs inside one.
  const containerGiven = projectId !== undefined;
  const requestedContainer = typeof projectId === 'string' && projectId ? projectId : null;
  const requestedAttached = Array.isArray(projects)
    ? [...new Set(projects.filter(id => typeof id === 'string' && isProjectId(id)))].slice(
        0,
        MAX_ATTACHED
      )
    : [];
  const storedContainer = chat?.projectId || null;
  const storedAttached = Array.isArray(chat?.attachedProjectIds) ? chat.attachedProjectIds : [];
  const unchanged = {
    ok: true,
    containerId: storedContainer,
    attachedIds: storedAttached,
    projectPatch: null,
    newContainer: false
  };

  if (!requestedContainer && !requestedAttached.length && !(containerGiven && storedContainer)) {
    // An explicit `null` on a chat outside any project still asserts that:
    // a first turn racing this one must not have opened it in a project.
    return containerGiven
      ? { ...unchanged, projectPatch: projectPatchOf({ expectedContainer: null }) }
      : unchanged;
  }
  const features = configCache.getFeatures();
  const allowed =
    isProjectsConfigured(features) &&
    isUserProjectsConfigured(features) &&
    canHoldProjects(req.user) &&
    app?.features?.userProjects !== false;
  if (!allowed) {
    logger.warn('Project fields on a chat request were ignored', {
      component: 'chatProjects',
      chatId: chat?.id,
      reason: 'user projects are off for this app, installation or principal'
    });
    return unchanged;
  }
  // The container is chosen with the first turn and fixed from then on: a
  // chat with a transcript that joined a project would hand its earlier
  // messages to the project's members, and one that left a project would
  // take them away. Either is an explicit move (`PATCH /api/chats/:id`).
  if (
    containerGiven &&
    requestedContainer !== storedContainer &&
    (storedContainer || Number(chat?.messageCount) > 0)
  ) {
    return {
      ok: false,
      status: 409,
      code: 'PROJECT_MISMATCH',
      message: storedContainer
        ? 'This chat already runs inside a project; move it with PATCH /api/chats/:id'
        : 'This chat already has messages outside a project; move it with PATCH /api/chats/:id'
    };
  }
  ensurePrincipal(req);
  const repository = getProjectRepository();
  const context = callerContext(req.user);
  const usable = async (id, { container = false } = {}) => {
    if (!isProjectId(id)) return false;
    const project = await repository.get(id);
    if (!project) return false;
    // A container holds chats, which its members may read: only a user
    // project is one (the same rule as a move, `routes/chats.js`). An admin
    // project is knowledge, attached or linked, never a container.
    if (container && project.ownership !== 'user') return false;
    const permissions = permissionsFor(project, req.user, context);
    // Someone who took the project from the catalog attaches it; a chat of
    // theirs inside it would be open to its members.
    return permissions.canUse && (!container || permissions.canHoldChats);
  };

  let containerId = storedContainer;
  let newContainer = false;
  if (requestedContainer && !storedContainer) {
    if (!(await usable(requestedContainer, { container: true }))) {
      return { ok: false, status: 404, code: 'PROJECT_NOT_FOUND', message: 'Project not found' };
    }
    containerId = requestedContainer;
    newContainer = true;
  }
  // The cap bounds the persisted union, not one request: every later
  // prompt and knowledge search walks the whole attached list.
  const attachedIds = storedAttached.slice(0, MAX_ATTACHED);
  const attach = [];
  for (const id of requestedAttached) {
    if (attachedIds.length >= MAX_ATTACHED) break;
    if (id === containerId || attachedIds.includes(id)) continue;
    if (await usable(id)) {
      attachedIds.push(id);
      attach.push(id);
    }
  }
  const changed = newContainer || attach.length > 0;
  return {
    ok: true,
    containerId,
    attachedIds,
    projectPatch:
      changed || containerGiven
        ? projectPatchOf({
            ...(newContainer
              ? { claimContainer: containerId }
              : containerGiven
                ? { expectedContainer: storedContainer }
                : {}),
            attach
          })
        : null,
    newContainer
  };
}

/** @returns {ProjectPatch} */
function projectPatchOf({ attach = [], ...container }) {
  return { ...container, attach, maxAttached: MAX_ATTACHED };
}

/**
 * Record a chat in its container project (the marker the project page lists
 * chats by). Best-effort: the chat's own `projectId` is the authority.
 *
 * @param {string} projectId
 * @param {string} chatId
 * @param {{ownerId?: string|null}} [options]
 */
export async function recordChatInProject(projectId, chatId, { ownerId = null } = {}) {
  try {
    await getProjectService().attachChat(projectId, chatId, { ownerId });
  } catch (error) {
    logger.warn('Could not record a chat in its project', {
      component: 'chatProjects',
      projectId,
      chatId,
      error: error.message
    });
  }
}
