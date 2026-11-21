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

test('a run in which every scenario of the mix ended a session, every chat a turn, and nothing failed passes', () => {
  const verdict = judge(
    result(
      { chat: 50, agentTurn: 50, browse: 10, inference: 0 },
      {
        'session.chat.ok': 5,
        'chat.turn.ok': 12,
        'session.agentTurn.ok': 4,
        'agentTurn.turn.ok': 9,
        'session.browse.ok': 2
      }
    )
  );
  assert.equal(verdict.ok, true, verdict.lines.join('\n'));
  assert.deepEqual(verdict.lines, [
    'chat: 5 sessions ended, 0 failed',
    'chat: 12 turns ended, 0 failed',
    'agentTurn: 4 sessions ended, 0 failed',
    'agentTurn: 9 turns ended, 0 failed',
    'browse: 2 sessions ended, 0 failed',
    'turns: 21 ended, 0 failed (0.0 %)'
  ]);
});

test('a chat scenario of the mix without a single turn fails the run', () => {
  const verdict = judge(
    result(
      { chat: 50, agentTurn: 50 },
      { 'session.chat.ok': 5, 'chat.turn.ok': 12, 'session.agentTurn.ok': 1 }
    )
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.lines.includes('FAILED: no turn of agentTurn ended'));
});

test('a run that made no turn at all fails', () => {
  const verdict = judge(result({ browse: 100 }, { 'session.browse.ok': 3 }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.lines.includes('FAILED: the run made no turn at all'));
});

/** A run in which `chat` did its work; a test adds the scenario it is about. */
const withChat = (mix, counts) =>
  result({ chat: 60, ...mix }, { 'session.chat.ok': 6, 'chat.turn.ok': 14, ...counts });

test('a scenario that records its turns under another name fails the run when every session of it failed', () => {
  // projectBuild fails at its upload or its crawl, before the chat it records
  // as projectBuildChat: no turn failed, only sessions.
  const verdict = judge(
    withChat(
      { projectBuild: 15 },
      { 'session.projectBuild.error': 4, 'error.session.projectBuild.HTTP_500': 4 }
    )
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.lines.includes('projectBuild: 0 sessions ended, 4 failed'));
  assert.ok(verdict.lines.includes('FAILED: no session of projectBuild ended'));
  assert.ok(verdict.lines.includes('FAILED: more than 0 % of the sessions of projectBuild failed'));
  assert.ok(verdict.lines.includes('  error.session.projectBuild.HTTP_500: 4'));
  // The turns alone say nothing is wrong.
  assert.ok(verdict.lines.includes('turns: 14 ended, 0 failed (0.0 %)'));
});

test('a scenario without turns fails the run when no session of it ended', () => {
  // browse makes no turn. Not one session of it ended: it failed, or was never run.
  const failed = judge(withChat({ browse: 10 }, { 'session.browse.error': 3 }));
  assert.equal(failed.ok, false);
  assert.ok(failed.lines.includes('FAILED: no session of browse ended'));
  const neverRun = judge(withChat({ browse: 10 }, {}));
  assert.equal(neverRun.ok, false);
  assert.ok(neverRun.lines.includes('browse: 0 sessions ended, 0 failed'));
  assert.ok(neverRun.lines.includes('FAILED: no session of browse ended'));
  // A weight of 0 takes the scenario out of the mix: nothing is asked of it.
  assert.equal(judge(withChat({ browse: 0 }, {})).ok, true);
});

test('failed sessions of one scenario fail the run unless the limit allows them', () => {
  // chatFile failed its upload in every session but one; the one made its turns.
  const counts = {
    'session.chatFile.ok': 1,
    'session.chatFile.error': 9,
    'chatFile.turn.ok': 2,
    'error.session.chatFile.HTTP_413': 9
  };
  const strict = judge(withChat({ chatFile: 20 }, counts));
  assert.equal(strict.ok, false);
  assert.ok(strict.lines.includes('FAILED: more than 0 % of the sessions of chatFile failed'));
  assert.ok(strict.lines.includes('  error.session.chatFile.HTTP_413: 9'));
  // The limit is per scenario: chat did not fail, and does not dilute chatFile.
  assert.equal(judge(withChat({ chatFile: 20 }, counts), { maxErrorPct: 89.9 }).ok, false);
  assert.equal(judge(withChat({ chatFile: 20 }, counts), { maxErrorPct: 90 }).ok, true);
});

test('one failed turn fails the run unless the limit allows it, and the error codes are listed', () => {
  const counts = {
    'session.chat.ok': 8,
    'chat.turn.ok': 19,
    'chat.turn.error': 1,
    'error.chat.RUN_ERROR': 1
  };
  const strict = judge(result({ chat: 100 }, counts));
  assert.equal(strict.ok, false);
  assert.ok(strict.lines.includes('FAILED: more than 0 % of the turns failed'));
  assert.ok(strict.lines.includes('  error.chat.RUN_ERROR: 1'));
  assert.equal(judge(result({ chat: 100 }, counts), { maxErrorPct: 5 }).ok, true);
  assert.equal(judge(result({ chat: 100 }, counts), { maxErrorPct: 4.9 }).ok, false);
});

test('an agent turn that ran fewer tool calls than asked for fails the run', () => {
  const verdict = judge(
    result(
      { agentTurn: 100 },
      { 'session.agentTurn.ok': 4, 'agentTurn.turn.ok': 8, 'agentTurn.toolRounds.short': 2 }
    ),
    { maxErrorPct: 100 }
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.lines.includes('FAILED: 2 agent turns ran fewer tool calls than asked for'));
});
