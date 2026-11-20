// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The app-as-tool surface: one app calls another as the tool `app__<id>`.
 *
 * `ok` is recorded from a chat turn of the calling app, so the record holds
 * what the user's stream shows of the call. The other cases call the gateway
 * (`invokeAppTool`) the way the tool runner does and record what the calling
 * model gets back.
 *
 * `server/tests/appToolsGateway.characterization.test.js` asserts the same
 * behaviour piece by piece and explains each one; these goldens hold the whole
 * record of each run.
 *
 * @module tests/golden/surfaces/appAsTool
 */
import { mock } from 'node:test';
import { defineCase } from '../harness.js';
import { turn } from '../../helpers/scriptedModel.js';
import { invokeAppTool } from '../../../services/chat/appToolsGateway.js';
import { app, goldenUser, MODEL, surfaceConfig, usage, usersGroup } from './fixtures.js';

const CALLER_CHAT = 'chat-of-the-caller';

const APPS = [
  app('concierge', { apps: ['specialist', 'restricted'] }),
  // The specialist may itself call an app: what the depth rule is about.
  app('specialist', {
    apps: ['helper'],
    integrations: { lookup: {}, dangerous: {}, ihub: { actions: ['ask_user'] } }
  }),
  app('helper'),
  // The group of the user does not list it.
  app('restricted')
];

const appToolConfig = () =>
  surfaceConfig({
    apps: APPS,
    features: { appAsTool: true },
    groups: { users: usersGroup(['concierge', 'specialist', 'helper']) },
    extra: {
      // The chat id of a call is minted for the call; the options of its model call hold it.
      volatileKeys: ['configHash']
    }
  });

/** Call the gateway as the tool runner does for a tool call of the concierge. */
const call = (env, overrides = {}) =>
  invokeAppTool({
    toolId: 'app__specialist',
    args: { message: 'How do I file a claim?' },
    user: goldenUser(env),
    chatId: CALLER_CHAT,
    language: 'en',
    callerAppId: 'concierge',
    ...overrides
  });

/** One call of the gateway; the record holds what the caller gets back. */
const gatewayCase = ({ name, title, script, overrides }) =>
  defineCase({
    surface: 'app-as-tool',
    name,
    title,
    config: appToolConfig,
    script,
    run: async env => ({ result: await call(env, overrides?.(env)) })
  });

/** One chat turn of the concierge, in process, as the chat route runs it after preparing the request. */
async function conciergeTurn(env, message) {
  const user = goldenUser(env);
  const chatId = 'golden-chat-concierge';
  const prepared = await env.chatService.prepareChatRequest({
    appId: 'concierge',
    modelId: MODEL.id,
    messages: [{ role: 'user', content: message }],
    language: 'en',
    user,
    chatId
  });
  if (!prepared.success)
    throw new Error(`the request was not prepared: ${prepared.error?.message}`);
  const summary = await env.chatService.runTurn({
    prep: prepared.data,
    chatId,
    streaming: true,
    buildLogData: (streaming, extra = {}) => ({
      appId: 'concierge',
      user,
      userSessionId: chatId,
      sessionId: chatId,
      streaming,
      ...extra
    }),
    language: 'en',
    user,
    getLocalizedError: async () => null
  });
  const { status, finishReason, content, usage: used, knowledgeSources, answerBasis } = summary;
  return {
    result: {
      offeredAppTools: prepared.data.tools.filter(tool => tool.isAppAsTool).map(tool => tool.id),
      status,
      finishReason,
      content,
      usage: used,
      knowledgeSources,
      answerBasis
    }
  };
}

const MODEL_ANSWERS_AFTER_MS = 100_000;
const WALL_CLOCK_LIMIT_MS = 180_000;

/**
 * A model turn that answers after 100 s of the fake clock: inside the limit of
 * one model call (120 s). `waiting` resolves once the call has arrived and its
 * timer is set; the clock is moved only after that.
 */
function slowly(inner) {
  let timerIsSet;
  const waiting = new Promise(resolve => {
    timerIsSet = resolve;
  });
  const respond = (request, ctx) =>
    new Promise((resolve, reject) => {
      ctx.onConnected?.();
      const timer = setTimeout(() => resolve(inner.respond(request, ctx)), MODEL_ANSWERS_AFTER_MS);
      ctx.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(ctx.signal.reason);
        },
        { once: true }
      );
      timerIsSet();
    });
  return Object.assign(respond, { waiting });
}

/**
 * The 3-minute limit of an app call, on a fake clock. Only `setTimeout` is
 * faked: the storage waits on I/O and `setImmediate` and keeps working.
 */
async function runPastTheLimit(env, turns) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const pending = call(env).finally(() => {
      settled = true;
    });
    /** Let everything that is ready run, without moving the clock. */
    const idle = async () => {
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    };
    let elapsed = 0;
    /** Move the clock in steps, so that short timers set on the way fire too. */
    const advanceTo = async ms => {
      while (elapsed < ms && !settled) {
        const step = Math.min(1000, ms - elapsed);
        mock.timers.tick(step);
        elapsed += step;
        await idle();
      }
    };
    await turns[0].waiting;
    await advanceTo(MODEL_ANSWERS_AFTER_MS);
    await turns[1].waiting;
    const stillRunningAfterMs = settled ? null : elapsed;
    await advanceTo(WALL_CLOCK_LIMIT_MS);
    const result = await pending;
    return { result: { stillRunningAfterMs, endedAfterMs: elapsed, answer: result } };
  } finally {
    mock.timers.reset();
  }
}

export const appAsToolCases = [
  defineCase({
    surface: 'app-as-tool',
    name: 'ok',
    title:
      'A chat turn of one app calls another app as a tool: the answer comes back as the tool result, as a run of kind subagent.',
    config: appToolConfig,
    script: () => [
      turn.toolCalls([{ name: 'app__specialist', args: { message: 'How do I file a claim?' } }], {
        usage: usage(50, 12)
      }),
      turn.text('File it online.', { usage: usage(11, 7) }),
      turn.text('The specialist says: file it online.', { usage: usage(80, 9) })
    ],
    run: env => conciergeTurn(env, 'I have a claim.')
  }),
  (() => {
    let turns = [];
    return defineCase({
      surface: 'app-as-tool',
      name: 'three-minute-clock',
      title: 'An app call that takes longer than 180 s is stopped and reported as an error.',
      config: appToolConfig,
      script: () => {
        turns = [
          slowly(turn.toolCalls([{ name: 'lookup', args: { key: 'claim' } }])),
          slowly(turn.text('too late'))
        ];
        return turns;
      },
      run: env => runPastTheLimit(env, turns)
    });
  })(),
  gatewayCase({
    name: 'depth-1',
    title:
      'An app that is called as a tool is not offered its own apps; a call to one is answered with an error.',
    script: () => [
      turn.toolCalls([{ name: 'app__helper', args: { message: 'help me' } }], {
        usage: usage(40, 9)
      }),
      turn.text('answered alone', { usage: usage(70, 4) })
    ]
  }),
  gatewayCase({
    name: 'approval-denied',
    title: 'A tool that needs approval is refused inside an app call and does not run.',
    script: () => [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text('I could not do that.', { usage: usage(90, 7) })
    ],
    overrides: () => ({ args: { message: 'Close record A-1.' } })
  }),
  gatewayCase({
    name: 'question-refused',
    title: 'A question to the user is refused inside an app call; the run does not pause.',
    script: () => [
      turn.toolCalls([{ name: 'ask_user', args: { question: 'Which claim?' } }], {
        usage: usage(40, 8)
      }),
      turn.text('I assumed the latest claim.', { usage: usage(90, 8) })
    ]
  }),
  gatewayCase({
    name: 'user-without-permissions',
    title:
      'FAIL-OPEN, current behaviour: a principal without a permissions object may call an app no group grants.',
    script: () => [turn.text('the restricted answer', { usage: usage(11, 7) })],
    overrides: () => ({
      toolId: 'app__restricted',
      user: { id: 'no-permissions', groups: ['users'] }
    })
  }),
  gatewayCase({
    name: 'user-not-permitted',
    title: 'A user with resolved permissions cannot call an app the user may not open.',
    script: () => [],
    overrides: () => ({ toolId: 'app__restricted' })
  })
];
