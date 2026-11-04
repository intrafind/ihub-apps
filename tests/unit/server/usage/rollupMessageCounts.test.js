// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest } from '@jest/globals';

// The aggregator only needs the rollup builder here; keep the event log and
// feedback store (contents paths, import.meta) out of the CJS transform.
jest.mock('../../../../server/services/UsageEventLog.js', () => ({
  readEvents: async () => [],
  getDailyDir: () => '/tmp/usage-daily',
  getMonthlyDir: () => '/tmp/usage-monthly',
  cleanupEvents: async () => {},
  flushQueue: async () => 0
}));
jest.mock('../../../../server/feedbackStorage.js', () => ({
  cleanupFeedback: async () => ({ removed: 0 })
}));
jest.mock('../../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

import { buildDailyRollup } from '../../../../server/services/UsageAggregator.js';

const base = { uid: 'u1', app: 'chat', model: 'm1', src: 'provider' };
const at = s => `2026-11-04T10:00:${String(s).padStart(2, '0')}.000Z`;

describe('buildDailyRollup message counts', () => {
  it('counts a request/response pair as one message', () => {
    const rollup = buildDailyRollup(
      [
        { ...base, ts: at(1), type: 'chat_request', pt: 100 },
        { ...base, ts: at(2), type: 'chat_response', ct: 20 }
      ],
      '2026-11-04'
    );
    expect(rollup.totals.messages).toBe(1);
    expect(rollup.byUser.u1.messages).toBe(1);
    expect(rollup.byApp.chat.messages).toBe(1);
    expect(rollup.byModel.m1).toMatchObject({
      messages: 1,
      promptTokens: 100,
      completionTokens: 20
    });
  });

  it('does not count feedback or magic prompts as messages', () => {
    const rollup = buildDailyRollup(
      [
        { ...base, ts: at(1), type: 'feedback', rating: 5 },
        { ...base, ts: at(2), type: 'magic_prompt', pt: 10, ct: 5 }
      ],
      '2026-11-04'
    );
    expect(rollup.totals.messages).toBe(0);
    expect(rollup.byUser.u1.messages).toBe(0);
    expect(rollup.byModel.m1.messages).toBe(0);
    expect(rollup.totals.feedbackCount).toBe(1);
    expect(rollup.totals.magicPrompts).toBe(1);
  });

  it('keeps the per-dimension message counts equal to the total', () => {
    const events = [];
    for (let i = 0; i < 3; i++) {
      events.push({ ...base, uid: `u${i}`, ts: at(i * 2), type: 'chat_request', pt: 1 });
      events.push({ ...base, uid: `u${i}`, ts: at(i * 2 + 1), type: 'chat_response', ct: 1 });
    }
    const rollup = buildDailyRollup(events, '2026-11-04');
    const perUser = Object.values(rollup.byUser).reduce((n, e) => n + e.messages, 0);
    expect(rollup.totals.messages).toBe(3);
    expect(perUser).toBe(3);
    expect(rollup.totals.uniqueUsers).toBe(3);
  });
});
