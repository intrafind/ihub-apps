/**
 * Regression tests for the "empty answer from Gemini" bug.
 *
 * Gemini (especially with thinking enabled) intermittently returns
 * finishReason: "MALFORMED_FUNCTION_CALL" with an empty candidate — most often
 * on a resend. Previously this reached the client as a clean, empty answer.
 *
 * These tests cover:
 *   1. The shared FAILURE_FINISH_REASONS / isFailureFinishReason helpers.
 *   2. GoogleAdapter.processResponseBuffer surfacing an error (not a silent
 *      empty answer) for a degenerate MALFORMED_FUNCTION_CALL response, while
 *      leaving normal responses untouched.
 *   3. The streaming converter marking such a chunk complete with the raw
 *      failure reason so StreamingHandler can turn it into an error.
 *   4. The RequestBuilder prevention notice that stops the model from being
 *      told to use a web search tool that isn't in the request.
 */

import assert from 'assert';
import GoogleAdapter from '../adapters/google.js';
import { convertGoogleResponseToGeneric } from '../adapters/toolCalling/GoogleConverter.js';
import {
  isFailureFinishReason,
  FAILURE_FINISH_REASONS
} from '../adapters/toolCalling/GenericToolCalling.js';
import { appendWebSearchDisabledNotice } from '../services/chat/RequestBuilder.js';

console.log('Testing Gemini MALFORMED_FUNCTION_CALL empty-answer handling...\n');

// --- 1. Failure finish reason helpers ---------------------------------------
assert.strictEqual(
  isFailureFinishReason('MALFORMED_FUNCTION_CALL'),
  true,
  'MALFORMED_FUNCTION_CALL must be treated as a failure reason'
);
assert.strictEqual(
  isFailureFinishReason('malformed_function_call'),
  true,
  'Failure reason match must be case-insensitive'
);
assert.strictEqual(isFailureFinishReason('STOP'), false, 'STOP is not a failure reason');
assert.strictEqual(
  isFailureFinishReason('MAX_TOKENS'),
  false,
  'MAX_TOKENS is not a failure reason'
);
assert.strictEqual(
  isFailureFinishReason('tool_calls'),
  false,
  'tool_calls is not a failure reason'
);
assert.strictEqual(isFailureFinishReason(null), false, 'null is not a failure reason');
assert.ok(FAILURE_FINISH_REASONS.has('OTHER'), 'OTHER should be in the failure set');
console.log('✓ Test 1 passed: failure finish reason helpers behave correctly\n');

// --- 2. Degenerate MALFORMED_FUNCTION_CALL response → error ------------------
const malformedResponse = JSON.stringify({
  candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', index: 0 }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 }
});
const malformed = await GoogleAdapter.processResponseBuffer(malformedResponse);
assert.strictEqual(
  malformed.complete,
  true,
  'Malformed response must terminate the turn (complete)'
);
assert.strictEqual(malformed.error, true, 'Malformed empty response must be surfaced as an error');
assert.ok(
  typeof malformed.errorMessage === 'string' && malformed.errorMessage.length > 0,
  'A user-facing error message must be set'
);
assert.strictEqual(malformed.content.length, 0, 'There is no answer content');
assert.strictEqual(
  malformed.finishReason,
  'MALFORMED_FUNCTION_CALL',
  'The raw failure reason must be preserved'
);
console.log('✓ Test 2 passed: degenerate MALFORMED_FUNCTION_CALL surfaces an error\n');

// --- 3. Normal STOP response is unaffected -----------------------------------
const normalResponse = JSON.stringify({
  candidates: [
    {
      content: { parts: [{ text: 'Hello there!' }], role: 'model' },
      finishReason: 'STOP',
      index: 0
    }
  ]
});
const normal = await GoogleAdapter.processResponseBuffer(normalResponse);
assert.strictEqual(normal.error, false, 'Normal response must not be flagged as an error');
assert.strictEqual(normal.complete, true, 'Normal response should be complete');
assert.strictEqual(normal.finishReason, 'stop', 'Normal response maps to stop');
assert.deepStrictEqual(normal.content, ['Hello there!'], 'Content should be preserved');
console.log('✓ Test 3 passed: normal responses are not misclassified as errors\n');

// A MALFORMED reason that still carried usable text must NOT be an error.
const malformedWithText = JSON.stringify({
  candidates: [
    {
      content: { parts: [{ text: 'partial answer' }], role: 'model' },
      finishReason: 'MALFORMED_FUNCTION_CALL',
      index: 0
    }
  ]
});
const withText = await GoogleAdapter.processResponseBuffer(malformedWithText);
assert.strictEqual(
  withText.error,
  false,
  'A failure reason that still produced text must not be an error'
);
assert.deepStrictEqual(withText.content, ['partial answer'], 'Text content must be kept');
console.log('✓ Test 3b passed: failure reason with usable text is kept as an answer\n');

// --- 4. Streaming converter marks the terminal chunk complete + failure ------
const streamingMalformedChunk = JSON.stringify({
  candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', index: 0 }]
});
const streamResult = await convertGoogleResponseToGeneric(streamingMalformedChunk);
assert.strictEqual(streamResult.complete, true, 'Terminal chunk should complete the stream');
assert.strictEqual(
  streamResult.finishReason,
  'MALFORMED_FUNCTION_CALL',
  'Converter must pass the raw failure reason through so the handler can detect it'
);
assert.strictEqual(streamResult.content.length, 0, 'No content in the malformed chunk');
assert.ok(
  isFailureFinishReason(streamResult.finishReason),
  'Handler-side detection must recognise the passed-through finish reason'
);
console.log('✓ Test 4 passed: streaming converter reports a detectable failure completion\n');

// --- 5. Prevention: web-search-disabled system prompt notice -----------------
const appWithWebSearch = {
  id: 'web-chat',
  websearch: { enabled: true, enabledByDefault: false }
};

// Web search OFF (toggle not sent → falls back to enabledByDefault:false) →
// notice appended.
const messagesOff = [
  { role: 'system', content: 'Use the web search tool to answer.' },
  { role: 'user', content: 'Who is Daniel Manzke?' }
];
const appendedOff = appendWebSearchDisabledNotice(messagesOff, appWithWebSearch, undefined);
assert.strictEqual(appendedOff, true, 'Notice should be appended when web search is off');
assert.ok(
  /web search is currently turned off/i.test(messagesOff[0].content),
  'System prompt should contain the web-search-off notice'
);
assert.ok(
  messagesOff[0].content.startsWith('Use the web search tool to answer.'),
  'Original system prompt content must be preserved before the notice'
);

// Idempotent — appending twice does not duplicate the notice.
const before = messagesOff[0].content;
const appendedTwice = appendWebSearchDisabledNotice(messagesOff, appWithWebSearch, undefined);
assert.strictEqual(appendedTwice, false, 'Notice must not be appended a second time');
assert.strictEqual(messagesOff[0].content, before, 'System prompt must be unchanged on re-append');

// Web search ON (explicit toggle) → no notice.
const messagesOn = [
  { role: 'system', content: 'Use the web search tool to answer.' },
  { role: 'user', content: 'Latest news?' }
];
const appendedOn = appendWebSearchDisabledNotice(messagesOn, appWithWebSearch, true);
assert.strictEqual(appendedOn, false, 'No notice when web search is enabled for the turn');
assert.strictEqual(messagesOn[0].content, 'Use the web search tool to answer.', 'Prompt unchanged');

// App without web search configured → no notice.
const messagesNoWs = [{ role: 'system', content: 'You are helpful.' }];
const appendedNoWs = appendWebSearchDisabledNotice(messagesNoWs, { id: 'plain' }, undefined);
assert.strictEqual(appendedNoWs, false, 'No notice for apps without web search');
console.log('✓ Test 5 passed: web-search-disabled notice is applied only when appropriate\n');

console.log('✅ All Gemini MALFORMED_FUNCTION_CALL tests passed!');
