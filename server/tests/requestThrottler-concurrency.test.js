// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Limits for large installations: model concurrency.
 *
 * Every model runs `requestConcurrency` calls at once unless it sets its own
 * `concurrency`. A call that waits 2 s or more for a slot is counted, so
 * admins can see when the concurrency is too low.
 */
import { after, afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import {
  getConcurrency,
  getSlowSlotWaits,
  SLOW_SLOT_WAIT_MS,
  throttledRun
} from '../requestThrottler.js';

const PLATFORM = 'config/platform.json';
const MODELS = 'config/models.json';
const saved = new Map([PLATFORM, MODELS].map(key => [key, configCache.cache.get(key)]));

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) configCache.cache.delete(key);
    else configCache.cache.set(key, value);
  }
});

function useConfig(platform, models) {
  configCache.cache.set(PLATFORM, { data: platform });
  configCache.cache.set(MODELS, { data: models });
}

describe('getConcurrency', () => {
  const models = [
    { id: 'vllm', provider: 'openai', url: 'http://gpu01:8000/v1/chat/completions' },
    { id: 'pinned', provider: 'local', url: 'http://gpu01:8000/v1', concurrency: 7 }
  ];

  it('gives every model without its own concurrency requestConcurrency', () => {
    useConfig({ requestConcurrency: 25 }, models);
    assert.equal(getConcurrency('vllm'), 25);
    assert.equal(getConcurrency('some-tool'), 25);
  });

  it("keeps a model's own concurrency", () => {
    useConfig({ requestConcurrency: 25 }, models);
    assert.equal(getConcurrency('pinned'), 7);
  });

  it('is unlimited without requestConcurrency', () => {
    useConfig({}, models);
    assert.equal(getConcurrency('vllm'), Infinity);
  });
});

describe('slow slot waits', () => {
  afterEach(() => mock.timers.reset());

  it('counts a call that waited at least SLOW_SLOT_WAIT_MS for a slot', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const id = 'slow-wait-test';
    let finishFirst;
    const first = throttledRun(id, () => new Promise(resolve => (finishFirst = resolve)), {
      concurrency: 1
    });
    const second = throttledRun(id, async () => 'second', { concurrency: 1 });
    await Promise.resolve();
    mock.timers.tick(SLOW_SLOT_WAIT_MS + 500);
    finishFirst('first');
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.equal(getSlowSlotWaits()[id], 1);
  });

  it('does not count a call that got its slot at once', async () => {
    const id = 'fast-wait-test';
    await throttledRun(id, async () => 'ok', { concurrency: 1 });
    assert.equal(getSlowSlotWaits()[id], undefined);
  });
});
