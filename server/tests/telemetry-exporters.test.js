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

import { parseOTLPEnvVars } from '../telemetry/exporters.js';

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
