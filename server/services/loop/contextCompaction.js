// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Context compaction primitives for the agentic loop (pure functions).
 *
 * - `microcompactMessages` collapses the content of old, bulky `tool` /
 *   `assistant` messages into short placeholders while keeping the last
 *   `keepRecent` messages verbatim and never touching system/user prompts or
 *   a condensed result (a findings digest, `findingsDigest.js`). What it
 *   collapses is lost: the loop uses it as the lossy path (`lossy: true`).
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
import { estimateTranscriptTokens } from './contextTracker.js';
import { isLLMError } from './contracts/errors.js';
import { isCondensedContent } from './findingsDigest.js';

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
    // A condensed result holds a findings digest: what the model learned from
    // results that are gone from the transcript already (#3819).
    if (isCondensedContent(msg.content)) return msg;
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

/** Whether a tool result says its call failed (`{ success: false }`, `{ error }`, "Error: …"). */
function isFailedResult(content) {
  const text = String(content ?? '').trim();
  if (/^error\b/i.test(text)) return true;
  if (!text.startsWith('{')) return false;
  try {
    const value = JSON.parse(text);
    return value?.success === false || (value?.error != null && value?.success !== true);
  } catch {
    return false;
  }
}

/**
 * The arguments of failed tool calls, shortened: a last way to free context
 * when the results are condensed already and a model resent a long call that
 * was refused (a workbook whose JSON did not parse, three times). The newest
 * failed call keeps its arguments, so the model can see what it sent last;
 * its error stays in its result.
 *
 * @param {Array<Object>} messages
 * @param {{maxArgsChars?: number}} [opts]
 * @returns {{messages: Array<Object>, freedChars: number, shortened: number}}
 */
export function shrinkFailedToolCalls(messages, opts = {}) {
  const maxArgsChars = opts.maxArgsChars ?? 1000;
  if (!Array.isArray(messages)) return { messages, freedChars: 0, shortened: 0 };
  const failed = new Set(
    messages
      .filter(m => m?.role === 'tool' && m.tool_call_id && isFailedResult(m.content))
      .map(m => m.tool_call_id)
  );
  // The newest failed call with long arguments keeps them.
  let newest = null;
  for (const message of messages) {
    for (const call of message?.role === 'assistant' ? message.tool_calls || [] : []) {
      if (failed.has(call?.id) && String(call.function?.arguments ?? '').length > maxArgsChars) {
        newest = call.id;
      }
    }
  }
  let freedChars = 0;
  let shortened = 0;
  const out = messages.map(message => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
    let changed = false;
    const calls = message.tool_calls.map(call => {
      const args = String(call?.function?.arguments ?? '');
      if (!failed.has(call?.id) || call.id === newest || args.length <= maxArgsChars) return call;
      const replacement = JSON.stringify({
        omitted: `the arguments of this failed call (${args.length} characters) were removed to free context; its error is in its result`
      });
      freedChars += args.length - replacement.length;
      shortened += 1;
      changed = true;
      return { ...call, function: { ...call.function, arguments: replacement } };
    });
    return changed ? { ...message, tool_calls: calls } : message;
  });
  return { messages: out, freedChars, shortened };
}

/**
 * Per message, remembered on the message, counted like the context figure
 * (`contextTracker.messageText`): the transcript is counted after every step
 * and only its newest messages are new.
 */
export function estimateMessagesTokens(messages) {
  return estimateTranscriptTokens(messages);
}

/**
 * Collapse old bulky messages when the transcript is over `thresholdTokens`.
 * `opts.knownTokens` is what the caller already knows the prompt to hold (the
 * provider's count of the last call plus what was added since); at or under
 * the threshold the messages are then not counted at all. Over it, the
 * messages are counted to decide, as without it: the provider's figure also
 * holds the tool definitions, which the threshold does not.
 */
export function compactIfOversized(messages, opts = {}) {
  const thresholdTokens = opts.thresholdTokens ?? 16000;
  const keepRecent = opts.keepRecent ?? 6;
  const maxChars = opts.maxChars ?? 2000;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, freedChars: 0, collapsed: 0, compacted: false };
  }
  const known = Number(opts.knownTokens);
  if (
    (Number.isFinite(known) && known > 0 && known <= thresholdTokens) ||
    estimateMessagesTokens(messages) <= thresholdTokens
  ) {
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
