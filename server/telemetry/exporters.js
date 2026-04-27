/**
 * OpenTelemetry Exporter Configuration
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';

/**
 * Create trace exporter based on configuration
 * @param {Object} config - Telemetry configuration
 * @returns {Object} Trace exporter
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
      break;

    case 'console':
    default:
      return new ConsoleSpanExporter();
  }

  return new ConsoleSpanExporter();
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

  // Parse headers (format: key1=value1,key2=value2)
  if (headers) {
    headers.split(',').forEach(pair => {
      const [key, value] = pair.split('=');
      if (key && value) {
        config.headers[key.trim()] = decodeURIComponent(value.trim());
      }
    });
  }

  return config;
}
