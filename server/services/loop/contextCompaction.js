/**
 * Context compaction primitives for the agentic loop (pure functions).
 *
 * - `microcompactMessages` collapses the content of old, bulky `tool` /
 *   `assistant` messages into short placeholders while keeping the last
 *   `keepRecent` messages verbatim and never touching system/user prompts.
 * - `compactIfOversized` runs it only when the estimated prompt size exceeds a
 *   threshold (the O(N²) prompt-growth fix); under the threshold it returns the
 *   same array reference.
 * - `isContextOverflowError` recognizes a provider "prompt too long" failure,
 *   preferring the canonical `LLMError` code and falling back to message
 *   heuristics for legacy error objects.
 *
 * @module services/loop/contextCompaction
 */
import { estimateTokens } from '../../../shared/tokenEstimator.js';
import { isLLMError } from './contracts/errors.js';

export function microcompactMessages(messages, opts = {}) {
  const keepRecent = opts.keepRecent ?? 4;
  const maxChars = opts.maxChars ?? 2000;
  if (!Array.isArray(messages) || messages.length <= keepRecent) {
    return { messages, freedChars: 0, collapsed: 0 };
  }
  const cutoff = messages.length - keepRecent;
  let freedChars = 0;
  let collapsed = 0;
  const out = messages.map((msg, i) => {
    if (i >= cutoff) return msg;
    if (!msg || typeof msg.content !== 'string') return msg;
    const isCompactable = msg.role === 'tool' || msg.role === 'assistant';
    if (!isCompactable || msg.content.length <= maxChars) return msg;
    freedChars += msg.content.length;
    collapsed += 1;
    const head = msg.content.slice(0, 200).replace(/\s+/g, ' ');
    return {
      ...msg,
      content: `[older ${msg.role} output elided to save context — ${msg.content.length} chars. Preview: ${head}…]`
    };
  });
  return { messages: out, freedChars, collapsed };
}

export function estimateMessagesTokens(messages) {
  const totalText = (Array.isArray(messages) ? messages : [])
    .map(m => (typeof m?.content === 'string' ? m.content : ''))
    .join(' ');
  return estimateTokens(totalText);
}

export function compactIfOversized(messages, opts = {}) {
  const thresholdTokens = opts.thresholdTokens ?? 16000;
  const keepRecent = opts.keepRecent ?? 6;
  const maxChars = opts.maxChars ?? 2000;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, freedChars: 0, collapsed: 0, compacted: false };
  }
  if (estimateMessagesTokens(messages) <= thresholdTokens) {
    return { messages, freedChars: 0, collapsed: 0, compacted: false };
  }
  const result = microcompactMessages(messages, { keepRecent, maxChars });
  return { ...result, compacted: result.collapsed > 0 };
}

const OVERFLOW_SIGNALS = [
  'context length',
  'context window',
  'maximum context',
  'too long',
  'prompt is too long',
  'context_length_exceeded',
  'reduce the length',
  'too many tokens',
  'exceeds the maximum'
];

export function isContextOverflowError(err) {
  if (!err) return false;
  if (isLLMError(err) && err.isContextWindowError) return true;
  const status = err.status || err.httpStatus;
  if (status === 413) return true;
  const haystack = `${err.message || ''} ${err.details || ''} ${err.code || ''}`.toLowerCase();
  const looksLikeOverflow = OVERFLOW_SIGNALS.some(s => haystack.includes(s));
  return (
    looksLikeOverflow &&
    (status === undefined || status === null || (status >= 400 && status < 500))
  );
}

export { estimateTokens };
