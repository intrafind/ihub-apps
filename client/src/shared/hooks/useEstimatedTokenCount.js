import { useEffect, useState } from 'react';
import { ensureTokenizer, estimateTokensSync } from '../utils/tokenEstimatorClient.js';

/**
 * Estimate the token count of a piece of text, lazily loading the tokenizer
 * chunk and optionally debouncing recomputation so we don't tokenize on every
 * keystroke.
 *
 * Returns 0 until the first computation completes. Once the tokenizer chunk is
 * loaded the count refines automatically (initial renders may use the chars/4
 * heuristic fallback).
 *
 * @param {string} text - text to estimate
 * @param {{ debounceMs?: number }} [options]
 * @returns {number} estimated token count
 */
export function useEstimatedTokenCount(text, { debounceMs = 0 } = {}) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const compute = () =>
      ensureTokenizer().then(() => {
        if (!cancelled) setCount(estimateTokensSync(text));
      });

    if (debounceMs > 0) {
      const handle = setTimeout(compute, debounceMs);
      return () => {
        cancelled = true;
        clearTimeout(handle);
      };
    }

    compute();
    return () => {
      cancelled = true;
    };
  }, [text, debounceMs]);

  return count;
}
