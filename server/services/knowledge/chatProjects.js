// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a chat request says about projects (spec 1 §5.2, §6.4): the
 * container project (`projectId`, accepted on the first turn and fixed for
 * the chat) and the projects attached from the chat-input picker
 * (`projects`, their union persisted on the chat).
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

const MAX_ATTACHED = 10;

/**
 * Resolve the request's project fields against the stored chat and the
 * caller's access.
 *
 * @param {Object} options
 * @param {Object} options.req - Express request (the user is read from it).
 * @param {Object|null} options.chat - The stored chat, when there is one.
 * @param {Object} options.app - The app configuration.
 * @param {unknown} options.projectId - `req.body.projectId`
 * @param {unknown} options.projects - `req.body.projects`
 * @returns {Promise<{ok: true, containerId: string|null, attachedIds: string[],
 *   chatPatch: Object|null, newContainer: boolean}|{ok: false, status: number, code: string, message: string}>}
 */
export async function resolveChatProjects({ req, chat, app, projectId, projects }) {
  const requestedContainer = typeof projectId === 'string' && projectId ? projectId : null;
  const requestedAttached = Array.isArray(projects)
    ? [...new Set(projects.filter(id => typeof id === 'string' && isProjectId(id)))].slice(
        0,
        MAX_ATTACHED
      )
    : [];
  const storedContainer = chat?.projectId || null;
  const storedAttached = Array.isArray(chat?.attachedProjectIds) ? chat.attachedProjectIds : [];

  if (!requestedContainer && !requestedAttached.length) {
    return {
      ok: true,
      containerId: storedContainer,
      attachedIds: storedAttached,
      chatPatch: null,
      newContainer: false
    };
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
    return {
      ok: true,
      containerId: storedContainer,
      attachedIds: storedAttached,
      chatPatch: null,
      newContainer: false
    };
  }
  if (requestedContainer && storedContainer && requestedContainer !== storedContainer) {
    return {
      ok: false,
      status: 409,
      code: 'PROJECT_MISMATCH',
      message: 'This chat already runs inside another project; move it with PATCH /api/chats/:id'
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
    return permissionsFor(project, req.user, context).canUse;
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
  const attachedIds = [...storedAttached];
  for (const id of requestedAttached) {
    if (id === containerId || attachedIds.includes(id)) continue;
    if (await usable(id)) attachedIds.push(id);
  }
  const changed = newContainer || attachedIds.length !== storedAttached.length;
  return {
    ok: true,
    containerId,
    attachedIds,
    chatPatch: changed
      ? { ...(newContainer ? { projectId: containerId } : {}), attachedProjectIds: attachedIds }
      : null,
    newContainer
  };
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
