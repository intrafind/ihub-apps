// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cap on concurrent file reads (`services/uploads/extractionLimiter.js`):
 * N run, the rest wait in a bounded queue, one more is refused with a
 * retryable error, and a failing read gives its slot back.
 */
import './support/scratchContents.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import {
  DEFAULT_EXTRACTION_CONCURRENCY,
  DEFAULT_EXTRACTION_MAX_QUEUE,
  ExtractionAbortedError,
  ExtractionBusyError,
  ExtractionLimiter,
  extractionLimits,
  getExtractionLimiter,
  setExtractionLimiter
} from '../services/uploads/extractionLimiter.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { ingestChatFile } from '../services/chatFiles/ChatFileService.js';
import { normalizeChatFilePolicy } from '../services/chatFiles/chatFilePolicy.js';
import { API_ERROR_CODES } from '../../shared/apiErrors.js';
import { toErrorResponse } from '../utils/errorResponse.js';

/** A task that runs until the test lets it go. */
function gate() {
  let open;
  let fail;
  const promise = new Promise((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

const limiterOf = (concurrency, maxQueue) =>
  new ExtractionLimiter({ limits: () => ({ concurrency, maxQueue }) });

afterEach(() => {
  setExtractionLimiter(null);
  configCache.setCacheEntry('config/platform.json', {});
});

describe('extraction limiter', () => {
  it('runs N at a time and the rest in arrival order', async () => {
    const limiter = limiterOf(2, 10);
    const gates = Array.from({ length: 5 }, gate);
    const started = [];
    let running = 0;
    let most = 0;
    const runs = gates.map((entry, index) =>
      limiter.run(async () => {
        started.push(index);
        running += 1;
        most = Math.max(most, running);
        await entry.promise;
        running -= 1;
        return index;
      })
    );
    await tick();
    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(limiter.stats(), { running: 2, queued: 3, concurrency: 2, maxQueue: 10 });

    gates[1].open();
    await tick();
    assert.deepEqual(started, [0, 1, 2]);
    gates[0].open();
    gates[2].open();
    await tick();
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
    gates[3].open();
    gates[4].open();
    assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3, 4]);
    assert.equal(most, 2, 'never more than the cap at once');
    assert.deepEqual(limiter.stats(), { running: 0, queued: 0, concurrency: 2, maxQueue: 10 });
  });

  it('refuses the caller that finds the queue full, with a retry time', async () => {
    const limiter = limiterOf(1, 2);
    const first = gate();
    const running = limiter.run(() => first.promise);
    const waiting = [limiter.run(() => 'a'), limiter.run(() => 'b')];
    await tick();
    await assert.rejects(
      limiter.run(() => 'c'),
      error => {
        assert.ok(error instanceof ExtractionBusyError);
        assert.equal(error.code, 'UPLOAD_BUSY');
        assert.ok(error.retryAfterMs >= 1000 && error.retryAfterMs <= 60_000);
        return true;
      }
    );
    // The refusal took nothing: those who waited still get their turn.
    first.open('first');
    assert.equal(await running, 'first');
    assert.deepEqual(await Promise.all(waiting), ['a', 'b']);
    // And there is room again.
    assert.equal(await limiter.run(() => 'd'), 'd');
  });

  it('with no queue, refuses as soon as every slot is taken', async () => {
    const limiter = limiterOf(1, 0);
    const first = gate();
    const running = limiter.run(() => first.promise);
    await assert.rejects(
      limiter.run(() => 'x'),
      ExtractionBusyError
    );
    first.open();
    await running;
  });

  it('gives the slot back when a read throws: no deadlock', async () => {
    const limiter = limiterOf(1, 10);
    const failing = Array.from({ length: 4 }, (_, index) =>
      limiter.run(async () => {
        await tick();
        throw new Error(`extraction ${index} failed`);
      })
    );
    const last = limiter.run(() => 'still served');
    const outcomes = await Promise.allSettled(failing);
    assert.deepEqual(
      outcomes.map(outcome => outcome.reason?.message),
      [0, 1, 2, 3].map(index => `extraction ${index} failed`)
    );
    assert.equal(await last, 'still served');
    assert.deepEqual(limiter.stats().running, 0);
    // A synchronous throw as well.
    await assert.rejects(
      limiter.run(() => {
        throw new Error('sync');
      }),
      /sync/
    );
    assert.equal(await limiter.run(() => 'after'), 'after');
  });

  it('lets background work wait however long the queue is', async () => {
    const limiter = limiterOf(1, 1);
    const first = gate();
    const running = limiter.run(() => first.promise);
    const bounded = limiter.run(() => 'bounded');
    // The bounded queue is full now; background jobs still queue up.
    const background = [1, 2, 3].map(n => limiter.run(() => `job ${n}`, { wait: 'always' }));
    await assert.rejects(
      limiter.run(() => 'refused'),
      ExtractionBusyError
    );
    assert.equal(limiter.stats().queued, 4);
    first.open();
    await running;
    assert.equal(await bounded, 'bounded');
    assert.deepEqual(await Promise.all(background), ['job 1', 'job 2', 'job 3']);
  });

  it('background jobs do not use up the bounded queue', async () => {
    const limiter = limiterOf(1, 1);
    const first = gate();
    const running = limiter.run(() => first.promise);
    const background = [1, 2, 3].map(n => limiter.run(() => n, { wait: 'always' }));
    const upload = limiter.run(() => 'upload');
    first.open();
    await running;
    assert.equal(await upload, 'upload');
    await Promise.all(background);
  });

  it('drops a waiter whose caller went away', async () => {
    const limiter = limiterOf(1, 5);
    const first = gate();
    const running = limiter.run(() => first.promise);
    const controller = new AbortController();
    let ran = false;
    const waiting = limiter.run(
      () => {
        ran = true;
      },
      { signal: controller.signal }
    );
    await tick();
    assert.equal(limiter.stats().queued, 1);
    controller.abort();
    await assert.rejects(waiting, ExtractionAbortedError);
    assert.equal(limiter.stats().queued, 0);
    first.open();
    await running;
    assert.equal(ran, false);
    await assert.rejects(
      limiter.run(() => 'never', { signal: controller.signal }),
      ExtractionAbortedError
    );
  });

  it('follows a changed limit without a restart', async () => {
    let concurrency = 1;
    const limiter = new ExtractionLimiter({ limits: () => ({ concurrency, maxQueue: 10 }) });
    const gates = [gate(), gate(), gate()];
    const started = [];
    const runs = gates.map((entry, index) =>
      limiter.run(async () => {
        started.push(index);
        await entry.promise;
      })
    );
    await tick();
    assert.deepEqual(started, [0]);
    concurrency = 3;
    gates[0].open();
    await tick();
    await tick();
    assert.deepEqual(started, [0, 1, 2]);
    gates[1].open();
    gates[2].open();
    await Promise.all(runs);
  });
});

describe('uploads.extraction settings', () => {
  it('has defaults without any configuration, and needs no migration', () => {
    assert.deepEqual(extractionLimits({}), {
      concurrency: DEFAULT_EXTRACTION_CONCURRENCY,
      maxQueue: DEFAULT_EXTRACTION_MAX_QUEUE
    });
    const parsed = platformConfigSchema.parse({});
    assert.deepEqual(parsed.uploads.extraction, {
      concurrency: DEFAULT_EXTRACTION_CONCURRENCY,
      maxQueue: DEFAULT_EXTRACTION_MAX_QUEUE
    });
    // An existing uploads block without the new field stays valid.
    const existing = platformConfigSchema.parse({ uploads: { storageMode: 'server_text_only' } });
    assert.equal(existing.uploads.extraction.concurrency, DEFAULT_EXTRACTION_CONCURRENCY);
  });

  it('reads platform.uploads.extraction, and falls back on values that make no sense', () => {
    assert.deepEqual(
      extractionLimits({ uploads: { extraction: { concurrency: 4, maxQueue: 7 } } }),
      {
        concurrency: 4,
        maxQueue: 7
      }
    );
    assert.deepEqual(
      extractionLimits({ uploads: { extraction: { concurrency: 0, maxQueue: -1 } } }),
      { concurrency: DEFAULT_EXTRACTION_CONCURRENCY, maxQueue: DEFAULT_EXTRACTION_MAX_QUEUE }
    );
    assert.equal(extractionLimits({ uploads: { extraction: { maxQueue: 0 } } }).maxQueue, 0);
  });

  it('the shared limiter reads the live platform configuration', () => {
    configCache.setCacheEntry('config/platform.json', {
      uploads: { extraction: { concurrency: 3, maxQueue: 9 } }
    });
    assert.deepEqual(getExtractionLimiter().stats(), {
      running: 0,
      queued: 0,
      concurrency: 3,
      maxQueue: 9
    });
  });
});

describe('the refusal as an API error', () => {
  const policy = normalizeChatFilePolicy({ enabled: true, storageMode: 'server_text_only' });
  const sink = { isAvailable: () => true, put: async (_scope, file) => ({ id: 'x', ...file }) };

  it('is UPLOAD_BUSY, 503, with Retry-After, in the registry', async () => {
    assert.equal(API_ERROR_CODES.UPLOAD_BUSY, 503);
    const limiter = limiterOf(1, 0);
    const first = gate();
    const running = limiter.run(() => first.promise);
    let thrown;
    try {
      await ingestChatFile({
        scope: { type: 'chat', id: 'c1' },
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('some text'),
        policy,
        store: sink,
        limiter
      });
    } catch (error) {
      thrown = error;
    }
    first.open();
    await running;
    assert.equal(thrown?.code, 'UPLOAD_BUSY');
    assert.equal(thrown.status, 503);
    const response = toErrorResponse(thrown);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'UPLOAD_BUSY');
    assert.equal(response.body.type, 'urn:ihub:problem:UPLOAD_BUSY');
    assert.equal(
      response.headers['Retry-After'],
      String(Math.ceil(thrown.details.retryAfterMs / 1000))
    );
    assert.equal(response.headers['Content-Type'], 'application/problem+json');
  });

  it('an extraction that throws frees its slot for the next upload', async () => {
    const limiter = limiterOf(1, 0);
    for (let round = 0; round < 3; round += 1) {
      await assert.rejects(
        ingestChatFile({
          scope: { type: 'chat', id: 'c2' },
          name: 'broken.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.7\nnot a pdf'),
          policy,
          store: sink,
          limiter
        }),
        error => error.status === 400
      );
    }
    assert.equal(limiter.stats().running, 0);
    const stored = await ingestChatFile({
      scope: { type: 'chat', id: 'c2' },
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('fine'),
      policy,
      store: sink,
      limiter
    });
    assert.equal(stored.text, 'fine');
  });
});
