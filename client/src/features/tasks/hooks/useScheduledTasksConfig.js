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
 * The limits the task form respects. `memoryEnabled` is the platform switch for
 * "Remember between runs" (on unless the server says false) and `memoryMaxChars`
 * the size limit of a task's notes.
 *
 * @returns {{minIntervalMinutes: number, staggerMinutes: number, maxTasksPerUser: number,
 *   maxInstructionLength: number, memoryEnabled: boolean, memoryMaxChars: number}}
 */
export function useScheduledTaskLimits() {
  const { platformConfig } = usePlatformConfig() || {};
  const cfg = platformConfig?.scheduledTasks || {};
  return {
    minIntervalMinutes: cfg.minIntervalMinutes ?? 15,
    staggerMinutes: cfg.staggerMinutes ?? 0,
    maxTasksPerUser: cfg.maxTasksPerUser ?? 10,
    maxInstructionLength: cfg.maxInstructionLength ?? 8000,
    memoryEnabled: cfg.memoryEnabled !== false,
    memoryMaxChars: cfg.memoryMaxChars ?? 16000
  };
}
