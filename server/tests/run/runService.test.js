// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The run service (`services/run/RunService.js`) with its headless host, on
 * the real chat preparation, agent loop, tool runner, run ledger and audit log.
 * Only the model is scripted (`helpers/appRunEnv.js`).
 *
 * - the seams of a run: the approval seam first, the host's last;
 * - the run context is frozen: a seam that changes it throws;
 * - what the service refuses before the model is called, and audits;
 * - nobody can answer a headless run: a call that needs approval is denied, never pending;
 * - a tool the run may no longer use is refused by the tool runner and audited;
 * - the tools tool search loads and the web search fallback are in the grant;
 * - an app run as a tool cannot write memory;
 * - the caller's integration scopes reach the tools of the called app.
 *
 * Run: node --test server/tests/run/runService.test.js
 */
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// The environment first: it isolates the contents directory before the server loads.
import { MODEL, startAppRunEnv, toolRuns, USAGE } from '../helpers/appRunEnv.js';
import { turn } from '../helpers/scriptedModel.js';
import { RUN_REFUSAL_CODES, RunService, appRunSpec } from '../../services/run/RunService.js';
import { HeadlessHost } from '../../services/run/hosts/HeadlessHost.js';
import { build as buildSeams, INTERACTIONS } from '../../services/run/seamProfiles.js';
import { childRunContext, createRunContext, isRunContext } from '../../services/run/RunContext.js';
import { requestRunContext } from '../../services/run/principalResolver.js';
import { TOOL_REFUSAL_CODES } from '../../services/run/ToolRunner.js';
import {
  registerScopeProvider,
  unregisterScopeProvider
} from '../../services/integrations/scopes/index.js';
import { queryAuditLog } from '../../services/AuditLogService.js';
import {
  createToolSearch,
  SEARCH_TOOLS_TOOL_ID,
  toolSearchToolDefinition
} from '../../services/tools/toolSearch.js';
import {
  clearNativeWebSearchFallbackMemo,
  markNativeWebSearchUnavailable
} from '../../services/loop/nativeWebSearchFallback.js';
import { APPROVAL_ERROR_CODES } from '../../../shared/toolApproval.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

let env;
let service;
let user;

before(async () => {
  env = await startAppRunEnv();
  service = new RunService({ chatService: env.chatService });
  user = env.user('u1', ['users']);
});

after(async () => {
  await env?.stop();
});

beforeEach(() => env.reset());

const eventsOf = type => env.ledger.filter(event => event.type === type);

/** The context of an app called as a tool from a chat turn of `principal`. */
const childContext = (principal = user) =>
  childRunContext(null, {
    principal: { ...principal, isInvokedViaAppAsTool: true },
    parentRunId: 'chat-of-the-caller'
  });

const run = (overrides = {}, host = new HeadlessHost()) =>
  service.run(
    appRunSpec({
      context: childContext(),
      appId: 'specialist',
      messages: [{ role: 'user', content: 'How do I file a claim?' }],
      language: 'en',
      ...overrides
    }),
    host
  );

/** The tool messages the model got in its request `index`. */
const toolMessages = (model, index) =>
  model.requests[index].body.messages.filter(message => message.role === 'tool');

/** The audit entries written since the test started, of one resource. */
async function auditEntries(resource, since) {
  const { entries } = await queryAuditLog({ resource, result: 'failure', limit: 50 });
  return entries.filter(entry => entry.ts >= since);
}

describe('the seams of a run', () => {
  it('put the approval seam first and the host seams last', () => {
    const marker = { name: 'host-marker' };
    const seams = buildSeams({
      interactions: 'none',
      host: { seams: () => [marker] },
      bindings: {
        chatId: 'c',
        app: { id: 'specialist' },
        principal: user,
        run: childContext(),
        buildLogData: () => ({}),
        logInteraction: async () => {},
        toolRunner: env.chatService.toolRunner
      }
    });
    assert.equal(seams[0].name, 'approval');
    assert.equal(seams.at(-1), marker);
    assert.deepEqual(INTERACTIONS, ['none']);
  });

  it('refuse a profile with a person who answers: the chat host builds that one', () => {
    assert.throws(
      () => buildSeams({ interactions: 'person', host: {}, bindings: {} }),
      /chat host/
    );
  });

  it('a headless run carries the approval seam first, then its own, then the host', async t => {
    env.script(t, [turn.text('ok', { usage: USAGE })]);
    const host = new HeadlessHost();
    const seen = [];
    const original = env.chatService.agentLoop.run.bind(env.chatService.agentLoop);
    mock.method(env.chatService.agentLoop, 'run', request => {
      seen.push(...request.seams.map(seam => seam.name));
      return original(request);
    });
    t.after(() => mock.restoreAll());
    await run({}, host);
    assert.deepEqual(seen, [
      'approval',
      'question',
      'passthrough',
      'image-lift',
      'headless-tool-outputs',
      'app-invoke-collector'
    ]);
  });
});

describe('the run context is frozen', () => {
  it('a seam that changes it throws, and the run goes on as the principal it was', async t => {
    env.script(t, [turn.text('ok', { usage: USAGE })]);
    const attempts = [];
    const host = new HeadlessHost();
    const ownSeams = host.seams.bind(host);
    host.seams = bindings => [
      ...ownSeams(bindings),
      {
        name: 'meddler',
        preStep(ctx) {
          const context = ctx.meta.run;
          attempts.push(isRunContext(context));
          for (const change of [
            () => {
              context.principal.isAdmin = true;
            },
            () => {
              context.toolGrant.push('delete_all');
            },
            () => context.principal.permissions.apps.add('*'),
            () => {
              context.origin = 'schedule';
            }
          ]) {
            try {
              change();
              attempts.push('changed');
            } catch (error) {
              attempts.push(error.name);
            }
          }
        }
      }
    ];
    const result = await run({}, host);
    assert.equal(result.status, 'ok');
    assert.deepEqual(attempts, [true, 'TypeError', 'TypeError', 'TypeError', 'TypeError']);
  });
});

describe('what the service refuses before the model is called', () => {
  it('a spec without a run context the service built (and so any bare principal)', async t => {
    env.script(t, []);
    const since = new Date().toISOString();
    const bare = { id: 'bare', groups: ['users'] };
    for (const context of [null, { principal: bare }, { ...childContext() }]) {
      const result = await run({ context });
      assert.equal(result.status, 'error');
      assert.equal(result.error.code, RUN_REFUSAL_CODES.CONTEXT_INVALID);
    }
    assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_START).length, 0);
    const audited = await auditEntries('app', since);
    assert.equal(audited.length, 3);
    assert.equal(audited[0].details.code, RUN_REFUSAL_CODES.CONTEXT_INVALID);
  });

  it('an app the principal may not open, audited with the principal as the actor', async t => {
    env.script(t, []);
    const since = new Date().toISOString();
    const result = await run({ appId: 'restricted' });
    assert.deepEqual(result.error, {
      code: RUN_REFUSAL_CODES.APP_NOT_PERMITTED,
      message: 'You do not have permission to access app restricted'
    });
    assert.equal(eventsOf(RUN_LOG_EVENTS.RUN_START).length, 0);
    const [entry] = await auditEntries('app', since);
    assert.equal(entry.resourceId, 'restricted');
    assert.equal(entry.actor.id, 'u1');
    assert.equal(entry.action, 'execute');
    assert.equal(entry.details.code, RUN_REFUSAL_CODES.APP_NOT_PERMITTED);
  });

  it('a host it cannot run on, and a spec without an app', async t => {
    env.script(t, []);
    assert.equal(
      (await run({}, { interactions: 'person', seams: () => [] })).error.code,
      RUN_REFUSAL_CODES.HOST_INVALID
    );
    assert.equal((await run({ appId: '' })).error.code, RUN_REFUSAL_CODES.SPEC_INVALID);
  });
});

describe('nobody can answer a headless run', () => {
  it('a call that needs approval is denied with APPROVAL_REQUIRED_NO_USER, never pending', async t => {
    const model = env.script(t, [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('I could not do that.', { usage: USAGE })
    ]);
    const result = await run({ messages: [{ role: 'user', content: 'Close record A-1.' }] });
    assert.equal(result.status, 'ok');
    assert.equal(result.finalMessage.content, 'I could not do that.');
    assert.equal(toolRuns.dangerous.length, 0, 'the gated tool did not run');
    const [denied] = toolMessages(model, 1);
    assert.equal(JSON.parse(denied.content).code, APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER);
    assert.equal(eventsOf(RUN_LOG_EVENTS.INTERACTION_RAISED).length, 0, 'no pending approval');
    const [end] = eventsOf(RUN_LOG_EVENTS.RUN_END);
    assert.equal(end.data.status, 'completed');
  });

  it('a question to the user is refused and the run does not pause', async t => {
    const model = env.script(t, [
      turn.toolCalls([{ name: 'ask_user', args: { question: 'Which claim?' } }], {
        usage: USAGE
      }),
      turn.text('I assumed the latest claim.', { usage: USAGE })
    ]);
    const result = await run();
    assert.equal(result.status, 'ok');
    assert.match(toolMessages(model, 1)[0].content, /NO_USER_AVAILABLE/);
    assert.equal(eventsOf(RUN_LOG_EVENTS.INTERACTION_RAISED).length, 0);
  });
});

describe('the grant of a run', () => {
  /** A model turn that disables an installation before it answers with its tool call. */
  const disablingFirst = (instanceId, inner) => (request, ctx) => {
    env.disableInstallation(instanceId);
    return inner.respond(request, ctx);
  };

  it('a tool whose installation was disabled after it was offered is refused and audited', async t => {
    t.after(() => mock.restoreAll());
    const since = new Date().toISOString();
    const model = env.script(t, [
      disablingFirst(
        'lookup',
        turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE })
      ),
      turn.text('The lookup is not available.', { usage: USAGE })
    ]);
    const result = await run();
    assert.equal(result.status, 'ok');
    assert.equal(toolRuns.lookup.length, 0, 'the tool did not run');
    assert.match(toolMessages(model, 1)[0].content, /not permitted for this caller/);
    const [entry] = await auditEntries('tool', since);
    assert.equal(entry.resourceId, 'lookup');
    assert.equal(entry.actor.id, 'u1');
    assert.equal(entry.source, 'web');
    assert.equal(entry.details.code, TOOL_REFUSAL_CODES.NOT_GRANTED);
    assert.equal(entry.details.origin, 'subagent');
    // The run that made the call, found in the ledger; its caller beside it.
    const [start] = eventsOf(RUN_LOG_EVENTS.RUN_START);
    assert.match(entry.details.runId, /^subagent/);
    assert.equal(entry.details.runId, start.runId ?? start.data.runId);
    assert.equal(entry.details.runId, result.runId);
    assert.equal(entry.details.parentRunId, 'chat-of-the-caller');
  });

  it('a tool the run offers runs, granted as offered', async t => {
    env.script(t, [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('Record A-1 is open.', { usage: USAGE })
    ]);
    const result = await run();
    assert.equal(result.finalMessage.content, 'Record A-1 is open.');
    assert.equal(toolRuns.lookup.length, 1);
    assert.equal(result.toolCalls[0].toolName, 'lookup');
  });

  /**
   * Prepare the run as the product does, then leave `lookup` out of what the
   * model is offered: `move(prepared, lookupTool)` says where it goes instead.
   */
  const withLookupOutOfTheRequest = (t, move) => {
    const original = env.chatService.prepareChatRequest.bind(env.chatService);
    mock.method(env.chatService, 'prepareChatRequest', async request => {
      const prepared = await original(request);
      const lookupTool = prepared.data.tools.find(tool => tool.id === 'lookup');
      assert.ok(lookupTool, 'the app offers lookup');
      prepared.data.tools = prepared.data.tools.filter(tool => tool.id !== 'lookup');
      move(prepared.data, lookupTool);
      return prepared;
    });
    t.after(() => mock.restoreAll());
  };

  it('a tool that tool search loads is granted: found, loaded and called, it runs', async t => {
    withLookupOutOfTheRequest(t, (data, lookupTool) => {
      data.tools.push(toolSearchToolDefinition('en'));
      data.toolSearch = createToolSearch({ deferred: [lookupTool] });
    });
    const model = env.script(t, [
      turn.toolCalls([{ name: SEARCH_TOOLS_TOOL_ID, args: { query: 'look up a record' } }], {
        usage: USAGE
      }),
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('Record A-1 is open.', { usage: USAGE })
    ]);
    const result = await run();
    assert.equal(result.status, 'ok');
    const offered = (index = 0) =>
      (model.requests[index].body.tools || []).map(tool => tool.function.name);
    assert.equal(offered(0).includes('lookup'), false, 'deferred at first');
    assert.equal(offered(1).includes('lookup'), true, 'loaded by the search');
    assert.equal(toolRuns.lookup.length, 1, 'the loaded tool ran');
    assert.doesNotMatch(toolMessages(model, 2).at(-1).content, /not permitted/);
  });

  it('the search tool the loop falls back to when native web search is turned down is granted', async t => {
    clearNativeWebSearchFallbackMemo();
    t.after(() => clearNativeWebSearchFallbackMemo());
    let fallbackTool = null;
    withLookupOutOfTheRequest(t, (data, lookupTool) => {
      fallbackTool = lookupTool;
      data.llmOptions = {
        ...data.llmOptions,
        nativeWebSearch: { provider: 'openai', fallback: 'lookup' }
      };
    });
    mock.method(env.chatService.agentLoop, 'resolveNativeWebSearchFallbackTools', async () => [
      fallbackTool
    ]);
    // The provider turned native web search down before: the loop starts on the fallback.
    markNativeWebSearchUnavailable(MODEL.id, { reason: 'web search disabled' });
    const model = env.script(t, [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('Record A-1 is open.', { usage: USAGE })
    ]);
    const result = await run();
    assert.equal(result.status, 'ok');
    assert.equal(toolRuns.lookup.length, 1, 'the fallback tool ran');
    assert.doesNotMatch(toolMessages(model, 1)[0].content, /not permitted/);
  });

  it('an app run as a tool cannot write memory: the tool is not offered and does not run', async t => {
    const model = env.script(t, [
      turn.toolCalls([{ name: 'write_memory', args: { content: 'remember this' } }], {
        usage: USAGE
      }),
      turn.text('done', { usage: USAGE })
    ]);
    const result = await run();
    assert.equal(result.status, 'ok');
    const offered = (model.requests[0].body.tools || []).map(tool => tool.function.name);
    assert.equal(offered.includes('write_memory'), false);
    assert.equal(
      eventsOf(RUN_LOG_EVENTS.TOOL_RESULT).some(
        event => event.data.toolId === 'write_memory' && !event.data.error
      ),
      false
    );
  });
});

describe("the caller's integration scopes", () => {
  const provider = {
    id: 'lookup',
    appliesTo: ({ app }) => Boolean(app?.integrations?.lookup),
    validateScope: async ({ scopeId }) =>
      scopeId === 'forbidden'
        ? { ok: false, code: 'INTEGRATION_SCOPE_NOT_ALLOWED', message: 'Not your scope' }
        : { ok: true, scopeId }
  };

  it('reach the tools of the called app, where it uses the same integration', async t => {
    registerScopeProvider(provider);
    t.after(() => unregisterScopeProvider('lookup'));
    env.script(t, [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('ok', { usage: USAGE })
    ]);
    await run({ integrationScopes: { lookup: 'records-2026', other: 'x' } });
    assert.equal(toolRuns.lookup[0].scope, 'records-2026');
  });

  it('a scope the principal may not use in the called app refuses the run', async t => {
    registerScopeProvider(provider);
    t.after(() => unregisterScopeProvider('lookup'));
    env.script(t, []);
    const result = await run({ integrationScopes: { lookup: 'forbidden' } });
    assert.deepEqual(result.error, {
      code: 'INTEGRATION_SCOPE_NOT_ALLOWED',
      message: 'Not your scope'
    });
  });

  it('without scopes from the caller the called app runs without a binding, as before', async t => {
    registerScopeProvider(provider);
    t.after(() => unregisterScopeProvider('lookup'));
    env.script(t, [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: USAGE }),
      turn.text('ok', { usage: USAGE })
    ]);
    await run();
    assert.equal(toolRuns.lookup[0].scope, null);
  });
});

describe('a request run context', () => {
  it('runs an inbound call as the person it acts for', async t => {
    env.script(t, [turn.text('ok', { usage: USAGE })]);
    const { context } = requestRunContext(user, { parentRunId: 'mcp-1' });
    assert.equal(context.depth, 0);
    const result = await run({ context });
    assert.equal(result.status, 'ok');
    const [start] = eventsOf(RUN_LOG_EVENTS.RUN_START);
    assert.equal(start.data.principal.id, 'u1');
  });

  it('a context of a principal without permissions cannot be built', () => {
    assert.throws(() => createRunContext({ principal: { id: 'bare' } }), /resolved permissions/);
  });
});
