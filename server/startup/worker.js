// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { uvThreadpoolSize } from '../threadpool.js';
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import cluster from 'node:cluster';
import { loadJson } from '../configLoader.js';
import { getRootDir } from '../pathUtils.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import { attachStickyWorker } from '../clusterSticky.js';
import { initWorkerBus } from '../clusterBus.js';
import { confirmUpdateOnStartup } from '../services/updateService.js';
import { initSystemResources } from '../services/systemResources.js';
import { registerConfigReloadHooks } from '../configReloadHooks.js';
import { attachRealtimeTranscription } from '../websocket/realtimeTranscription.js';
import { setDefaultLanguage } from '../../shared/localize.js';
import { initTelemetry } from '../telemetry.js';
import { setupMiddleware } from '../middleware/setup.js';
import errorHandler from '../middleware/errorHandler.js';
import { validateApiKeys, cleanupInactiveClients } from '../serverHelpers.js';
import { getProxyConfig, redactUrlSecrets } from '../utils/httpConfig.js';
import {
  getBasePath,
  basePathDetectionMiddleware,
  basePathValidationMiddleware
} from '../utils/basePath.js';
import config from '../config.js';
import { describeWorkerSizing } from '../utils/workerSizing.js';
import { registerAllRoutes } from './routes.js';
import { shutdown } from './shutdown.js';
import { prepareContents, bootstrapStorageOrExit } from './bootstrap.js';

// Enable port reuse to avoid EADDRINUSE errors on quick restarts.
// This allows the server to use a port that is in TIME_WAIT state (which can
// happen if the server is restarted quickly). Only applied when creating
// HTTP/HTTPS servers directly.
const serverOptions = {
  ...(process.platform === 'darwin' ? { reuseAddr: true, reusePort: true } : {})
};

/**
 * Load `platform.json`, bring storage, telemetry, the activity tracker and the
 * encryption keys up. Everything that keeps durable state comes after this.
 *
 * @returns {Promise<Object>} the raw platform config (`{}` when it cannot be read)
 */
async function initFoundations() {
  let platformConfig = {};
  try {
    platformConfig = await loadJson('config/platform.json');
    if (platformConfig?.defaultLanguage) {
      setDefaultLanguage(platformConfig.defaultLanguage);
    }
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to load platform configuration',
      error: error.message,
      stack: error.stack
    });
  }

  // Bring the storage provider up in every worker, before anything that keeps
  // durable state can be asked for it. The provider is mandatory (filesystem is
  // the default): a broken `storage` block or a provider that cannot start is a
  // configuration error like an invalid platform.json, and the worker refuses
  // to start instead of serving with state that is lost on restart.
  await bootstrapStorageOrExit(platformConfig);

  // Initialize OpenTelemetry SDK. We do this in its own try/catch because a
  // failure here (e.g. invalid OTLP endpoint, missing exporter package) must
  // not stop the rest of the worker - including the activity tracker - from
  // starting.
  try {
    await initTelemetry(platformConfig?.telemetry || {});
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to initialize telemetry',
      error: error.message,
      stack: error.stack
    });
  }

  // Activity tracker drives the active-users / active-chats observable gauges
  // AND the periodic activity-summary log line. The log line works even when
  // OTel itself is broken, so configure it unconditionally and in its own
  // try/catch.
  try {
    const { default: activityTracker } = await import('../telemetry/ActivityTracker.js');
    activityTracker.configure(platformConfig?.telemetry?.activitySummary || {});
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to configure activity tracker',
      error: error.message,
      stack: error.stack
    });
  }

  // Log application version information
  const { logVersionInfo } = await import('../utils/versionHelper.js');
  logVersionInfo();

  // Write down which version is running and keep the one it replaced, so What's New can mark
  // every release an upgrade brought in — not just the one being run. Idempotent and never
  // throws, so every worker may call it (see installedVersionStore).
  const { recordInstalledVersion } = await import('../utils/installedVersionStore.js');
  await recordInstalledVersion();

  // Initialize encryption key and JWT secret for secure storage and token signing
  try {
    const tokenStorageService = (await import('../services/TokenStorageService.js')).default;
    await tokenStorageService.initializeEncryptionKey();
    await tokenStorageService.initializeJwtSecret();
    await tokenStorageService.initializeRSAKeyPair();
    // Project text (uploads, picked documents) is encrypted under that key;
    // the pipeline, the reader and the reconciler come up once it exists.
    const { bootstrapProjects } = await import('../services/projects/bootstrap.js');
    await bootstrapProjects();
  } catch (error) {
    logger.error('Failed to initialize encryption key or JWT secret', {
      component: 'Server',
      error
    });
    logger.warn('Encrypted API keys, tokens, or JWT authentication may not work properly', {
      component: 'Server'
    });
  }
  return platformConfig;
}

/**
 * Load the configuration cache and the installed integrations, and follow config
 * changes other workers announce. Must stay after `bootstrapStorage`: the cache
 * reads through the provider and subscribes to its change stream.
 */
async function initConfigCache() {
  // Initialize configuration cache for optimal performance. This must stay
  // after `bootstrapStorage`: the cache reads every config file through the
  // provider and subscribes to the provider's change stream as it starts, and
  // with no provider up it would fall back to the filesystem for the whole
  // boot and follow nothing afterwards.
  try {
    await configCache.initialize();
    // Set configCache reference in logger after initialization
    logger.setConfigCache(configCache);
    // Reconfigure logger to pick up logging settings from platform config
    logger.reconfigureLogger();
    // Installed integrations (#3061): load the definition catalog and offer
    // their scopes (publishers, search profiles) to the chat from the start.
    try {
      const { default: integrationRegistry, INTEGRATIONS_CONFIG_KEY } =
        await import('../services/integrations/definitions/IntegrationRegistry.js');
      const { syncIntegrationScopeProviders } =
        await import('../services/integrations/integrationTools.js');
      const { registerConfigChangeHook, ALL_ENTRIES } = await import('../configSync.js');
      const { invalidate } =
        await import('../services/integrations/protocols/openapi/OpenApiAdapter.js');
      const { notifyDefinitionsChanged } =
        await import('../services/integrations/protocols/index.js');
      // Another worker installed, changed or removed an integration or a
      // definition: refresh what this worker derives from them — the cached
      // OpenAPI schemas, the MCP client manager's server configs (the MCP
      // adapter's `onChanged`), the scope providers. Registered before the
      // first load, so a load that fails here still leaves this worker
      // following later changes.
      registerConfigChangeHook(async ({ entries }) => {
        if (!entries.includes(INTEGRATIONS_CONFIG_KEY) && !entries.includes(ALL_ENTRIES)) return;
        await integrationRegistry.reload();
        invalidate();
        await notifyDefinitionsChanged();
        await syncIntegrationScopeProviders();
      });
      // The built-in native connectors (iFinder, iAssistant) register
      // themselves on import; definitions that name them load next.
      await import('../services/integrations/protocols/native/connectors/register.js');
      await integrationRegistry.reload();
      await syncIntegrationScopeProviders();
    } catch (error) {
      logger.warn({
        component: 'Server',
        message: 'Installed integrations could not be initialized',
        error: error.message
      });
    }
  } catch (error) {
    logger.error({
      component: 'Server',
      message: 'Failed to initialize configuration cache',
      error: error.message,
      stack: error.stack
    });
    logger.warn({
      component: 'Server',
      message: 'Server will continue with file-based configuration loading'
    });
  }

  // Follow config changes announced by other workers into the subsystems that
  // keep their own derived state (logger, telemetry, MCP clients). Registered
  // after the cache is loaded so each watcher's baseline is the current config.
  registerConfigReloadHooks();
}

/**
 * Log the outbound proxy configuration, with credentials redacted.
 */
function logProxyConfig() {
  // Log proxy configuration if configured
  try {
    const proxyConfig = getProxyConfig();
    if (proxyConfig.enabled && (proxyConfig.http || proxyConfig.https)) {
      logger.info({
        component: 'Server',
        message: '🌐 Proxy configuration active',
        // Redacted: a proxy URL may carry basic-auth credentials.
        http: proxyConfig.http ? redactUrlSecrets(proxyConfig.http) : '(not set)',
        https: proxyConfig.https ? redactUrlSecrets(proxyConfig.https) : '(not set)',
        noProxy: proxyConfig.noProxy.length > 0 ? proxyConfig.noProxy.join(',') : '(not set)',
        urlPatterns:
          proxyConfig.urlPatterns?.length > 0 ? proxyConfig.urlPatterns : '(all URLs proxied)'
      });
    } else if (!proxyConfig.enabled) {
      logger.info({
        component: 'Server',
        message: 'Proxy is explicitly disabled'
      });
    }
  } catch (error) {
    logger.warn({
      component: 'Server',
      message: 'Failed to read proxy configuration',
      error: error.message
    });
  }
}

/**
 * Start what runs beside the HTTP server: disk and usage monitors, the audit
 * cleanup, and the MCP and A2A client managers. The singletons run once per
 * cluster; the client managers run in every worker.
 *
 * @param {boolean} ownsClusterSingletons - whether this worker is the one that owns them
 */
async function startBackgroundServices(ownsClusterSingletons) {
  // Log when a disk iHub writes to runs low. Once per cluster, or every
  // worker would log the same line.
  if (ownsClusterSingletons) {
    try {
      const { startStorageMonitor } = await import('../services/storageMonitor.js');
      const { getStorageSnapshot, getMonitoredPaths, getLogFilePath } =
        await import('../services/systemResources.js');
      startStorageMonitor({
        getSnapshot: () =>
          getStorageSnapshot(
            getMonitoredPaths({ logFile: getLogFilePath(configCache.getPlatform?.() || {}) })
          )
      });
    } catch (error) {
      logger.warn('Failed to start disk space monitor', { component: 'Server', error });
    }
  }

  // Start usage rollup scheduler
  if (ownsClusterSingletons) {
    try {
      const { startRollupScheduler } = await import('../services/UsageAggregator.js');
      startRollupScheduler(() => configCache.getPlatform?.()?.usageTracking || {});
    } catch (error) {
      logger.warn('Failed to start usage rollup scheduler', { component: 'Server', error });
    }
  }

  // Initialise the MCP client manager from the installed MCP integrations.
  // Every worker needs its own initialized manager to serve tool calls it
  // handles, so it always runs; only the eager background `connectAll()` is
  // singleton-gated; workers that skip it still connect lazily on first use
  // (tools/list retries on miss). Failure is non-fatal — the rest of iHub
  // keeps working even if outbound MCP discovery is broken.
  try {
    const { initializeMcpFromInstallations } =
      await import('../services/integrations/protocols/mcp/manager.js');
    await initializeMcpFromInstallations({ connect: ownsClusterSingletons });
  } catch (error) {
    logger.warn('Failed to initialise MCP client manager', { component: 'Server', error });
  }

  // Initialise the A2A client manager (remote A2A agents as tools) from the
  // installed A2A integrations, on every worker; the singleton worker fetches
  // the Agent Cards in the background, the others lazily on first use. Failure
  // is non-fatal.
  try {
    const { initializeA2aFromInstallations } =
      await import('../services/integrations/protocols/a2a/manager.js');
    await initializeA2aFromInstallations({ warmUp: ownsClusterSingletons });
  } catch (error) {
    logger.warn('Failed to initialise A2A client manager', { component: 'Server', error });
  }

  // Start audit log cleanup scheduler
  if (ownsClusterSingletons) {
    try {
      const { startAuditCleanupScheduler } = await import('../services/AuditLogService.js');
      const platform = configCache.getPlatform ? configCache.getPlatform() : {};
      startAuditCleanupScheduler(platform?.audit || {});
    } catch (error) {
      logger.warn('Failed to start audit log cleanup scheduler', { component: 'Server', error });
    }
  }
}

/**
 * Create the HTTP (or HTTPS, when `SSL_KEY` and `SSL_CERT` are set) server,
 * attach the realtime transcription socket and start listening, or hand
 * connections over from a sticky-routing primary.
 *
 * @param {import('express').Express} app
 * @param {{stickyRouting: boolean}} options
 * @returns {Promise<import('node:http').Server>}
 */
async function createAndListen(app, { stickyRouting }) {
  const PORT = config.PORT;
  const HOST = config.HOST;
  // Check for SSL configuration
  let server;
  if (config.SSL_KEY && config.SSL_CERT) {
    try {
      // Import synchronous file system operations for SSL cert loading
      const fsSync = await import('node:fs');

      // SSL configuration
      const httpsOptions = {
        key: fsSync.readFileSync(config.SSL_KEY),
        cert: fsSync.readFileSync(config.SSL_CERT),
        // Add macOS-specific options for socket reuse
        ...(process.platform === 'darwin' ? serverOptions : {})
      };

      // Add CA certificate if provided
      if (config.SSL_CA) {
        httpsOptions.ca = fsSync.readFileSync(config.SSL_CA);
      }

      // Create HTTPS server
      server = https.createServer(httpsOptions, app);
      logger.info({
        component: 'Server',
        message: 'Starting HTTPS server',
        certPath: config.SSL_CERT
      });
    } catch (error) {
      logger.error({
        component: 'Server',
        message: 'Error setting up HTTPS server',
        error: error.message,
        stack: error.stack
      });
      logger.info({
        component: 'Server',
        message: 'Falling back to HTTP server'
      });
      server = http.createServer(serverOptions, app);
    }
  } else {
    // Create regular HTTP server with socket reuse options
    server = http.createServer(serverOptions, app);
    logger.info({
      component: 'Server',
      message: 'Starting HTTP server (no SSL configuration provided)'
    });
  }

  // Attach the realtime speech-to-text WebSocket handler. Works in both
  // single-process and sticky-cluster worker modes — WS upgrades ride the same
  // TCP connection the primary hands to the worker, so no extra coordination is
  // needed.
  attachRealtimeTranscription(server);

  if (cluster.isWorker && stickyRouting) {
    // Inside a sticky cluster the primary owns the public port; this worker
    // only receives already-accepted connections via IPC.
    attachStickyWorker(server);
    logger.info({
      component: 'Server',
      message: 'Worker ready for sticky connections',
      pid: process.pid,
      workerIndex: process.env.WORKER_INDEX ?? 'unknown'
    });
  } else {
    // Single-process mode (WORKERS=1), or a round-robin cluster worker: bind
    // the port directly. In the cluster case `listen` goes through the cluster
    // module, which shares the primary's socket rather than opening a second
    // one, so all workers can use the same port.
    server.listen(PORT, HOST, () => {
      const protocol = server instanceof https.Server ? 'https' : 'http';

      logger.info({
        component: 'Server',
        message: 'Server is listening on all interfaces',
        protocol,
        bindAddress: HOST,
        port: PORT,
        uvThreadpoolSize
      });

      if (HOST === '0.0.0.0' || HOST === '::') {
        logger.info({
          component: 'Server',
          message: 'Access the application at one of these URLs:',
          urls: [
            `${protocol}://localhost:${PORT}`,
            `${protocol}://127.0.0.1:${PORT}`,
            "(or use your machine's hostname/IP address)"
          ]
        });
        logger.warn({
          component: 'Server',
          message: '⚠️  IMPORTANT: Do not access via http://0.0.0.0:* in your browser',
          reason: 'Browsers will reject cookies from 0.0.0.0, causing authentication to fail',
          recommendation: 'Always use localhost, 127.0.0.1, or your actual hostname'
        });
      } else {
        logger.info({
          component: 'Server',
          message: 'Access the application at',
          url: `${protocol}://${HOST}:${PORT}`
        });
      }
      // Single-process mode only; under clustering the primary confirms.
      if (!cluster.isWorker) confirmUpdateOnStartup();
    });
  }
  return server;
}

/**
 * Workflow recovery and trigger initialisation on boot, then the scheduler.
 * Order matters:
 *   1. Attach the engine to the TriggerManager (this acquires the
 *      cross-process scheduler lock).
 *   2. Rescan the execution records: recover anything that exists only as a
 *      checkpoint and mark whatever the previous process left `running` as
 *      failed. Before the resume in step 3, exactly as it has always been —
 *      a run that resumes is set back to `running` by the engine. This used
 *      to run un-gated in every worker, which is safe only while each
 *      worker has its own registry; now the records are shared, so it is
 *      owner-gated like the two steps below.
 *   3. Resume runs interrupted by the previous process from their last
 *      checkpoint (only the scheduler-lock owner does this).
 *   4. Orphan-sweep whatever could NOT be resumed, marking it failed. Also
 *      owner-gated: resume + sweep run in the SAME process so the sweeper's
 *      in-memory activeStates guard authoritatively skips just-resumed runs.
 *      A non-owner worker must not sweep — it would clobber the owner's runs.
 *   5. Register schedule/webhook triggers.
 *
 * The scheduler starts after the workflow block, so the engine is attached before
 * the first schedule trigger can fire.
 */
async function recoverWorkflowsAndStartScheduler() {
  try {
    const { loadWorkflows, markInterruptedExecutionsFailed } =
      await import('../routes/workflow/workflowRoutes.js');
    const { getTriggerManager } = await import('../services/workflow/triggers/TriggerManager.js');
    const { getWorkflowEngine } = await import('../services/workflow/WorkflowEngine.js');
    const { resumeInterruptedRuns } = await import('../services/workflow/resumeManager.js');
    const { sweepOrphanedExecutions } = await import('../services/workflow/orphanSweeper.js');
    const { serializeProfile } = await import('../agents/profile/profileWorkflowSerializer.js');
    const { buildAgentPrincipal } = await import('../utils/authorization.js');
    const { applyNodeModels, applyReviewSettings } = await import('../routes/agents/runs.js');
    const { resolveReviewSettings } = await import('../agents/profile/reviewSettings.js');

    const engine = getWorkflowEngine();
    const triggerManager = getTriggerManager();
    triggerManager.setEngine(engine); // starts the scheduler-lock heartbeat
    triggerManager.setWorkflowLoader(loadWorkflows);

    // Step 2: awaited, so the resume below observes the rescan's writes rather
    // than racing them back to `failed`.
    try {
      await markInterruptedExecutionsFailed({ requireSchedulerOwner: true });
    } catch (error) {
      logger.warn({ component: 'Server', message: `Execution rescan skipped: ${error.message}` });
    }

    // 30-minute node timeout for resumed runs, consistent with the agent-run
    // engine in routes/agents/runs.js — needed so resumed agent runs
    // (including phased planner nodes) don't hit the engine's 5-minute
    // default on recovery. Passed per-call rather than via the (now shared)
    // engine's constructor so it doesn't leak into non-resume entry points.
    const RESUME_NODE_TIMEOUT_MS = 30 * 60 * 1000;

    // Reconstruct the full definition for a persisted run: agent runs are
    // re-serialized from their profile (with the agent principal restored);
    // plain workflow runs are reloaded by id from disk.
    const resolveDefinition = async state => {
      const profileId = state?.data?._agent?.profileId;
      if (profileId) {
        const { data: profiles } = configCache.getAgentProfiles(true);
        const profile = profiles?.find(p => p.id === profileId);
        if (!profile) return null;
        const serialized = serializeProfile(profile);
        // External profiles reference a standalone workflow file by id;
        // embedded profiles carry the rebuilt definition inline. Deep-clone the
        // external definition — getWorkflowById returns the SHARED cached object
        // and we mutate config/nodes below (embedded definitions are already
        // cloned by serializeProfile).
        let definition;
        if (serialized.workflow?.ref === 'external' && serialized.workflow.workflowId) {
          const cached = configCache.getWorkflowById(serialized.workflow.workflowId);
          definition = cached ? JSON.parse(JSON.stringify(cached)) : null;
        } else {
          definition = serialized.workflow?.definition;
        }
        if (!definition) return null;

        // Re-apply the same run-start wiring the request path sets
        // (routes/agents/runs.js) so a resumed run keeps its wall-time budget
        // and per-step model / review config. Without the wall-time budget,
        // resumeFromCheckpoint falls back to the engine's 5-minute default and
        // the resumed run trips MAX_EXECUTION_TIME shortly after recovery.
        const maxWallTimeSec = profile.budgets?.maxWallTimeSec ?? 600;
        definition.config = {
          ...definition.config,
          maxExecutionTime: maxWallTimeSec * 1000,
          ...(profile.preferredModel ? { defaultModelId: profile.preferredModel } : {})
        };
        applyNodeModels(definition, profile.nodeModels);
        applyReviewSettings(definition, resolveReviewSettings(profile.review));

        const principal = buildAgentPrincipal(profile, state.data._agent?.triggeredBy || null);
        return { definition, options: { user: principal, timeout: RESUME_NODE_TIMEOUT_MS } };
      }
      const workflows = await loadWorkflows(false);
      const definition = findByIdCaseInsensitive(workflows, state.workflowId);
      if (!definition) return null;
      return {
        definition,
        options: {
          user: { id: 'system', name: 'System (resumed)', groups: [] },
          timeout: RESUME_NODE_TIMEOUT_MS
        }
      };
    };

    try {
      const resumeResult = await resumeInterruptedRuns({ engine, resolveDefinition });
      if (resumeResult.resumed.length > 0) {
        logger.info({
          component: 'Server',
          message: `Resumed ${resumeResult.resumed.length} interrupted workflow run(s) from checkpoint`
        });
      }
    } catch (error) {
      logger.warn({ component: 'Server', message: `Run resume skipped: ${error.message}` });
    }

    try {
      await sweepOrphanedExecutions({ requireSchedulerOwner: true });
    } catch (error) {
      logger.warn({ component: 'Server', message: `Orphan sweeper skipped: ${error.message}` });
    }

    const workflows = await loadWorkflows(false);
    workflows.forEach(w => triggerManager.registerWorkflowTriggers(w));
    logger.info({
      component: 'Server',
      message: `Initialized ${triggerManager.getActiveTriggers().length} workflow triggers`
    });
  } catch (error) {
    logger.warn({
      component: 'Server',
      message: `Workflow recovery / trigger initialization skipped: ${error.message}`
    });
  }

  // The scheduler: one ticker per worker, acting only on the scheduler-lock
  // owner. It fires workflow schedule triggers (read from the workflow config
  // on every tick, so edits apply without a restart) and users' scheduled
  // tasks. After the workflow block above, so the engine is attached before
  // the first schedule trigger can fire.
  try {
    const { initScheduler } = await import('../services/scheduler/index.js');
    initScheduler();
  } catch (error) {
    logger.error({
      component: 'Server',
      message: `Scheduler failed to start: ${error.message}`
    });
  }
}

/**
 * Start a worker, or the one process when `WORKERS=1`: bring the services up,
 * build the Express app, listen, recover interrupted workflows and start the
 * scheduler.
 *
 * @param {{stickyRouting: boolean}} options
 * @returns {Promise<void>}
 */
export async function startWorker({ stickyRouting }) {
  // The single process logs the sizing decision itself; in a cluster the
  // primary does, once.
  if (!cluster.isWorker) logger.info(describeWorkerSizing(config.WORKER_SIZING));
  // Join the cross-worker bus before anything can register per-chat state, so
  // no SSE stream is ever invisible to the rest of the cluster. No-op when this
  // process is not a cluster worker.
  initWorkerBus();
  // Sample this process's CPU and answer the System resources page's
  // cross-worker snapshot requests (a plain sampler when not clustered).
  initSystemResources();

  // Determine if we're running from a packaged binary
  // Either via process.pkg (when using pkg directly) or APP_ROOT_DIR env var (our shell script approach)
  const isPackaged = process.pkg !== undefined || config.APP_ROOT_DIR !== undefined;

  // Resolve the application root directory
  const rootDir = getRootDir();
  if (isPackaged) {
    logger.info({
      component: 'Server',
      message: 'Running in packaged binary mode',
      rootDir
    });
  } else {
    logger.info({
      component: 'Server',
      message: 'Running in normal mode'
    });
  }
  logger.info({
    component: 'Server',
    message: 'Root directory configured',
    rootDir
  });

  // Get the contents directory, either from environment variable or use default 'contents'
  const contentsDir = config.CONTENTS_DIR;
  logger.info({
    component: 'Server',
    message: 'Using contents directory',
    contentsDir
  });

  // Seed contents/ and migrate. A cluster worker skips this: its primary
  // already did it before forking, and running it here would race the siblings.
  if (!cluster.isWorker) {
    await prepareContents();
  }

  const platformConfig = await initFoundations();
  await initConfigCache();
  logProxyConfig();

  // Process-wide singletons run once per cluster: on the worker in slot 0
  // (`WORKER_INDEX`, stable across respawns — `cluster.worker.id` is never
  // reused). Computed here (rather than just below, where it originally only
  // gated the sweeps registered after route setup) because the rollup/audit
  // schedulers and the MCP eager-connect below need the same guard: each used
  // to fire its own interval in every worker, so N workers wrote the same
  // usage-rollup/audit-log files independently and opened N times the MCP
  // connections at startup.
  const ownsClusterSingletons = !cluster.isWorker || process.env.WORKER_INDEX === '0';

  await startBackgroundServices(ownsClusterSingletons);

  // Create Express application
  const app = express();

  // Request timeout, already a number
  const DEFAULT_TIMEOUT = config.REQUEST_TIMEOUT;

  // Middleware
  // Use the resolved platform config from configCache (which applies IHUB_PLATFORM__*
  // env overrides and decrypts secrets) so boot-time middleware (body-size limit,
  // rate limiters, sessions, auth chain) picks up all overrides.  Fall back to
  // the raw JSON value only if configCache failed to initialize.
  setupMiddleware(app, configCache.getPlatform() || platformConfig);

  // Base path middleware chain. The rewrite that strips X-Forwarded-Prefix
  // from req.url runs inside setupMiddleware, ahead of the rate limiters.
  // 1. Detection: stores current request for runtime base path resolution
  // 2. Validation: warns on invalid X-Forwarded-Prefix values
  app.use(basePathDetectionMiddleware);
  app.use(basePathValidationMiddleware);

  // --- API Endpoints handled in separate route modules ---
  // All API routes are registered with base path support
  const basePath = getBasePath();
  await registerAllRoutes(app, {
    ownsClusterSingletons,
    isPackaged,
    rootDir,
    basePath,
    DEFAULT_TIMEOUT
  });

  // The one place an error becomes a response. After every route.
  app.use(errorHandler);

  // Cleanup inactive clients every minute
  cleanupInactiveClients();

  // Validate API keys at startup
  validateApiKeys();

  await createAndListen(app, { stickyRouting });
  await recoverWorkflowsAndStartScheduler();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
