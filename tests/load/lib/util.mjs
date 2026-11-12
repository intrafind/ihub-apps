// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { setTimeout as delay } from 'node:timers/promises';

export const sleep = ms => delay(Math.max(0, ms));

/** Integer in [min, max] from a [min, max] pair (or a plain number). */
export function between(range) {
  if (!Array.isArray(range)) return range;
  const [min, max] = range;
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function pickWeighted(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries.at(-1)[0];
}

/** Counting semaphore, e.g. to cap concurrent crawls against a real website. */
export class Semaphore {
  constructor(n) {
    this.free = n;
    this.waiters = [];
  }

  async use(fn) {
    if (this.free > 0) this.free -= 1;
    else await new Promise(resolve => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

/** Run `fn` over items with at most `n` in flight. */
export async function mapLimit(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Retry on HTTP 429 / network errors with backoff (honours Retry-After). */
export async function withRetry(fn, { attempts = 6, baseMs = 2000, label = 'request' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err.status === 429 || err.status === 503 || !err.status;
      if (!retryable || i === attempts - 1) break;
      const after = Number(err.retryAfter) * 1000;
      const wait = Number.isFinite(after) && after > 0 ? after : baseMs * 2 ** i;
      console.warn(`[retry] ${label}: ${err.message} — waiting ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}
