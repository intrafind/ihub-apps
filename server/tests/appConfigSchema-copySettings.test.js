/**
 * Tests for the settings.copy field of appConfigSchema (issue #1642:
 * per-app configuration of which "copy response" formats are offered
 * and which one is used by the one-click copy button).
 */
import { appConfigSchema } from '../validators/appConfigSchema.js';

function baseApp(overrides = {}) {
  return {
    id: 'test-app',
    name: { en: 'Test App' },
    description: { en: 'A test app' },
    color: '#4F46E5',
    icon: 'chat-bubble',
    system: { en: 'You are a helpful assistant.' },
    ...overrides
  };
}

describe('appConfigSchema settings.copy', () => {
  test('is optional and absent by default', () => {
    const result = appConfigSchema.safeParse(baseApp());
    expect(result.success).toBe(true);
    expect(result.data.settings).toBeUndefined();
  });

  test('applies schema defaults when only partially specified', () => {
    const result = appConfigSchema.safeParse(baseApp({ settings: { copy: {} } }));
    expect(result.success).toBe(true);
    expect(result.data.settings.copy).toEqual({
      enabled: true,
      formats: ['text', 'markdown', 'html'],
      defaultFormat: 'text'
    });
  });

  test('accepts a restricted format list with a matching default', () => {
    const result = appConfigSchema.safeParse(
      baseApp({ settings: { copy: { formats: ['html'], defaultFormat: 'html' } } })
    );
    expect(result.success).toBe(true);
    expect(result.data.settings.copy).toEqual({
      enabled: true,
      formats: ['html'],
      defaultFormat: 'html'
    });
  });

  test('rejects a defaultFormat not present in formats', () => {
    const result = appConfigSchema.safeParse(
      baseApp({ settings: { copy: { formats: ['text', 'markdown'], defaultFormat: 'html' } } })
    );
    expect(result.success).toBe(false);
  });

  test('rejects an unknown format value', () => {
    const result = appConfigSchema.safeParse(baseApp({ settings: { copy: { formats: ['pdf'] } } }));
    expect(result.success).toBe(false);
  });

  test('allows disabling the copy control entirely', () => {
    const result = appConfigSchema.safeParse(baseApp({ settings: { copy: { enabled: false } } }));
    expect(result.success).toBe(true);
    expect(result.data.settings.copy.enabled).toBe(false);
  });
});
