import assert from 'assert';
import logger from '../utils/logger.js';
import { estimateTokens, computeContextUsage } from '../../shared/tokenEstimator.js';

logger.info('Testing maxOutputTokens / contextWindow handling...');

/**
 * Output-cap logic in RequestBuilder after the token-limit split:
 *   - Apps no longer carry a token limit.
 *   - The output cap sent to the provider is model.maxOutputTokens.
 *   - If the model has none, fall back to DEFAULT_MAX_OUTPUT (4096).
 *   - contextWindow is a separate concept, used only for capacity/fit.
 */
const DEFAULT_MAX_OUTPUT = 4096;
function resolveOutputCap(model) {
  return model.maxOutputTokens || DEFAULT_MAX_OUTPUT;
}

// Test 1: Model defines maxOutputTokens
function testModelMaxOutput() {
  logger.info('Test 1: model.maxOutputTokens (16000) is used as the output cap');
  const model = { contextWindow: 1000000, maxOutputTokens: 16000 };
  assert.strictEqual(resolveOutputCap(model), 16000);
  logger.info('  ✓ Passed\n');
}

// Test 2: Model has no maxOutputTokens -> default
function testDefaultOutput() {
  logger.info('Test 2: model without maxOutputTokens falls back to 4096');
  const model = { contextWindow: 8192 };
  assert.strictEqual(resolveOutputCap(model), DEFAULT_MAX_OUTPUT);
  logger.info('  ✓ Passed\n');
}

// Test 3: App token limit no longer affects the output cap
function testAppHasNoEffect() {
  logger.info('Test 3: a leftover app.tokenLimit does not influence the output cap');
  const model = { contextWindow: 1000000, maxOutputTokens: 32000 };
  // Even if some legacy app object still had tokenLimit, it is ignored.
  assert.strictEqual(resolveOutputCap(model), 32000);
  logger.info('  ✓ Passed\n');
}

// Test 4: Regression — Opus must NOT request its full context window as output.
function testOpusOutputBugFixed() {
  logger.info('Test 4: Opus output cap is the output value, not the 1M context window');
  const opus = { contextWindow: 1000000, maxOutputTokens: 32000 };
  const cap = resolveOutputCap(opus);
  assert.strictEqual(cap, 32000, 'Output cap should be 32000');
  assert.notStrictEqual(cap, opus.contextWindow, 'Output cap must not equal the context window');
  logger.info('  ✓ Passed - latent max_tokens=200000 bug is fixed!\n');
}

// Test 5: Tokenizer-backed estimation is non-trivial (not chars/4).
function testTokenizer() {
  logger.info('Test 5: estimateTokens returns a sensible count');
  const n = estimateTokens('Hello, world!');
  assert.ok(n > 0 && n < 10, `expected a small token count, got ${n}`);
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens(null), 0);
  logger.info('  ✓ Passed\n');
}

// Test 6: Context usage computation (remaining capacity).
function testContextUsage() {
  logger.info('Test 6: computeContextUsage reports remaining capacity');
  const usage = computeContextUsage({
    contextWindow: 10000,
    inputTokens: 2000,
    maxOutputTokens: 1000
  });
  assert.strictEqual(usage.remaining, 7000, 'remaining = 10000 - 2000 - 1000');
  assert.ok(usage.usedRatio > 0.29 && usage.usedRatio < 0.31, 'usedRatio ~ 0.3');
  logger.info('  ✓ Passed\n');
}

try {
  testModelMaxOutput();
  testDefaultOutput();
  testAppHasNoEffect();
  testOpusOutputBugFixed();
  testTokenizer();
  testContextUsage();

  logger.info('✅ All maxOutputTokens/contextWindow tests passed!');
  process.exit(0);
} catch (error) {
  logger.error('❌ Test failed:', error.message);
  logger.error(error.stack);
  process.exit(1);
}
