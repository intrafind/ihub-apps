// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The two surfaces of the inference API, recorded through their HTTP routes
 * (`routes/openaiProxy.js`, `routes/inference/responses.js`):
 *
 * - `completions`: `POST /api/inference/v1/chat/completions` on a plain model.
 *   The caller holds the history and runs the tools; iHub forwards one model
 *   call.
 * - `inference-app`: a turn of an app, `model: "app:<id>"`, through
 *   `/chat/completions` and through `POST /api/inference/v1/responses`. The app
 *   runs its own prompt and tools on the server (`inference/appTurn.js`).
 *
 * `httpResponse` holds each request with its status, headers and body or
 * stream; `evidence` holds the evidence record of the run when the response
 * names one (`X-Run-Id`).
 *
 * @module tests/golden/surfaces/inference
 */
import { defineCase } from '../harness.js';
import { turn } from '../../helpers/scriptedModel.js';
import registerOpenAIProxyRoutes from '../../../routes/openaiProxy.js';
import { getLocalizedError } from '../../../serverHelpers.js';
import { getChatEvidenceRepository } from '../../../services/chat/ChatEvidenceRepository.js';
import { RUN_LOG_EVENTS } from '../../../../shared/runEvents.js';
import {
  app,
  goldenUser,
  surfaceConfig,
  usage,
  usersGroup,
  withoutConfigHashes
} from './fixtures.js';
import { exchange, openRequest, startRouteServer } from './http.js';

const COMPLETIONS = '/api/inference/v1/chat/completions';
const RESPONSES = '/api/inference/v1/responses';

const APPS = [app('desk', { integrations: { lookup: {} } })];

const inferenceConfig = () =>
  surfaceConfig({
    apps: APPS,
    groups: { users: usersGroup(['desk']) },
    extra: {
      // `created` of an OpenAI object is the time in seconds. The options of a model call hold
      // the id of the chat, which the server mints for a turn of the API.
      volatileKeys: ['created', 'created_at', 'configHash'],
      idPatterns: [
        // Ids of the Responses API: `resp_<hex>`, `msg_<hex>`, `fc_<hex>`.
        /\b(?:resp|msg|fc|rs|tc)_([0-9a-f]{16,})\b/g
      ]
    }
  });

/** A server with the routes of the inference API, signed in as the golden user. */
async function withInferenceServer(env, fn) {
  const user = goldenUser(env);
  const server = await startRouteServer({
    user: () => user,
    register: expressApp =>
      registerOpenAIProxyRoutes(expressApp, { getLocalizedError, DEFAULT_TIMEOUT: 60_000 })
  });
  try {
    return await fn(server.port);
  } finally {
    await server.close();
  }
}

/** The evidence record of the run a response names, without its storage envelope. */
async function runEvidence(env, response) {
  const runId = response?.headers?.['x-run-id'];
  if (!runId) return undefined;
  await env.settle();
  const stored = await getChatEvidenceRepository().getRecord('run', runId);
  return withoutConfigHashes([{ runId, record: stored?.data ?? null }]);
}

/** One request, recorded with the evidence of its run. */
async function oneExchange(env, options) {
  return withInferenceServer(env, async port => {
    const recorded = await exchange(port, options);
    const evidence = await runEvidence(env, recorded.response);
    return { httpResponse: { exchanges: [recorded] }, ...(evidence ? { evidence } : {}) };
  });
}

const question = content => [{ role: 'user', content }];

const CALLER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'The weather in a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city']
      }
    }
  }
];

/**
 * A model answer that sends its first words and then nothing more, until the
 * caller of the model goes away: what a client disconnect interrupts.
 */
function firstWordsThenSilence(text) {
  const encoder = new TextEncoder();
  const chunk = fields =>
    encoder.encode(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: fields, finish_reason: null }] })}\n\n`
    );
  return (_request, ctx) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk({ role: 'assistant', content: '' }));
          controller.enqueue(chunk({ content: text }));
          const fail = () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            controller.error(error);
          };
          if (ctx?.signal?.aborted) fail();
          else ctx?.signal?.addEventListener('abort', fail, { once: true });
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
}

/** Resolves when the run ledger holds the end of a run. */
function runEnded(env) {
  return new Promise(resolve => {
    const unsubscribe = env.runLog.subscribeAll(event => {
      if (event.type !== RUN_LOG_EVENTS.RUN_END) return;
      unsubscribe();
      resolve(event);
    });
  });
}

export const completionsCases = [
  defineCase({
    surface: 'completions',
    name: 'non-stream',
    title: 'A completion on a model, answered as one JSON object.',
    config: inferenceConfig,
    script: () => [turn.text('Record A-1 is open.', { usage: usage(12, 6) })],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: COMPLETIONS,
        body: { model: 'golden-model', messages: question('What about record A-1?') }
      })
  }),
  defineCase({
    surface: 'completions',
    name: 'stream',
    title: 'A completion on a model, streamed as OpenAI chunks.',
    config: inferenceConfig,
    script: () => [turn.text(['Record A-1 ', 'is open.'], { usage: usage(12, 6) })],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: COMPLETIONS,
        body: {
          model: 'golden-model',
          stream: true,
          stream_options: { include_usage: true },
          messages: question('What about record A-1?')
        }
      })
  }),
  defineCase({
    surface: 'completions',
    name: 'tool',
    title: 'The caller offers a tool: the tool call of the model is handed back, not run.',
    config: inferenceConfig,
    script: () => [
      turn.toolCalls([{ name: 'get_weather', args: { city: 'Munich' } }], { usage: usage(30, 9) })
    ],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: COMPLETIONS,
        body: {
          model: 'golden-model',
          messages: question('How is the weather in Munich?'),
          tools: CALLER_TOOLS,
          tool_choice: 'auto'
        }
      })
  }),
  defineCase({
    surface: 'completions',
    name: 'error-unknown-model',
    title: 'A model id that does not exist: the error body and no model call.',
    config: inferenceConfig,
    script: () => [],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: COMPLETIONS,
        body: { model: 'no-such-model', messages: question('Hello') }
      })
  }),
  defineCase({
    surface: 'completions',
    name: 'error-provider',
    title: 'The provider refuses the request: its error is mapped to the error body of the API.',
    config: inferenceConfig,
    script: () => [
      turn.error(400, { error: { message: 'The request was refused', code: 'bad_request' } })
    ],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: COMPLETIONS,
        body: { model: 'golden-model', messages: question('What about record A-1?') }
      })
  }),
  defineCase({
    surface: 'completions',
    name: 'disconnect',
    title: 'The client goes away while the answer streams: the model call is aborted.',
    config: inferenceConfig,
    script: () => [firstWordsThenSilence('Record A-1 ')],
    run: env =>
      withInferenceServer(env, async port => {
        const body = {
          model: 'golden-model',
          stream: true,
          messages: question('What about record A-1?')
        };
        const ended = runEnded(env);
        const open = openRequest({ port, method: 'POST', path: COMPLETIONS, body });
        await open.until(
          frame => frame.data?.choices?.[0]?.delta?.content === 'Record A-1 ',
          'the first words of the answer'
        );
        open.abort();
        const response = await open.done;
        await ended;
        return {
          httpResponse: {
            exchanges: [{ request: { method: 'POST', path: COMPLETIONS, body }, response }]
          }
        };
      })
  })
];

export const inferenceAppCases = [
  defineCase({
    surface: 'inference-app',
    name: 'completions-non-stream',
    title: 'A turn of an app through /chat/completions: the app runs its prompt and its tool.',
    config: inferenceConfig,
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text('Record A-1 is open.', { usage: usage(62, 6) })
    ],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: COMPLETIONS,
        body: { model: 'app:desk', messages: question('Look up record A-1.') }
      })
  }),
  defineCase({
    surface: 'inference-app',
    name: 'completions-stream',
    title: 'A turn of an app through /chat/completions, streamed.',
    config: inferenceConfig,
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text(['Record A-1 ', 'is open.'], { usage: usage(62, 6) })
    ],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: COMPLETIONS,
        body: { model: 'app:desk', stream: true, messages: question('Look up record A-1.') }
      })
  }),
  defineCase({
    surface: 'inference-app',
    name: 'completions-tools-refused',
    title:
      'An app runs its own tools: a request that brings tools is refused with the OpenAI error body.',
    config: inferenceConfig,
    script: () => [],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: COMPLETIONS,
        body: { model: 'app:desk', messages: question('Hello'), tools: CALLER_TOOLS }
      })
  }),
  defineCase({
    surface: 'inference-app',
    name: 'responses-non-stream',
    title: 'A turn of an app through /responses, answered as one response object.',
    config: inferenceConfig,
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text('Record A-1 is open.', { usage: usage(62, 6) })
    ],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: RESPONSES,
        body: { model: 'app:desk', input: 'Look up record A-1.' }
      })
  }),
  defineCase({
    surface: 'inference-app',
    name: 'responses-stream',
    title: 'A turn of an app through /responses, streamed as response events.',
    config: inferenceConfig,
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text(['Record A-1 ', 'is open.'], { usage: usage(62, 6) })
    ],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: RESPONSES,
        body: { model: 'app:desk', stream: true, input: 'Look up record A-1.' }
      })
  }),
  defineCase({
    surface: 'inference-app',
    name: 'responses-model',
    title: 'A plain model through /responses: one model call, no app.',
    config: inferenceConfig,
    script: () => [turn.text('Record A-1 is open.', { usage: usage(12, 6) })],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: RESPONSES,
        body: { model: 'golden-model', input: 'What about record A-1?' }
      })
  }),
  defineCase({
    surface: 'inference-app',
    name: 'responses-error-unknown-app',
    title: 'An app that does not exist: the OpenAI error body and no model call.',
    config: inferenceConfig,
    script: () => [],
    run: env =>
      oneExchange(env, {
        method: 'POST',
        path: RESPONSES,
        body: { model: 'app:no-such-app', input: 'Hello' }
      })
  })
];
