import assert from 'assert';
import configCache from '../configCache.js';

console.log('Testing NDA Risk Analyzer configuration and prompt logic...\n');

/**
 * Test Suite 1: Rule Configuration Tests
 * Ensures default rules are loaded correctly from app config
 */
async function testRuleConfigurationLoaded() {
  console.log('Test 1: Default rules are loaded from configuration');

  const { data: apps } = configCache.getApps();
  const appConfig = apps.find(app => app.id === 'nda-risk-analyzer');

  assert.ok(appConfig, 'NDA app config should exist');
  assert.ok(appConfig.variables, 'App should have variables');

  const customRulesVar = appConfig.variables.find(v => v.name === 'custom_rules');
  assert.ok(customRulesVar, 'custom_rules variable should exist');

  const defaultRulesEN = customRulesVar.defaultValue.en;
  const defaultRulesDE = customRulesVar.defaultValue.de;

  assert.ok(defaultRulesEN, 'English default rules should exist');
  assert.ok(defaultRulesDE, 'German default rules should exist');

  // Verify key rules are present
  assert.ok(
    defaultRulesEN.includes('Duration') && defaultRulesEN.includes('24 months'),
    'Should include Duration rule with 24 month limit'
  );
  assert.ok(
    defaultRulesEN.includes('RED if > 24 months'),
    'Should specify RED flag for duration > 24 months'
  );
  assert.ok(
    defaultRulesEN.includes('Mutuality'),
    'Should include Mutuality rule'
  );
;

  console.log('✓ Default rules loaded correctly\n');
}

async function testRuleVariableStructure() {
  console.log('Test 2: Rule variable has correct structure');

  const { data: apps } = configCache.getApps();
  const appConfig = apps.find(app => app.id === 'nda-risk-analyzer');
  const customRulesVar = appConfig.variables.find(v => v.name === 'custom_rules');

  assert.strictEqual(customRulesVar.type, 'text', 'Variable type should be text');
  assert.strictEqual(customRulesVar.required, false, 'Variable should not be required');
  assert.ok(customRulesVar.label.en, 'Should have English label');
  assert.ok(customRulesVar.label.de, 'Should have German label');
  assert.ok(customRulesVar.description.en, 'Should have English description');
  assert.ok(customRulesVar.description.de, 'Should have German description');

  console.log('✓ Rule variable structure is valid\n');
}

/**
 * Test Suite 2: Prompt Template Tests
 * Ensures variables are correctly substituted in prompts
 */
async function testPromptTemplateSubstitution() {
  console.log('Test 3: Custom rules are injected into prompt template');

  const { data: apps } = configCache.getApps();
  const appConfig = apps.find(app => app.id === 'nda-risk-analyzer');
  const template = appConfig.prompt.en;

  // Mock user input
  const variables = {
    custom_rules: '- Duration: Maximum 12 months (RED if > 12)',
    content: 'CONFIDENTIALITY AGREEMENT\nThis agreement shall remain in effect for 24 months.'
  };

  // Simulate prompt construction
  let finalPrompt = template;
  Object.entries(variables).forEach(([key, value]) => {
    finalPrompt = finalPrompt.replace(`{{${key}}}`, value);
  });

  // Verify substitution
  assert.ok(
    finalPrompt.includes('- Duration: Maximum 12 months'),
    'Custom rules should be injected'
  );
  assert.ok(
    finalPrompt.includes('CONFIDENTIALITY AGREEMENT'),
    'NDA content should be injected'
  );
  assert.ok(
    !finalPrompt.includes('{{custom_rules}}'),
    'Template placeholders should be replaced'
  );
  assert.ok(
    !finalPrompt.includes('{{content}}'),
    'Content placeholder should be replaced'
  );

  console.log('✓ Prompt template substitution works correctly\n');
}

async function testPromptTemplateStructure() {
  console.log('Test 4: Prompt template has correct structure');

  const { data: apps } = configCache.getApps();
  const appConfig = apps.find(app => app.id === 'nda-risk-analyzer');

  assert.ok(appConfig.prompt, 'App should have prompt template');
  assert.ok(appConfig.prompt.en, 'Should have English prompt template');
  assert.ok(appConfig.prompt.de, 'Should have German prompt template');

  // Verify template includes necessary placeholders
  assert.ok(
    appConfig.prompt.en.includes('{{custom_rules}}'),
    'Template should include custom_rules placeholder'
  );
  assert.ok(
    appConfig.prompt.en.includes('{{content}}'),
    'Template should include content placeholder'
  );

  console.log('✓ Prompt template structure is valid\n');
}

async function testEmptyRulesHandling() {
  console.log('Test 5: Empty/whitespace rules should fall back to defaults');

  const { data: apps } = configCache.getApps();
  const appConfig = apps.find(app => app.id === 'nda-risk-analyzer');
  const customRulesVar = appConfig.variables.find(v => v.name === 'custom_rules');

  assert.ok(customRulesVar, 'custom_rules variable should exist');

  const defaultRules = customRulesVar.defaultValue.en;
  const template = appConfig.prompt.en;

  // Simulate frontend validation logic:
  // If user provides empty or whitespace-only value, use default
  const testCases = [
    { input: '', description: 'empty string' },
    { input: '   ', description: 'whitespace only' },
    { input: ' \n\t ', description: 'mixed whitespace' }
  ];

  testCases.forEach(testCase => {
    const isEmptyOrWhitespace = testCase.input.trim() === '';
    const finalValue = isEmptyOrWhitespace ? defaultRules : testCase.input;

    // Build prompt with validated value
    let finalPrompt = template;
    finalPrompt = finalPrompt.replace('{{custom_rules}}', finalValue);
    finalPrompt = finalPrompt.replace('{{content}}', 'NDA text');

    // Verify default rules are used (not empty)
    assert.ok(
      finalPrompt.includes('Duration: Maximum months'),
      `Should use default rules when input is ${testCase.description}`
    );
    assert.ok(
      !finalPrompt.includes('{{'),
      `No unreplaced placeholders for ${testCase.description}`
    );
  });

  console.log('✓ Empty/whitespace rules correctly fall back to defaults\n');
}

/**
 * Test Suite 3: JSON Schema Tests
 * Validates the output schema structure
 */
async function testOutputSchemaStructure() {
  console.log('Test 6: Output schema has correct structure');

  const { data: apps } = configCache.getApps();
  const appConfig = apps.find(app => app.id === 'nda-risk-analyzer');
  const schema = appConfig.outputSchema;

  assert.ok(schema, 'App should have output schema');
  assert.strictEqual(schema.type, 'object', 'Schema type should be object');

  // Required fields
  assert.ok(
    schema.required.includes('overall_risk'),
    'Schema should require overall_risk'
  );
  assert.ok(
    schema.required.includes('clauses'),
    'Schema should require clauses'
  );

  // Overall risk property
  assert.strictEqual(
    schema.properties.overall_risk.type,
    'string',
    'overall_risk should be string'
  );
  assert.deepStrictEqual(
    schema.properties.overall_risk.enum,
    ['red', 'yellow', 'green'],
    'overall_risk should have correct enum values'
  );

  // Clauses array
  assert.strictEqual(
    schema.properties.clauses.type,
    'array',
    'clauses should be array'
  );
  assert.strictEqual(
    schema.properties.clauses.minItems,
    8,
    'clauses should have minimum 8 items'
  );

  console.log('✓ Output schema structure is valid\n');
}

async function testClausesSchemaStructure() {
  console.log('Test 7: Clauses items schema has correct structure');

  const { data: apps } = configCache.getApps();
  const appConfig = apps.find(app => app.id === 'nda-risk-analyzer');
  const clausesSchema = appConfig.outputSchema.properties.clauses.items;

  assert.strictEqual(clausesSchema.type, 'object', 'Clause item should be object');

  // Required fields for each clause
  const requiredFields = ['clause_name', 'citation', 'risk_level', 'reason'];
  requiredFields.forEach(field => {
    assert.ok(
      clausesSchema.required.includes(field),
      `Clause should require ${field}`
    );
  });

  // Field types
  assert.strictEqual(
    clausesSchema.properties.clause_name.type,
    'string',
    'clause_name should be string'
  );
  assert.strictEqual(
    clausesSchema.properties.citation.type,
    'array',
    'citation should be array'
  );
  assert.strictEqual(
    clausesSchema.properties.risk_level.type,
    'string',
    'risk_level should be string'
  );
  assert.deepStrictEqual(
    clausesSchema.properties.risk_level.enum,
    ['red', 'yellow', 'green'],
    'risk_level should have correct enum values'
  );
  assert.strictEqual(
    clausesSchema.properties.reason.type,
    'string',
    'reason should be string'
  );

  console.log('✓ Clauses schema structure is valid\n');
}

/**
 * Test Suite 4: Fixture Response Validation
 * Validates a sample response structure (not LLM output, just structure)
 */
async function testFixtureResponseStructure() {
  console.log('Test 8: Sample response fixture has valid structure');

  // This is a mock response structure that the renderer expects
  const sampleResponse = {
    overall_risk: 'red',
    clauses: [
      {
        clause_name: 'Duration',
        citation: ['Die Laufzeit beträgt 60 Monate'],
        risk_level: 'red',
        reason: 'Die Vertragslaufzeit überschreitet die maximal akzeptable Dauer von 24 Monaten erheblich'
      },
      {
        clause_name: 'Mutuality',
        citation: ['Diese Vereinbarung ist einseitig'],
        risk_level: 'yellow',
        reason: 'Die NDA ist einseitig, was für den Empfänger nachteilig sein kann'
      },
      {
        clause_name: 'Confidential Information Definition',
        citation: ['Vertrauliche Informationen umfassen alle geschäftlichen Daten'],
        risk_level: 'green',
        reason: 'Die Definition vertraulicher Informationen ist klar und angemessen'
      }
    ]
  };

  // Validate structure matches what renderer expects
  assert.ok(['red', 'yellow', 'green'].includes(sampleResponse.overall_risk));
  assert.ok(Array.isArray(sampleResponse.clauses));
  assert.ok(sampleResponse.clauses.length >= 3);

  sampleResponse.clauses.forEach((clause, idx) => {
    assert.ok(clause.clause_name, `Clause ${idx} should have clause_name`);
    assert.ok(
      ['red', 'yellow', 'green'].includes(clause.risk_level),
      `Clause ${idx} should have valid risk_level`
    );
    assert.ok(clause.reason, `Clause ${idx} should have reason`);
    assert.ok(Array.isArray(clause.citation), `Clause ${idx} should have citation array`);
  });

  console.log('✓ Sample response structure is valid for renderer\n');
}

/**
 * Run all tests
 */
async function runAllTests() {
  try {
    // Initialize config cache before running tests
    console.log('Initializing configuration cache...\n');
    await configCache.initialize();

    // Test Suite 1: Rule Configuration
    await testRuleConfigurationLoaded();
    await testRuleVariableStructure();

    // Test Suite 2: Prompt Template
    await testPromptTemplateSubstitution();
    await testPromptTemplateStructure();
    await testEmptyRulesHandling();

    // Test Suite 3: JSON Schema
    await testOutputSchemaStructure();
    await testClausesSchemaStructure();

    // Test Suite 4: Fixture Response
    await testFixtureResponseStructure();

    console.log('✅ All NDA Risk Analyzer tests passed!\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
runAllTests();
