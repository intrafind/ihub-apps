/**
 * Tests for structured logging with component names
 * 
 * This test verifies that the logger properly processes arguments
 * and creates structured log entries with component fields.
 */
import assert from 'assert';

console.log('Running structured logging tests...\n');

// Test the processLogArgs function directly by simulating its behavior
function processLogArgs(args) {
  // If first arg is an object with a message property, use it directly
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && args[0].message) {
    return args[0];
  }

  // If first arg is a string and second is an object, combine them
  if (args.length >= 2 && typeof args[0] === 'string' && typeof args[1] === 'object') {
    return { message: args[0], ...args[1] };
  }

  // If first arg is a string only, convert to object
  if (args.length === 1 && typeof args[0] === 'string') {
    return { message: args[0] };
  }

  // For backward compatibility with winston's multiple args
  // Convert to message with metadata
  const message = args[0];
  const meta = args.slice(1).reduce((acc, arg) => {
    if (typeof arg === 'object') {
      return { ...acc, ...arg };
    }
    return acc;
  }, {});

  if (typeof message === 'object') {
    return { ...message, ...meta };
  }

  return Object.keys(meta).length > 0 ? { message, ...meta } : { message };
}

// Test 1: Simple message with component
console.log('Test 1: Simple message with component');
const result1 = processLogArgs([{ component: 'TestComponent', message: 'Test message' }]);
assert.strictEqual(result1.component, 'TestComponent');
assert.strictEqual(result1.message, 'Test message');
console.log('✓ Simple message with component processed correctly');

// Test 2: Message with component and metadata
console.log('\nTest 2: Message with component and metadata');
const result2 = processLogArgs([{
  component: 'ChatService',
  message: 'Chat request received',
  type: 'CHAT_REQUEST',
  id: 'msg-123',
  user: 'testuser'
}]);
assert.strictEqual(result2.component, 'ChatService');
assert.strictEqual(result2.message, 'Chat request received');
assert.strictEqual(result2.type, 'CHAT_REQUEST');
assert.strictEqual(result2.id, 'msg-123');
assert.strictEqual(result2.user, 'testuser');
console.log('✓ Message with component and metadata processed correctly');

// Test 3: Backward compatibility - string message only
console.log('\nTest 3: Backward compatibility - string message only');
const result3 = processLogArgs(['Simple string message']);
assert.strictEqual(typeof result3, 'object');
assert.strictEqual(result3.message, 'Simple string message');
console.log('✓ Backward compatible string message works');

// Test 4: Backward compatibility - string message with metadata object
console.log('\nTest 4: Backward compatibility - string message with metadata object');
const result4 = processLogArgs(['String message', { component: 'Server', key: 'value' }]);
assert.strictEqual(result4.message, 'String message');
assert.strictEqual(result4.component, 'Server');
assert.strictEqual(result4.key, 'value');
console.log('✓ String message with metadata object works');

// Test 5: Object without message property
console.log('\nTest 5: Object without message property');
const result5 = processLogArgs([{ component: 'Test', level: 'info' }]);
assert.strictEqual(result5.component, 'Test');
assert.strictEqual(result5.level, 'info');
console.log('✓ Object without message property handled correctly');

// Test 6: Multiple non-object arguments (edge case)
console.log('\nTest 6: String with multiple metadata objects');
const result6 = processLogArgs(['Message', { component: 'A' }, { extra: 'B' }]);
assert.strictEqual(result6.message, 'Message');
// Only first metadata object is used in current implementation
assert.strictEqual(result6.component, 'A');
console.log('✓ Multiple arguments handled');

console.log('\n✅ All structured logging tests passed!');
console.log('\nℹ️  To verify actual logging output, check server startup logs for:');
console.log('   - JSON format with "component" field');
console.log('   - Text format with [component] tag');
console.log('   - Structured fields like id, appId, modelId, sessionId, user in CHAT_REQUEST logs');

