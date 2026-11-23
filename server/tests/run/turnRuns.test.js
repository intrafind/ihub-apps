// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat turns, scheduled runs and the app turns of the inference API on the run
 * service (`RunService.run` with a turn spec, the chat host's turn), on the
 * real chat preparation, agent loop, tool runner, run ledger and audit log.
 * Only the model is scripted (`helpers/appRunEnv.js`).
 *
 * - a tool call outside the grant of the run (an installation disabled while
 *   the run went on) is refused by the tool runner and audited with the run's
 *   id, for each of the three callers;
 * - the run's context is frozen and reaches the seams (`ctx.meta.run`), with
 *   the origin and approval route of its caller;
 * - a run the service refuses ends as a failed turn and is audited; on the
 *   inference API it keeps the OpenAI error format;
 * - the log lines and model-call spans of a run carry its ids, and the gauge
 *   `ihub.runs.active` counts it while it runs.
 *
 * Run: node --test server/tests/run/turnRuns.test.js
 */
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// The environment first: it isolates the contents directory before the server loads.
import { startAppRunEnv, toolRuns, USAGE } from '../helpers/appRunEnv.js';
import { turn } from '../helpers/scriptedModel.js';
import { RUN_REFUSAL_CODES, activeRunCounts, turnRunSpec } from '../../services/run/RunService.js';
import { assembleTurn } from '../../services/run/assemble/fromApp.js';
import { requestRunContext, scheduledRunContext } from '../../services/run/principalResolver.js';
import { createRunContext, isRunContext } from '../../services/run/RunContext.js';
import { TOOL_REFUSAL_CODES } from '../../services/run/ToolRunner.js';
import { approvalSeam } from '../../services/loop/seams/index.js';
import { RunStreamEmitter } from '../../services/loop/RunStream.js';
import { newRunId } from '../../services/loop/RunLog.js';
import { appTurnError, executeAppTurn, prepareAppTurn } from '../../services/inference/appTurn.js';
import { openAiErrorObject } from '../../services/inference/errors.js';
import { queryAuditLog } from '../../services/AuditLogService.js';
import { currentRunScope } from '../../utils/runScope.js';
import { buildCustomAttributes } from '../../telemetry/attributes.js';
import { guestOwnerId, setGuestId } from '../../services/chat/chatOwner.js';
import { quotaUserKey } from '../../services/quota/quotaService.js';

let env;
let user;

before(async () => {
  env = await startAppRunEnv();
  user = env.user('u-turn', ['users']);
});

after(async () => {
  await env?.stop();
});

beforeEach(() => env.reset());

const newChatId = label => `turn-${label}-${crypto.randomUUID().slice(0, 8)}`;

/** The audit entries written since the test started, of one resource. */
async function auditEntries(resource, since) {
  const { entries } = await queryAuditLog({ resource, result: 'failure', limit: 50 });
  return entries.filter(entry => entry.ts >= since);
}

/** A model turn that disables an installation before it calls its tool. */
const disablingFirst = (instanceId, inner) => (request, ctx) => {
  env.disableInstallation(instanceId);
  return inner.respond(request, ctx);
};

/** The request of a turn of the app `specialist`, prepared for the run's principal. */
async function prepared(context, chatId, content = 'Look up A-1.') {
  const prep = await assembleTurn({
    chatService: env.chatService,
    principal: context.principal,
    request: {
      appId: 'specialist',
      messages: [{ role: 'user', content }],
      language: 'en',
      chatId
    }
  });
  assert.equal(prep.success, true, JSON.stringify(prep.error));
  return prep.data;
}

/** The turn of `ChatService.runTurn` with a spec, unstored and without a stream. */
function runTurn({ spec, chatId, ...rest }) {
  return env.chatService.runTurn({
    spec,
    chatId,
    streaming: false,
    buildLogData: () => ({}),
    language: 'en',
    user: spec.context?.principal ?? user,
    getLocalizedError: async () => null,
    ...rest
  });
}

/** Script a refused call: the model calls `lookup`, whose installation is disabled first. */
function scriptRefusedLookup(t) {
  t.after(() => mock.restoreAll());
  return env.script(t, [
    disablingFirst('lookup', turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }])),
    turn.text('I could not look it up.', { usage: USAGE })
  ]);
}

/**
 * The refusal reached the model, the tool never ran, and the audit log names
 * the run and its caller (`details.origin`, and the `source` it maps to).
 */
async function assertRefusedAndAudited(model, runId, since, { origin, source }) {
  assert.equal(toolRuns.lookup.length, 0, 'the refused tool never ran');
  const toolMessage = model.requests[1].body.messages.find(message => message.role === 'tool');
  assert.match(toolMessage.content, /not permitted for this caller/);
  const entries = (await auditEntries('tool', since)).filter(e => e.resourceId === 'lookup');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].details.code, TOOL_REFUSAL_CODES.NOT_GRANTED);
  assert.equal(entries[0].details.runId, runId);
  assert.equal(entries[0].actor.id, 'u-turn');
  assert.equal(entries[0].details.origin, origin);
  assert.equal(entries[0].source, source);
}

describe('a tool call outside the grant of a turn is refused and audited', () => {
  it('a chat turn', async t => {
    const since = new Date().toISOString();
    const model = scriptRefusedLookup(t);
    const { context } = requestRunContext(user);
    const chatId = newChatId('chat');
    const prep = await prepared(context, chatId);
    const summary = await runTurn({ spec: turnRunSpec({ context, prep }), chatId, prep });
    assert.equal(summary.status, 'completed');
    assert.equal(summary.content, 'I could not look it up.');
    await assertRefusedAndAudited(model, summary.runId, since, { origin: 'chat', source: 'web' });
  });

  it('a scheduled run', async t => {
    const since = new Date().toISOString();
    const model = scriptRefusedLookup(t);
    const { context } = scheduledRunContext(user, { taskId: 'task-1', runId: 'run-1' });
    const chatId = newChatId('scheduled');
    const prep = await prepared(context, chatId);
    const summary = await runTurn({
      spec: turnRunSpec({ context, prep, caller: 'schedule' }),
      chatId,
      prep,
      headless: true,
      // The scheduled run's own approval seam (it waits for the owner).
      approvalGate: approvalSeam({ headless: true, fallback: 'park' })
    });
    assert.equal(summary.status, 'completed');
    await assertRefusedAndAudited(model, summary.runId, since, {
      origin: 'schedule',
      source: 'schedule'
    });
  });

  it('an app turn of the inference API', async t => {
    const since = new Date().toISOString();
    const model = scriptRefusedLookup(t);
    const chatId = newChatId('inference');
    const ready = await prepareAppTurn({
      chatService: env.chatService,
      target: { app: env.configCache.getApps().data.find(a => a.id === 'specialist') },
      user,
      language: 'en',
      messages: [{ role: 'user', content: 'Look up A-1.' }],
      applyTemplate: true,
      variables: {},
      chatId
    });
    assert.ok(isRunContext(ready.spec.context));
    assert.equal(ready.spec.context.approvalRoute, 'deny');
    const runId = newRunId('chat');
    const outcome = await executeAppTurn({
      chatService: env.chatService,
      prepared: ready,
      chatId,
      runId,
      user,
      language: 'en',
      validate: false,
      emitter: new RunStreamEmitter({ streamId: chatId, runId, deliver: () => true })
    });
    assert.equal(outcome.status, 'completed');
    await assertRefusedAndAudited(model, runId, since, { origin: 'inference', source: 'api' });
  });
});

describe('the run context of a turn', () => {
  /** Capture `ctx.meta.run` from a seam of the run. */
  const capturingSeam = seen => ({
    name: 'capture-run',
    preStep(ctx) {
      seen.push(ctx.meta.run);
    }
  });

  it('reaches the seams frozen, with the grant of the tools the turn offers', async t => {
    env.script(t, [turn.text('Done.', { usage: USAGE })]);
    const { context } = requestRunContext(user);
    const chatId = newChatId('frozen');
    const prep = await prepared(context, chatId);
    const seen = [];
    const summary = await runTurn({
      spec: turnRunSpec({ context, prep }),
      chatId,
      prep,
      extraSeams: [capturingSeam(seen)]
    });
    const [run] = seen;
    assert.ok(isRunContext(run));
    assert.equal(run.runId, summary.runId);
    assert.equal(run.origin, 'person');
    assert.equal(run.approvalRoute, 'person');
    assert.ok(run.toolGrant.includes('lookup'));
    assert.throws(() => {
      run.toolGrant.push('secret');
    }, TypeError);
  });

  it('a scheduled run: origin schedule, no admin rights, the task on its principal', () => {
    const admin = {
      ...env.user('u-admin', ['everything']),
      isAdmin: true,
      isContentAdmin: true
    };
    admin.permissions = { ...admin.permissions, adminAccess: true, contentAdmin: true };
    const { context } = scheduledRunContext(admin, { taskId: 'task-1', runId: 'run-1' });
    assert.equal(context.origin, 'schedule');
    assert.equal(context.unattended, true);
    assert.equal(context.approvalRoute, 'owner');
    assert.deepEqual(context.schedule, { taskId: 'task-1', runId: 'run-1' });
    assert.equal(context.principal.isAdmin, false);
    assert.equal(context.principal.isContentAdmin, false);
    assert.equal(context.principal.permissions.adminAccess, false);
    assert.equal(context.principal.permissions.contentAdmin, false);
    assert.deepEqual({ ...context.principal.scheduledRun }, { taskId: 'task-1', runId: 'run-1' });
    // The owner object the scheduler resolved is left as it is.
    assert.equal(admin.isAdmin, true);
    assert.equal(admin.scheduledRun, undefined);
  });

  it('the flags a principal brings along are replaced by the context', () => {
    const brought = { ...user, scheduledRun: { taskId: 'other', runId: 'x' } };
    const person = createRunContext({ principal: brought });
    assert.equal(person.principal.scheduledRun, undefined);
    assert.equal(person.principal.isInvokedViaAppAsTool, undefined);
    assert.throws(
      () => createRunContext({ principal: user, schedule: { taskId: 't', runId: 'r' } }),
      /origin schedule/
    );
  });
});

describe('the kill switch is read once per turn', () => {
  const capturingSeam = seen => ({
    name: 'capture-run',
    preStep(ctx) {
      seen.push(ctx.meta.run ?? null);
    }
  });

  /** Set `platform.runs.chatOnRunService` for one test. */
  function switchTo(t, on) {
    const platform = env.configCache.getPlatform();
    env.configCache.setCacheEntry('config/platform.json', {
      ...platform,
      runs: { chatOnRunService: on }
    });
    t.after(() => env.configCache.setCacheEntry('config/platform.json', platform));
  }

  it('a turn its caller started on the run service stays there when the switch is turned off meanwhile', async t => {
    env.script(t, [turn.text('Done.', { usage: USAGE })]);
    const { context } = requestRunContext(user);
    const chatId = newChatId('switch-on');
    const prep = await prepared(context, chatId);
    switchTo(t, false);
    const seen = [];
    await runTurn({
      spec: turnRunSpec({ context, prep }),
      chatId,
      prep,
      extraSeams: [capturingSeam(seen)]
    });
    assert.ok(isRunContext(seen[0]), 'ran on the run service');
  });

  it('a turn its caller started on the agent loop stays there when the switch is turned on meanwhile', async t => {
    env.script(t, [turn.text('Done.', { usage: USAGE })]);
    const { context } = requestRunContext(user);
    const chatId = newChatId('switch-off');
    const prep = await prepared(context, chatId);
    switchTo(t, true);
    const seen = [];
    const summary = await env.chatService.runTurn({
      prep,
      onRunService: false,
      chatId,
      streaming: false,
      buildLogData: () => ({}),
      language: 'en',
      user,
      getLocalizedError: async () => null,
      extraSeams: [capturingSeam(seen)]
    });
    assert.equal(summary.status, 'completed');
    assert.equal(seen[0], null, 'ran on the agent loop');
  });

  it("a scheduled turn without its caller's context is refused, never run as a person's request", async t => {
    env.script(t, []);
    const { context } = scheduledRunContext(user, { taskId: 'task-1', runId: 'run-1' });
    const chatId = newChatId('owner-no-spec');
    const prep = await prepared(context, chatId);
    const summary = await env.chatService.runTurn({
      prep,
      onRunService: true,
      chatId,
      streaming: false,
      headless: true,
      approvalGate: approvalSeam({ headless: true, fallback: 'park' }),
      buildLogData: () => ({}),
      language: 'en',
      user: context.principal,
      getLocalizedError: async () => null
    });
    assert.equal(summary.status, 'error');
    assert.equal(summary.errorInfo.code, RUN_REFUSAL_CODES.CONTEXT_INVALID);
  });
});

describe("a guest's app turn of the inference API", () => {
  it('is charged to the guest: the request is built for the request’s own principal', async t => {
    const secret = 'e'.repeat(64);
    const guest = env.principal({ id: 'anonymous', name: 'Anonymous', groups: ['users'] });
    setGuestId(guest, secret);
    const charged = [];
    const quota = env.llmClient.quota;
    env.llmClient.quota = {
      assert: async principal => {
        charged.push(quotaUserKey(principal));
      }
    };
    t.after(() => {
      env.llmClient.quota = quota;
    });
    env.script(t, [turn.text('Hello, guest.', { usage: USAGE })]);
    const chatId = newChatId('v1-guest');
    const ready = await prepareAppTurn({
      chatService: env.chatService,
      target: { app: env.configCache.getApps().data.find(a => a.id === 'specialist') },
      user: guest,
      language: 'en',
      messages: [{ role: 'user', content: 'Hello.' }],
      applyTemplate: true,
      variables: {},
      chatId
    });
    assert.equal(ready.onRunService, true);
    assert.equal(ready.prep.llmOptions.user, guest);
    const runId = newRunId('chat');
    const outcome = await executeAppTurn({
      chatService: env.chatService,
      prepared: ready,
      chatId,
      runId,
      user: guest,
      language: 'en',
      validate: false,
      emitter: new RunStreamEmitter({ streamId: chatId, runId, deliver: () => true })
    });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(charged, [guestOwnerId(secret)]);
  });
});

describe('a turn the run service refuses', () => {
  it('ends as a failed turn, audited, when no context can be built for its principal', async t => {
    env.script(t, []);
    const since = new Date().toISOString();
    const { context } = requestRunContext(user);
    const chatId = newChatId('refused');
    const prep = await prepared(context, chatId);
    const bare = { id: 'u-bare', groups: ['users'] };
    const summary = await env.chatService.runTurn({
      prep,
      chatId,
      streaming: false,
      buildLogData: () => ({}),
      language: 'en',
      user: bare,
      getLocalizedError: async () => null
    });
    assert.equal(summary.status, 'error');
    assert.equal(summary.errorInfo.code, RUN_REFUSAL_CODES.CONTEXT_INVALID);
    const [entry] = (await auditEntries('app', since)).filter(e => e.resourceId === 'specialist');
    assert.equal(entry.details.code, RUN_REFUSAL_CODES.CONTEXT_INVALID);
    assert.equal(entry.details.runId, summary.runId);
  });

  it('keeps the OpenAI error format on the inference API', async () => {
    // A caller without resolved permissions: refused before anything is prepared.
    await assert.rejects(
      prepareAppTurn({
        chatService: env.chatService,
        target: { app: env.configCache.getApps().data.find(a => a.id === 'specialist') },
        user: { id: 'u-bare', groups: ['users'] },
        language: 'en',
        messages: [{ role: 'user', content: 'hi' }],
        applyTemplate: true,
        variables: {},
        chatId: newChatId('v1-bare')
      }),
      error => {
        assert.equal(error.status, 403);
        const body = openAiErrorObject(error);
        assert.deepEqual([body.type, body.code], ['permission_error', 'permission_denied']);
        return true;
      }
    );
    // A refusal inside the run: the turn's error, as the inference API answers it.
    const error = appTurnError({
      status: 'error',
      errorInfo: { code: RUN_REFUSAL_CODES.CONTEXT_INVALID, message: 'refused' }
    });
    const body = openAiErrorObject(error);
    assert.equal(body.code, RUN_REFUSAL_CODES.CONTEXT_INVALID);
    assert.equal(typeof body.message, 'string');
    assert.equal(typeof body.type, 'string');
  });
});

describe('the ids of a run in its logs and spans, and the active-runs gauge', () => {
  it('a model call of a turn runs in the scope of its run and is counted while it runs', async t => {
    const { context } = requestRunContext(user);
    const chatId = newChatId('scope');
    const seen = [];
    env.script(t, [
      (request, ctx) => {
        seen.push({ scope: currentRunScope(), active: activeRunCounts() });
        return turn.text('Done.', { usage: USAGE }).respond(request, ctx);
      }
    ]);
    const prep = await prepared(context, chatId);
    const summary = await runTurn({ spec: turnRunSpec({ context, prep }), chatId, prep });
    const [{ scope, active }] = seen;
    assert.deepEqual(
      { ...scope },
      {
        runId: summary.runId,
        kind: 'chat',
        principalId: 'u-turn',
        chatId,
        modelId: prep.model.id
      }
    );
    assert.deepEqual(active, [{ kind: 'chat', model: prep.model.id, count: 1 }]);
    assert.deepEqual(activeRunCounts(), [], 'nothing counted once the run ended');
    assert.equal(currentRunScope(), null, 'no scope outside the run');
    // The span of the call carries them as attributes.
    assert.deepEqual(buildCustomAttributes({ run: scope }), {
      'ihub.run.id': summary.runId,
      'ihub.run.kind': 'chat',
      'ihub.principal.id': 'u-turn'
    });
  });
});
