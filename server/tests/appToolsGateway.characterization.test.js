// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Characterization of "app as tool" (#3786): what happens today when one app
 * calls another as the tool `app__<id>`, pinned before the run service
 * (#3772) moves the code.
 *
 * This file replaces nothing but the model: the gateway, the run service
 * (`services/run/RunService.js`) with its headless host, the agent loop, the approval and
 * question seams, the run ledger and the usage recorder run as in the product,
 * on the environment of the golden harness (real storage in a temporary
 * directory, a scripted model).
 *
 * These tests describe current behaviour. Where that behaviour is a known
 * weakness, the test says so and names the row of the difference list that
 * will change it. A test here fails when behaviour changes, and is then
 * changed together with that row, never alone.
 */
import test, { before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
// The harness first: it isolates the contents directory before the server loads.
import { startGoldenEnv } from './golden/harness.js';
import { scriptedModel, turn } from './helpers/scriptedModel.js';
import { fixtureInstallation, fixtureTool } from './helpers/integrationToolFixture.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import { invokeAppTool } from '../services/chat/appToolsGateway.js';
import { newRunId } from '../services/loop/RunLog.js';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';

const MODEL = {
  id: 'golden-model',
  provider: 'openai',
  modelId: 'gpt-golden',
  url: 'https://model.invalid/v1/chat/completions',
  autoDiscovery: false,
  supportsTools: 'auto',
  default: true
};

const app = (id, extra = {}) => ({
  id,
  name: { en: id },
  description: { en: `The ${id} app` },
  system: { en: `You are the ${id}.` },
  preferredModel: MODEL.id,
  enabled: true,
  ...extra
});

const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
const CALLER_CHAT = 'chat-of-the-caller';

let env;
let user;
let dangerousRan = 0;

before(async () => {
  env = await startGoldenEnv({
    features: { appAsTool: true, chatPersistence: true },
    platform: { chats: { enabled: true }, auth: {} },
    models: [MODEL],
    apps: [
      app('concierge', { apps: ['specialist', 'restricted'] }),
      // The specialist may itself call an app: what the depth rule is about.
      app('specialist', {
        apps: ['helper'],
        integrations: { lookup: {}, dangerous: {}, ihub: { actions: ['ask_user'] } }
      }),
      app('helper'),
      // No group below may use it.
      app('restricted')
    ],
    groups: {
      groups: {
        users: {
          id: 'users',
          permissions: {
            apps: ['concierge', 'specialist', 'helper'],
            models: ['*'],
            prompts: [],
            integrations: ['lookup', 'dangerous', 'ihub']
          }
        }
      }
    },
    tools: [
      fixtureTool('lookup', {
        description: 'Look up a record',
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
        run: args => ({ found: args.key })
      }),
      fixtureTool('dangerous', {
        description: 'Does something with side effects',
        requiresApproval: true,
        run: () => {
          dangerousRan++;
          return { done: true };
        }
      })
    ],
    integrations: () => ({
      installed: [
        fixtureInstallation('lookup'),
        fixtureInstallation('dangerous'),
        fixtureInstallation('ihub', {
          definition: 'com.intrafind/ihub',
          definitionVersion: integrationRegistry.get('com.intrafind/ihub').definition.version
        })
      ],
      security: { blockPrivateIps: true, allowedHosts: [] }
    })
  });
  user = env.principal({ id: 'u1', name: 'User One', groups: ['users'] });
});

after(async () => {
  await env?.stop();
});

beforeEach(() => {
  env.ledger.length = 0;
  dangerousRan = 0;
});

/** Script the model for one test; the script must be used exactly. */
function script(t, turns) {
  const model = scriptedModel(turns);
  env.model = model;
  t.after(() => model.assertDone());
  return model;
}

const call = (overrides = {}) =>
  invokeAppTool({
    toolId: 'app__specialist',
    args: { message: 'How do I file a claim?' },
    user,
    chatId: CALLER_CHAT,
    language: 'en',
    callerAppId: 'concierge',
    ...overrides
  });

const eventsOf = type => env.ledger.filter(event => event.type === type);
const offeredTools = request => (request.body.tools || []).map(tool => tool.function.name);
const lastMessage = request => request.body.messages.at(-1);

test('result shape: the caller gets the trimmed answer, the usage and the finish reason, and nothing else', async t => {
  script(t, [turn.text('  the specialist answer  ', { usage: USAGE })]);
  const result = await call();
  assert.deepEqual(result, {
    content: 'the specialist answer',
    usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, source: 'provider' },
    finishReason: 'stop'
  });
});

test('result shape: the callee gets the message as its only user message; other arguments are not message text', async t => {
  const model = script(t, [turn.text('ok', { usage: USAGE })]);
  await call({ args: { message: 'How do I file a claim?', tone: 'formal' } });
  const { messages } = model.requests[0].body;
  assert.deepEqual(
    messages.map(message => message.role),
    ['system', 'user']
  );
  assert.match(messages[0].content, /You are the specialist\./);
  assert.equal(messages[1].content, 'How do I file a claim?');
});

test('from a chat turn: the calling model gets the result as the tool message of app__specialist', async t => {
  const CHAT = 'chat-concierge';
  env.envelopes.length = 0;
  const model = script(t, [
    turn.toolCalls([{ name: 'app__specialist', args: { message: 'How do I file a claim?' } }]),
    turn.text('File it online.', { usage: USAGE }),
    turn.text('The specialist says: file it online.')
  ]);
  const prepared = await env.chatService.prepareChatRequest({
    appId: 'concierge',
    modelId: MODEL.id,
    messages: [{ role: 'user', content: 'I have a claim.' }],
    language: 'en',
    user,
    chatId: CHAT
  });
  assert.ok(prepared.success, prepared.error?.message);
  // The concierge lists two apps; the one the user may not open is not offered.
  assert.deepEqual(
    prepared.data.tools.filter(tool => tool.isAppAsTool).map(tool => tool.id),
    ['app__specialist']
  );
  const summary = await env.chatService.runTurn({
    prep: prepared.data,
    chatId: CHAT,
    streaming: true,
    buildLogData: (streaming, extra = {}) => ({
      appId: 'concierge',
      user,
      sessionId: CHAT,
      streaming,
      ...extra
    }),
    language: 'en',
    user,
    getLocalizedError: async () => null
  });
  assert.equal(summary.content, 'The specialist says: file it online.');

  // Model call 2 is the specialist's own turn, call 3 the concierge reading the result.
  assert.match(model.requests[1].body.messages[0].content, /You are the specialist\./);
  const toolMessage = lastMessage(model.requests[2]);
  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.name, 'app__specialist');
  assert.deepEqual(JSON.parse(toolMessage.content), {
    content: 'File it online.',
    usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, source: 'provider' },
    finishReason: 'stop'
  });

  // Two runs: the chat turn and, linked to the chat by its id, the app call.
  const starts = eventsOf(RUN_LOG_EVENTS.RUN_START);
  assert.deepEqual(
    starts.map(start => start.data.kind),
    ['chat', 'subagent']
  );
  assert.equal(starts[1].data.parentRunId, CHAT);
  assert.notEqual(starts[1].data.parentRunId, starts[0].runId);

  // What the user's stream shows of the call: one tool row, nothing of the specialist's run.
  const frames = env.envelopes.map(entry => entry.envelope);
  assert.ok(
    frames.every(frame => frame.runId === summary.runId),
    'only envelopes of the chat run'
  );
  const started = frames.find(frame => frame.type === 'tool/started');
  assert.deepEqual(
    {
      toolId: started.data.toolId,
      name: started.data.name,
      args: started.data.args,
      execution: started.data.execution
    },
    {
      toolId: 'app__specialist',
      name: 'app__specialist',
      args: { message: 'How do I file a claim?' },
      execution: 'server'
    }
  );
});

test('ledger link: the call is a run of kind "subagent" that names the caller as its parent', async t => {
  script(t, [turn.text('ok', { usage: USAGE })]);
  const callerRun = newRunId('chat');
  await call({ executionId: callerRun });

  const [start] = eventsOf(RUN_LOG_EVENTS.RUN_START);
  assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_START).length, 1, 'one run per call');
  assert.match(start.runId, /^subagent-[0-9a-f-]{36}$/);
  assert.equal(start.data.kind, 'subagent');
  assert.equal(start.data.parentRunId, callerRun);
  assert.equal(start.data.refs.executionId, callerRun);
  assert.equal(start.data.refs.appId, 'specialist');
  // The call has a chat id of its own, derived from the caller's id; nothing is stored under it.
  assert.match(start.data.refs.chatId, new RegExp(`^agent:${callerRun}:[0-9a-f]{8}$`));
  assert.deepEqual(start.data.principal, { id: 'u1', mode: 'default', anonymous: false });

  const [end] = eventsOf(RUN_LOG_EVENTS.RUN_END);
  assert.equal(end.runId, start.runId);
  assert.equal(end.data.status, 'completed');
  assert.equal(end.data.finishReason, 'stop');
});

test('ledger link from a chat: the parent is the id of the caller’s chat, not of its run', async t => {
  // The tool runner hands the gateway the chat id and no run id (`runTool.js`), so that is
  // what the ledger records. Current behaviour: the parent link of a chat's app call does
  // not lead to a run.
  script(t, [turn.text('ok', { usage: USAGE })]);
  await call();
  const [start] = eventsOf(RUN_LOG_EVENTS.RUN_START);
  assert.equal(start.data.kind, 'subagent');
  assert.equal(start.data.parentRunId, CALLER_CHAT);
  assert.equal(start.data.refs.executionId, CALLER_CHAT);
  assert.match(start.data.refs.chatId, new RegExp(`^agent:${CALLER_CHAT}:[0-9a-f]{8}$`));
});

test('usage attribution: the model call is recorded for the called app, under the call’s own conversation', async t => {
  const before = (await env.usageRecords()).length;
  script(t, [turn.text('ok', { usage: USAGE })]);
  await call();
  await env.settle();
  const records = (await env.usageRecords()).slice(before);
  assert.equal(records.length, 1);
  const [record] = records;
  const [start] = eventsOf(RUN_LOG_EVENTS.RUN_START);
  assert.deepEqual(
    {
      type: record.type,
      surf: record.surf,
      st: record.st,
      app: record.app,
      model: record.model,
      pt: record.pt,
      ct: record.ct,
      src: record.src,
      grp: record.grp
    },
    {
      type: 'llm_call',
      // The surface is "chat": an app call is not told apart from a chat turn.
      surf: 'chat',
      st: 'ok',
      // The called app, not the calling one.
      app: 'specialist',
      model: 'golden-model',
      pt: 11,
      ct: 7,
      src: 'provider',
      grp: ['users']
    }
  );
  // The conversation is the call's synthetic chat id, not the chat the user is in. In the
  // default tracking mode (pseudonymous) that id also stands in for the user.
  assert.equal(record.cid, start.data.refs.chatId);
  assert.equal(record.uid, start.data.refs.chatId);
  assert.notEqual(record.cid, CALLER_CHAT);
});

test('depth 1: an app that is called as a tool is not offered its own apps', async t => {
  const model = script(t, [turn.text('ok', { usage: USAGE })]);
  await call();
  // The specialist lists `helper` under `apps`; called as a tool it sees only its integrations.
  assert.deepEqual(offeredTools(model.requests[0]), ['lookup', 'dangerous', 'ask_user']);

  // The control: in a turn of its own the specialist is offered the app.
  const prepared = await env.chatService.prepareChatRequest({
    appId: 'specialist',
    modelId: MODEL.id,
    messages: [{ role: 'user', content: 'hi' }],
    language: 'en',
    user,
    chatId: 'chat-control'
  });
  assert.ok(prepared.success, prepared.error?.message);
  assert.ok(prepared.data.tools.some(tool => tool.id === 'app__helper'));
});

test('depth 1: a call to another app from inside an app call is answered with an error and runs nothing', async t => {
  const model = script(t, [
    turn.toolCalls([{ name: 'app__helper', args: { message: 'help me' } }]),
    turn.text('answered alone', { usage: USAGE })
  ]);
  const result = await call();
  assert.equal(result.content, 'answered alone');
  assert.deepEqual(JSON.parse(lastMessage(model.requests[1]).content), {
    error: true,
    reason: 'tool_not_registered',
    message:
      "Tool 'app__helper' is not registered for this agent. Available tools: lookup, dangerous, ask_user. Pick one of those or stop calling tools."
  });
  assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_START).length, 1, 'no second app run was started');

  // And when the marked principal reaches the gateway anyway, the gateway refuses.
  const nested = await call({ user: { ...user, isInvokedViaAppAsTool: true } });
  assert.deepEqual(nested, {
    error: true,
    message:
      'Nested app-to-app calls are not allowed (an app invoked as a tool cannot invoke further apps)'
  });
});

test('approval denied: a tool that needs a person’s approval is refused and does not run', async t => {
  const model = script(t, [
    turn.toolCalls([{ name: 'dangerous', args: {} }]),
    turn.text('I could not do that.', { usage: USAGE })
  ]);
  const result = await call({ args: { message: 'Do the dangerous thing.' } });

  assert.equal(dangerousRan, 0, 'the tool did not run');
  assert.deepEqual(JSON.parse(lastMessage(model.requests[1]).content), {
    error: true,
    code: 'APPROVAL_REQUIRED_NO_USER',
    message:
      'The tool "dangerous" needs a person\'s approval before it runs, and nobody can approve it here. ' +
      'It was not run. Do not call it again in this conversation; continue without it, or tell the user ' +
      'that this action needs approval in the chat.'
  });
  // Nobody is asked: no interaction is raised, the call just continues.
  assert.equal(eventsOf(RUN_LOG_EVENTS.INTERACTION_RAISED).length, 0);
  assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_PAUSED).length, 0);
  assert.equal(result.content, 'I could not do that.');
  assert.equal(result.error, undefined, 'the caller sees an answer, not an error');
});

test('question refused: ask_user is answered with NO_USER_AVAILABLE and the run does not pause', async t => {
  const model = script(t, [
    turn.toolCalls([{ name: 'ask_user', args: { question: 'Which claim?' } }]),
    turn.text('I assumed the latest claim.', { usage: USAGE })
  ]);
  const result = await call();
  assert.deepEqual(JSON.parse(lastMessage(model.requests[1]).content), {
    error: true,
    message:
      'No user is available to answer questions in this context. Proceed with the available ' +
      'information or make reasonable assumptions.',
    code: 'NO_USER_AVAILABLE'
  });
  assert.equal(eventsOf(RUN_LOG_EVENTS.INTERACTION_RAISED).length, 0);
  assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_PAUSED).length, 0);
  assert.equal(result.content, 'I assumed the latest claim.');
});

// The time limit is for a broken order of events only: when the clock is moved before a timer
// the test counts on exists, the call never ends, and without a limit the file would hang until
// the job is killed, with no test named. Nothing here waits for the limit.
const CLOCK_TEST_LIMIT_MS = 30_000;

test(
  '3-minute clock: an app call that takes longer than 180 s is stopped and reported as an error',
  {
    timeout: CLOCK_TEST_LIMIT_MS
  },
  async t => {
    // Fake timers: the limit is a `setTimeout` of the agent loop. Only `setTimeout` is faked, so the
    // storage, which waits on I/O and `setImmediate`, keeps working.
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());

    const MODEL_ANSWERS_AFTER_MS = 100_000;
    /**
     * A model that answers after 100 s: inside the limit of one model call (120 s).
     *
     * `waiting` resolves once the call has arrived AND its timer is set. The test moves the clock
     * only after that: a timer that is set after the clock moved would be due later than the test
     * counts on, and the answer would never come. `model.waitForCall` is too early for this, it
     * resolves before the turn is asked to respond.
     */
    const slowly = inner => {
      let timerIsSet;
      const waiting = new Promise(resolve => {
        timerIsSet = resolve;
      });
      const respond = (request, ctx) =>
        new Promise((resolve, reject) => {
          // The connection is there at once; the answer is what takes long.
          ctx.onConnected?.();
          const timer = setTimeout(
            () => resolve(inner.respond(request, ctx)),
            MODEL_ANSWERS_AFTER_MS
          );
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
    };
    const firstCall = slowly(turn.toolCalls([{ name: 'lookup', args: { key: 'claim' } }]));
    const secondCall = slowly(turn.text('too late'));
    const model = script(t, [firstCall, secondCall]);

    let settled = null;
    const pending = call().then(result => {
      settled = result;
    });
    /** Let everything that is ready run, without moving the clock. */
    const idle = async () => {
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    };
    /** Move the fake clock in steps, so timers set on the way (short ones of the pipeline) fire too. */
    let elapsed = 0;
    const advanceTo = async ms => {
      while (elapsed < ms) {
        const step = Math.min(1000, ms - elapsed);
        mock.timers.tick(step);
        elapsed += step;
        await idle();
      }
    };

    // However long the pipeline takes to reach the model (a store write, a ledger flush): the clock
    // stands still until the first call waits on its timer.
    await firstCall.waiting;
    assert.equal(model.calls, 1);
    await advanceTo(MODEL_ANSWERS_AFTER_MS);
    await secondCall.waiting;
    assert.equal(model.calls, 2);
    assert.equal(
      settled,
      null,
      'after 100 s the call is still running: the second model call has started'
    );

    await advanceTo(179_000);
    assert.equal(settled, null, 'after 179 s the call is still running');

    await advanceTo(180_000);
    await idle();
    await pending;
    assert.deepEqual(settled, { error: true, message: 'Agent loop wall-clock budget exceeded' });

    const [end] = eventsOf(RUN_LOG_EVENTS.RUN_END);
    assert.equal(end.data.status, 'error');
    assert.equal(end.data.error.code, 'TIMEOUT');
  }
);

test('a user with resolved permissions cannot call an app the user may not open', async t => {
  script(t, []);
  assert.deepEqual(await call({ toolId: 'app__restricted' }), {
    error: true,
    message: 'You do not have permission to access app restricted'
  });
  assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_START).length, 0);
});

test('a principal without a permissions object cannot call an app (row fail-open-removal)', async t => {
  // Before the run service, `isAppInvocationAllowed` let every principal through that carried
  // no `permissions` (appToolsGateway.js), and this call ran. The row "fail-open-removal" of the
  // difference list (server/tests/golden/differences.json) decided the refusal: the gateway
  // fails closed, and no run starts.
  script(t, []);
  const bare = { id: 'no-permissions', groups: ['users'] };
  assert.deepEqual(await call({ toolId: 'app__restricted', user: bare }), {
    error: true,
    message: 'You do not have permission to access app restricted'
  });
  // Not even an app the group grants: without resolved permissions nothing is granted.
  assert.deepEqual(await call({ user: bare }), {
    error: true,
    message: 'You do not have permission to access app specialist'
  });
  assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_START).length, 0);
});

test('a call without any principal is refused as well (row fail-open-removal)', async t => {
  script(t, []);
  assert.deepEqual(await call({ toolId: 'app__restricted', user: null }), {
    error: true,
    message: 'You do not have permission to access app restricted'
  });
  assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_START).length, 0);
});
