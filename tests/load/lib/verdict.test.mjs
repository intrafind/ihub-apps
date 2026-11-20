// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// node --test "tests/load/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from './verdict.mjs';

/** A shard result with the given counters, all in stage 0. */
const result = (mix, counts) => ({
  meta: { config: { mix } },
  metrics: { counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, { 0: v }])) }
});

test('a run in which every chat scenario of the mix ended a turn and none failed passes', () => {
  const verdict = judge(
    result(
      { chat: 50, agentTurn: 50, browse: 10, inference: 0 },
      { 'chat.turn.ok': 12, 'agentTurn.turn.ok': 9 }
    )
  );
  assert.equal(verdict.ok, true, verdict.lines.join('\n'));
  assert.deepEqual(verdict.lines, [
    'chat: 12 turns ended, 0 failed',
    'agentTurn: 9 turns ended, 0 failed',
    'turns: 21 ended, 0 failed (0.0 %)'
  ]);
});

test('a chat scenario of the mix without a single turn fails the run', () => {
  const verdict = judge(result({ chat: 50, agentTurn: 50 }, { 'chat.turn.ok': 12 }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.lines.includes('FAILED: no turn of agentTurn ended'));
});

test('a run that made no turn at all fails', () => {
  const verdict = judge(result({ browse: 100 }, {}));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.lines.includes('FAILED: the run made no turn at all'));
});

test('one failed turn fails the run unless the limit allows it, and the error codes are listed', () => {
  const counts = { 'chat.turn.ok': 19, 'chat.turn.error': 1, 'error.chat.RUN_ERROR': 1 };
  const strict = judge(result({ chat: 100 }, counts));
  assert.equal(strict.ok, false);
  assert.ok(strict.lines.includes('FAILED: more than 0 % of the turns failed'));
  assert.ok(strict.lines.includes('  error.chat.RUN_ERROR: 1'));
  assert.equal(judge(result({ chat: 100 }, counts), { maxErrorPct: 5 }).ok, true);
  assert.equal(judge(result({ chat: 100 }, counts), { maxErrorPct: 4.9 }).ok, false);
});

test('an agent turn that ran fewer tool calls than asked for fails the run', () => {
  const verdict = judge(
    result({ agentTurn: 100 }, { 'agentTurn.turn.ok': 8, 'agentTurn.toolRounds.short': 2 }),
    { maxErrorPct: 100 }
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.lines.includes('FAILED: 2 agent turns ran fewer tool calls than asked for'));
});
