import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigCache } from '../configCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '../../');

describe('Locale Override Feature', () => {
  let configCache;
  const contentsDir = path.join(rootDir, 'contents');
  const localesDir = path.join(contentsDir, 'locales');
  const testOverrideFile = path.join(localesDir, 'en.json');

  beforeAll(async () => {
    // Create contents/locales directory if it doesn't exist
    await fs.mkdir(localesDir, { recursive: true });

    // Create a test override file
    const overrideContent = {
      app: {
        title: 'Custom App Title'
      },
      common: {
        save: 'Custom Save Button'
      }
    };
    await fs.writeFile(testOverrideFile, JSON.stringify(overrideContent, null, 2));

    // Initialize config cache
    configCache = new ConfigCache();
    await configCache.initialize();
  });

  afterAll(async () => {
    // Clean up test files
    try {
      await fs.unlink(testOverrideFile);
      // Try to remove locales directory if empty
      const files = await fs.readdir(localesDir);
      if (files.length === 0) {
        await fs.rmdir(localesDir);
      }
    } catch (_error) {
      // Ignore errors during cleanup
    }
  });

  it('should merge override locale with builtin locale', async () => {
    // Load the locale with overrides
    await configCache.loadAndCacheLocale('en');
    const translations = configCache.getLocalizations('en');

    expect(translations).toBeDefined();
    expect(translations.app).toBeDefined();
    expect(translations.app.title).toBe('Custom App Title');
    expect(translations.common).toBeDefined();
    expect(translations.common.save).toBe('Custom Save Button');
  });

  it('should preserve non-overridden keys from builtin locale', async () => {
    const translations = configCache.getLocalizations('en');

    expect(translations).toBeDefined();
    // These keys should exist from the base translation file
    expect(translations.common).toBeDefined();
    expect(translations.common.cancel).toBeDefined(); // Not overridden
  });

  it('should handle missing override file gracefully', async () => {
    // Load a locale without override file
    await configCache.loadAndCacheLocale('de');
    const translations = configCache.getLocalizations('de');

    expect(translations).toBeDefined();
    expect(translations.app).toBeDefined();
  });

  it('should warn about unknown keys in override', () => {
    const base = {
      app: {
        title: 'Title'
      },
      common: {
        save: 'Save'
      }
    };

    const overrides = {
      app: {
        title: 'New Title'
      },
      unknownKey: {
        value: 'Should warn'
      }
    };

    // This should not throw but log a warning
    const merged = configCache.mergeLocaleData(base, overrides);

    expect(merged.app.title).toBe('New Title');
    expect(merged.unknownKey).toBeUndefined(); // Unknown keys are not merged
  });

  it('should handle nested override keys', () => {
    const base = {
      app: {
        title: 'Title',
        subtitle: 'Subtitle',
        nested: {
          deep: {
            value: 'Original'
          }
        }
      }
    };

    const overrides = {
      app: {
        title: 'New Title',
        nested: {
          deep: {
            value: 'Overridden'
          }
        }
      }
    };

    const merged = configCache.mergeLocaleData(base, overrides);

    expect(merged.app.title).toBe('New Title');
    expect(merged.app.subtitle).toBe('Subtitle'); // Not overridden
    expect(merged.app.nested.deep.value).toBe('Overridden');
  });
});
