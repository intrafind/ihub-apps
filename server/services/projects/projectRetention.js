// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Retention of abandoned user projects (spec 1 §9.3).
 *
 * `platform.projects.retentionDays > 0` makes a daily sweep delete user
 * projects whose `lastActivityAt` (last item change or chat turn) is older
 * than the limit, with the full cascade. Zero keeps projects until someone
 * deletes them, which is the default: a project carries uploaded knowledge,
 * and losing it by age is an admin's deliberate choice. Admin projects have
 * no retention.
 *
 * Same ownership guard as the chat sweep: the cluster-singleton worker runs
 * it, so two workers never race each other's deletes.
 *
 * @module services/projects/projectRetention
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { isStorageReady } from '../../storage/bootstrap.js';
import { logAudit } from '../AuditLogService.js';
import { getChatRepository } from '../chat/ChatRepository.js';
import { getProjectRepository } from './ProjectRepository.js';
import { getProjectService } from './ProjectService.js';
import { projectSettings } from './projectSettings.js';

const COMPONENT = 'ProjectRetention';
const DAY_MS = 24 * 60 * 60 * 1000;

let sweepTimer = null;
let startupTimer = null;
let sweeping = false;

function activityTime(project) {
  for (const candidate of [project?.lastActivityAt, project?.updatedAt, project?.createdAt]) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

/**
 * Delete every user project older than the retention limit.
 *
 * @param {Object} [options]
 * @param {number} [options.retentionDays] - Override the configured limit (tests).
 * @param {() => number} [options.now]
 * @returns {Promise<{scanned: number, deleted: number, skipped: boolean}>}
 */
export async function sweepProjects({ retentionDays, now = Date.now } = {}) {
  const days =
    retentionDays !== undefined
      ? Number(retentionDays)
      : projectSettings(configCache.getPlatform() || {}).retentionDays;
  if (!(days > 0)) return { scanned: 0, deleted: 0, skipped: true };
  const repository = getProjectRepository();
  if (!repository.isAvailable()) return { scanned: 0, deleted: 0, skipped: true };
  const cutoff = now() - days * DAY_MS;
  const { projects } = await repository.scanUser({
    filter: project => {
      const activeAt = activityTime(project);
      return Number.isFinite(activeAt) && activeAt < cutoff;
    }
  });
  const service = getProjectService();
  const chats = getChatRepository();
  let deleted = 0;
  for (const project of projects) {
    try {
      const removed = await service.deleteProject(project.id, {
        detachChat: chatId =>
          chats.isAvailable() ? chats.updateChat(chatId, { projectId: null }) : null
      });
      if (!removed) continue;
      deleted += 1;
      logAudit({
        action: 'delete',
        resource: 'project',
        resourceId: project.id,
        actor: { id: 'system', username: 'system', groups: [], authenticated: false },
        source: 'admin',
        summary: `Retention removed project "${project.name}" of ${project.owner?.name || project.owner?.id} after ${days} days without activity`
      });
    } catch (error) {
      logger.error('Failed to delete an expired project', {
        component: COMPONENT,
        projectId: project.id,
        error: error.message
      });
    }
  }
  if (deleted > 0) {
    logger.info('Project retention sweep removed expired projects', {
      component: COMPONENT,
      deleted,
      retentionDays: days
    });
  }
  return { scanned: projects.length, deleted, skipped: false };
}

/**
 * Start the daily sweep. Runs once at startup so a misconfigured limit shows
 * up at once rather than a day later.
 *
 * @param {Object} [options]
 * @param {number} [options.intervalMs]
 */
export function startProjectRetentionSweep({ intervalMs = DAY_MS } = {}) {
  if (sweepTimer) return;
  const tick = async () => {
    if (sweeping || !isStorageReady()) return;
    sweeping = true;
    try {
      await sweepProjects();
    } catch (error) {
      logger.error('Project retention sweep failed', {
        component: COMPONENT,
        error: error.message
      });
    } finally {
      sweeping = false;
    }
  };
  sweepTimer = setInterval(tick, intervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  // Off the startup path: the sweep reads every project document.
  startupTimer = setTimeout(tick, 5000);
  startupTimer.unref?.();
}

/** Stop the sweep (shutdown and tests). */
export function stopProjectRetentionSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (startupTimer) clearTimeout(startupTimer);
  sweepTimer = null;
  startupTimer = null;
}
