/**
 * ScheduleTrigger
 *
 * Manages cron-based scheduling for workflow triggers using the croner library.
 * Each instance wraps a single cron job that fires a callback on its schedule.
 *
 * @module services/workflow/triggers/ScheduleTrigger
 */

import { Cron } from 'croner';
import logger from '../../../utils/logger.js';

/**
 * A cron-based trigger that fires a callback on a recurring schedule.
 *
 * @example
 * const trigger = new ScheduleTrigger(
 *   { id: 'daily-report', cron: '0 9 * * *', timezone: 'Europe/Berlin' },
 *   () => console.log('Triggered!')
 * );
 * // Later: trigger.stop();
 */
export class ScheduleTrigger {
  /**
   * Creates a new ScheduleTrigger and immediately starts the cron job.
   *
   * @param {Object} config - Trigger configuration
   * @param {string} config.id - Unique identifier for this trigger
   * @param {string} config.cron - Cron expression (5 or 6 fields, croner syntax)
   * @param {string} [config.timezone] - IANA timezone for the schedule (e.g. 'Europe/Berlin')
   * @param {Function} callback - Function to invoke when the cron fires
   */
  constructor(config, callback) {
    this.config = config;
    this.callback = callback;
    this.job = null;

    try {
      this.job = new Cron(
        config.cron,
        {
          timezone: config.timezone,
          protect: true
        },
        () => {
          logger.info({
            component: 'ScheduleTrigger',
            message: `Cron trigger fired: ${config.id}`,
            cron: config.cron
          });
          callback();
        }
      );

      logger.info({
        component: 'ScheduleTrigger',
        message: `Registered schedule trigger: ${config.id}`,
        cron: config.cron,
        timezone: config.timezone
      });
    } catch (error) {
      logger.error({
        component: 'ScheduleTrigger',
        message: `Failed to create cron job: ${error.message}`,
        triggerId: config.id,
        cron: config.cron
      });
    }
  }

  /**
   * Stops the cron job so it no longer fires.
   */
  stop() {
    if (this.job) {
      this.job.stop();
      logger.info({
        component: 'ScheduleTrigger',
        message: `Stopped schedule trigger: ${this.config.id}`
      });
    }
  }

  /**
   * Returns the next scheduled run time, or null if the job is stopped / invalid.
   *
   * @returns {Date|null} Next run date
   */
  getNextRun() {
    return this.job?.nextRun() || null;
  }
}

export default ScheduleTrigger;
