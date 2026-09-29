import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

/**
 * Whether the server runs scheduled tasks (flag, durable chats and platform
 * switch agree). Platform config only — for components inside a chat, where
 * the viewer is already known to be the chat's owner, and which should not
 * pull the auth state in.
 *
 * @returns {boolean}
 */
export function useScheduledTasksEnabled() {
  const { platformConfig, isLoading } = usePlatformConfig() || {};
  return !isLoading && platformConfig?.scheduledTasks?.enabled === true;
}

/**
 * The limits the task form respects.
 *
 * @returns {{minIntervalMinutes: number, staggerMinutes: number, maxTasksPerUser: number,
 *   maxInstructionLength: number}}
 */
export function useScheduledTaskLimits() {
  const { platformConfig } = usePlatformConfig() || {};
  const cfg = platformConfig?.scheduledTasks || {};
  return {
    minIntervalMinutes: cfg.minIntervalMinutes ?? 15,
    staggerMinutes: cfg.staggerMinutes ?? 0,
    maxTasksPerUser: cfg.maxTasksPerUser ?? 10,
    maxInstructionLength: cfg.maxInstructionLength ?? 8000
  };
}
