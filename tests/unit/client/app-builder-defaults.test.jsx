// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The defaults of an app (`shared/appDefaults.js`): what a new app starts
 * with, what the editor adds to a loaded app, and which language of an app the
 * UI edits first. What is sent on save is covered by
 * `admin-app-cleanup.test.jsx`, the pair of load and save by
 * `app-editor-roundtrip.test.jsx`.
 */
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_APP_CATEGORY,
  DEFAULT_APP_COLOR,
  DEFAULT_APP_ICON,
  UI_CREATES_PUBLISHED,
  cleanAppForSave,
  newAppDefaults,
  padLoadedApp,
  primaryLanguageOf
} from '../../../shared/appDefaults.js';
import { HEX_COLOR_PATTERN } from '../../../shared/validationPatterns.js';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';

const ROOT = path.resolve(__dirname, '../../..');

/** The issues of a refused app, as text, so a failing test names the field. */
function schemaIssues(app) {
  const result = appConfigSchema.safeParse(app);
  return result.success
    ? []
    : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
}

describe('the constants', () => {
  test('are the values the editor used for a new app', () => {
    expect(DEFAULT_APP_COLOR).toBe('#4F46E5');
    expect(DEFAULT_APP_COLOR).toMatch(HEX_COLOR_PATTERN);
    expect(DEFAULT_APP_ICON).toBe('chat-bubbles');
    expect(DEFAULT_APP_CATEGORY).toBe('utility');
  });

  test('an app created in the UI starts not published', () => {
    // README 6.3 of the app builder rework names what else changes when this is flipped.
    expect(UI_CREATES_PUBLISHED).toBe(false);
  });
});

describe('newAppDefaults', () => {
  test('is a chat app with empty texts in the given language', () => {
    const app = newAppDefaults('de');

    expect(app).toMatchObject({
      id: '',
      type: 'chat',
      name: { de: '' },
      description: { de: '' },
      system: { de: '' },
      color: DEFAULT_APP_COLOR,
      icon: DEFAULT_APP_ICON,
      category: DEFAULT_APP_CATEGORY,
      preferredOutputFormat: 'markdown',
      preferredStyle: 'keep',
      variables: [],
      starterPrompts: [],
      allowEmptyContent: false,
      sendChatHistory: true,
      ephemeral: false
    });
    expect(app.enabled).toBe(UI_CREATES_PUBLISHED);
    expect(app.upload.enabled).toBe(false);
    expect(app.inputMode).toEqual({
      type: 'singleline',
      rows: 5,
      microphone: { enabled: true, mode: 'manual', showTranscript: true }
    });
  });

  test('names no model: the standard model applies', () => {
    const app = newAppDefaults('en');

    expect(app).not.toHaveProperty('preferredModel');
    expect(app).not.toHaveProperty('allowedModels');
  });

  test('binds nothing', () => {
    const app = newAppDefaults('en');

    for (const key of ['websearch', 'integrations', 'projects', 'apps', 'workflows', 'skills']) {
      expect(app).not.toHaveProperty(key);
    }
  });

  test.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['de', 'de'],
    ['de-DE', 'de'],
    ['DE', 'de'],
    ['fr-CA', 'fr'],
    [undefined, 'en'],
    ['', 'en'],
    ['not a language', 'en']
  ])('the language %p stores the texts under %p', (language, base) => {
    const app = newAppDefaults(language);

    for (const field of ['name', 'description', 'system']) {
      expect(Object.keys(app[field])).toEqual([base]);
    }
  });

  test('is a new object on every call, down to its lists', () => {
    const first = newAppDefaults('en');
    first.name.en = 'Changed';
    first.variables.push({ name: 'x' });
    first.upload.fileUpload.supportedFormats.length = 0;
    first.greeting.en.title = 'Changed';
    first.inputMode.microphone.enabled = false;

    const second = newAppDefaults('en');

    expect(second.name).toEqual({ en: '' });
    expect(second.variables).toEqual([]);
    expect(second.upload.fileUpload.supportedFormats).toContain('application/pdf');
    expect(second.greeting.en.title).not.toBe('Changed');
    expect(second.inputMode.microphone.enabled).toBe(true);
  });

  describe('against the app schema', () => {
    test.each(['de', 'de-DE', 'en', 'en-US'])(
      'with ID, name and description filled it is an app the server accepts (%s)',
      language => {
        const base = language.slice(0, 2);
        const app = cleanAppForSave({
          ...newAppDefaults(language),
          id: 'vertrags-helfer',
          name: { [base]: 'Vertragshelfer' },
          description: { [base]: 'Beantwortet Fragen zu Verträgen.' }
        });

        expect(schemaIssues(app)).toEqual([]);
        expect(appConfigSchema.parse(app).enabled).toBe(false);
      }
    );

    test('with the instructions filled too it needs no cleaning', () => {
      const app = {
        ...newAppDefaults('de'),
        id: 'vertrags-helfer',
        name: { de: 'Vertragshelfer' },
        description: { de: 'Beantwortet Fragen zu Verträgen.' },
        system: { de: 'Sie beantworten Fragen zu Verträgen.' }
      };

      expect(schemaIssues(app)).toEqual([]);
    });

    test('the untouched defaults are refused for the texts the author still owes, and nothing else', () => {
      const fields = schemaIssues(newAppDefaults('de')).map(issue => issue.split(':')[0]);

      expect(fields.sort()).toEqual(['description.de', 'id', 'id', 'name.de', 'system.de'].sort());
    });
  });
});

describe('padLoadedApp', () => {
  const stored = {
    id: 'helfer',
    name: { de: 'Helfer' },
    description: { de: 'Hilft' },
    color: '#112233',
    icon: 'star',
    system: { de: 'Sie helfen.' }
  };

  test('adds the sections the form reads', () => {
    const app = padLoadedApp(stored);
    const defaults = newAppDefaults('de');

    expect(app.greeting).toEqual(defaults.greeting);
    expect(app.allowEmptyContent).toBe(false);
    expect(app.sendChatHistory).toBe(true);
    expect(app.ephemeral).toBe(false);
    expect(app.inputMode).toEqual(defaults.inputMode);
    expect(app.upload).toEqual(defaults.upload);
  });

  test('pads a loaded app with the same values a new app starts with', () => {
    const padded = padLoadedApp(stored);
    const defaults = newAppDefaults('de');

    for (const key of Object.keys(padded).filter(key => !(key in stored))) {
      expect(padded[key]).toEqual(defaults[key]);
    }
  });

  test('keeps every value the app carries', () => {
    const app = padLoadedApp({
      ...stored,
      greeting: { de: { title: 'Guten Tag', subtitle: 'Womit kann ich helfen?' } },
      allowEmptyContent: true,
      sendChatHistory: false,
      ephemeral: true,
      inputMode: { type: 'multiline', voiceMode: { enabled: true } },
      upload: {
        enabled: true,
        allowMultiple: true,
        fileUpload: { enabled: true, maxFileSizeMB: 5, supportedFormats: ['text/plain'] },
        audioUpload: { enabled: true }
      }
    });

    expect(app.greeting).toEqual({
      de: { title: 'Guten Tag', subtitle: 'Womit kann ich helfen?' }
    });
    expect(app.allowEmptyContent).toBe(true);
    expect(app.sendChatHistory).toBe(false);
    expect(app.ephemeral).toBe(true);
    expect(app.inputMode).toEqual({
      type: 'multiline',
      rows: 5,
      microphone: { enabled: true, mode: 'manual', showTranscript: true },
      voiceMode: { enabled: true }
    });
    expect(app.upload.enabled).toBe(true);
    expect(app.upload.allowMultiple).toBe(true);
    expect(app.upload.audioUpload).toEqual({ enabled: true });
    expect(app.upload.fileUpload).toEqual({
      enabled: true,
      maxFileSizeMB: 5,
      supportedFormats: ['text/plain']
    });
    // The block the app does not have is offered switched off.
    expect(app.upload.imageUpload).toMatchObject({ enabled: false, maxFileSizeMB: 10 });
  });

  test('leaves fields it does not know alone', () => {
    const app = padLoadedApp({
      ...stored,
      parentId: 'chat',
      inheritanceLevel: 1,
      overriddenFields: ['system'],
      toolApproval: { default: 'writes' }
    });

    expect(app).toMatchObject({
      parentId: 'chat',
      inheritanceLevel: 1,
      overriddenFields: ['system'],
      toolApproval: { default: 'writes' },
      name: { de: 'Helfer' }
    });
  });

  test('does not modify the loaded app', () => {
    const loaded = { ...stored, inputMode: { type: 'multiline' }, upload: { enabled: true } };
    const snapshot = JSON.parse(JSON.stringify(loaded));

    const padded = padLoadedApp(loaded);
    padded.inputMode.rows = 9;
    padded.upload.imageUpload.supportedFormats.push('image/bmp');

    expect(loaded).toEqual(snapshot);
    expect(padLoadedApp(stored).upload.imageUpload.supportedFormats).not.toContain('image/bmp');
  });
});

describe('primaryLanguageOf', () => {
  const germanOnly = { name: { de: 'Helfer' } };
  const both = { name: { en: 'Helper', de: 'Helfer' } };

  test('a German-only app is edited in German by an admin with an English UI', () => {
    expect(primaryLanguageOf(germanOnly, 'en')).toBe('de');
    expect(primaryLanguageOf(germanOnly, 'en-US', 'en')).toBe('de');
  });

  test('an app in English and German is edited in the language of the UI', () => {
    expect(primaryLanguageOf(both, 'de')).toBe('de');
    expect(primaryLanguageOf(both, 'de-DE')).toBe('de');
    expect(primaryLanguageOf(both, 'en-GB')).toBe('en');
  });

  test('an app without a name is edited in the language of the UI', () => {
    expect(primaryLanguageOf({}, 'de-DE')).toBe('de');
    expect(primaryLanguageOf({ name: { en: '' } }, 'de')).toBe('de');
    expect(primaryLanguageOf({ name: {} }, 'fr', 'en')).toBe('fr');
    expect(primaryLanguageOf(null, 'de')).toBe('de');
    expect(primaryLanguageOf(undefined, 'en-US')).toBe('en');
  });

  test.each([
    // UI language, platform default, languages of the name, expected
    ['fr', 'de', ['en', 'de'], 'de'],
    ['fr', 'es', ['de', 'en'], 'en'],
    ['fr', 'es', ['it', 'de'], 'it'],
    ['fr', undefined, ['de'], 'de'],
    ['de', 'en', ['en'], 'en'],
    ['de', 'en', ['de', 'en'], 'de']
  ])(
    'UI %p, platform default %p, name in %p: %p',
    (uiLanguage, platformDefault, languages, expected) => {
      const app = { name: Object.fromEntries(languages.map(language => [language, 'Name'])) };

      expect(primaryLanguageOf(app, uiLanguage, platformDefault)).toBe(expected);
    }
  );

  test('a language that holds no text does not count', () => {
    expect(primaryLanguageOf({ name: { en: '  ', de: 'Helfer' } }, 'en')).toBe('de');
  });

  test('without a usable UI language the platform default decides, then English', () => {
    expect(primaryLanguageOf(null, undefined, 'de')).toBe('de');
    expect(primaryLanguageOf(null, 'cimode', 'de')).toBe('de');
    expect(primaryLanguageOf(null)).toBe('en');
  });
});

describe('one default object', () => {
  /**
   * Literals that only the default object of an app contains: the default
   * greeting, the microphone defaults, and the end of the list of file types.
   */
  const MARKERS = [/👋/u, /showTranscript:\s*true/, /opendocument\.presentation/];

  function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(file);
      return /\.(js|jsx)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name) ? [file] : [];
    });
  }

  test('lives in shared/appDefaults.js', () => {
    const source = fs.readFileSync(path.join(ROOT, 'shared/appDefaults.js'), 'utf8');

    for (const marker of MARKERS) expect(source).toMatch(marker);
  });

  test('no file under client/src/features/admin holds a second one', () => {
    const offenders = sourceFiles(path.join(ROOT, 'client/src/features/admin'))
      .filter(file => {
        const source = fs.readFileSync(file, 'utf8');
        return MARKERS.some(marker => marker.test(source));
      })
      .map(file => path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });
});
