// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * OpenTelemetry Exporter Configuration
 */

import { OTLPTraceExporter as OTLPTraceExporterJson } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter as OTLPMetricExporterJson } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterProto } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPLogExporter as OTLPLogExporterJson } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPLogExporterProto } from '@opentelemetry/exporter-logs-otlp-proto';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace';
import { ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';
import { ConsoleLogRecordExporter } from '@opentelemetry/sdk-logs';
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
 * @param {string} signalPath - `/v1/traces`, `/v1/metrics` or `/v1/logs`.
 * @param {string} [signal] - `TRACES`, `METRICS` or `LOGS`, for the signal-specific variables.
 * @returns {{url: string, headers: Object, httpAgentOptions: Function}} Exporter options.
 */
export function otlpExporterOptions(otlpConfig, signalPath, signal = 'TRACES') {
  const url = otlpSignalUrl(otlpConfig, signalPath, signal);
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
 * The URL a signal is sent to: `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` as it is
 * (the OTel spec says a signal endpoint is the full URL), otherwise the
 * configured base endpoint plus the signal path, without a doubled slash
 * (`http://collector:4318/` used to become `…//v1/traces`).
 *
 * @param {Object} otlpConfig
 * @param {string} signalPath
 * @param {string} signal
 * @returns {string}
 */
export function otlpSignalUrl(otlpConfig, signalPath, signal) {
  const signalEndpoint = process.env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`];
  if (signalEndpoint) return signalEndpoint;
  return `${String(otlpConfig?.endpoint || '').replace(/\/+$/, '')}${signalPath}`;
}

let warnedGrpc = false;

/**
 * The OTLP protocol of a signal: `OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL`, else
 * `OTEL_EXPORTER_OTLP_PROTOCOL`, else `exporters.otlp.protocol`, else
 * `http/protobuf`. gRPC is not supported: its client cannot use the platform's
 * proxy and SSL whitelist (CLAUDE.md, "Outbound connections"), so it falls back
 * to `http/protobuf` with a warning.
 *
 * @param {Object} config - The telemetry config
 * @param {string} signal - `TRACES`, `METRICS`, `LOGS`
 * @returns {'http/json'|'http/protobuf'}
 */
export function otlpProtocol(config, signal) {
  const requested = (
    process.env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] ||
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL ||
    config?.exporters?.otlp?.protocol ||
    'http/protobuf'
  )
    .trim()
    .toLowerCase();
  if (requested === 'http/json') return 'http/json';
  if (requested === 'grpc' && !warnedGrpc) {
    warnedGrpc = true;
    logger.warn('OTLP over gRPC is not supported; exporting with http/protobuf instead', {
      component: 'Telemetry',
      note: "Point the endpoint at the collector's HTTP receiver (usually port 4318)"
    });
  }
  return 'http/protobuf';
}

/** The OTLP exporter classes per protocol and signal. */
const OTLP_EXPORTERS = {
  'http/json': {
    TRACES: OTLPTraceExporterJson,
    METRICS: OTLPMetricExporterJson,
    LOGS: OTLPLogExporterJson
  },
  'http/protobuf': {
    TRACES: OTLPTraceExporterProto,
    METRICS: OTLPMetricExporterProto,
    LOGS: OTLPLogExporterProto
  }
};

const SIGNAL_PATHS = { TRACES: '/v1/traces', METRICS: '/v1/metrics', LOGS: '/v1/logs' };

/** An OTLP exporter for a signal with the configured protocol. */
function createOtlpExporter(config, signal) {
  const Exporter = OTLP_EXPORTERS[otlpProtocol(config, signal)][signal];
  return new Exporter(otlpExporterOptions(config.exporters.otlp, SIGNAL_PATHS[signal], signal));
}

let warnedUnknownProvider = false;

/** Warn once that `provider` names no exporter: nothing is exported. */
function warnUnknownProvider(provider) {
  if (warnedUnknownProvider) return;
  warnedUnknownProvider = true;
  logger.warn('Telemetry provider names no exporter; nothing is exported', {
    component: 'Telemetry',
    provider: String(provider).slice(0, 32),
    expected: ['otlp', 'prometheus', 'console']
  });
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
  const provider = config.provider || 'none';

  switch (provider) {
    case 'otlp':
      if (config.exporters?.otlp) return createOtlpExporter(config, 'TRACES');
      return undefined;

    case 'prometheus':
      // Metrics-only mode - no span export path. Spans still flow through
      // the SDK so duration metrics stay accurate, they just don't leak to
      // stdout the way ConsoleSpanExporter would.
      return undefined;

    case 'console':
      return new ConsoleSpanExporter();

    default:
      warnUnknownProvider(provider);
      return undefined;
  }
}

/**
 * Create metric exporter based on configuration
 * @param {Object} config - Telemetry configuration
 * @returns {Object} Metric exporter
 */
export function createMetricExporter(config) {
  const provider = config.provider || 'none';

  switch (provider) {
    case 'otlp':
      if (config.exporters?.otlp) return createOtlpExporter(config, 'METRICS');
      break;

    case 'prometheus':
      // A pull exporter: `telemetry/prometheusCluster.js` creates the reader
      // and the one scrape endpoint for all workers.
      return null;

    case 'console':
      // Console mode also exports metrics to stdout for parity with span output
      return new ConsoleMetricExporter();

    default:
      // An unknown provider used to fall back to the console silently, which
      // put spans with their ids into the container log nobody asked for.
      warnUnknownProvider(provider);
      return null;
  }

  return null;
}

/**
 * Create the log record exporter: OTLP with the configured protocol, the
 * console for `provider: console`, nothing for Prometheus (metrics only).
 *
 * @param {Object} config - Telemetry configuration
 * @returns {Object|null}
 */
export function createLogExporter(config) {
  const provider = config.provider || 'none';
  if (provider === 'otlp' && config.exporters?.otlp) return createOtlpExporter(config, 'LOGS');
  if (provider === 'console') return new ConsoleLogRecordExporter();
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
