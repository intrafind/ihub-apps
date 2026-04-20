/**
 * Test that the logger automatically redacts API keys in URLs
 */
import logger from '../utils/logger.js';

// Capture console output
const originalWrite = process.stdout.write;
const outputs = [];

process.stdout.write = function (chunk) {
  outputs.push(chunk.toString());
  return true;
};

// Test logging a URL with API key in query parameter
logger.error('HTTP error from LLM provider', {
  component: 'StreamingHandler',
  provider: 'google',
  httpStatus: 401,
  url: 'https://api.google.com/v1/models:generateContent?key=AIzaSyABC123xyz789'
});

// Test with multiple query parameters
logger.info('Making request', {
  component: 'Test',
  url: 'https://api.example.com/endpoint?api_key=secret123&token=xyz789&other=value'
});

// Restore console
process.stdout.write = originalWrite;

// Verify redaction
let allPassed = true;

// Check Test 1
const test1Output = outputs[0];
console.log('Test 1 output:');
console.log(test1Output);
console.log('');

if (test1Output.includes('AIzaSyABC123xyz789')) {
  console.error('❌ FAILED: Google API key was not redacted in URL');
  allPassed = false;
} else if (!test1Output.includes('key=[REDACTED]')) {
  console.error('❌ FAILED: URL query parameter not redacted');
  allPassed = false;
} else {
  console.log('✓ Test 1 passed: Google API key in URL redacted');
}

// Check Test 2
const test2Output = outputs[1];
console.log('Test 2 output:');
console.log(test2Output);
console.log('');

if (test2Output.includes('secret123') || test2Output.includes('xyz789')) {
  console.error('❌ FAILED: API keys in URL were not redacted');
  allPassed = false;
} else if (
  !test2Output.includes('api_key=[REDACTED]') ||
  !test2Output.includes('token=[REDACTED]')
) {
  console.error('❌ FAILED: URL query parameters not properly redacted');
  allPassed = false;
} else if (!test2Output.includes('other=value')) {
  console.error('❌ FAILED: Non-sensitive query parameter was incorrectly redacted');
  allPassed = false;
} else {
  console.log('✓ Test 2 passed: Multiple API keys in URL redacted, other params preserved');
}

if (allPassed) {
  console.log('\n✅ All URL redaction tests passed!');
  console.log('URLs with API keys are now automatically redacted by the logger.');
  process.exit(0);
} else {
  console.error('\n❌ Some tests failed!');
  process.exit(1);
}
