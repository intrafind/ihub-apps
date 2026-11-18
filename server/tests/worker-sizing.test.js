// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Worker count and per-worker heap limit from the container (#3624).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKERS,
  decideWorkerSizing,
  describeWorkerSizing,
  hasHeapLimitFlag,
  NODE_DEFAULT_SEMI_SPACE_MB,
  WORKER_BUDGET_MB,
  WORKER_NON_HEAP_MB,
  readContainerMemoryLimit,
  workerExecArgv,
  workerSizingForProcess
} from '../utils/workerSizing.js';

const MiB = 1024 * 1024;

test('a 4 GiB pod with four CPUs runs two workers with a heap limit each', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: undefined,
    memoryLimitBytes: 4096 * MiB,
    cpus: 4,
    heapFlagSet: false
  });
  assert.equal(sizing.workers, 2);
  assert.equal(sizing.workersSource, 'memory limit');
  // (4096 − 160) / 2 = 1968 → 1968 − 850 non-heap − 3 × 32 young = 1022
  assert.equal(sizing.heapMb, 1022);
  assert.equal(sizing.semiSpaceMb, 32);
  assert.equal(sizing.heapSource, 'memory limit');
  assert.equal(sizing.limitMb, 4096);
  assert.equal(sizing.fits, true);
});

test('a 2000 MiB pod runs a single process', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: undefined,
    memoryLimitBytes: 2000 * MiB,
    cpus: 4,
    heapFlagSet: false
  });
  assert.equal(sizing.workers, 1);
  assert.equal(sizing.heapMb, null);
});

test('old space + young generation + non-heap never exceed a derived share', () => {
  for (let limitMb = 1024; limitMb <= 64 * 1024; limitMb += 128) {
    for (const cpus of [1, 2, 4, 8, 16]) {
      const sizing = decideWorkerSizing({
        explicitWorkers: undefined,
        memoryLimitBytes: limitMb * MiB,
        cpus,
        heapFlagSet: false
      });
      if (sizing.heapMb === null) continue;
      const youngMb = 3 * (sizing.semiSpaceMb ?? NODE_DEFAULT_SEMI_SPACE_MB);
      const label = `${limitMb} MiB, ${cpus} CPUs`;
      assert.ok(sizing.fits, label);
      assert.ok(sizing.shareMb >= WORKER_BUDGET_MB, label);
      assert.ok(sizing.heapMb + youngMb + WORKER_NON_HEAP_MB <= sizing.shareMb, label);
      assert.ok(160 + sizing.workers * sizing.shareMb <= limitMb, label);
    }
  }
});

test('the derived count is capped by the CPUs and by the default', () => {
  const big = { explicitWorkers: undefined, memoryLimitBytes: 64 * 1024 * MiB, heapFlagSet: false };
  assert.equal(decideWorkerSizing({ ...big, cpus: 2 }).workers, 2);
  assert.equal(decideWorkerSizing({ ...big, cpus: 32 }).workers, DEFAULT_WORKERS);
});

test('a small pod runs one process with Node’s own heap default', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: undefined,
    memoryLimitBytes: 768 * MiB,
    cpus: 4,
    heapFlagSet: false
  });
  assert.equal(sizing.workers, 1);
  assert.equal(sizing.heapMb, null, 'a single process has no primary to hand it a flag');
  assert.equal(sizing.heapSource, 'node default');
});

test('an explicit WORKERS wins; the heap still follows the limit', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: 3,
    memoryLimitBytes: 4096 * MiB,
    cpus: 2,
    heapFlagSet: false
  });
  assert.equal(sizing.workers, 3);
  assert.equal(sizing.workersSource, 'env');
  // (4096 − 160) / 3 = 1312 → 1312 − 850 − 3 × 16 (Node's default semi-space) = 414
  assert.equal(sizing.heapMb, 414);
  assert.equal(sizing.semiSpaceMb, null);
  assert.equal(sizing.fits, false, '1312 MB is below the 1700 MB a worker needs');
});

test('an explicit WORKERS that does not fit gets what is left and a warning', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: 4,
    memoryLimitBytes: 1024 * MiB,
    cpus: 4,
    heapFlagSet: false
  });
  assert.equal(sizing.fits, false);
  assert.equal(sizing.heapMb, 256, 'never less than the lowest heap');
  assert.match(
    describeWorkerSizing(sizing).message,
    /4 workers do not fit into the memory limit: 216 MB each, a worker needs 1700 MB\. At most 1 worker\(s\) fit into 1024 MB; 4 workers need 6960 MB\./
  );
  // 8 GiB with WORKERS=6 (OOM-killed in the lab) does not fit.
  const lab = decideWorkerSizing({
    explicitWorkers: 6,
    memoryLimitBytes: 8192 * MiB,
    cpus: 8,
    heapFlagSet: false
  });
  assert.deepEqual([lab.fits, lab.heapMb, lab.semiSpaceMb], [false, 440, null]);
});

test('14 workers do not fit into 18 GiB and fit into 24 GiB (the k3s lab)', () => {
  const sized = limitMb =>
    decideWorkerSizing({
      explicitWorkers: 14,
      memoryLimitBytes: limitMb * MiB,
      cpus: 15,
      heapFlagSet: false
    });
  // (18432 − 160) / 14 = 1305 < 1700: OOM-killed under load.
  const small = sized(18432);
  assert.deepEqual([small.fits, small.shareMb, small.heapMb], [false, 1305, 407]);
  assert.match(
    describeWorkerSizing(small).message,
    /14 workers do not fit into the memory limit: 1305 MB each, a worker needs 1700 MB\. At most 10 worker\(s\) fit into 18432 MB; 14 workers need 23960 MB\. Lower WORKERS or raise the limit/
  );
  // (24576 − 160) / 14 = 1744 ≥ 1700: ran without OOM.
  const big = sized(24576);
  assert.deepEqual([big.fits, big.shareMb, big.semiSpaceMb, big.heapMb], [true, 1744, 32, 798]);
  assert.doesNotMatch(describeWorkerSizing(big).message, /do not fit/);
});

test('an explicit --max-old-space-size wins over the derived heap', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: undefined,
    memoryLimitBytes: 4096 * MiB,
    cpus: 4,
    heapFlagSet: true
  });
  assert.equal(sizing.heapMb, null);
  assert.equal(sizing.heapSource, 'NODE_OPTIONS');
  assert.ok(hasHeapLimitFlag('--max-old-space-size=1024'));
  assert.ok(hasHeapLimitFlag('--inspect --max_old_space_size=512'));
  assert.ok(hasHeapLimitFlag('', ['--max-old-space-size=900']));
  assert.ok(!hasHeapLimitFlag('--max-semi-space-size=16', ['--expose-gc']));
});

test('without a memory limit nothing changes: four workers, Node’s heap default', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: undefined,
    memoryLimitBytes: null,
    cpus: 16,
    heapFlagSet: false
  });
  assert.deepEqual(
    { workers: sizing.workers, source: sizing.workersSource, heap: sizing.heapMb },
    { workers: 4, source: 'default', heap: null }
  );
});

test('the cgroup memory limit is read from v2, then v1', () => {
  const files = map => file => {
    if (file in map) return map[file];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(
    readContainerMemoryLimit(files({ '/sys/fs/cgroup/memory.max': '2097152000\n' })),
    2097152000
  );
  assert.equal(readContainerMemoryLimit(files({ '/sys/fs/cgroup/memory.max': 'max\n' })), null);
  assert.equal(
    readContainerMemoryLimit(
      files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824\n' })
    ),
    1073741824
  );
  assert.equal(
    readContainerMemoryLimit(
      files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n' })
    ),
    null,
    'cgroup v1 reports "unlimited" as a huge number'
  );
  assert.equal(readContainerMemoryLimit(files({})), null);
});

test('the workers get the heap flag after the primary’s own flags', () => {
  assert.deepEqual(workerExecArgv({ heapMb: 620 }, ['--enable-source-maps']), [
    '--enable-source-maps',
    '--max-old-space-size=620'
  ]);
  assert.deepEqual(workerExecArgv({ heapMb: null }, ['--x']), ['--x']);
  assert.deepEqual(workerExecArgv({ heapMb: 1038, semiSpaceMb: 64 }, []), [
    '--max-old-space-size=1038',
    '--max-semi-space-size=64'
  ]);
});

test('the young generation follows the memory share of a worker', () => {
  const sized = (limitMb, workers, flags = {}) =>
    decideWorkerSizing({
      explicitWorkers: workers,
      memoryLimitBytes: limitMb * MiB,
      cpus: 16,
      heapFlagSet: false,
      ...flags
    });
  // 12 GiB, 6 workers → 2021 MB each → 64 MB, its young generation out of the share.
  assert.equal(sized(12288, 6).semiSpaceMb, 64);
  assert.equal(sized(12288, 6).heapMb, 2021 - 850 - 192);
  assert.equal(sized(4096, 2).semiSpaceMb, 32);
  assert.equal(sized(8192, 6).semiSpaceMb, null, '1338 MB each keeps the Node default');
  assert.equal(sized(4096, 4).semiSpaceMb, null, 'a small share keeps the Node default');
  assert.equal(sized(8192, 1).semiSpaceMb, null, 'a single process keeps the Node default');
  assert.equal(sized(8192, 6, { semiSpaceFlagSet: true }).semiSpaceMb, null, 'an admin flag wins');
  assert.equal(
    sized(8192, 6, { heapFlagSet: true }).semiSpaceMb,
    null,
    'an admin heap flag leaves both sizes to the admin'
  );
});

test('a semi-space flag in NODE_OPTIONS is respected', () => {
  const sizing = workerSizingForProcess({
    explicitWorkers: 6,
    env: { NODE_OPTIONS: '--max-semi-space-size=16' },
    execArgv: [],
    memoryLimit: () => 12288 * MiB,
    availableParallelism: () => 8
  });
  assert.equal(sizing.heapMb, 2021 - 850 - 48);
  assert.equal(sizing.semiSpaceMb, null);
});

test('the decision is logged with its inputs', () => {
  const line = describeWorkerSizing(
    decideWorkerSizing({
      explicitWorkers: undefined,
      memoryLimitBytes: 4096 * MiB,
      cpus: 4,
      heapFlagSet: false
    })
  );
  assert.equal(
    line.message,
    'Worker sizing: 2 worker(s) (memory limit), heap per worker 1022 MB (memory limit), young generation 32 MB semi-space'
  );
  assert.equal(line.semiSpaceMb, 32);
  assert.equal(line.shareMb, 1968);
  assert.equal(line.memoryLimitMb, 4096);
  assert.equal(line.cpus, 4);
});

test('workerSizingForProcess reads the environment it is given', () => {
  const sizing = workerSizingForProcess({
    explicitWorkers: undefined,
    env: { NODE_OPTIONS: '--max-old-space-size=700' },
    execArgv: [],
    memoryLimit: () => 5000 * MiB,
    availableParallelism: () => 8
  });
  assert.equal(sizing.workers, 2);
  assert.equal(sizing.heapMb, null);
  assert.equal(sizing.heapSource, 'NODE_OPTIONS');
});
