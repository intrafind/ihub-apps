// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import cluster from 'node:cluster';
import fs from 'node:fs';
import os from 'node:os';
import appLogger from './utils/logger.js';
import { resolveEnvVarsInObject } from './utils/envVars.js';
import { getAppVersion } from './utils/versionHelper.js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler
} from '@opentelemetry/sdk-trace';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
// Named imports: @opentelemetry/api 1.10 ships a real ESM build without a default export.
import { diag, DiagLogLevel, metrics as metricsApi } from '@opentelemetry/api';
import { ConsoleLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  envDetector,
  hostDetector,
  osDetector,
  resourceFromAttributes
} from '@opentelemetry/resources';
import { containerDetector } from '@opentelemetry/resource-detector-container';
import { GenAIInstrumentation } from './telemetry/GenAIInstrumentation.js';
import { initializeMetrics, registerTelemetryStatusObservers } from './telemetry/metrics.js';
import { initializeProcessMetrics } from './telemetry/ProcessMetrics.js';
import {
  createTraceExporter,
  createMetricExporter,
  parseOTLPEnvVars
} from './telemetry/exporters.js';
import { createInstrumentations } from './telemetry/autoInstrumentation.js';
import { RedactingSpanProcessor } from './telemetry/spanRedaction.js';
import { configureSpans } from './telemetry/spans.js';
import {
  configureIdentity,
  resolveUserIdMode,
  setPseudonymKeySource
} from './telemetry/identity.js';
import { capturesCompletions, capturesPrompts, contentCap } from './telemetry/contentCapture.js';
import {
  getTelemetryStatus,
  lastSuccessTimestamps,
  setSignalEnabled,
  setTelemetrySetup,
  trackExporter
} from './telemetry/exportStatus.js';
import { startPrometheusCluster } from './telemetry/prometheusCluster.js';
import { getConfiguredWorkerCount } from './telemetry/workerCount.js';
import { decryptIfEncrypted } from './utils/configSecrets.js';
import tokenStorageService from './services/TokenStorageService.js';

export { getTelemetryStatus };

let sdk = null;
let genAIInstrumentation = null;
let activeConfig = null;
let prometheusCluster = null;
// No span processor was registered at startup; turning spans on needs a restart.
let spansStartedDisabled = false;

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

/**
 * Routes the OpenTelemetry SDK's own diagnostics (export errors, collection
 * errors) into the application log at WARN and above, instead of stdout.
 * Only the message and the error code are kept: an argument can be a response
 * body or a request with headers.
 */
class AppDiagLogger {
  error(message, ...args) {
    appLogger.error('OpenTelemetry SDK error', {
      component: 'OpenTelemetry',
      ...summarize(message, args)
    });
  }
  warn(message, ...args) {
    appLogger.warn('OpenTelemetry SDK warning', {
      component: 'OpenTelemetry',
      ...summarize(message, args)
    });
  }
  info() {}
  debug() {}
  verbose() {}
}

function summarize(message, args) {
  const error = args.find(arg => arg instanceof Error);
  return {
    detail: typeof message === 'string' ? message.slice(0, 300) : undefined,
    errorName: error?.name,
    errorCode:
      typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : undefined
  };
}

/**
 * The OTLP headers in plain text. platform.json stores them encrypted
 * (`ENC[...]`); telemetry starts before the config cache, so it decrypts them
 * itself, loading the installation key first when needed.
 *
 * @param {Object} config - The telemetry config (headers replaced in place)
 */
async function decryptOtlpHeaders(config) {
  const headers = config.exporters?.otlp?.headers;
  if (!headers || typeof headers !== 'object') return;
  const encrypted = Object.values(headers).some(
    value => typeof value === 'string' && tokenStorageService.isEncrypted(value)
  );
  if (!encrypted) return;
  if (!tokenStorageService.encryptionKey) await tokenStorageService.initializeEncryptionKey();
  for (const [name, value] of Object.entries(headers)) {
    headers[name] = decryptIfEncrypted(value, {
      configPath: 'config/platform.json',
      setting: 'telemetry.exporters.otlp.headers'
    });
  }
}

/**
 * This process's stable identity. `service.instance.id` defaults to a random
 * UUID per process in the SDK, which through `resource_to_telemetry_conversion`
 * becomes a new series set on every restart of every worker. Here it is the
 * host (the pod name in Kubernetes) plus the worker slot, which survive
 * restarts.
 *
 * @returns {{instanceId: string, workerId: string|null}}
 */
export function processIdentity() {
  const host = process.env.HOSTNAME || os.hostname() || 'ihub';
  const workerId = cluster.isWorker
    ? String(process.env.WORKER_INDEX ?? cluster.worker?.id ?? '0')
    : null;
  return { instanceId: workerId === null ? host : `${host}-w${workerId}`, workerId };
}

/**
 * Kubernetes resource attributes from downward-API variables, when set.
 *
 * @returns {Object}
 */
function kubernetesAttributes() {
  const pick = (...names) => names.map(name => process.env[name]).find(Boolean);
  const attributes = {
    'k8s.pod.name': pick('K8S_POD_NAME', 'POD_NAME'),
    'k8s.namespace.name': pick('K8S_NAMESPACE_NAME', 'POD_NAMESPACE'),
    'k8s.node.name': pick('K8S_NODE_NAME', 'NODE_NAME')
  };
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value));
}

/**
 * The resource of this process: config attributes, service name and version,
 * stable instance id, worker id and Kubernetes attributes.
 *
 * @param {Object} config
 */
export function buildResourceAttributes(config) {
  // Accept both shapes: the dotted form `'service.name'` (the OpenTelemetry
  // attribute key) and the nested form `service: { name: ... }` (which is what
  // ctx.setDefault produces when the migration walks the dotted path).
  const flatResource = flattenResourceAttributes(config.resource || {});
  const serviceName = flatResource['service.name'] || process.env.OTEL_SERVICE_NAME || 'ihub-apps';
  const rawVersion = flatResource['service.version'];
  // `npm_package_version` is unset under plain `node` (Docker), so the version
  // comes from the same place the rest of the server reads it.
  const serviceVersion = rawVersion === 'auto' || !rawVersion ? getAppVersion() : rawVersion;
  const { instanceId, workerId } = processIdentity();
  return {
    'service.instance.id': instanceId,
    ...kubernetesAttributes(),
    ...flatResource,
    'service.name': serviceName,
    'service.version': serviceVersion,
    ...(workerId !== null ? { 'cluster.worker.id': workerId } : {})
  };
}

/**
 * The trace sampler: `spans.sampleRate` (0–1) of new traces, and whatever the
 * caller decided for a trace that arrives with a parent
 * (`ParentBased(TraceIdRatioBased)`). `OTEL_TRACES_SAMPLER` /
 * `OTEL_TRACES_SAMPLER_ARG` win when set: then the SDK reads them itself.
 *
 * Head sampling decides before anything is known about the trace. To keep
 * every failed or slow trace at a low rate, sample in the collector instead
 * (tail sampling, see docs/telemetry.md) and leave this at 1.
 *
 * @param {Object} config
 * @returns {{sampler?: import('@opentelemetry/sdk-trace').Sampler}}
 */
export function samplerOption(config) {
  if (process.env.OTEL_TRACES_SAMPLER) return {};
  const raw = Number(config.spans?.sampleRate);
  const ratio = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
  return {
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) })
  };
}

/** Whether this process runs in a container (Docker, Kubernetes). */
function isContainer() {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST) || fs.existsSync('/.dockerenv');
}

/**
 * Build the NodeSDK options. Every signal is explicit: a signal that is off
 * gets an empty processor/reader list. Left `undefined`, NodeSDK falls back to
 * its environment defaults and exports traces and logs over OTLP to
 * `localhost:4318`, bypassing the platform's TLS and proxy settings.
 *
 * @param {Object} config - Resolved telemetry config
 * @param {Object} [setup]
 * @param {Array} [setup.instrumentations] - Created by the `--import` bootstrap
 *   (`instrumentation.mjs`) before the app loaded; created here otherwise
 * @returns {{options: Object, exporters: {traces: string|null, metrics: string|null, logs: string|null}}}
 */
export function buildSdkOptions(config, { instrumentations } = {}) {
  const provider = config.provider || 'console';
  const exporters = { traces: null, metrics: null, logs: null };

  const spanProcessors = [];
  if (config.spans?.enabled !== false) {
    const traceExporter = createTraceExporter(config);
    if (traceExporter) {
      exporters.traces = provider;
      spanProcessors.push(
        new RedactingSpanProcessor(
          new BatchSpanProcessor({ exporter: trackExporter(traceExporter, 'traces') }),
          () => ({
            exportEnabled: activeConfig?.spans?.enabled !== false,
            includeOptInAttributes: activeConfig?.spans?.includeOptInAttributes === true
          })
        )
      );
    }
  }

  const metricReaders = [];
  if (config.metrics?.enabled !== false && provider !== 'prometheus') {
    const metricExporter = createMetricExporter(config);
    if (metricExporter) {
      exporters.metrics = provider;
      metricReaders.push(
        new PeriodicExportingMetricReader({
          exporter: trackExporter(metricExporter, 'metrics'),
          exportIntervalMillis: config.metrics?.exportInterval || 60000
        })
      );
    }
  }

  const logRecordProcessors = [];
  if (config.logs?.enabled === true || config.logs === true) {
    exporters.logs = 'console';
    logRecordProcessors.push(
      new SimpleLogRecordProcessor({
        exporter: trackExporter(new ConsoleLogRecordExporter(), 'logs')
      })
    );
  }

  return {
    exporters,
    options: {
      resource: resourceFromAttributes(buildResourceAttributes(config)),
      // Stable, low-churn detectors only: no random instance id, no pid. The
      // container detector only inside a container (it warns everywhere else).
      resourceDetectors: [
        envDetector,
        hostDetector,
        osDetector,
        ...(isContainer() ? [containerDetector] : [])
      ],
      spanProcessors,
      metricReaders,
      logRecordProcessors,
      instrumentations:
        instrumentations ?? (config.autoInstrumentation === true ? createInstrumentations() : []),
      ...samplerOption(config)
    }
  };
}

/**
 * Start telemetry. Called by the `--import` bootstrap (`instrumentation.mjs`)
 * before the app loads, and again by worker startup; the second call does
 * nothing when the SDK is already running.
 *
 * @param {Object} rawConfig - The `telemetry` block of platform.json, as stored
 * @param {Object} [setup]
 * @param {Array} [setup.instrumentations] - Library instrumentations created early
 * @param {boolean} [setup.bootstrap] - Called from the bootstrap
 */
export async function initTelemetry(rawConfig = {}, { instrumentations, bootstrap = false } = {}) {
  if (sdk) {
    appLogger.debug('Telemetry already started by the bootstrap', { component: 'Telemetry' });
    return;
  }
  setPseudonymKeySource(() => tokenStorageService.encryptionKey);
  configureIdentity(rawConfig);
  if (!rawConfig.enabled) {
    activeConfig = rawConfig;
    configureSpans({ enabled: false });
    setTelemetrySetup({ enabled: false });
    appLogger.info('Telemetry disabled (telemetry.enabled is false)', { component: 'Telemetry' });
    return;
  }

  // Telemetry boots before configCache: decrypt the OTLP headers stored
  // encrypted, then resolve shell-style `${VAR}` / `${VAR:-default}`
  // placeholders the same way the rest of the platform does.
  const decrypted = structuredClone(rawConfig);
  await decryptOtlpHeaders(decrypted);
  const config = resolveEnvVarsInObject(decrypted) || {};

  appLogger.info('Initializing telemetry', {
    component: 'Telemetry',
    config: describeConfigForLog(config)
  });

  diag.setLogger(new AppDiagLogger(), DiagLogLevel.WARN);

  // Merge OTLP env vars when set and admin hasn't configured the OTLP exporter
  const otlpEnvConfig = parseOTLPEnvVars();
  if (otlpEnvConfig && !config.exporters?.otlp?.endpoint) {
    config.exporters = config.exporters || {};
    config.exporters.otlp = { ...otlpEnvConfig, ...config.exporters.otlp };
    if (!config.provider || config.provider === 'console') {
      config.provider = 'otlp';
    }
  }

  activeConfig = config;
  configureIdentity(config);
  configureSpans(config);

  const { options, exporters } = buildSdkOptions(config, { instrumentations });
  spansStartedDisabled = exporters.traces === null;

  // Prometheus is pulled: one endpoint answers for all workers of the
  // cluster (`prometheusCluster.js`), each series labelled with its worker.
  if (config.provider === 'prometheus' && config.metrics?.enabled !== false) {
    const { workerId } = processIdentity();
    prometheusCluster = startPrometheusCluster({
      host: config.exporters?.prometheus?.host || '0.0.0.0',
      port: config.exporters?.prometheus?.port || 9464,
      workerId: workerId ?? '0',
      workerCount: cluster.isWorker ? getConfiguredWorkerCount() : 1
    });
    options.metricReaders = [prometheusCluster.reader];
    exporters.metrics = 'prometheus';
  }

  setTelemetrySetup({ enabled: true, provider: config.provider || 'console', exporters });

  sdk = new NodeSDK(options);
  await sdk.start();

  if (config.metrics?.enabled !== false) {
    // sdk-node v0.202 / sdk-metrics v2.x removed `sdk.getMeterProvider()`.
    // Once `sdk.start()` returns the SDK has registered its provider as the
    // global one, so we acquire meters via the @opentelemetry/api facade.
    initializeMetrics(metricsApi);
    initializeProcessMetrics(metricsApi);
    const version = options.resource.attributes['service.version'];
    registerTelemetryStatusObservers({
      lastSuccess: lastSuccessTimestamps,
      buildInfo: () => ({ version, provider: config.provider || 'console' })
    });
  }

  // Initialize GenAI instrumentation now that SDK is up
  genAIInstrumentation = new GenAIInstrumentation(config);

  warnIfContentCaptureOn(config);
  appLogger.info('Telemetry initialization complete', {
    component: 'Telemetry',
    provider: config.provider,
    exporters,
    userIdMode: resolveUserIdMode(config),
    startedBy: bootstrap ? 'bootstrap' : 'worker',
    libraryInstrumentation:
      config.autoInstrumentation === true ? (bootstrap ? 'patched' : 'no-loader-hook') : 'off'
  });
  if (config.autoInstrumentation === true && !bootstrap) {
    appLogger.warn(
      'autoInstrumentation is on but the server was started without --import ./instrumentation.mjs: HTTP and Express are not instrumented',
      { component: 'Telemetry' }
    );
  }
}

/**
 * Log a WARN when prompt or completion content leaves the server. The admin
 * save writes the audit entry.
 */
function warnIfContentCaptureOn(config) {
  const prompts = capturesPrompts(config);
  const completions = capturesCompletions(config);
  if (!prompts && !completions) return;
  appLogger.warn('Telemetry content capture is on: prompt/completion text is exported', {
    component: 'Telemetry',
    includePrompts: prompts,
    includeCompletions: completions,
    maxCharacters: contentCap(config.events),
    note: 'Redaction is best effort; keep content capture off in production'
  });
}

export function getGenAIInstrumentation() {
  return genAIInstrumentation;
}

/**
 * Apply runtime-mutable parts of the telemetry configuration without restarting
 * the OpenTelemetry SDK. Use this when admins change config through the UI.
 *
 * Keep in sync with documentation: settings that *require* restart include
 * `enabled`, `provider`, `exporters.*`, `autoInstrumentation` and
 * `metrics.exportInterval`.
 *
 * Settings that take effect immediately:
 *   - events.* (content capture, maxEventSize)
 *   - spans.enabled, spans.includeOptInAttributes, spans.userIdMode
 *   - activitySummary.*
 */
export function reloadTelemetryConfig(newConfig = {}) {
  const previous = activeConfig || {};
  // The caller passes the complete telemetry block, so a field it lacks was
  // deleted and falls back to its default; merging `previous` back in would
  // keep, say, a removed `userIdMode: clear` alive. Provider, exporters and
  // the signal switches need a restart and stay as they started.
  activeConfig = {
    ...previous,
    events: newConfig.events,
    spans: { ...newConfig.spans },
    activitySummary: newConfig.activitySummary
  };
  if (spansStartedDisabled && activeConfig.spans.enabled !== false && activeConfig.enabled) {
    appLogger.warn('Spans were off at startup: enabling them takes effect after a restart', {
      component: 'Telemetry'
    });
  }
  configureIdentity(activeConfig);
  configureSpans(activeConfig);
  setSignalEnabled('traces', activeConfig.spans.enabled !== false);
  if (genAIInstrumentation) {
    genAIInstrumentation.config = activeConfig;
  }
  const wasCapturing = capturesPrompts(previous) || capturesCompletions(previous);
  if (activeConfig.enabled && !wasCapturing) warnIfContentCaptureOn(activeConfig);
}

export async function shutdownTelemetry() {
  await prometheusCluster?.close();
  await sdk?.shutdown();
  appLogger.info('Telemetry shutdown completed successfully', { component: 'Telemetry' });
}
