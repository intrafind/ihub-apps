// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import { feedbackSchema } from '../../../server/validators/index.js';

const base = { messageId: 'msg-1', appId: 'chat', chatId: 'c1', rating: 4 };

describe('feedbackSchema', () => {
  it('accepts null for every optional field', () => {
    const result = feedbackSchema.body.safeParse({
      ...base,
      messageContent: null,
      feedback: null,
      modelId: null,
      runId: null
    });
    expect(result.success).toBe(true);
  });

  it('accepts a body without the optional fields', () => {
    expect(feedbackSchema.body.safeParse(base).success).toBe(true);
  });

  it('does not take the iFinder ids from the client', () => {
    const result = feedbackSchema.body.safeParse({
      ...base,
      conversationId: 'conv-from-client',
      ifinderMessageId: 'msg-from-client'
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('conversationId');
    expect(result.data).not.toHaveProperty('ifinderMessageId');
  });

  it('still rejects an invalid rating', () => {
    expect(feedbackSchema.body.safeParse({ ...base, rating: 0 }).success).toBe(false);
    expect(feedbackSchema.body.safeParse({ ...base, rating: 3.3 }).success).toBe(false);
  });
});
