// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * LLMClient writes exactly one usage call record per model call, whatever the
 * surface and however the call ends (services/usage).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, sseResponse, openaiText, textResponse } from './helpers/llmFixtures.js';
import { LLMError, LLM_ERROR_CODES } from '../../services/loop/contracts/errors.js';

const messages = [{ role: 'user', content: 'hello there' }];
const user = { id: 'alice', groups: ['sales', 'authenticated'] };

function recorder() {
  const records = [];
  return { records, usage: { record: call => records.push(call) } };
}

test('a completed call is recorded once with provider usage, outcome and timing', async () => {
  const { records, usage } = recorder();
  const { client } = makeClient({
    usage,
    transport: async () =>
      sseResponse(
        openaiText(['Hi', '!'], {
          usage: {
            prompt_tokens: 40,
            completion_tokens: 3,
            total_tokens: 43,
            prompt_tokens_details: { cached_tokens: 30 }
          }
        })
      )
  });
  await client.complete({
    modelId: 'oa',
    messages,
    options: { user },
    telemetry: { appId: 'chat', chatId: 'c-1', surface: 'chat', autoRun: false }
  });
  assert.equal(records.length, 1);
  const [call] = records;
  assert.equal(call.user, user);
  assert.equal(call.surface, 'chat');
  assert.equal(call.appId, 'chat');
  assert.equal(call.modelId, 'oa');
  assert.equal(call.provider, 'openai');
  assert.equal(call.conversationId, 'c-1');
  assert.equal(call.outcome, 'ok');
  assert.equal(call.errorCode, null);
  assert.equal(call.usage.promptTokens, 40);
  assert.equal(call.usage.cacheReadTokens, 30);
  assert.equal(call.usage.completionTokens, 3);
  assert.ok(call.latencyMs >= 0);
  assert.ok(call.ttftMs >= 0 && call.ttftMs <= call.latencyMs);
  assert.match(call.requestId, /^req-/);
});

test('a call refused by the quota is recorded with outcome quota', async () => {
  const { records, usage } = recorder();
  const refusal = new LLMError('over budget', { code: LLM_ERROR_CODES.QUOTA_EXCEEDED });
  const { client } = makeClient({
    usage,
    quota: {
      async assert() {
        throw refusal;
      },
      record() {}
    },
    transport: async () => sseResponse([])
  });
  await assert.rejects(client.execute({ modelId: 'oa', messages, options: { user } }));
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'quota');
  assert.equal(records[0].errorCode, 'QUOTA_EXCEEDED');
  assert.equal(records[0].usage, null);
});

test('a provider error is recorded with outcome error and its code', async () => {
  const { records, usage } = recorder();
  const { client } = makeClient({
    usage,
    maxRetries: 0,
    transport: async () => textResponse('bad things', { status: 400 })
  });
  await assert.rejects(
    client.complete({ modelId: 'oa', messages, retries: 0, telemetry: { autoRun: false } })
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'error');
  assert.ok(records[0].errorCode);
  assert.equal(records[0].user, null);
});

test('a rate-limited call is recorded as rate_limited', async () => {
  const { records, usage } = recorder();
  const { client } = makeClient({
    usage,
    maxRetries: 0,
    transport: async () => textResponse('slow down', { status: 429 })
  });
  await assert.rejects(
    client.complete({ modelId: 'oa', messages, retries: 0, telemetry: { autoRun: false } })
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'rate_limited');
});

test('the surface comes from the run on the ledger when the caller names none', async () => {
  const { records, usage } = recorder();
  const { client } = makeClient({
    usage,
    runLog: {
      getRunMeta: id =>
        id === 'run-task'
          ? { kind: 'chat', trigger: { type: 'schedule' }, refs: { appId: 'digest' } }
          : { kind: 'workflow', refs: { executionId: 'exec-1' } },
      append() {}
    },
    transport: async () => sseResponse(openaiText(['ok']))
  });
  const run = async runId => {
    const stream = await client.execute({ modelId: 'oa', messages, telemetry: { runId } });
    for await (const _ of stream) {
      /* drain */
    }
  };
  await run('run-task');
  await run('run-wf');
  assert.deepEqual(
    records.map(r => [r.surface, r.appId, r.conversationId]),
    [
      ['task', 'digest', 'run-task'],
      ['workflow', null, 'exec-1']
    ]
  );
});

test('tool calls are counted', async () => {
  const { records, usage } = recorder();
  const { client } = makeClient({
    usage,
    transport: async () =>
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 't1',
                    type: 'function',
                    function: { name: 'a', arguments: '{}' }
                  },
                  { index: 1, id: 't2', type: 'function', function: { name: 'b', arguments: '{}' } }
                ]
              },
              finish_reason: null
            }
          ]
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]'
      ])
  });
  await client.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } });
  assert.equal(records.length, 1);
  assert.equal(records[0].toolCalls, 2);
});
