/**
 * Test OpenAI Responses API message formatting for tool calls
 * Verifies that assistant messages with tool_calls are converted to function_call format
 */

import adapter from '../adapters/openai-responses.js';
import assert from 'assert';

console.log('Testing OpenAI Responses API message formatting for tool calls...\n');

// Test 1: Assistant message with tool_calls converted to function_call
console.log('Test 1: Assistant message with tool_calls converted to function_call...');
const messages1 = [
  {
    role: 'user',
    content: 'What is the weather?'
  },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_123',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"Paris"}'
        }
      }
    ]
  }
];

const formatted1 = adapter.formatMessages(messages1);
console.log('Formatted messages:', JSON.stringify(formatted1, null, 2));

assert.strictEqual(formatted1.length, 2, 'Should have 2 items');
assert.strictEqual(formatted1[0].role, 'user', 'First message should be user');
assert.strictEqual(formatted1[1].type, 'function_call', 'Second item should be function_call');
assert.strictEqual(formatted1[1].call_id, 'call_123', 'Should have call_id');
assert.strictEqual(formatted1[1].name, 'get_weather', 'Should have function name');
assert.strictEqual(formatted1[1].arguments, '{"location":"Paris"}', 'Should have arguments');
assert.strictEqual(formatted1[1].hasOwnProperty('role'), false, 'function_call should not have role');
console.log('✓ Test 1 passed: assistant with tool_calls converted to function_call\n');

// Test 2: Multiple tool calls result in multiple function_call objects
console.log('Test 2: Multiple tool calls...');
const messages2 = [
  {
    role: 'user',
    content: 'Check weather in Paris and London'
  },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_456',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"Paris"}'
        }
      },
      {
        id: 'call_457',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"London"}'
        }
      }
    ]
  }
];

const formatted2 = adapter.formatMessages(messages2);
console.log('Formatted messages:', JSON.stringify(formatted2, null, 2));

assert.strictEqual(formatted2.length, 3, 'Should have 3 items (1 user + 2 function_calls)');
assert.strictEqual(formatted2[1].type, 'function_call', 'Second item should be function_call');
assert.strictEqual(formatted2[1].call_id, 'call_456', 'Should have first call_id');
assert.strictEqual(formatted2[2].type, 'function_call', 'Third item should be function_call');
assert.strictEqual(formatted2[2].call_id, 'call_457', 'Should have second call_id');
console.log('✓ Test 2 passed: multiple tool_calls converted correctly\n');

// Test 3: Regular assistant message without tool_calls
console.log('Test 3: Regular assistant message without tool_calls...');
const messages3 = [
  {
    role: 'user',
    content: 'Hello'
  },
  {
    role: 'assistant',
    content: 'Hi there! How can I help you?'
  }
];

const formatted3 = adapter.formatMessages(messages3);
console.log('Formatted messages:', JSON.stringify(formatted3, null, 2));

assert.strictEqual(formatted3.length, 2, 'Should have 2 messages');
assert.strictEqual(formatted3[1].role, 'assistant', 'Second message should be assistant');
assert.strictEqual(
  formatted3[1].content,
  'Hi there! How can I help you?',
  'Assistant content should be preserved'
);
console.log('✓ Test 3 passed: regular assistant message preserved\n');

// Test 4: Tool result message converted to function_call_output
console.log('Test 4: Tool result message converted to function_call_output...');
const messages4 = [
  {
    role: 'user',
    content: 'What is the weather?'
  },
  {
    role: 'assistant',
    tool_calls: [
      {
        id: 'call_abc',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"Tokyo"}'
        }
      }
    ]
  },
  {
    role: 'tool',
    tool_call_id: 'call_abc',
    content: 'The weather in Tokyo is sunny, 25°C'
  }
];

const formatted4 = adapter.formatMessages(messages4);
console.log('Formatted messages:', JSON.stringify(formatted4, null, 2));

assert.strictEqual(formatted4.length, 3, 'Should have 3 items');
// First: user message
assert.strictEqual(formatted4[0].role, 'user', 'First should be user');
// Second: function_call
assert.strictEqual(formatted4[1].type, 'function_call', 'Second should be function_call');
assert.strictEqual(formatted4[1].call_id, 'call_abc', 'Should have call_id');
assert.strictEqual(formatted4[1].name, 'get_weather', 'Should have function name');
// Third: function_call_output
assert.strictEqual(formatted4[2].type, 'function_call_output', 'Third should be function_call_output');
assert.strictEqual(formatted4[2].call_id, 'call_abc', 'Should have matching call_id');
assert.strictEqual(
  formatted4[2].output,
  'The weather in Tokyo is sunny, 25°C',
  'Should have output field'
);
assert.strictEqual(formatted4[2].hasOwnProperty('role'), false, 'function_call_output should not have role');
console.log('✓ Test 4 passed: complete tool calling flow formatted correctly\n');

console.log('✅ All message formatting tests passed!');
console.log('\nKey findings:');
console.log('- Assistant messages with tool_calls: converted to function_call objects');
console.log('- Tool result messages: converted to function_call_output objects');
console.log('- Regular assistant messages: preserved as-is');
console.log('- Format matches OpenAI Responses API specification');
