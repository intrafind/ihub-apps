/**
 * In-process notification bus.
 *
 * Deliberately NOT hooked into actionTracker.js's 'fire-sse' bus (server/sse.js) —
 * that bus's contract is chat-progress events keyed by chatId, not general
 * per-user notifications. This is a parallel, purpose-built emitter.
 *
 * `notify()` persists the notification (see NotificationStore.js) and then
 * emits it for any live SSE listeners to forward to connected clients. This
 * ordering means a client reconnecting after a notification fired still
 * sees it via the REST list endpoint, even though it missed the live push.
 */
import { EventEmitter } from 'events';
import { appendNotification } from './NotificationStore.js';
import logger from '../../utils/logger.js';

class NotificationService extends EventEmitter {
  constructor() {
    super();
    // Many per-user SSE connections (often several tabs per user) attach
    // concurrently — mirrors actionTracker.js's setMaxListeners(0).
    this.setMaxListeners(0);
  }

  /**
   * Persist and broadcast a notification for a user.
   *
   * @param {string} userId
   * @param {string} type - e.g. 'job.started' | 'job.progress' | 'job.completed' | 'job.error'
   * @param {object} [data]
   * @returns {Promise<object|null>} The persisted notification, or null if userId is missing
   */
  async notify(userId, type, data = {}) {
    if (!userId || !type) return null;
    try {
      const notification = await appendNotification(userId, type, data);
      this.emit('notification', notification);
      return notification;
    } catch (error) {
      logger.error('Failed to persist/broadcast notification', {
        component: 'NotificationService',
        userId,
        type,
        error: error.message
      });
      return null;
    }
  }
}

export default new NotificationService();
