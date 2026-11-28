// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import cluster from 'node:cluster';
import logger from '../utils/logger.js';

/**
 * Process / runtime observable gauges. Registered as observable callbacks on
 * the global meter once initializeMetrics() has run, so they cost nothing
 * until the metrics backend actually scrapes them.
 *
 * Exposed metrics:
 *   process.cpu.utilization               (gauge, 1)            - 0..1, normalised CPU usage
 *   process.memory.usage                  (gauge, By)           - resident set size
 *   process.open_file_descriptor.count    (gauge)               - open file descriptors (Linux)
 *   ihub.workers.count                    (gauge, {worker})     - 1 per worker process
 *
 * Event loop, GC and heap spaces: @opentelemetry/instrumentation-runtime-node
 * (`nodejs.eventloop.*`, `v8js.*`), registered in telemetry.js.
 */
export function initializeProcessMetrics(meterSource) {
  if (!meterSource || typeof meterSource.getMeter !== 'function') return;

  const meter = meterSource.getMeter('ihub-apps-process', '1.0.0');

  // CPU utilisation needs a previous sample to compute against.
  let lastCpu = process.cpuUsage();
  let lastSampleTime = Date.now();

  meter
    .createObservableGauge('process.cpu.utilization', {
      description: 'Process CPU utilisation (0-1, summed over user+system)',
      unit: '1'
    })
    .addCallback(observableResult => {
      try {
        const now = Date.now();
        const cpu = process.cpuUsage(lastCpu);
        const elapsedMicros = (now - lastSampleTime) * 1000;
        if (elapsedMicros > 0) {
          const utilization = (cpu.user + cpu.system) / elapsedMicros;
          observableResult.observe(Math.max(0, Math.min(1, utilization)));
        }
        lastCpu = process.cpuUsage();
        lastSampleTime = now;
      } catch (error) {
        logger.warn('Failed to observe process.cpu.utilization', {
          component: 'ProcessMetrics',
          error: error.message
        });
      }
    });

  meter
    .createObservableGauge('process.memory.usage', {
      description:
        'Resident set size of this process (per process: sum across workers). Heap detail: v8js.memory.heap.*',
      unit: 'By'
    })
    .addCallback(observableResult => {
      try {
        observableResult.observe(process.memoryUsage.rss());
      } catch (error) {
        logger.warn('Failed to observe process.memory.usage', {
          component: 'ProcessMetrics',
          error: error.message
        });
      }
    });

  meter
    .createObservableGauge('process.open_file_descriptor.count', {
      description: 'Open file descriptors of this process (Linux; per process: sum across workers)',
      unit: '{file_descriptor}'
    })
    .addCallback(observableResult => {
      const count = openFileDescriptors();
      if (count !== null) observableResult.observe(count);
    });

  meter
    .createObservableGauge('ihub.workers.count', {
      description: 'Number of serving processes visible from this Node process',
      unit: '{worker}'
    })
    .addCallback(observableResult => {
      try {
        // Three cases to disambiguate:
        //   1. Sticky-cluster primary with forked workers: report the worker count.
        //   2. Single-process mode (WORKERS=1): cluster.isPrimary is true but no
        //      workers have been forked - this very process is the only serving
        //      one, so report 1 (not 0, which is what cluster.workers gives).
        //   3. Worker process: each worker reports 1 from its own /metrics.
        let count = 1;
        let role = 'primary';
        if (cluster.isPrimary) {
          const workerCount = cluster.workers ? Object.keys(cluster.workers).length : 0;
          count = workerCount > 0 ? workerCount : 1;
        } else {
          role = 'worker';
        }
        observableResult.observe(count, { 'cluster.role': role });
      } catch (error) {
        logger.warn('Failed to observe ihub.workers.count', {
          component: 'ProcessMetrics',
          error: error.message
        });
      }
    });

  logger.info('Process metrics initialized', { component: 'ProcessMetrics' });
}

/**
 * The number of open file descriptors of this process, from `/proc/self/fd`;
 * null where there is no procfs (macOS, Windows).
 *
 * @returns {number|null}
 */
export function openFileDescriptors() {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}
