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
 * Decide the worker count and the heap limit per worker.
 *
 * @param {Object} input
 * @param {number|undefined} input.explicitWorkers - `WORKERS` / `NUM_WORKERS`, when set
 * @param {number|null} input.memoryLimitBytes - Container memory limit, or null
 * @param {number} input.cpus - Available parallelism
 * @param {boolean} input.heapFlagSet - Whether `--max-old-space-size` was given
 * @returns {{workers: number, workersSource: 'env'|'memory limit'|'default',
 *   heapMb: number|null, heapSource: 'NODE_OPTIONS'|'memory limit'|'node default',
 *   limitMb: number|null, cpus: number}}
 */
export function decideWorkerSizing({ explicitWorkers, memoryLimitBytes, cpus, heapFlagSet }) {
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
  if (heapFlagSet) {
    heapSource = 'NODE_OPTIONS';
  } else if (limitMb !== null && workers > 1) {
    const share = Math.floor((limitMb - PRIMARY_RESERVE_MB) / workers);
    heapMb = Math.max(MIN_WORKER_HEAP_MB, share - WORKER_NON_HEAP_MB);
    heapSource = 'memory limit';
  }

  return { workers, workersSource, heapMb, heapSource, limitMb, cpus: cpuCount };
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
    heapFlagSet: hasHeapLimitFlag(env.NODE_OPTIONS, execArgv)
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
    } (${sizing.heapSource})`,
    workers: sizing.workers,
    workersSource: sizing.workersSource,
    heapPerWorkerMb: sizing.heapMb,
    heapSource: sizing.heapSource,
    memoryLimitMb: sizing.limitMb,
    cpus: sizing.cpus
  };
}

/**
 * The flags a worker is started with: the primary's own, plus the heap limit
 * when one was decided.
 *
 * @param {{heapMb: number|null}} sizing - The decision
 * @param {string[]} [execArgv] - The primary's flags
 * @returns {string[]}
 */
export function workerExecArgv(sizing, execArgv = process.execArgv) {
  if (!sizing?.heapMb) return [...execArgv];
  return [...execArgv, `--max-old-space-size=${sizing.heapMb}`];
}
