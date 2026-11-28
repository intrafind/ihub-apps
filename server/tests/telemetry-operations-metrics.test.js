// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The operations and product metrics of #4008 (P2): every label comes from a
 * closed set and is in the allow-list, a value outside the set becomes the
 * neutral one, and the signals are recorded where the work happens.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import http from 'node:http';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  initializeMetrics,
  METRIC_LABEL_KEYS,
  recordAuthEvent,
  recordClusterBusTimeout,
  recordOutboundRequest,
  recordSecurityEvent,
  recordToolDuration,
  recordTurn,
  recordWorkflowExecution,
  resetDependencyStatesForTests,
  SECURITY_EVENTS
} from '../telemetry/metrics.js';
import { clientChannelOf } from '../telemetry/channel.js';
import { securityEventOfAudit } from '../telemetry/securityEvents.js';
import { networkErrorClass } from '../telemetry/networkErrors.js';
import { volumesByMount } from '../telemetry/filesystemSampler.js';
import {
  endToolSpan,
  endTurnSpan,
  startToolSpan,
  startTurnSpan,
  turnOutcomeOf
} from '../telemetry/traces.js';
import { GenAIInstrumentation } from '../telemetry/GenAIInstrumentation.js';
import { httpFetch } from '../utils/httpConfig.js';

/** A fake meter that keeps every recording, by instrument name. */
function fakeMeter() {
  const recorded = {};
  const gauges = {};
  const instrument = name => {
    recorded[name] = [];
    const push = (value, labels) => recorded[name].push([value, labels || {}]);
    return { add: push, record: push };
  };
  const meter = {
    createHistogram: instrument,
    createCounter: instrument,
    createUpDownCounter: instrument,
    createObservableGauge: name => ({
      addCallback: cb => {
        gauges[name] = cb;
      }
    })
  };
  initializeMetrics({ getMeter: () => meter });
  return { recorded, gauges };
}

let fake;
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});
afterAll(() => context.disable());
beforeEach(() => {
  fake = fakeMeter();
  resetDependencyStatesForTests();
});

const labelsOf = name => fake.recorded[name].map(([, labels]) => labels);
const allowed = new Set(METRIC_LABEL_KEYS);

describe('closed label sets', () => {
  test('a turn is recorded by surface, channel, outcome and app; strays become neutral', () => {
    recordTurn({ seconds: 2, outcome: 'ok', surface: 'chat', channel: 'office', appId: 'chat' });
    recordTurn({ seconds: 1, outcome: 'weird', surface: 'nope', channel: 'X-Header-Value' });
    expect(labelsOf('ihub.turns')).toEqual([
      {
        'ihub.surface': 'chat',
        'ihub.client.channel': 'office',
        'ihub.turn.outcome': 'ok',
        'app.id': 'chat'
      },
      { 'ihub.surface': 'system', 'ihub.client.channel': 'system', 'ihub.turn.outcome': 'error' }
    ]);
    expect(fake.recorded['ihub.turn.duration'].map(([value]) => value)).toEqual([2, 1]);
  });

  test('tool, workflow, auth, outbound and cluster-bus labels stay in their sets', () => {
    recordToolDuration({ seconds: 0.5, toolName: 'read_url', origin: 'web', outcome: 'results' });
    recordToolDuration({ seconds: 0.5, toolName: 'mcp', origin: 'somewhere', outcome: 'meh' });
    recordWorkflowExecution('completed', 10);
    recordWorkflowExecution('exploded', 1);
    recordAuthEvent('saml-custom', 'something');
    recordOutboundRequest({ kind: 'ifinder', seconds: 0.2, status: 200 });
    recordOutboundRequest({ kind: 'nope', seconds: 0.2, errorType: 'tls', tls: true });
    recordClusterBusTimeout('gather');
    expect(labelsOf('ihub.tool.duration')).toEqual([
      { 'tool.name': 'read_url', 'tool.origin': 'web', 'tool.outcome': 'results' },
      { 'tool.name': 'mcp', 'tool.origin': 'none', 'tool.outcome': 'unknown' }
    ]);
    expect(labelsOf('ihub.workflow.executions')).toEqual([
      { 'ihub.workflow.outcome': 'completed' },
      { 'ihub.workflow.outcome': 'other' }
    ]);
    expect(labelsOf('ihub.auth.events')).toEqual([
      { 'auth.provider': 'other', 'auth.event': 'other' }
    ]);
    expect(labelsOf('ihub.outbound.request.duration')).toEqual([
      { 'ihub.dependency.kind': 'ifinder' },
      { 'ihub.dependency.kind': 'other', 'error.type': 'tls' }
    ]);
    expect(labelsOf('ihub.outbound.tls.errors')).toEqual([
      { 'ihub.dependency.kind': 'other', 'error.type': 'tls' }
    ]);
    expect(labelsOf('ihub.clusterbus.timeouts')).toEqual([{ 'clusterbus.operation': 'gather' }]);
  });

  test('every label key any of these instruments uses is in the allow-list', () => {
    recordTurn({ seconds: 1, outcome: 'ok', surface: 'api', channel: 'mcp', appId: 'x' });
    recordToolDuration({ seconds: 1, toolName: 'x', origin: 'web', outcome: 'empty' });
    recordWorkflowExecution('paused', 1);
    recordOutboundRequest({ kind: 'llm', seconds: 1, status: 503 });
    recordSecurityEvent('login_failure');
    for (const recordings of Object.values(fake.recorded)) {
      for (const [, labels] of recordings) {
        for (const key of Object.keys(labels)) expect(allowed).toContain(key);
      }
    }
  });

  test('a security event outside the set is not counted', () => {
    recordSecurityEvent('login_failure');
    recordSecurityEvent('anything else');
    expect(labelsOf('ihub.security.events')).toEqual([{ 'security.event': 'login_failure' }]);
  });

  test('ihub.dependency.up reports the last outcome per dependency kind', () => {
    recordOutboundRequest({ kind: 'llm', seconds: 1, status: 200 });
    recordOutboundRequest({ kind: 'idp', seconds: 1, status: 503 });
    const observed = [];
    fake.gauges['ihub.dependency.up']({
      observe: (value, labels) => observed.push([value, labels])
    });
    expect(observed).toEqual([
      [1, { 'ihub.dependency.kind': 'llm' }],
      [0, { 'ihub.dependency.kind': 'idp' }]
    ]);
  });
});

describe('turn outcome', () => {
  test.each([
    [{ status: 'completed', content: 'Hello' }, 'ok'],
    [{ status: 'completed', content: '  ' }, 'empty'],
    [{ status: 'paused', pendingInteraction: {} }, 'ok'],
    [{ status: 'aborted' }, 'aborted'],
    [{ status: 'error', errorInfo: { code: 'QUOTA_EXCEEDED' } }, 'quota'],
    [{ status: 'error', errorInfo: { code: 'RATE_LIMITED' } }, 'rate_limited'],
    [{ status: 'error', errorInfo: { code: 'NETWORK' } }, 'error']
  ])('%j → %s', (result, outcome) => {
    expect(turnOutcomeOf(result)).toBe(outcome);
  });

  test('a turn that answered after a failed tool call is tool_degraded', async () => {
    const turn = startTurnSpan({ appId: 'chat', surface: 'chat', channel: 'web' });
    await turn.run(async () => {
      const tool = startToolSpan({ toolDef: { id: 'read_url' }, toolId: 'read_url' });
      endToolSpan(tool, { outcome: 'error', failed: true });
      tool.end();
    });
    endTurnSpan(turn, { status: 'completed', content: 'Answer anyway' });
    turn.end();
    expect(labelsOf('ihub.turns')[0]['ihub.turn.outcome']).toBe('tool_degraded');
    expect(labelsOf('ihub.tool.duration')[0]).toMatchObject({
      'tool.name': 'read_url',
      'tool.outcome': 'error'
    });
  });
});

describe('client channel', () => {
  const platform = {
    officeIntegration: { oauthClientId: 'office-client' },
    browserExtension: { oauthClientId: 'ext-client' },
    nextcloudEmbed: { oauthClientId: 'nc-client' }
  };
  test.each([
    [{ path: '/api/inference/v1/chat/completions' }, 'openai_proxy'],
    [{ path: '/ihub/mcp' }, 'mcp'],
    [{ path: '/a2a' }, 'a2a'],
    [{ path: '/api/apps/x/chat/1', oauthClientId: 'office-client', platform }, 'office'],
    [{ path: '/api/apps/x/chat/1', oauthClientId: 'ext-client', platform }, 'browser_extension'],
    [{ path: '/api/apps/x/chat/1', oauthClientId: 'nc-client', platform }, 'nextcloud'],
    [{ path: '/api/apps/x/chat/1', authMode: 'teams' }, 'teams'],
    [{ path: '/api/apps/x/chat/1', oauthClientId: 'someone-else', platform }, 'web']
  ])('%j → %s', (input, channel) => {
    expect(clientChannelOf(input)).toBe(channel);
  });
});

describe('security events from audit entries', () => {
  test.each([
    [{ action: 'login', resource: 'auth', result: 'failure' }, 'login_failure'],
    [{ action: 'update', resource: 'platform', result: 'success' }, 'admin_config_change'],
    [{ action: 'update', resource: 'telemetryContentCapture' }, 'content_capture_change'],
    [{ action: 'update', resource: 'group' }, 'permission_change'],
    [{ action: 'create', resource: 'personalApiKey' }, 'api_key_change'],
    [{ action: 'create', resource: 'oauthToken' }, 'oauth_grant'],
    [{ action: 'delete', resource: 'oauthConnection' }, 'oauth_revoke'],
    [{ action: 'export', resource: 'chat' }, 'bulk_export'],
    [{ action: 'create', resource: 'chatShare' }, 'share_created'],
    [{ action: 'update', resource: 'app' }, null],
    [{ action: 'login', resource: 'auth', result: 'success' }, null]
  ])('%j → %s', (entry, event) => {
    expect(securityEventOfAudit(entry)).toBe(event);
    if (event) expect(SECURITY_EVENTS).toContain(event);
  });
});

describe('outbound requests through httpFetch', () => {
  let server;
  let port;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.statusCode = req.url === '/down' ? 503 : 200;
      res.end('ok');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));

  test('records duration by dependency kind, with error.type for an error status', async () => {
    await httpFetch(`http://127.0.0.1:${port}/ok?token=secret`, { dependency: 'ifinder' });
    await httpFetch(`http://127.0.0.1:${port}/down`, { dependency: 'llm' });
    await httpFetch(`http://127.0.0.1:${port}/ok`);
    expect(labelsOf('ihub.outbound.request.duration')).toEqual([
      { 'ihub.dependency.kind': 'ifinder' },
      { 'ihub.dependency.kind': 'llm', 'error.type': 'http_503' },
      { 'ihub.dependency.kind': 'other' }
    ]);
  });

  test('a refused connection is classified, never by its message', async () => {
    await expect(httpFetch('http://127.0.0.1:1/', { dependency: 'idp' })).rejects.toThrow();
    expect(labelsOf('ihub.outbound.request.duration')).toEqual([
      { 'ihub.dependency.kind': 'idp', 'error.type': 'connection_refused' }
    ]);
  });

  test('TLS failures are their own class', () => {
    expect(networkErrorClass({ cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } })).toEqual({
      type: 'tls',
      tls: true
    });
    expect(networkErrorClass({ code: 'ENOTFOUND' }).type).toBe('dns');
  });
});

describe('LLM call metrics', () => {
  test('in flight while it runs, time to first chunk once, surface and server on the labels', () => {
    const call = new GenAIInstrumentation({ enabled: true }).startCall({
      operation: 'chat',
      model: { modelId: 'm', url: 'https://vllm-2.internal:8000/v1/chat/completions' },
      provider: 'openai',
      surface: 'workflow'
    });
    call.firstChunk();
    call.firstChunk();
    call.succeed({});
    expect(fake.recorded['ihub.llm.requests.inflight'].map(([delta]) => delta)).toEqual([1, -1]);
    expect(labelsOf('gen_ai.client.operation.time_to_first_chunk')).toEqual([
      {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': 'm',
        'ihub.surface': 'workflow',
        'server.address': 'vllm-2.internal'
      }
    ]);
  });

  test('cache and reasoning tokens are their own token types', () => {
    const call = new GenAIInstrumentation({ enabled: true }).startCall({
      operation: 'chat',
      model: { modelId: 'm' },
      provider: 'anthropic'
    });
    call.succeed({
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, reasoningTokens: 4 }
    });
    expect(
      fake.recorded['gen_ai.client.token.usage'].map(([v, l]) => [v, l['gen_ai.token.type']])
    ).toEqual([
      [100, 'input'],
      [10, 'output'],
      [80, 'cache_read'],
      [4, 'reasoning']
    ]);
  });
});

describe('filesystem gauges', () => {
  test('a volume holding several locations is reported for each', () => {
    expect(
      volumesByMount({
        volumes: [
          { paths: [{ key: 'contents' }, { key: 'data' }], used: 5, total: 10 },
          { paths: [{ key: 'temp' }], used: 1, total: 2 }
        ]
      })
    ).toEqual([
      { mount: 'contents', used: 5, total: 10 },
      { mount: 'data', used: 5, total: 10 },
      { mount: 'temp', used: 1, total: 2 }
    ]);
  });
});
