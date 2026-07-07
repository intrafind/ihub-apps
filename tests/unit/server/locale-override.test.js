/** @jest-environment node */

import { describe, it, expect, jest } from '@jest/globals';
import configCache from '../../../server/configCache.js';
import logger from '../../../server/utils/logger.js';

jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => process.cwd()
}));

jest.mock('../../../server/utils/authorization.js', () => ({
  resolveGroupInheritance: config => config,
  filterResourcesByPermissions: resources => resources,
  isAnonymousAccessAllowed: () => false
}));

jest.mock('../../../server/toolLoader.js', () => ({
  loadTools: jest.fn(async () => [])
}));

jest.mock('../../../server/services/skillLoader.js', () => ({
  loadSkillsMetadata: jest.fn(async () => [])
}));

jest.mock('../../../server/utils/ApiKeyVerifier.js', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    validateEnabledModelsApiKeys: jest.fn(async () => undefined),
    validateEnvironmentVariables: jest.fn()
  }))
}));

describe('Locale Override Feature', () => {
  it('should merge override locale with builtin locale keys', () => {
    const base = {
      app: {
        title: 'iHub Apps'
      },
      common: {
        save: 'Save',
        cancel: 'Cancel'
      }
    };
    const overrides = {
      app: {
        title: 'Custom App Title'
      },
      common: {
        save: 'Custom Save Button'
      }
    };
    const translations = configCache.mergeLocaleData(base, overrides);

    expect(translations).toBeDefined();
    expect(translations.app).toBeDefined();
    expect(translations.app.title).toBe('Custom App Title');
    expect(translations.common).toBeDefined();
    expect(translations.common.save).toBe('Custom Save Button');
  });

  it('should preserve non-overridden keys from builtin locale', () => {
    const base = {
      app: {
        title: 'iHub Apps'
      },
      common: {
        save: 'Save',
        cancel: 'Cancel'
      }
    };
    const overrides = {
      common: {
        save: 'Custom Save Button'
      }
    };
    const translations = configCache.mergeLocaleData(base, overrides);

    expect(translations).toBeDefined();
    expect(translations.common).toBeDefined();
    expect(translations.common.cancel).toBeDefined();
    expect(translations.common.cancel).toBe('Cancel');
  });

  it('should handle missing override payload gracefully', () => {
    const base = {
      app: {
        title: 'iHub Apps'
      }
    };
    const translations = configCache.mergeLocaleData(base, null);

    expect(translations).toEqual(base);
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

    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const merged = configCache.mergeLocaleData(base, overrides);

    expect(merged.app.title).toBe('New Title');
    expect(merged.unknownKey).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown locale key in overrides'),
      expect.objectContaining({ key: 'unknownKey' })
    );

    warnSpy.mockRestore();
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
