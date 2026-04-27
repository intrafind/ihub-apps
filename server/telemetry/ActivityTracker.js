import logger from '../utils/logger.js';
import { registerActivityObservers } from './metrics.js';

/**
 * Tracks active users and chats over a rolling time window.
 *
 * Drives both the OpenTelemetry observable gauges (`ihub.active.users`,
 * `ihub.active.chats`) and a periodic informational log line that lets
 * operators see activity even without a metrics backend.
 */
class ActivityTracker {
  constructor() {
    this.userTimestamps = new Map();
    this.chatTimestamps = new Map();
    this.windowMs = 5 * 60 * 1000;
    this.summaryIntervalMs = 5 * 60 * 1000;
    this.summaryEnabled = false;
    this.summaryTimer = null;
    this.observersRegistered = false;
    // Keep counts for the previous window so we can report a delta in the log line
    this.lastReportedUsers = 0;
    this.lastReportedChats = 0;
  }

  /**
   * Configure the tracker. Safe to call multiple times - it will tear down any
   * existing summary timer before applying the new schedule.
   * @param {Object} config
   * @param {boolean} [config.enabled] - Whether to log periodic activity summaries
   * @param {number} [config.intervalSeconds] - Logging interval in seconds
   * @param {number} [config.windowMinutes] - Rolling window in minutes
   */
  configure(config = {}) {
    const intervalSeconds = Math.max(10, Number(config.intervalSeconds) || 300);
    const windowMinutes = Math.max(1, Number(config.windowMinutes) || 5);

    this.windowMs = windowMinutes * 60 * 1000;
    this.summaryIntervalMs = intervalSeconds * 1000;
    this.summaryEnabled = Boolean(config.enabled);

    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }

    if (this.summaryEnabled) {
      this.summaryTimer = setInterval(() => this.logSummary(), this.summaryIntervalMs);
      // The Node event loop should not be held open by this housekeeping timer
      this.summaryTimer.unref?.();
    }

    if (!this.observersRegistered) {
      registerActivityObservers({
        getActiveUsers: () => this.getActiveUsers(),
        getActiveChats: () => this.getActiveChats(),
        attributes: { 'window.minutes': windowMinutes }
      });
      this.observersRegistered = true;
    }
  }

  /**
   * Record activity for a user/chat. Pass either or both - missing values are
   * silently ignored.
   */
  recordActivity({ userId, chatId } = {}) {
    const now = Date.now();
    if (userId) this.userTimestamps.set(userId, now);
    if (chatId) this.chatTimestamps.set(chatId, now);
    if (this.userTimestamps.size > 5000 || this.chatTimestamps.size > 5000) {
      this._prune(now);
    }
  }

  getActiveUsers() {
    this._prune(Date.now());
    return this.userTimestamps.size;
  }

  getActiveChats() {
    this._prune(Date.now());
    return this.chatTimestamps.size;
  }

  logSummary() {
    if (!this.summaryEnabled) return;
    const activeUsers = this.getActiveUsers();
    const activeChats = this.getActiveChats();
    const windowMinutes = this.windowMs / 60000;
    logger.info('Activity summary', {
      component: 'ActivityTracker',
      activeUsers,
      activeChats,
      windowMinutes,
      deltaUsers: activeUsers - this.lastReportedUsers,
      deltaChats: activeChats - this.lastReportedChats
    });
    this.lastReportedUsers = activeUsers;
    this.lastReportedChats = activeChats;
  }

  shutdown() {
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
  }

  _prune(now) {
    const cutoff = now - this.windowMs;
    for (const [key, ts] of this.userTimestamps) {
      if (ts < cutoff) this.userTimestamps.delete(key);
    }
    for (const [key, ts] of this.chatTimestamps) {
      if (ts < cutoff) this.chatTimestamps.delete(key);
    }
  }
}

const activityTracker = new ActivityTracker();
export default activityTracker;
