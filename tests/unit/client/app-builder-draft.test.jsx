// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The draft of a new app (`client/src/features/admin/utils/appDraft.js`): one
 * function per way to start, and the step from a draft to the body of
 * `POST /api/admin/apps`. Every start has its own rule for the languages of
 * the stored app, and every body is checked against the real app schema.
 */
import fs from 'fs';
import path from 'path';
import {
  appCategoryOptions,
  buildCreatePayload,
  contentLanguage,
  draftForLink,
  draftFromBlank,
  draftFromExistingApp,
  draftFromGenerated,
  draftFromTemplate,
  dropOtherLanguages
} from '../../../client/src/features/admin/utils/appDraft.js';
import {
  DEFAULT_APP_CATEGORY,
  DEFAULT_APP_COLOR,
  DEFAULT_APP_ICON,
  UI_CREATES_PUBLISHED,
  newAppDefaults,
  primaryLanguageOf
} from '../../../shared/appDefaults.js';
import { RESERVED_APP_IDS, isValidAppId } from '../../../shared/appId.js';
import { unusedVariables } from '../../../shared/appPlaceholders.js';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';

const ROOT = path.resolve(__dirname, '../../..');

const shippedApp = id =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'server/defaults/apps', `${id}.json`), 'utf8'));

const copy = value => JSON.parse(JSON.stringify(value));

const without = (object, keys) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

function schemaIssues(app) {
  const result = appConfigSchema.safeParse(app);
  return result.success
    ? []
    : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
}

/**
 * Every localized text of an app with the languages it is stored in, as
 * `[path, languages]`. The greeting is left out: it is a default of the
 * product in English and German, not a text the author wrote.
 */
function localizedTexts(app) {
  const texts = [];
  const add = (label, value) => {
    if (value && typeof value === 'object') texts.push([label, Object.keys(value)]);
  };
  for (const field of ['name', 'description', 'system', 'prompt', 'messagePlaceholder']) {
    add(field, app[field]);
  }
  (app.variables || []).forEach((variable, index) => {
    for (const field of ['label', 'description', 'placeholder', 'defaultValue']) {
      add(`variables.${index}.${field}`, variable[field]);
    }
    (variable.predefinedValues || []).forEach((option, optionIndex) => {
      add(`variables.${index}.predefinedValues.${optionIndex}.label`, option.label);
    });
  });
  (app.starterPrompts || []).forEach((starter, index) => {
    for (const field of ['title', 'message', 'description']) {
      add(`starterPrompts.${index}.${field}`, starter[field]);
    }
  });
  return texts;
}

/** An item of `GET /api/admin/app-templates`, as README 5.2 of the rework describes it. */
const summarizerTemplate = {
  id: 'summarizer',
  name: { en: 'Summarizer', de: 'Zusammenfassung' },
  description: { en: 'Summarizes a text.', de: 'Fasst einen Text zusammen.' },
  icon: 'document-text',
  color: '#F59E0B',
  category: 'analysis',
  hasInputFields: true,
  app: {
    id: 'summarizer',
    name: { en: 'Summarizer', de: 'Zusammenfassung' },
    description: { en: 'Summarizes a text.', de: 'Fasst einen Text zusammen.' },
    icon: 'document-text',
    color: '#F59E0B',
    category: 'analysis',
    system: {
      en: 'You summarize the text the user pastes. Keep every fact.',
      de: 'Sie fassen den Text zusammen, den der Benutzer einfügt. Behalten Sie alle Fakten bei.'
    },
    prompt: {
      en: 'Length: {{length}}\n\n{{content}}',
      de: 'Länge: {{length}}\n\n{{content}}'
    },
    messagePlaceholder: { en: 'Paste a text…', de: 'Text einfügen…' },
    allowEmptyContent: false,
    variables: [
      {
        name: 'length',
        label: { en: 'Length', de: 'Länge' },
        description: { en: 'How long the summary is.', de: 'Wie lang die Zusammenfassung ist.' },
        type: 'select',
        required: true,
        defaultValue: { en: 'short', de: 'short' },
        predefinedValues: [
          { value: 'short', label: { en: 'Short', de: 'Kurz' } },
          { value: 'detailed', label: { en: 'Detailed', de: 'Ausführlich' } }
        ]
      }
    ],
    starterPrompts: [
      {
        title: { en: 'Meeting notes', de: 'Besprechungsnotizen' },
        message: { en: 'Summarize my meeting notes.', de: 'Fassen Sie meine Notizen zusammen.' }
      }
    ]
  }
};

/** The answer of `POST /api/admin/apps/_generate`, as README 5.2 of the rework describes it. */
const generated = () => ({
  app: {
    ...newAppDefaults('de'),
    id: 'einfache-sprache',
    name: { de: 'Einfache Sprache' },
    description: { de: 'Schreibt einen Text so um, dass ihn alle verstehen.' },
    system: { de: 'Sie schreiben Texte in einfacher Sprache um.' },
    prompt: { de: 'Leseniveau: {{level}}\n\n{{content}}' },
    allowEmptyContent: true,
    variables: [
      {
        name: 'level',
        label: { de: 'Leseniveau' },
        type: 'select',
        required: false,
        predefinedValues: [{ value: 'a2', label: { de: 'A2' } }]
      }
    ]
  },
  suggestions: {
    websearch: true,
    integrations: [
      { id: 'jira', label: 'Jira', actions: ['searchIssues', 'getIssue'] },
      { id: 'wiki-mcp', label: 'Wiki', actions: [] }
    ]
  },
  warnings: [],
  model: { id: 'gemini-flash', name: 'Gemini Flash' },
  brief: 'standard'
});

/** A draft as the Essentials screen leaves it: the texts the author owes are filled. */
function filled(draft, language) {
  const text = (value, fallback) =>
    Object.values(value || {}).some(entry => entry.trim()) ? value : { [language]: fallback };
  const result = {
    ...draft,
    id: draft.id || 'mein-helfer',
    name: text(draft.name, 'Mein Helfer'),
    description: text(draft.description, 'Hilft bei Fragen.')
  };
  if (result.type === 'chat') result.system = text(draft.system, 'Sie helfen bei Fragen.');
  return result;
}

describe('contentLanguage', () => {
  test.each([
    ['en', undefined, 'en'],
    ['en-US', undefined, 'en'],
    ['de', undefined, 'de'],
    ['de-DE', 'en', 'de'],
    ['DE-de', 'en', 'de'],
    ['fr-CA', 'en', 'fr'],
    [undefined, 'de', 'de'],
    ['', 'de', 'de'],
    ['cimode', 'de', 'de'],
    [undefined, 'de-AT', 'de'],
    [undefined, undefined, 'en'],
    ['???', '???', 'en']
  ])('UI %p, platform default %p: %p', (uiLanguage, platformDefault, expected) => {
    expect(contentLanguage(uiLanguage, platformDefault)).toBe(expected);
  });
});

describe('appCategoryOptions', () => {
  const uiConfig = {
    appsList: {
      categories: {
        list: [
          { id: 'all', name: { en: 'All' } },
          { id: 'writing', name: { en: 'Writing' } },
          { id: 'utility' }
        ]
      }
    }
  };

  test('lists the ui.json categories without "all"', () => {
    expect(appCategoryOptions(uiConfig)).toEqual([
      { id: 'writing', name: { en: 'Writing' } },
      { id: 'utility', name: 'utility' }
    ]);
  });

  test('keeps a category the app has that the list does not know', () => {
    expect(appCategoryOptions(uiConfig, 'legal').map(category => category.id)).toEqual([
      'writing',
      'utility',
      'legal'
    ]);
    expect(appCategoryOptions(uiConfig, 'writing')).toHaveLength(2);
  });

  test('is empty without a UI configuration', () => {
    expect(appCategoryOptions(null)).toEqual([]);
    expect(appCategoryOptions({ appsList: { categories: { list: 'broken' } } })).toEqual([]);
  });
});

describe('the locale table', () => {
  describe.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['de', 'de'],
    ['de-DE', 'de']
  ])('UI language %s', (locale, base) => {
    const language = contentLanguage(locale);

    test(`the content language is ${base}`, () => {
      expect(language).toBe(base);
    });

    test('an empty start stores name, short description and instructions under it', () => {
      const draft = draftFromBlank(language);

      expect(localizedTexts(draft)).toEqual([
        ['name', [base]],
        ['description', [base]],
        ['system', [base]]
      ]);
    });

    test('a template start stores every text under it, input placeholder and field labels included', () => {
      const draft = draftFromTemplate(summarizerTemplate, { language });
      const texts = Object.fromEntries(localizedTexts(draft));

      expect(texts).toMatchObject({
        name: [base],
        description: [base],
        system: [base],
        prompt: [base],
        messagePlaceholder: [base],
        'variables.0.label': [base],
        'variables.0.predefinedValues.0.label': [base],
        'variables.0.predefinedValues.1.label': [base]
      });
      for (const [, languages] of localizedTexts(draft)) expect(languages).toEqual([base]);
    });

    test('a link start stores name and short description under it', () => {
      const draft = draftForLink({ language, mode: 'redirect', url: 'https://example.com' });

      expect(localizedTexts(draft)).toEqual([
        ['name', [base]],
        ['description', [base]]
      ]);
    });

    test('the regional tag itself gives the same drafts', () => {
      expect(draftFromBlank(locale)).toEqual(draftFromBlank(base));
      expect(draftFromTemplate(summarizerTemplate, { language: locale })).toEqual(
        draftFromTemplate(summarizerTemplate, { language: base })
      );
      expect(draftForLink({ language: locale, mode: 'iframe' })).toEqual(
        draftForLink({ language: base, mode: 'iframe' })
      );
    });

    test('what is sent for an empty start has the typed texts under it, and no other language', () => {
      const draft = draftFromBlank(language);
      draft.id = 'helper';
      draft.name[language] = 'Helper';
      draft.description[language] = 'Answers questions';
      draft.system[language] = 'You answer questions.';

      const payload = buildCreatePayload(draft);

      expect(payload.name).toEqual({ [base]: 'Helper' });
      expect(payload.description).toEqual({ [base]: 'Answers questions' });
      expect(payload.system).toEqual({ [base]: 'You answer questions.' });
      expect(schemaIssues(payload)).toEqual([]);
    });
  });
});

describe('draftFromBlank', () => {
  test('is the defaults of a new chat app, without an ID', () => {
    expect(draftFromBlank('de')).toEqual(newAppDefaults('de'));
    expect(draftFromBlank('de').id).toBe('');
  });

  test('in a German UI the app has name.de only', () => {
    const draft = draftFromBlank(contentLanguage('de-DE', 'en'));

    expect(draft.name).toEqual({ de: '' });
    expect(draft.name).not.toHaveProperty('en');
  });

  test('is not published', () => {
    expect(draftFromBlank('en').enabled).toBe(UI_CREATES_PUBLISHED);
    expect(UI_CREATES_PUBLISHED).toBe(false);
  });
});

describe('draftFromTemplate', () => {
  const german = () => draftFromTemplate(summarizerTemplate, { language: 'de' });

  test('in a German UI every localized text has de only, and no en', () => {
    const texts = localizedTexts(german());

    expect(texts.length).toBeGreaterThanOrEqual(10);
    for (const [label, languages] of texts) {
      expect([label, languages]).toEqual([label, ['de']]);
    }
  });

  test('takes the German texts, not the English ones under another key', () => {
    const draft = german();

    expect(draft.name).toEqual({ de: 'Zusammenfassung' });
    expect(draft.description).toEqual({ de: 'Fasst einen Text zusammen.' });
    expect(draft.system.de).toMatch(/^Sie fassen den Text zusammen/);
    expect(draft.prompt).toEqual({ de: 'Länge: {{length}}\n\n{{content}}' });
    expect(draft.messagePlaceholder).toEqual({ de: 'Text einfügen…' });
    expect(draft.variables).toEqual([
      {
        name: 'length',
        label: { de: 'Länge' },
        description: { de: 'Wie lang die Zusammenfassung ist.' },
        type: 'select',
        required: true,
        defaultValue: { de: 'short' },
        predefinedValues: [
          { value: 'short', label: { de: 'Kurz' } },
          { value: 'detailed', label: { de: 'Ausführlich' } }
        ]
      }
    ]);
    expect(draft.starterPrompts).toEqual([
      {
        title: { de: 'Besprechungsnotizen' },
        message: { de: 'Fassen Sie meine Notizen zusammen.' }
      }
    ]);
  });

  test('for another content language the English text is the starting text, stored under that language', () => {
    const draft = draftFromTemplate(summarizerTemplate, { language: 'fr' });

    expect(draft.name).toEqual({ fr: 'Summarizer' });
    expect(draft.system).toEqual({ fr: summarizerTemplate.app.system.en });
    expect(draft.variables[0].predefinedValues[0].label).toEqual({ fr: 'Short' });
    for (const [, languages] of localizedTexts(draft)) expect(languages).toEqual(['fr']);
  });

  test('takes icon, colour and category of the template, and the defaults for everything else', () => {
    const draft = german();
    const defaults = newAppDefaults('de');

    expect(draft).toMatchObject({ icon: 'document-text', color: '#F59E0B', category: 'analysis' });
    for (const key of ['type', 'enabled', 'greeting', 'inputMode', 'upload', 'sendChatHistory']) {
      expect(draft[key]).toEqual(defaults[key]);
    }
    expect(draft.enabled).toBe(false);
  });

  test('the ID comes from the name and is free; the name gets no "(copy)"', () => {
    expect(german().id).toBe('zusammenfassung');
    expect(draftFromTemplate(summarizerTemplate, { language: 'en' }).id).toBe('summarizer');
    expect(
      draftFromTemplate(summarizerTemplate, {
        language: 'en',
        isTaken: id => ['summarizer', 'summarizer-2'].includes(id)
      }).id
    ).toBe('summarizer-3');
    expect(
      draftFromTemplate(summarizerTemplate, { language: 'en', isTaken: ['summarizer'] }).id
    ).toBe('summarizer-2');
    expect(german().name.de).not.toMatch(/\(/);
  });

  test('a name without Latin letters falls back to the ID of the template', () => {
    const template = {
      ...summarizerTemplate,
      app: { ...summarizerTemplate.app, name: { ja: '要約' } }
    };

    expect(draftFromTemplate(template, { language: 'ja' }).id).toBe('summarizer');
  });

  test('takes over nothing a template must not set', () => {
    const hostile = {
      ...summarizerTemplate,
      app: {
        ...summarizerTemplate.app,
        enabled: true,
        type: 'iframe',
        iframeConfig: { url: 'https://example.com' },
        websearch: { enabled: true },
        integrations: { jira: {} },
        projects: ['meeting-knowledge-base'],
        preferredModel: 'gpt-4',
        upload: { enabled: true },
        settings: { enabled: false },
        parentId: 'chat',
        order: 7
      }
    };

    expect(draftFromTemplate(hostile, { language: 'de' })).toEqual(german());
  });

  test('accepts the content of a template without the list item around it', () => {
    expect(draftFromTemplate(summarizerTemplate.app, { language: 'de' })).toEqual(german());
  });

  test('the fields of the list item stand in for what its app leaves out', () => {
    const moved = ['name', 'description', 'icon', 'color', 'category'];
    for (const key of moved) expect(summarizerTemplate).toHaveProperty(key);
    const rest = without(summarizerTemplate.app, moved);

    expect(draftFromTemplate({ ...summarizerTemplate, app: rest }, { language: 'de' })).toEqual(
      german()
    );
  });

  test('every input field is still used by a text', () => {
    expect(unusedVariables(german())).toEqual([]);
  });

  test('is created as it stands: the body passes the app schema', () => {
    for (const language of ['de', 'en', 'fr']) {
      const payload = buildCreatePayload(draftFromTemplate(summarizerTemplate, { language }));

      expect(schemaIssues(payload)).toEqual([]);
      expect(payload.enabled).toBe(false);
    }
  });

  test('does not modify the template', () => {
    const snapshot = copy(summarizerTemplate);

    const draft = german();
    draft.variables[0].predefinedValues.push({ value: 'x', label: { de: 'X' } });

    expect(summarizerTemplate).toEqual(snapshot);
  });
});

describe('draftFromExistingApp', () => {
  const source = {
    id: 'email-composer',
    order: 4,
    name: { en: 'Email Composer', de: 'E-Mail-Verfasser' },
    description: { en: 'Drafts emails', de: 'Entwirft E-Mails' },
    color: '#0EA5E9',
    icon: 'mail',
    system: { en: 'You draft emails.', de: 'Sie entwerfen E-Mails.' },
    prompt: { en: 'Tone: {{tone}}\n{{content}}', de: 'Ton: {{tone}}\n{{content}}' },
    variables: [{ name: 'tone', label: { en: 'Tone', de: 'Ton' }, type: 'string' }],
    enabled: true,
    websearch: { enabled: true },
    integrations: { jira: { actions: ['searchIssues'] } },
    upload: { enabled: true, fileUpload: { enabled: true, maxFileSizeMB: 5 } },
    allowInheritance: true,
    parentId: 'chat',
    inheritanceLevel: 1,
    overriddenFields: ['system']
  };
  const copyLabel = name => `${name} (copy)`;

  test('copies everything, in every language', () => {
    const draft = draftFromExistingApp(source, { copyLabel });

    expect(without(draft, ['id', 'name', 'enabled'])).toEqual(
      without(source, [
        'id',
        'name',
        'enabled',
        'order',
        'allowInheritance',
        'parentId',
        'inheritanceLevel',
        'overriddenFields'
      ])
    );
    expect(Object.keys(draft.system)).toEqual(['en', 'de']);
    expect(Object.keys(draft.description)).toEqual(['en', 'de']);
  });

  test('leaves the lineage and the list position behind', () => {
    const draft = draftFromExistingApp(source, { copyLabel });

    for (const key of [
      'parentId',
      'inheritanceLevel',
      'overriddenFields',
      'allowInheritance',
      'order'
    ]) {
      expect(draft).not.toHaveProperty(key);
    }
  });

  test('every language of the name gets the "(copy)" label', () => {
    expect(draftFromExistingApp(source, { copyLabel }).name).toEqual({
      en: 'Email Composer (copy)',
      de: 'E-Mail-Verfasser (copy)'
    });
  });

  test('the label function is told the language of each name', () => {
    const perLanguage = (name, language) => `${name} (${language === 'de' ? 'Kopie' : 'copy'})`;

    expect(draftFromExistingApp(source, { copyLabel: perLanguage }).name).toEqual({
      en: 'Email Composer (copy)',
      de: 'E-Mail-Verfasser (Kopie)'
    });
  });

  test('a suffix can stand in for the function', () => {
    expect(draftFromExistingApp(source, { copyLabel: ' (Kopie) ' }).name).toEqual({
      en: 'Email Composer (Kopie)',
      de: 'E-Mail-Verfasser (Kopie)'
    });
  });

  test('is not published, whatever the source is', () => {
    expect(draftFromExistingApp(source, { copyLabel }).enabled).toBe(false);
    expect(draftFromExistingApp({ ...source, enabled: false }, { copyLabel }).enabled).toBe(false);
    expect(draftFromExistingApp(without(source, ['enabled']), { copyLabel }).enabled).toBe(false);
  });

  test('the ID follows the name of the copy, in the language the screen edits', () => {
    expect(draftFromExistingApp(source, { copyLabel }).id).toBe('email-composer-copy');
    expect(draftFromExistingApp(source, { copyLabel, language: 'en-US' }).id).toBe(
      'email-composer-copy'
    );
    expect(draftFromExistingApp(source, { copyLabel, language: 'de-DE' }).id).toBe(
      'e-mail-verfasser-copy'
    );
    expect(primaryLanguageOf(source, 'de-DE')).toBe('de');
  });

  test('the ID is free', () => {
    const taken = ['email-composer-copy', 'email-composer-copy-2'];

    expect(draftFromExistingApp(source, { copyLabel, isTaken: id => taken.includes(id) }).id).toBe(
      'email-composer-copy-3'
    );
    expect(draftFromExistingApp(source, { copyLabel, isTaken: taken }).id).toBe(
      'email-composer-copy-3'
    );
  });

  test('never the ID of the source, also without a label and without a list of apps', () => {
    const plain = { ...source, name: { en: 'Email composer' } };

    expect(draftFromExistingApp(plain).id).toBe('email-composer-2');
    expect(draftFromExistingApp(plain, {}).name).toEqual({ en: 'Email composer' });
  });

  test('a name without Latin letters falls back to the ID of the source', () => {
    const japanese = { ...source, name: { ja: '要約' } };

    expect(draftFromExistingApp(japanese, { copyLabel: name => `${name}（コピー）` }).id).toBe(
      'email-composer-2'
    );
  });

  test('a German-only app stays German-only', () => {
    const germanOnly = {
      ...source,
      name: { de: 'E-Mail-Verfasser' },
      description: { de: 'Entwirft E-Mails' },
      system: { de: 'Sie entwerfen E-Mails.' }
    };

    const draft = draftFromExistingApp(germanOnly, {
      copyLabel: name => `${name} (Kopie)`,
      language: 'en'
    });

    expect(draft.name).toEqual({ de: 'E-Mail-Verfasser (Kopie)' });
    expect(draft.id).toBe('e-mail-verfasser-kopie');
  });

  test('does not modify the source, and shares nothing with it', () => {
    const snapshot = copy(source);

    const draft = draftFromExistingApp(source, { copyLabel });
    draft.variables[0].label.en = 'Changed';
    draft.integrations.jira.actions.push('getIssue');

    expect(source).toEqual(snapshot);
  });

  test.each(['email-composer', 'chat', 'external-website-intrafind', 'embedded-website-wikipedia'])(
    'a copy of the shipped app %s is created as it stands',
    id => {
      const draft = draftFromExistingApp(shippedApp(id), { copyLabel });

      const payload = buildCreatePayload(draft);

      expect(schemaIssues(payload)).toEqual([]);
      expect(payload.enabled).toBe(false);
      expect(payload.id).not.toBe(id);
      for (const key of ['parentId', 'inheritanceLevel', 'overriddenFields']) {
        expect(payload).not.toHaveProperty(key);
      }
    }
  );
});

describe('dropOtherLanguages', () => {
  const draft = () =>
    draftFromExistingApp(
      {
        id: 'email-composer',
        name: { en: 'Email Composer', de: 'E-Mail-Verfasser' },
        description: { en: 'Drafts emails', de: 'Entwirft E-Mails' },
        system: { en: 'You draft emails.', de: 'Sie entwerfen E-Mails.' },
        prompt: { en: '{{content}}', de: '{{content}}' },
        color: '#0EA5E9',
        icon: 'mail'
      },
      { copyLabel: name => `${name} (copy)` }
    );

  test('a copy of an en+de app keeps both languages until the author changes a text', () => {
    const copied = draft();

    expect(Object.keys(copied.name)).toEqual(['en', 'de']);
    expect(Object.keys(copied.system)).toEqual(['en', 'de']);
    expect(dropOtherLanguages(copied, [])).toEqual(copied);
  });

  test('after the instructions changed, system has one language and name still has two', () => {
    const copied = draft();
    const language = primaryLanguageOf(copied, 'de-DE');
    copied.system[language] = 'Sie entwerfen kurze E-Mails.';

    const result = dropOtherLanguages(copied, ['system'], language);

    expect(result.system).toEqual({ de: 'Sie entwerfen kurze E-Mails.' });
    expect(Object.keys(result.name)).toEqual(['en', 'de']);
    expect(Object.keys(result.description)).toEqual(['en', 'de']);
    expect(Object.keys(result.prompt)).toEqual(['en', 'de']);
  });

  test('without a language it keeps the one primaryLanguageOf names for the draft', () => {
    const copied = draft();
    copied.system.en = 'You draft short emails.';

    const result = dropOtherLanguages(copied, ['system']);

    expect(primaryLanguageOf(copied)).toBe('en');
    expect(result.system).toEqual({ en: 'You draft short emails.' });
    expect(Object.keys(result.name)).toEqual(['en', 'de']);
  });

  test('every changed text loses its other languages', () => {
    const result = dropOtherLanguages(draft(), ['name', 'description', 'system'], 'de');

    expect(result.name).toEqual({ de: 'E-Mail-Verfasser (copy)' });
    expect(result.description).toEqual({ de: 'Entwirft E-Mails' });
    expect(result.system).toEqual({ de: 'Sie entwerfen E-Mails.' });
  });

  test('only name, short description and instructions are ever reduced', () => {
    const copied = draft();

    const result = dropOtherLanguages(copied, ['prompt', 'greeting', 'nonsense'], 'de');

    expect(result).toEqual(copied);
  });

  test('a text without the edited language keeps what it has', () => {
    const copied = { ...draft(), system: { en: 'You draft emails.', fr: 'Vous rédigez.' } };

    expect(dropOtherLanguages(copied, ['system'], 'de').system).toEqual(copied.system);
  });

  test('a text in one language is left alone', () => {
    const copied = { ...draft(), system: { en: 'You draft emails.' } };

    expect(dropOtherLanguages(copied, ['system'], 'de').system).toEqual({
      en: 'You draft emails.'
    });
  });

  test('does not modify the draft', () => {
    const copied = draft();
    const snapshot = copy(copied);

    dropOtherLanguages(copied, ['name', 'system'], 'de');

    expect(copied).toEqual(snapshot);
  });
});

describe('draftFromGenerated', () => {
  test("with nothing ticked the draft is the server's app: no web search, no connected system", () => {
    const result = generated();

    const draft = draftFromGenerated(result);

    expect(draft).toEqual(result.app);
    expect(draft).not.toHaveProperty('websearch');
    expect(draft).not.toHaveProperty('integrations');
    expect(draftFromGenerated(result, {})).toEqual(result.app);
  });

  test('ticking web search switches it on', () => {
    const draft = draftFromGenerated(generated(), { webSearch: true });

    expect(draft.websearch).toEqual({ enabled: true });
    expect(draft).not.toHaveProperty('integrations');
  });

  test('ticking one connected system binds exactly that one, with the actions the server listed', () => {
    const draft = draftFromGenerated(generated(), { integrationIds: ['jira'] });

    expect(draft.integrations).toEqual({ jira: { actions: ['searchIssues', 'getIssue'] } });
    expect(draft).not.toHaveProperty('websearch');
  });

  test('a connected system without declared actions is bound whole', () => {
    const draft = draftFromGenerated(generated(), { integrationIds: ['wiki-mcp', 'jira'] });

    expect(draft.integrations).toEqual({
      jira: { actions: ['searchIssues', 'getIssue'] },
      'wiki-mcp': {}
    });
  });

  test('what the server did not suggest cannot be ticked', () => {
    const result = generated();
    result.suggestions = { websearch: false, integrations: [] };

    const draft = draftFromGenerated(result, {
      webSearch: true,
      integrationIds: ['jira', 'confluence']
    });

    expect(draft).not.toHaveProperty('websearch');
    expect(draft).not.toHaveProperty('integrations');
    expect(draftFromGenerated({ app: result.app }, { webSearch: true })).toEqual(result.app);
  });

  test('a binding the app itself carries is dropped unless it was ticked', () => {
    const result = generated();
    result.app.websearch = { enabled: true };
    result.app.integrations = { jira: {}, confluence: {} };

    expect(draftFromGenerated(result)).not.toHaveProperty('websearch');
    expect(draftFromGenerated(result)).not.toHaveProperty('integrations');
    expect(draftFromGenerated(result, { integrationIds: ['jira'] }).integrations).toEqual({
      jira: { actions: ['searchIssues', 'getIssue'] }
    });
  });

  test('only the app and the ticked suggestions reach the draft, nothing else of the answer', () => {
    const result = { ...generated(), raw: '{"type":"iframe"}', type: 'iframe', parentId: 'chat' };

    const draft = draftFromGenerated(result, { webSearch: true, integrationIds: ['jira'] });

    expect(Object.keys(draft).sort()).toEqual(
      [...Object.keys(result.app), 'websearch', 'integrations'].sort()
    );
    expect(draft.type).toBe('chat');
  });

  test('unticking the input fields removes them and the template lines that use them', () => {
    const draft = draftFromGenerated(generated(), { inputFields: false });

    expect(draft.variables).toEqual([]);
    expect(draft.prompt).toEqual({ de: '{{content}}' });
    // Sending without a message was allowed only because of the fields.
    expect(draft.allowEmptyContent).toBe(false);
  });

  test('the input fields stay by default', () => {
    const result = generated();

    expect(draftFromGenerated(result, { inputFields: true }).variables).toEqual(
      result.app.variables
    );
    expect(draftFromGenerated(result).allowEmptyContent).toBe(true);
  });

  test('is not published, whatever the answer says', () => {
    const result = generated();
    result.app.enabled = true;

    expect(draftFromGenerated(result).enabled).toBe(false);
  });

  test('every combination of ticks gives a body the app schema accepts', () => {
    for (const webSearch of [false, true]) {
      for (const integrationIds of [[], ['jira'], ['jira', 'wiki-mcp']]) {
        for (const inputFields of [true, false]) {
          const payload = buildCreatePayload(
            draftFromGenerated(generated(), { webSearch, integrationIds, inputFields })
          );

          expect(schemaIssues(payload)).toEqual([]);
          expect(unusedVariables(payload)).toEqual([]);
        }
      }
    }
  });

  test('does not modify the answer', () => {
    const result = generated();
    const snapshot = copy(result);

    const draft = draftFromGenerated(result, { webSearch: true, integrationIds: ['jira'] });
    draft.integrations.jira.actions.push('deleteIssue');
    draft.variables.length = 0;

    expect(result).toEqual(snapshot);
  });

  test('an answer without an app gives an empty draft, not an error', () => {
    expect(draftFromGenerated(undefined)).toEqual({ enabled: false });
    expect(draftFromGenerated({})).toEqual({ enabled: false });
  });
});

describe('draftForLink', () => {
  test('"Open the website" is a redirect app', () => {
    const draft = draftForLink({ language: 'de', mode: 'redirect', url: ' https://example.com ' });

    expect(draft).toEqual({
      id: '',
      type: 'redirect',
      order: 0,
      name: { de: '' },
      description: { de: '' },
      color: DEFAULT_APP_COLOR,
      icon: DEFAULT_APP_ICON,
      category: DEFAULT_APP_CATEGORY,
      enabled: false,
      redirectConfig: { url: 'https://example.com', openInNewTab: true, showWarning: true }
    });
  });

  test('"Show the website inside iHub" is an iframe app', () => {
    const draft = draftForLink({ language: 'en', mode: 'iframe', url: 'https://example.com' });

    expect(draft.type).toBe('iframe');
    expect(draft.iframeConfig).toEqual({
      url: 'https://example.com',
      allowFullscreen: true,
      sandbox: ['allow-scripts', 'allow-same-origin', 'allow-forms']
    });
    expect(draft).not.toHaveProperty('redirectConfig');
  });

  test('has no instructions and none of the chat settings', () => {
    for (const mode of ['redirect', 'iframe']) {
      const draft = draftForLink({ language: 'en', mode });

      for (const key of ['system', 'variables', 'greeting', 'inputMode', 'upload', 'prompt']) {
        expect(draft).not.toHaveProperty(key);
      }
    }
  });

  test('without an address the field starts empty; any other mode opens the website', () => {
    expect(draftForLink({ language: 'en', mode: 'redirect' }).redirectConfig.url).toBe('');
    expect(draftForLink({ language: 'en' }).type).toBe('redirect');
    expect(draftForLink().type).toBe('redirect');
  });

  test.each(['redirect', 'iframe'])('a filled %s draft is an app the server accepts', mode => {
    const draft = filled(
      draftForLink({ language: 'de', mode, url: 'https://example.com/hilfe' }),
      'de'
    );

    const payload = buildCreatePayload(draft);

    expect(schemaIssues(payload)).toEqual([]);
    expect(payload.enabled).toBe(false);
  });

  test('an address that is no http(s) address is refused by the server, not rewritten here', () => {
    const draft = filled(
      draftForLink({ language: 'en', mode: 'redirect', url: 'javascript:1' }),
      'en'
    );

    expect(schemaIssues(buildCreatePayload(draft)).join('\n')).toMatch(/redirectConfig\.url/);
  });
});

describe('buildCreatePayload', () => {
  const draft = (extra = {}) => ({
    ...filled(draftFromBlank('de'), 'de'),
    ...extra
  });

  test('is the draft cleaned for saving', () => {
    const payload = buildCreatePayload(
      draft({ messagePlaceholder: { de: ' ' }, prompt: { de: '' }, name: { de: 'Helfer', en: '' } })
    );

    expect(payload.name).toEqual({ de: 'Helfer' });
    expect(payload).not.toHaveProperty('messagePlaceholder');
    expect(payload).not.toHaveProperty('prompt');
    // Uploads are off in a new app, so the block is not stored.
    expect(payload).not.toHaveProperty('upload');
    expect(schemaIssues(payload)).toEqual([]);
  });

  test('an empty start, filled in, is an unpublished app without lineage', () => {
    const payload = buildCreatePayload(draft());

    expect(payload.enabled).toBe(false);
    for (const key of ['parentId', 'inheritanceLevel', 'overriddenFields', 'allowInheritance']) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(schemaIssues(payload)).toEqual([]);
  });

  test('trims the ID', () => {
    expect(buildCreatePayload(draft({ id: '  mein-helfer ' })).id).toBe('mein-helfer');
  });

  test.each([
    ['', 'required'],
    [undefined, 'required'],
    ['   ', 'required'],
    ['Mein Helfer', 'format'],
    ['a'.repeat(51), 'tooLong'],
    ['_generate', 'reserved'],
    ...RESERVED_APP_IDS.map(id => [id, 'reserved'])
  ])('refuses the ID %p as %p', (id, problem) => {
    let error;
    try {
      buildCreatePayload(draft({ id }));
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'APP_ID_INVALID', field: 'id', problem });
  });

  test('accepts every ID the builder derives', () => {
    for (const id of ['mein-helfer', 'app', 'new-2', 'release-notes-v2.1', 'a'.repeat(50)]) {
      expect(isValidAppId(id)).toBe(true);
      expect(buildCreatePayload(draft({ id })).id).toBe(id);
    }
  });

  test('does not modify the draft', () => {
    const state = draft({ id: ' mein-helfer ', prompt: { de: '' } });
    const snapshot = copy(state);

    buildCreatePayload(state);

    expect(state).toEqual(snapshot);
  });
});

describe('no start needs to know who creates the app', () => {
  test('the module names no admin path and makes no request', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'client/src/features/admin/utils/appDraft.js'),
      'utf8'
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

    expect(code).not.toMatch(/\/admin\b/);
    expect(code).not.toMatch(/\bfetch\(|makeAdminApiCall|apiClient/);
  });
});
