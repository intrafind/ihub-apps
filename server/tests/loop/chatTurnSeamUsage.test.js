/**
 * chatTurnSeam usage bookkeeping (issue #2508): the request side of a model
 * call is recorded when the call ends, with the provider's prompt and cache
 * counts; a call that never reaches `stepEnd` is still recorded, with the
 * estimate taken when it started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatTurnSeam } from '../../services/chat/chatSeams.js';

const model = { id: 'm1', provider: 'openai', modelId: 'gpt-4o' };

function fakeTelemetry() {
  const calls = { start: [], end: [], request: [] };
  return {
    calls,
    recordChatCallStart: async args => {
      calls.start.push(args);
      return { promptTokens: 11 };
    },
    recordChatCallEnd: async args => {
      calls.end.push(args);
    },
    recordChatCallRequest: async args => {
      calls.request.push(args);
    }
  };
}

function makeSeam(telemetry) {
  return chatTurnSeam({
    chatId: 'c1',
    buildLogData: () => ({ appId: 'a1', userSessionId: 's1' }),
    streaming: true,
    telemetry
  });
}

const ctx = (iteration = 1) => ({
  iteration,
  model,
  messages: [{ role: 'user', content: 'hi' }],
  knowledgeSources: [],
  addKnowledgeSource: () => {},
  meta: {}
});

test('a finished call hands its pending request and the provider usage to recordChatCallEnd', async () => {
  const telemetry = fakeTelemetry();
  const seam = makeSeam(telemetry);
  const usage = { promptTokens: 2000, completionTokens: 5, cacheReadTokens: 1920 };
  await seam.preStep(ctx());
  await seam.stepEnd(ctx(), { result: { usage, content: 'ok' }, toolCalls: [] });

  assert.equal(telemetry.calls.end.length, 1);
  assert.deepEqual(telemetry.calls.end[0].request, { promptTokens: 11 });
  assert.equal(telemetry.calls.end[0].usage, usage);
  assert.equal(telemetry.calls.end[0].outcome, 'completed');
  assert.equal(telemetry.calls.request.length, 0, 'nothing recorded twice');
  assert.equal(seam.takePendingCall(), null, 'no call left in flight');
});

test('a call the loop retried without stepEnd is recorded with its estimate on the next preStep', async () => {
  const telemetry = fakeTelemetry();
  const seam = makeSeam(telemetry);
  await seam.preStep(ctx());
  // e.g. native web-search fallback: the loop re-runs the same iteration.
  await seam.preStep(ctx());

  assert.equal(telemetry.calls.request.length, 1);
  assert.deepEqual(telemetry.calls.request[0].request, { promptTokens: 11 });
  assert.equal(telemetry.calls.request[0].usage, null);
  assert.equal(telemetry.calls.start.length, 2);
});

test('an aborted call is handed to the owner via takePendingCall, exactly once', async () => {
  const telemetry = fakeTelemetry();
  const seam = makeSeam(telemetry);
  await seam.preStep(ctx());
  assert.deepEqual(seam.takePendingCall(), { promptTokens: 11 });
  assert.equal(seam.takePendingCall(), null);
});

test('telemetry without recordChatCallRequest (older stubs) is tolerated', async () => {
  const telemetry = fakeTelemetry();
  delete telemetry.recordChatCallRequest;
  const seam = makeSeam(telemetry);
  await seam.preStep(ctx());
  await seam.preStep(ctx());
  assert.equal(telemetry.calls.start.length, 2);
});
