import assert from 'assert';
import OpenAIAdapter from '../adapters/openai.js';

// Test GPT-5.x model detection
console.log('Testing GPT-5.x model detection...');

const gpt5Models = [
  'gpt-5',
  'gpt-5.1',
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5.2-codex',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5.2-chat-latest'
];

const legacyModels = [
  'gpt-4',
  'gpt-4-turbo',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-3.5-turbo',
  'o1-preview',
  'o1-mini',
  'o3-mini'
];

// Test GPT-5.x detection
gpt5Models.forEach(modelId => {
  assert.strictEqual(
    OpenAIAdapter.isGPT5Model(modelId),
    true,
    `${modelId} should be detected as GPT-5.x model`
  );
});

// Test legacy model detection
legacyModels.forEach(modelId => {
  assert.strictEqual(
    OpenAIAdapter.isGPT5Model(modelId),
    false,
    `${modelId} should NOT be detected as GPT-5.x model`
  );
});

console.log('✓ GPT-5.x model detection tests passed');

// Test GPT-5.x request parameters
console.log('Testing GPT-5.x request parameters...');

const gpt5Model = {
  modelId: 'gpt-5.2',
  url: 'https://api.openai.com/v1/chat/completions',
  provider: 'openai',
  gpt5Reasoning: {
    effort: 'high',
    verbosity: 'low'
  }
};

const messages = [{ role: 'user', content: 'test' }];

const gpt5Request = OpenAIAdapter.createCompletionRequest(gpt5Model, messages, 'test-key', {
  maxTokens: 2048,
  temperature: 0.8
});

// Verify GPT-5.x uses max_output_tokens
assert.strictEqual(
  gpt5Request.body.max_output_tokens,
  2048,
  'GPT-5.x should use max_output_tokens'
);
assert.strictEqual(gpt5Request.body.max_tokens, undefined, 'GPT-5.x should not use max_tokens');

// Verify reasoning configuration
assert.deepStrictEqual(
  gpt5Request.body.reasoning,
  { effort: 'high' },
  'GPT-5.x should have reasoning configuration'
);

// Verify verbosity configuration
assert.deepStrictEqual(
  gpt5Request.body.text,
  { verbosity: 'low' },
  'GPT-5.x should have verbosity configuration'
);

// Verify temperature is NOT included when reasoning effort is not "none"
assert.strictEqual(
  gpt5Request.body.temperature,
  undefined,
  'GPT-5.x should not include temperature when reasoning effort is not "none"'
);

console.log('✓ GPT-5.x request parameter tests passed');

// Test GPT-5.x with reasoning effort "none"
console.log('Testing GPT-5.x with reasoning effort "none"...');

const gpt5NoneModel = {
  modelId: 'gpt-5.2',
  url: 'https://api.openai.com/v1/chat/completions',
  provider: 'openai',
  gpt5Reasoning: {
    effort: 'none',
    verbosity: 'medium'
  }
};

const gpt5NoneRequest = OpenAIAdapter.createCompletionRequest(gpt5NoneModel, messages, 'test-key', {
  maxTokens: 1024,
  temperature: 0.5
});

// Verify temperature IS included when reasoning effort is "none"
assert.strictEqual(
  gpt5NoneRequest.body.temperature,
  0.5,
  'GPT-5.x should include temperature when reasoning effort is "none"'
);

console.log('✓ GPT-5.x reasoning effort "none" tests passed');

// Test legacy model compatibility
console.log('Testing legacy model backward compatibility...');

const legacyModel = {
  modelId: 'gpt-4',
  url: 'https://api.openai.com/v1/chat/completions',
  provider: 'openai'
};

const legacyRequest = OpenAIAdapter.createCompletionRequest(legacyModel, messages, 'test-key', {
  maxTokens: 1024,
  temperature: 0.7
});

// Verify legacy models use max_tokens
assert.strictEqual(legacyRequest.body.max_tokens, 1024, 'Legacy models should use max_tokens');
assert.strictEqual(
  legacyRequest.body.max_output_tokens,
  undefined,
  'Legacy models should not use max_output_tokens'
);

// Verify temperature is included for legacy models
assert.strictEqual(legacyRequest.body.temperature, 0.7, 'Legacy models should include temperature');

// Verify reasoning and verbosity are not included for legacy models
assert.strictEqual(
  legacyRequest.body.reasoning,
  undefined,
  'Legacy models should not have reasoning configuration'
);
assert.strictEqual(
  legacyRequest.body.text,
  undefined,
  'Legacy models should not have text configuration'
);

console.log('✓ Legacy model backward compatibility tests passed');

// Test GPT-5.x with default reasoning configuration
console.log('Testing GPT-5.x with default reasoning configuration...');

const gpt5DefaultModel = {
  modelId: 'gpt-5.2',
  url: 'https://api.openai.com/v1/chat/completions',
  provider: 'openai'
  // No gpt5Reasoning configuration
};

const gpt5DefaultRequest = OpenAIAdapter.createCompletionRequest(
  gpt5DefaultModel,
  messages,
  'test-key',
  {
    maxTokens: 1024,
    temperature: 0.7
  }
);

// Verify default reasoning effort is "medium"
assert.deepStrictEqual(
  gpt5DefaultRequest.body.reasoning,
  { effort: 'medium' },
  'GPT-5.x should default to medium reasoning effort'
);

// Verify default verbosity is "medium"
assert.deepStrictEqual(
  gpt5DefaultRequest.body.text,
  { verbosity: 'medium' },
  'GPT-5.x should default to medium verbosity'
);

console.log('✓ GPT-5.x default configuration tests passed');

console.log('\n✅ All GPT-5.x support tests passed!');
