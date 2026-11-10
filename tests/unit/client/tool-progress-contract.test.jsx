// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The wire contract of the tool-call progress frames (issue #3534), end to end on
 * the client: frames shaped as the server's `chatToolSeam` emits them go through
 * the real reducer and `buildToolActivity`. The server side is tested in
 * `server/tests/loop/{toolArgProgress,chatToolProgress}.test.js`; this file is
 * what keeps the two halves agreeing on the awkward sequences.
 */
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { buildToolActivity } from '../../../shared/run/toolActivity.js';
import { ARGS_OUTCOMES } from '../../../shared/run/argProgress.js';

const TOOL = 'create_web_artifact';
let seq = 0;
const env = (type, data = {}) => ({
  v: 2,
  seq: ++seq,
  runId: 'r1',
  ts: new Date(Date.UTC(2026, 10, 9, 10, 0, seq)).toISOString(),
  type,
  data
});
const progress = (phase, callId, data) =>
  env('tool/progress', { step: 0, callId, toolId: callId ? TOOL : undefined, phase, data });
const started = callId =>
  env('tool/started', {
    step: 0,
    callId,
    toolId: TOOL,
    name: TOOL,
    args: { content: 'x' },
    execution: 'server'
  });
const completed = (callId, extra = {}) =>
  env('tool/completed', {
    step: 0,
    callId,
    toolId: TOOL,
    name: TOOL,
    resultPreview: 'ok',
    ...extra
  });

/** The first frame of a call carries the display fields; later ones only the numbers. */
const firstFrame = (extra = {}) => ({
  name: TOOL,
  title: 'Create interactive web artifact',
  activityKind: 'tool',
  outputKind: 'webArtifact',
  argBytes: 0,
  elapsedMs: 0,
  ...extra
});
const leanFrame = (argBytes, elapsedMs) => ({ argBytes, elapsedMs });

function play(events) {
  seq = 0;
  const state = reduceRunEvents(createStreamState('s'), [
    env('run/started', { kind: 'chat', refs: {} }),
    ...events
  ]);
  return getRun(state, 'r1');
}
const itemsOf = run => buildToolActivity(run)?.items ?? [];

describe('tool-call progress frames through the reducer and buildToolActivity', () => {
  test('later frames carry only numbers and keep the row drawn from the first one', () => {
    const [row, ...rest] = itemsOf(
      play([
        progress('args', 'c1', firstFrame()),
        progress('args', 'c1', leanFrame(4000, 1000)),
        progress('args', 'c1', leanFrame(9000, 2000))
      ])
    );
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      id: 'c1',
      status: 'preparing',
      outputKind: 'webArtifact',
      argBytes: 9000
    });
  });

  test('the size never shrinks when a frame arrives late or out of order', () => {
    const [row] = itemsOf(
      play([
        progress('args', 'c1', firstFrame()),
        progress('args', 'c1', leanFrame(9000, 2000)),
        progress('args', 'c1', leanFrame(4000, 1000))
      ])
    );
    expect(row.argBytes).toBe(9000);
  });

  test('tool/started takes the same row over: one row, then completed, never a duplicate', () => {
    const items = itemsOf(
      play([
        progress('args', 'c1', firstFrame()),
        progress('args.ended', 'c1', { outcome: 'ready', argBytes: 9500, elapsedMs: 2500 }),
        started('c1'),
        completed('c1')
      ])
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'c1', status: 'completed', outputKind: 'webArtifact' });
  });

  test('a repeated call is its own row and carries its occurrence; the first is unlabelled', () => {
    const items = itemsOf(
      play([
        progress('args', 'c1', firstFrame()),
        progress('args.ended', 'c1', { outcome: 'ready', argBytes: 100, elapsedMs: 10 }),
        started('c1'),
        completed('c1'),
        progress('args', 'c2', firstFrame({ occurrence: 2 })),
        progress('args', 'c2', leanFrame(500, 1000))
      ])
    );
    expect(items.map(item => item.id)).toEqual(['c1', 'c2']);
    expect(items[0].occurrence).toBeNull();
    expect(items[1]).toMatchObject({ status: 'preparing', occurrence: 2, argBytes: 500 });
  });

  test('a client that attached mid-call draws the row from the next frame that repeats the display fields', () => {
    // The ledger does not replay `args` frames: such a client never saw the first one.
    const lean = itemsOf(play([progress('args', 'c1', leanFrame(9000, 2000))]));
    expect(lean[0]).toMatchObject({ id: 'c1', status: 'preparing', outputKind: null });
    const repeated = itemsOf(
      play([
        progress('args', 'c1', leanFrame(9000, 2000)),
        progress('args', 'c1', { ...firstFrame(), argBytes: 12000, elapsedMs: 5000 })
      ])
    );
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ outputKind: 'webArtifact', argBytes: 12000 });
  });

  // One row per outcome the server can send. A value added to ARGS_OUTCOMES without
  // an entry here fails this test: the client would read it as `ready`.
  const OUTCOME_ROWS = {
    [ARGS_OUTCOMES.READY]: { status: 'preparing', ready: true },
    [ARGS_OUTCOMES.DROPPED]: { status: 'error', errorCode: 'dropped' },
    [ARGS_OUTCOMES.TRUNCATED]: { status: 'error', errorCode: 'truncated' },
    [ARGS_OUTCOMES.INVALID]: { status: 'error', errorCode: 'invalid' },
    [ARGS_OUTCOMES.ABORTED]: { status: 'stopped' }
  };

  test.each(Object.values(ARGS_OUTCOMES))('the outcome %s has its own row state', outcome => {
    expect(OUTCOME_ROWS).toHaveProperty([outcome]);
    const [row] = itemsOf(
      play([
        progress('args', 'c1', firstFrame()),
        progress('args.ended', 'c1', { outcome, argBytes: 100, elapsedMs: 10 })
      ])
    );
    expect(row).toMatchObject(OUTCOME_ROWS[outcome]);
  });

  test('arguments the loop repaired are still run: tool/started wins over args.ended invalid', () => {
    const [row] = itemsOf(
      play([
        progress('args', 'c1', firstFrame()),
        progress('args.ended', 'c1', { outcome: 'invalid', argBytes: 100, elapsedMs: 10 }),
        started('c1'),
        completed('c1', { error: { message: 'Tool execution failed: bad args' } })
      ])
    );
    expect(row).toMatchObject({ status: 'error', error: 'Tool execution failed: bad args' });
  });

  test('a ready call taken over by an approval shows as awaiting while the run is paused', () => {
    const [row] = itemsOf(
      play([
        progress('args', 'c1', firstFrame()),
        progress('args.ended', 'c1', { outcome: 'ready', argBytes: 100, elapsedMs: 10 }),
        env('interaction/raised', {
          interaction: {
            id: 'i1',
            kind: 'approval',
            status: 'pending',
            origin: 'policy',
            source: { toolCallId: 'c1' },
            prompt: 'Allow?'
          }
        }),
        env('run/paused', { reason: 'interaction', interactionId: 'i1' })
      ])
    );
    expect(row.status).toBe('awaiting');
  });

  test.each([
    [
      'Stop during the arguments, closed by args.ended aborted',
      [
        progress('args', 'c1', firstFrame()),
        progress('args', 'c1', leanFrame(3000, 1000)),
        progress('args.ended', 'c1', { outcome: 'aborted', argBytes: 3000, elapsedMs: 1200 }),
        env('run/ended', { status: 'aborted', finishReason: 'aborted' })
      ]
    ],
    [
      'a run that ended with no closing frame at all',
      [progress('args', 'c1', firstFrame()), env('run/ended', { status: 'aborted' })]
    ]
  ])('%s: the row is stopped, never left preparing', (_label, events) => {
    const [row] = itemsOf(play(events));
    expect(row.status).toBe('stopped');
  });

  test('a closing frame for a call that was never announced changes nothing', () => {
    const items = itemsOf(
      play([
        progress('args.ended', 'ghost', { outcome: 'ready', argBytes: 1, elapsedMs: 1 }),
        progress('args', 'c1', firstFrame())
      ])
    );
    expect(items.map(item => item.id)).toEqual(['c1']);
  });

  describe('model.waiting', () => {
    const waiting = data => progress('model.waiting', undefined, data);

    test('is the idle line of the turn and is not kept in the progress list', () => {
      const run = play([waiting({ elapsedMs: 3000 })]);
      expect(run.waiting).toMatchObject({ elapsedMs: 3000, reasoning: false });
      expect(buildToolActivity(run)?.idle).toMatchObject({ kind: 'waiting', elapsedMs: 3000 });
      expect(run.progress.some(entry => entry.phase === 'model.waiting')).toBe(false);
    });

    test('answer text ends it', () => {
      const run = play([
        waiting({ elapsedMs: 4000 }),
        env('step/delta', { step: 0, kind: 'text', content: 'Hi' })
      ]);
      expect(run.waiting).toBeNull();
    });

    test('hidden reasoning keeps it, flagged, so the line can say Thinking', () => {
      const run = play([
        waiting({ elapsedMs: 4000, reasoning: true }),
        env('step/delta', { step: 0, kind: 'thinking', content: 'hmm' })
      ]);
      expect(run.waiting).toMatchObject({ reasoning: true });
    });
  });
});
