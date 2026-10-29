// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Restarting the whole server from inside a request handler.
 *
 * The launcher (and the shell / batch loop or the Windows service around it)
 * restarts the server when the process it started exits with
 * {@link UPDATE_RESTART_CODE}. Under clustering that process is the PRIMARY;
 * a worker that calls `process.exit(75)` is simply respawned by the primary,
 * which left the primary and the other workers running the old code from
 * memory next to one worker running the new code from disk. So a worker asks
 * the primary, which shuts every worker down and then exits with the code
 * itself.
 *
 * @module utils/processRestart
 */
import cluster from 'node:cluster';
import { randomUUID } from 'node:crypto';

export const UPDATE_RESTART_CODE = 75;

/**
 * Identifies one start of the server. Set in the primary (or the single
 * process) when this module loads, before any worker is forked, so every
 * worker inherits the same value. The admin UI compares it before and after
 * an update to know the server really restarted — the clocks of browser and
 * server need not agree, and each worker has its own start time.
 */
if (!process.env.IHUB_BOOT_ID) process.env.IHUB_BOOT_ID = randomUUID();
export const BOOT_ID = process.env.IHUB_BOOT_ID;

/** Key of the worker → primary IPC message asking for a restart. */
export const RESTART_MESSAGE_KEY = '__ihubRestartRequest';

let shutdownExitCode = 0;

/** Exit code the graceful shutdown ends the process with (0 unless a restart was asked for). */
export function getShutdownExitCode() {
  return shutdownExitCode;
}

/** Make the next graceful shutdown end the process with `code`. */
export function setShutdownExitCode(code) {
  shutdownExitCode = code;
}

/**
 * Restart the server: drain and exit with {@link UPDATE_RESTART_CODE}.
 *
 * Emits SIGTERM on the process rather than sending it: `process.kill(pid,
 * 'SIGTERM')` terminates a Windows process unconditionally, without running
 * the shutdown handler and without the exit code.
 *
 * @param {Object} [options]
 * @param {number} [options.delayMs=1000] - Lets the HTTP response that asked for the restart go out first
 * @param {number} [options.forceAfterMs=30000] - Exit even if the graceful shutdown hangs
 */
export function requestServerRestart({ delayMs = 1000, forceAfterMs = 30_000 } = {}) {
  setTimeout(() => {
    if (cluster.isWorker && typeof process.send === 'function') {
      process.send({ [RESTART_MESSAGE_KEY]: UPDATE_RESTART_CODE });
      return;
    }
    setShutdownExitCode(UPDATE_RESTART_CODE);
    setTimeout(() => process.exit(UPDATE_RESTART_CODE), forceAfterMs).unref();
    if (process.listenerCount('SIGTERM') > 0) {
      process.emit('SIGTERM', 'SIGTERM');
    } else {
      process.exit(UPDATE_RESTART_CODE);
    }
  }, delayMs);
}
