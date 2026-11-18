// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How full the model's context window is, as the server knows it.
 *
 * The client only sees the messages it sent and the answers it got back. A
 * turn that searches the web or reads pages fills the window with tool
 * results the client never holds, so the server — which owns the transcript —
 * reports the figure.
 *
 * The count is anchored on what the provider reports for the last model call
 * (`promptTokens`, exact). What was added to the transcript since — the
 * model's reply, tool results — is estimated. Before the first model call the
 * turn starts from the context stored with the previous answer and counts only
 * the system prompt and what came after that answer; without one (a first
 * turn, another model), and for a provider that reports no usage, the whole
 * transcript is estimated. Text whose count was stored with it (attachments,
 * project documents) is never tokenized again.
 *
 * Two figures come out of it. The live one (`estimate` / `recordStep` / `last`)
 * is the window of the call in progress, tool results included. `replay` is
 * what the *next* turn sends: later turns rebuild their prompt from the stored
 * messages (role + content), so a turn's tool calls and results are gone by
 * then. It is the first call's prompt (system prompt, history, this question)
 * plus the answer.
 *
 * @module services/loop/contextTracker
 */
import { computeContextUsage } from '../../../shared/contextUsage.js';
import {
  estimateTokens,
  estimateTokensFor,
  estimateTokensMemo,
  estimateTokensSampled,
  estimateTokensWithKnown,
  knownTokenParts,
  FULL_COUNT_MAX_CHARS
} from '../../../shared/tokenEstimator.js';

/**
 * Text a message puts into the prompt: its content plus the tool calls it
 * carries. The one definition the context figure and the compaction check
 * count by, so both find each other's count remembered on the message.
 * @param {Object} message
 * @returns {string}
 */
export function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  // The common case returns the content itself: the remembered count is then
  // found by identity, without comparing a long string.
  if (typeof message.content === 'string' && !hasCalls) return message.content;
  const parts = [];
  if (typeof message.content === 'string') parts.push(message.content);
  else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (typeof part === 'string') parts.push(part);
      else if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  if (hasCalls) {
    for (const call of message.tool_calls) {
      if (call?.function?.name) parts.push(call.function.name);
      if (typeof call?.function?.arguments === 'string') parts.push(call.function.arguments);
    }
  }
  return parts.join(' ');
}

/**
 * Estimated tokens of one message, remembered on it. Pieces whose count was
 * stored with them (an attachment, a project document; see
 * `setKnownTokenParts`) add that count and are not tokenized. A system
 * message is the same text turn after turn on a new object, so what is left of
 * it is also remembered by content.
 * @param {Object} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  const text = messageText(message);
  const parts = knownTokenParts(message);
  const count = message?.role === 'system' ? estimateTokensMemo : estimateTokens;
  if (!parts) return estimateTokensFor(message, text, count);
  return estimateTokensFor(message, text, t => estimateTokensWithKnown(t, parts, count));
}

/**
 * Estimated tokens of a list of transcript messages (tool calls and results included).
 * @param {Array<Object>} messages
 * @returns {number}
 */
export function estimateTranscriptTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * A whole transcript counted with no earlier figure to start from. Up to
 * `FULL_COUNT_MAX_CHARS` of text that has no stored count, every message is
 * counted (and remembered); above it the text is counted from samples, about
 * 5 ms however long the chat (within a few percent), so the first token of a
 * long chat is not held up by the count.
 * @param {Array<Object>} messages
 * @returns {number}
 */
function countFreshTranscript(messages) {
  let chars = 0;
  for (const m of messages) {
    if (!knownTokenParts(m)) chars += messageText(m).length;
    if (chars > FULL_COUNT_MAX_CHARS) break;
  }
  if (chars <= FULL_COUNT_MAX_CHARS) return estimateTranscriptTokens(messages);
  let known = 0;
  const texts = [];
  for (const m of messages) {
    const parts = knownTokenParts(m);
    if (parts) known += estimateMessageTokens(m);
    else texts.push(messageText(m));
  }
  return known + estimateTokensSampled(texts.join(' '));
}

/**
 * The stored context of the previous answer, if this turn can start from it:
 * it says what the model's prompt held when that answer was written (system
 * prompt, history, question, the answer), with the system prompt's share
 * (`systemTokens`). Not when it was counted for another context window (the
 * model changed) or carries no system share (stored before it was recorded).
 */
function usablePrior(prior, contextWindow) {
  if (!prior || typeof prior !== 'object') return null;
  const inputTokens = Number(prior.inputTokens);
  const systemTokens = Number(prior.systemTokens);
  if (!(inputTokens > 0) || !Number.isFinite(systemTokens) || systemTokens < 0) return null;
  if (Number(prior.contextWindow) !== contextWindow) return null;
  return { inputTokens, systemTokens };
}

const isSystem = m => m?.role === 'system';

/**
 * Tracker for one chat turn.
 *
 * Before the first model call there is no provider count yet. With the
 * previous answer's stored context (`prior`) the turn starts from it: the
 * prompt that answer was written for plus the answer is what this turn resends,
 * so only the system prompt (which may have changed) and the messages after
 * that answer are counted. Without it the whole transcript is counted.
 *
 * @param {Object} model - the resolved model (`contextWindow`, `maxOutputTokens`)
 * @param {Object} [options]
 * @param {Object|null} [options.prior] - the `context` stored with the last
 *   answer of the history this turn sends (null: no history, or a turn that
 *   continues a stored transcript)
 * @returns {{
 *   recordStep: (usage: Object|null|undefined, messageCount: number) => Object|null,
 *   estimate: (messages: Array<Object>) => Object|null,
 *   last: () => Object|null,
 *   replay: (answerText: string) => Object|null
 * }}
 */
export function createContextTracker(model, { prior = null } = {}) {
  const contextWindow = Number(model?.contextWindow) || 0;
  const maxOutputTokens = Number(model?.maxOutputTokens) || 0;
  const previous = usablePrior(prior, contextWindow);
  // Where the history the previous answer counted ends in the transcript (the
  // index of that answer), fixed by the first estimate: later steps append.
  let boundary = -1;
  // The last exact count: the prompt the provider counted, and how many
  // transcript messages that prompt held.
  let anchor = null;
  let latest = null;
  // The prompt the turn started from: what a later turn resends of it, and
  // the system prompt's share of it.
  let start = null;

  const state = (inputTokens, source) => {
    if (!contextWindow) return null;
    const usage = computeContextUsage({ contextWindow, inputTokens, maxOutputTokens });
    latest = {
      contextWindow: usage.contextWindow,
      inputTokens: usage.inputTokens,
      maxOutputTokens: usage.maxOutputTokens,
      source
    };
    return latest;
  };

  /** The transcript before any provider count: see the tracker's description. */
  const unanchored = messages => {
    const system = messages.filter(isSystem);
    const systemTokens = estimateTranscriptTokens(system);
    if (!start && previous) boundary = messages.findLastIndex(m => m?.role === 'assistant');
    const body =
      previous && boundary >= 0
        ? previous.inputTokens -
          previous.systemTokens +
          estimateTranscriptTokens(messages.slice(boundary + 1).filter(m => !isSystem(m)))
        : countFreshTranscript(messages.filter(m => !isSystem(m)));
    return { tokens: Math.max(0, systemTokens + body), systemTokens };
  };

  return {
    /**
     * A model call finished. Its reply joins the context, so the window holds
     * the prompt the provider counted plus what it answered.
     * @param {Object|null|undefined} usage - the call's normalized usage
     * @param {number} messageCount - transcript messages in that call's prompt
     */
    recordStep(usage, messageCount) {
      const prompt = Number(usage?.promptTokens) || 0;
      if (usage?.source === 'estimate' || prompt <= 0) return latest;
      anchor = { tokens: prompt, messageCount };
      // The first call the provider counted is the turn's start, even when the
      // pre-call estimate stood in for it until now.
      if (!start || start.source !== 'provider') {
        start = { tokens: prompt, source: 'provider', systemTokens: start?.systemTokens };
      }
      // Reasoning tokens are part of `completionTokens` but never of the
      // transcript: the reply that joins the context is the visible output.
      const reasoning = Number(usage.reasoningTokens) || 0;
      const reply = Math.max(0, (Number(usage.completionTokens) || 0) - reasoning);
      return state(prompt + reply, 'provider');
    },
    /**
     * The window as the next model call would find it.
     * @param {Array<Object>} messages - the transcript so far
     */
    estimate(messages) {
      if (!Array.isArray(messages)) return latest;
      if (!anchor) {
        const { tokens, systemTokens } = unanchored(messages);
        if (!start) start = { tokens, source: 'estimate', systemTokens };
        return state(tokens, 'estimate');
      }
      const added = estimateTranscriptTokens(messages.slice(anchor.messageCount));
      return state(anchor.tokens + added, 'provider');
    },
    last: () => latest,
    /**
     * The window as the next turn will find it: the prompt this turn started
     * from plus its answer, and the system prompt's share of it (what the next
     * turn replaces with its own). Tool calls and results of this turn are not
     * in it.
     * @param {string} answerText - the answer stored with the turn
     * @returns {Object|null}
     */
    replay(answerText) {
      if (!contextWindow || !start) return null;
      const answer = typeof answerText === 'string' ? estimateTokens(answerText) : 0;
      return {
        contextWindow,
        inputTokens: start.tokens + answer,
        maxOutputTokens,
        source: start.source,
        ...(Number.isFinite(start.systemTokens) ? { systemTokens: start.systemTokens } : {})
      };
    }
  };
}
