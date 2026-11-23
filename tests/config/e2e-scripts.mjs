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

/** The text of the last user message of a request body. */
function lastUserText(body) {
  const users = (body?.messages || []).filter(message => message.role === 'user');
  const content = users.at(-1)?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.map(part => (typeof part === 'string' ? part : part?.text || '')).join(' ')
    : '';
}

/**
 * The first turn of `hold-then-call`, read from the user message
 * `e2e-script:hold-then-call hold=<key> tool=<name> args=<json>`: one call of the
 * tool `<name>` with the JSON object `<json>` (to the end of the message), sent only
 * after `POST /__release/<key>`. A message it cannot read gets a text that says so.
 *
 * @param {Object} body - The chat request
 * @returns {Object} A turn
 */
export function holdThenCall(body) {
  return callFrom(lastUserText(body), 'hold-then-call', { hold: true });
}

/**
 * The call of a `hold=<key> tool=<name> args=<json>` message, held until the
 * release of `<key>` when `hold` is set; a message it cannot read gets a text
 * that says so.
 *
 * @param {string} text - The user message with the marker
 * @param {string} name - The script, for the text of a message it cannot read
 * @param {{hold: boolean}} options
 * @returns {Object} A turn
 */
function callFrom(text, name, { hold: held }) {
  const hold = /\bhold=([\w-]+)/.exec(text)?.[1];
  const tool = /\btool=([\w-]+)/.exec(text)?.[1];
  const at = text.indexOf(' args=');
  let args = null;
  try {
    args = at === -1 ? {} : JSON.parse(text.slice(at + ' args='.length).trim());
  } catch {
    args = null;
  }
  if (!hold || !tool || !args || typeof args !== 'object' || Array.isArray(args)) {
    return say(`E2E script ${name}: needs hold=<key> tool=<name> args=<json>`);
  }
  return { ...callTools({ name: tool, args }), ...(held ? { hangKey: hold } : {}) };
}

/** The text of the user message that named the script `name`, or ''. */
function scriptMessageText(body, name) {
  const marker = `e2e-script:${name}`;
  const users = (body?.messages || []).filter(message => message.role === 'user');
  for (let i = users.length - 1; i >= 0; i--) {
    const content = users[i].content;
    const text =
      typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content : [])
            .map(part => (typeof part === 'string' ? part : part?.text || ''))
            .join(' ');
    if (text.includes(marker)) return text;
  }
  return '';
}

/**
 * The second turn of `steer-two-steps`: the same call again, at once, read from
 * the message that named the script (the last user message is now the one the
 * person sent into the running answer).
 *
 * @param {Object} body - The chat request
 * @returns {Object} A turn
 */
export function callAgain(body) {
  return callFrom(scriptMessageText(body, 'steer-two-steps'), 'steer-two-steps', {
    hold: false
  });
}

/**
 * The scripts that go on past a message the person sent into the running answer
 * (a user message that starts with `[steer]`): such a request is answered from
 * the script the user message before it named, by the same turn count. Every
 * other script answers such a request with the default reply, which shows the
 * message as the model got it.
 */
export const SCRIPTS_THROUGH_STEERS = new Set(['steer-two-steps']);

/** @type {Record<string, Array<Object|Function>>} */
export const E2E_SCRIPTS = {
  // The smallest script, for the stub's own test and as a pattern: send the marker
  // twice in one chat to see both turns.
  'two-step': [say('E2E script two-step: step 1'), say('E2E script two-step: step 2')],
  // A tool call that comes only when the spec releases it, so the page can be busy
  // with something else when the call (an approval, a question) arrives.
  // tests/e2e-agents/focus-policy.spec.js.
  'hold-then-call': [holdThenCall, say('E2E script hold-then-call: done')],
  // A held tool call at step 1, the same call again at step 2, then the answer: a
  // message sent while step 1 is held is read at step 2, between the two calls.
  // It goes on past that message (SCRIPTS_THROUGH_STEERS). tests/e2e-agents/steer.spec.js.
  'steer-two-steps': [holdThenCall, callAgain, say('E2E script steer-two-steps: done')]
};
