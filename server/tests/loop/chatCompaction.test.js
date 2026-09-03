/**
 * Chat compaction-threshold specs.
 *
 * C2/C3 moved chat onto AgentLoop, which proactively collapses old bulky
 * tool/assistant messages. Chat passed no context policy, so it inherited the
 * loop default of 16k tokens - sized for workflow nodes. On a 128k-1M window
 * model that truncated still-relevant websearch results and page extractions
 * to a 200-char preview and visibly shrank answers. The threshold now scales
 * with the model's context window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatCompactThresholdTokens,
  CHAT_COMPACT_MIN_TOKENS
} from '../../services/chat/ChatService.js';

test('the threshold scales with the model context window', () => {
  assert.equal(chatCompactThresholdTokens({ contextWindow: 128_000 }), 64_000);
  assert.equal(chatCompactThresholdTokens({ contextWindow: 1_000_000 }), 500_000);
  assert.equal(chatCompactThresholdTokens({ contextWindow: 200_000 }), 100_000);
});

test('a large window is no longer capped at the workflow-sized 16k default', () => {
  const threshold = chatCompactThresholdTokens({ contextWindow: 128_000 });
  assert.ok(
    threshold > CHAT_COMPACT_MIN_TOKENS * 3,
    `128k window must not compact at ${CHAT_COMPACT_MIN_TOKENS} (got ${threshold})`
  );
});

test('small or missing context windows fall back to the floor', () => {
  assert.equal(chatCompactThresholdTokens({ contextWindow: 8_000 }), CHAT_COMPACT_MIN_TOKENS);
  assert.equal(chatCompactThresholdTokens({}), CHAT_COMPACT_MIN_TOKENS);
  assert.equal(chatCompactThresholdTokens(null), CHAT_COMPACT_MIN_TOKENS);
  assert.equal(chatCompactThresholdTokens(undefined), CHAT_COMPACT_MIN_TOKENS);
});

test('a malformed contextWindow never yields NaN or a non-positive threshold', () => {
  for (const bad of [{ contextWindow: 'lots' }, { contextWindow: 0 }, { contextWindow: -5 }]) {
    const threshold = chatCompactThresholdTokens(bad);
    assert.ok(
      Number.isInteger(threshold) && threshold > 0,
      `${JSON.stringify(bad)} -> ${threshold}`
    );
    assert.equal(threshold, CHAT_COMPACT_MIN_TOKENS);
  }
});
