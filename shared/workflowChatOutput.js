// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The answer of a workflow run, shared by the server (the chat runner, the
 * MCP and A2A gateways, the handoff of an execution to a chat) and the client
 * (the execution pages).
 *
 * Every end step has an `output` (`EndNodeExecutor`), and that is the answer: a
 * chat shows it as it is, and so does an API, MCP or A2A caller. Whatever else
 * the end step passes on is additional information next to it.
 *
 * The answer keeps its type. Text is text, and JSON (an object or a list) stays
 * JSON: it is handed on as a JSON value (`answerOf`) and only turned into text
 * where text is all there is, which is a chat bubble (`chatAnswerOf`), shown
 * there as a JSON block (`chatAnswerFormat`).
 *
 * @module shared/workflowChatOutput
 */

/**
 * The answer a workflow's output gives, as the value it is: text, JSON (an
 * object or a list), a number or a boolean. Null when it gives none.
 *
 * The output is the end step's output object, and its `output` is the answer.
 * Anything that is not an object, such as the output a run was stored with
 * before an end step kept its answer in `output`, is the answer itself.
 *
 * @param {*} output - What the workflow finished with (`finalOutputOf()`)
 * @returns {*} The answer; null for no answer
 */
export function answerOf(output) {
  if (output === null || output === undefined || output === '') return null;
  const answer = typeof output === 'object' && !Array.isArray(output) ? output.output : output;
  return answer === null || answer === undefined || answer === '' ? null : answer;
}

/**
 * Whether an answer is JSON, an object or a list, rather than text or a scalar.
 *
 * @param {*} answer - A value from `answerOf()`
 * @returns {boolean}
 */
export function isJsonAnswer(answer) {
  return answer !== null && typeof answer === 'object';
}

/**
 * The answer as text for a chat bubble, or null when there is none. Text is
 * text as it is; JSON is written out, because a bubble holds nothing else.
 *
 * @param {*} output - What the workflow finished with (`finalOutputOf()`)
 * @returns {string|null}
 */
export function chatAnswerOf(output) {
  const answer = answerOf(output);
  if (answer === null) return null;
  if (typeof answer === 'string') return answer;
  return isJsonAnswer(answer) ? JSON.stringify(answer, null, 2) : String(answer);
}

/**
 * The format a chat shows the answer in: JSON as a JSON block, whatever format
 * the workflow asks for, and everything else in the format it asks for.
 *
 * @param {*} output - What the workflow finished with (`finalOutputOf()`)
 * @param {string} [format] - The workflow's output format (`markdown`, `text`, `json`)
 * @returns {string}
 */
export function chatAnswerFormat(output, format = 'markdown') {
  return isJsonAnswer(answerOf(output)) ? 'json' : format;
}

/**
 * What a finished execution ended with: the output of the end step it finished at.
 *
 * @param {Object} state - Execution state (`WorkflowEngine.getState`)
 * @returns {*} The output; undefined when the run finished nowhere
 */
export function executionOutputOf(state) {
  const completed = state?.completedNodes;
  const lastNodeId = Array.isArray(completed) ? completed[completed.length - 1] : undefined;
  return state?.data?.nodeResults?.[lastNodeId]?.output;
}

/**
 * The answer of a finished execution as text, from the end step it finished at.
 *
 * @param {Object} state - Execution state (`WorkflowEngine.getState`)
 * @returns {string|null}
 */
export function executionAnswerOf(state) {
  return chatAnswerOf(executionOutputOf(state));
}
