import assert from 'assert';
import { getAdapter } from '../adapters/index.js';
import logger from '../utils/logger.js';

// Test that known providers return the correct adapter
const knownProviders = [
  'openai',
  'openai-responses',
  'anthropic',
  'google',
  'mistral',
  'local',
  'iassistant-conversation',
  'bedrock'
];
for (const provider of knownProviders) {
  const adapter = getAdapter(provider);
  assert.ok(adapter, `Expected adapter for provider "${provider}" to be defined`);
}
logger.info('getAdapter returns adapters for all known providers');

// Test that an unknown provider throws instead of silently falling back to OpenAI
assert.throws(
  () => getAdapter('nonexistent-provider'),
  err => {
    assert.ok(err instanceof Error, 'Expected an Error to be thrown');
    assert.ok(
      err.message.includes('nonexistent-provider'),
      `Expected error message to mention the unknown provider, got: ${err.message}`
    );
    return true;
  }
);
logger.info('getAdapter throws for unknown providers');

// Test that a typo'd provider does not silently fall back to OpenAI
assert.throws(() => getAdapter('opanai'), /Unknown provider/);
logger.info("getAdapter does not silently fall back to OpenAI for typo'd providers");
