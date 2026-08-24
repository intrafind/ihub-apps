/**
 * Regression test for #1722: Google streaming emitted the same tool_calls index (0)
 * for every chunk because GoogleConverter derived it from result.tool_calls.length,
 * which resets to 0 on every fresh streaming chunk. When Gemini splits parallel
 * function calls across separate SSE chunks, ToolExecutor's dedup-by-index merge
 * (collectedToolCalls.find(c => c.index === call.index)) then collided the second
 * call into the first, concatenating JSON arguments into an invalid '{...}{...}'
 * blob and silently dropping a tool call.
 */

import assert from 'assert';
import {
  convertGoogleResponseToGeneric,
  clearGoogleStreamingState
} from '../adapters/toolCalling/GoogleConverter.js';
import logger from '../utils/logger.js';

logger.info('Testing Google parallel tool call streaming indices...\n');

const STREAM_ID = 'chat-1722';

function chunkWithFunctionCall(name, args) {
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name, args } }]
        }
      }
    ]
  });
}

const finishChunk = JSON.stringify({ candidates: [{ finishReason: 'STOP' }] });

// Test 1: two parallel tool calls arriving in separate streaming chunks must get
// distinct, monotonically increasing indices instead of both landing on 0.
logger.info('Test 1: parallel tool calls in separate chunks get distinct indices');
const chunk1 = await convertGoogleResponseToGeneric(
  chunkWithFunctionCall('webSearch', { query: 'first query' }),
  STREAM_ID
);
const chunk2 = await convertGoogleResponseToGeneric(
  chunkWithFunctionCall('webContentExtractor', { url: 'https://example.com' }),
  STREAM_ID
);

assert.strictEqual(chunk1.tool_calls.length, 1, 'Chunk 1 should have one tool call');
assert.strictEqual(chunk2.tool_calls.length, 1, 'Chunk 2 should have one tool call');
assert.strictEqual(chunk1.tool_calls[0].index, 0, 'First call should get index 0');
assert.strictEqual(chunk2.tool_calls[0].index, 1, 'Second call should get index 1, not 0');
logger.info('✓ Test 1 passed\n');

// Test 2: simulate ToolExecutor's dedup-by-index merge to prove both tool calls
// survive independently with valid, non-concatenated JSON arguments.
logger.info('Test 2: simulated ToolExecutor merge keeps both calls intact');
const collectedToolCalls = [];
for (const result of [chunk1, chunk2]) {
  for (const call of result.tool_calls) {
    const existingCall = collectedToolCalls.find(c => c.index === call.index);
    if (existingCall) {
      existingCall.function.arguments += call.function.arguments;
    } else {
      collectedToolCalls.push({
        index: call.index,
        id: call.id,
        function: { name: call.function.name, arguments: call.function.arguments }
      });
    }
  }
}

assert.strictEqual(collectedToolCalls.length, 2, 'Both tool calls should survive the merge');
for (const call of collectedToolCalls) {
  assert.doesNotThrow(
    () => JSON.parse(call.function.arguments),
    `Arguments for ${call.function.name} should be valid JSON`
  );
}
assert.strictEqual(collectedToolCalls[0].function.name, 'webSearch');
assert.strictEqual(collectedToolCalls[1].function.name, 'webContentExtractor');
logger.info('✓ Test 2 passed\n');

// Test 3: once the stream completes, state is cleared so a new stream reusing the
// same streamId value restarts its index counter at 0 instead of leaking forever.
logger.info('Test 3: index counter resets after stream completion');
await convertGoogleResponseToGeneric(finishChunk, STREAM_ID);
const freshChunk = await convertGoogleResponseToGeneric(
  chunkWithFunctionCall('webSearch', { query: 'new stream' }),
  STREAM_ID
);
assert.strictEqual(
  freshChunk.tool_calls[0].index,
  0,
  'A new stream reusing the same streamId should restart at index 0'
);
logger.info('✓ Test 3 passed\n');

clearGoogleStreamingState(STREAM_ID);

logger.info('All parallel tool call tests passed! ✓');
