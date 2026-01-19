/**
 * Test OpenAI Responses API streaming function call events
 * Verifies handling of response.output_item.added, response.function_call_arguments.delta,
 * and response.function_call_arguments.done events
 */

import { convertOpenaiResponsesResponseToGeneric } from '../adapters/toolCalling/OpenAIResponsesConverter.js';
import assert from 'assert';

console.log('Testing OpenAI Responses API streaming function call events...\n');

// Test 1: Handle response.output_item.added event
console.log('Test 1: response.output_item.added event creates function call...');
const outputItemAdded = JSON.stringify({
  type: 'response.output_item.added',
  sequence_number: 4,
  output_index: 1,
  item: {
    id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
    type: 'function_call',
    status: 'in_progress',
    arguments: '',
    call_id: 'call_FhLW7AYO3AaZAnbwhQFufUVb',
    name: 'enhancedWebSearch'
  }
});

const result1 = convertOpenaiResponsesResponseToGeneric(outputItemAdded);
console.log('Result:', JSON.stringify(result1, null, 2));

assert.strictEqual(result1.tool_calls.length, 1, 'Should have one tool call');
assert.strictEqual(
  result1.tool_calls[0].name,
  'enhancedWebSearch',
  'Tool name should be enhancedWebSearch'
);
assert.strictEqual(
  result1.tool_calls[0].id,
  'call_FhLW7AYO3AaZAnbwhQFufUVb',
  'Tool call ID should match'
);
console.log('✓ Test 1 passed: output_item.added event handled\n');

// Test 2: Handle response.function_call_arguments.delta event
console.log('Test 2: response.function_call_arguments.delta accumulates arguments...');
const argsDelta1 = JSON.stringify({
  type: 'response.function_call_arguments.delta',
  sequence_number: 5,
  item_id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
  output_index: 1,
  delta: '{"',
  obfuscation: 'cgTGTkb7HTn02V'
});

const result2 = convertOpenaiResponsesResponseToGeneric(argsDelta1);
console.log('Result:', JSON.stringify(result2, null, 2));

assert.strictEqual(result2.tool_calls.length, 1, 'Should have one tool call delta');
assert.strictEqual(result2.tool_calls[0].arguments.__raw_arguments, '{"', 'Should have delta');
console.log('✓ Test 2 passed: arguments.delta event handled\n');

// Test 3: Handle response.function_call_arguments.done event
console.log('Test 3: response.function_call_arguments.done provides complete arguments...');
const argsDone = JSON.stringify({
  type: 'response.function_call_arguments.done',
  sequence_number: 31,
  item_id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
  output_index: 1,
  arguments:
    '{"query":"IntraFind iHub Produkt","extractContent":true,"maxResults":3,"contentMaxLength":3000}'
});

const result3 = convertOpenaiResponsesResponseToGeneric(argsDone);
console.log('Result:', JSON.stringify(result3, null, 2));

assert.strictEqual(result3.tool_calls.length, 1, 'Should have one tool call');
const parsedArgs = result3.tool_calls[0].arguments;
assert.strictEqual(parsedArgs.query, 'IntraFind iHub Produkt', 'Should have parsed query');
assert.strictEqual(parsedArgs.extractContent, true, 'Should have parsed extractContent');
assert.strictEqual(parsedArgs.maxResults, 3, 'Should have parsed maxResults');
assert.strictEqual(parsedArgs.contentMaxLength, 3000, 'Should have parsed contentMaxLength');
console.log('✓ Test 3 passed: arguments.done event handled\n');

// Test 4: Handle response.output_item.done event (final complete function call)
console.log('Test 4: response.output_item.done provides complete function call with name...');
const outputItemDone = JSON.stringify({
  type: 'response.output_item.done',
  sequence_number: 32,
  output_index: 1,
  item: {
    id: 'fc_09ff245f403efcad00696eb1a26108819784ef8f47bda30f79',
    type: 'function_call',
    status: 'completed',
    arguments:
      '{"query":"Intrafind iHub","extractContent":true,"maxResults":3,"contentMaxLength":3000}',
    call_id: 'call_Uy1WdAKT2ZA4beABlIYCjLR2',
    name: 'enhancedWebSearch'
  }
});

const result4 = convertOpenaiResponsesResponseToGeneric(outputItemDone);
console.log('Result:', JSON.stringify(result4, null, 2));

assert.strictEqual(result4.tool_calls.length, 1, 'Should have one complete tool call');
assert.strictEqual(
  result4.tool_calls[0].name,
  'enhancedWebSearch',
  'Should have function name from output_item.done'
);
assert.strictEqual(
  result4.tool_calls[0].id,
  'call_Uy1WdAKT2ZA4beABlIYCjLR2',
  'Should have correct call_id'
);
const parsedArgs4 = result4.tool_calls[0].arguments;
assert.strictEqual(parsedArgs4.query, 'Intrafind iHub', 'Should have parsed query');
assert.strictEqual(parsedArgs4.extractContent, true, 'Should have parsed extractContent');
console.log('✓ Test 4 passed: output_item.done event provides complete function call\n');

// Test 5: Simulate full streaming sequence
console.log('Test 5: Full streaming sequence from user logs...');

const events = [
  {
    type: 'response.output_item.added',
    sequence_number: 4,
    output_index: 1,
    item: {
      id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
      type: 'function_call',
      status: 'in_progress',
      arguments: '',
      call_id: 'call_FhLW7AYO3AaZAnbwhQFufUVb',
      name: 'enhancedWebSearch'
    }
  },
  {
    type: 'response.function_call_arguments.delta',
    sequence_number: 5,
    item_id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
    output_index: 1,
    delta: '{"'
  },
  {
    type: 'response.function_call_arguments.delta',
    sequence_number: 6,
    item_id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
    output_index: 1,
    delta: 'query'
  },
  {
    type: 'response.function_call_arguments.delta',
    sequence_number: 7,
    item_id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
    output_index: 1,
    delta: '":"'
  },
  {
    type: 'response.function_call_arguments.done',
    sequence_number: 31,
    item_id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
    output_index: 1,
    arguments:
      '{"query":"IntraFind iHub Produkt","extractContent":true,"maxResults":3,"contentMaxLength":3000}'
  },
  {
    type: 'response.output_item.done',
    sequence_number: 32,
    output_index: 1,
    item: {
      id: 'fc_02939ee9e3d1d59900696eaf1bed40819588e8b9ba1828005b',
      type: 'function_call',
      status: 'completed',
      arguments:
        '{"query":"IntraFind iHub Produkt","extractContent":true,"maxResults":3,"contentMaxLength":3000}',
      call_id: 'call_FhLW7AYO3AaZAnbwhQFufUVb',
      name: 'enhancedWebSearch'
    }
  }
];

console.log('Processing streaming events...');
const results = events.map(event => convertOpenaiResponsesResponseToGeneric(JSON.stringify(event)));

// Verify first event (output_item.added)
assert.strictEqual(
  results[0].tool_calls.length,
  1,
  'First event should create function call'
);
assert.strictEqual(
  results[0].tool_calls[0].name,
  'enhancedWebSearch',
  'Should have correct name'
);

// Verify delta events create tool call chunks
assert.strictEqual(results[1].tool_calls.length, 1, 'Delta events should create chunks');
assert.strictEqual(results[2].tool_calls.length, 1, 'Delta events should create chunks');

// Verify done event has complete arguments
assert.strictEqual(
  results[4].tool_calls.length,
  1,
  'Done event should have complete arguments'
);
assert.strictEqual(
  results[4].tool_calls[0].arguments.query,
  'IntraFind iHub Produkt',
  'Should have complete parsed arguments'
);

// Verify output_item.done has both name and complete arguments
assert.strictEqual(
  results[5].tool_calls.length,
  1,
  'output_item.done should have complete function call'
);
assert.strictEqual(
  results[5].tool_calls[0].name,
  'enhancedWebSearch',
  'output_item.done should have function name'
);
assert.strictEqual(
  results[5].tool_calls[0].arguments.query,
  'IntraFind iHub Produkt',
  'output_item.done should have complete parsed arguments'
);

console.log('✓ Test 5 passed: Full streaming sequence handled correctly\n');

console.log('✅ All streaming function call tests passed!');
console.log('\nSupported streaming events:');
console.log('1. response.output_item.added - Function call initialization');
console.log('2. response.function_call_arguments.delta - Streaming arguments');
console.log('3. response.function_call_arguments.done - Complete arguments');
console.log('4. response.output_item.done - Final complete function call with name');
