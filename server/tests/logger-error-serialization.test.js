/**
 * Test that the logger correctly serializes Error objects passed as metadata.
 * Error properties (message, stack, name) are non-enumerable and invisible to
 * Object.keys(), so without special handling they serialize as empty {}.
 */
import logger from '../utils/logger.js';

const originalWrite = process.stdout.write;
const outputs = [];

process.stdout.write = function (chunk) {
  outputs.push(chunk.toString());
  return true;
};

// Test 1: Basic Error object is serialized with message and name
logger.error('Something failed', {
  component: 'Test',
  error: new Error('test error message')
});

// Test 2: Error with custom enumerable properties (e.g., code, statusCode)
const customError = new Error('custom error');
customError.code = 'ENOENT';
customError.statusCode = 503;
logger.error('Custom error occurred', {
  component: 'Test',
  error: customError
});

// Test 3: Non-Error nested objects are unaffected
logger.error('Plain object error', {
  component: 'Test',
  error: { reason: 'something went wrong', code: 42 }
});

// Test 4: Error at top-level context (as first argument)
logger.error(new Error('top level error'));

process.stdout.write = originalWrite;

let allPassed = true;

// Check Test 1: error.message and error.name must appear in output
const test1Output = outputs.find(o => o.includes('Something failed'));
if (!test1Output) {
  console.error('❌ FAILED Test 1: log entry not found');
  allPassed = false;
} else if (!test1Output.includes('test error message')) {
  console.error('❌ FAILED Test 1: error.message was not serialized (got empty error object)');
  console.error('Output:', test1Output);
  allPassed = false;
} else if (!test1Output.includes('"name"')) {
  console.error('❌ FAILED Test 1: error.name was not serialized');
  console.error('Output:', test1Output);
  allPassed = false;
} else {
  console.log('✓ Test 1 passed: Error message and name serialized correctly');
}

// Check Test 2: custom enumerable properties preserved
const test2Output = outputs.find(o => o.includes('Custom error occurred'));
if (!test2Output) {
  console.error('❌ FAILED Test 2: log entry not found');
  allPassed = false;
} else if (!test2Output.includes('custom error')) {
  console.error('❌ FAILED Test 2: error.message was not serialized');
  console.error('Output:', test2Output);
  allPassed = false;
} else if (!test2Output.includes('ENOENT')) {
  console.error('❌ FAILED Test 2: custom error.code not preserved');
  console.error('Output:', test2Output);
  allPassed = false;
} else if (!test2Output.includes('503')) {
  console.error('❌ FAILED Test 2: custom error.statusCode not preserved');
  console.error('Output:', test2Output);
  allPassed = false;
} else {
  console.log('✓ Test 2 passed: Custom error properties preserved');
}

// Check Test 3: plain objects still work normally
const test3Output = outputs.find(o => o.includes('Plain object error'));
if (!test3Output) {
  console.error('❌ FAILED Test 3: log entry not found');
  allPassed = false;
} else if (!test3Output.includes('something went wrong')) {
  console.error('❌ FAILED Test 3: plain object error reason not preserved');
  console.error('Output:', test3Output);
  allPassed = false;
} else {
  console.log('✓ Test 3 passed: Plain object error fields preserved');
}

if (allPassed) {
  console.log('\n✅ All logger error serialization tests passed!');
  process.exit(0);
} else {
  console.error('\n❌ Some tests failed!');
  process.exit(1);
}
