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
 * - **Heap per worker.** A `--max-old-space-size` or `--max-heap-size` in
 *   `NODE_OPTIONS` or on the command line wins. Otherwise, with a memory limit
 *   and more than one worker, each worker's share of the limit is split: what
 *   a Node process uses outside its V8 heap ({@link WORKER_NON_HEAP_MB}), the
 *   young generation Node sizes from the container's limit
 *   ({@link nodeYoungGenerationMb}), and the rest as the old-space limit (at
 *   least {@link LOWEST_WORKER_HEAP_MB}) — so old space, young generation and
 *   non-heap together never exceed the share. A worker that needs more than
 *   its share does not fit — fewer than {@link WORKER_BUDGET_MB} per worker,
 *   or an admin heap flag that leaves too little for the rest: the decision
 *   is logged as a warning naming how many workers fit and how much memory
 *   the requested count needs.
 *   A single process keeps Node's own default, which already follows the
 *   container limit.
 * - **Young generation.** Left to Node. Node 24 already sizes it from the
 *   container (64 MB semi-space above 2 GiB), so a larger flag did nothing and
 *   a smaller one only halved it; an admin's `--max-semi-space-size` is still
 *   passed on and budgeted.
 *
 * Measured on Kubernetes (k3s, no swap, 14 workers, 2,000–2,500 users): a
 * worker uses 1.5–1.7 GB RSS under load, largely independent of its heap
 * limit — 1.5 GB even with a 657 MB heap, most of it outside the main heap
 * (worker-thread isolates up to their caps, buffers, code). 14 workers in
 * 24 GiB ran without OOM; in 18 GiB they were OOM-killed, in 14 GiB
 * repeatedly.
 *
 * @module utils/workerSizing
 */
import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';

/** Workers without a memory limit, and the ceiling of a derived count. */
export const DEFAULT_WORKERS = 4;

/** Memory set aside for the cluster primary, which only supervises (~120 MB RSS). */
export const PRIMARY_RESERVE_MB = 160;

/**
 * Memory one worker is planned with: the derived count fits this many MB per
 * worker, and a share below it does not fit (measured 1.5–1.7 GB RSS per
 * worker under load).
 */
export const WORKER_BUDGET_MB = 1700;

/**
 * What a worker process uses outside its main V8 heap: the isolates of its
 * worker threads (up to their caps), buffers, native allocations and code.
 */
export const WORKER_NON_HEAP_MB = 850;

/** V8's young generation is this many times the semi-space size. */
export const YOUNG_GENERATION_FACTOR = 3;

/** Smallest heap a worker is given, even when its share cannot hold it. */
export const LOWEST_WORKER_HEAP_MB = 256;

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

/**
 * Node's default young generation, in MB, for a container memory limit: V8
 * sizes the semi-space from the memory it may use (16 MB up to 1 GiB, 32 MB up
 * to 2 GiB, 64 MB above), whatever `--max-old-space-size` says. Measured with
 * Node 24.22 in containers: `heap_size_limit` minus the old-space flag.
 *
 * @param {number} limitMb - Container memory limit in MB
 * @returns {number} MB
 */
export function nodeYoungGenerationMb(limitMb) {
  if (limitMb <= 1024) return YOUNG_GENERATION_FACTOR * 16;
  if (limitMb <= 2048) return YOUNG_GENERATION_FACTOR * 32;
  return YOUNG_GENERATION_FACTOR * 64;
}

/**
 * The value of a V8 size flag (`--max-old-space-size=900`, `--max_heap_size 900`)
 * in `NODE_OPTIONS` or the command line; the last one wins, as in V8.
 *
 * @param {string} name - Flag name with dashes, without the leading `--`
 * @param {string} [nodeOptions] - `NODE_OPTIONS`
 * @param {string[]} [execArgv] - `process.execArgv`
 * @returns {number|null} MB, or null when not given
 */
export function sizeFlagMb(name, nodeOptions = '', execArgv = []) {
  const pattern = new RegExp(`--${name.replace(/-/g, '[-_]')}(?:=|\\s+)(\\d+)`, 'g');
  const matches = [...[nodeOptions || '', ...execArgv].join(' ').matchAll(pattern)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
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
 * Whether a V8 heap limit (`--max-old-space-size` or `--max-heap-size`) was
 * already given to this process.
 *
 * @param {string} [nodeOptions] - `NODE_OPTIONS`
 * @param {string[]} [execArgv] - `process.execArgv`
 * @returns {boolean}
 */
export function hasHeapLimitFlag(nodeOptions = '', execArgv = []) {
  return (
    sizeFlagMb('max-old-space-size', nodeOptions, execArgv) !== null ||
    sizeFlagMb('max-heap-size', nodeOptions, execArgv) !== null
  );
}

/**
 * Decide the worker count and the heap limit per worker.
 *
 * @param {Object} input
 * @param {number|undefined} input.explicitWorkers - `WORKERS` / `NUM_WORKERS`, when set
 * @param {number|null} input.memoryLimitBytes - Container memory limit, or null
 * @param {number} input.cpus - Available parallelism
 * @param {boolean} input.heapFlagSet - Whether `--max-old-space-size` or `--max-heap-size` was given
 * @param {number|null} [input.oldSpaceFlagMb] - The `--max-old-space-size` given, in MB
 * @param {number|null} [input.heapSizeFlagMb] - The `--max-heap-size` given, in MB
 * @param {number|null} [input.semiSpaceFlagMb] - The `--max-semi-space-size` given, in MB
 * @returns {{workers: number, workersSource: 'env'|'memory limit'|'default',
 *   heapMb: number|null, heapSource: 'NODE_OPTIONS'|'memory limit'|'node default',
 *   youngMb: number|null, shareMb: number|null, workerNeedsMb: number, fits: boolean,
 *   limitMb: number|null, cpus: number}}
 */
export function decideWorkerSizing({
  explicitWorkers,
  memoryLimitBytes,
  cpus,
  heapFlagSet,
  oldSpaceFlagMb = null,
  heapSizeFlagMb = null,
  semiSpaceFlagMb = null
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
  let youngMb = null;
  let shareMb = null;
  let workerNeedsMb = WORKER_BUDGET_MB;
  let fits = true;
  if (limitMb !== null) {
    youngMb = semiSpaceFlagMb
      ? YOUNG_GENERATION_FACTOR * semiSpaceFlagMb
      : nodeYoungGenerationMb(limitMb);
  }
  if (heapFlagSet) {
    heapSource = 'NODE_OPTIONS';
    // The admin's heap is not ours to change, but it has to fit: the flag's
    // heap (old space plus young generation) next to the non-heap memory.
    const flagHeapMb = heapSizeFlagMb ?? (oldSpaceFlagMb ? oldSpaceFlagMb + (youngMb ?? 0) : null);
    if (limitMb !== null) {
      shareMb = Math.floor((limitMb - (workers > 1 ? PRIMARY_RESERVE_MB : 0)) / workers);
      if (flagHeapMb) workerNeedsMb = Math.max(WORKER_BUDGET_MB, flagHeapMb + WORKER_NON_HEAP_MB);
      fits = shareMb >= workerNeedsMb;
    }
  } else if (limitMb !== null && workers > 1) {
    shareMb = Math.floor((limitMb - PRIMARY_RESERVE_MB) / workers);
    fits = shareMb >= WORKER_BUDGET_MB;
    heapMb = Math.max(LOWEST_WORKER_HEAP_MB, shareMb - WORKER_NON_HEAP_MB - youngMb);
    heapSource = 'memory limit';
  }

  return {
    workers,
    workersSource,
    heapMb,
    heapSource,
    youngMb,
    shareMb,
    workerNeedsMb,
    fits,
    limitMb,
    cpus: cpuCount
  };
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
  const flag = name => sizeFlagMb(name, env.NODE_OPTIONS, execArgv);
  return decideWorkerSizing({
    explicitWorkers,
    memoryLimitBytes: memoryLimit(),
    cpus: availableParallelism(),
    heapFlagSet: hasHeapLimitFlag(env.NODE_OPTIONS, execArgv),
    oldSpaceFlagMb: flag('max-old-space-size'),
    heapSizeFlagMb: flag('max-heap-size'),
    semiSpaceFlagMb: flag('max-semi-space-size')
  });
}

/**
 * The decision as one log line, written once by the process that starts the
 * cluster (or by the single process); log it as a warning when `sizing.fits`
 * is false.
 *
 * @param {ReturnType<typeof decideWorkerSizing>} sizing - The decision
 * @returns {Object} Log fields, `message` included
 */
export function describeWorkerSizing(sizing) {
  const fits = sizing.fits !== false;
  const needsMb = sizing.workerNeedsMb ?? WORKER_BUDGET_MB;
  const maxWorkers = Math.max(1, Math.floor((sizing.limitMb - PRIMARY_RESERVE_MB) / needsMb));
  const neededMb = PRIMARY_RESERVE_MB + sizing.workers * needsMb;
  return {
    component: 'Server',
    message: `Worker sizing: ${sizing.workers} worker(s) (${sizing.workersSource}), heap per worker ${
      sizing.heapMb ? `${sizing.heapMb} MB` : 'Node default'
    } (${sizing.heapSource})${
      fits
        ? ''
        : ` — ${sizing.workers} workers do not fit into the memory limit: ${sizing.shareMb} MB each, a worker needs ${needsMb} MB. At most ${maxWorkers} worker(s) fit into ${sizing.limitMb} MB; ${sizing.workers} workers need ${neededMb} MB. Lower WORKERS${
            sizing.heapSource === 'NODE_OPTIONS' ? ' or the heap flag' : ''
          } or raise the limit`
    }`,
    workers: sizing.workers,
    workersSource: sizing.workersSource,
    heapPerWorkerMb: sizing.heapMb,
    heapSource: sizing.heapSource,
    youngGenerationMb: sizing.youngMb ?? null,
    shareMb: sizing.shareMb ?? null,
    memoryLimitMb: sizing.limitMb,
    cpus: sizing.cpus
  };
}

/**
 * The flags a worker is started with: the primary's own, plus the heap limit
 * when it was decided.
 *
 * @param {{heapMb: number|null}} sizing - The decision
 * @param {string[]} [execArgv] - The primary's flags
 * @returns {string[]}
 */
export function workerExecArgv(sizing, execArgv = process.execArgv) {
  const flags = [...execArgv];
  if (sizing?.heapMb) flags.push(`--max-old-space-size=${sizing.heapMb}`);
  return flags;
}

/**
 * Let this process's worker threads use their own heap limits.
 *
 * V8 heap flags are process-wide: a `--max-old-space-size`, `--max-heap-size`
 * or `--max-semi-space-size` given to a process (by {@link workerExecArgv},
 * `NODE_OPTIONS` or the command line) also overrides the `resourceLimits` of
 * every worker thread it starts — a thread asking for 256 MB got the worker's
 * whole heap limit. The main isolate reads the flags once, when it is created,
 * so resetting them to V8's "not set" afterwards keeps this process's own
 * limits and lets each thread's `resourceLimits` apply again. Call it before
 * the first thread starts. Node calls `v8.setFlagsFromString` after startup
 * unsupported; `server/tests/thread-heap-limits.test.js` pins the behaviour.
 */
export function releaseThreadHeapFlags() {
  v8.setFlagsFromString('--max-old-space-size=0');
  v8.setFlagsFromString('--max-heap-size=0');
  v8.setFlagsFromString('--max-semi-space-size=0');
}
