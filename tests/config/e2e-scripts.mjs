// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The named scripts of the model stub (`e2e-llm-stub.mjs`): a user message that
 * contains `e2e-script:<name>` is answered from the script `<name>`.
 *
 * A script is a list of turns. The stub answers with the turn at the index
 * "number of assistant messages in the request": turn 0 answers a request with no
 * assistant message yet, turn 1 the request that follows it, and so on. No counter
 * is kept, so two chats that run the same script at the same time do not disturb
 * each other, and a server that repeats a request gets the same answer again.
 *
 * A turn is an object, or a function `(body) => turn` that reads the request:
 *
 * - `content`: the text of the answer.
 * - `toolCalls`: `[{ name, args }]`, the tools the model calls in this turn. A turn
 *   with tool calls is followed by the next turn once the server sends the results;
 *   a turn without ends the answer, and the next turn is reached only when the user
 *   sends the marker again in the same chat.
 * - `slowMs`: send the text one word every `slowMs` milliseconds.
 * - `hangKey`: hold the answer until `POST /__release/<hangKey>` on the stub.
 *
 * A request past the last turn is answered with `E2E script <name>: no turn <n>`,
 * which a spec sees in the chat.
 *
 * To add a script: add an entry here and name the spec that uses it.
 */

/** A turn that answers with text. */
export const say = (content, extra = {}) => ({ content, ...extra });

/** A turn that calls tools: `callTools({ name: 'read_url', args: { url } })`. */
export const callTools = (...toolCalls) => ({ toolCalls });

/** @type {Record<string, Array<Object|Function>>} */
export const E2E_SCRIPTS = {
  // The smallest script, for the stub's own test and as a pattern: send the marker
  // twice in one chat to see both turns.
  'two-step': [say('E2E script two-step: step 1'), say('E2E script two-step: step 2')]
};
