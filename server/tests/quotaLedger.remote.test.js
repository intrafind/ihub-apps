// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage-limit counters held by the cluster primary: a worker's remote ledger
 * against the primary's ledger over a fake bus, and the fallback to the file
 * when the primary does not answer.
 */
import './support/scratchContents.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { currentWindows } from '../services/quota/resetSchedule.js';
import { createQuotaLedger, createRemoteQuotaLedger } from '../services/quota/QuotaLedger.js';

const windows = currentWindows({ timezone: 'UTC' });
const dirs = [];
after(() => Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true }))));

async function filePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-remote-'));
  dirs.push(dir);
  return path.join(dir, 'quota.json');
}

/** The primary's side of the four channels, as `respondInPrimary` registers them. */
function fakeBus(primary, { up = () => true } = {}) {
  const calls = [];
  const ask = async (type, payload, opts) => {
    calls.push({ type, primaryOnly: opts?.primaryOnly });
    if (!up()) return null;
    const copy = structuredClone(payload); // IPC clones
    switch (type) {
      case 'quota:delta':
        primary.absorb(copy);
        return { ok: true };
      case 'quota:list':
        return { users: await primary.listUsers(copy.windows) };
      case 'quota:reset':
        await primary.reset(copy.userKey, copy.windows, copy.scope);
        return { ok: true };
      default:
        return null;
    }
  };
  return { ask, calls };
}

const use = tokens => ({ modelId: 'm', appId: 'chat', tokens, windows });

describe('quota counters held by the primary', () => {
  it("a limit check sees this worker's own tokens at once and the others' after the primary wrote them", async () => {
    const file = await filePath();
    const primary = createQuotaLedger({ filePath: file, flushIntervalMs: 60000 });
    const bus = fakeBus(primary);
    const make = () =>
      createRemoteQuotaLedger({
        local: createQuotaLedger({ filePath: file, flushIntervalMs: 60000 }),
        ask: bus.ask,
        isActive: () => true,
        isConnected: () => true,
        sendIntervalMs: 60000
      });
    const a = make();
    const b = make();
    a.record('u1', use(10));
    assert.equal((await a.getUser('u1', windows)).models.m.day, 10, 'own unsent tokens');
    b.record('u1', use(5));
    await a.flush();
    await b.flush();
    assert.equal((await primary.getUser('u1', windows)).models.m.day, 15, 'the primary has both');
    await primary.flush();
    assert.equal((await a.getUser('u1', windows)).models.m.day, 15);
    assert.equal((await b.getUser('u1', windows)).models.m.day, 15);
    assert.ok(
      bus.calls.every(c => c.primaryOnly === true),
      'never broadcast to workers'
    );
    assert.ok(!bus.calls.some(c => c.type === 'quota:get'), 'no question on the request path');
  });

  it('the primary writes the file once; another pod reading it sees the counts', async () => {
    const file = await filePath();
    const primary = createQuotaLedger({ filePath: file, flushIntervalMs: 60000 });
    const worker = createRemoteQuotaLedger({
      ask: fakeBus(primary).ask,
      isActive: () => true,
      isConnected: () => true,
      sendIntervalMs: 60000
    });
    worker.record('u1', use(7));
    await worker.flush();
    await primary.flush();
    const otherPod = createQuotaLedger({ filePath: file, flushIntervalMs: 60000 });
    assert.equal((await otherPod.getUser('u1', windows)).models.m.day, 7);
  });

  it('a slow primary counts a batch once, however late it answers', async () => {
    const primary = createQuotaLedger({ filePath: await filePath(), flushIntervalMs: 60000 });
    const bus = fakeBus(primary);
    let slow = true;
    const ask = async (type, payload, opts) => {
      if (type === 'quota:delta' && slow) {
        // The answer comes after the asker gave up; the primary still counts it.
        setTimeout(() => bus.ask(type, payload, opts), 20);
        return null;
      }
      return bus.ask(type, payload, opts);
    };
    const worker = createRemoteQuotaLedger({
      ask,
      isActive: () => true,
      isConnected: () => true,
      sendIntervalMs: 60000
    });
    worker.record('u1', use(6));
    await worker.flush();
    await new Promise(r => setTimeout(r, 50));
    slow = false;
    await worker.flush();
    assert.equal((await primary.getUser('u1', windows)).models.m.day, 6, 'counted once');
  });

  it('without a channel to the primary the worker counts into the file itself', async () => {
    const file = await filePath();
    const worker = createRemoteQuotaLedger({
      local: createQuotaLedger({ filePath: file, flushIntervalMs: 60000 }),
      ask: async () => assert.fail('nobody to ask'),
      isActive: () => true,
      isConnected: () => false,
      sendIntervalMs: 60000
    });
    worker.record('u1', use(3));
    assert.equal((await worker.getUser('u1', windows)).models.m.day, 3);
    await worker.flush();
    const fresh = createQuotaLedger({ filePath: file, flushIntervalMs: 60000 });
    assert.equal((await fresh.getUser('u1', windows)).models.m.day, 3);
  });

  it('the final batch at shutdown is written to the file when the primary does not answer', async () => {
    const file = await filePath();
    const worker = createRemoteQuotaLedger({
      local: createQuotaLedger({ filePath: file, flushIntervalMs: 60000 }),
      ask: async () => null,
      isActive: () => true,
      isConnected: () => true,
      sendIntervalMs: 60000
    });
    worker.record('u1', use(2));
    await worker.flush();
    const fresh = createQuotaLedger({ filePath: file, flushIntervalMs: 60000 });
    assert.equal((await fresh.getUser('u1', windows)).models.m.day, 2);
  });

  it('an admin reset through a worker clears the counts the primary holds', async () => {
    const file = await filePath();
    const primary = createQuotaLedger({ filePath: file, flushIntervalMs: 60000 });
    const bus = fakeBus(primary);
    const worker = createRemoteQuotaLedger({
      local: createQuotaLedger({ filePath: file, flushIntervalMs: 60000 }),
      ask: bus.ask,
      isActive: () => true,
      isConnected: () => true,
      sendIntervalMs: 60000
    });
    worker.record('u1', use(9));
    await worker.reset('u1', windows);
    assert.equal((await worker.getUser('u1', windows)).models.m.day, 0);
    const [listed] = await worker.listUsers(windows);
    assert.equal(listed.userKey, 'u1');
  });

  it("a read copies one user and leaves the file's cached data alone", async () => {
    const primary = createQuotaLedger({ filePath: await filePath(), flushIntervalMs: 60000 });
    primary.record('u1', use(4));
    await primary.flush();
    primary.record('u1', use(1));
    const entry = await primary.readEntry('u1');
    assert.equal((await primary.getUser('u1', windows)).models.m.day, 5, 'pending included');
    entry.models.m.day.tokens = 999;
    assert.equal((await primary.getUser('u1', windows)).models.m.day, 5, 'cache untouched');
  });
});
