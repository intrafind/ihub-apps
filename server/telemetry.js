import appLogger from './utils/logger.js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import apiPkg from '@opentelemetry/api';
const { diag, DiagConsoleLogger, DiagLogLevel, logs } = apiPkg;
import {
  LoggerProvider,
  ConsoleLogRecordExporter,
  SimpleLogRecordProcessor
} from '@opentelemetry/sdk-logs';
import resourcesPkg from '@opentelemetry/resources';
const { Resource } = resourcesPkg;
import { GenAIInstrumentation } from './telemetry/GenAIInstrumentation.js';
import { initializeMetrics } from './telemetry/metrics.js';
import {
  createTraceExporter,
  createMetricExporter,
  parseOTLPEnvVars
} from './telemetry/exporters.js';

let sdk = null;
let tokenUsageCounter = null;
let logger = null;
let genAIInstrumentation = null;
let activeConfig = null;

function interceptConsole() {
  if (!logger) return;
  const levels = {
    log: 'INFO',
    info: 'INFO',
    warn: 'WARN',
    error: 'ERROR'
  };
  Object.keys(levels).forEach(level => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      logger.emit({ body: args.join(' '), severityText: levels[level] });
      original(...args);
    };
  });
}

export async function initTelemetry(config = {}) {
  if (!config.enabled) {
    activeConfig = config;
    return;
  }
  appLogger.info('Initializing telemetry', { component: 'Telemetry', config });

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

  const serviceName =
    config.resource?.['service.name'] || process.env.OTEL_SERVICE_NAME || 'ihub-apps';
  const serviceVersion =
    config.resource?.['service.version'] === 'auto' || !config.resource?.['service.version']
      ? process.env.npm_package_version || '1.0.0'
      : config.resource['service.version'];

  const resource = new Resource({
    'service.name': serviceName,
    'service.version': serviceVersion,
    ...(config.resource || {})
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

  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: config.autoInstrumentation === true ? [getNodeAutoInstrumentations()] : [],
    metricReader
  });

  await sdk.start();

  if (config.metrics?.enabled !== false) {
    const meterProvider = sdk.getMeterProvider();
    initializeMetrics(meterProvider);

    // Keep legacy token usage counter for backward compatibility
    tokenUsageCounter = meterProvider.getMeter('ihub-apps').createCounter('token_usage_total', {
      description: 'Total number of tokens processed (legacy)'
    });
  }

  // Initialize GenAI instrumentation now that SDK is up
  genAIInstrumentation = new GenAIInstrumentation(config);

  if (config.logs?.enabled === true) {
    const loggerProvider = new LoggerProvider({ resource });
    loggerProvider.addLogRecordProcessor(
      new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
    );
    loggerProvider.register();
    logger = logs.getLogger('ihub-apps');
    interceptConsole();
  } else if (config.logs === true) {
    // Backwards compat with old `logs: true` shorthand
    const loggerProvider = new LoggerProvider({ resource });
    loggerProvider.addLogRecordProcessor(
      new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
    );
    loggerProvider.register();
    logger = logs.getLogger('ihub-apps');
    interceptConsole();
  }

  activeConfig = config;
  appLogger.info('Telemetry initialization complete', {
    component: 'Telemetry',
    provider: config.provider
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
  }
}

export async function shutdownTelemetry() {
  await sdk?.shutdown();
  appLogger.info('Telemetry shutdown completed successfully', { component: 'Telemetry' });
}
