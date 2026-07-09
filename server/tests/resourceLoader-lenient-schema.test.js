/**
 * Regression tests for createSchemaValidator's lenient-schema fallback (#1803).
 *
 * Both appConfigSchema and modelConfigSchema use z.strict(), so a config with a
 * single stray/unknown key used to fail safeParse entirely and fall back to the
 * raw, unvalidated item - silently dropping Zod defaults (enabled, sendChatHistory,
 * etc.). createSchemaValidator now retries against a passthrough ("lenient")
 * variant of the same schema when the strict parse fails, so defaults still apply.
 */
import { createSchemaValidator } from '../utils/resourceLoader.js';
import {
  appConfigSchema,
  appConfigSchemaLenient,
  knownAppKeys
} from '../validators/appConfigSchema.js';
import {
  modelConfigSchema,
  modelConfigSchemaLenient,
  knownModelKeys
} from '../validators/modelConfigSchema.js';

function baseApp(overrides = {}) {
  return {
    id: 'my-app',
    name: { en: 'My App' },
    description: { en: 'An app' },
    color: '#4F46E5',
    icon: 'chat',
    ...overrides
  };
}

function baseModel(overrides = {}) {
  return {
    id: 'my-model',
    modelId: 'gpt-4o',
    name: { en: 'My Model' },
    description: { en: 'A model' },
    provider: 'openai',
    ...overrides
  };
}

describe('createSchemaValidator lenient fallback', () => {
  test('applies app schema defaults when strict parse succeeds', () => {
    const validate = createSchemaValidator(appConfigSchema, knownAppKeys, appConfigSchemaLenient);
    const result = validate(baseApp(), 'contents/apps/my-app.json');

    expect(result.enabled).toBe(true);
    expect(result.sendChatHistory).toBe(true);
  });

  test('still applies app schema defaults when an unknown key would fail strict parsing', () => {
    const validate = createSchemaValidator(appConfigSchema, knownAppKeys, appConfigSchemaLenient);
    const item = baseApp({ someLegacyField: 'left over from an old version' });

    // Confirm the premise: strict parsing does reject this input.
    expect(appConfigSchema.safeParse(item).success).toBe(false);

    const result = validate(item, 'contents/apps/my-app.json');

    expect(result.enabled).toBe(true);
    expect(result.sendChatHistory).toBe(true);
    expect(result.someLegacyField).toBe('left over from an old version');
  });

  test('falls back to the raw item when the config is invalid for reasons other than unknown keys', () => {
    const validate = createSchemaValidator(appConfigSchema, knownAppKeys, appConfigSchemaLenient);
    // Missing required 'color' - lenient parsing must fail too.
    const item = { id: 'my-app', name: { en: 'My App' }, description: { en: 'An app' } };

    expect(appConfigSchemaLenient.safeParse(item).success).toBe(false);

    const result = validate(item, 'contents/apps/my-app.json');

    expect(result).toBe(item);
    expect(result.enabled).toBeUndefined();
  });

  test('still applies model schema defaults when an unknown key would fail strict parsing', () => {
    const validate = createSchemaValidator(
      modelConfigSchema,
      knownModelKeys,
      modelConfigSchemaLenient
    );
    const item = baseModel({ legacyFlag: true });

    expect(modelConfigSchema.safeParse(item).success).toBe(false);

    const result = validate(item, 'contents/models/my-model.json');

    expect(result.enabled).toBe(true);
    expect(result.supportsTools).toBe(false);
    expect(result.legacyFlag).toBe(true);
  });

  test('works unchanged with no lenient schema provided', () => {
    const validate = createSchemaValidator(appConfigSchema, knownAppKeys);
    const item = baseApp({ someLegacyField: 'x' });

    const result = validate(item, 'contents/apps/my-app.json');

    // No lenient fallback available - behaves like before the fix.
    expect(result).toBe(item);
  });
});
