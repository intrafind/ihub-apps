/**
 * Test finish reason handling for OpenAI Responses API
 * This test verifies that tool calls are correctly detected and finish reason is set appropriately
 */

import { convertOpenaiResponsesResponseToGeneric } from '../adapters/toolCalling/OpenAIResponsesConverter.js';
import assert from 'assert';

console.log('Testing OpenAI Responses API finish reason handling...\n');

// Test 1: Non-streaming response with tool calls
console.log('Test 1: Non-streaming response with tool calls...');
const toolCallResponse = JSON.stringify({
  id: 'resp_123',
  object: 'response',
  output: [
    {
      id: 'call_abc',
      type: 'function_call',
      function: {
        name: 'get_weather',
        arguments: '{"location":"San Francisco"}'
      }
    }
  ],
  status: 'completed'
});

const result1 = convertOpenaiResponsesResponseToGeneric(toolCallResponse);
assert.strictEqual(result1.tool_calls.length, 1, 'Should have one tool call');
assert.strictEqual(
  result1.tool_calls[0].name,
  'get_weather',
  'Tool name should be get_weather'
);
assert.strictEqual(result1.finishReason, 'tool_calls', 'Finish reason should be tool_calls');
assert.strictEqual(result1.complete, true, 'Response should be complete');
console.log('✓ Test 1 passed: Tool calls detected, finish reason = tool_calls\n');

// Test 2: Non-streaming response without tool calls
console.log('Test 2: Non-streaming response without tool calls...');
const normalResponse = JSON.stringify({
  id: 'resp_456',
  object: 'response',
  output: [
    {
      id: 'msg_123',
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Hello! How can I help you today?'
        }
      ]
    }
  ],
  status: 'completed'
});

const result2 = convertOpenaiResponsesResponseToGeneric(normalResponse);
assert.strictEqual(result2.content.length, 1, 'Should have one content item');
assert.strictEqual(result2.tool_calls.length, 0, 'Should have no tool calls');
assert.strictEqual(result2.finishReason, 'stop', 'Finish reason should be stop');
assert.strictEqual(result2.complete, true, 'Response should be complete');
console.log('✓ Test 2 passed: No tool calls, finish reason = stop\n');

// Test 3: Streaming completion event with tool calls
console.log('Test 3: Streaming completion event with tool calls...');
const streamingCompletionWithTools = JSON.stringify({
  type: 'response.completed',
  response: {
    id: 'resp_789',
    output: [
      {
        id: 'call_xyz',
        type: 'function_call',
        function: {
          name: 'search_web',
          arguments: '{"query":"latest news"}'
        }
      }
    ]
  }
});

const result3 = convertOpenaiResponsesResponseToGeneric(streamingCompletionWithTools);
assert.strictEqual(result3.complete, true, 'Response should be complete');
assert.strictEqual(
  result3.finishReason,
  'tool_calls',
  'Finish reason should be tool_calls for streaming completion with tools'
);
console.log('✓ Test 3 passed: Streaming completion with tools, finish reason = tool_calls\n');

// Test 4: Streaming completion event without tool calls
console.log('Test 4: Streaming completion event without tool calls...');
const streamingCompletionNoTools = JSON.stringify({
  type: 'response.completed',
  response: {
    id: 'resp_012',
    output: [
      {
        id: 'msg_456',
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Response text'
          }
        ]
      }
    ]
  }
});

const result4 = convertOpenaiResponsesResponseToGeneric(streamingCompletionNoTools);
assert.strictEqual(result4.complete, true, 'Response should be complete');
assert.strictEqual(
  result4.finishReason,
  'stop',
  'Finish reason should be stop for streaming completion without tools'
);
console.log('✓ Test 4 passed: Streaming completion without tools, finish reason = stop\n');

// Test 5: Multiple tool calls in output
console.log('Test 5: Multiple tool calls in output...');
const multipleToolCalls = JSON.stringify({
  id: 'resp_multi',
  object: 'response',
  output: [
    {
      id: 'call_1',
      type: 'function_call',
      function: {
        name: 'get_weather',
        arguments: '{"location":"New York"}'
      }
    },
    {
      id: 'call_2',
      type: 'function_call',
      function: {
        name: 'get_weather',
        arguments: '{"location":"London"}'
      }
    }
  ],
  status: 'completed'
});

const result5 = convertOpenaiResponsesResponseToGeneric(multipleToolCalls);
assert.strictEqual(result5.tool_calls.length, 2, 'Should have two tool calls');
assert.strictEqual(result5.finishReason, 'tool_calls', 'Finish reason should be tool_calls');
assert.strictEqual(result5.complete, true, 'Response should be complete');
console.log('✓ Test 5 passed: Multiple tool calls detected, finish reason = tool_calls\n');

// Test 6: Mixed output (message + tool call)
console.log('Test 6: Mixed output (message + tool call)...');
const mixedOutput = JSON.stringify({
  id: 'resp_mixed',
  object: 'response',
  output: [
    {
      id: 'msg_1',
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Let me check the weather for you.'
        }
      ]
    },
    {
      id: 'call_3',
      type: 'function_call',
      function: {
        name: 'get_weather',
        arguments: '{"location":"Tokyo"}'
      }
    }
  ],
  status: 'completed'
});

const result6 = convertOpenaiResponsesResponseToGeneric(mixedOutput);
assert.strictEqual(result6.content.length, 1, 'Should have one content item');
assert.strictEqual(result6.tool_calls.length, 1, 'Should have one tool call');
assert.strictEqual(
  result6.finishReason,
  'tool_calls',
  'Finish reason should be tool_calls when any tool calls are present'
);
assert.strictEqual(result6.complete, true, 'Response should be complete');
console.log('✓ Test 6 passed: Mixed output with tool calls, finish reason = tool_calls\n');

console.log('✅ All finish reason tests passed!');
console.log(
  '\nKey insight: The Responses API does NOT include a finish_reason field.'
);
console.log('We determine finish reason by checking if tool calls are present in the output.');
