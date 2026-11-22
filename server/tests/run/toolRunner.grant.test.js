// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The grant re-check of the tool runner: a call of a run on the run service
 * carries its frozen run context (`toolContext.run`), and the runner checks the
 * grant again on every call, whatever was checked when the tools were listed.
 * One test per row of the table in docs/agent-loop.md ("Tool runner", rows
 * `run-context-valid` to `directory-grant`).
 *
 * Real installations, groups and audit log (`helpers/appRunEnv.js`); the tool
 * itself is a spy, so a refused call shows as no call.
 *
 * Run: node --test server/tests/run/toolRunner.grant.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The environment first: it isolates the contents directory before the server loads.
import { startAppRunEnv } from '../helpers/appRunEnv.js';
import {
  ToolCallRefusedError,
  ToolRunner,
  TOOL_REFUSAL_CODES
} from '../../services/run/ToolRunner.js';
import { createRunContext } from '../../services/run/RunContext.js';
import { queryAuditLog } from '../../services/AuditLogService.js';

let env;
let users;
let noSecret;
let everything;

before(async () => {
  env = await startAppRunEnv();
  users = env.user('u-users', ['users']);
  noSecret = env.user('u-no-secret', ['no-secret']);
  everything = env.user('u-everything', ['everything']);
});

after(async () => {
  await env?.stop();
});

let calls;
let appCalls;
let runner;

beforeEach(() => {
  calls = [];
  appCalls = [];
  runner = new ToolRunner({
    runTool: async (toolId, params) => {
      calls.push({ toolId, params });
      return { ok: true };
    },
    invokeAppTool: async request => {
      appCalls.push(request);
      return { content: 'app answer' };
    }
  });
});

const integrationTool = id => ({ id, _integration: { instanceId: id, action: id } });

const execute = (toolDef, run, extra = {}) =>
  runner.execute(null, {
    toolId: toolDef.id,
    toolDef,
    args: { key: 'A-1', user: { id: 'forged' } },
    toolContext: { origin: 'mcp', approval: 'caller', argsFrom: 'caller', run, ...extra }
  });

const refused = code => error => {
  assert.ok(error instanceof ToolCallRefusedError, `expected a refusal, got ${error}`);
  assert.equal(error.code, code);
  return true;
};

const context = (principal, fields = {}) => createRunContext({ principal, ...fields });

describe('the grant re-check of a run (run-service-headless)', () => {
  it('run-context-valid: a context the run service did not build is refused', async () => {
    const real = context(users, { toolGrant: ['lookup'] });
    for (const run of [{ ...real }, { principal: users, toolGrant: ['lookup'] }, 'ctx']) {
      await assert.rejects(
        execute(integrationTool('lookup'), run),
        refused(TOOL_REFUSAL_CODES.RUN_CONTEXT_INVALID)
      );
    }
    assert.equal(calls.length, 0);
  });

  it('tool-grant: a tool outside the grant is refused and audited; it runs only for the run principal', async () => {
    const since = new Date().toISOString();
    await assert.rejects(
      execute(integrationTool('lookup'), context(users, { toolGrant: ['secret'] })),
      refused(TOOL_REFUSAL_CODES.NOT_GRANTED)
    );
    // No grant at all grants nothing.
    await assert.rejects(
      execute(integrationTool('lookup'), context(users)),
      refused(TOOL_REFUSAL_CODES.NOT_GRANTED)
    );
    assert.equal(calls.length, 0);
    const { entries } = await queryAuditLog({ resource: 'tool', result: 'failure', limit: 50 });
    const mine = entries.filter(entry => entry.ts >= since);
    assert.equal(mine.length, 2);
    assert.deepEqual(
      [mine[0].resourceId, mine[0].action, mine[0].source, mine[0].actor.id],
      ['lookup', 'execute', 'mcp', 'u-users']
    );
    assert.equal(mine[0].details.code, TOOL_REFUSAL_CODES.NOT_GRANTED);

    // Granted: it runs as the run's principal, whatever the arguments say.
    await execute(integrationTool('lookup'), context(users, { toolGrant: ['lookup'] }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.user.id, 'u-users');
    // The caller's principal, when given, runs the tool: it must be the run's.
    await execute(integrationTool('lookup'), context(users, { toolGrant: ['lookup'] }), {
      principal: users
    });
    assert.equal(calls[1].params.user, users);
    await assert.rejects(
      execute(integrationTool('lookup'), context(users, { toolGrant: ['lookup'] }), {
        principal: everything
      }),
      refused(TOOL_REFUSAL_CODES.RUN_CONTEXT_INVALID)
    );
    assert.equal(calls.length, 2);
  });

  it("integration-grant: the installation is enabled and the principal's groups grant it", async () => {
    // `no-secret` does not grant the integration `secret`; it is in the grant all the same.
    await assert.rejects(
      execute(integrationTool('secret'), context(noSecret, { toolGrant: ['secret'] })),
      refused(TOOL_REFUSAL_CODES.NOT_GRANTED)
    );
    // An installation that does not exist (any more).
    await assert.rejects(
      execute(integrationTool('gone'), context(everything, { toolGrant: ['gone'] })),
      refused(TOOL_REFUSAL_CODES.NOT_GRANTED)
    );
    // A run narrowed to some installations reaches no other.
    await assert.rejects(
      execute(
        integrationTool('secret'),
        context(everything, { toolGrant: ['secret'], integrationGrant: ['lookup'] })
      ),
      refused(TOOL_REFUSAL_CODES.NOT_GRANTED)
    );
    assert.equal(calls.length, 0);
    await execute(integrationTool('secret'), context(users, { toolGrant: ['secret'] }));
    assert.equal(calls.length, 1);
  });

  it('app-grant: an app tool runs only for a principal who may open the app', async () => {
    const restricted = { id: 'app__restricted' };
    await assert.rejects(
      execute(restricted, context(users, { toolGrant: ['app__restricted'] })),
      refused(TOOL_REFUSAL_CODES.NOT_GRANTED)
    );
    assert.equal(appCalls.length, 0);
    const run = context(users, { toolGrant: ['app__specialist'] });
    await execute({ id: 'app__specialist' }, run);
    assert.equal(appCalls.length, 1);
    // The gateway gets the calling run, to run the app one level below it.
    assert.equal(appCalls[0].parentContext, run);
    assert.equal(appCalls[0].user.id, 'u-users');
  });

  it('directory-grant: a people directory the principal may not use is refused (fails closed)', async () => {
    const directoryTool = { id: 'find_person', _peopleDirectory: { id: 'unknown-dir' } };
    await assert.rejects(
      execute(directoryTool, context(everything, { toolGrant: ['find_person'] })),
      refused(TOOL_REFUSAL_CODES.NOT_GRANTED)
    );
    assert.equal(calls.length, 0);
  });

  it('a call without a run context keeps the checks of its caller (chat, until it moves)', async () => {
    await runner.execute(null, {
      toolId: 'lookup',
      toolDef: integrationTool('lookup'),
      args: {},
      toolContext: { origin: 'chat', approval: 'seam', principal: users }
    });
    assert.equal(calls.length, 1);
  });
});
