// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where an answer that hit the output limit ran out: thinking that used it
 * all, or an answer cut off. Decided from the final model call's own usage.
 */

import { limitReachedIn } from '../services/chat/outputLimit.js';

describe('limitReachedIn', () => {
  test('nothing when the turn did not hit the limit', () => {
    expect(
      limitReachedIn({
        finishReason: 'stop',
        answerText: '',
        stepUsage: { completionTokens: 32768, reasoningTokens: 32768 }
      })
    ).toBeUndefined();
  });

  test('reasoning: the whole completion was thinking and no answer was written', () => {
    expect(
      limitReachedIn({
        finishReason: 'length',
        answerText: '',
        stepUsage: { completionTokens: 32768, reasoningTokens: 32768 }
      })
    ).toBe('reasoning');
  });

  test('answer: text was written before the limit', () => {
    expect(
      limitReachedIn({
        finishReason: 'length',
        answerText: 'Here are the jokes',
        stepUsage: { completionTokens: 32768, reasoningTokens: 30000 }
      })
    ).toBe('answer');
  });

  test('unknown: no answer, but the provider did not report reasoning tokens', () => {
    expect(
      limitReachedIn({
        finishReason: 'length',
        answerText: '  ',
        stepUsage: { completionTokens: 32768 }
      })
    ).toBeUndefined();
    expect(limitReachedIn({ finishReason: 'length', answerText: '' })).toBeUndefined();
  });

  test('unknown: no answer and most of the completion was not thinking (a tool call)', () => {
    expect(
      limitReachedIn({
        finishReason: 'length',
        answerText: '',
        stepUsage: { completionTokens: 32768, reasoningTokens: 1000 }
      })
    ).toBeUndefined();
  });
});
