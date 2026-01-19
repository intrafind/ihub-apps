/**
 * Test OpenAI Responses API message formatting for tool calls
 * Verifies that assistant messages with tool_calls don't have content: null
 */

import adapter from '../adapters/openai-responses.js';
import assert from 'assert';

console.log('Testing OpenAI Responses API message formatting for tool calls...\n');

// Test 1: Assistant message with tool_calls should not have content field
console.log('Test 1: Assistant message with tool_calls and no content...');
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

assert.strictEqual(formatted1.length, 2, 'Should have 2 messages');
assert.strictEqual(formatted1[1].role, 'assistant', 'Second message should be assistant');
assert.strictEqual(
  formatted1[1].hasOwnProperty('content'),
  false,
  'Assistant message with tool_calls should NOT have content field'
);
assert.strictEqual(
  Array.isArray(formatted1[1].tool_calls),
  true,
  'Should have tool_calls array'
);
console.log('✓ Test 1 passed: content field omitted when tool_calls present\n');

// Test 2: Assistant message with tool_calls and empty string content
console.log('Test 2: Assistant message with tool_calls and empty string content...');
const messages2 = [
  {
    role: 'user',
    content: 'Search the web'
  },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_456',
        type: 'function',
        function: {
          name: 'search_web',
          arguments: '{"query":"test"}'
        }
      }
    ]
  }
];

const formatted2 = adapter.formatMessages(messages2);
console.log('Formatted messages:', JSON.stringify(formatted2, null, 2));

assert.strictEqual(
  formatted2[1].hasOwnProperty('content'),
  false,
  'Assistant message with empty content and tool_calls should NOT have content field'
);
console.log('✓ Test 2 passed: empty content omitted when tool_calls present\n');

// Test 3: Assistant message with tool_calls and actual content
console.log('Test 3: Assistant message with tool_calls AND content text...');
const messages3 = [
  {
    role: 'user',
    content: 'Get weather'
  },
  {
    role: 'assistant',
    content: 'Let me check the weather for you.',
    tool_calls: [
      {
        id: 'call_789',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"London"}'
        }
      }
    ]
  }
];

const formatted3 = adapter.formatMessages(messages3);
console.log('Formatted messages:', JSON.stringify(formatted3, null, 2));

assert.strictEqual(
  formatted3[1].hasOwnProperty('content'),
  true,
  'Assistant message with tool_calls AND content text should have content field'
);
assert.strictEqual(
  formatted3[1].content,
  'Let me check the weather for you.',
  'Content should be preserved'
);
console.log('✓ Test 3 passed: content preserved when both tool_calls and content present\n');

// Test 4: Regular assistant message without tool_calls
console.log('Test 4: Regular assistant message without tool_calls...');
const messages4 = [
  {
    role: 'user',
    content: 'Hello'
  },
  {
    role: 'assistant',
    content: 'Hi there! How can I help you?'
  }
];

const formatted4 = adapter.formatMessages(messages4);
console.log('Formatted messages:', JSON.stringify(formatted4, null, 2));

assert.strictEqual(
  formatted4[1].hasOwnProperty('content'),
  true,
  'Regular assistant message should have content field'
);
assert.strictEqual(
  formatted4[1].content,
  'Hi there! How can I help you?',
  'Content should match'
);
console.log('✓ Test 4 passed: regular message content preserved\n');

// Test 5: Tool result message converted to function_call_output format
console.log('Test 5: Tool result message converted to function_call_output...');
const messages5 = [
  {
    role: 'user',
    content: 'What is the weather?'
  },
  {
    role: 'assistant',
    content: null,
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

const formatted5 = adapter.formatMessages(messages5);
console.log('Formatted messages:', JSON.stringify(formatted5, null, 2));

assert.strictEqual(formatted5.length, 3, 'Should have 3 messages');
assert.strictEqual(
  formatted5[1].hasOwnProperty('content'),
  false,
  'Assistant with tool_calls should not have content'
);
// Tool result should be converted to function_call_output format
assert.strictEqual(formatted5[2].type, 'function_call_output', 'Tool result should have type: function_call_output');
assert.strictEqual(
  formatted5[2].call_id,
  'call_abc',
  'Should have call_id field'
);
assert.strictEqual(
  formatted5[2].output,
  'The weather in Tokyo is sunny, 25°C',
  'Tool result should be in output field, not content'
);
assert.strictEqual(
  formatted5[2].hasOwnProperty('role'),
  false,
  'function_call_output should not have role field'
);
console.log('✓ Test 5 passed: tool result converted to function_call_output format\n');

console.log('✅ All message formatting tests passed!');
console.log('\nKey findings:');
console.log('- Assistant messages with tool_calls and no/empty content: content field OMITTED');
console.log('- Assistant messages with tool_calls AND content text: content field INCLUDED');
console.log('- Tool result messages: converted to type: "function_call_output" with output field');
console.log('- This matches the OpenAI Responses API format requirements');
