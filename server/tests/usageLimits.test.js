// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage limits (services/quota): the reset schedule, how limits resolve
 * across model, groups and user, the ledger's counters, and the refusal the
 * LLM client raises once a budget is used up.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { currentWindows, normalizeResets, windowBounds } from '../services/quota/resetSchedule.js';
import { limitValue, resolveLimits } from '../services/quota/limitResolver.js';
import { createQuotaLedger } from '../services/quota/QuotaLedger.js';
import { buildBuckets, quotaExceededError } from '../services/quota/quotaService.js';
import { LLM_ERROR_CODES } from '../services/loop/contracts/errors.js';
import { isTransientLlmError } from '../services/loop/llmRetry.js';
import { inferenceErrorStatus, fromLLMError } from '../services/inference/errors.js';
import { parseUsageLimitsInput } from '../validators/common.js';

const iso = ms => new Date(ms).toISOString();
const BERLIN = {
  timezone: 'Europe/Berlin',
  dailyAt: '00:00',
  weeklyOn: 'monday',
  weeklyAt: '06:30',
  monthlyAt: '00:00'
};

describe('reset schedule', () => {
  it('daily window runs from the last reset to the next', () => {
    const b = windowBounds('day', BERLIN, Date.parse('2026-11-03T10:00:00Z'));
    assert.equal(iso(b.start), '2026-11-02T23:00:00.000Z');
    assert.equal(iso(b.end), '2026-11-03T23:00:00.000Z');
  });

  it('weekly window starts on the configured weekday and time', () => {
    const b = windowBounds('week', BERLIN, Date.parse('2026-11-03T10:00:00Z'));
    assert.equal(iso(b.start), '2026-11-02T05:30:00.000Z'); // Monday 06:30 CET
    assert.equal(iso(b.end), '2026-11-09T05:30:00.000Z');
  });

  it('before the weekly time on the reset day, the previous week is current', () => {
    const b = windowBounds('week', BERLIN, Date.parse('2026-11-02T05:00:00Z'));
    assert.equal(iso(b.end), '2026-11-02T05:30:00.000Z');
  });

  it('monthly window resets on the 1st', () => {
    const b = windowBounds('month', BERLIN, Date.parse('2026-11-03T10:00:00Z'));
    assert.equal(iso(b.start), '2026-10-31T23:00:00.000Z');
    assert.equal(iso(b.end), '2026-11-30T23:00:00.000Z');
    const jan = windowBounds('month', BERLIN, Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(iso(jan.start), '2025-12-31T23:00:00.000Z');
  });

  it('keeps wall-clock times across DST changes', () => {
    // Spring forward (29 March 2026): the next local midnight is 22:00Z.
    const spring = windowBounds('day', BERLIN, Date.parse('2026-03-29T00:30:00Z'));
    assert.equal(iso(spring.end), '2026-03-29T22:00:00.000Z');
    // Fall back (25 October 2026): the day lasts 25 hours.
    const fall = windowBounds('day', BERLIN, Date.parse('2026-10-25T12:00:00Z'));
    assert.equal(fall.end - fall.start, 25 * 60 * 60 * 1000);
  });

  it('falls back to defaults for invalid settings', () => {
    const r = normalizeResets({ timezone: 'Nowhere/City', dailyAt: '25:00', weeklyOn: 'funday' });
    assert.equal(r.dailyAt, '00:00');
    assert.equal(r.weeklyOn, 'monday');
    assert.notEqual(r.timezone, 'Nowhere/City');
  });

  it('currentWindows gives a key and a reset per window', () => {
    const w = currentWindows({ timezone: 'UTC' }, Date.parse('2026-11-03T10:00:00Z'));
    assert.deepEqual(w.day, {
      key: '2026-11-03T00:00:00.000Z',
      resetAt: '2026-11-04T00:00:00.000Z'
    });
    assert.equal(w.week.key, '2026-11-02T00:00:00.000Z');
    assert.equal(w.month.resetAt, '2026-12-01T00:00:00.000Z');
  });
});

describe('limit resolution', () => {
  const models = [
    { id: 'preview', usageLimits: { day: 1000, month: 20000 } },
    { id: 'standard' },
    { id: 'off', enabled: false, usageLimits: { day: 5 } }
  ];
  const user = (groups, models = ['*']) => ({
    id: 'u1',
    groups,
    permissions: { models: new Set(models) }
  });

  it('reads -1 as unlimited and unset as not limited here', () => {
    assert.equal(limitValue(-1), Infinity);
    assert.equal(limitValue(undefined), undefined);
    assert.equal(limitValue(0), 0);
  });

  it('the model is the ceiling', () => {
    const r = resolveLimits({ user: user(['users']), models, groups: {} });
    assert.deepEqual(r.models.preview.day, { limit: 1000, source: 'model' });
    assert.equal(r.models.preview.week.limit, Infinity);
    assert.equal(r.models.standard.day.limit, Infinity);
    assert.equal(r.models.off, undefined);
  });

  it('a group can lower but not raise the model limit', () => {
    const groups = {
      interns: { usageLimits: { models: { preview: { day: 200, month: 99999 } } } }
    };
    const r = resolveLimits({ user: user(['interns']), models, groups });
    assert.deepEqual(r.models.preview.day, { limit: 200, source: 'group:interns' });
    assert.deepEqual(r.models.preview.month, { limit: 20000, source: 'model' });
  });

  it('the most generous group wins; groups without an entry are neutral', () => {
    const groups = {
      interns: { usageLimits: { models: { preview: { day: 200 } } } },
      power: { usageLimits: { models: { preview: { day: 800 } } } },
      authenticated: {}
    };
    const r = resolveLimits({ user: user(['interns', 'power', 'authenticated']), models, groups });
    assert.deepEqual(r.models.preview.day, { limit: 800, source: 'group:power' });
  });

  it('-1 in a group lifts the other groups’ limits (still capped by the model)', () => {
    const groups = {
      interns: { usageLimits: { models: { preview: { day: 200 } } } },
      leads: { usageLimits: { models: { preview: { day: -1 } } } }
    };
    const r = resolveLimits({ user: user(['interns', 'leads']), models, groups });
    assert.deepEqual(r.models.preview.day, { limit: 1000, source: 'model' });
  });

  it('a model entry beats `*`, and `*` applies to the rest', () => {
    const groups = {
      g: { usageLimits: { models: { '*': { day: 50 }, preview: { day: 300 } } } }
    };
    const r = resolveLimits({ user: user(['g']), models, groups });
    assert.equal(r.models.preview.day.limit, 300);
    assert.equal(r.models.standard.day.limit, 50);
  });

  it('a group without an entry inherits its parents’', () => {
    const groups = {
      users: { usageLimits: { models: { preview: { day: 400 } } } },
      admins: { inherits: ['users'] }
    };
    const r = resolveLimits({ user: user(['admins']), models, groups });
    assert.deepEqual(r.models.preview.day, { limit: 400, source: 'group:users' });
  });

  it('the user can lower further', () => {
    const groups = { g: { usageLimits: { models: { preview: { day: 500 } } } } };
    const r = resolveLimits({
      user: user(['g']),
      userRecord: { usageLimits: { models: { preview: { day: 100 } }, allModels: { week: 7 } } },
      models,
      groups,
      platform: { usageLimits: { allModels: { week: 10 } } }
    });
    assert.deepEqual(r.models.preview.day, { limit: 100, source: 'user' });
    assert.deepEqual(r.allModels.week, { limit: 7, source: 'user' });
  });

  it('only models the user may use are listed', () => {
    const r = resolveLimits({ user: user(['g'], ['standard']), models, groups: {} });
    assert.deepEqual(Object.keys(r.models), ['standard']);
  });

  it('file storage: platform default, lowered by group and user', () => {
    const platform = { uploads: { quotas: { maxUserBytes: 1000 } } };
    const groups = { g: { usageLimits: { fileStorageBytes: 600 } } };
    assert.deepEqual(
      resolveLimits({ user: user(['g']), models: [], groups, platform }).fileStorageBytes,
      { limit: 600, source: 'group:g' }
    );
    const none = resolveLimits({
      user: user([]),
      models: [],
      platform: { uploads: { quotas: { maxUserBytes: 0 } } }
    });
    assert.equal(none.fileStorageBytes.limit, Infinity);
  });
});

describe('quota ledger', () => {
  const dirs = [];
  after(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  async function ledger() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-ledger-'));
    dirs.push(dir);
    return createQuotaLedger({ filePath: path.join(dir, 'quota.json'), flushIntervalMs: 60000 });
  }

  it('counts per model and window, and across models', async () => {
    const l = await ledger();
    const windows = currentWindows({ timezone: 'UTC' });
    l.record('u1', { modelId: 'a', appId: 'chat', tokens: 40, windows, name: 'Ann' });
    l.record('u1', { modelId: 'b', tokens: 10, windows });
    const counts = await l.getUser('u1', windows); // pending counts are visible
    assert.deepEqual(counts.models.a, { day: 40, week: 40, month: 40 });
    assert.deepEqual(counts.allModels, { day: 50, week: 50, month: 50 });
    assert.equal(counts.apps.chat, 40);
    await l.flush();
    const after = await l.getUser('u1', windows);
    assert.equal(after.allModels.day, 50);
    assert.equal(after.name, 'Ann');
  });

  it('a count from an earlier window is zero after the reset', async () => {
    const l = await ledger();
    const yesterday = currentWindows({ timezone: 'UTC' }, Date.parse('2026-11-02T12:00:00Z'));
    const today = currentWindows({ timezone: 'UTC' }, Date.parse('2026-11-03T12:00:00Z'));
    l.record('u1', { modelId: 'a', tokens: 70, windows: yesterday });
    await l.flush();
    const counts = await l.getUser('u1', today);
    assert.equal(counts.models.a.day, 0);
    assert.equal(counts.models.a.week, 70); // same week (Monday 2 November)
    l.record('u1', { modelId: 'a', tokens: 5, windows: today });
    await l.flush();
    assert.equal((await l.getUser('u1', today)).models.a.day, 5);
  });

  it('reset clears the current window', async () => {
    const l = await ledger();
    const windows = currentWindows({ timezone: 'UTC' });
    l.record('u1', { modelId: 'a', tokens: 30, windows });
    l.record('u1', { modelId: 'b', tokens: 30, windows });
    await l.reset('u1', windows, { modelId: 'a', window: 'day' });
    const counts = await l.getUser('u1', windows);
    assert.equal(counts.models.a.day, 0);
    assert.equal(counts.models.a.month, 30);
    assert.equal(counts.models.b.day, 30);
  });

  it('ignores unsafe keys', async () => {
    const l = await ledger();
    const windows = currentWindows({ timezone: 'UTC' });
    l.record('__proto__', { modelId: 'a', tokens: 1, windows });
    l.record('u1', { modelId: 'constructor', tokens: 1, windows });
    await l.flush();
    assert.deepEqual((await l.listUsers(windows)).length, 0);
  });
});

describe('buckets and the refusal', () => {
  const windows = currentWindows({ timezone: 'UTC' });
  const limits = {
    models: {
      p: {
        day: { limit: 100, source: 'model' },
        week: { limit: Infinity, source: null },
        month: { limit: Infinity, source: null }
      }
    },
    allModels: {
      day: { limit: Infinity, source: null },
      week: { limit: 1000, source: 'platform' },
      month: { limit: Infinity, source: null }
    }
  };

  it('lists only limited buckets with status', () => {
    const counts = {
      models: { p: { day: 85, week: 85, month: 85 } },
      allModels: { day: 85, week: 85, month: 85 },
      apps: {}
    };
    const buckets = buildBuckets({
      limits,
      counts,
      windows,
      models: [{ id: 'p', name: { en: 'P' } }]
    });
    assert.equal(buckets.length, 2);
    const day = buckets.find(b => b.id === 'model:p:day');
    assert.equal(day.warning, true);
    assert.equal(day.exceeded, false);
    assert.equal(day.remaining, 15);
    assert.equal(day.modelName, 'P');
    assert.equal(day.resetAt, windows.day.resetAt);
  });

  it('a refused call is a non-retryable QUOTA_EXCEEDED that the API answers with 429', () => {
    const err = quotaExceededError({
      scope: 'model',
      modelId: 'p',
      modelName: 'P',
      window: 'day',
      limit: 100,
      used: 120,
      resetAt: windows.day.resetAt,
      source: 'model'
    });
    assert.equal(err.code, LLM_ERROR_CODES.QUOTA_EXCEEDED);
    assert.equal(err.details.limit, 100);
    assert.equal(isTransientLlmError(err), false);
    assert.equal(inferenceErrorStatus(err), 429);
    assert.equal(fromLLMError(err).details.window, 'day');
  });
});

describe('usageLimits input from the admin editors', () => {
  it('drops empty parts and clears to null', () => {
    assert.deepEqual(parseUsageLimitsInput({ allModels: { day: null }, models: { a: {} } }), {
      ok: true,
      value: null
    });
    assert.deepEqual(
      parseUsageLimitsInput({ models: { a: { day: 5, week: null } }, fileStorageBytes: 10 }).value,
      { models: { a: { day: 5 } }, fileStorageBytes: 10 }
    );
  });

  it('rejects invalid values', () => {
    assert.equal(parseUsageLimitsInput({ models: { a: { day: -5 } } }).ok, false);
    assert.equal(parseUsageLimitsInput({ models: { a: { hour: 5 } } }).ok, false);
    assert.equal(parseUsageLimitsInput({ allModels: { day: 'x' } }).ok, false);
  });
});
