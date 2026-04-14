/**
 * Test that logging modelConfig redacts API key (issue reproduction test)
 */
import logger from '../utils/logger.js';

// Mock a typical model config object as would be returned from configCache
const modelConfig = {
  id: 'gpt-4',
  modelId: 'gpt-4',
  name: { en: 'GPT-4' },
  provider: 'openai',
  tokenLimit: 8192,
  apiKey: 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
  supportsTools: true,
  supportsVision: true,
  enabled: true
};

// Capture console output
const originalWrite = process.stdout.write;
const outputs = [];

process.stdout.write = function (chunk) {
  outputs.push(chunk.toString());
  return true;
};

// Reproduce the exact log statement from server/utils.js:526
logger.info('Using model:', { component: 'Utils', modelConfig });

// Restore console
process.stdout.write = originalWrite;

// Verify redaction
const output = outputs[0];

console.log('Captured log output:');
console.log(output);
console.log('');

let allPassed = true;

// Verify the API key is NOT in the log
if (output.includes('sk-proj-1234567890abcdefghijklmnopqrstuvwxyz')) {
  console.error('❌ FAILED: API key was not redacted!');
  console.error('This is the security issue reported in the GitHub issue.');
  allPassed = false;
} else {
  console.log('✓ API key successfully redacted');
}

// Verify it was replaced with [REDACTED]
if (!output.includes('[REDACTED]')) {
  console.error('❌ FAILED: API key field not marked as [REDACTED]');
  allPassed = false;
} else {
  console.log('✓ API key marked as [REDACTED]');
}

// Verify other fields are preserved
if (!output.includes('"id":"gpt-4"')) {
  console.error('❌ FAILED: Model ID was incorrectly redacted');
  allPassed = false;
} else {
  console.log('✓ Model ID preserved');
}

if (!output.includes('"tokenLimit":8192')) {
  console.error('❌ FAILED: Token limit was incorrectly redacted');
  allPassed = false;
} else {
  console.log('✓ Token limit preserved');
}

if (!output.includes('"provider":"openai"')) {
  console.error('❌ FAILED: Provider was incorrectly redacted');
  allPassed = false;
} else {
  console.log('✓ Provider preserved');
}

if (allPassed) {
  console.log(
    '\n✅ Issue fix verified! API key is now automatically redacted when logging modelConfig.'
  );
  process.exit(0);
} else {
  console.error('\n❌ Fix did not work correctly!');
  process.exit(1);
}
