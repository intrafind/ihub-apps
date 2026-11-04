// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mockRoot;
jest.mock('../../../../server/utils/contentsPath.js', () => ({
  getContentsPath: (...segments) => require('node:path').join(mockRoot, ...segments)
}));
jest.mock('../../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
jest.mock('../../../../server/feedbackStorage.js', () => ({
  cleanupFeedback: async () => ({ removed: 0 })
}));

import { eventFileFor } from '../../../../server/services/UsageEventLog.js';
import { queryCalls } from '../../../../server/services/usage/callLog.js';
import { UsageQueryError } from '../../../../server/services/usage/usageQuery.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

function writeDay(date, records) {
  fs.mkdirSync(path.dirname(eventFileFor(date)), { recursive: true });
  fs.writeFileSync(eventFileFor(date), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const call = (ts, over = {}) => ({
  v: 2,
  type: 'llm_call',
  ts,
  surf: 'chat',
  uid: 'alice',
  app: 'chat',
  model: 'gpt',
  st: 'ok',
  pt: 1,
  ct: 1,
  ...over
});

beforeEach(() => {
  mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'call-log-'));
  writeDay('2026-11-03', [
    call('2026-11-03T08:00:00.000Z'),
    call('2026-11-03T09:00:00.000Z', { surf: 'agent', uid: 'bob' })
  ]);
  writeDay('2026-11-04', [
    call('2026-11-04T10:00:00.000Z', { st: 'error', err: 'TIMEOUT' }),
    { v: 2, type: 'feedback', ts: '2026-11-04T10:30:00.000Z', rating: 5 },
    call('2026-11-04T11:00:00.000Z'),
    call('2026-11-04T11:00:00.000Z', { model: 'claude' })
  ]);
});
afterEach(() => fs.rmSync(mockRoot, { recursive: true, force: true }));

describe('queryCalls', () => {
  it('lists call records newest first, across days, without feedback', async () => {
    const page = await queryCalls({ range: '7d' }, NOW);
    expect(page.items.map(i => i.ts)).toEqual([
      '2026-11-04T11:00:00.000Z',
      '2026-11-04T11:00:00.000Z',
      '2026-11-04T10:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
      '2026-11-03T08:00:00.000Z'
    ]);
    // Same timestamp: the later line first.
    expect(page.items[0].model).toBe('claude');
    expect(page.items[0].id).toBe('2026-11-04:3');
    expect(page.nextCursor).toBe(null);
  });

  it('pages with a cursor without repeating or skipping records', async () => {
    const seen = [];
    let cursor;
    do {
      const page = await queryCalls({ range: '7d', limit: 2, cursor }, NOW);
      seen.push(...page.items.map(i => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([
      '2026-11-04:3',
      '2026-11-04:2',
      '2026-11-04:0',
      '2026-11-03:1',
      '2026-11-03:0'
    ]);
  });

  it('filters by user, surface, outcome and model', async () => {
    expect((await queryCalls({ range: '7d', user: 'bob' }, NOW)).items).toHaveLength(1);
    expect((await queryCalls({ range: '7d', surface: 'agent' }, NOW)).items[0].uid).toBe('bob');
    expect((await queryCalls({ range: '7d', outcome: 'error' }, NOW)).items[0].err).toBe('TIMEOUT');
    expect((await queryCalls({ range: '7d', model: 'claude' }, NOW)).items).toHaveLength(1);
    expect((await queryCalls({ range: 'today' }, NOW)).items).toHaveLength(3);
  });

  it('rejects unknown filters and broken cursors', async () => {
    await expect(queryCalls({ range: '7d', surface: 'x' }, NOW)).rejects.toThrow(UsageQueryError);
    await expect(queryCalls({ range: '7d', outcome: 'x' }, NOW)).rejects.toThrow(UsageQueryError);
    await expect(queryCalls({ range: '7d', cursor: 'nope' }, NOW)).rejects.toThrow(UsageQueryError);
  });
});
