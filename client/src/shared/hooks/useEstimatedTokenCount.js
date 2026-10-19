// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import {
  ensureTokenizer,
  estimateTokensForFragmentsSync,
  estimateTokensSync,
  shouldLoadTokenizer
} from '../utils/tokenEstimatorClient.js';

/**
 * Shared machinery for the two token-count hooks: run `estimate()` with the
 * implementation at hand (the chars/4 heuristic until the tokenizer chunk is
 * loaded) and, when the count is large enough to matter, load the tokenizer
 * and refine it — optionally debounced, and always cancelled on unmount /
 * dependency change so a late resolve can't write a stale count.
 *
 * @param {() => number} estimate - reads the latest inputs when it runs
 * @param {*} dependency - identity that triggers recomputation
 * @param {number} debounceMs
 * @returns {number}
 */
function useLazyTokenCount(estimate, dependency, debounceMs) {
  const [count, setCount] = useState(0);
  const estimateRef = useRef(estimate);
  estimateRef.current = estimate;

  useEffect(() => {
    let cancelled = false;
    const compute = () => {
      // Tokenize once; only a freshly loaded tokenizer needs a second pass.
      const estimate = estimateRef.current();
      const counted = shouldLoadTokenizer(estimate)
        ? ensureTokenizer().then(() => estimateRef.current())
        : Promise.resolve(estimate);
      counted.then(value => {
        if (!cancelled) setCount(value);
      });
    };

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
  }, [dependency, debounceMs]);

  return count;
}

/**
 * Estimate the token count of a piece of text, lazily loading the tokenizer
 * chunk and optionally debouncing recomputation so we don't tokenize on every
 * keystroke.
 *
 * Returns 0 until the first computation completes. Small texts use the chars/4
 * heuristic; once a count is large enough to matter the tokenizer chunk is
 * loaded and the count refines automatically.
 *
 * @param {string} text - text to estimate
 * @param {{ debounceMs?: number }} [options]
 * @returns {number} estimated token count
 */
export function useEstimatedTokenCount(text, { debounceMs = 0 } = {}) {
  return useLazyTokenCount(() => estimateTokensSync(text), text, debounceMs);
}

/**
 * Estimate the combined token count of several text fragments (system prompt,
 * chat history, attached document text). Per-fragment counts are memoized, so
 * appending one message to a long conversation only tokenizes the new text.
 *
 * Recomputes when the `fragments` array identity changes — memoize it in the
 * caller (`useMemo`) so a re-render alone doesn't retrigger the estimate.
 *
 * @param {Array<string>} fragments
 * @param {{ debounceMs?: number }} [options]
 * @returns {number} estimated token count
 */
export function useEstimatedTokensForFragments(fragments, { debounceMs = 0 } = {}) {
  return useLazyTokenCount(() => estimateTokensForFragmentsSync(fragments), fragments, debounceMs);
}
