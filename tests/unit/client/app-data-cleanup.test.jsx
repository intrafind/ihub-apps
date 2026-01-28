/**
 * Unit tests for wizard-specific field cleanup
 * Tests the removal of useTemplate, useAI, useManual fields
 */

import {
  removeWizardFields,
  removeInvalidSpeechRecognition,
  cleanupAppData
} from '../../../client/src/utils/appDataCleanup';

describe('appDataCleanup utility functions', () => {
  describe('removeWizardFields', () => {
    test('should remove useTemplate field', () => {
      const appData = {
        id: 'test-app',
        name: { en: 'Test App' },
        useTemplate: true
      };

      const result = removeWizardFields(appData);

      expect(result.id).toBe('test-app');
      expect(result.name).toEqual({ en: 'Test App' });
      expect(result.useTemplate).toBeUndefined();
    });

    test('should remove useAI field', () => {
      const appData = {
        id: 'test-app',
        name: { en: 'Test App' },
        useAI: true
      };

      const result = removeWizardFields(appData);

      expect(result.id).toBe('test-app');
      expect(result.name).toEqual({ en: 'Test App' });
      expect(result.useAI).toBeUndefined();
    });

    test('should remove useManual field', () => {
      const appData = {
        id: 'test-app',
        name: { en: 'Test App' },
        useManual: true
      };

      const result = removeWizardFields(appData);

      expect(result.id).toBe('test-app');
      expect(result.name).toEqual({ en: 'Test App' });
      expect(result.useManual).toBeUndefined();
    });

    test('should remove all wizard fields at once', () => {
      const appData = {
        id: 'test-app',
        name: { en: 'Test App' },
        useTemplate: true,
        useAI: false,
        useManual: false
      };

      const result = removeWizardFields(appData);

      expect(result.id).toBe('test-app');
      expect(result.name).toEqual({ en: 'Test App' });
      expect(result.useTemplate).toBeUndefined();
      expect(result.useAI).toBeUndefined();
      expect(result.useManual).toBeUndefined();
    });

    test('should handle app data without wizard fields', () => {
      const appData = {
        id: 'test-app',
        name: { en: 'Test App' },
        description: { en: 'Test Description' }
      };

      const result = removeWizardFields(appData);

      expect(result.id).toBe('test-app');
      expect(result.name).toEqual({ en: 'Test App' });
      expect(result.description).toEqual({ en: 'Test Description' });
    });
  });

  describe('removeInvalidSpeechRecognition', () => {
    test('should remove speechRecognition when host is empty', () => {
      const appData = {
        id: 'test-app',
        settings: {
          speechRecognition: {
            service: 'default',
            host: ''
          }
        }
      };

      const result = removeInvalidSpeechRecognition(appData);

      expect(result.settings.speechRecognition).toBeUndefined();
    });

    test('should remove speechRecognition when host is whitespace', () => {
      const appData = {
        id: 'test-app',
        settings: {
          speechRecognition: {
            service: 'default',
            host: '   '
          }
        }
      };

      const result = removeInvalidSpeechRecognition(appData);

      expect(result.settings.speechRecognition).toBeUndefined();
    });

    test('should keep speechRecognition when host has valid URL', () => {
      const appData = {
        id: 'test-app',
        settings: {
          speechRecognition: {
            service: 'custom',
            host: 'https://speech.example.com'
          }
        }
      };

      const result = removeInvalidSpeechRecognition(appData);

      expect(result.settings.speechRecognition).toBeDefined();
      expect(result.settings.speechRecognition.host).toBe('https://speech.example.com');
    });
  });

  describe('cleanupAppData (combined cleanup)', () => {
    test('should remove both wizard fields and invalid speechRecognition', () => {
      const appData = {
        id: 'test-app',
        name: { en: 'Test App' },
        useTemplate: true,
        useAI: false,
        useManual: false,
        settings: {
          speechRecognition: {
            service: 'default',
            host: ''
          }
        }
      };

      const result = cleanupAppData(appData);

      expect(result.id).toBe('test-app');
      expect(result.name).toEqual({ en: 'Test App' });
      expect(result.useTemplate).toBeUndefined();
      expect(result.useAI).toBeUndefined();
      expect(result.useManual).toBeUndefined();
      expect(result.settings.speechRecognition).toBeUndefined();
    });

    test('should keep valid fields and valid speechRecognition', () => {
      const appData = {
        id: 'test-app',
        name: { en: 'Test App' },
        description: { en: 'Test Description' },
        useTemplate: true,
        settings: {
          enabled: true,
          speechRecognition: {
            service: 'custom',
            host: 'https://speech.example.com'
          }
        }
      };

      const result = cleanupAppData(appData);

      expect(result.id).toBe('test-app');
      expect(result.name).toEqual({ en: 'Test App' });
      expect(result.description).toEqual({ en: 'Test Description' });
      expect(result.useTemplate).toBeUndefined();
      expect(result.settings.enabled).toBe(true);
      expect(result.settings.speechRecognition).toBeDefined();
      expect(result.settings.speechRecognition.host).toBe('https://speech.example.com');
    });
  });
});
