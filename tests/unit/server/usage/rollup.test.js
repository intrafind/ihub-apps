// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import {
  buildRollup,
  mergeRollups,
  percentileFromHist,
  summarizeStats,
  LATENCY_BUCKETS_MS
} from '../../../../server/services/usage/rollup.js';

const call = (over = {}) => ({
  v: 2,
  type: 'llm_call',
  ts: '2026-11-04T10:15:00.000Z',
  surf: 'chat',
  uid: 'alice',
  grp: ['sales'],
  app: 'chat',
  model: 'gpt',
  prov: 'openai',
  st: 'ok',
  pt: 100,
  ct: 10,
  cr: 60,
  src: 'provider',
  lat: 900,
  ttft: 200,
  tc: 1,
  ...over
});

describe('buildRollup', () => {
  const events = [
    call(),
    call({
      ts: '2026-11-04T10:45:00.000Z',
      uid: 'bob',
      grp: ['sales', 'it'],
      model: 'claude',
      prov: 'anthropic'
    }),
    call({
      ts: '2026-11-04T13:00:00.000Z',
      st: 'error',
      err: 'TIMEOUT',
      pt: 0,
      ct: 0,
      cr: undefined,
      lat: 30000
    }),
    call({
      ts: '2026-11-04T13:01:00.000Z',
      st: 'quota',
      err: 'QUOTA_EXCEEDED',
      pt: 0,
      ct: 0,
      cr: undefined,
      lat: 2
    }),
    {
      v: 2,
      type: 'feedback',
      ts: '2026-11-04T14:00:00.000Z',
      uid: 'alice',
      app: 'chat',
      model: 'gpt',
      rating: 4
    }
  ];
  const rollup = buildRollup(events, { date: '2026-11-04' });

  it('counts one request per call and feedback separately', () => {
    expect(rollup.totals.requests).toBe(4);
    expect(rollup.totals.promptTokens).toBe(200);
    expect(rollup.totals.cacheReadTokens).toBe(120);
    expect(rollup.totals.errors).toBe(1);
    expect(rollup.feedback.count).toBe(1);
    expect(rollup.feedback.ratings[4]).toBe(1);
    expect(rollup.feedback.byApp.chat[4]).toBe(1);
  });

  it('fills hourly buckets (UTC)', () => {
    expect(rollup.byHour[10].requests).toBe(2);
    expect(rollup.byHour[13]).toMatchObject({ requests: 2, errors: 1 });
    expect(rollup.byHour.reduce((n, h) => n + h.requests, 0)).toBe(4);
  });

  it('has every dimension, a group per group and per-model sub-rows', () => {
    expect(Object.keys(rollup.byUser).sort()).toEqual(['alice', 'bob']);
    expect(rollup.byGroup.sales.requests).toBe(4);
    expect(rollup.byGroup.it.requests).toBe(1);
    expect(rollup.bySurface.chat.requests).toBe(4);
    expect(rollup.byProvider.anthropic.requests).toBe(1);
    expect(rollup.byUser.alice.models.gpt.requests).toBe(3);
    expect(rollup.byModel.gpt.models).toBeUndefined();
    expect(rollup.byUser.alice.lastTs).toBe('2026-11-04T13:01:00.000Z');
  });

  it('counts outcomes and error codes by provider', () => {
    expect(rollup.byOutcome).toEqual({ ok: 2, error: 1, quota: 1 });
    expect(rollup.byError.TIMEOUT).toEqual({ count: 1, byProvider: { openai: 1 } });
  });

  it('leaves quota refusals out of the latency figures', () => {
    expect(rollup.totals.latencyCount).toBe(3);
  });

  it('ignores records of an unknown type and unsafe keys', () => {
    const r = buildRollup([{ type: 'chat_request', ts: 'x' }, call({ uid: '__proto__' })]);
    expect(r.totals.requests).toBe(1);
    expect(Object.keys(r.byUser)).toEqual([]);
  });
});

describe('mergeRollups', () => {
  it('adds days up, sub-rows and feedback included', () => {
    const a = buildRollup([call()]);
    const b = buildRollup([
      call({ ts: '2026-11-05T09:00:00.000Z', pt: 50 }),
      { v: 2, type: 'feedback', ts: '2026-11-05T09:00:00.000Z', uid: 'alice', rating: 5 }
    ]);
    const merged = mergeRollups([a, b, null]);
    expect(merged.totals.requests).toBe(2);
    expect(merged.totals.promptTokens).toBe(150);
    expect(merged.byUser.alice.models.gpt.requests).toBe(2);
    expect(merged.byUser.alice.lastTs).toBe('2026-11-05T09:00:00.000Z');
    expect(merged.feedback.byUser.alice[5]).toBe(1);
    expect(merged.totals.latencyHist.reduce((x, y) => x + y, 0)).toBe(2);
  });
});

describe('percentiles', () => {
  it('reads p50/p95 from the histogram', () => {
    const hist = LATENCY_BUCKETS_MS.map(() => 0);
    hist[2] = 90; // 500–1000 ms
    hist[6] = 10; // 8–15 s
    expect(percentileFromHist(hist, 0.5)).toBeGreaterThan(500);
    expect(percentileFromHist(hist, 0.5)).toBeLessThanOrEqual(1000);
    expect(percentileFromHist(hist, 0.95)).toBeGreaterThan(8000);
    expect(percentileFromHist(hist, 0.95)).toBeLessThanOrEqual(15000);
    expect(
      percentileFromHist(
        LATENCY_BUCKETS_MS.map(() => 0),
        0.5
      )
    ).toBe(null);
  });

  it('summarizes rates', () => {
    const s = summarizeStats(buildRollup([call(), call({ st: 'rate_limited' })]).totals);
    expect(s.errorRate).toBe(0.5);
    expect(s.cacheHitRate).toBeCloseTo(0.6);
    expect(s.totalTokens).toBe(220);
  });
});
