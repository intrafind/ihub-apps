/**
 * WebhookTrigger HMAC signature verification tests.
 *
 * These verify that:
 * - Signatures are computed over the RAW body bytes (matching GitHub,
 *   Stripe, etc.) -- not over a re-stringified JSON object.
 * - Missing / wrong-length / wrong-value signatures are rejected.
 * - A trigger with no configured secret never accepts requests
 *   (the route layer also enforces this, but defense-in-depth here).
 */

import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import { WebhookTrigger } from '../../../services/workflow/triggers/WebhookTrigger.js';

describe('WebhookTrigger.verifyRawSignature', () => {
  const secret = 'a'.repeat(32);

  function sign(secret, body) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  test('accepts a valid signature with `sha256=` prefix', () => {
    const trigger = new WebhookTrigger({ id: 'test', secret });
    const body = Buffer.from('{"a":1,"b":2}', 'utf8');
    const sig = `sha256=${sign(secret, body)}`;
    expect(trigger.verifyRawSignature(body, sig)).toBe(true);
  });

  test('accepts a valid signature without prefix', () => {
    const trigger = new WebhookTrigger({ id: 'test', secret });
    const body = Buffer.from('{"a":1}', 'utf8');
    const sig = sign(secret, body);
    expect(trigger.verifyRawSignature(body, sig)).toBe(true);
  });

  test('rejects a signature computed over a re-stringified body', () => {
    const trigger = new WebhookTrigger({ id: 'test', secret });
    // External sender: signs the raw bytes they actually sent.
    const rawBody = Buffer.from('{"b":2,"a":1}', 'utf8'); // arbitrary key order
    const sig = `sha256=${sign(secret, rawBody)}`;

    // Old buggy code re-stringified the parsed body, which reorders keys
    // and breaks the signature. Verifying against the raw body succeeds:
    expect(trigger.verifyRawSignature(rawBody, sig)).toBe(true);

    // ...but a signature computed over JSON.stringify of the parsed body
    // would not match the raw bytes:
    const reSerialized = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString())));
    const badSig = `sha256=${sign(secret, reSerialized)}`;
    expect(trigger.verifyRawSignature(rawBody, badSig)).toBe(false);
  });

  test('rejects a missing signature', () => {
    const trigger = new WebhookTrigger({ id: 'test', secret });
    expect(trigger.verifyRawSignature(Buffer.from(''), undefined)).toBe(false);
    expect(trigger.verifyRawSignature(Buffer.from(''), '')).toBe(false);
  });

  test('rejects when the trigger has no secret configured', () => {
    const trigger = new WebhookTrigger({ id: 'test' });
    const body = Buffer.from('{}');
    const sig = `sha256=${sign('any-secret', body)}`;
    expect(trigger.verifyRawSignature(body, sig)).toBe(false);
  });

  test('rejects signatures of the wrong length without throwing', () => {
    const trigger = new WebhookTrigger({ id: 'test', secret });
    const body = Buffer.from('{}');
    // timingSafeEqual throws on length mismatch; the method must catch this.
    expect(() => trigger.verifyRawSignature(body, 'sha256=abc')).not.toThrow();
    expect(trigger.verifyRawSignature(body, 'sha256=abc')).toBe(false);
  });

  test('rejects a signature with a different secret', () => {
    const trigger = new WebhookTrigger({ id: 'test', secret });
    const body = Buffer.from('{"x":1}');
    const sig = `sha256=${sign('wrong-secret-of-equal-length-as-original', body)}`;
    expect(trigger.verifyRawSignature(body, sig)).toBe(false);
  });
});

describe('WebhookTrigger.stop', () => {
  test('is a no-op and does not throw', () => {
    const trigger = new WebhookTrigger({ id: 'test' });
    expect(() => trigger.stop()).not.toThrow();
  });
});

// Silence logger warnings inside the suite
jest.mock('../../../utils/logger.js', () => ({
  __esModule: true,
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
}));
