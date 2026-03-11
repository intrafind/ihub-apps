import { Cron } from 'croner';
import logger from '../../../utils/logger.js';

export class ScheduleTrigger {
  constructor(triggerId, workflowId, config, manager) {
    this.triggerId = triggerId;
    this.workflowId = workflowId;
    this.config = config; // { id, type: 'schedule', cron: '0 * * * *', timezone?: string, initialData?: object }
    this.manager = manager;
    this.type = 'schedule';
    this.active = false;
    this.job = null;
  }

  async start() {
    try {
      this.job = new Cron(
        this.config.cron,
        { timezone: this.config.timezone || 'UTC', protect: true },
        () => {
          this.manager.fireTrigger(this.triggerId, this.config.initialData || {});
        }
      );
      this.active = true;
      logger.info({
        component: 'ScheduleTrigger',
        message: 'Started cron trigger',
        triggerId: this.triggerId,
        cron: this.config.cron
      });
    } catch (error) {
      logger.error({
        component: 'ScheduleTrigger',
        message: 'Failed to start cron trigger',
        error: error.message
      });
      throw error;
    }
  }

  async stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.active = false;
  }
}
