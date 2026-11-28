// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Traces that hang together (#4008, P1): sampling, context carried across
 * processes and runs, async iterators bound to their span, and the lifecycle of
 * the LLM span (retries, pause_turn, stops, abandoned streams).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TracerProvider
} from '@opentelemetry/sdk-trace';
import { samplerOption } from '../telemetry.js';
import { GenAIInstrumentation } from '../telemetry/GenAIInstrumentation.js';
import {
  configureIdentity,
  resetIdentityForTests,
  setPseudonymKeySource
} from '../telemetry/identity.js';
import {
  endTurnSpan,
  endWorkflowRunSpan,
  resetTracesForTests,
  startToolSpan,
  startTurnSpan,
  startWorkflowRunSpan,
  toolSpanName,
  withA2aTaskSpan,
  withInferenceSpan,
  withMcpToolSpan
} from '../telemetry/traces.js';
import {
  configureSpans,
  extractContext,
  injectContext,
  linksFrom,
  resetSpansForTests,
  startSpan,
  withSpan
} from '../telemetry/spans.js';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
const savedEnv = { ...process.env };

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

beforeEach(() => {
  exporter.reset();
  resetSpansForTests();
  configureSpans({ enabled: true, spans: { enabled: true } });
});

afterEach(() => {
  process.env = { ...savedEnv };
});

const span = name => exporter.getFinishedSpans().find(s => s.name === name);

describe('sampling', () => {
  test('spans.sampleRate becomes ParentBased(TraceIdRatioBased)', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    const { sampler } = samplerOption({ spans: { sampleRate: 0.25 } });
    expect(sampler).toBeInstanceOf(ParentBasedSampler);
    expect(sampler.toString()).toContain('TraceIdRatioBased{0.25}');
  });

  test('out-of-range rates are clamped, a missing rate samples everything', () => {
    delete process.env.OTEL_TRACES_SAMPLER;
    expect(samplerOption({ spans: { sampleRate: 7 } }).sampler.toString()).toContain('{1}');
    expect(samplerOption({}).sampler.toString()).toContain('{1}');
  });

  test('OTEL_TRACES_SAMPLER wins: the SDK reads it itself', () => {
    process.env.OTEL_TRACES_SAMPLER = 'always_off';
    expect(samplerOption({ spans: { sampleRate: 0.5 } })).toEqual({});
  });
});

describe('context across processes and runs', () => {
  test('a carrier continues the trace on the other side', async () => {
    let carrier;
    await withSpan('sender', {}, async () => {
      carrier = injectContext();
    });
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    startSpan('receiver', { parentContext: extractContext(carrier) }).end();
    expect(span('receiver').spanContext().traceId).toBe(span('sender').spanContext().traceId);
    expect(span('receiver').parentSpanContext.spanId).toBe(span('sender').spanContext().spanId);
  });

  test('a resumed run starts a new trace with a link to the old one', async () => {
    let carrier;
    await withSpan('first', {}, async () => {
      carrier = injectContext();
    });
    startSpan('resumed', { root: true, links: linksFrom(carrier) }).end();
    const resumed = span('resumed');
    expect(resumed.spanContext().traceId).not.toBe(span('first').spanContext().traceId);
    expect(resumed.links[0].context.spanId).toBe(span('first').spanContext().spanId);
  });

  test('no carrier: no link, a root context', () => {
    expect(linksFrom(undefined)).toEqual([]);
    expect(trace.getSpanContext(extractContext(null))).toBeUndefined();
  });
});

describe('async iterators', () => {
  test('bindIterable runs every step in the span, whoever calls next()', async () => {
    const outer = startSpan('turn');
    async function* produce() {
      yield 1;
      await withSpan('inside', {}, async () => {});
      yield 2;
    }
    const seen = [];
    for await (const value of outer.bindIterable(produce())) seen.push(value);
    outer.end();
    expect(seen).toEqual([1, 2]);
    expect(span('inside').parentSpanContext.spanId).toBe(span('turn').spanContext().spanId);
  });
});

describe('the LLM span', () => {
  const call = () =>
    new GenAIInstrumentation({ enabled: true }).startCall({
      operation: 'chat',
      model: { modelId: 'm' },
      provider: 'openai'
    });

  test('is the parent of what runs inside it (the HTTP client span)', () => {
    const c = call();
    c.span.run(() => startSpan('POST').end());
    c.succeed({});
    expect(span('POST').parentSpanContext.spanId).toBe(span('chat m').spanContext().spanId);
  });

  test('retries and pause_turn continuations are events', () => {
    const c = call();
    c.retried(1, Object.assign(new Error('x'), { status: 503 }));
    c.continued(1);
    c.succeed({});
    expect(span('chat m').events.map(e => [e.name, e.attributes])).toEqual([
      ['ihub.llm.retry', { 'ihub.retry.attempt': 1, 'error.type': 'http_503' }],
      ['ihub.llm.pause_turn', { 'ihub.continuation': 1 }]
    ]);
  });

  test('a stop after the answer started is aborted, not an error', () => {
    const c = call();
    c.succeed({ aborted: true });
    expect(span('chat m').attributes['ihub.aborted']).toBe(true);
    expect(span('chat m').status.code).toBe(0);
  });

  test('an abandoned stream ends its span once', () => {
    const c = call();
    c.abandon();
    c.succeed({});
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(span('chat m').attributes['ihub.stream.abandoned']).toBe(true);
  });

  test('switching spans off while a call runs still ends its span', () => {
    const c = call();
    configureSpans({ enabled: true, spans: { enabled: false } });
    c.succeed({});
    expect(span('chat m')).toBeDefined();
  });
});

describe('traces.js helpers', () => {
  beforeEach(() => {
    resetTracesForTests();
    resetIdentityForTests();
    setPseudonymKeySource(() => 'd'.repeat(64));
    configureIdentity({});
  });

  test('runtime tool names never reach the span name', () => {
    expect(toolSpanName({ _mcp: true }, 'acme_crm_lookup_customer')).toBe('mcp');
    expect(toolSpanName({ _a2a: true }, 'remote-agent-skill')).toBe('a2a');
    expect(toolSpanName(null, 'whatever')).toBe('unknown');
    startToolSpan({ toolDef: { _mcp: true }, toolId: 'acme_crm_lookup_customer' }).end();
    expect(span('execute_tool mcp')).toBeDefined();
  });

  test('a trigger outside the closed set is `other`', () => {
    startTurnSpan({ appId: 'chat', trigger: 'cron-from-somewhere' }).end();
    expect(span('invoke_agent chat').attributes['ihub.trigger.type']).toBe('other');
  });

  test('turn, inference and A2A spans carry a pseudonymised user and a hashed chat id', async () => {
    startTurnSpan({ appId: 'chat', chatId: 'chat-42', userId: 'DOMAIN\\jdoe' }).end();
    await withInferenceSpan({ api: 'chat_completions', userId: 'DOMAIN\\jdoe' }, async () => {});
    await withA2aTaskSpan(
      { skillKind: 'app', skillId: 'chat', userId: 'DOMAIN\\jdoe' },
      async () => {}
    );
    await withMcpToolSpan({ tool: 'chat', userId: 'DOMAIN\\jdoe' }, async () => {});
    for (const s of exporter.getFinishedSpans()) {
      expect(s.attributes['user.id']).toBeUndefined();
      expect(s.attributes['user.hash']).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(s.attributes)).not.toContain('jdoe');
    }
    const turn = span('invoke_agent chat').attributes;
    expect(turn['gen_ai.conversation.id']).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(turn)).not.toContain('chat-42');
  });

  test('an aborted turn is ihub.aborted without ERROR; a failed one is ERROR with error.type', () => {
    const stopped = startTurnSpan({ appId: 'a' });
    endTurnSpan(stopped, { status: 'aborted' });
    stopped.end();
    const failed = startTurnSpan({ appId: 'b' });
    endTurnSpan(failed, { status: 'error', errorInfo: { code: 'NETWORK' } });
    failed.end();
    expect(span('invoke_agent a').attributes['ihub.aborted']).toBe(true);
    expect(span('invoke_agent a').status.code).toBe(0);
    expect(span('invoke_agent b').status.code).toBe(2);
    expect(span('invoke_agent b').attributes['error.type']).toBe('NETWORK');
  });

  test('a failed or cancelled workflow segment keeps its carrier: the resume links to it', () => {
    for (const status of ['failed', 'cancelled']) {
      exporter.reset();
      const first = startWorkflowRunSpan({ executionId: `wf-${status}` });
      endWorkflowRunSpan(first, status, `wf-${status}`);
      first.end();
      const resumed = startWorkflowRunSpan({ executionId: `wf-${status}`, resumed: true });
      endWorkflowRunSpan(resumed, 'completed', `wf-${status}`);
      resumed.end();
      const [before, after] = exporter.getFinishedSpans();
      expect(after.links.map(l => l.context.spanId)).toEqual([before.spanContext().spanId]);
    }
  });
});
