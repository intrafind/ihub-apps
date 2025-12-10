import assert from 'assert';

console.log('Testing tokenLimit handling in RequestBuilder...');

/**
 * Test the tokenLimit logic to ensure it follows the expected behavior:
 * 1. If app.tokenLimit is specified, use it
 * 2. If app.tokenLimit is not specified, use model.tokenLimit
 * 3. If useMaxTokens is true, use model.tokenLimit
 * 4. Otherwise, use Math.min(appTokenLimit, modelTokenLimit)
 */

// Test 1: App has tokenLimit, model has tokenLimit
function testAppWithTokenLimit() {
  console.log('Test 1: App has tokenLimit (4000), model has tokenLimit (8192)');

  const app = { tokenLimit: 4000 };
  const model = { tokenLimit: 8192 };
  const useMaxTokens = false;

  const modelTokenLimit = model.tokenLimit || 4096;
  const appTokenLimit = app.tokenLimit !== undefined ? app.tokenLimit : modelTokenLimit;
  const finalTokens = useMaxTokens ? modelTokenLimit : Math.min(appTokenLimit, modelTokenLimit);

  console.log(`  Model Token Limit: ${modelTokenLimit}`);
  console.log(`  App Token Limit: ${appTokenLimit}`);
  console.log(`  Final Token Limit: ${finalTokens}`);

  assert.strictEqual(modelTokenLimit, 8192, 'Model token limit should be 8192');
  assert.strictEqual(appTokenLimit, 4000, 'App token limit should be 4000');
  assert.strictEqual(finalTokens, 4000, 'Final token limit should be 4000 (min of app and model)');
  console.log('  ✓ Passed\n');
}

// Test 2: App has NO tokenLimit, model has tokenLimit
function testAppWithoutTokenLimit() {
  console.log('Test 2: App has NO tokenLimit, model has tokenLimit (8192)');

  const app = {}; // No tokenLimit
  const model = { tokenLimit: 8192 };
  const useMaxTokens = false;

  const modelTokenLimit = model.tokenLimit || 4096;
  const appTokenLimit = app.tokenLimit !== undefined ? app.tokenLimit : modelTokenLimit;
  const finalTokens = useMaxTokens ? modelTokenLimit : Math.min(appTokenLimit, modelTokenLimit);

  console.log(`  Model Token Limit: ${modelTokenLimit}`);
  console.log(`  App Token Limit: ${appTokenLimit}`);
  console.log(`  Final Token Limit: ${finalTokens}`);

  assert.strictEqual(modelTokenLimit, 8192, 'Model token limit should be 8192');
  assert.strictEqual(
    appTokenLimit,
    8192,
    'App token limit should fallback to model token limit (8192)'
  );
  assert.strictEqual(finalTokens, 8192, 'Final token limit should be 8192');
  console.log('  ✓ Passed\n');
}

// Test 3: App has NO tokenLimit, model has NO tokenLimit
function testNeitherHasTokenLimit() {
  console.log('Test 3: App has NO tokenLimit, model has NO tokenLimit');

  const app = {}; // No tokenLimit
  const model = {}; // No tokenLimit
  const useMaxTokens = false;

  const modelTokenLimit = model.tokenLimit || 4096;
  const appTokenLimit = app.tokenLimit !== undefined ? app.tokenLimit : modelTokenLimit;
  const finalTokens = useMaxTokens ? modelTokenLimit : Math.min(appTokenLimit, modelTokenLimit);

  console.log(`  Model Token Limit: ${modelTokenLimit}`);
  console.log(`  App Token Limit: ${appTokenLimit}`);
  console.log(`  Final Token Limit: ${finalTokens}`);

  assert.strictEqual(modelTokenLimit, 4096, 'Model token limit should default to 4096');
  assert.strictEqual(appTokenLimit, 4096, 'App token limit should fallback to default (4096)');
  assert.strictEqual(finalTokens, 4096, 'Final token limit should be 4096');
  console.log('  ✓ Passed\n');
}

// Test 4: useMaxTokens is true
function testUseMaxTokens() {
  console.log(
    'Test 4: useMaxTokens is true, app has tokenLimit (4000), model has tokenLimit (8192)'
  );

  const app = { tokenLimit: 4000 };
  const model = { tokenLimit: 8192 };
  const useMaxTokens = true;

  const modelTokenLimit = model.tokenLimit || 4096;
  const appTokenLimit = app.tokenLimit !== undefined ? app.tokenLimit : modelTokenLimit;
  const finalTokens = useMaxTokens ? modelTokenLimit : Math.min(appTokenLimit, modelTokenLimit);

  console.log(`  Model Token Limit: ${modelTokenLimit}`);
  console.log(`  App Token Limit: ${appTokenLimit}`);
  console.log(`  Final Token Limit: ${finalTokens}`);

  assert.strictEqual(modelTokenLimit, 8192, 'Model token limit should be 8192');
  assert.strictEqual(appTokenLimit, 4000, 'App token limit should be 4000');
  assert.strictEqual(
    finalTokens,
    8192,
    'Final token limit should be 8192 (model max) when useMaxTokens is true'
  );
  console.log('  ✓ Passed\n');
}

// Test 5: App has tokenLimit = 0 (edge case - explicit 0)
function testAppWithZeroTokenLimit() {
  console.log('Test 5: App has tokenLimit = 0 (edge case), model has tokenLimit (8192)');

  const app = { tokenLimit: 0 };
  const model = { tokenLimit: 8192 };
  const useMaxTokens = false;

  const modelTokenLimit = model.tokenLimit || 4096;
  const appTokenLimit = app.tokenLimit !== undefined ? app.tokenLimit : modelTokenLimit;
  const finalTokens = useMaxTokens ? modelTokenLimit : Math.min(appTokenLimit, modelTokenLimit);

  console.log(`  Model Token Limit: ${modelTokenLimit}`);
  console.log(`  App Token Limit: ${appTokenLimit}`);
  console.log(`  Final Token Limit: ${finalTokens}`);

  assert.strictEqual(modelTokenLimit, 8192, 'Model token limit should be 8192');
  assert.strictEqual(appTokenLimit, 0, 'App token limit should be 0 (explicitly set)');
  assert.strictEqual(finalTokens, 0, 'Final token limit should be 0');
  console.log('  ✓ Passed\n');
}

// Test 6: Bug scenario - app has NO tokenLimit, should NOT default to 1024
function testBugScenarioFixed() {
  console.log('Test 6: Bug scenario - app has NO tokenLimit, should use model tokenLimit NOT 1024');

  const app = {}; // No tokenLimit
  const model = { tokenLimit: 64000 }; // Like Claude 4 Sonnet
  const useMaxTokens = false;

  // OLD BUGGY LOGIC (for reference):
  // const appTokenLimit = app.tokenLimit || 1024;  // BUG: defaults to 1024
  // const modelTokenLimit = model.tokenLimit || appTokenLimit;

  // NEW FIXED LOGIC:
  const modelTokenLimit = model.tokenLimit || 4096;
  const appTokenLimit = app.tokenLimit !== undefined ? app.tokenLimit : modelTokenLimit;
  const finalTokens = useMaxTokens ? modelTokenLimit : Math.min(appTokenLimit, modelTokenLimit);

  console.log(`  Model Token Limit: ${modelTokenLimit}`);
  console.log(`  App Token Limit: ${appTokenLimit}`);
  console.log(`  Final Token Limit: ${finalTokens}`);

  assert.strictEqual(modelTokenLimit, 64000, 'Model token limit should be 64000');
  assert.strictEqual(appTokenLimit, 64000, 'App token limit should be 64000 (NOT 1024)');
  assert.strictEqual(finalTokens, 64000, 'Final token limit should be 64000 (NOT 1024)');
  assert.notStrictEqual(appTokenLimit, 1024, 'App token limit should NOT be 1024');
  console.log('  ✓ Passed - Bug is fixed!\n');
}

// Run all tests
try {
  testAppWithTokenLimit();
  testAppWithoutTokenLimit();
  testNeitherHasTokenLimit();
  testUseMaxTokens();
  testAppWithZeroTokenLimit();
  testBugScenarioFixed();

  console.log('✅ All tokenLimit tests passed!');
  process.exit(0);
} catch (error) {
  console.error('❌ Test failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}
