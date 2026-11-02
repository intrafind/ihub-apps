// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Headless runs and integration connections: a scheduled run resolves the
 * task **owner's** own connection of every installation whose tools it may
 * call and that signs users in, and fails with the structured
 * `INTEGRATION_AUTH_REQUIRED` (`integration`, `reason`) when there is none —
 * never with anybody else's connection.
 *
 * Run: node --test server/tests/scheduled-tasks-integration-auth.test.js
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkIntegrations } from '../services/scheduler/tasks/taskExecution.js';
import { integrationIssueOf } from '../services/scheduler/tasks/runSeams.js';
import {
  IntegrationConnectionService,
  setIntegrationConnectionServiceForTests,
  getIntegrationConnectionService
} from '../services/integrations/auth/IntegrationConnectionService.js';
import { IntegrationAuthRequiredError } from '../services/integrations/auth/integrationAuthRequired.js';

const original = getIntegrationConnectionService();
after(() => setIntegrationConnectionServiceForTests(original));

/** A connection service whose installations and connections are given. */
function fakeConnections({ descriptors, connected }) {
  const service = new IntegrationConnectionService({
    documents: null,
    describe: async id => descriptors[id] || null
  });
  const resolved = [];
  service.resolve = async (principal, installationId) => {
    resolved.push([principal, installationId]);
    if (connected[installationId]?.includes(principal.id)) return { ok: true };
    return {
      ok: false,
      error: new IntegrationAuthRequiredError({
        integration: installationId,
        reason: connected[installationId] ? 'expired' : 'not_connected'
      })
    };
  };
  service.resolved = resolved;
  setIntegrationConnectionServiceForTests(service);
  return service;
}

const tool = instanceId => ({ id: `${instanceId}__x`, _integration: { instanceId } });

describe('the integration check before a scheduled run', () => {
  it("resolves the owner's own connection and fails with INTEGRATION_AUTH_REQUIRED", async () => {
    const service = fakeConnections({
      descriptors: {
        jira: { kind: 'oauth-user', displayName: 'JIRA' },
        web: { kind: 'service-account', displayName: 'Web' }
      },
      connected: { jira: ['someone-else'] }
    });
    const failure = await checkIntegrations([tool('web'), tool('jira'), tool('jira')], {
      id: 'owner-1'
    }).catch(error => error);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.code, 'INTEGRATION_AUTH_REQUIRED');
    assert.match(failure.message, /^Reconnect JIRA: the connection has expired$/);
    assert.deepEqual(failure.extra, {
      integration: 'jira',
      reason: 'expired',
      connectUrl: '/settings/integrations'
    });
    // Only the per-user installation, once, as the owner — nobody else.
    assert.deepEqual(service.resolved, [[{ type: 'user', id: 'owner-1' }, 'jira']]);
  });

  it('lets the run go on when the owner is connected', async () => {
    fakeConnections({
      descriptors: { jira: { kind: 'oauth-user', displayName: 'JIRA' } },
      connected: { jira: ['owner-1'] }
    });
    await checkIntegrations([tool('jira'), { id: 'plain' }], { id: 'owner-1' });
  });
});

describe('what a tool result says about its integration', () => {
  it('reads the structured INTEGRATION_AUTH_REQUIRED result', () => {
    assert.deepEqual(
      integrationIssueOf('jira_searchTickets', {
        error: 'INTEGRATION_AUTH_REQUIRED',
        integration: 'jira',
        reason: 'not_connected',
        message: 'Please connect your JIRA account to search tickets',
        connectUrl: '/api/integrations/jira/auth'
      }),
      {
        toolId: 'jira_searchTickets',
        message: 'Please connect your JIRA account to search tickets',
        integration: 'jira',
        reason: 'not_connected',
        connectUrl: '/api/integrations/jira/auth'
      }
    );
  });

  it('keeps the MCP Connect marker and adds the structured fields', () => {
    const issue = integrationIssueOf('okta__whoami', {
      error: 'INTEGRATION_AUTH_REQUIRED',
      integration: 'okta',
      reason: 'expired',
      authRequired: { serverId: 'okta', serverName: 'Okta', connectUrl: '/connect' }
    });
    assert.deepEqual(issue, {
      toolId: 'okta__whoami',
      message: 'Connect Okta again',
      integration: 'okta',
      reason: 'expired',
      connectUrl: '/connect'
    });
  });
});
