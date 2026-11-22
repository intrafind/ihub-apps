// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Opening an app in the editor and saving it without a change must not change
 * the app. This file checks that at the pure level: `padLoadedApp` is what the
 * editor adds on load, `cleanAppForSave` what it sends on save
 * (`shared/appDefaults.js`).
 *
 * The pair is not the identity: the editor has always written a few defaults
 * into an app that was saved once. Those are the entries of `NORMALISATIONS`
 * below, one per line with its reason. Anything else that differs is a field
 * the editor lost or changed, and fails here.
 *
 * The second half checks the same at the rendered level: the real form
 * (`AppFormEditor`) is mounted with the loaded app, and what it hands back is
 * what a save would send. The form must change nothing on its own, whatever
 * groups are open, and an edit must change the edited field only.
 */
import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { cleanAppForSave, newAppDefaults, padLoadedApp } from '../../../shared/appDefaults.js';
import { appConfigSchema, knownAppKeys } from '../../../server/validators/appConfigSchema.js';

jest.mock('react-i18next', () => require('./helpers/appFormHarness').i18nMock());
jest.mock('../../../client/src/api/adminApi', () =>
  require('./helpers/appFormHarness').adminApiMock()
);
jest.mock('../../../client/src/api/integrationsAdminApi', () =>
  require('./helpers/appFormHarness').adminApiMock()
);
jest.mock('../../../client/src/api/documentTemplatesAdminApi', () =>
  require('./helpers/appFormHarness').adminApiMock()
);
jest.mock('../../../client/src/api/endpoints/skills', () =>
  require('./helpers/appFormHarness').adminApiMock()
);
jest.mock('../../../client/src/api/endpoints/config', () =>
  require('./helpers/appFormHarness').configApiMock()
);
jest.mock('../../../client/src/api/client', () =>
  require('./helpers/appFormHarness').apiClientMock()
);
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () =>
  require('./helpers/appFormHarness').platformConfigMock()
);
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () =>
  require('./helpers/appFormHarness').featureFlagsMock()
);
jest.mock('../../../client/src/utils/runtimeBasePath', () =>
  require('./helpers/appFormHarness').basePathMock()
);
// The JSON mode's editor is Monaco, which does not run in jsdom. The switch
// between the modes, which is what the test is about, is the real one.
jest.mock('../../../client/src/shared/components/MonacoJsonEditor', () =>
  require('./helpers/appFormHarness').stubComponent('json-editor')
);

const ROOT = path.resolve(__dirname, '../../..');
const SHIPPED_APPS_DIR = path.join(ROOT, 'server/defaults/apps');

const copy = value => JSON.parse(JSON.stringify(value));
const roundTrip = app => cleanAppForSave(padLoadedApp(app));
const without = (object, key) =>
  Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

const DEFAULTS = newAppDefaults('en');

/**
 * What a load and a save change in an app, and nothing else may. Each entry
 * is `[what, why, (app) => app]`; the function gets a copy it may modify.
 */
const NORMALISATIONS = [
  [
    'greeting: the default greeting is written when the app has none',
    'the form shows a greeting for every app and saves what it shows',
    app => {
      if (!app.greeting) app.greeting = DEFAULTS.greeting;
      return app;
    }
  ],
  [
    'allowEmptyContent: false is written when the app does not say',
    'the checkbox has no third state',
    app => {
      app.allowEmptyContent ??= false;
      return app;
    }
  ],
  [
    'sendChatHistory: true is written when the app does not say',
    'the checkbox has no third state',
    app => {
      app.sendChatHistory ??= true;
      return app;
    }
  ],
  [
    'ephemeral: false is written when the app does not say',
    'the checkbox has no third state',
    app => {
      app.ephemeral ??= false;
      return app;
    }
  ],
  [
    'inputMode: type, rows and microphone get their defaults where the app sets none',
    'the form shows the three settings for every app; what the app sets wins, key by key',
    app => {
      app.inputMode = { ...DEFAULTS.inputMode, ...app.inputMode };
      return app;
    }
  ],
  [
    'upload: the block is removed when uploads are not switched on',
    'a switched-off block is not stored; this includes a block without "enabled"',
    app => {
      if (app.upload && app.upload.enabled !== true) delete app.upload;
      return app;
    }
  ],
  [
    'upload.imageUpload / upload.fileUpload: a switched-off block is removed',
    'a switched-off block is not stored',
    app => {
      for (const block of ['imageUpload', 'fileUpload']) {
        if (app.upload?.[block]?.enabled === false) delete app.upload[block];
      }
      return app;
    }
  ],
  [
    'variables[].defaultValue: removed when it is empty in every language',
    'an empty default is no default',
    app => {
      for (const variable of app.variables || []) {
        if (variable.defaultValue && !Object.values(variable.defaultValue).some(Boolean)) {
          delete variable.defaultValue;
        }
      }
      return app;
    }
  ],
  [
    'variables[].predefinedValues: an empty list is removed',
    'a field without options has no list',
    app => {
      for (const variable of app.variables || []) {
        if (variable.predefinedValues?.length === 0) delete variable.predefinedValues;
      }
      return app;
    }
  ],
  [
    'features.magicPrompt: removed when switched off, and "features" with it when nothing is left',
    'a switched-off block is not stored',
    app => {
      if (app.features?.magicPrompt?.enabled === false) delete app.features.magicPrompt;
      if (app.features && Object.keys(app.features).length === 0) delete app.features;
      return app;
    }
  ]
];

/** The app as a load and a save may leave it. */
function normalised(app) {
  return NORMALISATIONS.reduce((result, [, , apply]) => apply(result), copy(app));
}

/** The top-level keys in which two apps differ. */
function changedKeys(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    key => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  );
}

const shippedApps = fs
  .readdirSync(SHIPPED_APPS_DIR)
  .filter(file => file.endsWith('.json'))
  .sort()
  .map(file => [file, JSON.parse(fs.readFileSync(path.join(SHIPPED_APPS_DIR, file), 'utf8'))]);

/**
 * An app that sets every key of the app schema, so also every field the form
 * does not show. Where the editor normalises a value on purpose, the app
 * already has the normalised form; the entries of `NORMALISATIONS` have their
 * own cases further down.
 */
const everyFieldApp = {
  id: 'every-field',
  name: { en: 'Every field', de: 'Jedes Feld' },
  description: { en: 'Sets every key of the schema', de: 'Setzt jeden Schlüssel des Schemas' },
  color: '#0EA5E9',
  icon: 'sparkles',
  type: 'chat',
  redirectConfig: { url: 'https://example.com/redirect', openInNewTab: false, showWarning: false },
  iframeConfig: {
    url: 'https://example.com/frame',
    allowFullscreen: false,
    sandbox: ['allow-scripts']
  },
  system: { en: 'Answer in a {{tone}} tone.', de: 'Antworten Sie im Ton {{tone}}.' },
  order: 7,
  preferredModel: 'gemini-flash',
  preferredOutputFormat: 'json',
  preferredStyle: 'concise',
  sendChatHistory: false,
  thinking: { enabled: true, level: 'high', thoughts: true },
  imageGeneration: { aspectRatio: '16:9', quality: 'High' },
  messagePlaceholder: { en: 'Paste a text…', de: 'Text einfügen…' },
  prompt: { en: 'Tone: {{tone}}\n\n{{content}}', de: 'Ton: {{tone}}\n\n{{content}}' },
  variables: [
    {
      name: 'tone',
      label: { en: 'Tone', de: 'Ton' },
      description: { en: 'How the answer sounds', de: 'Wie die Antwort klingt' },
      placeholder: { en: 'formal', de: 'förmlich' },
      type: 'select',
      required: true,
      defaultValue: { en: 'formal', de: 'formal' },
      predefinedValues: [
        { value: 'formal', label: { en: 'Formal', de: 'Förmlich' } },
        { value: 'casual', label: { en: 'Casual', de: 'Locker' } }
      ]
    }
  ],
  startForm: { enabled: true, submitLabel: { en: 'Go', de: '' } },
  variablesPanel: { pinned: false },
  settings: {
    enabled: true,
    model: { enabled: false, filter: { provider: 'google' } },
    outputFormat: { enabled: false },
    chatHistory: { enabled: false },
    ephemeral: { enabled: false },
    style: { enabled: false },
    imageGeneration: { enabled: false },
    speechRecognition: { service: 'custom', modelId: 'whisper', host: 'https://speech.example.com' }
  },
  inputMode: {
    type: 'multiline',
    rows: 8,
    microphone: { enabled: false, mode: 'automatic', showTranscript: false },
    voiceMode: {
      enabled: true,
      listeningStyle: 'push-to-talk',
      ttsModelId: 'tts-1',
      voice: 'alloy'
    }
  },
  upload: {
    enabled: true,
    allowMultiple: true,
    imageUpload: {
      enabled: true,
      resizeImages: false,
      maxFileSizeMB: 4,
      supportedFormats: ['image/png']
    },
    audioUpload: { enabled: true, maxFileSizeMB: 30, supportedFormats: ['audio/wav'] },
    videoUpload: {
      enabled: false,
      extractAudio: false,
      maxFileSizeMB: 100,
      supportedFormats: ['video/mp4']
    },
    fileUpload: {
      enabled: true,
      trackedChanges: 'markup',
      comments: 'inline',
      speakerNotes: 'include',
      maxFileSizeMB: 12,
      supportedFormats: ['application/pdf']
    }
  },
  features: {
    magicPrompt: { enabled: true, model: 'gemini-flash', prompt: 'Improve: {{prompt}}' },
    compareMode: { enabled: false },
    feedback: false,
    projects: false,
    userProjects: false,
    somethingNew: { enabled: true }
  },
  greeting: { en: { title: 'Welcome', subtitle: 'Paste a text to begin.' } },
  aiDisclosure: { firstTurnNotice: { enabled: true, text: { en: 'You are talking to an AI.' } } },
  starterPrompts: [
    {
      title: { en: 'A formal letter', de: 'Ein förmlicher Brief' },
      message: { en: 'Write a formal letter.', de: 'Schreiben Sie einen förmlichen Brief.' },
      description: { en: 'Starts with a letter', de: 'Beginnt mit einem Brief' },
      variables: { tone: 'formal' },
      autoSend: true
    }
  ],
  usageGuide: { question: { en: 'How do I use this?' }, content: { en: '# Paste a text' } },
  projects: ['handbook', { id: 'contracts', mode: 'tools', write: true }],
  allowedModels: ['gemini-flash', 'local-llm'],
  disallowModelSelection: true,
  allowEmptyContent: true,
  autoStart: true,
  ephemeral: true,
  websearch: {
    enabled: true,
    required: true,
    provider: 'brave',
    useNativeSearch: false,
    maxResults: 3,
    extractContent: false,
    contentMaxLength: 1000,
    enabledByDefault: true,
    maxSearches: 2,
    maxPageReads: 4,
    researchGuidance: 'Search twice.'
  },
  toolChoice: 'required',
  toolApproval: { default: 'writes', tools: { jira: 'always' } },
  workflows: ['research'],
  toolSearch: { mode: 'off', maxToolTokens: 4000 },
  apps: ['chat'],
  skills: ['docx'],
  skillSettings: { enabled: true, autoActivate: true, maxActiveSkills: 2, allowPersonal: false },
  documentTemplate: 'corporate',
  allowUserTemplateUploads: true,
  uploads: { storageMode: 'server_text_only' },
  outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  customResponseRenderer: 'quiz',
  rendererConfig: { columns: 2, nested: { deep: [1, 2, 3] } },
  category: 'writing',
  enabled: false,
  requiredFeatures: ['skills'],
  requiredIntegrations: [],
  iassistant: {
    enabled: true,
    profileId: 'legal-docs',
    searchProfile: 'contracts',
    groundedOnly: true,
    filter: [{ key: 'department', values: ['legal'], isNegated: true }]
  },
  integrations: {
    jira: { actions: ['searchIssues'], connection: 'shared', required: false },
    ifinder: { scopePicker: 'menu', defaultScope: 'contracts' }
  },
  allowInheritance: true,
  parentId: 'chat',
  inheritanceLevel: 2,
  overriddenFields: ['system', 'variables']
};

/** An app as the wizard that is being replaced created it from a template. */
const inheritedApp = {
  id: 'support-chat',
  name: { en: 'Support chat' },
  description: { en: 'Based on the chat app' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  system: { en: 'You answer support questions.' },
  parentId: 'chat',
  inheritanceLevel: 1,
  overriddenFields: ['name', 'description', 'system']
};

/** An app as the create page stores it in a German UI. */
const germanOnlyApp = {
  id: 'vertrags-helfer',
  name: { de: 'Vertragshelfer' },
  description: { de: 'Beantwortet Fragen zu Verträgen.' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  system: { de: 'Sie beantworten Fragen zu Verträgen.' },
  prompt: { de: 'Vertragsart: {{art}}\n\n{{content}}' },
  variables: [{ name: 'art', label: { de: 'Vertragsart' }, type: 'string' }],
  enabled: false
};

describe('app editor round trip, pure level', () => {
  describe('the fixtures', () => {
    test('the shipped apps are the 27 files of server/defaults/apps', () => {
      expect(shippedApps).toHaveLength(27);
    });

    test('the app with every field sets every key of the app schema, and the schema accepts it', () => {
      expect(Object.keys(everyFieldApp).sort()).toEqual([...knownAppKeys].sort());

      const result = appConfigSchema.safeParse(everyFieldApp);
      expect(result.success ? [] : result.error.issues).toEqual([]);
    });

    test('the other two are apps the schema accepts', () => {
      expect(appConfigSchema.safeParse(inheritedApp).success).toBe(true);
      expect(appConfigSchema.safeParse(germanOnlyApp).success).toBe(true);
    });
  });

  describe.each(shippedApps)('the shipped app %s', (file, app) => {
    test('comes back as it was, except for the named normalisations', () => {
      expect(roundTrip(copy(app))).toEqual(normalised(app));
    });

    test('keeps every key it had, apart from a switched-off upload block', () => {
      const saved = roundTrip(copy(app));
      const lost = Object.keys(app).filter(key => !(key in saved));

      expect(lost.filter(key => key !== 'upload')).toEqual([]);
      if (lost.includes('upload')) expect(app.upload.enabled).not.toBe(true);
    });

    test('is still an app the schema accepts', () => {
      const result = appConfigSchema.safeParse(roundTrip(copy(app)));

      expect(result.success ? [] : result.error.issues).toEqual([]);
    });

    test('a second load and save changes nothing more', () => {
      const saved = roundTrip(copy(app));

      expect(roundTrip(copy(saved))).toEqual(saved);
    });

    test('is not modified by loading and saving', () => {
      const loaded = copy(app);

      roundTrip(loaded);

      expect(loaded).toEqual(app);
    });
  });

  describe('an app that sets every field of the schema', () => {
    test('comes back exactly as it was', () => {
      expect(roundTrip(copy(everyFieldApp))).toEqual(everyFieldApp);
    });

    test('needs none of the named normalisations', () => {
      expect(normalised(everyFieldApp)).toEqual(everyFieldApp);
    });

    test('loses no nested value either', () => {
      // toEqual treats a missing key and an undefined one alike; the stored JSON does not.
      expect(JSON.stringify(roundTrip(copy(everyFieldApp)))).toHaveLength(
        JSON.stringify(everyFieldApp).length
      );
    });
  });

  describe('an app with the three inheritance fields', () => {
    test('keeps them', () => {
      const saved = roundTrip(copy(inheritedApp));

      expect(saved).toMatchObject({
        parentId: 'chat',
        inheritanceLevel: 1,
        overriddenFields: ['name', 'description', 'system']
      });
      expect(saved).toEqual(normalised(inheritedApp));
    });

    test('changes only what the normalisations name', () => {
      expect(changedKeys(inheritedApp, roundTrip(copy(inheritedApp))).sort()).toEqual([
        'allowEmptyContent',
        'ephemeral',
        'greeting',
        'inputMode',
        'sendChatHistory'
      ]);
    });
  });

  describe('an app with name.de only', () => {
    test('stays German-only in every text the author wrote', () => {
      const saved = roundTrip(copy(germanOnlyApp));

      expect(saved.name).toEqual({ de: 'Vertragshelfer' });
      expect(saved.description).toEqual(germanOnlyApp.description);
      expect(saved.system).toEqual(germanOnlyApp.system);
      expect(saved.prompt).toEqual(germanOnlyApp.prompt);
      expect(saved.variables).toEqual(germanOnlyApp.variables);
      expect(saved.enabled).toBe(false);
      expect(saved).toEqual(normalised(germanOnlyApp));
    });

    test('gets no empty English text, which the server would refuse', () => {
      const result = appConfigSchema.safeParse(roundTrip(copy(germanOnlyApp)));

      expect(result.success ? [] : result.error.issues).toEqual([]);
    });
  });

  describe('each named normalisation', () => {
    const base = {
      id: 'x',
      name: { en: 'X' },
      description: { en: 'X' },
      color: '#4F46E5',
      icon: 'star',
      greeting: { en: { title: 'Hi', subtitle: 'Ask' } },
      allowEmptyContent: true,
      sendChatHistory: false,
      ephemeral: true,
      inputMode: { type: 'multiline', rows: 3, microphone: { enabled: false } }
    };

    test('an app that sets all of it comes back exactly as it was', () => {
      expect(roundTrip(copy(base))).toEqual(base);
    });

    test.each([
      ['greeting', app => without(app, 'greeting'), { greeting: DEFAULTS.greeting }],
      ['allowEmptyContent', app => without(app, 'allowEmptyContent'), { allowEmptyContent: false }],
      ['sendChatHistory', app => without(app, 'sendChatHistory'), { sendChatHistory: true }],
      ['ephemeral', app => without(app, 'ephemeral'), { ephemeral: false }],
      [
        'inputMode without settings',
        app => without(app, 'inputMode'),
        { inputMode: DEFAULTS.inputMode }
      ],
      [
        'inputMode with one setting',
        app => ({ ...app, inputMode: { rows: 9 } }),
        { inputMode: { ...DEFAULTS.inputMode, rows: 9 } }
      ],
      [
        'upload switched off',
        app => ({ ...app, upload: { enabled: false } }),
        { upload: undefined }
      ],
      [
        'upload without "enabled"',
        app => ({ ...app, upload: { fileUpload: { enabled: true } } }),
        { upload: undefined }
      ],
      [
        'upload with a switched-off block',
        app => ({
          ...app,
          upload: {
            enabled: true,
            imageUpload: { enabled: false, maxFileSizeMB: 3 },
            fileUpload: { enabled: true, maxFileSizeMB: 5 }
          }
        }),
        { upload: { enabled: true, fileUpload: { enabled: true, maxFileSizeMB: 5 } } }
      ],
      [
        'an empty default value',
        app => ({ ...app, variables: [{ name: 'a', defaultValue: { en: '', de: '' } }] }),
        { variables: [{ name: 'a' }] }
      ],
      [
        'an empty list of options',
        app => ({ ...app, variables: [{ name: 'a', predefinedValues: [] }] }),
        { variables: [{ name: 'a' }] }
      ],
      [
        'a switched-off magic prompt',
        app => ({ ...app, features: { magicPrompt: { enabled: false }, feedback: false } }),
        { features: { feedback: false } }
      ],
      [
        'features with nothing but a switched-off magic prompt',
        app => ({ ...app, features: { magicPrompt: { enabled: false } } }),
        { features: undefined }
      ]
    ])('%s: only that changes', (name, change, expected) => {
      const app = change(copy(base));

      const saved = roundTrip(copy(app));

      expect(changedKeys(app, saved)).toEqual(Object.keys(expected));
      for (const [key, value] of Object.entries(expected)) expect(saved[key]).toEqual(value);
      expect(saved).toEqual(normalised(app));
    });
  });

  describe('what the list of normalisations covers', () => {
    test('every entry names what changes and why', () => {
      for (const [what, why, apply] of NORMALISATIONS) {
        expect(what).toMatch(/\S: \S/);
        expect(why.length).toBeGreaterThan(10);
        expect(typeof apply).toBe('function');
      }
    });

    test('across the shipped apps only these keys ever change', () => {
      const changed = new Set(
        shippedApps.flatMap(([, app]) => changedKeys(app, roundTrip(copy(app))))
      );

      expect([...changed].sort()).toEqual([
        'allowEmptyContent',
        'ephemeral',
        'greeting',
        'inputMode',
        'sendChatHistory',
        'upload',
        'variables'
      ]);
    });
  });
});

describe('app editor round trip, rendered level', () => {
  const {
    groupParts,
    openGroupIds,
    renderedGroupIds,
    renderForm,
    setUiLanguage
  } = require('./helpers/appFormHarness');
  const { getAppJsonSchema } = require('../../../server/utils/schemaExport.js');
  const jsonSchema = getAppJsonSchema();

  /** As the create page stores an app that was started empty. */
  const flowCreatedApp = cleanAppForSave({
    ...newAppDefaults('en'),
    id: 'plain-language',
    name: { en: 'Plain language' },
    description: { en: 'Rewrites a text so that everyone understands it.' },
    system: { en: 'You rewrite texts in plain language.' }
  });

  const fixtures = [
    ['a flow-created app', flowCreatedApp],
    ['the app with every field', everyFieldApp],
    ['the app with the inheritance fields', inheritedApp],
    ['the German-only app', germanOnlyApp]
  ];

  /** The editor's state after loading a stored app. */
  const load = stored => padLoadedApp(copy(stored));

  beforeEach(() => setUiLanguage('en'));

  test('the flow-created fixture is what the schema accepts', () => {
    expect(appConfigSchema.safeParse(flowCreatedApp).success).toBe(true);
    expect(flowCreatedApp.enabled).toBe(false);
  });

  describe.each(fixtures)('%s', (_name, stored) => {
    test('is not changed by the form when it is mounted, expanded and collapsed', async () => {
      const loaded = load(stored);
      const { probe } = await renderForm(loaded, { jsonSchema });
      expect(openGroupIds()).toEqual(['basics', 'instructions']);
      act(() => probe.groups.expandAll());
      expect(openGroupIds()).toEqual(renderedGroupIds());
      act(() => probe.groups.collapseAll());
      expect(openGroupIds()).toEqual([]);

      expect(probe.changes).toEqual([]);
      expect(probe.app).toBe(loaded);
      expect(cleanAppForSave(probe.app)).toEqual(roundTrip(copy(stored)));
    });

    test('reports no error for it', async () => {
      const { probe } = await renderForm(load(stored), { jsonSchema });
      expect(probe.validation.errors).toEqual([]);
    });

    test('sends the same body with every group collapsed as with every group open', async () => {
      const bodies = [];
      for (const state of ['collapseAll', 'expandAll']) {
        const { probe, unmount } = await renderForm(load(stored), { jsonSchema });
        act(() => probe.groups[state]());
        // One edit in a group that is hidden in the collapsed run.
        const description = groupParts('basics').panel.querySelector(
          '[data-field="description"] textarea'
        );
        fireEvent.change(description, { target: { value: 'Changed in the editor.' } });
        expect(probe.changes).toHaveLength(1);
        bodies.push(cleanAppForSave(probe.app));
        unmount();
      }
      expect(bodies[0]).toEqual(bodies[1]);

      const language = Object.keys(stored.description)[0];
      const expected = roundTrip(copy(stored));
      expected.description = { ...expected.description, [language]: 'Changed in the editor.' };
      expect(bodies[0]).toEqual(expected);
      // toEqual treats a missing key and an undefined one alike; the stored JSON does not.
      expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(bodies[1]));
      expect(appConfigSchema.safeParse(bodies[0]).success).toBe(true);
    });
  });

  test('the flow-created app and the app with every field come back exactly as stored', async () => {
    for (const stored of [flowCreatedApp, everyFieldApp]) {
      const { probe, unmount } = await renderForm(load(stored), { jsonSchema });
      act(() => probe.groups.expandAll());
      expect(cleanAppForSave(probe.app)).toEqual(stored);
      unmount();
    }
  });

  describe.each(shippedApps)('the shipped app %s', (_file, stored) => {
    test('is not changed by the form, open or collapsed', async () => {
      const loaded = load(stored);
      const { probe } = await renderForm(loaded, { jsonSchema });
      act(() => probe.groups.expandAll());
      act(() => probe.groups.collapseAll());
      expect(probe.changes).toEqual([]);
      expect(cleanAppForSave(probe.app)).toEqual(normalised(stored));
    });
  });

  describe('Form to JSON to Form', () => {
    const DualModeEditor = require('../../../client/src/shared/components/DualModeEditor').default;
    const AppFormEditor =
      require('../../../client/src/features/admin/components/AppFormEditor').default;
    const { MemoryRouter } = require('react-router-dom');

    test.each([
      ['a flow-created app', flowCreatedApp],
      ['the app with every field', everyFieldApp]
    ])('leaves the state of %s deep-equal without an edit', async (_name, stored) => {
      const loaded = load(stored);
      const before = copy(loaded);
      const changes = [];
      await act(async () => {
        render(
          <MemoryRouter>
            <DualModeEditor
              value={loaded}
              onChange={next => changes.push(next)}
              formComponent={AppFormEditor}
              formProps={{ availableModels: [], uiConfig: null, jsonSchema }}
              jsonSchema={jsonSchema}
            />
          </MemoryRouter>
        );
      });
      expect(groupParts('basics').group).not.toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
      });
      expect(screen.getByTestId('stub-json-editor')).toBeInTheDocument();
      expect(groupParts('basics').group).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Form' }));
      });
      // The form is mounted anew: it opens like on the first visit and hands nothing back.
      expect(openGroupIds()).toEqual(['basics', 'instructions']);
      expect(
        within(groupParts('basics').panel).getByDisplayValue(stored.name.en)
      ).toBeInTheDocument();
      expect(changes).toEqual([]);
      expect(loaded).toEqual(before);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(before));
    });
  });
});
