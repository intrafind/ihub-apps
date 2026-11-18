// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Worker threads keep their own `resourceLimits` in a process started with
 * V8 heap flags (`releaseThreadHeapFlags` in utils/workerSizing.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { THREAD_YOUNG_GENERATION_MB, threadResourceLimits } from '../utils/workerSizing.js';

const WORKER_SIZING_URL = new URL('../utils/workerSizing.js', import.meta.url).href;

// Started like a cluster worker: with the flags workerExecArgv() adds.
const PROBE = `
import v8 from 'node:v8';
import { Worker } from 'node:worker_threads';
import { releaseThreadHeapFlags, threadResourceLimits } from '${WORKER_SIZING_URL}';
const mb = () => Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
if (process.env.RELEASE === '1') releaseThreadHeapFlags();
const worker = new Worker(
  // Evaluated as a module: the thread inherits --input-type=module.
  "import v8 from 'node:v8'; import { parentPort } from 'node:worker_threads';" +
    "parentPort.postMessage(Math.round(v8.getHeapStatistics().heap_size_limit / 1048576));",
  { eval: true, resourceLimits: threadResourceLimits(256) }
);
worker.once('message', thread => {
  console.log(JSON.stringify({ main: mb(), thread }));
  worker.terminate();
});
`;

function probe(release, heapFlags = ['--max-old-space-size=900', '--max-semi-space-size=32']) {
  const out = execFileSync(process.execPath, [...heapFlags, '--input-type=module', '-e', PROBE], {
    env: { ...process.env, NODE_OPTIONS: '', RELEASE: release ? '1' : '0' },
    encoding: 'utf8'
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('a worker thread gets its resourceLimits, the process keeps its flags', () => {
  const { main, thread } = probe(true);
  assert.ok(main >= 900 && main < 1100, `main heap_size_limit ${main} MB follows its flags`);
  assert.ok(
    thread >= 256 && thread <= 320,
    `thread heap_size_limit ${thread} MB follows resourceLimits`
  );
});

test('without the release the process flags override the thread (why it exists)', t => {
  const { main, thread } = probe(false);
  if (thread !== main) t.skip(`Node no longer lets process flags win (${thread} vs ${main} MB)`);
  else assert.equal(thread, main);
});

test('--max-heap-size is released for the threads as well', () => {
  const { main, thread } = probe(true, ['--max-heap-size=900']);
  assert.ok(main >= 880 && main <= 920, `main heap_size_limit ${main} MB follows its flag`);
  assert.ok(thread >= 256 && thread <= 320, `thread heap_size_limit ${thread} MB`);
});

test('every thread pool caps the young generation, not just the old space', () => {
  // Without maxYoungGenerationSizeMb a 256 MB thread had a 448 MB heap limit
  // in a 4 GB container (Node's 192 MB container default on top).
  assert.deepEqual(threadResourceLimits(256), {
    maxOldGenerationSizeMb: 256,
    maxYoungGenerationSizeMb: THREAD_YOUNG_GENERATION_MB
  });
  for (const file of [
    '../services/knowledge/searchPool.js',
    '../services/projects/extractionPool.js',
    '../services/documents/renderService.js'
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /resourceLimits: threadResourceLimits\(/, file);
  }
});
