// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Context compaction primitives for the agentic loop (pure functions).
 *
 * - `microcompactMessages` collapses the content of old, bulky `tool` /
 *   `assistant` messages into short placeholders while keeping the last
 *   `keepRecent` messages verbatim and never touching system/user prompts.
 * - `compactIfOversized` runs it only when the estimated prompt size exceeds a
 *   threshold (the O(N²) prompt-growth fix); under the threshold it returns the
 *   same array reference.
 * - `elideRetriedCallArguments` shortens the arguments of a failed tool call
 *   once the model has called that tool again: only the newest attempt is
 *   replayed in full.
 * - `isContextOverflowError` recognizes a provider "prompt too long" failure,
 *   preferring the canonical `LLMError` code and falling back to message
 *   heuristics for legacy error objects.
 *
 * @module services/loop/contextCompaction
 */
import { estimateTokens } from '../../../shared/tokenEstimator.js';
import { estimateTranscriptTokens } from './contextTracker.js';
import { isLLMError } from './contracts/errors.js';
import { classifyToolResult } from './toolClassify.js';

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

/** Arguments shorter than this are replayed as sent, failed or not. */
const RETRIED_MIN_CHARS = 1000;
/** An argument value longer than this is replaced in a retried call. */
const RETRIED_VALUE_CHARS = 200;

/** The arguments with each long value replaced by a note; null when none is long. */
function elidedArguments(text) {
  const note = n => `[${n} characters left out: this call failed and was sent again]`;
  let args;
  try {
    args = JSON.parse(text);
  } catch {
    return JSON.stringify({ note: note(text.length) });
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return JSON.stringify({ note: note(text.length) });
  }
  const out = {};
  let replaced = false;
  for (const [key, value] of Object.entries(args)) {
    const valueText = typeof value === 'string' ? value : JSON.stringify(value);
    if (valueText && valueText.length > RETRIED_VALUE_CHARS) {
      out[key] = note(valueText.length);
      replaced = true;
    } else {
      out[key] = value;
    }
  }
  return replaced ? JSON.stringify(out) : null;
}

/**
 * Shorten the arguments of failed tool calls the model has since sent again.
 *
 * A model that gets an error back resends the call, often with thousands of
 * characters of arguments (a workbook's sheets, a deck's slides). Replayed in
 * full, every attempt stays in the prompt: three tries at 5,000 characters
 * filled a 60k window (intrafind/ihub-apps#3831). Once a later assistant
 * message calls the same tool, an earlier call whose result was an error
 * keeps its short arguments (a filename, a title) and each long value becomes
 * a note of its length. The error it got stays, so the model still knows what
 * went wrong; the newest attempt is never touched, so it can be fixed from
 * what it sent.
 *
 * Pure: returns new message objects for what changed, the same array when
 * nothing did.
 *
 * @param {Array<Object>} messages
 * @returns {{ messages: Array<Object>, freedChars: number, collapsed: number }}
 */
export function elideRetriedCallArguments(messages) {
  const unchanged = { messages, freedChars: 0, collapsed: 0 };
  if (!Array.isArray(messages) || messages.length === 0) return unchanged;
  const lastCallAt = new Map();
  messages.forEach((message, index) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return;
    for (const call of message.tool_calls) {
      if (call?.function?.name) lastCallAt.set(call.function.name, index);
    }
  });
  // Calls with long arguments the model has called again since; only their
  // results are read, so a long transcript is not parsed on every step.
  const candidates = new Set();
  messages.forEach((message, index) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return;
    for (const call of message.tool_calls) {
      const text = call?.function?.arguments;
      if (
        call?.id &&
        typeof text === 'string' &&
        text.length >= RETRIED_MIN_CHARS &&
        lastCallAt.get(call.function.name) > index
      ) {
        candidates.add(call.id);
      }
    }
  });
  if (candidates.size === 0) return unchanged;
  const failed = new Set();
  for (const message of messages) {
    if (
      message?.role === 'tool' &&
      candidates.has(message.tool_call_id) &&
      classifyToolResult(message).failed
    ) {
      failed.add(message.tool_call_id);
    }
  }
  if (failed.size === 0) return unchanged;

  let freedChars = 0;
  let collapsed = 0;
  const out = messages.map(message => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
    let changed = false;
    const calls = message.tool_calls.map(call => {
      if (!failed.has(call?.id)) return call;
      const text = call.function.arguments;
      const shorter = elidedArguments(text);
      if (shorter === null || shorter.length >= text.length) return call;
      changed = true;
      collapsed += 1;
      freedChars += text.length - shorter.length;
      return { ...call, function: { ...call.function, arguments: shorter } };
    });
    return changed ? { ...message, tool_calls: calls } : message;
  });
  return collapsed ? { messages: out, freedChars, collapsed } : unchanged;
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
