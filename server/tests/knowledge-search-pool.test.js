// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Project search runs on worker threads that own the corpus indexes: a thread
 * answers exactly what the event loop would, a query crosses the boundary as a
 * key (not as the index), and with the pool off or shut down the search runs
 * inline.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';

import {
  configureSearchPool,
  evictSearchIndexes,
  searchPoolStats,
  searchProjectIndex,
  searchThreadLimits,
  shutdownSearchPool
} from '../services/knowledge/searchPool.js';
import { INDEX_HEAP_BYTES_PER_CHAR } from '../utils/cacheBudgets.js';

const TOPICS = ['invoices', 'travel expenses', 'holidays', 'onboarding', 'security policy'];

/** Five Markdown documents of ~40,000 characters each. */
const DOCS = TOPICS.map((topic, d) => ({
  id: `itm_${d}`,
  name: `${topic}.md`,
  text: Array.from(
    { length: 40 },
    (_, s) =>
      `## ${topic} section ${s}\n\n` +
      `How ${topic} are handled in case ${s}: configure the approval workflow, ` +
      `submit receipts and check the reimbursement rules. `.repeat(8)
  ).join('\n\n')
}));
const LIMITS = { maxEntries: 32, maxChars: 10_000_000 };
const QUERY = 'travel reimbursement approval';

function request(key, extra = {}) {
  return { key, query: QUERY, limit: 8, budgetChars: 40_000, limits: LIMITS, ...extra };
}

/** The answer without what differs between a cold and a warm run. */
function ranking(found) {
  const { buildSeconds: _b, evicted: _e, entries: _n, chars: _c, ...rest } = found;
  return rest;
}

after(async () => {
  await shutdownSearchPool();
  configureSearchPool(null);
});

describe('search pool', () => {
  it('answers on a thread exactly as inline, and keeps the index there', async () => {
    configureSearchPool({ threads: 0 });
    const inline = await searchProjectIndex('prj_a', request('prj_a:v1', { docs: DOCS }));
    const inlineSections = await searchProjectIndex(
      'prj_a',
      request('prj_a:v1', { sections: true, docIds: ['itm_1', 'itm_2'] })
    );
    assert.equal(searchPoolStats().threads, 0, 'threads: 0 starts no thread');
    assert.ok(inline.hits.length > 0);

    configureSearchPool({ threads: 2 });
    const cold = await searchProjectIndex('prj_a', request('prj_a:v1'));
    assert.equal(cold.miss, true, 'a new thread does not hold the index');
    const built = await searchProjectIndex('prj_a', request('prj_a:v1', { docs: DOCS }));
    assert.equal(typeof built.buildSeconds, 'number');
    assert.deepEqual(ranking(built), ranking(inline));

    const warm = await searchProjectIndex(
      'prj_a',
      request('prj_a:v1', { sections: true, docIds: ['itm_1', 'itm_2'] })
    );
    assert.equal(warm.buildSeconds, null, 'the thread kept the index');
    assert.deepEqual(ranking(warm), ranking(inlineSections));
    assert.ok(warm.hits.every(hit => hit.section.startsWith('<section id=')));
    assert.ok(warm.hits.every(hit => hit.sectionTokens > 0));
    assert.equal(searchPoolStats().threads, 1, 'a project goes to one thread');

    // What crosses the boundary per query: a key and a question out, the hits back.
    const docBytes = v8.serialize(DOCS).length;
    const queryBytes = v8.serialize(request('prj_a:v1')).length;
    const answerBytes = v8.serialize(warm).length;
    console.log(
      `search pool messages: query ${queryBytes} B, answer ${answerBytes} B, ` +
        `texts sent once per build ${docBytes} B`
    );
    assert.ok(queryBytes < 512, `query message ${queryBytes} B`);
    assert.ok(answerBytes < 64 * 1024, `answer message ${answerBytes} B`);
    assert.ok(answerBytes < docBytes / 2, 'the answer is a fraction of the corpus');
  });

  it('forgets an evicted project on its thread', async () => {
    configureSearchPool({ threads: 2 });
    await searchProjectIndex('prj_b', request('prj_b:v1', { docs: DOCS }));
    assert.notEqual((await searchProjectIndex('prj_b', request('prj_b:v1'))).miss, true);
    evictSearchIndexes('prj_b');
    assert.equal((await searchProjectIndex('prj_b', request('prj_b:v1'))).miss, true);
  });

  it('searches inline after threads keep failing to load', async () => {
    const broken = new URL('data:text/javascript,throw new Error("load failed")');
    await shutdownSearchPool();
    configureSearchPool({ threads: 1, workerUrl: broken });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        searchProjectIndex('prj_d', request('prj_d:v1', { docs: DOCS })),
        error => error.code === 'SEARCH_THREAD_FAILED'
      );
    }
    const found = await searchProjectIndex('prj_d', request('prj_d:v1', { docs: DOCS }));
    assert.ok(found.hits.length > 0, 'the search ran on the event loop');
    assert.equal(searchPoolStats().threads, 0, 'no thread was started');
    configureSearchPool({ threads: 2 });
  });

  it('searches a project that exhausts its thread on the event loop from then on', async () => {
    // A thread that runs out of heap on its first job, like an oversized index build.
    const oom = new URL(
      'data:text/javascript,' +
        encodeURIComponent(
          "import { parentPort } from 'node:worker_threads'; const keep = [];" +
            "parentPort.on('message', () => { for (;;) keep.push(new Array(1e6).fill(1.5)); });"
        )
    );
    await shutdownSearchPool();
    configureSearchPool({ threads: 1, workerUrl: oom });
    const found = await searchProjectIndex('prj_big', request('prj_big:v1', { docs: DOCS }));
    assert.ok(found.hits.length > 0, 'the failed build was retried on the event loop');
    assert.equal(searchPoolStats().threads, 0, 'the thread was retired');
    const again = await searchProjectIndex('prj_big', request('prj_big:v1'));
    assert.notEqual(again.miss, true, 'the event loop holds the index');
    assert.equal(searchPoolStats().threads, 0, 'the project no longer goes to a thread');
    configureSearchPool({ threads: 2 });
  });

  it('keeps a thread cache well below the thread heap', () => {
    const MB = 1024 * 1024;
    // indexCache.maxHeapShare 0.5 of a 1,024 MB process heap, one 512 MB thread.
    const processChars = Math.floor((512 * MB) / INDEX_HEAP_BYTES_PER_CHAR);
    const one = searchThreadLimits({ maxEntries: 32, maxChars: processChars }, 1, 512);
    assert.equal(one.maxChars, Math.floor((256 * MB) / INDEX_HEAP_BYTES_PER_CHAR));
    assert.equal(one.maxEntries, 32);
    // A small budget is only split.
    assert.deepEqual(searchThreadLimits({ maxEntries: 32, maxChars: 1_000_000 }, 2, 512), {
      maxEntries: 16,
      maxChars: 500_000
    });
  });

  it('stops the threads above a lowered thread count', async () => {
    configureSearchPool({ threads: 4 });
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) {
      await searchProjectIndex(id, request(`${id}:v1`, { docs: DOCS.slice(0, 1) }));
    }
    assert.ok(searchPoolStats().threads > 1);
    configureSearchPool({ threads: 1 });
    await searchProjectIndex('p1', request('p1:v1', { docs: DOCS.slice(0, 1) }));
    assert.equal(searchPoolStats().threads, 1);
  });

  it('searches inline once the pool is shut down', async () => {
    configureSearchPool({ threads: 2 });
    await searchProjectIndex('prj_c', request('prj_c:v1', { docs: DOCS }));
    await shutdownSearchPool();
    assert.equal(searchPoolStats().threads, 0);
    const found = await searchProjectIndex('prj_c', request('prj_c:v1', { docs: DOCS }));
    assert.ok(found.hits.length > 0);
    assert.equal(searchPoolStats().threads, 0, 'no thread was started');
  });
});
