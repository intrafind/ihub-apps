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
  nodeYoungGenerationMb,
  sizeFlagMb,
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
  // (4096 − 160) / 2 = 1968 → 1968 − 850 non-heap − 3 × 64 young (Node's default) = 926
  assert.equal(sizing.heapMb, 926);
  assert.equal(sizing.youngMb, 192);
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
      const youngMb = nodeYoungGenerationMb(limitMb);
      assert.equal(sizing.youngMb, youngMb);
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
  // (4096 − 160) / 3 = 1312 → 1312 − 850 − 192 (Node's default young generation) = 270
  assert.equal(sizing.heapMb, 270);
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
  assert.deepEqual([lab.fits, lab.heapMb], [false, 296]);
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
  assert.deepEqual([small.fits, small.shareMb, small.heapMb], [false, 1305, 263]);
  assert.match(
    describeWorkerSizing(small).message,
    /14 workers do not fit into the memory limit: 1305 MB each, a worker needs 1700 MB\. At most 10 worker\(s\) fit into 18432 MB; 14 workers need 23960 MB\. Lower WORKERS or raise the limit/
  );
  // (24576 − 160) / 14 = 1744 ≥ 1700: ran without OOM.
  const big = sized(24576);
  assert.deepEqual([big.fits, big.shareMb, big.heapMb], [true, 1744, 702]);
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
});

test('the young generation is Node’s default for the container, never a flag of ours', () => {
  // Measured with Node 24.22 in containers: heap_size_limit − --max-old-space-size.
  assert.deepEqual(
    [768, 1024, 1100, 2048, 2100, 4096, 8192].map(nodeYoungGenerationMb),
    [48, 48, 96, 96, 192, 192, 192]
  );
  const sizing = decideWorkerSizing({
    explicitWorkers: 6,
    memoryLimitBytes: 12288 * MiB,
    cpus: 16,
    heapFlagSet: false
  });
  assert.equal(sizing.heapMb, 2021 - 850 - 192);
  assert.deepEqual(workerExecArgv(sizing, []), ['--max-old-space-size=979']);
});

test('an admin semi-space flag is passed on and budgeted', () => {
  const sizing = workerSizingForProcess({
    explicitWorkers: 6,
    env: { NODE_OPTIONS: '--max-semi-space-size=16' },
    execArgv: [],
    memoryLimit: () => 12288 * MiB,
    availableParallelism: () => 8
  });
  assert.equal(sizing.youngMb, 48);
  assert.equal(sizing.heapMb, 2021 - 850 - 48);
  assert.deepEqual(workerExecArgv(sizing, ['--max-semi-space-size=16']), [
    '--max-semi-space-size=16',
    '--max-old-space-size=1123'
  ]);
});

test('size flags are read with either spelling, the last one winning', () => {
  assert.equal(sizeFlagMb('max-old-space-size', '--max_old_space_size 512'), 512);
  assert.equal(
    sizeFlagMb('max-old-space-size', '--max-old-space-size=512', ['--max-old-space-size=900']),
    900
  );
  assert.equal(sizeFlagMb('max-heap-size', '--max-old-space-size=512'), null);
  assert.ok(hasHeapLimitFlag('--max-heap-size=900'));
});

test('an admin heap flag that leaves too little room does not fit', () => {
  const sized = (nodeOptions, workers) =>
    workerSizingForProcess({
      explicitWorkers: workers,
      env: { NODE_OPTIONS: nodeOptions },
      execArgv: [],
      memoryLimit: () => 8192 * MiB,
      availableParallelism: () => 8
    });
  // (8192 − 160) / 4 = 2008; 1038 + 192 young + 850 non-heap = 2080 > 2008.
  const tight = sized('--max-old-space-size=1038', 4);
  assert.deepEqual([tight.fits, tight.heapMb, tight.workerNeedsMb], [false, null, 2080]);
  assert.match(
    describeWorkerSizing(tight).message,
    /4 workers do not fit into the memory limit: 2008 MB each, a worker needs 2080 MB\. At most 3 worker\(s\) fit into 8192 MB; 4 workers need 8480 MB\. Lower WORKERS or the heap flag or raise the limit/
  );
  // --max-heap-size is the whole heap: 1000 + 850 ≤ 2008.
  assert.equal(sized('--max-heap-size=1000', 4).fits, true);
  assert.equal(sized('--max-old-space-size=700', 4).fits, true);
  // A single process has no primary to reserve for: 8192 ≥ 6000 + 192 + 850 is false.
  assert.equal(sized('--max-old-space-size=7500', 1).fits, false);
  assert.equal(sized('--max-old-space-size=6000', 1).fits, true);
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
    'Worker sizing: 2 worker(s) (memory limit), heap per worker 926 MB (memory limit)'
  );
  assert.equal(line.youngGenerationMb, 192);
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
