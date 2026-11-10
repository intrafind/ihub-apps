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
 * model's reply, tool results — is estimated. Before the first model call, and
 * for a provider that reports no usage, the whole transcript is estimated.
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
import { estimateTokens } from '../../../shared/tokenEstimator.js';

/** Text a message puts into the prompt: its content plus the tool calls it carries. */
function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  if (typeof message.content === 'string') parts.push(message.content);
  else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (typeof part === 'string') parts.push(part);
      else if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call?.function?.name) parts.push(call.function.name);
      if (typeof call?.function?.arguments === 'string') parts.push(call.function.arguments);
    }
  }
  return parts.join(' ');
}

/**
 * Estimated tokens of a list of transcript messages (tool calls and results included).
 * @param {Array<Object>} messages
 * @returns {number}
 */
export function estimateTranscriptTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  return estimateTokens(messages.map(messageText).join('\n'));
}

/**
 * Tracker for one chat turn.
 *
 * @param {Object} model - the resolved model (`contextWindow`, `maxOutputTokens`)
 * @returns {{
 *   recordStep: (usage: Object|null|undefined, messageCount: number) => Object|null,
 *   estimate: (messages: Array<Object>) => Object|null,
 *   last: () => Object|null,
 *   replay: (answerText: string) => Object|null
 * }}
 */
export function createContextTracker(model) {
  const contextWindow = Number(model?.contextWindow) || 0;
  const maxOutputTokens = Number(model?.maxOutputTokens) || 0;
  // The last exact count: the prompt the provider counted, and how many
  // transcript messages that prompt held.
  let anchor = null;
  let latest = null;
  // The prompt the turn started from: what a later turn resends of it.
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
      if (!start || start.source !== 'provider') start = { tokens: prompt, source: 'provider' };
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
        const tokens = estimateTranscriptTokens(messages);
        if (!start) start = { tokens, source: 'estimate' };
        return state(tokens, 'estimate');
      }
      const added = estimateTranscriptTokens(messages.slice(anchor.messageCount));
      return state(anchor.tokens + added, 'provider');
    },
    last: () => latest,
    /**
     * The window as the next turn will find it: the prompt this turn started
     * from plus its answer. Tool calls and results of this turn are not in it.
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
        source: start.source
      };
    }
  };
}
