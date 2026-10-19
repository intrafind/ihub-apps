import { renderHook, waitFor } from '@testing-library/react';

/**
 * The tokenizer chunk is ~1 MB gzipped. The chat input estimates tokens as soon
 * as it mounts, so loading the tokenizer for every estimate put it on the
 * network whenever a chat page opened. Small texts now use the chars/4
 * heuristic; the tokenizer is only loaded once a count is large enough for the
 * difference to matter.
 */

const mockTokenizer = { loads: 0 };

jest.mock('gpt-tokenizer', () => {
  mockTokenizer.loads += 1;
  // One token per character, so a refined count is easy to tell apart from
  // the chars/4 heuristic.
  return { countTokens: text => text.length };
});

import { useEstimatedTokenCount } from '../../../client/src/shared/hooks/useEstimatedTokenCount.js';
import { ACCURATE_ESTIMATE_MIN_TOKENS } from '../../../client/src/shared/utils/tokenEstimatorClient.js';

describe('useEstimatedTokenCount tokenizer loading', () => {
  it('estimates small texts without loading the tokenizer', async () => {
    const { result } = renderHook(() => useEstimatedTokenCount('a short system prompt'));
    await waitFor(() => expect(result.current).toBe(Math.ceil('a short system prompt'.length / 4)));
    expect(mockTokenizer.loads).toBe(0);
  });

  it('loads the tokenizer and refines the count for large texts', async () => {
    const text = 'x'.repeat(ACCURATE_ESTIMATE_MIN_TOKENS * 4);
    const { result } = renderHook(() => useEstimatedTokenCount(text));
    await waitFor(() => expect(result.current).toBe(text.length));
    expect(mockTokenizer.loads).toBe(1);
  });
});
