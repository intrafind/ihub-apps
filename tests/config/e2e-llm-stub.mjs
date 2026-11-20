// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A tiny OpenAI-compatible chat endpoint for the end-to-end suites, so a chat
 * turn runs through the real server, adapter and stream without a model key.
 *
 * - `POST /v1/chat/completions` answers `E2E reply to: <last user message>
 *   (turn N)`, N being the number of user messages sent so far, streamed in
 *   word-sized chunks (or as one JSON body when `stream` is off).
 * - A last user message containing `e2e-fail` is answered with HTTP 400 (a failure the
 *   server does not retry, so the error shows at once).
 * - `GET /v1/models` lists the stub's models.
 * - `GET /__last-request` returns the body of the last chat request the stub got
 *   (`{ body }`, or `{ body: null }`), so a spec can assert what reached the model:
 *   the EU AI Act guardrail rule, a `watermarking` flag.
 *
 * ## Markers
 *
 * A marker in the **last user message** of a request makes the stub act as a
 * scripted model. A message with no marker, or with one the stub cannot read (an
 * unknown name, a script that is not registered, arguments that are not JSON),
 * gets the default reply above.
 *
 * - `e2e-slow:<ms>:<n>`: the words `slow-1` … `slow-<n>`, one every `<ms>`
 *   milliseconds (the first after `<ms>` too).
 * - `e2e-hang:<key>`: sends the first (role) chunk and then nothing, until
 *   `POST /__release/<key>` (or `POST /__release-all`); the answer then is
 *   `E2E released: <key>`. A hang nobody releases ends by itself after
 *   {@link HANG_AUTO_RELEASE_MS}, so a failed spec leaves no open socket.
 * - `e2e-tool:<name>:<json-args>`: one call of the tool `<name>` (`:<json-args>` is
 *   optional, a JSON object). Once the request carries the tool's result, the
 *   answer is `E2E tool result seen: <first 80 characters of the result>`.
 * - `e2e-tools-parallel:<a>,<b>`: the tools called in one assistant message, with
 *   empty arguments, or with those of an optional JSON array (`:[{…},{…}]`, one
 *   object per tool). Afterwards the answer is `E2E tool results seen: <count>`.
 * - `e2e-script:<name>`: a named multi-turn script from `e2e-scripts.mjs`. The turn
 *   is the one at the index "number of assistant messages in the request", never
 *   a call counter, so two chats running the same script do not disturb each other.
 *
 * A tool the request does not offer is called anyway: the server has to refuse it.
 *
 * ## For specs
 *
 * - `GET /__requests` lists the chat request bodies the stub got, oldest first
 *   (`{ items }`, at most {@link MAX_KEPT_REQUESTS}); `?marker=<text>` keeps the ones
 *   with a message that contains `<text>`. `POST /__requests` or `POST /__reset`
 *   empties the list (`/__reset` also sets the counter of `/__stats` to zero).
 * - `GET /__stats` answers `{ aborted, hanging }`: how many chat requests the caller
 *   closed before the stub had answered (the server cancelled its call to the model),
 *   and the keys of the hangs that wait for a release.
 * - `POST /__release/<key>` and `POST /__release-all` answer `{ released: <count> }`.
 *
 * ## For suites that bring their own model
 *
 * `startLlmStub(port, { script })` (the prompt-injection suite in
 * `tests/security/injection/`): `script(body)` is asked first for every chat request
 * and returns `{ content, toolCalls }` to answer with, or `null` for the markers and
 * the default reply.
 */

import http from 'node:http';
import { E2E_SCRIPTS } from './e2e-scripts.mjs';

export const STUB_MODEL_ID = 'e2e-stub-model';
/** The model id of the second stub model, the one that is offered tools. */
export const STUB_TOOLS_MODEL_ID = 'e2e-stub-tools-model';

/** After this many milliseconds a hang that nobody released ends by itself. */
export const HANG_AUTO_RELEASE_MS = 120_000;

/** The last chat request body the stub received. */
let lastRequestBody = null;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : part?.text || ''))
      .join(' ')
      .trim();
  }
  return '';
}

function replyFor(messages = []) {
  const users = messages.filter(message => message.role === 'user');
  const last = textOf(users.at(-1)?.content);
  return { last, reply: `E2E reply to: ${last} (turn ${users.length})` };
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

/** Most request bodies kept for `GET /__requests`. */
const MAX_KEPT_REQUESTS = 2000;

/** Upper bounds of `e2e-slow`, so a typo cannot keep a socket open for hours. */
const MAX_SLOW_MS = 60_000;
const MAX_SLOW_WORDS = 500;

const MARKER = /e2e-(slow|hang|tools-parallel|tool|script):(\S.*)/s;

/**
 * The JSON value a text starts with (an object or an array), or `undefined`.
 * What follows the value is ignored, so a marker can stand in a sentence.
 */
function leadingJson(text) {
  const open = text[0];
  if (open !== '{' && open !== '[') return undefined;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(0, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const TOOL_NAME = /^[A-Za-z0-9_-]+/;

/**
 * The marker of a user message (see the module comment), or `null` when the
 * message has none or it cannot be read.
 *
 * @param {string} text - The text of the last user message
 * @returns {{kind: 'slow', ms: number, count: number}
 *   | {kind: 'hang', key: string}
 *   | {kind: 'tool', parallel: boolean, calls: Array<{name: string, args: Object}>}
 *   | {kind: 'script', name: string}
 *   | null}
 *
 * @example
 * parseMarker('e2e-slow:200:5'); // { kind: 'slow', ms: 200, count: 5 }
 * parseMarker('e2e-tool:read_url:{"url":"https://example.org"}');
 * parseMarker('hello'); // null
 */
export function parseMarker(text) {
  const match = MARKER.exec(String(text || ''));
  if (!match) return null;
  const [, name, rest] = match;

  if (name === 'slow') {
    const slow = /^(\d+):(\d+)(?!\S)/.exec(rest);
    if (!slow) return null;
    const ms = Number(slow[1]);
    const count = Number(slow[2]);
    if (count < 1 || ms > MAX_SLOW_MS || count > MAX_SLOW_WORDS) return null;
    return { kind: 'slow', ms, count };
  }

  if (name === 'hang' || name === 'script') {
    const word = /^[A-Za-z0-9_.-]+(?!\S)/.exec(rest)?.[0];
    if (!word) return null;
    return name === 'hang' ? { kind: 'hang', key: word } : { kind: 'script', name: word };
  }

  if (name === 'tool') {
    const tool = TOOL_NAME.exec(rest)?.[0];
    if (!tool) return null;
    const after = rest.slice(tool.length);
    if (after === '' || /^\s/.test(after)) {
      return { kind: 'tool', parallel: false, calls: [{ name: tool, args: {} }] };
    }
    const args = after[0] === ':' ? leadingJson(after.slice(1)) : undefined;
    if (!isPlainObject(args)) return null;
    return { kind: 'tool', parallel: false, calls: [{ name: tool, args }] };
  }

  // tools-parallel
  const list = /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)+/.exec(rest)?.[0];
  if (!list) return null;
  const names = list.split(',');
  const after = rest.slice(list.length);
  let argsList = names.map(() => ({}));
  if (after !== '' && !/^\s/.test(after)) {
    const parsed = after[0] === ':' ? leadingJson(after.slice(1)) : undefined;
    if (!Array.isArray(parsed) || parsed.length !== names.length || !parsed.every(isPlainObject)) {
      return null;
    }
    argsList = parsed;
  }
  return {
    kind: 'tool',
    parallel: true,
    calls: names.map((tool, index) => ({ name: tool, args: argsList[index] }))
  };
}

/**
 * Tool calls in the stub's own answer format. The ids are fixed by the position
 * in the conversation, so the same request always gets the same ids.
 */
function toToolCalls(calls, assistantCount) {
  return calls.map((call, index) => ({
    id: call.id || `call_e2e_${assistantCount}_${index}`,
    name: call.name,
    arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.args || {})
  }));
}

/**
 * What the stub does for a request whose last user message carries a marker:
 * an answer to send (`content`, `toolCalls`), optionally paced (`slowMs`: one
 * word per interval) or held back (`hangKey`). `null` means the default reply.
 *
 * @param {Object} body - The chat request body
 * @param {Record<string, Array<Object|Function>>} [scripts] - Named scripts (see e2e-scripts.mjs)
 * @returns {{content?: string, toolCalls?: Array, slowMs?: number, hangKey?: string}|null}
 */
export function planFor(body, scripts = E2E_SCRIPTS) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
  if (lastUserIndex < 0) return null;
  const marker = parseMarker(textOf(messages[lastUserIndex].content));
  if (!marker) return null;
  const assistantCount = messages.filter(message => message.role === 'assistant').length;

  if (marker.kind === 'slow') {
    const words = Array.from({ length: marker.count }, (_, index) => `slow-${index + 1}`);
    return { content: words.join(' '), slowMs: marker.ms };
  }
  if (marker.kind === 'hang') {
    return { content: `E2E released: ${marker.key}`, hangKey: marker.key };
  }
  if (marker.kind === 'tool') {
    // Everything after the last user message belongs to this turn.
    const results = messages.slice(lastUserIndex + 1).filter(message => message.role === 'tool');
    if (results.length === 0) return { toolCalls: toToolCalls(marker.calls, assistantCount) };
    return {
      content: marker.parallel
        ? `E2E tool results seen: ${results.length}`
        : `E2E tool result seen: ${textOf(results.at(-1).content).slice(0, 80)}`
    };
  }

  const script = Object.hasOwn(scripts, marker.name) ? scripts[marker.name] : null;
  if (!Array.isArray(script)) return null;
  const entry = script[assistantCount];
  const turn = typeof entry === 'function' ? entry(body) : entry;
  if (!turn) {
    return { content: `E2E script ${marker.name}: no turn ${assistantCount + 1}` };
  }
  return {
    content: turn.content || '',
    toolCalls: toToolCalls(turn.toolCalls || [], assistantCount),
    ...(Number.isFinite(turn.slowMs) && { slowMs: turn.slowMs }),
    ...(turn.hangKey && { hangKey: String(turn.hangKey) })
  };
}

/** The fields every answer of the stub starts with. */
const BASE = { id: 'chatcmpl-e2e', created: 1, model: STUB_MODEL_ID };
const USAGE = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };

/** One streamed chunk (OpenAI chunk format). */
function writeChunk(res, delta, finish = null, extra = {}) {
  res.write(
    `data: ${JSON.stringify({
      ...BASE,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra
    })}\n\n`
  );
}

const toolCallDelta = (call, index) => ({
  tool_calls: [
    {
      index,
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    }
  ]
});

/**
 * Stream a scripted answer: text, and/or tool calls (OpenAI chunk format).
 *
 * @param {(delta: Object, finish?: string|null, extra?: Object) => void} send
 * @param {{content?: string, toolCalls?: Array<{id: string, name: string, arguments: string}>}} answer
 */
function streamScripted(send, { content = '', toolCalls = [] }) {
  send({ role: 'assistant', content: '' });
  for (const word of String(content).split(/(?<= )/)) if (word) send({ content: word });
  toolCalls.forEach((call, index) => send(toolCallDelta(call, index)));
  send({}, toolCalls.length ? 'tool_calls' : 'stop', { usage: USAGE });
}

/** A scripted answer as one JSON body (`stream` off). */
function scriptedJson({ content = '', toolCalls = [] }) {
  return JSON.stringify({
    ...BASE,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || (toolCalls.length ? null : ''),
          ...(toolCalls.length && {
            tool_calls: toolCalls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments }
            }))
          })
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
      }
    ],
    usage: USAGE
  });
}

/** Send a scripted answer at once, streamed or as JSON, and end the response. */
function sendScripted(res, body, answer) {
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(scriptedJson(answer));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  streamScripted((delta, finish, extra) => writeChunk(res, delta, finish, extra), answer);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * @param {number} port
 * @param {Object} [options]
 * @param {(body: Object) => ({content?: string, toolCalls?: Array}|null)} [options.script] -
 *   Scripted answers (see the module comment); `null` falls back to the markers and
 *   the default reply.
 * @param {Record<string, Array<Object|Function>>} [options.scripts] - The scripts
 *   `e2e-script:<name>` can name (default: the ones of e2e-scripts.mjs).
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] - The
 *   clock of `e2e-slow` and of the automatic release of a hang; a test passes its own.
 * @param {number} [options.hangAutoReleaseMs] - See {@link HANG_AUTO_RELEASE_MS}.
 * @returns {Promise<http.Server>} Listening server
 */
export function startLlmStub(
  port,
  {
    script = null,
    scripts = E2E_SCRIPTS,
    timers = { setTimeout, clearTimeout },
    hangAutoReleaseMs = HANG_AUTO_RELEASE_MS
  } = {}
) {
  /** Every chat request body, oldest first. */
  const requests = [];
  /** Chat requests the caller closed before they were answered. */
  let aborted = 0;
  /** The hangs waiting for a release: key -> the functions that end them. */
  const hangs = new Map();

  const sendJson = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  /** End the hangs of `key` (every hang without one). @returns {number} How many */
  const release = key => {
    let released = 0;
    for (const [hangKey, waiting] of [...hangs]) {
      if (key !== undefined && hangKey !== key) continue;
      hangs.delete(hangKey);
      for (const finish of waiting) {
        finish();
        released++;
      }
    }
    return released;
  };

  /**
   * Send an answer that takes time: paced (`slowMs`) and/or after a release
   * (`hangKey`). Timers stop and the hang is forgotten when the caller closes
   * the request first.
   */
  const sendOverTime = (res, body, plan) => {
    const { content = '', toolCalls = [], slowMs, hangKey } = plan;
    const pending = new Set();
    let closed = false;
    let leaveHang = () => {};
    res.on('close', () => {
      closed = true;
      for (const timer of pending) timers.clearTimeout(timer);
      pending.clear();
      leaveHang();
    });
    const wait = ms =>
      new Promise(resolve => {
        const timer = timers.setTimeout(() => {
          pending.delete(timer);
          resolve();
        }, ms);
        pending.add(timer);
      });
    const released = () =>
      new Promise(resolve => {
        const waiting = hangs.get(hangKey) || new Set();
        hangs.set(hangKey, waiting);
        let auto = null;
        const finish = () => {
          if (auto !== null) {
            timers.clearTimeout(auto);
            pending.delete(auto);
          }
          resolve();
        };
        leaveHang = () => {
          waiting.delete(finish);
          if (waiting.size === 0 && hangs.get(hangKey) === waiting) hangs.delete(hangKey);
        };
        waiting.add(finish);
        auto = timers.setTimeout(() => {
          leaveHang();
          finish();
        }, hangAutoReleaseMs);
        pending.add(auto);
      });

    const words = String(content)
      .split(/(?<= )/)
      .filter(Boolean);
    const run = async () => {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        writeChunk(res, { role: 'assistant', content: '' });
      }
      if (hangKey) await released();
      if (closed) return;
      if (!body.stream) {
        if (Number.isFinite(slowMs)) await wait(slowMs * Math.max(words.length, 1));
        if (closed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(scriptedJson({ content, toolCalls }));
        return;
      }
      for (const word of words) {
        if (Number.isFinite(slowMs)) await wait(slowMs);
        if (closed) return;
        writeChunk(res, { content: word });
      }
      toolCalls.forEach((call, index) => writeChunk(res, toolCallDelta(call, index)));
      writeChunk(res, {}, toolCalls.length ? 'tool_calls' : 'stop', { usage: USAGE });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    run();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://stub.invalid');
    if (url.pathname === '/__requests') {
      if (req.method === 'POST') requests.length = 0;
      const marker = url.searchParams.get('marker');
      const items = marker
        ? requests.filter(body =>
            (body.messages || []).some(message => textOf(message.content).includes(marker))
          )
        : requests;
      sendJson(res, 200, { items });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__reset') {
      requests.length = 0;
      aborted = 0;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__stats') {
      sendJson(res, 200, { aborted, hanging: [...hangs.keys()] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__release-all') {
      sendJson(res, 200, { released: release() });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/__release/')) {
      const key = decodeURIComponent(url.pathname.slice('/__release/'.length));
      sendJson(res, 200, { released: release(key) });
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: STUB_MODEL_ID, object: 'model' },
            { id: STUB_TOOLS_MODEL_ID, object: 'model' }
          ]
        })
      );
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/__last-request')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body: lastRequestBody }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const body = await readBody(req);
    lastRequestBody = body;
    requests.push(body);
    if (requests.length > MAX_KEPT_REQUESTS) requests.shift();
    res.on('close', () => {
      if (!res.writableFinished) aborted++;
    });

    const scripted = script ? script(body) : null;
    if (scripted) {
      sendScripted(res, body, { ...scripted, toolCalls: scripted.toolCalls || [] });
      return;
    }
    const { last, reply } = replyFor(body.messages);
    if (last.includes('e2e-fail')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'The stub model refused this request.' } }));
      return;
    }

    const plan = planFor(body, scripts);
    if (plan) {
      if (plan.hangKey || Number.isFinite(plan.slowMs)) sendOverTime(res, body, plan);
      else sendScripted(res, body, plan);
      return;
    }

    const base = { id: 'chatcmpl-e2e', created: 1, model: STUB_MODEL_ID };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
        })
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta, finish = null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra
        })}\n\n`
      );
    send({ role: 'assistant', content: '' });
    for (const word of reply.split(/(?<= )/)) send({ content: word });
    send({}, 'stop', { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
