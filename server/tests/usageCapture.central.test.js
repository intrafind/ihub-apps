// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One capture point: `recordLlmCall` counts a model call against the user's
 * limits and stores its call record from the same usage, so the user menu, the
 * limits page and the usage reports show the same tokens.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-capture-'));
process.env.CONTENTS_DIR = dir;

const { recordLlmCall } = await import('../services/usage/usageRecorder.js');
const { createQuotaLedger, setQuotaLedger } = await import('../services/quota/QuotaLedger.js');
const { getCurrentWindows } = await import('../services/quota/quotaService.js');
const { flushQueue, readEvents } = await import('../services/UsageEventLog.js');

const user = { id: 'alice', groups: ['users'] };
const usage = { promptTokens: 40, completionTokens: 10, source: 'provider' };

describe('recordLlmCall', () => {
  let ledger;
  before(async () => {
    await fs.mkdir(path.join(dir, 'data'), { recursive: true });
    ledger = createQuotaLedger({
      filePath: path.join(dir, 'data', 'quota-usage.json'),
      flushIntervalMs: 10
    });
    setQuotaLedger(ledger);
  });
  after(async () => {
    await ledger.flush();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('counts the same tokens for the limits and the call record', async () => {
    const record = await recordLlmCall({
      user,
      surface: 'chat',
      appId: 'chat',
      modelId: 'm1',
      provider: 'openai',
      usage,
      outcome: 'ok'
    });
    const counts = await ledger.getUser('alice', getCurrentWindows());
    assert.equal(record.pt + record.ct, 50);
    assert.equal(counts.models.m1.day, 50);
    assert.equal(counts.allModels.month, 50);
    assert.equal(counts.apps.chat, 50);
  });

  it('counts a call that names its user for reporting only (workflow, agent)', async () => {
    await recordLlmCall({ user, surface: 'workflow', modelId: 'm2', usage, outcome: 'ok' });
    const counts = await ledger.getUser('alice', getCurrentWindows());
    assert.equal(counts.models.m2.day, 50);
  });

  it('keeps an exempt call off the budget but reports it', async () => {
    await recordLlmCall({
      user,
      surface: 'system',
      modelId: 'm3',
      usage,
      outcome: 'ok',
      countQuota: false
    });
    const counts = await ledger.getUser('alice', getCurrentWindows());
    assert.equal(counts.models.m3, undefined);
    await flushQueue();
    const events = await readEvents();
    assert.ok(events.some(e => e.model === 'm3'));
  });

  it('counts nothing for a call without tokens or without a user', async () => {
    await recordLlmCall({ user, modelId: 'm4', usage: null, outcome: 'quota' });
    await recordLlmCall({ user: null, modelId: 'm5', usage, outcome: 'ok' });
    const counts = await ledger.getUser('alice', getCurrentWindows());
    assert.equal(counts.models.m4, undefined);
    assert.equal(counts.models.m5, undefined);
  });
});

describe('QuotaLedger reads during flushes', () => {
  it('a read behind a queued second flush still sees every count', async () => {
    await fs.mkdir(path.join(dir, 'data'), { recursive: true });
    const own = createQuotaLedger({
      filePath: path.join(dir, 'data', 'quota-usage-queued.json'),
      flushIntervalMs: 60_000
    });
    const windows = getCurrentWindows();
    own.record('bob', { modelId: 'm1', tokens: 10, windows });
    const first = own.flush(); // in flight
    own.record('bob', { modelId: 'm1', tokens: 5, windows });
    const second = own.flush(); // queued behind the first
    const counts = await own.getUser('bob', windows); // reads while both are pending
    assert.equal(counts.models.m1.day, 15);
    await Promise.all([first, second]);
    const after = await own.getUser('bob', windows);
    assert.equal(after.models.m1.day, 15);
  });
});
