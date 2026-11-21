// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * When the fake LLM (`stub/server.mjs`) acts as an agent.
 *
 * A turn with tools is several model calls: the model asks for a tool, iHub runs
 * it and calls the model again with the result, until the model answers. The
 * `agentTurn` scenario makes the stub do that with a marker in its message:
 *
 *   lt-tool:<name>            one round: call the tool <name> once, then answer
 *   lt-tool:<name>:<rounds>   <rounds> rounds (1 to 10), one call each
 *
 * The stub calls a tool only when the request offers it. A request without the
 * tool (a model registered without tools, an app that does not bind the
 * integration) gets the ordinary text answer, and the scenario reports the turn
 * as one without its tool rounds.
 *
 * The round is read off the request, not counted in the stub: it is the number
 * of tool results after the last user message. Two chats that run side by side
 * do not disturb each other, and a retried call gets the same answer.
 */

const MARKER = /lt-tool:([A-Za-z0-9_.-]{1,64})(?::(\d{1,2}))?/;
/** More rounds than this in one turn is a typo, not a test. */
export const MAX_TOOL_ROUNDS = 10;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text || '').join(' ');
  return '';
}

/**
 * The tool call the fake LLM answers a request with, or null for a text answer.
 *
 * @param {Object} body - The body of `POST /v1/chat/completions`
 * @returns {{name: string, round: number, rounds: number, id: string}|null}
 *
 * @example
 * toolCallFor({
 *   tools: [{ type: 'function', function: { name: 'list_scheduled_tasks' } }],
 *   messages: [{ role: 'user', content: 'What is planned? lt-tool:list_scheduled_tasks:2' }]
 * }); // { name: 'list_scheduled_tasks', round: 1, rounds: 2, id: 'call_lt_1' }
 */
export function toolCallFor(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = messages.findLastIndex(message => message?.role === 'user');
  if (lastUser < 0) return null;
  const marker = MARKER.exec(textOf(messages[lastUser].content));
  if (!marker) return null;
  const name = marker[1];
  const offered = (Array.isArray(body.tools) ? body.tools : []).some(
    tool => tool?.function?.name === name
  );
  if (!offered) return null;
  const rounds = Math.min(Math.max(Number(marker[2] || 1), 1), MAX_TOOL_ROUNDS);
  const done = messages.slice(lastUser + 1).filter(message => message?.role === 'tool').length;
  if (done >= rounds) return null;
  return { name, round: done + 1, rounds, id: `call_lt_${done + 1}` };
}

/**
 * The marker a scenario puts into its message.
 *
 * @param {string} name - The tool
 * @param {number} [rounds=1]
 * @returns {string}
 */
export const toolMarker = (name, rounds = 1) => `lt-tool:${name}:${rounds}`;
