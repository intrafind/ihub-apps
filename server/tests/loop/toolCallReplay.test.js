/**
 * Tool calls replayed in message history go to OpenAI-format providers with
 * JSON arguments. A call the model made without arguments is recorded as `''`;
 * OpenAI tolerates that, strict OpenAI-compatible servers (Ollama) answer 400
 * "invalid tool call arguments" (issue #2707).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeToolArguments,
  withSerializedToolArguments
} from '../../adapters/toolCalling/index.js';
import { makeClient, sseResponse, openaiText } from './helpers/llmFixtures.js';

const NO_RUN = { autoRun: false };

function historyWithToolCalls(argumentsList) {
  return [
    { role: 'user', content: 'list my issues' },
    {
      role: 'assistant',
      content: null,
      tool_calls: argumentsList.map((args, i) => ({
        index: i,
        id: `call_${i + 1}`,
        type: 'function',
        function: { name: 'list_my_issues', arguments: args }
      }))
    },
    ...argumentsList.map((_, i) => ({
      role: 'tool',
      tool_call_id: `call_${i + 1}`,
      name: 'list_my_issues',
      content: '[]'
    }))
  ];
}

/** Build the provider request through the real adapter and return its body. */
async function requestBody(modelId, messages, response = sseResponse(openaiText(['ok']))) {
  const { client, calls } = makeClient({ realRequest: true, transport: async () => response });
  await client.complete({ modelId, messages, telemetry: NO_RUN });
  return calls[0].request.body;
}

test('serializeToolArguments: blank and missing → {}, objects stringified, JSON kept', () => {
  assert.equal(serializeToolArguments(''), '{}');
  assert.equal(serializeToolArguments('  \n'), '{}');
  assert.equal(serializeToolArguments(undefined), '{}');
  assert.equal(serializeToolArguments(null), '{}');
  assert.equal(serializeToolArguments({ q: 'a' }), '{"q":"a"}');
  assert.equal(serializeToolArguments('{"q": "a"}'), '{"q": "a"}');
});

test('withSerializedToolArguments returns the same array when nothing needs fixing', () => {
  const calls = [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }];
  assert.equal(withSerializedToolArguments(calls), calls);
  const fixed = withSerializedToolArguments([
    { id: 'c1', type: 'function', function: { name: 'x', arguments: '' } }
  ]);
  assert.equal(fixed[0].function.arguments, '{}');
  assert.equal(fixed[0].function.name, 'x');
});

for (const modelId of ['oa', 'vl', 'ms']) {
  test(`[${modelId}] a replayed tool call without arguments is sent as "{}"`, async () => {
    const messages = historyWithToolCalls(['', ' ', '{"state":"open"}']);
    const body = await requestBody(modelId, messages);
    const assistant = body.messages.find(m => m.role === 'assistant');
    assert.deepEqual(
      assistant.tool_calls.map(c => c.function.arguments),
      ['{}', '{}', '{"state":"open"}']
    );
    assert.equal(messages[1].tool_calls[0].function.arguments, '', 'caller history untouched');
  });
}

test('[or] a replayed tool call without arguments is sent as "{}"', async () => {
  const body = await requestBody(
    'or',
    historyWithToolCalls(['', ' ', '{"state":"open"}']),
    sseResponse([{ type: 'response.completed', response: { status: 'completed', output: [] } }])
  );
  const calls = body.input.filter(item => item.type === 'function_call');
  assert.deepEqual(
    calls.map(c => c.arguments),
    ['{}', '{}', '{"state":"open"}']
  );
});
