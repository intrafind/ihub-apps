// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// Plain-node test (node server/tests/chatResumeCluster.test.js).
//
// A client re-attaching to a running chat turn on another worker gets the
// turn's partial text and thinking, then the live tail, with nothing missing
// and nothing doubled (`services/chat/chatResume.js`). Forks real workers like
// runEventRelayCluster.test.js, because the exactness argument lives in the
// ordering of the IPC: the GET registers its stream before it asks for the
// snapshot, and the producer keeps streaming while it answers.

import assert from 'assert';
import cluster from 'node:cluster';
import { initPrimaryBus, initWorkerBus } from '../clusterBus.js';

const CHAT_ID = 'chat-resume-1';
const RUN_ID = 'chat-run-resume-1';
/** Chunks per step; the producer emits one every TICK_MS. */
const CHUNKS = 40;
const TICK_MS = 3;

if (cluster.isPrimary) {
  await runPrimary();
} else {
  await runWorker();
}

async function runPrimary() {
  const workers = [];
  initPrimaryBus({ getWorkers: () => workers });
  for (let i = 0; i < 2; i++) workers.push(cluster.fork());

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
      const timer = setTimeout(() => reject(new Error(`no answer to ${request.step}`)), 10000);
      pending.set(id, msg => {
        clearTimeout(timer);
        resolve(msg);
      });
      worker.send({ ...request, id });
    });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const [producer, reader] = workers;

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

  await check(
    'a re-attach mid-step on another worker shows all text and thinking once',
    async () => {
      const started = ask(producer, { step: 'turn' });
      // Mid step 0: some text and thinking are out, most is still to come.
      await sleep(CHUNKS * TICK_MS * 0.4);
      const { busTypes } = await ask(reader, { step: 'reattach' });
      const { expected } = await started;
      await sleep(200);
      const { run, frames } = await ask(reader, { step: 'collect' });
      assert.ok(frames > 0, 'frames were written');
      assert.strictEqual(run.steps[0].text, expected.steps[0], 'step 0 text');
      assert.strictEqual(run.steps[1].text, expected.steps[1], 'step 1 text');
      assert.deepStrictEqual(run.thinking, expected.thinking, 'thinking');
      assert.strictEqual(run.status, 'completed');
      // One question and one answer over the bus for the snapshot.
      assert.strictEqual(busTypes.asked, 1, 'one resume request');
      const { busTypes: producerTypes } = await ask(producer, { step: 'stats' });
      assert.strictEqual(producerTypes.replied, 1, 'one resume reply');
    }
  );

  await check('a re-attach to a run nobody produces is just connected', async () => {
    const { written } = await ask(reader, { step: 'reattachUnknown' });
    assert.deepStrictEqual(written, ['stream/connected']);
  });

  for (const worker of workers) worker.kill();
  if (failed) {
    console.error('\n❌ chat resume cluster tests failed');
    process.exit(1);
  }
  console.log('\nchatResumeCluster: all checks passed');
  process.exit(0);
}

async function runWorker() {
  initWorkerBus();
  const { activeRequests, clients, writeStreamStart } = await import('../sse.js');
  const { resumeChatRun } = await import('../services/chat/chatResume.js');
  const { RunStreamEmitter } = await import('../services/loop/RunStream.js');
  const { getWaitDiagnostics } = await import('../telemetry/waitDiagnostics.js');
  const { createStreamState, reduceRunEvent, getRun } =
    await import('../../shared/run/runReducer.js');
  const writes = [];

  const busCount = type => getWaitDiagnostics().busTypes?.[type]?.published || 0;

  /** A GET connection's entry, collecting what is written to it. */
  const fakeEntry = () => ({
    lastActivity: new Date(),
    response: { write: chunk => writes.push(chunk), end: () => {} }
  });

  /** Emit a two-step turn, one chunk per tick; resolves with what was emitted. */
  async function playTurn() {
    activeRequests.set(CHAT_ID, new AbortController());
    const stream = new RunStreamEmitter({ streamId: CHAT_ID, runId: RUN_ID });
    const expected = { steps: ['', ''], thinking: [] };
    stream.emit('run/started', { kind: 'chat', refs: { chatId: CHAT_ID } });
    for (let step = 0; step < 2; step++) {
      for (let i = 0; i < CHUNKS; i++) {
        if (i % 10 === 0) {
          const thought = `t${step}.${i} `;
          stream.emit('step/delta', { step, kind: 'thinking', content: thought });
          const last = expected.thinking[expected.thinking.length - 1];
          if (typeof last === 'string') expected.thinking[expected.thinking.length - 1] += thought;
          else expected.thinking.push(thought);
        }
        if (i === 20) {
          stream.emit('step/delta', {
            step,
            kind: 'thinking',
            content: 'named',
            meta: { name: `plan${step}` }
          });
          expected.thinking.push({ name: `plan${step}`, content: 'named' });
        }
        const chunk = `s${step}c${i} `;
        stream.emit('step/delta', { step, kind: 'text', content: chunk });
        expected.steps[step] += chunk;
        await new Promise(r => setTimeout(r, TICK_MS));
      }
    }
    stream.emit('run/ended', { status: 'completed', finishReason: 'stop' });
    activeRequests.delete(CHAT_ID);
    return expected;
  }

  process.on('message', async msg => {
    if (!msg?.step) return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });
    switch (msg.step) {
      case 'ready':
        return reply({});
      case 'turn':
        return reply({ expected: await playTurn() });
      case 'reattach': {
        const before = busCount('chat:resume');
        const entry = fakeEntry();
        clients.set(CHAT_ID, entry);
        entry.held = [];
        const resume = await resumeChatRun({ chatId: CHAT_ID, runId: RUN_ID, afterLedgerSeq: 0 });
        writeStreamStart(CHAT_ID, entry, resume ? { ...resume, runId: RUN_ID } : {});
        return reply({ busTypes: { asked: busCount('chat:resume') - before } });
      }
      case 'reattachUnknown': {
        writes.length = 0;
        const entry = fakeEntry();
        clients.set('chat-nobody', entry);
        entry.held = [];
        const resume = await resumeChatRun({ chatId: 'chat-nobody', runId: 'chat-run-none' });
        writeStreamStart('chat-nobody', entry, resume || {});
        const written = writes
          .filter(w => w.startsWith('event: '))
          .map(w => w.slice('event: '.length, -1));
        return reply({ written });
      }
      case 'collect': {
        let state = createStreamState();
        let frames = 0;
        for (const chunk of writes) {
          if (!chunk.startsWith('data: ')) continue;
          frames += 1;
          state = reduceRunEvent(state, JSON.parse(chunk.slice('data: '.length)));
        }
        const run = getRun(state, RUN_ID);
        return reply({
          frames,
          run: {
            status: run.status,
            thinking: run.thinking,
            steps: { 0: { text: run.steps[0]?.text }, 1: { text: run.steps[1]?.text } }
          }
        });
      }
      case 'stats':
        return reply({ busTypes: { replied: busCount('chat:resume:reply') } });
      default:
        return reply({});
    }
  });
}
