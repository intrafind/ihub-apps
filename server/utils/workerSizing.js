// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How many workers to run, and how much V8 heap each may use, decided from the
 * container the server runs in (#3624).
 *
 * Without this every process sized itself as if it owned the machine: four
 * workers by default whatever the memory limit, and each V8 heap limit derived
 * from the container's whole limit — five processes "allowed" about 5.5 GB of
 * heap in a 2 GB pod, so V8 had no reason to collect before the kernel killed
 * the container.
 *
 * The rules, applied once by the process that starts the cluster:
 *
 * - **Workers.** `WORKERS` / `NUM_WORKERS` win when set. Otherwise, with a
 *   cgroup memory limit, as many workers as fit into the limit after the
 *   primary's reserve at {@link WORKER_BUDGET_MB} each — at least one, at most
 *   the CPU count and never more than {@link DEFAULT_WORKERS}. Without a limit,
 *   {@link DEFAULT_WORKERS}, as before.
 * - **Heap per worker.** A `--max-old-space-size` in `NODE_OPTIONS` or on the
 *   command line wins. Otherwise, with a memory limit and more than one
 *   worker, each worker gets its share of the limit minus what a Node process
 *   uses outside the old-space heap ({@link WORKER_NON_HEAP_MB}), never less
 *   than {@link MIN_WORKER_HEAP_MB}. A single process keeps Node's own
 *   default, which already follows the container limit.
 * - **Young generation per worker.** A `--max-semi-space-size` given by the
 *   admin wins. Otherwise a worker with a heap limit from the memory limit gets
 *   a larger young generation when its share allows it ({@link semiSpaceMbFor}):
 *   chat turns allocate many short-lived objects, and Node's default young
 *   generation promotes them into the old space, whose collections paused the
 *   event loop for up to a second. A load test at 1,500 users (6 workers,
 *   ~1.3 GB per worker) measured the event-loop peak about 30% lower with 64 MB.
 *   The young generation takes about three times the semi-space, out of
 *   {@link WORKER_NON_HEAP_MB}; 128 MB did not fit and a worker was killed.
 *
 * @module utils/workerSizing
 */
import fs from 'node:fs';
import os from 'node:os';

/** Workers without a memory limit, and the ceiling of a derived count. */
export const DEFAULT_WORKERS = 4;

/** Memory set aside for the cluster primary, which only supervises (~120 MB RSS). */
export const PRIMARY_RESERVE_MB = 160;

/**
 * Memory one worker is planned with: ~450–550 MB RSS idle after boot, plus
 * headroom for the requests it serves (file extraction, large chats).
 */
export const WORKER_BUDGET_MB = 768;

/**
 * What a worker process uses besides its old-space heap: code, the young
 * generation, buffers and native allocations.
 */
export const WORKER_NON_HEAP_MB = 300;

/** Lowest heap limit handed to a worker. */
export const MIN_WORKER_HEAP_MB = 512;

/** cgroup v2, then v1. */
const CGROUP_LIMIT_FILES = Object.freeze([
  '/sys/fs/cgroup/memory.max',
  '/sys/fs/cgroup/memory/memory.limit_in_bytes'
]);

/**
 * cgroup v1 reports "no limit" as a page-rounded `LONG_MAX`; anything this
 * large is not a limit anybody set.
 */
const UNLIMITED_THRESHOLD = 2 ** 60;

const HEAP_FLAG = /--max[-_]old[-_]space[-_]size(?:=|\s|$)/;
const SEMI_SPACE_FLAG = /--max[-_]semi[-_]space[-_]size(?:=|\s|$)/;

/**
 * Semi-space size for a worker's share of the memory limit: 64 MB from about
 * 1.2 GB per worker, 32 MB from 800 MB, otherwise Node's default.
 *
 * @param {number} shareMb - Memory per worker (limit minus the primary's reserve, divided by workers)
 * @returns {number|null} MB, or null for Node's default
 */
export function semiSpaceMbFor(shareMb) {
  if (shareMb >= 1200) return 64;
  if (shareMb >= 800) return 32;
  return null;
}

/**
 * The container's memory limit, from the cgroup.
 *
 * @param {(file: string) => string} [readFile] - Reads a file; for tests.
 * @returns {number|null} Bytes, or null when there is no limit (or no cgroup).
 */
export function readContainerMemoryLimit(readFile = file => fs.readFileSync(file, 'utf8')) {
  for (const file of CGROUP_LIMIT_FILES) {
    let text;
    try {
      text = String(readFile(file)).trim();
    } catch {
      continue;
    }
    if (text === 'max') return null;
    const bytes = Number(text);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    return bytes >= UNLIMITED_THRESHOLD ? null : bytes;
  }
  return null;
}

/**
 * Whether a V8 old-space limit was already given to this process.
 *
 * @param {string} [nodeOptions] - `NODE_OPTIONS`
 * @param {string[]} [execArgv] - `process.execArgv`
 * @returns {boolean}
 */
export function hasHeapLimitFlag(nodeOptions = '', execArgv = []) {
  return HEAP_FLAG.test(nodeOptions || '') || execArgv.some(arg => HEAP_FLAG.test(arg));
}

/**
 * Whether a V8 semi-space size was already given to this process.
 *
 * @param {string} [nodeOptions] - `NODE_OPTIONS`
 * @param {string[]} [execArgv] - `process.execArgv`
 * @returns {boolean}
 */
export function hasSemiSpaceFlag(nodeOptions = '', execArgv = []) {
  return SEMI_SPACE_FLAG.test(nodeOptions || '') || execArgv.some(arg => SEMI_SPACE_FLAG.test(arg));
}

/**
 * Decide the worker count and the heap limit per worker.
 *
 * @param {Object} input
 * @param {number|undefined} input.explicitWorkers - `WORKERS` / `NUM_WORKERS`, when set
 * @param {number|null} input.memoryLimitBytes - Container memory limit, or null
 * @param {number} input.cpus - Available parallelism
 * @param {boolean} input.heapFlagSet - Whether `--max-old-space-size` was given
 * @param {boolean} [input.semiSpaceFlagSet] - Whether `--max-semi-space-size` was given
 * @returns {{workers: number, workersSource: 'env'|'memory limit'|'default',
 *   heapMb: number|null, heapSource: 'NODE_OPTIONS'|'memory limit'|'node default',
 *   semiSpaceMb: number|null, limitMb: number|null, cpus: number}}
 */
export function decideWorkerSizing({
  explicitWorkers,
  memoryLimitBytes,
  cpus,
  heapFlagSet,
  semiSpaceFlagSet = false
}) {
  const limitMb =
    Number.isFinite(memoryLimitBytes) && memoryLimitBytes > 0
      ? Math.floor(memoryLimitBytes / (1024 * 1024))
      : null;
  const cpuCount = Number.isFinite(cpus) && cpus >= 1 ? Math.floor(cpus) : 1;

  let workers;
  let workersSource;
  if (Number.isFinite(explicitWorkers) && explicitWorkers >= 1) {
    workers = Math.floor(explicitWorkers);
    workersSource = 'env';
  } else if (limitMb !== null) {
    const fit = Math.floor((limitMb - PRIMARY_RESERVE_MB) / WORKER_BUDGET_MB);
    workers = Math.max(1, Math.min(fit, cpuCount, DEFAULT_WORKERS));
    workersSource = 'memory limit';
  } else {
    workers = DEFAULT_WORKERS;
    workersSource = 'default';
  }

  let heapMb = null;
  let heapSource = 'node default';
  let semiSpaceMb = null;
  if (heapFlagSet) {
    heapSource = 'NODE_OPTIONS';
  } else if (limitMb !== null && workers > 1) {
    const share = Math.floor((limitMb - PRIMARY_RESERVE_MB) / workers);
    heapMb = Math.max(MIN_WORKER_HEAP_MB, share - WORKER_NON_HEAP_MB);
    heapSource = 'memory limit';
    if (!semiSpaceFlagSet) semiSpaceMb = semiSpaceMbFor(share);
  }

  return { workers, workersSource, heapMb, heapSource, semiSpaceMb, limitMb, cpus: cpuCount };
}

/**
 * The decision for this process, from its environment and the cgroup.
 *
 * @param {Object} [options]
 * @param {number|undefined} [options.explicitWorkers] - Parsed `WORKERS` / `NUM_WORKERS`
 * @param {NodeJS.ProcessEnv} [options.env] - Environment
 * @param {string[]} [options.execArgv] - Command-line flags
 * @param {() => number|null} [options.memoryLimit] - Reads the memory limit
 * @param {() => number} [options.availableParallelism] - CPU count
 * @returns {ReturnType<typeof decideWorkerSizing>}
 */
export function workerSizingForProcess({
  explicitWorkers,
  env = process.env,
  execArgv = process.execArgv,
  memoryLimit = readContainerMemoryLimit,
  availableParallelism = () =>
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
} = {}) {
  return decideWorkerSizing({
    explicitWorkers,
    memoryLimitBytes: memoryLimit(),
    cpus: availableParallelism(),
    heapFlagSet: hasHeapLimitFlag(env.NODE_OPTIONS, execArgv),
    semiSpaceFlagSet: hasSemiSpaceFlag(env.NODE_OPTIONS, execArgv)
  });
}

/**
 * The decision as one log line, written once by the process that starts the
 * cluster (or by the single process).
 *
 * @param {ReturnType<typeof decideWorkerSizing>} sizing - The decision
 * @returns {Object} Log fields, `message` included
 */
export function describeWorkerSizing(sizing) {
  return {
    component: 'Server',
    message: `Worker sizing: ${sizing.workers} worker(s) (${sizing.workersSource}), heap per worker ${
      sizing.heapMb ? `${sizing.heapMb} MB` : 'Node default'
    } (${sizing.heapSource})${sizing.semiSpaceMb ? `, young generation ${sizing.semiSpaceMb} MB semi-space` : ''}`,
    workers: sizing.workers,
    workersSource: sizing.workersSource,
    heapPerWorkerMb: sizing.heapMb,
    heapSource: sizing.heapSource,
    semiSpaceMb: sizing.semiSpaceMb ?? null,
    memoryLimitMb: sizing.limitMb,
    cpus: sizing.cpus
  };
}

/**
 * The flags a worker is started with: the primary's own, plus the heap limit
 * and the semi-space size when they were decided.
 *
 * @param {{heapMb: number|null, semiSpaceMb?: number|null}} sizing - The decision
 * @param {string[]} [execArgv] - The primary's flags
 * @returns {string[]}
 */
export function workerExecArgv(sizing, execArgv = process.execArgv) {
  const flags = [...execArgv];
  if (sizing?.heapMb) flags.push(`--max-old-space-size=${sizing.heapMb}`);
  if (sizing?.semiSpaceMb) flags.push(`--max-semi-space-size=${sizing.semiSpaceMb}`);
  return flags;
}
