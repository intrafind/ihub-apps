// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How the OpenTelemetry SDK is set up (#4008, P0.1, P0.5, P0.6, P0.8):
 * - a signal that is off gets an empty processor list, so NodeSDK never falls
 *   back to its environment default (OTLP to localhost:4318);
 * - the resource has a stable instance id and the real version;
 * - auto-instrumented spans lose query strings, user info, caller addresses
 *   and exception messages before export;
 * - exports report success and failure with a closed reason;
 * - one Prometheus endpoint labels every worker's series.
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { SpanKind } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { buildResourceAttributes, buildSdkOptions, processIdentity } from '../telemetry.js';
import { RedactingSpanProcessor, redactSpan, stripUrl } from '../telemetry/spanRedaction.js';
import { isIgnoredIncomingRequest } from '../telemetry/autoInstrumentation.js';
import {
  exportFailureReason,
  getTelemetryHealth,
  getTelemetryStatus,
  resetExportStatusForTests,
  setTelemetrySetup,
  trackExporter
} from '../telemetry/exportStatus.js';
import { initializeMetrics } from '../telemetry/metrics.js';
import { mergeExpositions, startPrometheusCluster } from '../telemetry/prometheusCluster.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  resetExportStatusForTests();
});

describe('buildSdkOptions: no fallback exporters', () => {
  test('spans off and logs off: empty processor lists, never undefined', () => {
    const { options, exporters } = buildSdkOptions({
      enabled: true,
      provider: 'otlp',
      exporters: { otlp: { endpoint: 'https://otel.example.com' } },
      spans: { enabled: false },
      metrics: { enabled: false }
    });
    expect(options.spanProcessors).toEqual([]);
    expect(options.logRecordProcessors).toEqual([]);
    expect(options.metricReaders).toEqual([]);
    expect(exporters).toEqual({ traces: null, metrics: null, logs: null });
  });

  test('prometheus: no trace exporter at all (metrics only)', () => {
    const { options, exporters } = buildSdkOptions({ enabled: true, provider: 'prometheus' });
    expect(options.spanProcessors).toEqual([]);
    expect(options.metricReaders).toEqual([]);
    expect(exporters.traces).toBeNull();
  });

  test('otlp with spans on: one redacting processor in front of the batch exporter', () => {
    const { options, exporters } = buildSdkOptions({
      enabled: true,
      provider: 'otlp',
      exporters: { otlp: { endpoint: 'https://otel.example.com' } },
      metrics: { enabled: false }
    });
    expect(options.spanProcessors).toHaveLength(1);
    expect(options.spanProcessors[0]).toBeInstanceOf(RedactingSpanProcessor);
    expect(exporters.traces).toBe('otlp');
  });

  test('NodeSDK started with those options registers no tracer and no log processor, even with OTEL_* set', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    process.env.OTEL_TRACES_EXPORTER = 'otlp';
    process.env.OTEL_LOGS_EXPORTER = 'otlp';
    const { options } = buildSdkOptions({
      enabled: true,
      provider: 'prometheus',
      logs: { enabled: false }
    });
    const sdk = new NodeSDK({ ...options, resourceDetectors: [] });
    sdk.start();
    try {
      expect(sdk._tracerProvider).toBeUndefined();
      expect(sdk._loggerProvider?._sharedState?.processors ?? []).toHaveLength(0);
      expect(sdk._loggerProvider?._sharedState?.activeProcessor?.processors ?? []).toHaveLength(0);
    } finally {
      await sdk.shutdown();
    }
  });
});

describe('resource', () => {
  test('stable instance id from the host, version from the app, not 1.0.0', () => {
    process.env.HOSTNAME = 'if-ihub-0';
    process.env.APP_VERSION = '9.8.7';
    delete process.env.OTEL_SERVICE_NAME;
    const attributes = buildResourceAttributes({ resource: { 'service.version': 'auto' } });
    expect(attributes['service.instance.id']).toBe(processIdentity().instanceId);
    expect(attributes['service.instance.id']).toBe('if-ihub-0');
    expect(attributes['service.version']).toBe('9.8.7');
    expect(attributes['service.name']).toBe('ihub-apps');
  });

  test('Kubernetes downward-API variables become k8s.* attributes', () => {
    process.env.K8S_POD_NAME = 'if-ihub-0';
    process.env.K8S_NAMESPACE_NAME = 'ihub';
    const attributes = buildResourceAttributes({});
    expect(attributes['k8s.pod.name']).toBe('if-ihub-0');
    expect(attributes['k8s.namespace.name']).toBe('ihub');
  });
});

describe('span redaction before export', () => {
  test('stripUrl removes user info, query and fragment', () => {
    expect(stripUrl('https://u:p@ifinder.example.com/api/search?q=hr&token=abc#x')).toBe(
      'https://ifinder.example.com/api/search'
    );
  });

  test('a server span loses url.query, the caller address and exception text', () => {
    const span = {
      kind: SpanKind.SERVER,
      attributes: {
        'url.path': '/api/auth/oidc/callback',
        'url.query': 'code=SECRET&state=XYZ',
        'http.target': '/api/auth/oidc/callback?code=SECRET',
        'client.address': '10.1.2.3',
        'http.route': '/api/auth/oidc/callback'
      },
      events: [{ name: 'exception', attributes: { 'exception.message': 'GET ...?token=t' } }],
      status: { code: 2, message: 'failed for https://x?token=t' }
    };
    redactSpan(span);
    expect(span.attributes).toEqual({
      'url.path': '/api/auth/oidc/callback',
      'http.target': '/api/auth/oidc/callback',
      'http.route': '/api/auth/oidc/callback'
    });
    expect(span.events[0].attributes).toEqual({});
    expect(span.status.message).toBeUndefined();
    expect(JSON.stringify(span)).not.toMatch(/SECRET|token=t|10\.1\.2\.3/);
  });

  test('a client span keeps the server address but not the URL query', () => {
    const span = {
      kind: SpanKind.CLIENT,
      attributes: {
        'url.full': 'https://ifinder.example.com/sig?X-Amz-Signature=abc&key=k',
        'server.address': 'ifinder.example.com'
      }
    };
    redactSpan(span);
    expect(span.attributes).toEqual({
      'url.full': 'https://ifinder.example.com/sig',
      'server.address': 'ifinder.example.com'
    });
  });

  test('a span the redaction cannot handle is dropped, not exported as is', () => {
    const next = { onEnd: jest.fn(), onStart: jest.fn() };
    const processor = new RedactingSpanProcessor(next);
    const broken = { kind: SpanKind.SERVER };
    Object.defineProperty(broken, 'attributes', {
      get() {
        throw new Error('broken');
      }
    });
    processor.onEnd(broken);
    expect(next.onEnd).not.toHaveBeenCalled();
  });

  test('spans switched off at runtime are dropped, auto-instrumented ones included', () => {
    const next = { onEnd: jest.fn(), onStart: jest.fn() };
    let exportEnabled = true;
    const processor = new RedactingSpanProcessor(next, () => ({ exportEnabled }));
    const span = () => ({ kind: SpanKind.CLIENT, attributes: { 'url.full': 'https://x/y' } });
    processor.onEnd(span());
    exportEnabled = false;
    processor.onEnd(span());
    expect(next.onEnd).toHaveBeenCalledTimes(1);
  });

  test('health probes and static assets get no inbound span', () => {
    expect(isIgnoredIncomingRequest({ url: '/api/health' })).toBe(true);
    expect(isIgnoredIncomingRequest({ url: '/ihub/api/ready?x=1' })).toBe(true);
    expect(isIgnoredIncomingRequest({ url: '/assets/index-abc.js' })).toBe(true);
    expect(isIgnoredIncomingRequest({ url: '/api/apps/chat/chat/1' })).toBe(false);
  });
});

describe('export status', () => {
  test('failure reasons come from a closed set, never the message', () => {
    expect(exportFailureReason({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })).toBe('tls');
    expect(exportFailureReason({ cause: { code: 'ECONNREFUSED' } })).toBe('connection_refused');
    expect(exportFailureReason({ code: 503 })).toBe('http_5xx');
    expect(exportFailureReason({ code: 401 })).toBe('authentication');
    expect(exportFailureReason({ message: 'Bearer abc failed' })).toBe('unknown');
  });

  test('a tracked exporter reports success and failure, and counts failures by reason', async () => {
    const added = [];
    initializeMetrics({
      getMeter: () => ({
        createHistogram: () => ({ record: () => {} }),
        createCounter: name => ({
          add: (value, labels) => name === 'ihub.telemetry.export.failures' && added.push(labels)
        }),
        createUpDownCounter: () => ({ add: () => {} }),
        createObservableGauge: () => ({ addCallback: () => {} })
      })
    });
    setTelemetrySetup({ enabled: true, provider: 'otlp', exporters: { traces: 'otlp' } });
    let next = { code: 1, error: { code: 'ECONNREFUSED' } };
    const exporter = trackExporter({ export: (items, done) => done(next) }, 'traces');
    await new Promise(resolve => exporter.export([], resolve));
    expect(getTelemetryStatus().signals.traces).toMatchObject({
      status: 'failing',
      lastFailureReason: 'connection_refused',
      failures: 1
    });
    expect(added).toEqual([{ 'telemetry.signal': 'traces', 'error.type': 'connection_refused' }]);
    next = { code: 0 };
    await new Promise(resolve => exporter.export([], resolve));
    expect(getTelemetryStatus().signals.traces.status).toBe('ok');
    expect(getTelemetryHealth()).toEqual({
      enabled: true,
      signals: {
        traces: { status: 'ok', lastSuccessAt: expect.any(String) },
        metrics: { status: 'off', lastSuccessAt: null },
        logs: { status: 'off', lastSuccessAt: null }
      }
    });
  });
});

describe('Prometheus: one endpoint for all workers', () => {
  test('mergeExpositions labels every sample with its worker and keeps HELP/TYPE once', () => {
    const text = worker =>
      [
        '# HELP ihub_errors_total Errors',
        '# TYPE ihub_errors_total counter',
        `ihub_errors_total{error_type="x"} ${worker}`,
        '# HELP up_s Up',
        '# TYPE up_s gauge',
        'up_s 1',
        '# HELP target_info Target metadata',
        '# TYPE target_info gauge',
        `target_info{service_name="ihub-apps",cluster_worker_id="${worker - 1}"} 1`,
        ''
      ].join('\n');
    const merged = mergeExpositions([
      { workerId: '0', text: text(1) },
      { workerId: '1', text: text(2) }
    ]);
    expect(merged).toBe(
      [
        '# HELP ihub_errors_total Errors',
        '# TYPE ihub_errors_total counter',
        'ihub_errors_total{cluster_worker_id="0",error_type="x"} 1',
        'ihub_errors_total{cluster_worker_id="1",error_type="x"} 2',
        '',
        '# HELP up_s Up',
        '# TYPE up_s gauge',
        'up_s{cluster_worker_id="0"} 1',
        'up_s{cluster_worker_id="1"} 1',
        '',
        '# HELP target_info Target metadata',
        '# TYPE target_info gauge',
        'target_info{service_name="ihub-apps",cluster_worker_id="0"} 1',
        'target_info{service_name="ihub-apps",cluster_worker_id="1"} 1',
        ''
      ].join('\n')
    );
  });

  async function scrapeOver(cluster) {
    // A reader collects only once a meter provider has it.
    new MeterProvider({ readers: [cluster.reader] });
    if (!cluster.server.listening)
      await new Promise(resolve => cluster.server.once('listening', resolve));
    const { port } = cluster.server.address();
    return fetch(`http://127.0.0.1:${port}/metrics`);
  }

  test('a scrape a worker did not answer is served but not counted as a success', async () => {
    setTelemetrySetup({
      enabled: true,
      provider: 'prometheus',
      exporters: { metrics: 'prometheus' }
    });
    const complete = startPrometheusCluster({
      host: '127.0.0.1',
      port: 0,
      workerId: '0',
      workerCount: 1
    });
    expect((await scrapeOver(complete)).status).toBe(200);
    expect(getTelemetryStatus().signals.metrics.status).toBe('ok');
    await complete.close();

    // Two workers configured, no cluster bus here: the other one never answers.
    const partial = startPrometheusCluster({
      host: '127.0.0.1',
      port: 0,
      workerId: '0',
      workerCount: 2
    });
    expect((await scrapeOver(partial)).status).toBe(200);
    expect(getTelemetryStatus().signals.metrics).toMatchObject({
      status: 'failing',
      lastFailureReason: 'incomplete'
    });
    await partial.close();
  });

  test('a port that cannot be bound marks metrics export as failing', async () => {
    setTelemetrySetup({
      enabled: true,
      provider: 'prometheus',
      exporters: { metrics: 'prometheus' }
    });
    const first = startPrometheusCluster({
      host: '127.0.0.1',
      port: 0,
      workerId: '0',
      workerCount: 1
    });
    await new Promise(resolve => first.server.once('listening', resolve));
    const { port } = first.server.address();
    const second = startPrometheusCluster({
      host: '127.0.0.1',
      port,
      workerId: '0',
      workerCount: 1
    });
    await new Promise(resolve => second.server.once('error', () => setImmediate(resolve)));
    expect(getTelemetryStatus().signals.metrics).toMatchObject({
      status: 'failing',
      lastFailureReason: 'network'
    });
    await first.close();
    await second.close();
  });

  test('a real reader scrapes with the worker label (single process)', async () => {
    const cluster = startPrometheusCluster({
      host: '127.0.0.1',
      port: 0,
      workerId: '3',
      workerCount: 1,
      listen: false
    });
    const provider = new MeterProvider({ readers: [cluster.reader] });
    provider.getMeter('t').createCounter('ihub.test.things').add(2, { kind: 'a' });
    const text = await cluster.scrape();
    expect(text).toMatch(/ihub_test_things_total\{cluster_worker_id="3",kind="a"[^}]*\} 2/);
    await cluster.close();
    await provider.shutdown();
  });
});
