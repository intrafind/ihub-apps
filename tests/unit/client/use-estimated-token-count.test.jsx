import { renderHook, waitFor } from '@testing-library/react';
import {
  useEstimatedTokenCount,
  useEstimatedTokensForFragments
} from '../../../client/src/shared/hooks/useEstimatedTokenCount.js';

/**
 * The token-count hooks back the context-window indicator. Both share the same
 * lazy-tokenizer + debounce machinery, so both are exercised here: the text
 * hook for the pending message, the fragments hook for the system prompt and
 * the full chat history (issue #2283).
 */
describe('useEstimatedTokenCount', () => {
  it('reports a count for text once the tokenizer resolves', async () => {
    const { result } = renderHook(() => useEstimatedTokenCount('hello world, how are you?'));
    await waitFor(() => expect(result.current).toBeGreaterThan(0));
  });

  it('stays at zero for empty text', async () => {
    const { result } = renderHook(() => useEstimatedTokenCount(''));
    await waitFor(() => expect(result.current).toBe(0));
  });

  it('recomputes when the text changes', async () => {
    const { result, rerender } = renderHook(({ text }) => useEstimatedTokenCount(text), {
      initialProps: { text: 'short' }
    });
    await waitFor(() => expect(result.current).toBeGreaterThan(0));
    const short = result.current;

    rerender({ text: 'a considerably longer piece of text than the first one was' });
    await waitFor(() => expect(result.current).toBeGreaterThan(short));
  });
});

describe('useEstimatedTokensForFragments', () => {
  it('sums every fragment of the conversation', async () => {
    const { result } = renderHook(() =>
      useEstimatedTokensForFragments(['first question', 'first answer', 'second question'])
    );
    await waitFor(() => expect(result.current).toBeGreaterThan(3));
  });

  it('grows when a turn is appended', async () => {
    const first = ['question one', 'answer one'];
    const { result, rerender } = renderHook(
      ({ fragments }) => useEstimatedTokensForFragments(fragments),
      { initialProps: { fragments: first } }
    );
    await waitFor(() => expect(result.current).toBeGreaterThan(0));
    const before = result.current;

    rerender({ fragments: [...first, 'question two', 'answer two'] });
    await waitFor(() => expect(result.current).toBeGreaterThan(before));
  });

  it('drops back to zero when history is excluded', async () => {
    const { result, rerender } = renderHook(
      ({ fragments }) => useEstimatedTokensForFragments(fragments),
      { initialProps: { fragments: ['question one', 'answer one'] } }
    );
    await waitFor(() => expect(result.current).toBeGreaterThan(0));

    rerender({ fragments: [] });
    await waitFor(() => expect(result.current).toBe(0));
  });

  it('honours the debounce before reporting', async () => {
    const { result } = renderHook(() =>
      useEstimatedTokensForFragments(['a debounced fragment'], { debounceMs: 50 })
    );
    expect(result.current).toBe(0);
    await waitFor(() => expect(result.current).toBeGreaterThan(0));
  });
});
