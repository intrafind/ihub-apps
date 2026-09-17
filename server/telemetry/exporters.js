/**
 * OpenTelemetry Exporter Configuration
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';

/**
 * Create trace exporter based on configuration.
 *
 * Returning `undefined` means "spans are still created and the in-process
 * tracer remains active, but nothing exports them off-host." We use that for
 * Prometheus mode because Prometheus is a metrics-only protocol - dumping
 * spans to stdout there just spams the application logs (one ConsoleSpan
 * record per LLM call). Operators who want traces too should run an OTLP
 * collector alongside Prometheus.
 *
 * @param {Object} config - Telemetry configuration
 * @returns {Object|undefined} Trace exporter, or undefined when no export is wanted
 */
export function createTraceExporter(config) {
  const provider = config.provider || 'console';

  switch (provider) {
    case 'otlp':
      if (config.exporters?.otlp) {
        return new OTLPTraceExporter({
          url: `${config.exporters.otlp.endpoint}/v1/traces`,
          headers: config.exporters.otlp.headers || {}
        });
      }
      return undefined;

    case 'prometheus':
      // Metrics-only mode - no span export path. Spans still flow through
      // the SDK so duration metrics stay accurate, they just don't leak to
      // stdout the way ConsoleSpanExporter would.
      return undefined;

    case 'console':
      return new ConsoleSpanExporter();

    default:
      return undefined;
  }
}

/**
 * Create metric exporter based on configuration
 * @param {Object} config - Telemetry configuration
 * @returns {Object} Metric exporter
 */
export function createMetricExporter(config) {
  const provider = config.provider || 'console';

  switch (provider) {
    case 'otlp':
      if (config.exporters?.otlp) {
        return new OTLPMetricExporter({
          url: `${config.exporters.otlp.endpoint}/v1/metrics`,
          headers: config.exporters.otlp.headers || {}
        });
      }
      break;

    case 'prometheus':
      if (config.exporters?.prometheus) {
        return new PrometheusExporter({
          port: config.exporters.prometheus.port || 9464,
          host: config.exporters.prometheus.host || '0.0.0.0'
        });
      }
      break;

    case 'console':
    default:
      // Console mode also exports metrics to stdout for parity with span output
      return new ConsoleMetricExporter();
  }

  return null;
}

/**
 * Parse environment variables for OTLP configuration
 * @returns {Object} OTLP configuration from environment
 */
export function parseOTLPEnvVars() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS;

  if (!endpoint) return null;

  const config = {
    endpoint,
    headers: {}
  };

  // Parse headers (format: key1=value1,key2=value2). We split on the FIRST `=`
  // only - header values frequently contain `=` (e.g. base64-padded bearer
  // tokens like "Authorization=Bearer Zm9vYmFy=") and the previous naive split
  // silently dropped everything after the second segment.
  if (headers) {
    headers.split(',').forEach(pair => {
      const eq = pair.indexOf('=');
      if (eq <= 0) return;
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!key || !value) return;
      config.headers[key] = decodeURIComponent(value);
    });
  }

  return config;
}
