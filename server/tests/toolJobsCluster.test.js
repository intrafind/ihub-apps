// Plain-node test (node server/tests/toolJobsCluster.test.js).
//
// Tool jobs (OCR) run in the memory of the worker that started them, while
// progress, download, cancel and the job list arrive on any cluster worker.
// Forks real workers, like clusterBus.test.js: worker 0 owns the jobs, worker 1
// asks about them.

import assert from 'assert';
import cluster from 'node:cluster';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETTLE_MS = 250;

if (cluster.isPrimary) {
  const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-jobs-'));
  process.env.CONTENTS_DIR = contentsDir;
  process.env.WORKERS = '2';
  const { initPrimaryBus } = await import('../clusterBus.js');
  await runPrimary(initPrimaryBus, contentsDir);
} else {
  await runWorker();
}

async function runPrimary(initPrimaryBus, contentsDir) {
  const workers = [];
  initPrimaryBus({ getWorkers: () => workers });
  for (let i = 0; i < 2; i++) workers.push(cluster.fork({ TEST_WORKER_INDEX: String(i) }));

  const pending = new Map();
  let nextId = 1;
  for (const worker of workers) {
    worker.on('message', msg => {
      if (!msg?.testReply) return;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
  }
  const ask = (worker, request) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no answer to ${request.step}`)), 5000);
      pending.set(id, msg => {
        clearTimeout(timer);
        resolve(msg);
      });
      worker.send({ ...request, id });
    });
  const settle = () => new Promise(r => setTimeout(r, SETTLE_MS));
  const [owner, other] = workers;

  let failed = false;
  const check = async (label, fn) => {
    try {
      await fn();
      console.log(`✅ ${label}`);
    } catch (error) {
      failed = true;
      console.error(`❌ ${label}\n   ${error.message}`);
    }
  };

  await Promise.all(workers.map(w => new Promise(r => w.once('online', r))));
  await Promise.all(workers.map(w => ask(w, { step: 'ready' })));

  const { jobId: running } = await ask(owner, { step: 'create', status: 'processing' });
  const { jobId: done } = await ask(owner, { step: 'create', status: 'processing' });
  await ask(owner, { step: 'complete', jobId: done, text: 'ocr result bytes' });
  await settle();

  await check('another worker finds a running job, without its bytes', async () => {
    const { found } = await ask(other, { step: 'find', jobId: running });
    assert.strictEqual(found?.local, false);
    assert.strictEqual(found.job.status, 'processing');
    assert.strictEqual(found.job.userId, 'user-1');
    assert.strictEqual(found.job.result, undefined);
  });

  await check('a completed job can be downloaded on another worker from its result file', async () => {
    const { found } = await ask(other, { step: 'find', jobId: done });
    assert.strictEqual(found.job.status, 'completed');
    assert.ok(found.job.resultFile?.startsWith(contentsDir), 'result not in the data directory');
    assert.strictEqual(fs.readFileSync(found.job.resultFile, 'utf8'), 'ocr result bytes');
  });

  await check('the job list on another worker includes the owner’s jobs', async () => {
    const { jobs } = await ask(other, { step: 'list' });
    const ids = jobs.map(j => j.id);
    assert.ok(ids.includes(running) && ids.includes(done), `listed ${ids.join(',')}`);
  });

  await check('a cancel on another worker stops the job where it runs', async () => {
    const { outcome } = await ask(other, { step: 'cancel', jobId: running });
    assert.deepStrictEqual(outcome, { status: 'cancelled' });
    const { status } = await ask(owner, { step: 'status', jobId: running });
    assert.strictEqual(status, 'cancelled');
  });

  await check('a job nobody has is not found', async () => {
    const { found } = await ask(other, { step: 'find', jobId: 'no-such-job' });
    assert.strictEqual(found, null);
  });

  for (const worker of workers) worker.kill();
  fs.rmSync(contentsDir, { recursive: true, force: true });
  if (failed) {
    console.error('\n❌ tool job cluster tests failed');
    process.exit(1);
  }
  console.log('\ntoolJobsCluster: all checks passed');
  process.exit(0);
}

async function runWorker() {
  const { initWorkerBus } = await import('../clusterBus.js');
  initWorkerBus();
  const store = await import('../routes/toolsService/jobStore.js');

  process.on('message', async msg => {
    if (!msg?.step) return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });
    switch (msg.step) {
      case 'ready':
        return reply({});
      case 'create': {
        const job = store.createJob('ocr', 'user-1', {});
        job.status = msg.status;
        return reply({ jobId: job.id });
      }
      case 'complete': {
        const job = store.getJob(msg.jobId);
        await store.completeJob(job, {
          result: Buffer.from(msg.text),
          contentType: 'application/pdf',
          filename: 'out.pdf'
        });
        return reply({});
      }
      case 'find': {
        const found = await store.findJob(msg.jobId);
        return reply({
          found: found ? { local: found.local, job: { ...found.job, clients: undefined } } : null
        });
      }
      case 'list':
        return reply({ jobs: await store.listJobsEverywhere('user-1', false) });
      case 'cancel':
        return reply({ outcome: await store.cancelJobAnywhere(msg.jobId) });
      case 'status':
        return reply({ status: store.getJob(msg.jobId)?.status });
      default:
        return reply({});
    }
  });
}
