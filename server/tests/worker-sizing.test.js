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
  readContainerMemoryLimit,
  workerExecArgv,
  workerSizingForProcess
} from '../utils/workerSizing.js';

const MiB = 1024 * 1024;

test('a 2000 MiB pod with four CPUs runs two workers with a heap limit each', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: undefined,
    memoryLimitBytes: 2000 * MiB,
    cpus: 4,
    heapFlagSet: false
  });
  assert.equal(sizing.workers, 2);
  assert.equal(sizing.workersSource, 'memory limit');
  assert.equal(sizing.heapMb, 620);
  assert.equal(sizing.heapSource, 'memory limit');
  assert.equal(sizing.limitMb, 2000);
  // Primary reserve + two workers (heap + non-heap) stay within the limit.
  assert.ok(160 + 2 * (sizing.heapMb + 300) <= 2000);
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
  assert.equal(sizing.heapMb, Math.floor((4096 - 160) / 3) - 300);
});

test('the heap limit never drops below the minimum', () => {
  const sizing = decideWorkerSizing({
    explicitWorkers: 4,
    memoryLimitBytes: 1024 * MiB,
    cpus: 4,
    heapFlagSet: false
  });
  assert.equal(sizing.heapMb, 512);
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

test('the decision is logged with its inputs', () => {
  const line = describeWorkerSizing(
    decideWorkerSizing({
      explicitWorkers: undefined,
      memoryLimitBytes: 2000 * MiB,
      cpus: 4,
      heapFlagSet: false
    })
  );
  assert.equal(
    line.message,
    'Worker sizing: 2 worker(s) (memory limit), heap per worker 620 MB (memory limit)'
  );
  assert.equal(line.memoryLimitMb, 2000);
  assert.equal(line.cpus, 4);
});

test('workerSizingForProcess reads the environment it is given', () => {
  const sizing = workerSizingForProcess({
    explicitWorkers: undefined,
    env: { NODE_OPTIONS: '--max-old-space-size=700' },
    execArgv: [],
    memoryLimit: () => 3000 * MiB,
    availableParallelism: () => 8
  });
  assert.equal(sizing.workers, 3);
  assert.equal(sizing.heapMb, null);
  assert.equal(sizing.heapSource, 'NODE_OPTIONS');
});
