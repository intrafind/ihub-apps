// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a user's deletion does to projects (spec 1 §9.2): every project they
 * own is deleted with the cascade, their membership is dropped from every
 * project that was shared with them, and the chats step has already removed
 * their chats (with the chat markers going through the cascade there).
 *
 * @module services/projects/projectUserCleanup
 */
import logger from '../../utils/logger.js';
import { getChatRepository } from '../chat/ChatRepository.js';
import { getProjectRepository } from './ProjectRepository.js';
import { getProjectService } from './ProjectService.js';
import { memberTargetKey } from './projectAccess.js';

const COMPONENT = 'ProjectUserCleanup';

/**
 * @param {string} userId
 * @returns {Promise<{removed: number, membershipsDropped: number}>}
 */
export async function cleanUpProjectsOfUser(userId) {
  const repository = getProjectRepository();
  if (!repository.isAvailable()) return { removed: 0, membershipsDropped: 0 };
  const service = getProjectService();
  const chats = getChatRepository();
  let removed = 0;
  const ownedBy = project => String(project?.owner?.id) === String(userId);
  for (const project of await repository.listOwned(String(userId))) {
    try {
      const deleted = await service.deleteProject(project.id, {
        // Judged again under the project's lock: a transfer that landed since
        // the listing leaves the new owner's project alone.
        authorize: ownedBy,
        detachChat: chatId =>
          chats.isAvailable() ? chats.moveProjectIf(chatId, project.id, null) : null
      });
      if (deleted) removed += 1;
    } catch (error) {
      if (error?.code === 'PROJECT_ACCESS_CHANGED') continue; // handed over since the listing
      logger.error('Failed to delete a project of a deleted user', {
        component: COMPONENT,
        projectId: project.id,
        error: error.message
      });
    }
  }
  const userKey = memberTargetKey({ type: 'user', id: String(userId) });
  let membershipsDropped = 0;
  for (const project of await repository.listSharedWith([userKey])) {
    try {
      // Against the member list stored right now, under the project's lock.
      const result = await repository.removeMember(project.id, userKey, {
        actor: { id: 'system', name: 'user deletion' }
      });
      if (result) membershipsDropped += 1;
    } catch (error) {
      logger.error('Failed to drop a membership of a deleted user', {
        component: COMPONENT,
        projectId: project.id,
        error: error.message
      });
    }
  }
  return { removed, membershipsDropped };
}
