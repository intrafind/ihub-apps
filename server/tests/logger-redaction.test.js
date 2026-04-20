/**
 * Test that the logger automatically redacts sensitive information
 */
import logger from '../utils/logger.js';

// Capture console output to verify redaction
const originalWrite = process.stdout.write;
const outputs = [];

process.stdout.write = function (chunk) {
  outputs.push(chunk.toString());
  return true;
};

// Test 1: Logging an object with API key
logger.info('Testing model config:', {
  component: 'Test',
  modelConfig: {
    id: 'gpt-4',
    name: 'GPT-4',
    apiKey: 'sk-1234567890abcdefghijklmnop',
    provider: 'openai',
    tokenLimit: 4096
  }
});

// Test 2: Logging an object with encrypted API key
logger.info('Testing encrypted key:', {
  component: 'Test',
  config: {
    apiKey: 'ENC[AES256_GCM,data:encrypted123,iv:abc,tag:def,type:str]'
  }
});

// Test 3: Logging nested objects with secrets
logger.info('Testing nested secrets:', {
  component: 'Test',
  platform: {
    auth: {
      clientSecret: 'my-super-secret-value',
      redirectUrl: 'http://localhost:3000/callback'
    }
  }
});

// Restore console
process.stdout.write = originalWrite;

// Verify redaction
let allPassed = true;

// Check Test 1
const test1Output = outputs.find(o => o.includes('Testing model config'));
if (test1Output && test1Output.includes('sk-1234567890abcdefghijklmnop')) {
  console.error('❌ FAILED: API key was not redacted in Test 1');
  allPassed = false;
} else if (test1Output && !test1Output.includes('[REDACTED]')) {
  console.error('❌ FAILED: API key field not marked as [REDACTED] in Test 1');
  allPassed = false;
} else if (test1Output && !test1Output.includes('"tokenLimit":4096')) {
  console.error('❌ FAILED: Non-sensitive field was incorrectly redacted in Test 1');
  allPassed = false;
} else {
  console.log('✓ Test 1 passed: API key redacted, tokenLimit preserved');
}

// Check Test 2
const test2Output = outputs.find(o => o.includes('Testing encrypted key'));
if (test2Output && test2Output.includes('ENC[AES256_GCM')) {
  console.error('❌ FAILED: Encrypted key was not masked in Test 2');
  allPassed = false;
} else if (test2Output && !test2Output.includes('[ENCRYPTED]')) {
  console.error('❌ FAILED: Encrypted key not marked as [ENCRYPTED] in Test 2');
  allPassed = false;
} else {
  console.log('✓ Test 2 passed: Encrypted key marked as [ENCRYPTED]');
}

// Check Test 3
const test3Output = outputs.find(o => o.includes('Testing nested secrets'));
if (test3Output && test3Output.includes('my-super-secret-value')) {
  console.error('❌ FAILED: Client secret was not redacted in Test 3');
  console.error('Output:', test3Output);
  allPassed = false;
} else if (test3Output && !test3Output.includes('[REDACTED]')) {
  console.error('❌ FAILED: Client secret not marked as [REDACTED] in Test 3');
  console.error('Output:', test3Output);
  allPassed = false;
} else if (test3Output && !test3Output.includes('http://localhost:3000/callback')) {
  console.error('❌ FAILED: Non-sensitive field was incorrectly redacted in Test 3');
  console.error('Output:', test3Output);
  allPassed = false;
} else {
  console.log('✓ Test 3 passed: Client secret redacted, redirectUrl preserved');
}

if (allPassed) {
  console.log('\n✅ All logger redaction tests passed!');
  process.exit(0);
} else {
  console.error('\n❌ Some tests failed!');
  process.exit(1);
}
