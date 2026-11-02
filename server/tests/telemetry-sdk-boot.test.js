// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The OpenTelemetry SDK boots and shuts down with iHub's telemetry config:
 * the metric reader reaches NodeSDK (`metricReaders`, the 0.300 option), the
 * log record processor takes the 3.x options object, and the API's named ESM
 * exports resolve. Guards the next OpenTelemetry upgrade.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metrics, trace } from '@opentelemetry/api';
import { initTelemetry, shutdownTelemetry } from '../telemetry.js';

test('console provider with spans, metrics and logs starts and shuts down', async () => {
  // Without our reader NodeSDK falls back to readers from the environment;
  // "none" makes that fallback register no meter provider, so the check below
  // sees whether iHub's own reader arrived.
  process.env.OTEL_METRICS_EXPORTER = 'none';
  await initTelemetry({
    enabled: true,
    provider: 'console',
    spans: { enabled: true },
    metrics: { enabled: true, exportInterval: 60000 },
    logs: { enabled: true }
  });
  try {
    const provider = metrics.getMeterProvider();
    assert.notEqual(
      provider.constructor.name,
      'NoopMeterProvider',
      'the metric reader did not reach NodeSDK'
    );
    assert.doesNotThrow(() => trace.getTracer('boot-test').startSpan('probe').end());
  } finally {
    await shutdownTelemetry();
  }
});
