// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The App Tools Gateway (`services/chat/appToolsGateway.js`) and its wiring
 * into the chat-app tool pipeline (`services/tools/appTools.js`), on the real
 * run service: nothing is replaced but the model (`helpers/appRunEnv.js`).
 *
 *  - synthetic `app__<id>` descriptors (permission filtering, the display name)
 *  - invokeAppTool guard rails: nesting, feature flag, permissions (fail closed)
 *  - the slim result of the run, with the app's sources as the tool-result envelope
 *  - getToolsForApp surfacing `app.apps` as tools
 *  - runTool dispatch of the `app__` prefix
 *
 * Run: node --test server/tests/appToolsGateway.test.js
 */
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// The environment first: it isolates the contents directory before the server loads.
import { startAppRunEnv, USAGE } from './helpers/appRunEnv.js';
import { turn } from './helpers/scriptedModel.js';
import {
  getAppAsTools,
  invokeAppTool,
  isAppInvocationAllowed
} from '../services/chat/appToolsGateway.js';
import { getToolsForApp } from '../services/tools/appTools.js';
import { runTool } from '../services/tools/runTool.js';
import { toolDisplayOf } from '../utils/toolDisplay.js';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';

let env;
let restricted;
let everything;

before(async () => {
  env = await startAppRunEnv();
  restricted = env.user('u-restricted', ['users']);
  everything = env.user('u-everything', ['everything']);
});

after(async () => {
  await env?.stop();
});

beforeEach(() => env.reset());

const runStarts = () => env.ledger.filter(event => event.type === RUN_LOG_EVENTS.RUN_START);

const call = (overrides = {}) =>
  invokeAppTool({
    toolId: 'app__specialist',
    args: { message: 'How do I file a claim?' },
    user: restricted,
    chatId: 'chat-1',
    language: 'en',
    callerAppId: 'concierge',
    ...overrides
  });

describe('isAppInvocationAllowed', () => {
  it('enforces the permissions of a principal that carries them', () => {
    assert.equal(isAppInvocationAllowed(restricted, 'specialist'), true);
    assert.equal(isAppInvocationAllowed(restricted, 'restricted'), false);
    assert.equal(isAppInvocationAllowed(everything, 'restricted'), true);
  });

  it('fails closed for a principal without resolved permissions', () => {
    assert.equal(
      isAppInvocationAllowed({ id: 'agent:helper', isAgent: true }, 'specialist'),
      false
    );
    assert.equal(isAppInvocationAllowed({ id: 'bare', groups: ['users'] }, 'specialist'), false);
    assert.equal(isAppInvocationAllowed(null, 'specialist'), false);
    assert.equal(isAppInvocationAllowed(undefined, 'specialist'), false);
  });
});

describe('getAppAsTools', () => {
  it('builds descriptors for known enabled apps and derives parameters from variables', async () => {
    const tools = await getAppAsTools(['specialist', 'missing', 'disabled'], 'en', {
      user: restricted
    });
    assert.equal(tools.length, 1);
    const [tool] = tools;
    assert.equal(tool.id, 'app__specialist');
    assert.equal(tool.isAppAsTool, true);
    assert.equal(tool.name, 'App: Claims specialist');
    assert.equal(tool.appName, 'Claims specialist');
    assert.equal(tool.description, 'Answers claims questions');
    assert.deepEqual(tool.parameters.required, ['message']);
    assert.deepEqual(Object.keys(tool.parameters.properties), ['message', 'tone']);
  });

  it('titles the row of the call with the localized name of the app alone', async () => {
    const [en] = await getAppAsTools(['specialist'], 'en', { user: restricted });
    const [de] = await getAppAsTools(['specialist'], 'de', { user: restricted });
    assert.equal(toolDisplayOf(en).title, 'Claims specialist');
    assert.equal(toolDisplayOf(de).title, 'Schadensspezialist');
  });

  it('omits apps the calling user may not access', async () => {
    const tools = await getAppAsTools(['specialist', 'restricted'], 'en', { user: restricted });
    assert.deepEqual(
      tools.map(t => t.id),
      ['app__specialist']
    );
  });

  it('offers nothing to a principal without resolved permissions', async () => {
    for (const user of [{ id: 'agent:helper', isAgent: true }, null]) {
      assert.deepEqual(await getAppAsTools(['specialist', 'restricted'], 'en', { user }), []);
    }
  });
});

describe('invokeAppTool', () => {
  it('runs the app on the run service as the caller, one level deep, and returns a slim payload', async t => {
    const model = env.script(t, [turn.text('  the specialist answer  ', { usage: USAGE })]);
    const result = await call({ args: { message: 'How do I file a claim?', tone: 'formal' } });
    assert.deepEqual(result, {
      content: 'the specialist answer',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, source: 'provider' },
      finishReason: 'stop'
    });
    const { messages, tools } = model.requests[0].body;
    assert.equal(messages.at(-1).content, 'How do I file a claim?');
    // Nested: the callee is offered no app tools of its own.
    assert.ok((tools || []).every(tool => !tool.function.name.startsWith('app__')));
    const [start] = runStarts();
    assert.equal(start.data.kind, 'subagent');
    assert.equal(start.data.principal.id, 'u-restricted');
    assert.equal(start.data.refs.appId, 'specialist');
  });

  it('keeps the context handed beside the arguments out of what the app reads (#3925)', async t => {
    const model = env.script(t, [turn.text('ok', { usage: USAGE })]);
    // What the tool runner hands the gateway for a chat turn's call: the model's
    // arguments, and the chat's context beside them.
    await call({
      args: { message: 'How do I file a claim?', tone: 'formal' },
      integrationScopes: {},
      clientTimezone: 'Europe/Berlin'
    });
    const { messages } = model.requests[0].body;
    assert.equal(messages.at(-1).content, 'How do I file a claim?');
    assert.doesNotMatch(JSON.stringify(messages), /integrationScopes|turnSkills|Europe\/Berlin/);
  });

  it('hands the app’s sources to the caller as the tool-result envelope, without passages', async t => {
    env.script(t, [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('Record A-1 is open.', { usage: USAGE })
    ]);
    const result = await call({ user: everything });
    assert.equal(result.content, 'Record A-1 is open.');
    assert.equal(result.sources.length, 1);
    const [source] = result.sources;
    assert.equal(source.title, 'Record A-1');
    assert.equal(source.private, true);
    assert.equal('passages' in source, false);
    assert.equal('snippet' in source, false);
  });

  it('rejects nested app-to-app calls', async t => {
    env.script(t, []);
    const result = await call({ user: { ...everything, isInvokedViaAppAsTool: true } });
    assert.equal(result.error, true);
    assert.match(result.message, /nested/i);
    assert.equal(runStarts().length, 0);
  });

  it('rejects when the appAsTool feature is disabled', async t => {
    env.script(t, []);
    const features = env.configCache.getFeatures();
    mock.method(env.configCache, 'getFeatures', () => ({ ...features, appAsTool: false }));
    t.after(() => mock.restoreAll());
    const result = await call({ user: everything });
    assert.equal(result.error, true);
    assert.match(result.message, /appAsTool/);
    assert.equal(runStarts().length, 0);
  });

  it('rejects apps the calling user may not access, and every app for a bare principal', async t => {
    env.script(t, []);
    const denied = await call({ toolId: 'app__restricted' });
    assert.deepEqual(denied, {
      error: true,
      message: 'You do not have permission to access app restricted'
    });
    const bare = await call({ user: { id: 'bare', groups: ['users'] } });
    assert.deepEqual(bare, {
      error: true,
      message: 'You do not have permission to access app specialist'
    });
    assert.equal(runStarts().length, 0);
  });

  it('reports unknown and disabled apps as tool errors', async t => {
    env.script(t, []);
    const missing = await call({ toolId: 'app__missing', user: everything });
    assert.deepEqual(missing, { error: true, message: 'App missing not found' });
    const disabled = await call({ toolId: 'app__disabled', user: everything });
    assert.deepEqual(disabled, { error: true, message: 'App disabled is disabled' });
    assert.equal(runStarts().length, 0);
  });

  it('surfaces a failed run as a slim error payload', async t => {
    env.script(t, [turn.error(400, { error: { message: 'model exploded', code: 'bad_request' } })]);
    const result = await call();
    assert.deepEqual(result, {
      error: true,
      message: 'Invalid request sent to openai API. Please check your input and try again.'
    });
  });
});

describe('getToolsForApp (app.apps wiring)', () => {
  const concierge = () => env.configCache.getApps().data.find(app => app.id === 'concierge');

  it('surfaces configured apps as app__ tools, excluding itself, unknown and disabled apps', async () => {
    const tools = await getToolsForApp(concierge(), 'en', { user: everything });
    assert.deepEqual(
      tools.filter(t => t.isAppAsTool).map(t => t.id),
      ['app__specialist', 'app__restricted']
    );
  });

  it('filters app tools by the calling user permissions', async () => {
    const tools = await getToolsForApp(concierge(), 'en', { user: restricted });
    assert.deepEqual(
      tools.filter(t => t.isAppAsTool).map(t => t.id),
      ['app__specialist']
    );
  });

  it('generates no app tools when the feature is disabled', async t => {
    const features = env.configCache.getFeatures();
    mock.method(env.configCache, 'getFeatures', () => ({ ...features, appAsTool: false }));
    t.after(() => mock.restoreAll());
    const tools = await getToolsForApp(concierge(), 'en', { user: everything });
    assert.equal(tools.filter(t => t.isAppAsTool).length, 0);
  });

  it('generates no app tools for principals already serving an app-as-tool call', async () => {
    const nested = { ...everything, isInvokedViaAppAsTool: true };
    const tools = await getToolsForApp(concierge(), 'en', { user: nested });
    assert.equal(tools.filter(t => t.isAppAsTool).length, 0);
  });
});

describe('runTool (app__ dispatch)', () => {
  it('routes app__ tool ids through the gateway, separating args from context', async t => {
    const model = env.script(t, [turn.text('the specialist answer', { usage: USAGE })]);
    const result = await runTool('app__specialist', {
      message: 'Summarize the incident',
      tone: 'brief',
      chatId: 'chat-9',
      user: restricted,
      appConfig: { id: 'concierge' },
      language: 'en'
    });
    assert.equal(result.content, 'the specialist answer');
    const { messages } = model.requests[0].body;
    assert.equal(messages.at(-1).content, 'Summarize the incident');
    assert.doesNotMatch(JSON.stringify(messages), /chat-9/);
  });
});
