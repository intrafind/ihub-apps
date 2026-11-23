// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who a run acts as (`services/run/principalResolver.js`) and the frozen run
 * context built from it (`services/run/RunContext.js`).
 *
 * The parity table: for a session user, a personal API key, an OAuth client and
 * a scheduled run, `unattended` and the admin flags of the run context equal
 * what `isUnattendedCaller` and the principal give today, except the rows of
 * the difference list (`server/tests/golden/differences.json`):
 *
 * - `fail-open-removal` (this pull request): a bare principal, one without
 *   resolved permissions, is refused.
 * - `unattended-admin-rights` (`chat-on-run-service`): a scheduled run of an
 *   admin owner loses the admin flags. The resolver does it from now on; the
 *   scheduled run moves onto the run service in that pull request, so today's
 *   scheduled runs do not change here.
 *
 * Run: node --test server/tests/run/principalResolver.test.js
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The harness first: it isolates the contents directory before the server loads.
import { startGoldenEnv } from '../golden/harness.js';
import {
  PRINCIPAL_ERROR_CODES,
  resolveRequestPrincipal,
  SERVICE_AUTH_MODE,
  principalTypeOf,
  requestRunContext,
  resolvePrincipal,
  withoutAdminRights
} from '../../services/run/principalResolver.js';
import {
  MAX_RUN_DEPTH,
  RUN_CONTEXT_ERROR_CODES,
  childRunContext,
  createRunContext,
  isRunContext,
  withToolGrant
} from '../../services/run/RunContext.js';
import { isUnattendedCaller } from '../../utils/toolApproval.js';
import { enhanceUserWithPermissions } from '../../utils/authorization.js';

let env;
let platform;

before(async () => {
  env = await startGoldenEnv({
    apps: [{ id: 'desk', name: { en: 'Desk' }, enabled: true }],
    groups: {
      groups: {
        admins: {
          id: 'admins',
          permissions: { apps: ['*'], models: ['*'], prompts: [], adminAccess: true }
        },
        users: { id: 'users', permissions: { apps: ['desk'], models: ['*'], prompts: [] } }
      }
    }
  });
  platform = env.configCache.getPlatform();
});

after(async () => {
  await env?.stop();
});

/** A request's principal, resolved as the auth middleware resolves it. */
const requestUser = fields => enhanceUserWithPermissions({ ...fields }, {}, platform);

/** A scheduled task of an owner who signs in with OIDC and is not in users.json. */
const task = groups => ({
  id: 'task-1',
  owner: {
    userId: 'ada',
    username: 'ada',
    name: 'Ada',
    groups,
    authMode: 'oidc',
    recorded: false
  }
});
const notRecorded = () => ({ found: false });

const adminFlags = principal => ({
  isAdmin: principal.isAdmin === true,
  adminAccess: principal.permissions?.adminAccess === true
});

describe('the parity table', () => {
  /**
   * One row per principal. `today` is what the code before the run service
   * gave: `isUnattendedCaller` on the request's principal, and the admin flags
   * of the principal the request (or the scheduler) built. A scheduled run was
   * never asked `isUnattendedCaller`: its own seams run it without a person
   * (`scheduler/tasks/runSeams.js`), which is what `today.unattended` says.
   */
  const rows = [
    {
      name: 'session user (admin)',
      source: () => ({
        kind: 'user',
        user: requestUser({ id: 'ada', authMode: 'oidc', groups: ['admins'] })
      }),
      origin: 'person',
      today: { unattended: false, isAdmin: true, adminAccess: true },
      principalType: 'user'
    },
    {
      name: 'session user',
      source: () => ({
        kind: 'user',
        user: requestUser({ id: 'bob', authMode: 'oidc', groups: ['users'] })
      }),
      origin: 'person',
      today: { unattended: false, isAdmin: false, adminAccess: false },
      principalType: 'user'
    },
    {
      name: 'personal API key of an admin',
      source: () => ({
        kind: 'user',
        user: requestUser({
          id: 'ada',
          authMode: 'oauth_personal_key',
          isPersonalApiKey: true,
          groups: ['admins'],
          clientAllowedApps: []
        })
      }),
      origin: 'person',
      today: { unattended: true, isAdmin: false, adminAccess: false },
      principalType: 'client'
    },
    {
      name: 'OAuth client',
      source: () => ({
        kind: 'user',
        user: requestUser({
          id: 'client-1',
          authMode: 'oauth_client_credentials',
          isOAuthClient: true,
          allowedApps: ['desk'],
          groups: ['oauth_clients']
        })
      }),
      origin: 'person',
      today: { unattended: true, isAdmin: false, adminAccess: false },
      principalType: 'client'
    },
    {
      name: 'scheduled run of an admin owner',
      source: () => ({ kind: 'owner', task: task(['admins']) }),
      origin: 'schedule',
      today: { unattended: true, isAdmin: true, adminAccess: true },
      principalType: 'user',
      // Row unattended-admin-rights (pull request chat-on-run-service).
      after: { isAdmin: false, adminAccess: false }
    }
  ];

  for (const row of rows) {
    it(`${row.name}: unattended and the admin flags`, async () => {
      const source = row.source();
      const resolved = await resolvePrincipal(source, {
        origin: row.origin,
        platform,
        lookupUser: notRecorded
      });
      assert.equal(resolved.ok, true, resolved.message);
      assert.equal(resolved.principalType, row.principalType);
      const context = createRunContext({
        principal: resolved.principal,
        principalType: resolved.principalType,
        origin: row.origin
      });
      const expected = { ...row.today, ...row.after };
      assert.deepEqual(
        { unattended: context.unattended, ...adminFlags(context.principal) },
        expected
      );
      // isUnattendedCaller reads the context, and agrees with what it said of the request.
      assert.equal(isUnattendedCaller(context), context.unattended);
      if (source.kind === 'user') {
        assert.equal(isUnattendedCaller(source.user), row.today.unattended);
      }
    });
  }

  it('a bare principal (no resolved permissions) is refused: row fail-open-removal', async () => {
    for (const user of [
      { id: 'bare', groups: ['users'] },
      { id: 'agent:x', isAgent: true },
      null
    ]) {
      const resolved = await resolvePrincipal({ kind: 'user', user }, { platform });
      assert.equal(resolved.ok, false);
      assert.equal(resolved.code, PRINCIPAL_ERROR_CODES.UNRESOLVED);
      assert.equal(requestRunContext(user).ok, false);
      assert.equal(resolveRequestPrincipal(user).code, PRINCIPAL_ERROR_CODES.UNRESOLVED);
      assert.throws(
        () => createRunContext({ principal: user }),
        error => error.code === RUN_CONTEXT_ERROR_CODES.PRINCIPAL_UNRESOLVED
      );
    }
    // Today's answer for the same principal, unchanged: it is unattended only when missing.
    assert.equal(isUnattendedCaller({ id: 'bare', groups: ['users'] }), false);
    assert.equal(isUnattendedCaller(null), true);
  });
});

describe('admin rights are for a person who is there', () => {
  it('every origin other than person strips them, on a copy', async () => {
    const user = requestUser({ id: 'ada', authMode: 'oidc', groups: ['admins'] });
    const resolved = await resolvePrincipal(
      { kind: 'user', user },
      { origin: 'schedule', platform }
    );
    assert.deepEqual(adminFlags(resolved.principal), { isAdmin: false, adminAccess: false });
    assert.equal(resolved.principal.isContentAdmin, false);
    assert.equal(resolved.principal.permissions.contentAdmin, false);
    // The request's principal is shared with the rest of the request: it keeps its flags.
    assert.deepEqual(adminFlags(user), { isAdmin: true, adminAccess: true });
    // The grants other than admin stay.
    assert.equal(resolved.principal.permissions.apps.has('*'), true);
  });

  it('withoutAdminRights leaves a principal without permissions as it is', async () => {
    assert.deepEqual(withoutAdminRights({ id: 'x' }), {
      id: 'x',
      isAdmin: false,
      isContentAdmin: false,
      permissions: undefined
    });
  });
});

describe('a service account an admin chose', () => {
  it('is resolved with the groups the admin gave it and is never an administrator', async () => {
    const resolved = await resolvePrincipal(
      { kind: 'service', account: { id: 'svc-reports', name: 'Reports', groups: ['admins'] } },
      { origin: 'schedule', platform }
    );
    assert.equal(resolved.ok, true);
    assert.equal(resolved.principalType, 'service');
    assert.equal(resolved.principal.authMode, SERVICE_AUTH_MODE);
    assert.equal(principalTypeOf(resolved.principal), 'service');
    assert.deepEqual(adminFlags(resolved.principal), { isAdmin: false, adminAccess: false });
    assert.equal(resolved.principal.permissions.apps.has('*'), true);
    // Even started by a person: a service account acts for nobody at a screen.
    const byPerson = await resolvePrincipal(
      { kind: 'service', account: { id: 'svc-reports', groups: ['admins'] } },
      { origin: 'person', platform }
    );
    assert.equal(byPerson.principal.isAdmin, false);
    const context = createRunContext({
      principal: byPerson.principal,
      principalType: byPerson.principalType
    });
    assert.equal(context.unattended, true);
    assert.equal(context.approvalRoute, 'deny');
  });

  it('needs an id and groups', async () => {
    for (const account of [null, { id: 'svc' }, { groups: ['users'] }]) {
      const resolved = await resolvePrincipal({ kind: 'service', account }, { platform });
      assert.equal(resolved.code, PRINCIPAL_ERROR_CODES.UNRESOLVED);
    }
  });
});

describe('a scheduled task owner', () => {
  it('keeps the refusals of the scheduler (a deleted owner disables the task)', async () => {
    const resolved = await resolvePrincipal(
      { kind: 'owner', task: { owner: { ...task(['users']).owner, recorded: true } } },
      { origin: 'schedule', platform, lookupUser: notRecorded }
    );
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, 'OWNER_DELETED');
    assert.equal(resolved.action, 'disable');
  });

  it('an unknown source is refused', async () => {
    assert.equal(
      (await resolvePrincipal({ kind: 'agent' }, { platform })).code,
      'PRINCIPAL_SOURCE_UNKNOWN'
    );
  });
});

describe('the run context', () => {
  const user = () => requestUser({ id: 'bob', authMode: 'oidc', groups: ['users'] });

  it('is frozen all the way down: a change throws', async () => {
    const context = createRunContext({ principal: user(), toolGrant: ['lookup'] });
    assert.ok(isRunContext(context));
    assert.throws(() => {
      context.origin = 'schedule';
    }, TypeError);
    assert.throws(() => {
      context.principal.isAdmin = true;
    }, TypeError);
    assert.throws(() => {
      context.principal.groups.push('admins');
    }, TypeError);
    assert.throws(() => context.principal.permissions.apps.add('*'), TypeError);
    assert.throws(() => context.principal.permissions.apps.delete('desk'), TypeError);
    assert.throws(() => context.principal.permissions.apps.clear(), TypeError);
    assert.throws(() => {
      context.toolGrant.push('delete_all');
    }, TypeError);
    // Still a Set for the checks that read it.
    assert.ok(context.principal.permissions.apps instanceof Set);
    assert.equal(context.principal.permissions.apps.has('desk'), true);
  });

  it('a copy is not a run context, and a new grant is a new context', async () => {
    const context = createRunContext({ principal: user() });
    assert.equal(isRunContext({ ...context }), false);
    assert.equal(context.toolGrant, null);
    const granted = withToolGrant(context, ['lookup', 'lookup']);
    assert.ok(isRunContext(granted));
    assert.notEqual(granted, context);
    assert.deepEqual(granted.toolGrant, ['lookup']);
    assert.equal(context.toolGrant, null);
  });

  it('carries the fields of the run with their defaults', async () => {
    const context = createRunContext({ principal: user() });
    assert.deepEqual(
      {
        principalType: context.principalType,
        actor: context.actor,
        agentId: context.agentId,
        agentVersion: context.agentVersion,
        origin: context.origin,
        unattended: context.unattended,
        parentRunId: context.parentRunId,
        depth: context.depth,
        toolGrant: context.toolGrant,
        integrationGrant: context.integrationGrant,
        approvalRoute: context.approvalRoute,
        budget: context.budget,
        taint: context.taint
      },
      {
        principalType: 'user',
        actor: { kind: 'user', id: 'bob' },
        agentId: null,
        agentVersion: null,
        origin: 'person',
        unattended: false,
        parentRunId: null,
        depth: 0,
        toolGrant: null,
        integrationGrant: null,
        approvalRoute: 'person',
        budget: {},
        taint: false
      }
    );
  });

  it('refuses an unknown origin, principal type or approval route', async () => {
    for (const fields of [
      { origin: 'webhook' },
      { principalType: 'agent' },
      { approvalRoute: 'nobody' },
      { toolGrant: 'lookup' }
    ]) {
      assert.throws(
        () => createRunContext({ principal: user(), ...fields }),
        error => error.code === RUN_CONTEXT_ERROR_CODES.INVALID
      );
    }
  });

  it('a child runs one level deeper with the parent origin; no deeper than the limit', async () => {
    const parent = createRunContext({ principal: user(), origin: 'schedule' });
    const child = childRunContext(parent, { principal: user(), parentRunId: 'chat-1' });
    assert.deepEqual(
      [child.depth, child.origin, child.unattended, child.parentRunId],
      [1, 'schedule', true, 'chat-1']
    );
    assert.equal(MAX_RUN_DEPTH, 1);
    assert.throws(
      () => childRunContext(child, { principal: user() }),
      error => error.code === RUN_CONTEXT_ERROR_CODES.INVALID
    );
    // Without a parent context (a chat turn): a run of a person, one level deep.
    const fromChat = childRunContext(null, { principal: user(), parentRunId: 'chat-2' });
    assert.deepEqual([fromChat.depth, fromChat.origin], [1, 'person']);
  });
});
