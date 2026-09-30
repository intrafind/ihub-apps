/**
 * CPU, memory and disk usage of this installation, as the admin "System
 * resources" page shows it.
 *
 * ## Why this exists
 *
 * The OpenTelemetry gauges in `telemetry/ProcessMetrics.js` cover the same
 * ground for deployments that run a metrics backend. Small single-host
 * installations usually don't, and the resource they run out of first is disk:
 * `contents/` (config, chats, run logs, uploads), the log directory and the
 * temp directory tend to share one small volume, and a full disk shows up as
 * failed saves and silently missing chat history long before anyone runs `df`.
 * This module answers "how much is left" from inside the product.
 *
 * ## Shape
 *
 * Three kinds of numbers, with different owners:
 *
 *  - **per process**: CPU, memory, event-loop delay. Every process answers
 *    for itself. In cluster mode an admin request lands on one worker, which
 *    asks the others (and the primary) over the cluster bus with `gather`.
 *  - **host**: cores, CPU limit, memory, load. The same for every process on
 *    the machine, so the worker serving the request reads it once.
 *  - **storage**: `statfs` of the directories iHub writes to, grouped by
 *    filesystem so one disk is not listed once per directory on it.
 *
 * Scope is one host. Replicas on several machines each have their own disk
 * and are what the OpenTelemetry exporters are for.
 */

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';
import cluster from 'node:cluster';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import config from '../config.js';
import { getContentsPath } from '../utils/contentsPath.js';
import { gather, respond, respondInPrimary } from '../clusterBus.js';
import logger from '../utils/logger.js';

/** Cluster-bus channel on which each process reports its own snapshot. */
export const SYSTEM_RESOURCES_CHANNEL = 'system:resources';

/**
 * Disk usage levels, in percent of the volume used (as `df` computes it).
 * Percentages rather than absolute free space, so a small tmpfs is not
 * flagged forever for being small. The page always shows the free bytes too.
 */
export const STORAGE_THRESHOLDS = Object.freeze({ warningPercent: 80, criticalPercent: 90 });

const STATUS_RANK = { ok: 0, warning: 1, critical: 2 };

/** How long a gather waits for silent processes before giving up on them. */
const GATHER_TIMEOUT_MS = 1500;

const DEFAULT_SAMPLE_INTERVAL_MS = 5000;

/**
 * Event-loop monitor tick, in ms. The histogram records the time between
 * ticks, so every value includes this interval; it is subtracted again to
 * report the actual lag (an idle loop reads ~0, not ~10).
 */
const LOOP_DELAY_RESOLUTION_MS = 10;

/**
 * Latest rolling sample. CPU percentages need two readings to mean anything,
 * so a background timer takes them at a fixed interval and a request reads the
 * most recent window. Measuring "since the last request" instead would give
 * numbers whose window depends on how often someone happens to look.
 */
const latestSample = {
  cpuPercent: null,
  hostCpuPercent: null,
  eventLoopDelayMs: null,
  sampledAt: null
};

let samplerTimer = null;
let loopDelay = null;
let unregisterResponder = null;

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function readHostCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

/**
 * Start sampling CPU and event-loop delay for this process. Idempotent; the
 * timer is unref'd so it never holds a shutting-down process open.
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs=5000]
 */
export function startResourceSampler({ intervalMs = DEFAULT_SAMPLE_INTERVAL_MS } = {}) {
  if (samplerTimer) return;

  loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  loopDelay.enable();

  let lastCpu = process.cpuUsage();
  let lastTime = process.hrtime.bigint();
  let lastHost = readHostCpuTimes();

  const tick = () => {
    try {
      const now = process.hrtime.bigint();
      const elapsedMicros = Number(now - lastTime) / 1000;
      const cpu = process.cpuUsage(lastCpu);
      if (elapsedMicros > 0) {
        // Percent of one core, like `top` and `docker stats`: a busy
        // single-threaded worker reads ~100, GC and libuv threads can push a
        // process past it.
        latestSample.cpuPercent = round(((cpu.user + cpu.system) / elapsedMicros) * 100);
      }

      const host = readHostCpuTimes();
      const totalDelta = host.total - lastHost.total;
      if (totalDelta > 0) {
        latestSample.hostCpuPercent = round((1 - (host.idle - lastHost.idle) / totalDelta) * 100);
      }

      // Histogram values are nanoseconds and include the tick interval; NaN
      // when nothing was recorded.
      const lagMs = ns => round(Math.max(0, ns / 1e6 - LOOP_DELAY_RESOLUTION_MS));
      latestSample.eventLoopDelayMs = Number.isFinite(loopDelay.mean)
        ? { mean: lagMs(loopDelay.mean), max: lagMs(loopDelay.max) }
        : null;
      loopDelay.reset();

      latestSample.sampledAt = new Date().toISOString();
      lastCpu = process.cpuUsage();
      lastTime = now;
      lastHost = host;
    } catch (error) {
      logger.warn({
        component: 'SystemResources',
        message: 'Resource sample failed',
        error: error.message
      });
    }
  };

  samplerTimer = setInterval(tick, intervalMs);
  samplerTimer.unref?.();
}

/**
 * Which kind of process this is: a cluster `worker`, the cluster `primary`
 * that forked them, or a `standalone` process (`WORKERS=1`) doing both jobs.
 */
export function getProcessRole() {
  if (cluster.isWorker) return 'worker';
  const forked = cluster.workers ? Object.keys(cluster.workers).length : 0;
  return forked > 0 ? 'primary' : 'standalone';
}

/** This process's own numbers. Cheap and synchronous, so safe to answer over IPC. */
export function getProcessSnapshot() {
  const role = getProcessRole();
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const workerIndex = Number.parseInt(process.env.WORKER_INDEX ?? '', 10);

  // Until the first sample lands, report the average since start rather than
  // nothing: it is the right order of magnitude and the page refreshes anyway.
  let cpuPercent = latestSample.cpuPercent;
  if (cpuPercent === null) {
    const usage = process.cpuUsage();
    const uptimeMicros = process.uptime() * 1e6;
    cpuPercent = uptimeMicros > 0 ? round(((usage.user + usage.system) / uptimeMicros) * 100) : 0;
  }

  return {
    role,
    workerIndex: role === 'worker' && Number.isInteger(workerIndex) ? workerIndex : null,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    cpuPercent,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      heapLimit: heap.heap_size_limit,
      external: memory.external
    },
    eventLoopDelayMs: latestSample.eventLoopDelayMs,
    sampledAt: latestSample.sampledAt
  };
}

/**
 * Parse cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>") into a
 * number of cores, or null when unlimited or unreadable.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseCgroupCpuMax(text) {
  if (typeof text !== 'string') return null;
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === 'max') return null;
  const quotaNum = Number(quota);
  const periodNum = Number(period ?? 100000);
  if (!Number.isFinite(quotaNum) || !Number.isFinite(periodNum) || quotaNum <= 0 || periodNum <= 0)
    return null;
  return round(quotaNum / periodNum, 2);
}

/** Container CPU limit in cores, from cgroup v2 or v1. Null when none applies. */
async function readCpuLimitCores() {
  if (process.platform !== 'linux') return null;
  try {
    return parseCgroupCpuMax(await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8'));
  } catch {
    // Not cgroup v2; fall through to v1.
  }
  try {
    const [quota, period] = await Promise.all([
      fs.readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'),
      fs.readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8')
    ]);
    // v1 spells "unlimited" as a quota of -1.
    return Number(quota) > 0 ? parseCgroupCpuMax(`${quota.trim()} ${period.trim()}`) : null;
  } catch {
    return null;
  }
}

/**
 * Host-wide CPU and memory. Honours container limits: `constrainedMemory()`
 * is the cgroup memory limit and `availableMemory()` what is left of it, so a
 * container capped at 2 GiB on a 64 GiB host reports 2 GiB, not 64.
 */
export async function getHostSnapshot() {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const constrained =
    typeof process.constrainedMemory === 'function' ? Number(process.constrainedMemory()) : 0;
  const limited = constrained > 0 && constrained < totalMemory;
  const memoryLimit = limited ? constrained : totalMemory;
  const rawAvailable =
    typeof process.availableMemory === 'function' ? Number(process.availableMemory()) : NaN;
  const available = Math.min(
    memoryLimit,
    Math.max(0, Number.isFinite(rawAvailable) ? rawAvailable : os.freemem())
  );
  const used = memoryLimit - available;

  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    uptimeSeconds: Math.round(os.uptime()),
    cpu: {
      model: cpus[0]?.model?.trim() || null,
      cores:
        typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpus.length,
      limitCores: await readCpuLimitCores(),
      utilizationPercent: latestSample.hostCpuPercent,
      // Always zeros on Windows, which has no load average.
      loadAverage: process.platform === 'win32' ? null : os.loadavg().map(v => round(v, 2))
    },
    memory: {
      total: memoryLimit,
      available,
      used,
      usedPercent: memoryLimit > 0 ? round((used / memoryLimit) * 100) : null,
      containerLimited: limited,
      hostTotal: totalMemory
    }
  };
}

/**
 * Status of a volume from how full it is.
 *
 * @param {number} usedPercent
 * @param {{warningPercent: number, criticalPercent: number}} [thresholds]
 * @returns {'ok'|'warning'|'critical'}
 */
export function evaluateStorageStatus(usedPercent, thresholds = STORAGE_THRESHOLDS) {
  if (!Number.isFinite(usedPercent)) return 'ok';
  if (usedPercent >= thresholds.criticalPercent) return 'critical';
  if (usedPercent >= thresholds.warningPercent) return 'warning';
  return 'ok';
}

/** The more severe of two statuses. */
export function worstStatus(a, b) {
  return (STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a;
}

/**
 * The log file winston writes to, when file logging is on. Relative paths
 * resolve against the working directory, as winston resolves them.
 *
 * @param {object} [platform] - Platform config.
 * @returns {string|null}
 */
export function getLogFilePath(platform) {
  const file = platform?.logging?.file;
  if (!file?.enabled) return null;
  return path.resolve(file.path || 'logs/app.log');
}

/**
 * The directories iHub writes to, labelled for the page.
 *
 * @param {object} [options]
 * @param {string|null} [options.logFile] - Active log file, if any.
 * @returns {Array<{key: string, path: string}>}
 */
export function getMonitoredPaths({ logFile = null } = {}) {
  const paths = [
    { key: 'contents', path: getContentsPath() },
    { key: 'data', path: getContentsPath(config.DATA_DIR || 'data') },
    { key: 'uploads', path: getContentsPath('uploads') }
  ];
  if (logFile) paths.push({ key: 'logs', path: path.dirname(logFile) });
  paths.push({ key: 'temp', path: os.tmpdir() });
  return paths;
}

/**
 * Disk usage of the filesystems behind `paths`. Paths on the same filesystem
 * (same `st_dev`) share one volume entry; paths that do not exist are skipped,
 * since nothing is written there.
 *
 * @param {Array<{key: string, path: string}>} [paths]
 * @param {object} [options]
 * @param {object} [options.thresholds]
 */
export async function getStorageSnapshot(
  paths = getMonitoredPaths(),
  { thresholds = STORAGE_THRESHOLDS } = {}
) {
  const volumesByDevice = new Map();

  for (const entry of paths) {
    let stat;
    let statfs;
    try {
      [stat, statfs] = await Promise.all([fs.stat(entry.path), fs.statfs(entry.path)]);
    } catch {
      continue;
    }

    const existing = volumesByDevice.get(stat.dev);
    if (existing) {
      existing.paths.push({ key: entry.key, path: entry.path });
      continue;
    }

    const blockSize = Number(statfs.bsize);
    const total = Number(statfs.blocks) * blockSize;
    // Pseudo filesystems report zero blocks; there is nothing to fill.
    if (!(total > 0)) continue;
    const free = Number(statfs.bfree) * blockSize;
    const available = Number(statfs.bavail) * blockSize;
    const used = total - free;
    // `df`'s Use%: blocks reserved for root count as neither used nor
    // available, so the percentage is what an unprivileged writer sees.
    const usedPercent = used + available > 0 ? round((used / (used + available)) * 100) : 0;

    volumesByDevice.set(stat.dev, {
      paths: [{ key: entry.key, path: entry.path }],
      total,
      used,
      available,
      usedPercent,
      status: evaluateStorageStatus(usedPercent, thresholds)
    });
  }

  const volumes = [...volumesByDevice.values()];
  const status = volumes.reduce((acc, volume) => worstStatus(acc, volume.status), 'ok');
  return { status, thresholds: { ...thresholds }, volumes };
}

/**
 * The fullest volume and the overall status, for a one-line summary such as
 * the admin Overview's. Null when no volume could be read.
 */
export function summarizeStorage(storage) {
  if (!storage?.volumes?.length) return null;
  const fullest = storage.volumes.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  return {
    status: storage.status,
    usedPercent: fullest.usedPercent,
    available: fullest.available,
    total: fullest.total
  };
}

const ROLE_ORDER = { primary: 0, standalone: 1, worker: 2 };

/**
 * Everything the System resources page shows. Asks the other processes of
 * the cluster for their own numbers; outside cluster mode this process is the
 * only one.
 *
 * @param {object} [options]
 * @param {string|null} [options.logFile]
 */
export async function collectSystemResources({ logFile = null } = {}) {
  const self = { ...getProcessSnapshot(), current: true };
  const clustered = cluster.isWorker;
  const configuredWorkers = clustered ? Number(config.WORKERS) || 1 : 1;

  const [others, host, storage] = await Promise.all([
    // Every other worker plus the primary answers, which is `configuredWorkers`
    // replies in all. Resolving on that count keeps the healthy case fast;
    // the timeout only runs out when someone is missing.
    clustered
      ? gather(SYSTEM_RESOURCES_CHANNEL, null, {
          expected: configuredWorkers,
          timeoutMs: GATHER_TIMEOUT_MS
        })
      : Promise.resolve([]),
    getHostSnapshot(),
    getStorageSnapshot(getMonitoredPaths({ logFile }))
  ]);

  const byPid = new Map([[self.pid, self]]);
  for (const reply of others) {
    if (reply && Number.isInteger(reply.pid) && !byPid.has(reply.pid)) {
      byPid.set(reply.pid, { ...reply, current: false });
    }
  }
  const processes = [...byPid.values()].sort(
    (a, b) =>
      (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) ||
      (a.workerIndex ?? 0) - (b.workerIndex ?? 0)
  );

  let missingWorkers = [];
  if (clustered) {
    const reported = new Set(processes.filter(p => p.role === 'worker').map(p => p.workerIndex));
    missingWorkers = Array.from({ length: configuredWorkers }, (_, i) => i).filter(
      i => !reported.has(i)
    );
  }

  return {
    collectedAt: new Date().toISOString(),
    cluster: {
      mode: clustered ? 'cluster' : 'standalone',
      configuredWorkers,
      missingWorkers,
      primaryReported: clustered ? processes.some(p => p.role === 'primary') : null
    },
    host,
    storage,
    processes
  };
}

/**
 * Start sampling and answer snapshot requests from the rest of the cluster.
 * Call once per process: from the primary after `initPrimaryBus`, from a
 * worker (or the standalone process) after `initWorkerBus`.
 */
export function initSystemResources() {
  startResourceSampler();
  if (unregisterResponder) return;
  unregisterResponder = cluster.isPrimary
    ? respondInPrimary(SYSTEM_RESOURCES_CHANNEL, () => getProcessSnapshot())
    : respond(SYSTEM_RESOURCES_CHANNEL, () => getProcessSnapshot());
}

/** Test seam: stop the sampler and forget the latest sample. */
export function resetSystemResourcesForTests() {
  if (samplerTimer) clearInterval(samplerTimer);
  samplerTimer = null;
  loopDelay?.disable();
  loopDelay = null;
  unregisterResponder?.();
  unregisterResponder = null;
  latestSample.cpuPercent = null;
  latestSample.hostCpuPercent = null;
  latestSample.eventLoopDelayMs = null;
  latestSample.sampledAt = null;
}
