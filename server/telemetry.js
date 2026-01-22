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
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { GenAIInstrumentation } from './telemetry/GenAIInstrumentation.js';
import { initializeMetrics } from './telemetry/metrics.js';
import { createTraceExporter, createMetricExporter, parseOTLPEnvVars } from './telemetry/exporters.js';

let sdk = null;
let tokenUsageCounter = null;
let logger = null;
let genAIInstrumentation = null;

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
    return;
  }
  console.info('Initializing telemetry... with config:', config);

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  // Merge OTLP env vars if available
  const otlpEnvConfig = parseOTLPEnvVars();
  if (otlpEnvConfig && !config.exporters?.otlp) {
    config.exporters = config.exporters || {};
    config.exporters.otlp = otlpEnvConfig;
    config.provider = 'otlp';
  }

  // Create resource with semantic conventions
  const serviceName = config.resource?.['service.name'] || process.env.OTEL_SERVICE_NAME || 'ihub-apps';
  const serviceVersion = config.resource?.['service.version'] === 'auto'
    ? process.env.npm_package_version || '1.0.0'
    : config.resource?.['service.version'] || '1.0.0';

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    ...(config.resource || {})
  });

  // Create exporters
  const traceExporter = config.spans?.enabled !== false ? createTraceExporter(config) : undefined;
  const metricExporter = config.metrics?.enabled !== false ? createMetricExporter(config) : undefined;

  // Create metric reader
  const metricReader = metricExporter
    ? new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.metrics?.exportInterval || 60000
      })
    : undefined;

  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: config.traces ? [getNodeAutoInstrumentations()] : [],
    metricReader
  });

  await sdk.start();

  // Initialize GenAI metrics
  if (config.metrics?.enabled !== false) {
    const meterProvider = sdk.getMeterProvider();
    initializeMetrics(meterProvider);

    // Keep legacy token usage counter for backward compatibility
    tokenUsageCounter = meterProvider
      .getMeter('ihub-apps')
      .createCounter('token_usage_total', {
        description: 'Total number of tokens processed (legacy)'
      });
  }

  // Initialize GenAI instrumentation
  if (config.enabled) {
    genAIInstrumentation = new GenAIInstrumentation(config);
    console.info('GenAI instrumentation initialized');
  }

  // Initialize logging
  if (config.logs?.enabled === true) {
    const loggerProvider = new LoggerProvider({ resource });
    loggerProvider.addLogRecordProcessor(
      new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
    );
    loggerProvider.register();
    logger = logs.getLogger('ihub-apps');
    interceptConsole();
  }

  console.info('Telemetry initialization complete');
}

export function recordTokenUsage(tokens) {
  if (tokenUsageCounter) {
    tokenUsageCounter.add(tokens);
  }
}

/**
 * Get GenAI instrumentation instance
 * @returns {GenAIInstrumentation} GenAI instrumentation
 */
export function getGenAIInstrumentation() {
  return genAIInstrumentation;
}

/**
 * Check if GenAI instrumentation is enabled
 * @returns {boolean} True if enabled
 */
export function isGenAIInstrumentationEnabled() {
  return genAIInstrumentation?.isEnabled() || false;
}

export async function shutdownTelemetry() {
  await sdk?.shutdown();
  console.info('Telemetry shutdown completed successfully.');
}
