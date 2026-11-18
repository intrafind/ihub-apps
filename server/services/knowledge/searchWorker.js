// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { parentPort } from 'node:worker_threads';
import { createIndexCache, searchIndex } from './corpusSearch.js';

/**
 * Worker thread entry of the project search pool (`searchPool.js`).
 *
 * The thread owns the corpus indexes of the projects routed to it, so a query
 * crosses the boundary as a key and a question, not as an index. Messages:
 *
 *  - `{ id, task: 'search', payload }` → `{ id, ok, result | error }`, where
 *    `payload` and `result` are those of `corpusSearch.searchIndex`;
 *  - `{ task: 'evict', payload: { projectId } }` → no answer.
 *
 * Messages are handled one after the other (the work is synchronous), so the
 * thread's own message queue is the pool's job queue. Nothing here reads
 * configuration or reaches out: every limit arrives in the payload.
 */

const cache = createIndexCache();

parentPort.on('message', ({ id, task, payload }) => {
  if (task === 'evict') {
    cache.evictProject(payload?.projectId);
    return;
  }
  try {
    if (task !== 'search') throw new Error(`Unknown search task: ${task}`);
    parentPort.postMessage({ id, ok: true, result: searchIndex(cache, payload) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: { message: error?.message || String(error) } });
  }
});
