// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The count the chat surface waits on before it takes the frames of a turn
 * from the GET stream: frames read against envelopes sent. Both sides must
 * count the same frames, or the wait is over one frame early and the record
 * lacks the end of the turn on a slow machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveredFrames, recordedFrames } from './chat.js';
import { parseSse } from './http.js';

const CHAT = '0c0ffee0-0000-4000-8000-00000000c4a7';
const frame = (type, extra = {}) => ({ event: type, data: { type, runId: 'run-1', ...extra } });

test('stream/connected is not one of the frames the server delivered, although it names a run', () => {
  // As `writeStreamStart` writes it: the id of the chat in the place of the run id.
  const connected = frame('stream/connected', { runId: CHAT, data: { runId: CHAT, lastSeq: 0 } });
  const turn = [frame('run/started'), frame('step/delta'), frame('run/ended')];
  assert.deepEqual(deliveredFrames([connected]), []);
  assert.deepEqual(deliveredFrames([connected, ...turn]), turn);
  // One frame of the turn is still on its way: the count is one short, not complete.
  assert.equal(deliveredFrames([connected, ...turn.slice(0, 2)]).length, 2);
});

test('a frame without a run id counts; a frame that is no envelope does not', () => {
  const frames = [
    { event: 'stream/error', data: { type: 'stream/error', data: { code: 'X' } } },
    { data: '[DONE]' },
    { event: 'heartbeat', data: { type: 'heartbeat' } },
    {}
  ];
  assert.deepEqual(deliveredFrames(frames), [frames[0]]);
});

test('the count reads frames as the stream writes them', () => {
  const text =
    `event: stream/connected\ndata: {"type":"stream/connected","runId":"${CHAT}"}\n\n` +
    ': keep-alive\n\n' +
    'event: run/started\ndata: {"type":"run/started","runId":"run-1"}\n\n' +
    'event: run/ended\ndata: {"type":"run/ended","runId":"run-1"}\n\n';
  assert.deepEqual(
    deliveredFrames(parseSse(text)).map(f => f.data.type),
    ['run/started', 'run/ended']
  );
});

test('the counters the server put on the wire are checked before a record drops them', () => {
  const wire = (type, seq, rseq, runId = 'run-1') => ({
    event: type,
    data: { type, runId, seq, ...(rseq ? { rseq } : {}), data: {} }
  });
  const connected = wire('stream/connected', 1, 0, CHAT);
  const turn = [wire('run/started', 2, 1), wire('run/ended', 3, 2)];
  assert.deepEqual(
    recordedFrames([connected, ...turn]).map(f => Object.keys(f)),
    [
      ['type', 'runId', 'data'],
      ['type', 'runId', 'data'],
      ['type', 'runId', 'data']
    ]
  );
  // A second run on the same response counts its own frames from 1; the stream counts on.
  assert.doesNotThrow(() =>
    recordedFrames([connected, ...turn, wire('run/started', 4, 1, 'run-2')])
  );
  assert.throws(
    () => recordedFrames([connected, wire('run/started', 3, 1), wire('run/ended', 2, 2)]),
    /seq does not increase/
  );
  assert.throws(
    () => recordedFrames([connected, wire('run/started', 2, 2), wire('run/ended', 3, 1)]),
    /rseq does not increase/
  );
  // A count that starts again in the middle of a turn.
  assert.throws(
    () => recordedFrames([connected, ...turn, wire('step/delta', 1, 3)]),
    /seq does not increase/
  );
});
