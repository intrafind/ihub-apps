// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Telemetry in production (#4008, P3): OTLP protocol and endpoint selection,
 * the standard OTEL_* variables, no silent console fallback, the log bridge's
 * privacy filter, trace ids on log lines, readiness, and the resource rename.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import winston from 'winston';
import { context, logs, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor
} from '@opentelemetry/sdk-logs';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider
} from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter as ProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPTraceExporter as JsonTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  createLogExporter,
  createMetricExporter,
  createTraceExporter,
  otlpProtocol,
  otlpSignalUrl
} from '../telemetry/exporters.js';
import { metricExportInterval, sdkDisabledByEnv, shutdownTelemetry } from '../telemetry.js';
import { exportedLogAttributes, OtelLogTransport } from '../telemetry/logBridge.js';
import { configureSpans, resetSpansForTests, withSpan } from '../telemetry/spans.js';
import {
  configureIdentity,
  resetIdentityForTests,
  setPseudonymKeySource
} from '../telemetry/identity.js';
import logger, { addLogTransport } from '../utils/logger.js';
import { readinessChecks } from '../routes/generalRoutes.js';
import { up as v268 } from '../migrations/V268__telemetry_semconv_resource.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

const OTLP = { provider: 'otlp', exporters: { otlp: { endpoint: 'https://otel.example.com/' } } };

describe('OTLP endpoint and protocol', () => {
  test('a trailing slash no longer doubles the path', () => {
    expect(otlpSignalUrl({ endpoint: 'https://otel.example.com/' }, '/v1/traces', 'TRACES')).toBe(
      'https://otel.example.com/v1/traces'
    );
  });

  test('a signal endpoint variable is used as the full URL', () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://logs.example.com/ingest';
    expect(otlpSignalUrl({ endpoint: 'https://otel.example.com' }, '/v1/logs', 'LOGS')).toBe(
      'https://logs.example.com/ingest'
    );
  });

  test('http/protobuf is the default and really protobuf; http/json is JSON', () => {
    expect(otlpProtocol(OTLP, 'TRACES')).toBe('http/protobuf');
    expect(createTraceExporter(OTLP)).toBeInstanceOf(ProtoTraceExporter);
    const json = {
      ...OTLP,
      exporters: { otlp: { ...OTLP.exporters.otlp, protocol: 'http/json' } }
    };
    expect(createTraceExporter(json)).toBeInstanceOf(JsonTraceExporter);
  });

  test('the environment wins over the config; grpc falls back to http/protobuf', () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    expect(otlpProtocol(OTLP, 'METRICS')).toBe('http/json');
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'grpc';
    expect(otlpProtocol(OTLP, 'METRICS')).toBe('http/protobuf');
  });

  test('an unknown or missing provider exports nothing, not to the console', () => {
    expect(createTraceExporter({ provider: 'jaeger' })).toBeUndefined();
    expect(createMetricExporter({})).toBeNull();
    expect(createLogExporter({ provider: 'prometheus' })).toBeNull();
    expect(createLogExporter(OTLP)).not.toBeNull();
  });
});

describe('standard variables', () => {
  test('OTEL_METRIC_EXPORT_INTERVAL wins over metrics.exportInterval', () => {
    expect(metricExportInterval({ metrics: { exportInterval: 30000 } })).toBe(30000);
    process.env.OTEL_METRIC_EXPORT_INTERVAL = '15000';
    expect(metricExportInterval({ metrics: { exportInterval: 30000 } })).toBe(15000);
  });

  test('OTEL_SDK_DISABLED switches telemetry off', () => {
    expect(sdkDisabledByEnv()).toBe(false);
    process.env.OTEL_SDK_DISABLED = 'true';
    expect(sdkDisabledByEnv()).toBe(true);
  });

  test('shutdown without a running SDK returns within its budget', async () => {
    const started = Date.now();
    await shutdownTelemetry({ timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('logs', () => {
  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })]
  });
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })]
  });
  const captured = [];

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(tracerProvider);
    logs.setGlobalLoggerProvider(loggerProvider);
    configureSpans({ enabled: true });
    setPseudonymKeySource(() => 'c'.repeat(64));
    configureIdentity({});
    addLogTransport(
      new (class extends winston.Transport {
        log(info, callback) {
          captured.push(info);
          callback();
        }
      })()
    );
    addLogTransport(new OtelLogTransport({ level: 'info' }));
  });

  afterAll(async () => {
    resetSpansForTests();
    resetIdentityForTests();
    await loggerProvider.shutdown();
    await tracerProvider.shutdown();
    logs.disable();
    trace.disable();
    context.disable();
  });

  test('a log line inside a span carries its trace and span id', async () => {
    await withSpan('work', {}, async span => {
      logger.info('Inside the span', { component: 'Test' });
      expect(captured.at(-1)).toMatchObject({
        trace_id: span.spanContext.traceId,
        span_id: span.spanContext.spanId
      });
    });
    logger.info('Outside', { component: 'Test' });
    expect(captured.at(-1).trace_id).toBeUndefined();
  });

  test('an exported record keeps the component and codes, pseudonymises the user, drops the rest', async () => {
    logExporter.reset();
    await withSpan('work', {}, async span => {
      logger.warn('Model call failed', {
        component: 'LLMClient',
        modelId: 'gpt-x',
        errorCode: 'NETWORK',
        userId: 'DOMAIN\\jdoe',
        ip: '10.1.2.3',
        query: 'salary of jane',
        error: Object.assign(new Error('upstream said: sk-secret'), { code: 'ECONNRESET' })
      });
      const [record] = logExporter.getFinishedLogRecords();
      expect(record.severityText).toBe('WARN');
      expect(record.body).toBe('Model call failed');
      expect(record.spanContext.traceId).toBe(span.spanContext.traceId);
      expect(record.attributes).toEqual({
        component: 'LLMClient',
        modelId: 'gpt-x',
        errorCode: 'NETWORK',
        'error.type': 'ECONNRESET',
        'user.hash': expect.stringMatching(/^[0-9a-f]{32}$/)
      });
    });
  });

  test('nested objects and unknown fields are not exported', () => {
    expect(exportedLogAttributes({ component: 'x', nested: { a: 1 } })).toEqual({ component: 'x' });
  });
});

describe('readiness', () => {
  test('names what is not ready', async () => {
    const checks = await readinessChecks();
    expect(Object.keys(checks).sort()).toEqual(['config', 'contents', 'storage']);
    // No config cache and no storage provider in this test process.
    expect(checks.config).toBe('not_loaded');
    expect(checks.storage).toBe('not_ready');
  });
});

describe('V268: deployment.environment.name', () => {
  function ctxFor(config) {
    const written = [];
    return {
      written,
      readJson: async () => structuredClone(config),
      writeJson: async (_, data) => written.push(data),
      log: () => {}
    };
  }

  test('both shapes become the flat new key; an own value wins', async () => {
    const ctx = ctxFor({
      telemetry: {
        resource: {
          'service.name': 'ihub-apps',
          'deployment.environment': 'staging',
          deployment: { environment: '${NODE_ENV:-production}' }
        }
      }
    });
    await v268(ctx);
    expect(ctx.written[0].telemetry.resource).toEqual({
      'service.name': 'ihub-apps',
      'deployment.environment.name': 'staging'
    });
  });

  test('nothing to do: nothing written', async () => {
    const ctx = ctxFor({ telemetry: { resource: { 'deployment.environment.name': 'prod' } } });
    await v268(ctx);
    expect(ctx.written).toHaveLength(0);
  });
});
