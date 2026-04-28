import appLogger from './utils/logger.js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import apiPkg from '@opentelemetry/api';
const { diag, DiagConsoleLogger, DiagLogLevel, metrics: metricsApi } = apiPkg;
import { ConsoleLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { GenAIInstrumentation } from './telemetry/GenAIInstrumentation.js';
import { initializeMetrics } from './telemetry/metrics.js';
import {
  createTraceExporter,
  createMetricExporter,
  parseOTLPEnvVars
} from './telemetry/exporters.js';

let sdk = null;
let tokenUsageCounter = null;
let genAIInstrumentation = null;
let activeConfig = null;

/**
 * Flatten a nested object of resource attributes to dotted keys. Used so that
 * config like `{ service: { name: 'x', version: 'y' } }` becomes
 * `{ 'service.name': 'x', 'service.version': 'y' }` - which is what the
 * OpenTelemetry semantic conventions expect.
 */
function flattenResourceAttributes(obj, prefix = '', acc = {}) {
  for (const [key, value] of Object.entries(obj || {})) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenResourceAttributes(value, flatKey, acc);
    } else {
      acc[flatKey] = value;
    }
  }
  return acc;
}

/**
 * Build a log-safe view of the telemetry config: drop OTLP headers entirely
 * (they may contain Bearer tokens / API keys) and only surface non-sensitive
 * routing metadata.
 */
function describeConfigForLog(config) {
  return {
    enabled: !!config.enabled,
    provider: config.provider,
    exporters: {
      otlp: config.exporters?.otlp
        ? {
            endpoint: config.exporters.otlp.endpoint,
            protocol: config.exporters.otlp.protocol,
            // headers intentionally omitted
            headerCount: Object.keys(config.exporters.otlp.headers || {}).length
          }
        : undefined,
      prometheus: config.exporters?.prometheus
    },
    spans: config.spans,
    metrics: config.metrics,
    events: {
      enabled: config.events?.enabled,
      includePrompts: !!config.events?.includePrompts,
      includeCompletions: !!config.events?.includeCompletions,
      maxEventSize: config.events?.maxEventSize
    },
    activitySummary: config.activitySummary,
    resource: config.resource
  };
}

export async function initTelemetry(config = {}) {
  if (!config.enabled) {
    activeConfig = config;
    return;
  }
  appLogger.info('Initializing telemetry', {
    component: 'Telemetry',
    config: describeConfigForLog(config)
  });

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  // Merge OTLP env vars when set and admin hasn't configured the OTLP exporter
  const otlpEnvConfig = parseOTLPEnvVars();
  if (otlpEnvConfig && !config.exporters?.otlp?.endpoint) {
    config.exporters = config.exporters || {};
    config.exporters.otlp = { ...otlpEnvConfig, ...(config.exporters.otlp || {}) };
    if (!config.provider || config.provider === 'console') {
      config.provider = 'otlp';
    }
  }

  // Accept both shapes: the dotted form `'service.name'` (the OpenTelemetry
  // attribute key) and the nested form `service: { name: ... }` (which is what
  // ctx.setDefault produces when the migration walks the dotted path).
  const flatService = config.resource?.['service.name'];
  const nestedService = config.resource?.service?.name;
  const serviceName = flatService || nestedService || process.env.OTEL_SERVICE_NAME || 'ihub-apps';

  const flatVersion = config.resource?.['service.version'];
  const nestedVersion = config.resource?.service?.version;
  const rawVersion = flatVersion ?? nestedVersion;
  const serviceVersion =
    rawVersion === 'auto' || !rawVersion ? process.env.npm_package_version || '1.0.0' : rawVersion;

  // @opentelemetry/resources v2.x removed the `new Resource(...)` class form.
  // Use the factory `resourceFromAttributes` so we work on the version range
  // declared in package.json (^2.0.1).
  //
  // The migration writes nested objects via setDefault on dotted paths:
  //   `telemetry.resource.service.name` → { resource: { service: { name } } }
  // If we spread that directly the nested `service` object also becomes an
  // attribute named `service` next to the proper `service.name` key. Flatten
  // the nested config first, then let our resolved service.name/version win.
  const flatResource = flattenResourceAttributes(config.resource || {});
  const resource = resourceFromAttributes({
    ...flatResource,
    'service.name': serviceName,
    'service.version': serviceVersion
  });

  // Create exporters based on the configured provider
  const traceExporter = config.spans?.enabled !== false ? createTraceExporter(config) : undefined;
  const metricExporter =
    config.metrics?.enabled !== false ? createMetricExporter(config) : undefined;

  // Prometheus is itself a MetricReader - use it directly. Other exporters get wrapped.
  let metricReader;
  if (metricExporter) {
    if (config.provider === 'prometheus' || metricExporter instanceof PrometheusExporter) {
      metricReader = metricExporter;
    } else {
      metricReader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.metrics?.exportInterval || 60000
      });
    }
  }

  // Optional log emission. NodeSDK in v0.202 accepts an array of log record
  // processors and registers the LoggerProvider globally - the v1
  // `loggerProvider.register()` API was removed, and the singular
  // `logRecordProcessor` option is now deprecated in favour of
  // `logRecordProcessors`.
  const logsEnabled = config.logs?.enabled === true || config.logs === true;
  const logRecordProcessors = logsEnabled
    ? [new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())]
    : undefined;

  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: config.autoInstrumentation === true ? [getNodeAutoInstrumentations()] : [],
    metricReader,
    logRecordProcessors
  });

  await sdk.start();

  if (config.metrics?.enabled !== false) {
    // sdk-node v0.202 / sdk-metrics v2.x removed `sdk.getMeterProvider()`.
    // Once `sdk.start()` returns the SDK has registered its provider as the
    // global one, so we acquire meters via the @opentelemetry/api facade.
    initializeMetrics(metricsApi);

    // Keep legacy token usage counter for backward compatibility
    tokenUsageCounter = metricsApi.getMeter('ihub-apps').createCounter('token_usage_total', {
      description: 'Total number of tokens processed (legacy)'
    });
  }

  // Initialize GenAI instrumentation now that SDK is up
  genAIInstrumentation = new GenAIInstrumentation(config);

  activeConfig = config;
  appLogger.info('Telemetry initialization complete', {
    component: 'Telemetry',
    provider: config.provider,
    logsEnabled
  });
}

export function recordTokenUsage(tokens) {
  if (tokenUsageCounter) {
    tokenUsageCounter.add(tokens);
  }
}

export function getGenAIInstrumentation() {
  return genAIInstrumentation;
}

export function isGenAIInstrumentationEnabled() {
  return genAIInstrumentation?.isEnabled() || false;
}

export function getActiveTelemetryConfig() {
  return activeConfig;
}

/**
 * Apply runtime-mutable parts of the telemetry configuration without restarting
 * the OpenTelemetry SDK. Use this when admins change config through the UI.
 *
 * Keep in sync with documentation: settings that *require* restart include
 * `enabled`, `provider`, `exporters.*`, and `metrics.exportInterval`.
 *
 * Settings that take effect immediately:
 *   - events.includePrompts / events.includeCompletions
 *   - events.maxEventSize
 *   - spans.includeOptInAttributes
 *   - activitySummary.*
 */
export function reloadTelemetryConfig(newConfig = {}) {
  // Updating activeConfig propagates to GenAIInstrumentation (it reads from
  // its own copy) - so we must mutate that as well.
  activeConfig = { ...(activeConfig || {}), ...newConfig };
  if (genAIInstrumentation) {
    genAIInstrumentation.config = activeConfig;
    // Re-evaluate the enabled flag - the constructor derived it from
    // config.enabled && config.spans.enabled, so mutating config alone won't
    // pick up admin UI toggles for span emission.
    genAIInstrumentation.enabled =
      activeConfig?.enabled !== false && activeConfig?.spans?.enabled !== false;
  }
}

export async function shutdownTelemetry() {
  await sdk?.shutdown();
  appLogger.info('Telemetry shutdown completed successfully', { component: 'Telemetry' });
}
