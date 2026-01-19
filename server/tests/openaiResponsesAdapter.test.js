import assert from 'assert';
import OpenAIResponsesAdapter from '../adapters/openai-responses.js';

// Test basic adapter functionality
const model = {
  modelId: 'gpt-5',
  url: 'https://api.openai.com/v1/responses',
  provider: 'openai-responses'
};

// Test 1: Basic message formatting
console.log('Test 1: Basic message formatting...');
const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello!' }
];

const req = OpenAIResponsesAdapter.createCompletionRequest(model, messages, 'test-key', {
  stream: true
});

// Verify endpoint
assert.strictEqual(req.url, 'https://api.openai.com/v1/responses', 'URL should be /v1/responses');

// Verify instructions are separated
assert.strictEqual(
  req.body.instructions,
  'You are a helpful assistant.',
  'System message should be in instructions'
);

// Verify input contains only user message
assert.strictEqual(
  req.body.input,
  'Hello!',
  'Input should be simplified to string for single user message'
);

// Verify store is true by default
assert.strictEqual(req.body.store, true, 'Store should be true by default');

// Verify max_output_tokens is used (not max_tokens)
assert.strictEqual(req.body.max_output_tokens, 1024, 'Should use max_output_tokens parameter');
assert.strictEqual(req.body.max_tokens, undefined, 'Should not have max_tokens parameter');

console.log('✓ Test 1 passed: Basic message formatting works correctly');

// Test 2: Multiple user messages
console.log('\nTest 2: Multiple user messages...');
const multipleMessages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello!' },
  { role: 'assistant', content: 'Hi there!' },
  { role: 'user', content: 'How are you?' }
];

const req2 = OpenAIResponsesAdapter.createCompletionRequest(model, multipleMessages, 'test-key', {
  stream: true
});

// Verify input is an array when multiple messages
assert.ok(Array.isArray(req2.body.input), 'Input should be array for multiple messages');
assert.strictEqual(req2.body.input.length, 3, 'Input should have 3 messages (excluding system)');

console.log('✓ Test 2 passed: Multiple messages handled correctly');

// Test 3: Structured output
console.log('\nTest 3: Structured output...');
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' }
  },
  required: ['name', 'age']
};

const req3 = OpenAIResponsesAdapter.createCompletionRequest(
  model,
  [{ role: 'user', content: 'Extract person info' }],
  'test-key',
  { responseSchema: schema }
);

// Verify text.format is used instead of response_format
assert.ok(req3.body.text, 'Should have text field');
assert.ok(req3.body.text.format, 'Should have text.format field');
assert.strictEqual(req3.body.text.format.type, 'json_schema', 'Format type should be json_schema');
assert.ok(req3.body.text.format.schema, 'Should have schema');

console.log('✓ Test 3 passed: Structured output uses text.format');

// Test 4: Response processing
console.log('\nTest 4: Response processing...');

// Test non-streaming response
const nonStreamingResponse = JSON.stringify({
  id: 'resp_123',
  object: 'response',
  model: 'gpt-5',
  output: [
    {
      id: 'msg_123',
      type: 'message',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Hello! How can I help you today?'
        }
      ],
      role: 'assistant'
    }
  ],
  status: 'completed'
});

const result = OpenAIResponsesAdapter.processResponseBuffer(nonStreamingResponse);
assert.strictEqual(result.content.length, 1, 'Should have one content item');
assert.strictEqual(
  result.content[0],
  'Hello! How can I help you today?',
  'Content should be extracted correctly'
);
assert.strictEqual(result.complete, true, 'Response should be complete');

console.log('✓ Test 4 passed: Response processing works correctly');

// Test 5: Tool calls in response
console.log('\nTest 5: Tool calls processing...');

const toolCallResponse = JSON.stringify({
  id: 'resp_456',
  object: 'response',
  output: [
    {
      id: 'call_123',
      type: 'function_call',
      function: {
        name: 'get_weather',
        arguments: '{"location":"San Francisco"}'
      }
    }
  ],
  status: 'completed'
});

const result2 = OpenAIResponsesAdapter.processResponseBuffer(toolCallResponse);
assert.strictEqual(result2.tool_calls.length, 1, 'Should have one tool call');
assert.strictEqual(result2.tool_calls[0].function.name, 'get_weather', 'Tool name should match');
assert.strictEqual(result2.complete, true, 'Response should be complete');

console.log('✓ Test 5 passed: Tool calls processed correctly');

console.log('\n✅ All OpenAI Responses adapter tests passed!');
