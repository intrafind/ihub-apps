// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// node --test "tests/load/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TOOL_ROUNDS, toolCallFor, toolMarker } from './stubTools.mjs';

const tools = [{ type: 'function', function: { name: 'list_scheduled_tasks' } }];
const user = content => ({ role: 'user', content });
const toolResult = id => ({ role: 'tool', tool_call_id: id, content: '{"count":0}' });
const assistantCall = id => ({ role: 'assistant', content: null, tool_calls: [{ id }] });

test('a marker for an offered tool gives a tool call; the round is read off the request', () => {
  const ask = user(`What is planned? ${toolMarker('list_scheduled_tasks', 2)}`);
  assert.deepEqual(toolCallFor({ tools, messages: [ask] }), {
    name: 'list_scheduled_tasks',
    round: 1,
    rounds: 2,
    id: 'call_lt_1'
  });
  const afterOne = [ask, assistantCall('call_lt_1'), toolResult('call_lt_1')];
  assert.deepEqual(toolCallFor({ tools, messages: afterOne }), {
    name: 'list_scheduled_tasks',
    round: 2,
    rounds: 2,
    id: 'call_lt_2'
  });
  const afterTwo = [...afterOne, assistantCall('call_lt_2'), toolResult('call_lt_2')];
  assert.equal(toolCallFor({ tools, messages: afterTwo }), null, 'now the model answers');
});

test('the rounds of an earlier turn do not count for the next one', () => {
  const messages = [
    user(toolMarker('list_scheduled_tasks', 1)),
    assistantCall('call_lt_1'),
    toolResult('call_lt_1'),
    { role: 'assistant', content: 'Nothing is planned.' },
    user(`And now? ${toolMarker('list_scheduled_tasks', 1)}`)
  ];
  assert.equal(toolCallFor({ tools, messages }).round, 1);
});

test('no marker, a tool the request does not offer, or no user message: a text answer', () => {
  assert.equal(toolCallFor({ tools, messages: [user('Hello')] }), null);
  assert.equal(
    toolCallFor({ tools: [], messages: [user(toolMarker('list_scheduled_tasks'))] }),
    null
  );
  assert.equal(toolCallFor({ messages: [user(toolMarker('list_scheduled_tasks'))] }), null);
  assert.equal(toolCallFor({ tools, messages: [user(toolMarker('another_tool'))] }), null);
  assert.equal(toolCallFor({ tools, messages: [{ role: 'system', content: 'x' }] }), null);
  assert.equal(toolCallFor({}), null);
  assert.equal(toolCallFor(null), null);
});

test('the marker is found in a message made of parts, and without a round count', () => {
  const parts = user([{ type: 'text', text: 'Please check. lt-tool:list_scheduled_tasks' }]);
  assert.deepEqual(toolCallFor({ tools, messages: [parts] }), {
    name: 'list_scheduled_tasks',
    round: 1,
    rounds: 1,
    id: 'call_lt_1'
  });
});

test('the number of rounds is kept between 1 and the maximum', () => {
  const rounds = marker => toolCallFor({ tools, messages: [user(marker)] }).rounds;
  assert.equal(rounds('lt-tool:list_scheduled_tasks:0'), 1);
  assert.equal(rounds('lt-tool:list_scheduled_tasks:99'), MAX_TOOL_ROUNDS);
  assert.equal(toolMarker('list_scheduled_tasks'), 'lt-tool:list_scheduled_tasks:1');
});
