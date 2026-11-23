// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the app editor and the create page send to `POST` and
 * `PUT /api/admin/apps`: `cleanAppForSave` (`shared/appDefaults.js`). The
 * form keeps switched-off blocks and empty languages in its state; the stored
 * app does not.
 */
import { cleanAppForSave } from '../../../shared/appDefaults.js';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';

describe('cleanAppForSave', () => {
  describe('upload configuration', () => {
    test('removes the image upload block when it is switched off', () => {
      const result = cleanAppForSave({
        id: 'test-app',
        upload: {
          enabled: true,
          imageUpload: {
            enabled: false,
            maxFileSizeMB: 10,
            supportedFormats: ['image/jpeg', 'image/png']
          }
        }
      });

      expect(result.upload).toEqual({ enabled: true });
    });

    test('removes the file upload block when it is switched off', () => {
      const result = cleanAppForSave({
        id: 'test-app',
        upload: {
          enabled: true,
          fileUpload: { enabled: false, maxFileSizeMB: 5, supportedFormats: ['text/plain'] }
        }
      });

      expect(result.upload).toEqual({ enabled: true });
    });

    test('removes the whole upload block when uploads are off', () => {
      const result = cleanAppForSave({
        id: 'test-app',
        upload: {
          enabled: false,
          imageUpload: { enabled: true, maxFileSizeMB: 10 },
          fileUpload: { enabled: true, maxFileSizeMB: 5 }
        }
      });

      expect(result).not.toHaveProperty('upload');
    });

    test('keeps the blocks that are switched on, and the settings beside them', () => {
      const upload = {
        enabled: true,
        allowMultiple: true,
        imageUpload: { enabled: true, maxFileSizeMB: 10, supportedFormats: ['image/jpeg'] },
        fileUpload: { enabled: true, maxFileSizeMB: 5, supportedFormats: ['text/plain'] },
        audioUpload: { enabled: false }
      };

      const result = cleanAppForSave({ id: 'test-app', upload });

      expect(result.upload).toEqual(upload);
    });

    test('an app without an upload block gets none', () => {
      expect(cleanAppForSave({ id: 'test-app' })).toEqual({ id: 'test-app' });
    });
  });

  describe('features configuration', () => {
    test('removes a switched-off magic prompt, and the features block with it', () => {
      const result = cleanAppForSave({
        id: 'test-app',
        features: { magicPrompt: { enabled: false, model: 'gpt-4', prompt: 'Some prompt' } }
      });

      expect(result).not.toHaveProperty('features');
    });

    test('keeps a switched-on magic prompt', () => {
      const features = {
        magicPrompt: { enabled: true, model: 'gpt-4', prompt: 'Improve this prompt' }
      };

      expect(cleanAppForSave({ id: 'test-app', features }).features).toEqual(features);
    });

    test('keeps the other feature switches when the magic prompt goes', () => {
      const result = cleanAppForSave({
        id: 'test-app',
        features: { magicPrompt: { enabled: false }, feedback: false, projects: true }
      });

      expect(result.features).toEqual({ feedback: false, projects: true });
    });
  });

  describe('input fields', () => {
    test('removes a default value that is empty in every language', () => {
      const result = cleanAppForSave({
        id: 'test-app',
        variables: [{ name: 'tone', defaultValue: { en: '', de: '' } }]
      });

      expect(result.variables).toEqual([{ name: 'tone' }]);
    });

    test('keeps a default value that one language sets', () => {
      const variables = [{ name: 'tone', defaultValue: { en: 'formal', de: '' } }];

      expect(cleanAppForSave({ id: 'test-app', variables }).variables).toEqual(variables);
    });

    test('removes an empty list of options and keeps a filled one', () => {
      const option = { value: 'short', label: { en: 'Short' } };
      const result = cleanAppForSave({
        id: 'test-app',
        variables: [
          { name: 'tone', predefinedValues: [] },
          { name: 'length', predefinedValues: [option] }
        ]
      });

      expect(result.variables).toEqual([
        { name: 'tone' },
        { name: 'length', predefinedValues: [option] }
      ]);
    });
  });

  describe('texts in several languages', () => {
    const app = (extra = {}) => ({
      id: 'helper',
      name: { en: 'Helper' },
      description: { en: 'Answers questions' },
      color: '#4F46E5',
      icon: 'chat-bubbles',
      system: { en: 'You are a helpful assistant.' },
      ...extra
    });

    test('name, short description and instructions lose their empty languages', () => {
      const result = cleanAppForSave(
        app({
          name: { en: '', de: 'Helfer' },
          description: { en: ' ', de: 'Hilft' },
          system: { en: '', de: 'Sie helfen.' }
        })
      );

      expect(result.name).toEqual({ de: 'Helfer' });
      expect(result.description).toEqual({ de: 'Hilft' });
      expect(result.system).toEqual({ de: 'Sie helfen.' });
    });

    test('a name or short description without any text stays, so the server names the field', () => {
      const result = cleanAppForSave(app({ name: { en: '' }, description: { en: '', de: ' ' } }));

      expect(result.name).toEqual({ en: '' });
      expect(result.description).toEqual({ en: '', de: ' ' });

      const issues = appConfigSchema
        .safeParse(result)
        .error.issues.map(issue => issue.path.join('.'));
      expect(issues).toEqual(expect.arrayContaining(['name.en', 'description.en']));
    });

    test('instructions without any text are left out: the schema does not require them', () => {
      const result = cleanAppForSave(app({ system: { en: '', de: '  ' } }));

      expect(result).not.toHaveProperty('system');
      expect(appConfigSchema.safeParse(result).success).toBe(true);
    });

    test('message template and input placeholder lose their empty languages', () => {
      const result = cleanAppForSave(
        app({
          messagePlaceholder: { en: 'Ask me', de: '  ' },
          prompt: { en: '', de: '{{content}}' }
        })
      );

      expect(result.messagePlaceholder).toEqual({ en: 'Ask me' });
      expect(result.prompt).toEqual({ de: '{{content}}' });
    });

    test('message template and input placeholder are left out when no language has text', () => {
      const result = cleanAppForSave(
        app({ messagePlaceholder: { en: '' }, prompt: { en: '', de: '' } })
      );

      expect(result).not.toHaveProperty('messagePlaceholder');
      expect(result).not.toHaveProperty('prompt');
      expect(appConfigSchema.safeParse(result).success).toBe(true);
    });

    test('a text that is complete is not touched', () => {
      const complete = app({
        name: { en: 'Helper', de: 'Helfer' },
        prompt: { en: 'Tone: {{tone}}\n{{content}}' }
      });

      expect(cleanAppForSave(complete)).toEqual(complete);
    });

    test('a text keeps its spaces and line breaks', () => {
      const system = { en: '  Line one\n\nLine two  ' };

      expect(cleanAppForSave(app({ system })).system).toEqual(system);
    });
  });

  describe('everything else', () => {
    test('is passed on as it is', () => {
      const other = {
        id: 'test-app',
        type: 'chat',
        enabled: false,
        color: '#4F46E5',
        parentId: 'chat',
        inheritanceLevel: 1,
        overriddenFields: ['system'],
        websearch: { enabled: true },
        integrations: { jira: { actions: ['searchIssues'] } },
        greeting: { en: { title: 'Hi', subtitle: 'Ask away' } },
        inputMode: { type: 'multiline', rows: 3 },
        starterPrompts: [{ title: { en: 'Start' }, message: { en: 'Go' } }]
      };

      expect(cleanAppForSave(other)).toEqual(other);
    });

    test('switched-off uploads and features go together, the rest stays', () => {
      const result = cleanAppForSave({
        id: 'test-app',
        name: { en: 'Test App' },
        description: { en: 'Test Description' },
        color: '#4F46E5',
        upload: { enabled: false, imageUpload: { enabled: true, maxFileSizeMB: 10 } },
        features: { magicPrompt: { enabled: false, model: 'gpt-4' } }
      });

      expect(result).toEqual({
        id: 'test-app',
        name: { en: 'Test App' },
        description: { en: 'Test Description' },
        color: '#4F46E5'
      });
    });

    test('the form state is not modified', () => {
      const state = {
        id: 'test-app',
        name: { en: '', de: 'Helfer' },
        system: { en: '' },
        prompt: { en: '' },
        variables: [{ name: 'tone', defaultValue: { en: '' }, predefinedValues: [] }],
        upload: { enabled: true, imageUpload: { enabled: false }, fileUpload: { enabled: false } },
        features: { magicPrompt: { enabled: false } }
      };
      const snapshot = JSON.parse(JSON.stringify(state));

      cleanAppForSave(state);

      expect(state).toEqual(snapshot);
    });

    test('cleaning twice changes nothing more', () => {
      const once = cleanAppForSave({
        id: 'test-app',
        name: { en: '', de: 'Helfer' },
        prompt: { en: ' ' },
        variables: [{ name: 'tone', defaultValue: { en: '' } }],
        upload: { enabled: true, imageUpload: { enabled: false } },
        features: { magicPrompt: { enabled: false }, feedback: true }
      });

      expect(cleanAppForSave(once)).toEqual(once);
    });
  });
});
