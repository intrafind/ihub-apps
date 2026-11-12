// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// Entry point. The work lives in `startup/`: `primary.js` (the cluster primary),
// `worker.js` (a worker, or the single process), `routes.js` (the ordered route
// table), `shutdown.js` and `bootstrap.js` (steps both share).

// Must stay the first import: sizes the libuv threadpool before any module
// touches it (see threadpool.js).
import './threadpool.js';
import dotenv from 'dotenv';
import cluster from 'node:cluster';
import logger from './utils/logger.js';
import { applySystemCaDefault } from './utils/systemCa.js';
// Modules whose cluster-wide state the primary holds and answers for over the
// bus. Imported here so the primary always registers them; a worker asking a
// primary that never loaded one would wait for an answer that never comes.
import './requestThrottler.js';
import './utils/clusterRateLimitStore.js';
import './utils/loginLockout.js';
import config from './config.js';
// `startup/primary.js` and `startup/worker.js` are imported below, each only in
// the process that runs it. A static import of `worker.js` loaded the whole
// application — routes, services, every library they use — into the cluster
// primary too, which only supervises: ~140 MB of heap and ~300 MB of RSS for a
// process that never serves a request (#3624).

// Initialize environment variables
dotenv.config();

// Trust the OS certificate store (company CAs) unless NODE_USE_SYSTEM_CA=0.
// After dotenv so a .env file can opt out; before the first outbound connection.
const systemCa = applySystemCaDefault();
if (!cluster.isWorker) {
  const message = systemCa.applied
    ? 'Added the operating system certificate store to the trusted CAs'
    : `Operating system certificate store not added (${systemCa.reason})`;
  logger[systemCa.reason.startsWith('error') ? 'warn' : 'info'](message, {
    component: 'SystemCa',
    ...(systemCa.count && { certificates: systemCa.count })
  });
}
// Process-level safety net. Without these, a rejected promise with no local
// `.catch` (or an exception thrown outside Express's synchronous error
// handling) tears the process down with nothing written to the application log,
// leaving no trace of what actually failed.
process.on('unhandledRejection', reason => {
  logger.error({
    component: 'Server',
    message: 'Unhandled promise rejection',
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    pid: process.pid
  });
});

process.on('uncaughtException', error => {
  logger.error({
    component: 'Server',
    message: 'Uncaught exception, exiting',
    error: error?.message ?? String(error),
    stack: error?.stack,
    pid: process.pid
  });
  // The process is in an undefined state now; exit rather than keep serving
  // requests from a possibly corrupted worker. Under clustering the primary's
  // `exit` handler respawns it (see the `cluster.on('exit', ...)` below).
  //
  // The short delay gives winston's file transport a chance to flush; whether a
  // same-tick exit truncates the entry depends on the write stream's state, and
  // losing the one line that explains the crash is the worst possible outcome.
  setTimeout(() => process.exit(1), 100);
});

// ----- Cluster setup -----
const workerCount = config.WORKERS;

// Connection routing. By default the workers share the listening socket and
// Node's round-robin scheduler spreads connections evenly; per-chat state that
// ends up on the "wrong" worker is relayed over the cluster bus
// (`server/clusterBus.js`). STICKY_SESSIONS=true restores the old router, which
// pins each client to one worker by hashing its TCP peer address — correct only
// when clients reach iHub directly, since a proxy gives every request the same
// peer address and collapses the cluster onto one worker.
const stickyRouting = config.STICKY_SESSIONS === true;

if (cluster.isPrimary && workerCount > 1) {
  const { startPrimary } = await import('./startup/primary.js');
  await startPrimary({ workerCount, stickyRouting });
} else {
  // A cluster worker, or the single process when WORKERS=1.
  const { startWorker } = await import('./startup/worker.js');
  await startWorker({ stickyRouting });
}
