// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The groups of the app editor (plan section 3.5): which groups there are,
 * which group shows a field, what a collapsed group says, when a group opens,
 * and what the form renders inside them.
 *
 * The first half checks the pure module (`editorGroups.js`) and the hook
 * (`useEditorGroups.js`). The second half renders the real form
 * (`AppFormEditor`) in the frame the editor page gives it, with the real
 * English and German texts.
 */
import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';

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

const {
  groupParts,
  localeT,
  openGroupIds,
  renderedGroupIds,
  renderForm,
  setUiLanguage
} = require('./helpers/appFormHarness');
const en = require('../../../shared/i18n/en.json');
const de = require('../../../shared/i18n/de.json');
const { cleanAppForSave, newAppDefaults, padLoadedApp } = require('../../../shared/appDefaults.js');
const { getAppJsonSchema } = require('../../../server/utils/schemaExport.js');
const { draftFromTemplate } = require('../../../client/src/features/admin/utils/appDraft');
const {
  EDITOR_GROUPS,
  groupChanged,
  groupDomIds,
  groupOfField,
  groupSummary,
  isEditorGroupId
} = require('../../../client/src/features/admin/components/app-form/editorGroups');
const useEditorGroupsModule = require('../../../client/src/features/admin/components/app-form/useEditorGroups');
const AppFormEditor =
  require('../../../client/src/features/admin/components/AppFormEditor').default;
const EditorGroup =
  require('../../../client/src/features/admin/components/app-form/EditorGroup').default;
const EditorGroupNav =
  require('../../../client/src/features/admin/components/app-form/EditorGroupNav').default;

const { useEditorGroups } = useEditorGroupsModule;
const ROOT = path.resolve(__dirname, '../../..');
const t = localeT('en');
const lookup = (locale, key) => key.split('.').reduce((node, part) => node?.[part], locale);

/** A new app as "Start empty" leaves it in the editor's state. */
const fresh = (language = 'en') => ({
  ...newAppDefaults(language),
  id: 'plain-language',
  name: { [language]: 'Plain language' },
  description: { [language]: 'Rewrites a text.' },
  system: { [language]: 'You rewrite texts in plain language.' }
});

/** An app as the editor holds it after the create page stored it and the editor loaded it. */
const loaded = app => padLoadedApp(cleanAppForSave(app));

const summarizerApp = () =>
  loaded(
    draftFromTemplate(
      JSON.parse(fs.readFileSync(path.join(ROOT, 'server/appTemplates/summarizer.json'), 'utf8')),
      { language: 'en', isTaken: () => false }
    )
  );

/** Upload on, changed user settings and a multi-line input: three groups differ from a new app. */
const changedApp = () =>
  loaded({
    ...fresh(),
    upload: { enabled: true, fileUpload: { enabled: true } },
    settings: { style: { enabled: false } },
    inputMode: { type: 'multiline', rows: 5 }
  });

beforeEach(() => setUiLanguage('en'));
afterEach(() => {
  window.history.replaceState(null, '', window.location.pathname);
  jest.useRealTimers();
});

describe('EDITOR_GROUPS', () => {
  it('lists the eight groups in page order, access last', () => {
    expect(EDITOR_GROUPS.map(group => group.id)).toEqual([
      'basics',
      'instructions',
      'model',
      'knowledge',
      'chat',
      'input',
      'userSettings',
      'access'
    ]);
    expect(EDITOR_GROUPS.filter(group => group.defaultOpen).map(group => group.id)).toEqual([
      'basics',
      'instructions'
    ]);
    for (const type of ['iframe', 'redirect']) {
      expect(
        EDITOR_GROUPS.filter(group => group.types.includes(type)).map(group => group.id)
      ).toEqual(['basics', 'access']);
    }
    expect(EDITOR_GROUPS.every(group => group.types.includes('chat'))).toBe(true);
    expect(Object.isFrozen(EDITOR_GROUPS) && EDITOR_GROUPS.every(Object.isFrozen)).toBe(true);
  });

  it('has a label in English and German for every group', () => {
    for (const group of EDITOR_GROUPS) {
      expect(group.labelKey).toBe(`admin.apps.edit.groups.${group.id}`);
      expect(typeof lookup(en, group.labelKey)).toBe('string');
      expect(typeof lookup(de, group.labelKey)).toBe('string');
    }
  });

  it('knows its IDs and gives DOM ids that cannot be field ids', () => {
    expect(isEditorGroupId('access')).toBe(true);
    expect(isEditorGroupId('constructor')).toBe(false);
    expect(groupDomIds('model')).toEqual({
      group: 'app-group-model',
      header: 'app-group-model-header',
      panel: 'app-group-model-panel'
    });
  });
});

describe('groupOfField', () => {
  it.each([
    ['variables.0.name', 'instructions'],
    ['variables[0].name', 'instructions'],
    ['/variables/0/name', 'instructions'],
    ['system', 'instructions'],
    ['system.en', 'instructions'],
    ['prompt.de', 'instructions'],
    ['messagePlaceholder', 'instructions'],
    ['starterPrompts.1.title', 'instructions'],
    ['startForm.submitLabel', 'instructions'],
    ['variablesPanel.pinned', 'instructions'],
    ['preferredModel', 'model'],
    ['allowedModels.0', 'model'],
    ['preferredOutputFormat', 'model'],
    ['websearch.maxResults', 'knowledge'],
    ['integrations.jira.actions', 'knowledge'],
    ['iassistant.profileId', 'knowledge'],
    ['toolChoice', 'knowledge'],
    ['toolApproval.default', 'knowledge'],
    ['toolSearch.maxToolTokens', 'knowledge'],
    ['workflows', 'knowledge'],
    ['apps.0', 'knowledge'],
    ['skills', 'knowledge'],
    ['skillSettings.maxActiveSkills', 'knowledge'],
    ['projects.0.id', 'knowledge'],
    ['features.projects', 'knowledge'],
    ['features.userProjects', 'knowledge'],
    ['features.magicPrompt.model', 'chat'],
    ['features', 'chat'],
    ['upload.imageUpload.maxFileSizeMB', 'chat'],
    ['documentTemplate', 'chat'],
    ['aiDisclosure.firstTurnNotice.text', 'chat'],
    ['usageGuide.content', 'chat'],
    ['autoStart', 'chat'],
    ['ephemeral', 'chat'],
    ['inputMode.rows', 'input'],
    ['settings.speechRecognition.host', 'input'],
    ['settings.model.enabled', 'userSettings'],
    ['settings', 'userSettings'],
    ['name', 'basics'],
    ['description.en', 'basics'],
    ['color', 'basics'],
    ['icon', 'basics'],
    ['iframeConfig.url', 'basics'],
    ['redirectConfig.url', 'basics'],
    ['thinking.budget', 'basics'],
    ['somethingNew', 'basics'],
    ['constructor', 'basics'],
    ['__proto__', 'basics'],
    ['', 'basics'],
    [undefined, 'basics'],
    [null, 'basics']
  ])('%s -> %s', (field, id) => {
    expect(groupOfField(field)).toBe(id);
  });
});

describe('groupSummary', () => {
  it('describes a new app', () => {
    const app = fresh();
    expect(groupSummary('basics', app, t)).toBe('');
    expect(groupSummary('instructions', app, t)).toBe('');
    expect(groupSummary('model', app, t)).toBe('Standard model');
    expect(groupSummary('knowledge', app, t)).toBe('Web search off');
    expect(groupSummary('chat', app, t)).toBe('Upload off · export, feedback on');
    expect(groupSummary('input', app, t)).toBe('Single line · microphone on');
    expect(groupSummary('userSettings', app, t)).toBe('4 of 4 on');
    expect(groupSummary('access', app, t)).toBe('');
    expect(groupSummary('nope', app, t)).toBe('');
    expect(groupSummary('constructor', app, t)).toBe('');
    expect(groupSummary('model', null, t)).toBe('');
  });

  it('names the model, in the UI language', () => {
    const models = [
      { id: 'm1', name: { en: 'Fast', de: 'Schnell' } },
      { id: 'm2', name: 'Plain' }
    ];
    const summary = (app, extra) => groupSummary('model', app, t, extra);
    expect(summary({ preferredModel: 'm1' }, { models, language: 'de-DE' })).toBe('Schnell');
    expect(summary({ preferredModel: 'm1' }, { models })).toBe('Fast');
    expect(summary({ preferredModel: 'm2' }, { models, language: 'de' })).toBe('Plain');
    expect(summary({ preferredModel: 'gone' }, { models })).toBe('gone');
    expect(summary({ preferredModel: 'gone' })).toBe('gone');
  });

  it('counts connected systems', () => {
    const summary = app => groupSummary('knowledge', app, t);
    expect(summary({ websearch: { enabled: true }, integrations: { jira: {} } })).toBe(
      'Web search on · 1 connected system'
    );
    expect(summary({ integrations: { jira: {}, ifinder: {} } })).toBe(
      'Web search off · 2 connected systems'
    );
    expect(summary({ integrations: { '*': {}, jira: {} } })).toBe(
      'Web search off · all connected systems'
    );
    expect(summary({ iassistant: { enabled: true } })).toBe('Web search off · 1 connected system');
    expect(summary({ iassistant: { enabled: true }, integrations: { iassistant: {} } })).toBe(
      'Web search off · 1 connected system'
    );
  });

  it('lists the chat features that are on', () => {
    const summary = app => groupSummary('chat', app, t);
    expect(summary({ upload: { enabled: true }, features: { export: false } })).toBe(
      'Upload on · feedback on'
    );
    expect(summary({ features: { export: false, feedback: false } })).toBe('Upload off');
  });

  it('describes input and user settings', () => {
    expect(
      groupSummary('input', { inputMode: { type: 'multiline', microphone: { enabled: false } } }, t)
    ).toBe('Multi-line · microphone off');
    expect(
      groupSummary(
        'userSettings',
        { settings: { model: { enabled: false }, style: { enabled: false } } },
        t
      )
    ).toBe('2 of 4 on');
  });

  it('describes the audience from the content-access view', () => {
    const row = (id, more = {}) => ({ id, effective: true, ...more });
    const summary = access => groupSummary('access', null, t, { access });
    expect(
      summary({ scope: 'all', audience: { allSignedIn: true, anonymous: true }, groups: [] })
    ).toBe('Everyone, including people who are not signed in');
    expect(
      summary({
        scope: 'membership',
        audience: { allSignedIn: true, anonymous: false },
        groups: []
      })
    ).toBe('Everyone who signs in');
    expect(
      summary({
        scope: 'all',
        audience: { allSignedIn: false, anonymous: false },
        groups: [
          row('users'),
          row('sales'),
          row('authenticated', { implicit: true }),
          row('x', { effective: false })
        ]
      })
    ).toBe('2 groups');
    // Open to people who are not signed in says nothing about signed-in users:
    // where the group of signed-in users does not inherit, only the groups count.
    expect(
      summary({
        scope: 'all',
        audience: { anonymous: true, allSignedIn: false },
        groups: [row('sales')]
      })
    ).toBe('People who are not signed in · 1 group');
    expect(
      summary({ scope: 'all', audience: { anonymous: true, allSignedIn: false }, groups: [] })
    ).toBe('People who are not signed in');
    expect(
      summary({
        scope: 'membership',
        audience: { anonymous: true, allSignedIn: false },
        groups: [row('sales')]
      })
    ).toBe('People who are not signed in · 1 of the groups you manage');
    expect(summary({ scope: 'all', audience: {}, groups: [row('users')] })).toBe('1 group');
    expect(summary({ scope: 'all', audience: {}, groups: [] })).toBe('No group yet');
    expect(summary({ scope: 'membership', audience: {}, groups: [row('sales')] })).toBe(
      '1 of the groups you manage'
    );
    expect(summary({ scope: 'membership', audience: {}, groups: [] })).toBe(
      'None of the groups you manage'
    );
    expect(summary({ scope: 'all', groups: [row('users')] })).toBe('1 group');
    expect(summary('Ready text')).toBe('Ready text');
    expect(summary(undefined)).toBe('');
  });
});

describe('groupChanged', () => {
  const ids = EDITOR_GROUPS.map(group => group.id);
  const changed = app => ids.filter(id => groupChanged(id, app));

  it('is false everywhere for a new app, before and after the editor padded it', () => {
    expect(changed(fresh())).toEqual([]);
    expect(changed(padLoadedApp(fresh()))).toEqual([]);
    expect(changed(loaded(fresh()))).toEqual([]);
    expect(changed(cleanAppForSave(fresh()))).toEqual([]);
    expect(changed({ id: 'bare', name: { en: 'x' } })).toEqual([]);
    expect(changed(null)).toEqual([]);
  });

  it('is false for an app from the Summarizer template', () => {
    expect(changed(summarizerApp())).toEqual([]);
  });

  it('marks upload on, changed user settings and a multi-line input, and nothing else', () => {
    expect(changed(changedApp())).toEqual(['chat', 'input', 'userSettings']);
  });

  it('reads a switched-off block and an explicit default like a missing value', () => {
    const app = {
      ...fresh(),
      preferredOutputFormat: 'markdown',
      allowedModels: [],
      websearch: { enabled: false, maxResults: 3 },
      iassistant: { enabled: false },
      integrations: {},
      toolChoice: 'auto',
      workflows: [],
      apps: [],
      skills: ['a'],
      skillSettings: { enabled: false },
      projects: [],
      features: {
        magicPrompt: { enabled: false, model: 'x' },
        export: true,
        feedback: true,
        compareMode: { enabled: true }
      },
      upload: { enabled: false, allowMultiple: true },
      aiDisclosure: { firstTurnNotice: {} },
      usageGuide: { content: { en: '' } },
      autoStart: false,
      inputMode: {
        type: 'singleline',
        rows: 9,
        microphone: { enabled: true },
        voiceMode: { voice: '' }
      },
      settings: { model: { enabled: true }, speechRecognition: { service: 'default' } }
    };
    expect(changed(app)).toEqual([]);
  });

  it.each([
    ['model', { preferredModel: 'm1' }],
    ['model', { allowedModels: ['m1'] }],
    ['model', { preferredOutputFormat: 'text' }],
    ['knowledge', { websearch: { enabled: true } }],
    ['knowledge', { integrations: { jira: {} } }],
    ['knowledge', { iassistant: { enabled: true } }],
    ['knowledge', { toolChoice: 'required' }],
    ['knowledge', { toolApproval: { default: 'always' } }],
    ['knowledge', { workflows: ['w'] }],
    ['knowledge', { apps: ['other'] }],
    ['knowledge', { skillSettings: { enabled: true } }],
    ['knowledge', { projects: ['p'] }],
    ['knowledge', { features: { projects: false } }],
    ['knowledge', { features: { userProjects: false } }],
    ['chat', { upload: { enabled: true } }],
    ['chat', { features: { magicPrompt: { enabled: true } } }],
    ['chat', { features: { export: false } }],
    ['chat', { features: { compareMode: { enabled: false } } }],
    ['chat', { features: { feedback: false } }],
    ['chat', { documentTemplate: 'corp' }],
    ['chat', { aiDisclosure: { firstTurnNotice: { enabled: false } } }],
    ['chat', { aiDisclosure: { firstTurnNotice: { text: { en: 'AI' } } } }],
    ['chat', { usageGuide: { content: { en: '# Guide' } } }],
    ['chat', { autoStart: true }],
    ['chat', { ephemeral: true }],
    ['input', { inputMode: { type: 'multiline' } }],
    ['input', { inputMode: { type: 'singleline', microphone: { enabled: false } } }],
    [
      'input',
      { inputMode: { type: 'singleline', microphone: { enabled: true, mode: 'automatic' } } }
    ],
    ['input', { inputMode: { type: 'singleline', microphone: { showTranscript: false } } }],
    ['input', { inputMode: { type: 'singleline', voiceMode: { enabled: true } } }],
    ['input', { settings: { speechRecognition: { service: 'browser' } } }],
    ['userSettings', { settings: { chatHistory: { enabled: false } } }]
  ])('%s changes with %j, and only it', (id, patch) => {
    expect(changed({ ...fresh(), ...patch })).toEqual([id]);
  });

  it('never marks the two open groups or access', () => {
    const app = {
      ...fresh(),
      order: 7,
      category: 'x',
      variables: [{ name: 'a' }]
    };
    for (const id of ['basics', 'instructions', 'access', 'constructor']) {
      expect(groupChanged(id, app)).toBe(false);
    }
  });

  it('answers for every shipped app without throwing', () => {
    const dir = path.join(ROOT, 'server/defaults/apps');
    const files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const app = padLoadedApp(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      for (const id of ids) {
        expect(typeof groupChanged(id, app)).toBe('boolean');
        expect(typeof groupSummary(id, app, t)).toBe('string');
      }
    }
  });
});

describe('useEditorGroups', () => {
  const app = fresh();
  const open = result =>
    EDITOR_GROUPS.filter(group => result.current.isOpen(group.id)).map(group => group.id);

  function Dom() {
    return (
      <div>
        {EDITOR_GROUPS.map(group => (
          <section key={group.id} id={groupDomIds(group.id).group}>
            <button type="button" id={groupDomIds(group.id).header}>
              {group.id}
            </button>
          </section>
        ))}
        <div data-field="icon">
          <button type="button" data-testid="icon-button">
            icon
          </button>
        </div>
        <input id="color" />
        <textarea data-field="system.en" />
      </div>
    );
  }

  it('is exported by name and as default', () => {
    expect(useEditorGroupsModule.default).toBe(useEditorGroups);
  });

  it('starts with Basics and Instructions open', () => {
    const { result } = renderHook(() => useEditorGroups({ app, errors: [] }));
    expect(open(result)).toEqual(['basics', 'instructions']);
    expect(result.current.totalErrors).toBe(0);
    expect(result.current.firstErrorField).toBeNull();
    expect(result.current.allOpen).toBe(false);
    expect(result.current.groups.map(group => group.id)).toEqual(
      EDITOR_GROUPS.map(group => group.id)
    );
    expect(result.current.isOpen('constructor')).toBe(false);
    expect(result.current.errorCount('constructor')).toBe(0);
  });

  it('does not open a group because it differs from the defaults', () => {
    const { result } = renderHook(() => useEditorGroups({ app: changedApp(), errors: [] }));
    expect(open(result)).toEqual(['basics', 'instructions']);
    expect(result.current.changed('chat')).toBe(true);
    expect(result.current.changed('model')).toBe(false);
    expect(result.current.summary('chat', t)).toBe('Upload on · export, feedback on');
  });

  it('toggles, expands and collapses', () => {
    const { result } = renderHook(() => useEditorGroups({ app }));
    act(() => result.current.toggle('model'));
    expect(open(result)).toEqual(['basics', 'instructions', 'model']);
    act(() => result.current.toggle('basics'));
    expect(open(result)).toEqual(['instructions', 'model']);
    act(() => result.current.toggle('nope'));
    expect(open(result)).toEqual(['instructions', 'model']);
    act(() => result.current.expandAll());
    expect(open(result)).toEqual(EDITOR_GROUPS.map(group => group.id));
    expect(result.current.allOpen).toBe(true);
    act(() => result.current.collapseAll());
    expect(open(result)).toEqual([]);
    expect(result.current.allOpen).toBe(false);
  });

  it('opens a group when an error appears in it, counts, and lets the author collapse it', () => {
    const first = [
      { field: 'settings.speechRecognition.host', message: 'bad' },
      { field: 'websearch.maxResults', message: 'bad' },
      { field: 'websearch.contentMaxLength', message: 'bad' }
    ];
    const { result, rerender } = renderHook(({ errors }) => useEditorGroups({ app, errors }), {
      initialProps: { errors: [] }
    });
    rerender({ errors: first });
    expect(open(result)).toEqual(['basics', 'instructions', 'knowledge', 'input']);
    expect(result.current.errorCount('knowledge')).toBe(2);
    expect(result.current.errorCount('input')).toBe(1);
    expect(result.current.errorCount('basics')).toBe(0);
    expect(result.current.totalErrors).toBe(3);
    // In page order, not in the order of the list.
    expect(result.current.firstErrorField).toBe('websearch.maxResults');

    act(() => result.current.toggle('knowledge'));
    // The next validation run reports the same errors: the group stays as the author left it.
    rerender({ errors: first.map(error => ({ ...error })) });
    expect(result.current.isOpen('knowledge')).toBe(false);
    expect(result.current.errorCount('knowledge')).toBe(2);

    rerender({ errors: [] });
    expect(result.current.totalErrors).toBe(0);
    rerender({ errors: [{ field: 'websearch.maxResults', message: 'bad' }] });
    expect(result.current.isOpen('knowledge')).toBe(true);
  });

  it('opens the groups of errors that exist on the first render', () => {
    const { result } = renderHook(() =>
      useEditorGroups({
        app,
        errors: [
          { field: 'inputMode.rows', message: 'bad' },
          { field: 'name', message: 'x' }
        ]
      })
    );
    expect(open(result)).toEqual(['basics', 'instructions', 'input']);
    expect(result.current.firstErrorField).toBe('name');
  });

  it('tolerates missing errors and an app that is not loaded yet', () => {
    const { result } = renderHook(() => useEditorGroups({ app: null, errors: undefined }));
    expect(result.current.totalErrors).toBe(0);
    expect(result.current.summary('model', t)).toBe('');
    expect(result.current.changed('chat')).toBe(false);
    const none = renderHook(() => useEditorGroups());
    expect(open(none.result)).toEqual(['basics', 'instructions']);
  });

  it('lists only the groups of the app type', () => {
    const { result } = renderHook(() => useEditorGroups({ app: { ...app, type: 'iframe' } }));
    expect(result.current.groups.map(group => group.id)).toEqual(['basics', 'access']);
    act(() => result.current.toggle('access'));
    expect(result.current.allOpen).toBe(true);
  });

  it('opens a group and moves the focus to its header', () => {
    render(<Dom />);
    const { result } = renderHook(() => useEditorGroups({ app }));
    act(() => result.current.open('access', { focus: true }));
    expect(result.current.isOpen('access')).toBe(true);
    expect(document.activeElement.id).toBe('app-group-access-header');
    // The same link again, after the focus moved elsewhere.
    document.getElementById('color').focus();
    act(() => result.current.open('access', { focus: true }));
    expect(document.activeElement.id).toBe('app-group-access-header');
    // Without a focus request the focus stays where it is.
    document.getElementById('color').focus();
    act(() => result.current.open('model'));
    expect(result.current.isOpen('model')).toBe(true);
    expect(document.activeElement.id).toBe('color');
    act(() => result.current.open('nope', { focus: true }));
    expect(document.activeElement.id).toBe('color');
  });

  it('moves the focus to a field, to the control inside its wrapper, or to the header', () => {
    render(<Dom />);
    const { result } = renderHook(() => useEditorGroups({ app }));
    act(() => result.current.open('basics', { focus: 'color' }));
    expect(document.activeElement.id).toBe('color');
    act(() => result.current.open('basics', { focus: 'icon' }));
    expect(document.activeElement.dataset.testid).toBe('icon-button');
    act(() => result.current.open('instructions', { focus: 'system.en' }));
    expect(document.activeElement.tagName).toBe('TEXTAREA');
    act(() => result.current.open('instructions', { focus: 'variables.0.name' }));
    expect(document.activeElement.id).toBe('app-group-instructions-header');
    act(() => result.current.open('knowledge', { focus: String.raw`a"b\c.d` }));
    expect(document.activeElement.id).toBe('app-group-knowledge-header');
  });

  it('opens the group the URL hash names and moves the focus there once the app is loaded', () => {
    window.location.hash = '#access';
    const { result, rerender } = renderHook(
      ({ ready }) => useEditorGroups({ app: ready ? app : null }),
      { initialProps: { ready: false } }
    );
    expect(open(result)).toEqual(['basics', 'instructions', 'access']);
    render(<Dom />);
    rerender({ ready: true });
    expect(document.activeElement.id).toBe('app-group-access-header');
  });

  it('follows a hash change, and ignores a hash that names no group', () => {
    render(<Dom />);
    const { result, unmount } = renderHook(() => useEditorGroups({ app }));
    window.history.replaceState(null, '', '#model');
    act(() => {
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(result.current.isOpen('model')).toBe(true);
    expect(document.activeElement.id).toBe('app-group-model-header');
    window.history.replaceState(null, '', '#nothing');
    act(() => {
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(open(result)).toEqual(['basics', 'instructions', 'model']);
    unmount();
    window.history.replaceState(null, '', '#chat');
    expect(() => window.dispatchEvent(new Event('hashchange'))).not.toThrow();
  });

  it('keeps its functions and its result stable between renders', () => {
    const errors = [];
    const { result, rerender } = renderHook(() => useEditorGroups({ app, errors }));
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
    act(() => result.current.toggle('model'));
    expect(result.current).not.toBe(before);
    expect(result.current.open).toBe(before.open);
    expect(result.current.toggle).toBe(before.toggle);
  });
});

describe('EditorGroup and EditorGroupNav', () => {
  function Frame({ app, errors, compact }) {
    const groups = useEditorGroups({ app, errors });
    return (
      <div>
        <EditorGroupNav groups={groups} compact={compact} />
        {groups.groups.map(group => (
          <EditorGroup key={group.id} id={group.id} groups={groups}>
            <input aria-label={`field of ${group.id}`} />
          </EditorGroup>
        ))}
      </div>
    );
  }

  it('renders a header button that controls a panel which stays mounted', () => {
    render(<Frame app={changedApp()} />);
    const { group, header, panel } = groupParts('chat');
    expect(group.tagName).toBe('SECTION');
    expect(header.closest('h2')).not.toBeNull();
    expect(header).toHaveAttribute('type', 'button');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('hidden');
    // Collapsed, the group's content is still in the document.
    expect(within(panel).getByLabelText('field of chat')).toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveAttribute('hidden');
    fireEvent.click(header);
    expect(panel).toHaveAttribute('hidden');
  });

  it('puts label, summary line and "changed" marker into the name of a collapsed header', () => {
    render(<Frame app={changedApp()} />);
    expect(groupParts('chat').header).toHaveTextContent(
      'Chat features' + 'Upload on · export, feedback on' + 'changed'
    );
    expect(
      screen.getByRole('button', {
        name: 'Chat features Upload on · export, feedback on changed'
      })
    ).toBe(groupParts('chat').header);
    // A group that equals a new app has a summary and no marker.
    expect(groupParts('model').header).toHaveTextContent(/^ModelStandard model$/);
    // An open group shows neither.
    fireEvent.click(groupParts('chat').header);
    expect(groupParts('chat').header).toHaveTextContent(/^Chat features$/);
    expect(groupParts('basics').header).toHaveTextContent(/^Basics$/);
  });

  it('shows the number of fields that need attention, open or not', () => {
    const errors = [
      { field: 'inputMode.rows', message: 'bad' },
      { field: 'settings.speechRecognition.host', message: 'bad' }
    ];
    render(<Frame app={fresh()} errors={errors} />);
    const { header } = groupParts('input');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(within(header).getByText('2 fields need your attention.')).toHaveClass('sr-only');
    fireEvent.click(header);
    expect(within(header).getByText('2 fields need your attention.')).toBeInTheDocument();
    expect(within(groupParts('model').header).queryByText(/need your attention/)).toBeNull();
  });

  it('renders the children alone for an ID that names no group', () => {
    function Unknown() {
      const groups = useEditorGroups({ app: fresh() });
      return (
        <EditorGroup id="nope" groups={groups}>
          <p>content</p>
        </EditorGroup>
      );
    }
    const { container } = render(<Unknown />);
    expect(container.innerHTML).toBe('<p>content</p>');
  });

  it('lists the groups in a nav, with markers and counts', () => {
    render(<Frame app={changedApp()} errors={[{ field: 'preferredModel', message: 'bad' }]} />);
    const nav = screen.getByRole('navigation', { name: 'Jump to section' });
    const entries = within(nav.querySelector('ul')).getAllByRole('button');
    expect(entries.map(entry => entry.textContent)).toEqual([
      'Basics',
      'Instructions and inputs',
      'Model' + '1' + '1 field needs your attention.',
      'Knowledge and tools',
      'Chat features' + 'changed',
      'Input and voice' + 'changed',
      'What users can change' + 'changed',
      'Who can use this app'
    ]);
  });

  it('opens a group from the index and moves the focus to its header', () => {
    render(<Frame app={fresh()} />);
    const nav = screen.getByRole('navigation', { name: 'Jump to section' });
    fireEvent.click(within(nav.querySelector('ul')).getByRole('button', { name: 'Model' }));
    expect(groupParts('model').header).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(groupParts('model').header);
  });

  it('offers the same entries as a "Jump to section" select', () => {
    render(<Frame app={changedApp()} errors={[{ field: 'preferredModel', message: 'bad' }]} />);
    const select = screen.getByRole('combobox', { name: 'Jump to section' });
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual([
      'Jump to section',
      'Basics',
      'Instructions and inputs',
      'Model – 1 field needs your attention.',
      'Knowledge and tools',
      'Chat features (changed)',
      'Input and voice (changed)',
      'What users can change (changed)',
      'Who can use this app'
    ]);
    // Choosing an option moves nothing: an arrow key on a closed select chooses one.
    select.focus();
    fireEvent.change(select, { target: { value: 'chat' } });
    fireEvent.change(select, { target: { value: 'userSettings' } });
    expect(select).toHaveValue('userSettings');
    expect(document.activeElement).toBe(select);
    expect(groupParts('chat').header).toHaveAttribute('aria-expanded', 'false');
    expect(groupParts('userSettings').header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(within(select.parentElement).getByRole('button', { name: 'Go' }));
    expect(groupParts('userSettings').header).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(groupParts('userSettings').header);
    // The select is a menu: it shows its label again.
    expect(select).toHaveValue('');

    // Enter in the select does the same; without a choice neither does anything.
    select.focus();
    fireEvent.keyDown(select, { key: 'Enter' });
    fireEvent.click(within(select.parentElement).getByRole('button', { name: 'Go' }));
    expect(document.activeElement).toBe(select);
    fireEvent.change(select, { target: { value: 'access' } });
    fireEvent.keyDown(select, { key: 'Enter' });
    expect(document.activeElement).toBe(groupParts('access').header);
  });

  it('expands and collapses all groups', () => {
    render(<Frame app={fresh()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(openGroupIds()).toEqual(EDITOR_GROUPS.map(group => group.id));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(openGroupIds()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
  });

  it('shows the list from lg, and from 2xl while something sits beside the form', () => {
    const { unmount } = render(<Frame app={fresh()} />);
    let nav = screen.getByRole('navigation');
    expect(nav.querySelector('ul')).toHaveClass('hidden', 'lg:block');
    expect(nav.querySelector('select').parentElement).toHaveClass('lg:hidden');
    unmount();
    render(<Frame app={fresh()} compact />);
    nav = screen.getByRole('navigation');
    expect(nav.querySelector('ul')).toHaveClass('hidden', '2xl:block');
    expect(nav.querySelector('select').parentElement).toHaveClass('2xl:hidden');
  });
});

describe('the form in its groups', () => {
  const jsonSchema = getAppJsonSchema();
  const summaryOf = id =>
    document.querySelector(`[data-testid="app-group-${id}-summary"]`)?.textContent ?? null;
  const changedIds = () =>
    renderedGroupIds().filter(id => within(groupParts(id).header).queryByText('changed'));

  it('opens a flow-created app with two groups open and a summary line on every other', async () => {
    await renderForm(loaded(fresh()), {
      jsonSchema,
      access: { scope: 'all', groups: [], audience: { allSignedIn: true, anonymous: false } }
    });
    expect(renderedGroupIds()).toEqual(EDITOR_GROUPS.map(group => group.id));
    expect(openGroupIds()).toEqual(['basics', 'instructions']);
    expect(summaryOf('basics')).toBeNull();
    expect(summaryOf('instructions')).toBeNull();
    expect(summaryOf('model')).toBe('Standard model');
    expect(summaryOf('knowledge')).toBe('Web search off');
    expect(summaryOf('chat')).toBe('Upload off · export, feedback on');
    expect(summaryOf('input')).toBe('Single line · microphone on');
    expect(summaryOf('userSettings')).toBe('4 of 4 on');
    expect(summaryOf('access')).toBe('Everyone who signs in');
    expect(changedIds()).toEqual([]);
    // A new app has nothing to fix.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the sections of a collapsed group mounted', async () => {
    await renderForm(loaded(fresh()), { jsonSchema });
    for (const id of ['model', 'knowledge', 'chat', 'input', 'userSettings', 'access']) {
      const { panel } = groupParts(id);
      expect(panel).toHaveAttribute('hidden');
      expect(panel.children.length).toBeGreaterThan(0);
    }
    expect(groupParts('model').panel.querySelector('select[name="preferredModel"]')).not.toBeNull();
  });

  it('opens an app from the Summarizer template the same way, with nothing marked', async () => {
    await renderForm(summarizerApp(), { jsonSchema });
    expect(openGroupIds()).toEqual(['basics', 'instructions']);
    expect(changedIds()).toEqual([]);
  });

  it('keeps three changed groups collapsed and marks them "changed"', async () => {
    await renderForm(changedApp(), { jsonSchema });
    expect(openGroupIds()).toEqual(['basics', 'instructions']);
    expect(changedIds()).toEqual(['chat', 'input', 'userSettings']);
    expect(summaryOf('chat')).toBe('Upload on · export, feedback on');
    expect(summaryOf('input')).toBe('Multi-line · microphone on');
    expect(summaryOf('userSettings')).toBe('3 of 4 on');
  });

  it('opens a collapsed group with an invalid field and counts it in header and index', async () => {
    const { probe } = await renderForm(
      { ...loaded(fresh()), preferredOutputFormat: 'pdf' },
      { jsonSchema }
    );
    expect(probe.validation.isValid).toBe(false);
    expect(probe.validation.errors.map(error => error.field)).toEqual(['preferredOutputFormat']);
    expect(openGroupIds()).toEqual(['basics', 'instructions', 'model']);
    expect(
      within(groupParts('model').header).getByText('1 field needs your attention.')
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Jump to section' });
    expect(
      within(nav.querySelector('ul')).getByRole('button', {
        name: /^Model .*1 field needs your attention\.$/
      })
    ).toBeInTheDocument();
    expect(probe.groups.totalErrors).toBe(1);
    expect(probe.groups.firstErrorField).toBe('preferredOutputFormat');
  });

  it('reaches a field of a collapsed group from the error summary', async () => {
    jest.useFakeTimers();
    await renderForm({ ...loaded(fresh()), preferredOutputFormat: 'pdf' }, { jsonSchema });
    // The author collapsed the group again.
    fireEvent.click(groupParts('model').header);
    expect(groupParts('model').panel).toHaveAttribute('hidden');

    const field = document.querySelector('select[name="preferredOutputFormat"]');
    field.scrollIntoView = jest.fn(() => {
      // The summary scrolls to the field; by then its group must be shown.
      expect(groupParts('model').panel).not.toHaveAttribute('hidden');
    });
    const summary = screen.getByRole('alert');
    fireEvent.click(within(summary).getByRole('button'));
    expect(field.scrollIntoView).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(300));
    expect(document.activeElement).toBe(field);
  });

  it('reaches the first field that needs attention through the groups, as the save bar does', async () => {
    const { probe } = await renderForm(
      { ...loaded(fresh()), preferredOutputFormat: 'pdf' },
      { jsonSchema }
    );
    fireEvent.click(groupParts('model').header);
    act(() =>
      probe.groups.open(groupOfField(probe.groups.firstErrorField), {
        focus: probe.groups.firstErrorField
      })
    );
    expect(groupParts('model').panel).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(
      document.querySelector('select[name="preferredOutputFormat"]')
    );
  });

  it('moves the focus into the empty required text, not to "Add a translation"', async () => {
    const { probe } = await renderForm(loaded(fresh()), { jsonSchema });
    for (const [label, field] of [
      [/^Name/, 'name'],
      [/^Short description/, 'description'],
      [/^Instructions/, 'system']
    ]) {
      const input = screen.getByLabelText(label);
      fireEvent.change(input, { target: { value: '' } });
      expect(probe.validation.errors.map(error => error.field)).toContain(field);
      act(() => probe.groups.open(groupOfField(field), { focus: field }));
      expect(document.activeElement).toBe(screen.getByLabelText(label));
      expect(document.activeElement.tagName).not.toBe('BUTTON');
    }
  });

  it('moves the focus into the text also while a translation is being added', async () => {
    const { probe } = await renderForm(loaded(fresh()), { jsonSchema });
    const input = screen.getByLabelText(/^Name/);
    // The row for a new language puts a select and a code input before the text.
    const addTranslation = within(input.closest('[data-field="name"]')).getByRole('button', {
      name: 'Add a translation'
    });
    fireEvent.click(addTranslation);
    fireEvent.change(input, { target: { value: '' } });
    act(() => probe.groups.open(groupOfField('name'), { focus: 'name' }));
    expect(document.activeElement).toBe(input);
  });

  it('asks for instructions that were emptied, as an error of the form', async () => {
    const { probe } = await renderForm(loaded(fresh()), { jsonSchema });
    fireEvent.change(screen.getByLabelText(/^Instructions/), { target: { value: '' } });
    expect(probe.validation.isValid).toBe(false);
    expect(probe.validation.errors).toEqual([
      expect.objectContaining({
        field: 'system',
        message: 'Enter instructions. One sentence is enough to start.'
      })
    ]);
    expect(
      within(groupParts('instructions').header).getByText('1 field needs your attention.')
    ).toBeInTheDocument();
  });

  it('opens the group the URL hash names', async () => {
    window.location.hash = '#access';
    await renderForm(loaded(fresh()), { jsonSchema });
    expect(openGroupIds()).toEqual(['basics', 'instructions', 'access']);
    expect(document.activeElement).toBe(groupParts('access').header);
  });

  it('shows no App ID input and no switch for "enabled" in Basics', async () => {
    const { probe } = await renderForm(loaded(fresh()), { jsonSchema });
    const basics = within(groupParts('basics').panel);
    expect(document.getElementById('id')).toBeNull();
    expect(basics.queryByText('App ID')).toBeNull();
    expect(basics.queryByDisplayValue(probe.app.id)).toBeNull();
    // Publishing is the header's action: the form has no control for it.
    expect(basics.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByLabelText('Enabled')).toBeNull();
    for (const label of ['Name', 'Short description', 'Icon', 'Color', 'Category']) {
      expect(basics.getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
    }
  });

  it('keeps app type and position in a collapsed "More details"', async () => {
    await renderForm(loaded(fresh()), { jsonSchema });
    const basics = within(groupParts('basics').panel);
    const details = basics.getByText('More details').closest('details');
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByLabelText('App type')).toHaveValue('chat');
    expect(within(details).getByLabelText('Position in the app list')).toHaveValue(0);
    // Nowhere else in the group.
    expect(basics.getAllByLabelText('App type')).toHaveLength(1);
    expect(basics.getAllByLabelText('Position in the app list')).toHaveLength(1);
  });

  it('shows model settings in Model, and auto-start, ephemeral chat and the usage guide in Chat features', async () => {
    const { probe } = await renderForm(loaded(fresh()), { jsonSchema });
    const chat = within(groupParts('chat').panel);
    const basics = within(groupParts('basics').panel);
    const instructions = within(groupParts('instructions').panel);
    const model = within(groupParts('model').panel);

    for (const label of ['Auto-start conversation', 'Ephemeral chat']) {
      expect(chat.getByLabelText(label)).not.toBeChecked();
      expect(basics.queryByText(label)).toBeNull();
    }
    const guideTitle = en.admin.apps.edit.usageGuide.title;
    expect(chat.getByRole('heading', { name: guideTitle, hidden: true })).toBeInTheDocument();
    expect(instructions.queryByRole('heading', { name: guideTitle })).toBeNull();

    for (const name of ['preferredModel', 'preferredOutputFormat']) {
      expect(groupParts('model').panel.querySelector(`select[name="${name}"]`)).not.toBeNull();
      expect(groupParts('basics').panel.querySelector(`select[name="${name}"]`)).toBeNull();
    }
    expect(model.getByText(en.admin.apps.edit.allowedModels)).toBeInTheDocument();

    fireEvent.click(chat.getByLabelText('Ephemeral chat'));
    expect(probe.app.ephemeral).toBe(true);
    fireEvent.click(chat.getByLabelText('Auto-start conversation'));
    expect(probe.app.autoStart).toBe(true);
  });

  it('renders the titles of Skills and Workflows as text, and no label as an object or a key', async () => {
    for (const language of ['en', 'de']) {
      setUiLanguage(language);
      const { unmount } = await renderForm(loaded(fresh(language)), { jsonSchema });
      const knowledge = within(groupParts('knowledge').panel);
      expect(knowledge.getByRole('heading', { name: 'Skills', hidden: true })).toBeTruthy();
      expect(knowledge.getByRole('heading', { name: 'Workflows', hidden: true })).toBeTruthy();
      const text = document.body.textContent;
      expect(text).not.toMatch(/\[object /);
      expect(text).not.toMatch(/returned an object/);
      expect(text).not.toMatch(/admin\.apps\./);
      unmount();
    }
  });

  /** An app whose two open groups render every label they have. */
  const wordyApp = language =>
    loaded({
      ...fresh(language),
      prompt: { [language]: 'Ton: {{tone}}\n\n{{content}}' },
      messagePlaceholder: { [language]: 'Text' },
      variables: [
        {
          name: 'tone',
          label: { [language]: 'Ton' },
          type: 'select',
          required: true,
          defaultValue: { [language]: 'formal' },
          predefinedValues: [{ value: 'formal', label: { [language]: 'Formal' } }]
        },
        { name: 'unused', label: { [language]: 'Extra' }, type: 'string', required: false }
      ],
      starterPrompts: [
        { title: { [language]: 'Los' }, message: { [language]: 'Los' }, autoSend: false }
      ],
      startForm: { enabled: true, submitLabel: { [language]: 'Start' } }
    });

  /** Labels, headings, legends, buttons and placeholders of the two open groups. */
  function wordsOfOpenGroups() {
    const words = [];
    for (const id of ['basics', 'instructions']) {
      const { group } = groupParts(id);
      for (const element of group.querySelectorAll(
        'label, legend, summary, button, h2, h3, h4, option, [role="group"] > div > span'
      )) {
        words.push(element.textContent, element.getAttribute('aria-label') || '');
      }
      for (const element of group.querySelectorAll('[placeholder]')) {
        words.push(element.getAttribute('placeholder'));
      }
      for (const element of group.querySelectorAll('[title]')) {
        words.push(element.getAttribute('title'));
      }
    }
    return words.filter(Boolean);
  }

  it.each([
    [
      'en',
      ['Variable', 'Starter Prompt', 'System Prompt', 'Prompt Template', 'App Type', 'Order'],
      /system prompt/gi
    ],
    ['de', ['Variable', 'Starter-Prompt', 'System-Prompt', 'Prompt-Vorlage'], /System-Prompt/g]
  ])(
    'uses the new words in the two open groups (%s)',
    async (language, forbidden, systemPrompt) => {
      setUiLanguage(language);
      await renderForm(wordyApp(language), { jsonSchema });
      fireEvent.click(document.querySelector('details > summary'));
      const words = wordsOfOpenGroups();
      expect(words.length).toBeGreaterThan(40);
      for (const word of forbidden) {
        expect(words.filter(text => text.includes(word))).toEqual([]);
      }
      // The technical term appears once, in the help text of Instructions.
      const text =
        groupParts('basics').group.textContent + groupParts('instructions').group.textContent;
      expect(text.match(systemPrompt)).toHaveLength(1);
      expect(text).not.toMatch(/admin\.apps\./);
    }
  );

  it('uses the vocabulary of the plan for the labels of the two open groups', async () => {
    await renderForm(wordyApp('en'), { jsonSchema });
    const instructions = within(groupParts('instructions').panel);
    for (const heading of ['Instructions', 'Input fields', 'Conversation starters']) {
      expect(instructions.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    for (const label of [
      /^Instructions/,
      'Hint in the message box',
      'Message template',
      /^Placeholder/,
      'Kind of field',
      'Users must fill this in',
      'Prefilled value',
      /^Text the AI receives/,
      /^Text on the button/,
      /^Message\b/
    ]) {
      expect(instructions.getAllByLabelText(label).length).toBeGreaterThan(0);
    }
    expect(instructions.getAllByLabelText(/^Field name/).length).toBe(2);
    expect(instructions.getByRole('button', { name: 'Add input field' })).toBeInTheDocument();
    expect(instructions.getAllByRole('button', { name: 'Add option' })).toHaveLength(2);
    expect(
      instructions.getByRole('button', { name: 'Add conversation starter' })
    ).toBeInTheDocument();
    expect(
      within(instructions.getAllByLabelText('Kind of field')[0])
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Short text', 'Long text', 'Dropdown (choose one)', 'Date', 'Number']);
    // The help lines say what belongs into a field; the braces are text for the reader.
    expect(
      instructions.getByText(/Write {{content}} where the user's message should go/)
    ).toBeTruthy();
    expect(instructions.getByText(/^Write {{tone}} in the instructions/)).toBeTruthy();
    expect(instructions.getByText(/Grey text in the empty message box/)).toBeTruthy();
  });

  it('names a new input field by the new word in the error summary', async () => {
    const { probe } = await renderForm(loaded(fresh()), { jsonSchema });
    fireEvent.click(
      within(groupParts('instructions').panel).getByRole('button', { name: 'Add input field' })
    );
    // A new field has no field name and no placeholder yet.
    expect(probe.validation.errors.map(error => error.field).sort()).toEqual([
      'variables.0.label.en',
      'variables.0.name'
    ]);
    const links = within(document.querySelector('.app-form-editor [aria-live]'))
      .getAllByRole('button')
      .map(link => link.textContent);
    expect(links.sort()).toEqual([
      'Input field 1, Field name — English',
      'Input field 1, Placeholder'
    ]);
  });

  it('says in German what is wrong with a new input field and a new conversation starter', async () => {
    setUiLanguage('de');
    const { probe } = await renderForm(loaded(fresh('de')), { jsonSchema });
    const instructions = within(groupParts('instructions').panel);
    fireEvent.click(instructions.getByRole('button', { name: 'Eingabefeld hinzufügen' }));
    fireEvent.click(instructions.getByRole('button', { name: 'Einstiegsfrage hinzufügen' }));

    const fields = probe.validation.errors.map(error => error.field).sort();
    expect(fields).toEqual([
      'starterPrompts.0.message.de',
      'starterPrompts.0.title.de',
      'variables.0.label.de',
      'variables.0.name'
    ]);
    const summary = within(document.querySelector('.app-form-editor [aria-live]'));
    expect(summary.getByRole('heading')).toHaveTextContent(
      /^Bitte beheben Sie die folgenden Fehler\s*\(4 Fehler\)$/
    );
    const entries = summary.getAllByRole('listitem').map(item => item.textContent);
    expect(entries.sort()).toEqual([
      'Eingabefeld 1, Feldname — Deutsch: Dieses Feld ist leer. Geben Sie einen Text ein.',
      'Eingabefeld 1, Platzhalter: Dieses Feld ist leer. Geben Sie einen Text ein.',
      'Einstiegsfrage 1, Nachricht — Deutsch: Dieses Feld ist leer. Geben Sie einen Text ein.',
      'Einstiegsfrage 1, Text der Schaltfläche — Deutsch: Dieses Feld ist leer. Geben Sie einen Text ein.'
    ]);
    // No sentence of the schema validator and no path of a field, anywhere in the form.
    for (const { field, message } of probe.validation.errors) {
      expect(message).not.toMatch(/must be|is invalid|is required|Please enter/);
      expect(message).not.toContain(field);
    }
    const text = document.querySelector('.app-form-editor').textContent;
    expect(text).not.toMatch(/must be at least|format is invalid|\berrors?\)/);
    expect(text).not.toMatch(/variables\.0|starterPrompts\.0/);
  });

  it('names a field, a language and the rule in the reader\u2019s language', async () => {
    setUiLanguage('de');
    const { probe } = await renderForm(
      { ...loaded(fresh('de')), name: { de: 'Einfache Sprache', fr: '' }, order: -1 },
      { jsonSchema }
    );
    expect(probe.validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'name.fr',
          message: 'Dieses Feld ist leer. Geben Sie einen Text ein.'
        }),
        expect.objectContaining({
          field: 'order',
          message: 'Diese Zahl ist zu klein. Geben Sie eine Zahl ein, die mindestens 0 ist.'
        })
      ])
    );
    const links = within(document.querySelector('.app-form-editor [aria-live]'))
      .getAllByRole('button')
      .map(link => link.textContent);
    expect(links).toEqual(
      expect.arrayContaining(['Name — Französisch', 'Position in der App-Liste'])
    );
  });

  it('says what a placeholder may contain when it has other characters', async () => {
    const app = loaded(fresh());
    const { probe } = await renderForm(
      { ...app, variables: [{ name: '1 tone', label: { en: 'Tone' }, type: 'string' }] },
      { jsonSchema }
    );
    expect(probe.validation.errors).toEqual([
      expect.objectContaining({
        field: 'variables.0.name',
        message:
          'This placeholder is not allowed. Start with a letter or an underscore, and use only letters, digits, hyphens and underscores.'
      })
    ]);
  });

  it('says so when an app has no input fields', async () => {
    await renderForm(loaded(fresh()), { jsonSchema });
    expect(
      within(groupParts('instructions').panel).getByText(
        'No input fields. Users write a message, nothing else.'
      )
    ).toBeInTheDocument();
  });

  it.each([
    ['one language', fresh()],
    [
      'two languages',
      {
        ...fresh(),
        name: { en: 'Plain language', de: 'Einfache Sprache' },
        description: { en: 'Rewrites a text.', de: 'Schreibt einen Text um.' },
        system: { en: 'You rewrite texts.', de: 'Sie schreiben Texte um.' }
      }
    ]
  ])('shows one asterisk on every required label (%s)', async (_case, app) => {
    await renderForm(loaded(app), { jsonSchema });
    const starred = [];
    for (const id of ['basics', 'instructions']) {
      for (const label of groupParts(id).panel.querySelectorAll('label, span[id], legend')) {
        const stars = (label.textContent.match(/\*/g) || []).length;
        expect(stars).toBeLessThanOrEqual(1);
        if (stars === 1) starred.push(label.textContent.replaceAll('*', '').trim());
      }
    }
    expect(starred).toEqual(['Name', 'Short description', 'Icon', 'Color', 'Instructions']);
    expect(
      within(groupParts('basics').panel).getByText('Fields marked with * are required.')
    ).toBeInTheDocument();
  });

  it.each([
    [
      'iframe',
      { type: 'iframe', iframeConfig: { url: 'https://example.com/frame' } },
      'Iframe URL'
    ],
    [
      'redirect',
      { type: 'redirect', redirectConfig: { url: 'https://example.com/go' } },
      'Redirect URL'
    ]
  ])('renders a %s app as Basics plus its configuration card', async (type, patch, urlLabel) => {
    const base = fresh();
    delete base.system;
    const { probe } = await renderForm(padLoadedApp({ ...base, ...patch }), { jsonSchema });
    expect(renderedGroupIds()).toEqual(['basics', 'access']);
    expect(probe.groups.groups.map(group => group.id)).toEqual(['basics', 'access']);
    expect(probe.validation).toEqual({ isValid: true, errors: [] });
    const basics = within(groupParts('basics').panel);
    const url = basics.getByText(urlLabel, { exact: false }).parentElement.querySelector('input');
    expect(url).toHaveValue(patch[`${type}Config`].url);
    fireEvent.change(url, { target: { value: 'https://example.org/next' } });
    expect(probe.app[`${type}Config`].url).toBe('https://example.org/next');
    expect(cleanAppForSave(probe.app).type).toBe(type);
    // Nothing of a chat app is rendered.
    expect(screen.queryByRole('heading', { name: 'Input fields' })).toBeNull();
  });

  it('keeps its own group state when the page hands it none', async () => {
    let latest = loaded(fresh());
    await act(async () => {
      const { MemoryRouter } = require('react-router-dom');
      render(
        <MemoryRouter>
          <AppFormEditor
            value={latest}
            onChange={next => {
              latest = next;
            }}
            jsonSchema={jsonSchema}
          />
        </MemoryRouter>
      );
    });
    expect(renderedGroupIds()).toEqual([
      'basics',
      'instructions',
      'model',
      'knowledge',
      'chat',
      'input',
      'userSettings'
    ]);
    expect(openGroupIds()).toEqual(['basics', 'instructions']);
    fireEvent.click(groupParts('model').header);
    expect(openGroupIds()).toEqual(['basics', 'instructions', 'model']);
    expect(groupParts('chat').header).toHaveTextContent('Upload off · export, feedback on');
  });
});
