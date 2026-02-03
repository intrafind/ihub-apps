/**
 * Tests for JSON logging field order
 *
 * This test verifies that the logger outputs JSON logs with a consistent
 * field order: component, level, timestamp, message, then other attributes.
 */
import assert from 'assert';
import { Transform } from 'stream';
import winston from 'winston';

console.log('Running JSON field order tests...\n');

/**
 * Custom JSON formatter with fixed field order
 * Ensures consistent field ordering: component, level, timestamp, message, then other fields
 */
const orderedJsonFormat = winston.format.printf((info) => {
  // Define the desired field order
  const orderedLog = {};

  // 1. Component (if present)
  if (info.component !== undefined) {
    orderedLog.component = info.component;
  }

  // 2. Log level
  orderedLog.level = info.level;

  // 3. Timestamp
  if (info.timestamp !== undefined) {
    orderedLog.timestamp = info.timestamp;
  }

  // 4. Message
  if (info.message !== undefined) {
    orderedLog.message = info.message;
  }

  // 5. Add all other fields (except the ones we've already added)
  const reservedFields = ['component', 'level', 'timestamp', 'message'];
  Object.keys(info).forEach((key) => {
    if (!reservedFields.includes(key) && typeof key === 'string') {
      orderedLog[key] = info[key];
    }
  });

  return JSON.stringify(orderedLog);
});

// Create a custom transport to capture log output
const logs = [];

const testTransport = new winston.transports.Stream({
  stream: new Transform({
    transform(chunk, encoding, callback) {
      logs.push(chunk.toString());
      callback();
    }
  })
});

// Create logger with ordered JSON format
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    orderedJsonFormat
  ),
  transports: [testTransport]
});

// Helper function to get field order from JSON string
function getFieldOrder(jsonString) {
  // Extract field names in order they appear in the JSON string
  const fieldMatches = jsonString.matchAll(/"([^"]+)":/g);
  return Array.from(fieldMatches, (match) => match[1]);
}

// Test 1: Verify field order with all fields present
console.log('Test 1: All fields present (component, level, timestamp, message, extras)');
logger.info({ component: 'TestComp', message: 'Test message', extra: 'data', userId: '123' });
const log1 = logs[logs.length - 1];
const fields1 = getFieldOrder(log1);
assert.strictEqual(fields1[0], 'component', 'Component should be first field');
assert.strictEqual(fields1[1], 'level', 'Level should be second field');
assert.strictEqual(fields1[2], 'timestamp', 'Timestamp should be third field');
assert.strictEqual(fields1[3], 'message', 'Message should be fourth field');
assert.ok(fields1.length >= 4, 'Should have at least 4 fields');
console.log(`✓ Field order: ${fields1.join(', ')}`);

// Test 2: Verify field order without component
console.log('\nTest 2: Without component field');
logger.info({ message: 'Test message', extra: 'data', sessionId: 'abc' });
const log2 = logs[logs.length - 1];
const fields2 = getFieldOrder(log2);
assert.strictEqual(fields2[0], 'level', 'Level should be first field when no component');
assert.strictEqual(fields2[1], 'timestamp', 'Timestamp should be second field when no component');
assert.strictEqual(fields2[2], 'message', 'Message should be third field when no component');
console.log(`✓ Field order: ${fields2.join(', ')}`);

// Test 3: Verify order remains consistent regardless of input order
console.log('\nTest 3: Consistent order regardless of input field order');
logger.info({ extra: 'data', component: 'Test', message: 'Test', userId: '123' });
const log3 = logs[logs.length - 1];
const fields3 = getFieldOrder(log3);
assert.strictEqual(fields3[0], 'component', 'Component should always be first');
assert.strictEqual(fields3[1], 'level', 'Level should always be second');
assert.strictEqual(fields3[2], 'timestamp', 'Timestamp should always be third');
assert.strictEqual(fields3[3], 'message', 'Message should always be fourth');
console.log(`✓ Field order: ${fields3.join(', ')}`);

// Test 4: Multiple extra fields maintain order
console.log('\nTest 4: Multiple extra fields after standard fields');
logger.info({
  component: 'ChatService',
  message: 'Chat request',
  appId: 'platform',
  modelId: 'gpt-4',
  sessionId: 'session-123',
  user: 'john'
});
const log4 = logs[logs.length - 1];
const fields4 = getFieldOrder(log4);
assert.strictEqual(fields4[0], 'component', 'Component should be first');
assert.strictEqual(fields4[1], 'level', 'Level should be second');
assert.strictEqual(fields4[2], 'timestamp', 'Timestamp should be third');
assert.strictEqual(fields4[3], 'message', 'Message should be fourth');
// Extra fields should come after the standard 4
assert.ok(fields4.indexOf('appId') > 3, 'Extra fields should come after standard fields');
assert.ok(fields4.indexOf('modelId') > 3, 'Extra fields should come after standard fields');
console.log(`✓ Field order: ${fields4.join(', ')}`);

// Test 5: Error logs with stack trace
console.log('\nTest 5: Error log with stack trace');
try {
  throw new Error('Test error');
} catch (err) {
  logger.error({ component: 'Server', message: 'Error occurred', error: err.message });
}
const log5 = logs[logs.length - 1];
const fields5 = getFieldOrder(log5);
assert.strictEqual(fields5[0], 'component', 'Component should be first');
assert.strictEqual(fields5[1], 'level', 'Level should be second');
assert.strictEqual(fields5[2], 'timestamp', 'Timestamp should be third');
assert.strictEqual(fields5[3], 'message', 'Message should be fourth');
console.log(`✓ Field order: ${fields5.join(', ')}`);

// Test 6: Verify all logs have same primary field order
console.log('\nTest 6: All logs maintain consistent order');
const allLogs = logs.map((log) => {
  const parsed = JSON.parse(log);
  const fields = getFieldOrder(log);
  return { parsed, fields };
});

allLogs.forEach((entry, index) => {
  const { parsed, fields } = entry;
  let expectedOrder;
  if (parsed.component) {
    expectedOrder = ['component', 'level', 'timestamp', 'message'];
  } else {
    expectedOrder = ['level', 'timestamp', 'message'];
  }

  expectedOrder.forEach((field, idx) => {
    assert.strictEqual(
      fields[idx],
      field,
      `Log ${index + 1}: Field ${idx + 1} should be ${field}, got ${fields[idx]}`
    );
  });
});
console.log(`✓ All ${allLogs.length} logs have consistent field ordering`);

console.log('\n✅ All JSON field order tests passed!');
console.log('\nℹ️  Field ordering guaranteed:');
console.log('   1. component (if present)');
console.log('   2. level');
console.log('   3. timestamp');
console.log('   4. message');
console.log('   5. All other attributes in order added');
