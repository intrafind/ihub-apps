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
import { startAppRunEnv, toolRuns, USAGE } from './helpers/appRunEnv.js';
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
import { ToolRunner } from '../services/run/ToolRunner.js';
import { runService } from '../services/run/RunService.js';
import { createTurnSkillLog } from '../services/chat/turnSkillLog.js';
import {
  registerScopeProvider,
  unregisterScopeProvider
} from '../services/integrations/scopes/index.js';
import { queryAuditLog } from '../services/AuditLogService.js';

/** A scope provider for the integration `lookup`: every scope is valid. */
const scopeProvider = {
  id: 'lookup',
  appliesTo: ({ app }) => Boolean(app?.integrations?.lookup),
  validateScope: async ({ scopeId }) => ({ ok: true, scopeId })
};

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

  it("a chat turn's call: the scopes the person picked reach the called app's tools, never its prompt (#3925)", async t => {
    registerScopeProvider(scopeProvider);
    t.after(() => {
      unregisterScopeProvider('lookup');
      mock.restoreAll();
    });
    // What the called app's own tool calls get beside their arguments.
    const inner = runService.chatService.toolRunner;
    const innerExecute = inner.execute.bind(inner);
    const innerContexts = [];
    mock.method(inner, 'execute', (callArg, request) => {
      innerContexts.push(request.toolContext);
      return innerExecute(callArg, request);
    });
    const model = env.script(t, [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('Record A-1 is open.', { usage: USAGE })
    ]);
    const [toolDef] = await getAppAsTools(['specialist'], 'en', { user: everything });
    // The chat turn's call, through the tool runner as the chat makes it: the
    // model's arguments, and the chat's context beside them.
    const result = await new ToolRunner().execute(null, {
      toolId: 'app__specialist',
      toolDef,
      args: { message: 'Look up A-1.', tone: 'formal' },
      toolContext: {
        origin: 'chat',
        approval: 'seam',
        principal: everything,
        chatId: 'chat-3925',
        appConfig: { id: 'concierge' },
        language: 'en',
        integrationScopes: { lookup: 'records-2026' },
        turnSkills: createTurnSkillLog(),
        clientTimezone: 'Europe/Berlin'
      }
    });
    assert.equal(result.content, 'Record A-1 is open.');
    // The called app searched inside the picked scope, and has the timezone for its tools.
    assert.equal(toolRuns.lookup[0].scope, 'records-2026');
    assert.equal(innerContexts[0].clientTimezone, 'Europe/Berlin');
    assert.deepEqual(innerContexts[0].integrationScopes, { lookup: 'records-2026' });
    // Its model got the message alone: no scope, skill log or timezone as a variable or text.
    const { messages } = model.requests[0].body;
    assert.equal(messages.at(-1).content, 'Look up A-1.');
    assert.doesNotMatch(
      JSON.stringify(messages),
      /integrationScopes|turnSkills|records-2026|Europe\/Berlin/
    );
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

  it('rejects apps the calling user may not access, and every app for a bare principal; both audited', async t => {
    env.script(t, []);
    const since = new Date().toISOString();
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
    const { entries } = await queryAuditLog({ resource: 'app', result: 'failure', limit: 50 });
    const audited = entries
      .filter(entry => entry.ts >= since)
      .map(entry => [entry.resourceId, entry.actor.id, entry.details.code, entry.details.origin])
      .sort((a, b) => (a[0] < b[0] ? -1 : Number(a[0] > b[0])));
    assert.deepEqual(audited, [
      ['restricted', 'u-restricted', 'APP_NOT_PERMITTED', 'subagent'],
      ['specialist', 'bare', 'PRINCIPAL_UNRESOLVED', 'subagent']
    ]);
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
