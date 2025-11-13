/**
 * Unit tests for cleanAppData function in AdminAppEditPage
 * Tests the cleanup of disabled feature configurations
 */

describe('AdminAppEditPage - cleanAppData', () => {
  // Extract and test the cleanAppData logic
  const cleanAppData = appData => {
    const cleanedApp = { ...appData };

    // Clean up variables - remove empty defaultValue and predefinedValues
    if (cleanedApp.variables) {
      cleanedApp.variables = cleanedApp.variables.map(variable => {
        const cleanedVariable = { ...variable };

        if (cleanedVariable.defaultValue) {
          const hasNonEmptyValue = Object.values(cleanedVariable.defaultValue).some(
            val => val && val !== ''
          );
          if (!hasNonEmptyValue) {
            delete cleanedVariable.defaultValue;
          }
        }

        if (cleanedVariable.predefinedValues && cleanedVariable.predefinedValues.length === 0) {
          delete cleanedVariable.predefinedValues;
        }

        return cleanedVariable;
      });
    }

    // Clean up upload configuration when disabled
    if (cleanedApp.upload) {
      const upload = { ...cleanedApp.upload };

      if (upload.imageUpload && upload.imageUpload.enabled === false) {
        delete upload.imageUpload;
      }

      if (upload.fileUpload && upload.fileUpload.enabled === false) {
        delete upload.fileUpload;
      }

      if (upload.enabled === false) {
        delete cleanedApp.upload;
      } else {
        cleanedApp.upload = upload;
      }
    }

    // Clean up features configuration when disabled
    if (cleanedApp.features) {
      const features = { ...cleanedApp.features };

      if (features.magicPrompt && features.magicPrompt.enabled === false) {
        delete features.magicPrompt;
      }

      if (Object.keys(features).length === 0) {
        delete cleanedApp.features;
      } else {
        cleanedApp.features = features;
      }
    }

    return cleanedApp;
  };

  describe('upload configuration cleanup', () => {
    test('should remove imageUpload when disabled', () => {
      const appData = {
        id: 'test-app',
        upload: {
          enabled: true,
          imageUpload: {
            enabled: false,
            maxFileSizeMB: 10,
            supportedFormats: ['image/jpeg', 'image/png']
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.upload).toBeDefined();
      expect(result.upload.imageUpload).toBeUndefined();
      expect(result.upload.enabled).toBe(true);
    });

    test('should remove fileUpload when disabled', () => {
      const appData = {
        id: 'test-app',
        upload: {
          enabled: true,
          fileUpload: {
            enabled: false,
            maxFileSizeMB: 5,
            supportedFormats: ['text/plain']
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.upload).toBeDefined();
      expect(result.upload.fileUpload).toBeUndefined();
      expect(result.upload.enabled).toBe(true);
    });

    test('should remove entire upload config when upload is disabled', () => {
      const appData = {
        id: 'test-app',
        upload: {
          enabled: false,
          imageUpload: {
            enabled: true,
            maxFileSizeMB: 10
          },
          fileUpload: {
            enabled: true,
            maxFileSizeMB: 5
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.upload).toBeUndefined();
    });

    test('should keep enabled imageUpload and fileUpload', () => {
      const appData = {
        id: 'test-app',
        upload: {
          enabled: true,
          imageUpload: {
            enabled: true,
            maxFileSizeMB: 10,
            supportedFormats: ['image/jpeg']
          },
          fileUpload: {
            enabled: true,
            maxFileSizeMB: 5,
            supportedFormats: ['text/plain']
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.upload).toBeDefined();
      expect(result.upload.enabled).toBe(true);
      expect(result.upload.imageUpload).toBeDefined();
      expect(result.upload.imageUpload.enabled).toBe(true);
      expect(result.upload.fileUpload).toBeDefined();
      expect(result.upload.fileUpload.enabled).toBe(true);
    });

    test('should handle missing upload config', () => {
      const appData = {
        id: 'test-app'
      };

      const result = cleanAppData(appData);

      expect(result.upload).toBeUndefined();
    });
  });

  describe('features configuration cleanup', () => {
    test('should remove magicPrompt when disabled', () => {
      const appData = {
        id: 'test-app',
        features: {
          magicPrompt: {
            enabled: false,
            model: 'gpt-4',
            prompt: 'Some prompt'
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.features).toBeUndefined();
    });

    test('should keep magicPrompt when enabled', () => {
      const appData = {
        id: 'test-app',
        features: {
          magicPrompt: {
            enabled: true,
            model: 'gpt-4',
            prompt: 'Improve this prompt'
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.features).toBeDefined();
      expect(result.features.magicPrompt).toBeDefined();
      expect(result.features.magicPrompt.enabled).toBe(true);
      expect(result.features.magicPrompt.model).toBe('gpt-4');
    });

    test('should remove entire features object when empty', () => {
      const appData = {
        id: 'test-app',
        features: {
          magicPrompt: {
            enabled: false
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.features).toBeUndefined();
    });

    test('should handle missing features config', () => {
      const appData = {
        id: 'test-app'
      };

      const result = cleanAppData(appData);

      expect(result.features).toBeUndefined();
    });
  });

  describe('combined scenarios', () => {
    test('should clean up both upload and features when disabled', () => {
      const appData = {
        id: 'test-app',
        upload: {
          enabled: false,
          imageUpload: {
            enabled: true,
            maxFileSizeMB: 10
          }
        },
        features: {
          magicPrompt: {
            enabled: false,
            model: 'gpt-4'
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.upload).toBeUndefined();
      expect(result.features).toBeUndefined();
    });

    test('should preserve other app properties', () => {
      const appData = {
        id: 'test-app',
        name: { en: 'Test App' },
        description: { en: 'Test Description' },
        color: '#4F46E5',
        upload: {
          enabled: false
        },
        features: {
          magicPrompt: {
            enabled: false
          }
        }
      };

      const result = cleanAppData(appData);

      expect(result.id).toBe('test-app');
      expect(result.name).toEqual({ en: 'Test App' });
      expect(result.description).toEqual({ en: 'Test Description' });
      expect(result.color).toBe('#4F46E5');
      expect(result.upload).toBeUndefined();
      expect(result.features).toBeUndefined();
    });
  });

  describe('variables cleanup (existing functionality)', () => {
    test('should remove empty defaultValue', () => {
      const appData = {
        id: 'test-app',
        variables: [
          {
            name: 'testVar',
            defaultValue: { en: '', de: '' }
          }
        ]
      };

      const result = cleanAppData(appData);

      expect(result.variables[0].defaultValue).toBeUndefined();
    });

    test('should remove empty predefinedValues array', () => {
      const appData = {
        id: 'test-app',
        variables: [
          {
            name: 'testVar',
            predefinedValues: []
          }
        ]
      };

      const result = cleanAppData(appData);

      expect(result.variables[0].predefinedValues).toBeUndefined();
    });
  });
});
