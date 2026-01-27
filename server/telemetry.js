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

let sdk = null;
let tokenUsageCounter = null;
let logger = null;

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
  console.log('Initializing telemetry... with config:', config);

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  const metricReader = config.metrics
    ? new PeriodicExportingMetricReader({
        exporter: new PrometheusExporter({ port: config.port || 9464 })
      })
    : undefined;

  sdk = new NodeSDK({
    resource: new Resource({ 'service.name': 'ihub-apps-server' }),
    traceExporter: config.traces ? new ConsoleSpanExporter() : undefined,
    instrumentations: config.traces ? [getNodeAutoInstrumentations()] : [],
    metricReader
  });

  await sdk.start();

  if (config.metrics?.enabled === true) {
    tokenUsageCounter = sdk
      .getMeterProvider()
      .getMeter('ihub-apps')
      .createCounter('token_usage_total', {
        description: 'Total number of tokens processed'
      });
  }

  if (config.logs?.enabled === true) {
    const loggerProvider = new LoggerProvider({
      resource: new Resource({ 'service.name': 'ihub-apps-server' })
    });
    loggerProvider.addLogRecordProcessor(
      new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
    );
    loggerProvider.register();
    logger = logs.getLogger('ihub-apps');
    interceptConsole();
  }
}

export function recordTokenUsage(tokens) {
  if (tokenUsageCounter) {
    tokenUsageCounter.add(tokens);
  }
}

export async function shutdownTelemetry() {
  await sdk?.shutdown();
  console.log('Telemetry shutdown completed successfully.');
}
