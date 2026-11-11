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
 * - `GET /v1/models` lists the one model.
 * - `GET /__last-request` returns the body of the last chat request the stub got
 *   (`{ body }`, or `{ body: null }`), so a spec can assert what reached the model:
 *   the EU AI Act guardrail rule, a `watermarking` flag.
 */

import http from 'node:http';

export const STUB_MODEL_ID = 'e2e-stub-model';

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

/**
 * @param {number} port
 * @returns {Promise<http.Server>} Listening server
 */
export function startLlmStub(port) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: STUB_MODEL_ID, object: 'model' }] }));
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
    const { last, reply } = replyFor(body.messages);
    if (last.includes('e2e-fail')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'The stub model refused this request.' } }));
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
