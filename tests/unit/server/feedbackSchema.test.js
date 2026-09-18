import { describe, expect, test } from '@jest/globals';
import { feedbackSchema } from '../../../server/validators/index.js';

const validBody = {
  messageId: 'msg-1',
  appId: 'app-1',
  chatId: 'chat-1',
  rating: 4
};

describe('feedbackSchema', () => {
  test('accepts a minimal valid submission', () => {
    expect(feedbackSchema.body.safeParse(validBody).success).toBe(true);
  });

  test.each(['conversationId', 'ifinderMessageId'])(
    // The client explicitly sends `null` for %s when there's nothing to report
    // (e.g. no conversation ID yet in localStorage, or a non-iFinder message) —
    // it must not be rejected the way an actually-wrong type would be.
    'accepts null for the optional %s field',
    field => {
      const result = feedbackSchema.body.safeParse({ ...validBody, [field]: null });
      expect(result.success).toBe(true);
    }
  );

  test('still rejects a non-string, non-null value for conversationId', () => {
    const result = feedbackSchema.body.safeParse({ ...validBody, conversationId: 42 });
    expect(result.success).toBe(false);
  });
});
