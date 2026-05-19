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
   * Verifies the HMAC-SHA256 signature of an incoming webhook payload
   * over the raw request body bytes. This matches the convention used
   * by GitHub, Stripe, and most other webhook providers, which sign
   * the exact bytes they sent -- not a re-stringified parsed object.
   *
   * Returns false if no secret is configured. The route layer is
   * responsible for refusing requests to secret-less triggers; this
   * method only verifies a signature when verification is possible.
   *
   * @param {Buffer} rawBody - The raw request body bytes
   * @param {string} signature - The signature header value (e.g. 'sha256=abcdef...')
   * @returns {boolean} True if the signature is valid
   */
  verifyRawSignature(rawBody, signature) {
    if (!this.config.secret) return false;

    const expected = crypto
      .createHmac('sha256', this.config.secret)
      .update(rawBody || Buffer.alloc(0))
      .digest('hex');

    const sig = (signature || '').replace('sha256=', '');

    if (!sig) {
      logger.warn({
        component: 'WebhookTrigger',
        message: 'Missing signature for webhook',
        triggerId: this.config.id
      });
      return false;
    }

    let expectedBuf;
    let sigBuf;
    try {
      expectedBuf = Buffer.from(expected, 'hex');
      sigBuf = Buffer.from(sig, 'hex');
    } catch {
      return false;
    }

    // timingSafeEqual requires equal-length buffers; otherwise it throws
    if (expectedBuf.length !== sigBuf.length) {
      return false;
    }

    try {
      return crypto.timingSafeEqual(expectedBuf, sigBuf);
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
