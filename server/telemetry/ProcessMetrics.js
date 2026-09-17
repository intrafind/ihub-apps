import { monitorEventLoopDelay } from 'perf_hooks';
import cluster from 'cluster';
import logger from '../utils/logger.js';

/**
 * Process / runtime observable gauges. Registered as observable callbacks on
 * the global meter once initializeMetrics() has run, so they cost nothing
 * until the metrics backend actually scrapes them.
 *
 * Exposed metrics:
 *   process.cpu.utilization               (gauge, 1)            - 0..1, normalised CPU usage
 *   process.runtime.nodejs.memory.usage   (gauge, By, by `mem.type` ∈ rss/heap_used/heap_total/external)
 *   process.runtime.nodejs.event_loop.delay (gauge, s)          - mean event-loop delay
 *   ihub.workers.count                    (gauge, {worker})     - number of cluster workers from this process's POV
 */
export function initializeProcessMetrics(meterSource) {
  if (!meterSource || typeof meterSource.getMeter !== 'function') return;

  const meter = meterSource.getMeter('ihub-apps-process', '1.0.0');

  // Event-loop delay histogram - once per process. Use a 100ms resolution
  // monitor; we only read the mean / stddev each scrape.
  const elDelay = monitorEventLoopDelay({ resolution: 100 });
  elDelay.enable();

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
    .createObservableGauge('process.runtime.nodejs.memory.usage', {
      description: 'Node.js process memory usage by type',
      unit: 'By'
    })
    .addCallback(observableResult => {
      try {
        const m = process.memoryUsage();
        observableResult.observe(m.rss, { 'mem.type': 'rss' });
        observableResult.observe(m.heapUsed, { 'mem.type': 'heap_used' });
        observableResult.observe(m.heapTotal, { 'mem.type': 'heap_total' });
        observableResult.observe(m.external, { 'mem.type': 'external' });
      } catch (error) {
        logger.warn('Failed to observe process.runtime.nodejs.memory.usage', {
          component: 'ProcessMetrics',
          error: error.message
        });
      }
    });

  meter
    .createObservableGauge('process.runtime.nodejs.event_loop.delay', {
      description: 'Mean event-loop delay since the last scrape (seconds)',
      unit: 's'
    })
    .addCallback(observableResult => {
      try {
        // .mean is in nanoseconds; convert to seconds for the unit
        const meanSec = elDelay.mean / 1e9;
        if (Number.isFinite(meanSec)) {
          observableResult.observe(meanSec);
        }
        elDelay.reset();
      } catch (error) {
        logger.warn('Failed to observe event_loop.delay', {
          component: 'ProcessMetrics',
          error: error.message
        });
      }
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
