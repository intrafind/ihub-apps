// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import cluster from 'node:cluster';
import { loadJson } from '../configLoader.js';
import logger from '../utils/logger.js';
import { startStickyPrimary, logStickyRoutingCaveat } from '../clusterSticky.js';
import { initPrimaryBus } from '../clusterBus.js';
import {
  RESTART_MESSAGE_KEY,
  getShutdownExitCode,
  setShutdownExitCode
} from '../utils/processRestart.js';
import { confirmUpdateOnStartup, isUpdateAwaitingConfirmation } from '../services/updateService.js';
import { initSystemResources } from '../services/systemResources.js';
import { shutdownStorageBootstrap } from '../storage/bootstrap.js';
import config from '../config.js';
import { prepareContents, bootstrapStorageOrExit } from './bootstrap.js';
import { describeWorkerSizing, workerExecArgv } from '../utils/workerSizing.js';

/**
 * Start the cluster primary: seed and migrate `contents/`, check the storage
 * provider once, fork the workers, replace the ones that die and shut the
 * cluster down on a signal. The primary keeps no HTTP server of its own, except
 * with sticky routing, where it owns the public socket.
 *
 * @param {{workerCount: number, stickyRouting: boolean}} options
 */
export async function startPrimary({ workerCount, stickyRouting }) {
  logger.info(describeWorkerSizing(config.WORKER_SIZING));
  logger.info({
    component: 'Server',
    message: `Primary process ${process.pid} starting ${workerCount} workers`,
    pid: process.pid,
    workerCount,
    routing: stickyRouting ? 'sticky-ip-hash' : 'round-robin'
  });

  // Track live workers so the bus (and, in sticky mode, the router) can reach
  // them. Dead entries are replaced in the `exit` handler.
  const workers = [];

  // Set once a shutdown signal arrives, so the `exit` handler below stops
  // replacing workers. Without it the handler respawned the very workers the
  // shutdown had just killed, the cluster resurrected itself and kept serving
  // until the primary force-exited 5s later — so `docker stop` / a Kubernetes
  // rollout sat out its whole grace period and in-flight requests were cut by
  // the hard exit instead of being drained.
  let shuttingDown = false;

  // Seed contents/ and migrate BEFORE any worker exists, so the workers never
  // race each other over the same config files (see prepareContents).
  await prepareContents();

  // Check the storage provider once here, before forking: a worker that cannot
  // start it exits, and the primary would respawn it in a loop. The primary
  // keeps no provider of its own, so it is shut down again straight away.
  {
    let primaryPlatformConfig = {};
    try {
      primaryPlatformConfig = await loadJson('config/platform.json');
    } catch {
      // Same tolerance as the worker: a missing platform.json means defaults.
    }
    await bootstrapStorageOrExit(primaryPlatformConfig);
    await shutdownStorageBootstrap();
  }

  // Start the repeater before forking so a worker's first presence
  // announcement — sent as soon as its module graph loads — is never dropped.
  initPrimaryBus({ getWorkers: () => workers });
  // The primary is a process with its own memory footprint; let it report
  // itself to the admin System resources page alongside the workers.
  initSystemResources();

  // Each worker gets its share of the container's memory as its V8 heap limit,
  // unless one was given explicitly (see utils/workerSizing.js), so V8 collects
  // before the container is killed. The count goes along as `WORKERS`: a worker
  // reads it to know how many peers to wait for.
  cluster.setupPrimary({ execArgv: workerExecArgv(config.WORKER_SIZING) });
  const forkWorker = workerIndex =>
    cluster.fork({ WORKER_INDEX: String(workerIndex), WORKERS: String(workerCount) });

  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
    workers[workerIndex] = forkWorker(workerIndex);
  }

  // Workers that die while a just-applied update is still unconfirmed. If the
  // new version crashes every worker before any serves, respawning forever
  // would hide it from the launcher, which counts failed starts (and rolls
  // back) only when this primary exits.
  let unconfirmedUpdateWorkerDeaths = 0;

  cluster.on('exit', (worker, code, signal) => {
    const slot = workers.findIndex(w => w === worker);
    if (shuttingDown) {
      logger.info({
        component: 'Server',
        message: `Worker ${worker.process.pid} exited during shutdown`,
        workerPid: worker.process.pid,
        code,
        signal,
        slot
      });
      if (workers.every(w => w.isDead())) {
        logger.info({
          component: 'Server',
          message: 'All workers exited, primary shutting down'
        });
        // 75 when an update or rollback asked for a restart: the launcher
        // restarts the server only when the process it started — this
        // primary — exits with that code.
        process.exit(getShutdownExitCode());
      }
      return;
    }
    if (isUpdateAwaitingConfirmation()) {
      unconfirmedUpdateWorkerDeaths++;
      if (unconfirmedUpdateWorkerDeaths >= Math.max(3, workerCount * 2)) {
        logger.error({
          component: 'Server',
          message:
            'Workers keep failing right after an update; exiting so the launcher can restore the previous version',
          deaths: unconfirmedUpdateWorkerDeaths
        });
        process.exit(1);
      }
    }
    logger.warn({
      component: 'Server',
      message: `Worker ${worker.process.pid} exited (${code || signal}), respawning`,
      workerPid: worker.process.pid,
      code,
      signal,
      slot
    });
    const replacement = forkWorker(slot >= 0 ? slot : workers.length);
    if (slot >= 0) {
      workers[slot] = replacement;
    } else {
      workers.push(replacement);
    }
  });

  const logAccessUrls = () => {
    if (config.HOST === '0.0.0.0' || config.HOST === '::') {
      logger.info({
        component: 'Server',
        message: 'Access the application at one of these URLs:',
        urls: [
          `http://localhost:${config.PORT}`,
          `http://127.0.0.1:${config.PORT}`,
          "(or use your machine's hostname/IP address)"
        ]
      });
    } else {
      logger.info({
        component: 'Server',
        message: 'Access the application at',
        url: `http://${config.HOST}:${config.PORT}`
      });
    }
  };

  if (stickyRouting) {
    // Primary owns the public listening socket and hands each connection to a
    // worker by hashing the client's remote address.
    startStickyPrimary({
      getWorkers: () => workers,
      port: config.PORT,
      host: config.HOST,
      onListening: () => {
        logger.info({
          component: 'Server',
          message: 'Sticky cluster primary listening',
          host: config.HOST,
          port: config.PORT,
          workerCount
        });
        logStickyRoutingCaveat(workerCount);
        logAccessUrls();
        confirmUpdateOnStartup();
      }
    });
  } else {
    // Workers bind the shared socket themselves and Node's round-robin
    // scheduler hands each new connection to the next one. The primary keeps
    // only the bus, so it stays idle enough to relay cross-worker chat traffic.
    logger.info({
      component: 'Server',
      message: 'Cluster using round-robin connection scheduling; workers bind the port directly',
      host: config.HOST,
      port: config.PORT,
      workerCount
    });
    logAccessUrls();
    // The first worker answering on the port confirms an update that was
    // just applied (the launcher restores the previous version otherwise).
    cluster.once('listening', () => confirmUpdateOnStartup());
  }

  const handlePrimaryShutdown = signal => {
    // A second signal while the first is in flight must not re-kill workers.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({
      component: 'Server',
      message: `Primary received ${signal}, shutting down workers`,
      workerCount: workers.length
    });
    for (const w of workers) {
      try {
        w.kill(signal);
      } catch {
        // worker may already be dead
      }
    }
    // Give workers a moment to exit cleanly, then force-exit the primary.
    setTimeout(() => process.exit(getShutdownExitCode()), 5000).unref();
  };
  process.on('SIGTERM', () => handlePrimaryShutdown('SIGTERM'));
  process.on('SIGINT', () => handlePrimaryShutdown('SIGINT'));
  // A worker that applied an update asks the primary to restart the whole
  // cluster (utils/processRestart.js); exiting only that worker left the
  // others running the old code.
  cluster.on('message', (worker, message) => {
    if (!message || typeof message !== 'object' || !(RESTART_MESSAGE_KEY in message)) return;
    logger.info({
      component: 'Server',
      message: 'Worker requested a server restart (update), shutting down the cluster',
      workerPid: worker.process.pid
    });
    setShutdownExitCode(Number(message[RESTART_MESSAGE_KEY]) || 75);
    handlePrimaryShutdown('SIGTERM');
  });
}
