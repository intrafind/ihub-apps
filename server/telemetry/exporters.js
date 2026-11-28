// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * OpenTelemetry Exporter Configuration
 */

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace';
import { ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';
import fs from 'node:fs';
import path from 'node:path';
import configCache from '../configCache.js';
import { createAgentWithTls } from '../utils/httpConfig.js';
import logger from '../utils/logger.js';

/**
 * Reads a TLS file named by an OTel environment variable, the signal-specific
 * one first (`OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE`), then the general one
 * (`OTEL_EXPORTER_OTLP_CERTIFICATE`), relative to the working directory like
 * the OTel SDK does.
 *
 * @param {string} signal - `TRACES` or `METRICS`.
 * @param {string} suffix - `CERTIFICATE`, `CLIENT_CERTIFICATE` or `CLIENT_KEY`.
 * @returns {Buffer|undefined} The file, or undefined when none is set or it cannot be read.
 */
function readOtelTlsFile(signal, suffix) {
  const filePath =
    process.env[`OTEL_EXPORTER_OTLP_${signal}_${suffix}`] ??
    process.env[`OTEL_EXPORTER_OTLP_${suffix}`];
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(path.resolve(process.cwd(), filePath));
  } catch (error) {
    logger.warn('Failed to read OTLP TLS file', {
      component: 'Telemetry',
      variable: suffix,
      error: error.message
    });
    return undefined;
  }
}

/**
 * The TLS material the OTel SDK reads from its environment variables: a root
 * CA (`…_CERTIFICATE`) and a client certificate and key for mutual TLS
 * (`…_CLIENT_CERTIFICATE`, `…_CLIENT_KEY`), each with a signal-specific variant.
 * Supplying our own agent replaces the SDK's, which is where it would apply
 * them, so they are read here and passed to that agent instead.
 *
 * @param {string} signal - `TRACES` or `METRICS`.
 * @returns {{ca?: Buffer, cert?: Buffer, key?: Buffer}} The material that is set.
 */
export function otlpTlsOptionsFromEnv(signal) {
  const material = {
    ca: readOtelTlsFile(signal, 'CERTIFICATE'),
    cert: readOtelTlsFile(signal, 'CLIENT_CERTIFICATE'),
    key: readOtelTlsFile(signal, 'CLIENT_KEY')
  };
  return Object.fromEntries(Object.entries(material).filter(([, value]) => value !== undefined));
}

/**
 * Options for an OTLP/HTTP exporter that sends to `endpoint` + `signalPath`.
 *
 * The connection goes through the server's own agent (`createAgentWithTls`), so
 * it honours the platform's outbound settings like every other outbound call:
 * a collector on `ssl.domainWhitelist` (with "ignore invalid certificates" on)
 * may use a certificate from a private CA, and the configured proxy applies.
 * Certificates are verified for every other host. The CA and client
 * certificate from the `OTEL_EXPORTER_OTLP_*` variables still apply.
 *
 * The exporter asks the factory for its agent on its first export and keeps
 * that agent for its whole life. Telemetry starts before the platform config
 * is loaded, so until then the factory throws: that export fails and the next
 * one asks again, instead of an agent built without the SSL and proxy settings
 * sticking until the server restarts.
 *
 * @param {Object} otlpConfig - `telemetry.exporters.otlp` (`endpoint`, `headers`).
 * @param {string} signalPath - `/v1/traces` or `/v1/metrics`.
 * @param {string} [signal] - `TRACES` or `METRICS`, for the signal-specific TLS variables.
 * @returns {{url: string, headers: Object, httpAgentOptions: Function}} Exporter options.
 */
export function otlpExporterOptions(otlpConfig, signalPath, signal = 'TRACES') {
  const url = `${otlpConfig.endpoint}${signalPath}`;
  const tlsOptions = otlpTlsOptionsFromEnv(signal);
  return {
    url,
    headers: otlpConfig.headers || {},
    httpAgentOptions: () => {
      if (!configCache.getPlatform()) {
        const deferred = new Error(
          'OTLP export deferred: the platform configuration is not loaded yet'
        );
        // Classified as `deferred` by the export status, not as a failure cause.
        deferred.deferred = true;
        throw deferred;
      }
      return createAgentWithTls(url, tlsOptions);
    }
  };
}

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
        return new OTLPTraceExporter(
          otlpExporterOptions(config.exporters.otlp, '/v1/traces', 'TRACES')
        );
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
        return new OTLPMetricExporter(
          otlpExporterOptions(config.exporters.otlp, '/v1/metrics', 'METRICS')
        );
      }
      break;

    case 'prometheus':
      // A pull exporter: `telemetry/prometheusCluster.js` creates the reader
      // and the one scrape endpoint for all workers.
      return null;

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
