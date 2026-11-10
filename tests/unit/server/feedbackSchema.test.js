// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import { feedbackSchema } from '../../../server/validators/index.js';

const base = { messageId: 'msg-1', appId: 'chat', chatId: 'c1', rating: 4 };

describe('feedbackSchema', () => {
  it('accepts null for the optional iAssistant fields the client sends for ordinary messages', () => {
    const result = feedbackSchema.body.safeParse({
      ...base,
      modelId: 'gpt-4o',
      feedback: '',
      messageContent: 'hello',
      conversationId: null,
      ifinderMessageId: null
    });
    expect(result.success).toBe(true);
  });

  it('accepts a body without the optional fields', () => {
    expect(feedbackSchema.body.safeParse(base).success).toBe(true);
  });

  it('still rejects an invalid rating', () => {
    expect(feedbackSchema.body.safeParse({ ...base, rating: 0 }).success).toBe(false);
    expect(feedbackSchema.body.safeParse({ ...base, rating: 3.3 }).success).toBe(false);
  });
});
