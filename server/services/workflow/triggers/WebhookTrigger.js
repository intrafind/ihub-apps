import logger from '../../../utils/logger.js';
import crypto from 'crypto';

export class WebhookTrigger {
  constructor(triggerId, workflowId, config, manager) {
    this.triggerId = triggerId;
    this.workflowId = workflowId;
    this.config = config; // { id, type: 'webhook', secret?: string, path?: string }
    this.manager = manager;
    this.type = 'webhook';
    this.active = false;
  }

  async start() {
    this.active = true;
    // Webhook triggers are HTTP-driven - the route handler calls fire()
    // Registration just marks it as active
    logger.info({
      component: 'WebhookTrigger',
      message: 'Registered webhook trigger',
      triggerId: this.triggerId
    });
  }

  async stop() {
    this.active = false;
  }

  // Verify webhook signature (HMAC-SHA256)
  verifySignature(payload, signature) {
    if (!this.config.secret) return true; // no secret configured = skip verification
    const expected = crypto.createHmac('sha256', this.config.secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  // Called by route handler when webhook fires
  async fire(payload) {
    if (!this.active) return;
    await this.manager.fireTrigger(this.triggerId, { webhookPayload: payload });
  }
}
