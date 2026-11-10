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
 *   last: () => Object|null
 * }}
 */
export function createContextTracker(model) {
  const contextWindow = Number(model?.contextWindow) || 0;
  const maxOutputTokens = Number(model?.maxOutputTokens) || 0;
  // The last exact count: the prompt the provider counted, and how many
  // transcript messages that prompt held.
  let anchor = null;
  let latest = null;

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
      return state(prompt + (Number(usage.completionTokens) || 0), 'provider');
    },
    /**
     * The window as the next model call would find it.
     * @param {Array<Object>} messages - the transcript so far
     */
    estimate(messages) {
      if (!Array.isArray(messages)) return latest;
      if (!anchor) return state(estimateTranscriptTokens(messages), 'estimate');
      const added = estimateTranscriptTokens(messages.slice(anchor.messageCount));
      return state(anchor.tokens + added, 'provider');
    },
    last: () => latest
  };
}
