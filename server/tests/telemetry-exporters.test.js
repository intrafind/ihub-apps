// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * parseOTLPEnvVars handles the OTEL_EXPORTER_OTLP_HEADERS string format
 * documented in the OpenTelemetry spec:
 *   key1=value1,key2=value2
 *
 * Two important edge cases that broke in the original implementation:
 *   - Bearer tokens that contain `=` (base64 padding) - splitting on every
 *     `=` truncates the value silently.
 *   - Percent-encoded values - the spec allows URI encoding.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import configCache from '../configCache.js';
import {
  createMetricExporter,
  createTraceExporter,
  otlpExporterOptions,
  parseOTLPEnvVars
} from '../telemetry/exporters.js';

describe('parseOTLPEnvVars', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    process.env = { ...originalEnv };
  });

  test('returns null when endpoint is unset', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(parseOTLPEnvVars()).toBeNull();
  });

  test('returns endpoint with empty headers when no header env var', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    expect(parseOTLPEnvVars()).toEqual({
      endpoint: 'http://collector:4318',
      headers: {}
    });
  });

  test('parses simple key=value pairs', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://c:4318';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-api-key=secret,x-tenant=acme';
    const result = parseOTLPEnvVars();
    expect(result.headers).toEqual({
      'x-api-key': 'secret',
      'x-tenant': 'acme'
    });
  });

  test('preserves values that contain "=" (base64 bearer tokens)', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://c:4318';
    // base64-padded token frequently includes trailing =
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer Zm9vYmFy==';
    const result = parseOTLPEnvVars();
    expect(result.headers.Authorization).toBe('Bearer Zm9vYmFy==');
  });

  test('decodes percent-encoded header values', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://c:4318';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'X-Auth=Bearer%20token';
    const result = parseOTLPEnvVars();
    expect(result.headers['X-Auth']).toBe('Bearer token');
  });

  test('skips malformed pairs without a key', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://c:4318';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = '=foo,key=value';
    const result = parseOTLPEnvVars();
    expect(result.headers).toEqual({ key: 'value' });
  });
});

/**
 * OTLP exporters connect through the server's agent (`createAgent`): the TLS
 * whitelist and the proxy apply to the collector like to any outbound call.
 * A collector on `ssl.domainWhitelist` gets `rejectUnauthorized: false`; any
 * other host keeps full certificate verification.
 */
describe('OTLP exporters and the SSL whitelist', () => {
  /** Finds the agent factory the exporter's HTTP transport will call. */
  function findAgentFactory(root) {
    const seen = new Set();
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (typeof node.agentFactory === 'function') return node.agentFactory;
      for (const value of Object.values(node)) stack.push(value);
    }
    return null;
  }

  const ssl = { ignoreInvalidCertificates: true, domainWhitelist: ['collector.internal'] };

  beforeEach(() => {
    // Direct connection: no proxy, whatever the test environment sets.
    configCache.setCacheEntry('config/platform.json', { ssl, proxy: { enabled: false } });
  });

  afterEach(() => {
    configCache.setCacheEntry('config/platform.json', {});
  });

  test('a whitelisted collector gets an agent that accepts a private CA', async () => {
    const options = otlpExporterOptions(
      { endpoint: 'https://collector.internal:4318', headers: { 'x-tenant': 'a' } },
      '/v1/traces'
    );
    expect(options.url).toBe('https://collector.internal:4318/v1/traces');
    expect(options.headers).toEqual({ 'x-tenant': 'a' });
    const agent = await options.httpAgentOptions('https:');
    expect(agent.options.rejectUnauthorized).toBe(false);
  });

  test('a collector that is not whitelisted keeps certificate verification', async () => {
    const options = otlpExporterOptions(
      { endpoint: 'https://collector.public:4318' },
      '/v1/metrics'
    );
    const agent = await options.httpAgentOptions('https:');
    // The default agent (undefined) or one without the bypass.
    expect(agent?.options?.rejectUnauthorized).not.toBe(false);
  });

  test('a whitelisted collector behind the configured proxy keeps the bypass for the collector', async () => {
    configCache.setCacheEntry('config/platform.json', {
      ssl,
      proxy: {
        enabled: true,
        https: 'http://proxy.example:3128',
        http: 'http://proxy.example:3128'
      }
    });
    const whitelisted = await otlpExporterOptions(
      { endpoint: 'https://collector.internal:4318' },
      '/v1/traces'
    ).httpAgentOptions('https:');
    expect(whitelisted.constructor.name).toBe('TlsForwardingHttpsProxyAgent');
    expect(whitelisted._destinationTlsOptions.rejectUnauthorized).toBe(false);

    const other = await otlpExporterOptions(
      { endpoint: 'https://collector.public:4318' },
      '/v1/traces'
    ).httpAgentOptions('https:');
    expect(other.constructor.name).toBe('TlsForwardingHttpsProxyAgent');
    expect(other._destinationTlsOptions.rejectUnauthorized).toBeUndefined();
  });

  test('both exporters use that agent', async () => {
    const config = {
      provider: 'otlp',
      exporters: { otlp: { endpoint: 'https://collector.internal:4318' } }
    };
    for (const exporter of [createTraceExporter(config), createMetricExporter(config)]) {
      const factory = findAgentFactory(exporter);
      expect(typeof factory).toBe('function');
      const agent = await factory('https:');
      expect(agent.options.rejectUnauthorized).toBe(false);
      await exporter.shutdown?.();
    }
  });
});
