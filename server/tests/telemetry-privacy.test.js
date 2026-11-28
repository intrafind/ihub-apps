// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The privacy defaults of the LLM span (#4008, P0.2, P0.3, P0.7):
 * - the user is pseudonymised (`user.hash`) by default, never the raw login,
 *   and groups never leave the server;
 * - the conversation id is hashed;
 * - content capture is off by default; when on it is redacted, capped at
 *   4096 characters whatever the setting, and renders multimodal parts;
 * - the GenAI metrics are recorded with spans switched off, with their labels
 *   built from the call, not from the span;
 * - a failure sets `error.type` only, a stop sets `ihub.aborted`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider
} from '@opentelemetry/sdk-trace';
import tokenStorageService from '../services/TokenStorageService.js';
import { GenAIInstrumentation } from '../telemetry/GenAIInstrumentation.js';
import {
  configureIdentity,
  pseudonymise,
  resetIdentityForTests,
  userSpanAttributes
} from '../telemetry/identity.js';
import {
  configureSpans,
  filterSpanAttributes,
  resetSpansForTests,
  withSpan
} from '../telemetry/spans.js';
import {
  inputMessagesAttributes,
  MAX_CONTENT_LENGTH,
  redactContent
} from '../telemetry/contentCapture.js';
import { initializeMetrics } from '../telemetry/metrics.js';

const KEY = 'a'.repeat(64);
const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
let savedKey;

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  savedKey = tokenStorageService.encryptionKey;
});

afterAll(async () => {
  tokenStorageService.encryptionKey = savedKey;
  await provider.shutdown();
  trace.disable();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
  resetIdentityForTests();
  resetSpansForTests();
  tokenStorageService.encryptionKey = KEY;
});

function fakeMeter() {
  const histograms = {};
  const meter = {
    createHistogram: name => {
      histograms[name] = { record: jest.fn() };
      return histograms[name];
    },
    createCounter: () => ({ add: jest.fn() }),
    createObservableGauge: () => ({ addCallback: () => {} })
  };
  initializeMetrics({ getMeter: () => meter });
  return histograms;
}

const MODEL = { modelId: 'gpt-test', url: 'https://llm.example.com:8443/v1' };

function call(config, extra = {}) {
  return new GenAIInstrumentation(config).startCall({
    operation: 'chat',
    model: MODEL,
    provider: 'openai',
    appId: 'chat-app',
    userId: 'DOMAIN\\jdoe',
    conversationId: 'chat-123',
    messageCount: 3,
    isFollowUp: true,
    ...extra
  });
}

const ON = { enabled: true, spans: { enabled: true } };

describe('identity on spans', () => {
  test('pseudonymised by default: user.hash, no user.id, no groups', () => {
    configureSpans(ON);
    configureIdentity(ON);
    call(ON).succeed({});
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['user.id']).toBeUndefined();
    expect(span.attributes['user.groups']).toBeUndefined();
    expect(span.attributes['user.hash']).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(span.attributes)).not.toContain('jdoe');
  });

  test('the pseudonym is stable per user and installation key, and differs per domain', () => {
    expect(pseudonymise('jdoe', 'user')).toBe(pseudonymise('jdoe', 'user'));
    expect(pseudonymise('jdoe', 'user')).not.toBe(pseudonymise('jdoe', 'conversation'));
    const first = pseudonymise('jdoe', 'user');
    tokenStorageService.encryptionKey = 'b'.repeat(64);
    expect(pseudonymise('jdoe', 'user')).not.toBe(first);
  });

  test('the conversation id is hashed', () => {
    configureSpans(ON);
    call(ON).succeed({});
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['gen_ai.conversation.id']).toMatch(/^[0-9a-f]{32}$/);
    expect(span.attributes['gen_ai.conversation.id']).not.toBe('chat-123');
  });

  test('`off` records no user; `clear` records the login', () => {
    configureIdentity({ spans: { userIdMode: 'off' } });
    expect(userSpanAttributes('jdoe')).toEqual({});
    configureIdentity({ spans: { userIdMode: 'clear' } });
    expect(userSpanAttributes('jdoe')).toEqual({ 'user.id': 'jdoe' });
  });

  test('without the installation key no identity attribute is written, never the clear id', () => {
    tokenStorageService.encryptionKey = null;
    expect(userSpanAttributes('jdoe')).toEqual({});
  });

  test('the attribute filter drops clear ids, groups and error text', () => {
    expect(
      filterSpanAttributes({
        'user.id': 'jdoe',
        'user.groups': ['admins'],
        'error.message': 'provider said: key sk-123',
        'app.id': 'chat',
        nested: { a: 1 },
        empty: undefined
      })
    ).toEqual({ 'app.id': 'chat' });
  });
});

describe('errors and stops', () => {
  test('a failure sets error.type and ERROR, without the message', () => {
    configureSpans(ON);
    const err = Object.assign(new Error('upstream echoed the prompt'), { status: 429 });
    call(ON).fail(err);
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['error.type']).toBe('rate_limit_exceeded');
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBeUndefined();
    expect(span.events).toHaveLength(0);
  });

  test('a stop is not an error: ihub.aborted, status unset, no duration recorded', () => {
    configureSpans(ON);
    const histograms = fakeMeter();
    call(ON).fail(Object.assign(new Error('stopped'), { code: 'ABORTED' }));
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['ihub.aborted']).toBe(true);
    expect(span.attributes['error.type']).toBeUndefined();
    expect(span.status.code).toBe(0);
    expect(histograms['gen_ai.client.operation.duration'].record).not.toHaveBeenCalled();
  });

  test('ending twice ends once', () => {
    configureSpans(ON);
    const c = call(ON);
    c.succeed({});
    c.fail(new Error('late'));
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  test('withSpan makes the span active for nested spans and ends it on throw', async () => {
    configureSpans(ON);
    await expect(
      withSpan('outer', {}, async () => {
        await withSpan('inner', {}, async () => {});
        throw Object.assign(new Error('boom'), { code: 'BROKEN' });
      })
    ).rejects.toThrow('boom');
    const spans = exporter.getFinishedSpans();
    const outer = spans.find(s => s.name === 'outer');
    const inner = spans.find(s => s.name === 'inner');
    expect(inner.parentSpanContext.spanId).toBe(outer.spanContext().spanId);
    expect(outer.attributes['error.type']).toBe('BROKEN');
  });
});

describe('GenAI metrics do not depend on spans', () => {
  test('with spans off the token and duration metrics are recorded with their labels', () => {
    configureSpans({ enabled: true, spans: { enabled: false } });
    const histograms = fakeMeter();
    call({ enabled: true, spans: { enabled: false } }).succeed({
      usage: { inputTokens: 12, outputTokens: 5 }
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    const labels = {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-test',
      'app.id': 'chat-app'
    };
    expect(histograms['gen_ai.client.token.usage'].record.mock.calls).toEqual([
      [12, { ...labels, 'gen_ai.token.type': 'input' }],
      [5, { ...labels, 'gen_ai.token.type': 'output' }]
    ]);
    expect(histograms['gen_ai.client.operation.duration'].record).toHaveBeenCalledWith(
      expect.any(Number),
      labels
    );
  });
});

describe('content capture', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Mail max@example.com or call +49 89 1234567, IBAN DE89 3704 0044 0532 0130 00'
        },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    }
  ];

  test('off by default: no content attribute', () => {
    configureSpans(ON);
    const c = call(ON);
    c.recordRequest(messages, {});
    c.succeed({ outputText: 'the answer' });
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['gen_ai.input.messages']).toBeUndefined();
    expect(span.attributes['gen_ai.output.messages']).toBeUndefined();
  });

  test('on: current semconv attributes, redacted, multimodal as a blob part', () => {
    const config = {
      ...ON,
      events: { enabled: true, includePrompts: true, includeCompletions: true }
    };
    configureSpans(config);
    const c = call(config);
    c.recordRequest(messages, {});
    c.succeed({ outputText: 'Reach jane@example.org', finishReasons: ['stop'] });
    const [span] = exporter.getFinishedSpans();
    const input = JSON.parse(span.attributes['gen_ai.input.messages']);
    expect(input[1].parts).toEqual([
      {
        type: 'text',
        content: 'Mail [REDACTED:email] or call [REDACTED:phone], IBAN [REDACTED:iban]'
      },
      { type: 'blob', modality: 'image' }
    ]);
    expect(span.attributes['gen_ai.input.messages']).not.toContain('[object Object]');
    const output = JSON.parse(span.attributes['gen_ai.output.messages']);
    expect(output[0].parts[0].content).toBe('Reach [REDACTED:email]');
  });

  test('capped at 4096 characters even when maxEventSize asks for more, newest kept', () => {
    const config = {
      ...ON,
      events: { enabled: true, includePrompts: true, maxEventSize: 100000 }
    };
    const long = [
      { role: 'user', content: 'old '.repeat(3000) },
      { role: 'user', content: `${'x'.repeat(5000)} newest` }
    ];
    const { 'gen_ai.input.messages': json } = inputMessagesAttributes(long, config);
    expect(json.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].parts[0].content.endsWith('newest')).toBe(true);
  });
});

describe('redactContent', () => {
  test.each([
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghij', 'token [REDACTED:jwt]'],
    ['Authorization: Bearer abcdef0123456789', 'Authorization: Bearer [REDACTED:token]'],
    ['key sk-proj-abcdefghijklmnop1234', 'key [REDACTED:key]'],
    ['api_key=supersecretvalue&x=1', 'api_key=[REDACTED:secret]&x=1'],
    ['AKIAABCDEFGHIJKLMNOP', '[REDACTED:key]'], // gitleaks:allow (fake key, redaction test)
    ['call 0171 2345678 now', 'call [REDACTED:phone] now'],
    ['on 01.02.2024 at noon', 'on 01.02.2024 at noon'],
    ['version 1.2.3 and 42', 'version 1.2.3 and 42']
  ])('%s', (input, expected) => {
    expect(redactContent(input)).toBe(expected);
  });
});
