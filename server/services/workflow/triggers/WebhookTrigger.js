/**
 * WebhookTrigger
 *
 * Handles signature verification for incoming webhook payloads.
 * Uses HMAC-SHA256 with timing-safe comparison to prevent timing attacks.
 *
 * @module services/workflow/triggers/WebhookTrigger
 */

import crypto from 'node:crypto';
import logger from '../../../utils/logger.js';

/**
 * A webhook trigger that verifies incoming payload signatures.
 * Unlike ScheduleTrigger, webhooks are passive -- they are invoked
 * by external HTTP requests rather than on a timer.
 *
 * @example
 * const trigger = new WebhookTrigger({ id: 'github-push', secret: 'my-secret' });
 * const valid = trigger.verifySignature(payload, req.headers['x-hub-signature-256']);
 */
export class WebhookTrigger {
  /**
   * Creates a new WebhookTrigger.
   *
   * @param {Object} config - Trigger configuration
   * @param {string} config.id - Unique identifier for this trigger
   * @param {string} [config.secret] - HMAC secret for signature verification (optional)
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * Verifies the HMAC-SHA256 signature of an incoming webhook payload.
   * If no secret is configured, verification is skipped (returns true).
   *
   * @param {Object} payload - The parsed JSON body of the webhook request
   * @param {string} signature - The signature header value (e.g. 'sha256=abcdef...')
   * @returns {boolean} True if the signature is valid or no secret is configured
   */
  verifySignature(payload, signature) {
    if (!this.config.secret) return true;

    const expected = crypto
      .createHmac('sha256', this.config.secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    const sig = (signature || '').replace('sha256=', '');

    if (!sig) {
      logger.warn({
        component: 'WebhookTrigger',
        message: 'Missing signature for webhook with secret configured',
        triggerId: this.config.id
      });
      return false;
    }

    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch {
      return false;
    }
  }

  /**
   * No-op cleanup. Webhooks are stateless and do not need teardown.
   */
  stop() {
    // Webhooks don't need cleanup
  }
}

export default WebhookTrigger;
