// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a caller outside the chat gets from a finished workflow run: the MCP
 * and A2A gateways, which return the answer and nothing else.
 *
 * The answer is the `output` of the workflow (`shared/workflowChatOutput.js`).
 * Text is returned as text, and JSON as JSON: a JSON answer comes in the
 * protocol's own JSON form (`structuredContent` for MCP, a `data` part for A2A)
 * as `{ "output": <the JSON> }`, next to the same JSON written out as text for
 * a client that reads only text.
 *
 * @module services/workflow/answerParts
 */
import { answerOf, chatAnswerOf, isJsonAnswer } from '../../../shared/workflowChatOutput.js';

/**
 * @typedef {Object} AnswerParts
 * @property {boolean} ok - False when the run did not finish with an answer
 * @property {string} [error] - What went wrong, when it did not
 * @property {string} [text] - The answer as text: text as it is, JSON written out
 * @property {{output: (Object|Array)}|null} [json] - The answer as JSON, or null when it is not JSON
 */

/**
 * The answer a caller gets from what `workflowRunner` resolved with.
 *
 * @param {Object|string} result - The runner's result: a finished run's
 *   `{status, executionId, output, outputText}`, a failed run's
 *   `{status, error, outputText}`, or a plain text answer
 * @returns {AnswerParts}
 */
export function workflowAnswerParts(result) {
  if (typeof result === 'string') return { ok: true, text: result, json: null };
  if (!result || result.status !== 'completed') {
    return {
      ok: false,
      error: String(result?.error || result?.outputText || 'Workflow execution failed')
    };
  }
  const answer = answerOf(result.output);
  return {
    ok: true,
    text: chatAnswerOf(result.output) ?? '',
    json: isJsonAnswer(answer) ? { output: answer } : null
  };
}
