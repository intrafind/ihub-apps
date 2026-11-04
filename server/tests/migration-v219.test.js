// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version
} from '../migrations/V219__usage_feedback_good_bad_to_ratings.js';

function makeCtx(usage) {
  let stored = usage === undefined ? undefined : structuredClone(usage);
  const writes = [];
  return {
    writes,
    stored: () => stored,
    fileExists: async () => stored !== undefined,
    readJson: async () => structuredClone(stored),
    writeJson: async (_path, data) => {
      writes.push(data);
      stored = data;
    },
    log: () => {},
    warn: () => {}
  };
}

const empty = () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

describe('migration V219', () => {
  it('has version 219', () => assert.equal(version, '219'));

  it('is skipped without a usage file', async () => {
    assert.equal(await precondition(makeCtx(undefined)), false);
  });

  it('folds good/bad into empty ratings and removes the counters everywhere', async () => {
    const ctx = makeCtx({
      feedback: {
        total: 0,
        ratings: empty(),
        averageRating: 0,
        good: 3,
        bad: 1,
        perApp: { a1: { total: 0, ratings: empty(), averageRating: 0, good: 3, bad: 1 } },
        perUser: {},
        perModel: { m1: { good: 2, bad: 0 } }
      }
    });
    await up(ctx);
    const { feedback } = ctx.stored();
    assert.equal(feedback.good, undefined);
    assert.equal(feedback.bad, undefined);
    assert.equal(feedback.total, 4);
    assert.equal(feedback.ratings[5], 3);
    assert.equal(feedback.ratings[1], 1);
    assert.equal(feedback.averageRating, 4);
    assert.equal(feedback.perApp.a1.good, undefined);
    assert.equal(feedback.perApp.a1.total, 4);
    assert.equal(feedback.perModel.m1.ratings[5], 2);
    assert.equal(feedback.perModel.m1.total, 2);
  });

  it('only strips the counters when star ratings already exist', async () => {
    const ctx = makeCtx({
      feedback: {
        total: 2,
        ratings: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 },
        averageRating: 4.5,
        good: 2,
        bad: 0
      }
    });
    await up(ctx);
    const { feedback } = ctx.stored();
    assert.equal(feedback.good, undefined);
    assert.equal(feedback.total, 2);
    assert.equal(feedback.ratings[5], 1);
    assert.equal(feedback.averageRating, 4.5);
  });

  it('does not write when nothing needs changing', async () => {
    const ctx = makeCtx({ feedback: { total: 0, ratings: empty(), averageRating: 0 } });
    await up(ctx);
    assert.equal(ctx.writes.length, 0);
  });
});
