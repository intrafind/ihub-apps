// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the tests of the app editor's form (`AppFormEditor` and
 * `components/app-form/`) share: a `t` that reads the real English and German
 * texts, stand-ins for the requests the form's sections send, and a frame
 * that renders the form the way the editor page does.
 *
 * The form, its sections, the groups (`EditorGroup`, `EditorGroupNav`,
 * `useEditorGroups`) and the language component are the real ones.
 *
 * @example
 * jest.mock('react-i18next', () => require('./helpers/appFormHarness').i18nMock());
 * jest.mock('../../../client/src/api/adminApi', () =>
 *   require('./helpers/appFormHarness').adminApiMock()
 * );
 */
const React = require('react');
const en = require('../../../../shared/i18n/en.json');
const de = require('../../../../shared/i18n/de.json');

const LOCALES = { en, de };

const lookup = (locale, key) =>
  key
    .split('.')
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), locale);

/**
 * A `t` for one UI language. It reads the locale file, then a fallback the
 * call carries. A key without any of
 * them comes back as the key, and a key that names a group of keys as
 * `[object <key>]`, so a test that looks for a text fails on both.
 *
 * @param {'en'|'de'} language
 * @returns {function(string, (string|object)=, object=): string}
 */
function localeT(language) {
  const locale = LOCALES[language];
  const textOf = key => {
    const text = lookup(locale, key);
    return typeof text === 'string' ? text : undefined;
  };
  return (key, fallbackOrOptions, maybeOptions) => {
    const options =
      fallbackOrOptions && typeof fallbackOrOptions === 'object'
        ? fallbackOrOptions
        : maybeOptions || {};
    const fallback =
      typeof fallbackOrOptions === 'string' ? fallbackOrOptions : options.defaultValue;
    let text = textOf(key);
    if (typeof text !== 'string' && typeof options.count === 'number') {
      text = textOf(`${key}_${options.count === 1 ? 'one' : 'other'}`);
    }
    if (typeof text !== 'string') {
      if (lookup(locale, key) && typeof lookup(locale, key) === 'object') return `[object ${key}]`;
      text = fallback;
    }
    if (typeof text !== 'string') return key;
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
  };
}

const translations = {
  en: { t: localeT('en'), i18n: { language: 'en' } },
  de: { t: localeT('de'), i18n: { language: 'de' } }
};
let uiLanguage = 'en';

/** Sets the UI language of the next render: `'en'` or `'de'`. */
function setUiLanguage(language) {
  uiLanguage = language;
}

/** The module `react-i18next` for a `jest.mock` factory. */
function i18nMock() {
  return {
    __esModule: true,
    // The same object per language on every render, as the real hook gives.
    useTranslation: () => translations[uiLanguage],
    Trans: ({ children }) => children ?? null
  };
}

/**
 * A request that answers with an empty list, in every shape the sections
 * read: a plain array, `{ items }` and an axios response `{ data: { items } }`.
 */
const emptyAnswer = () =>
  Promise.resolve(
    Object.assign([], { data: { items: [], nextCursor: null }, items: [], nextCursor: null })
  );

/**
 * An API module of the client (`api/adminApi`, `api/integrationsAdminApi`,
 * …) for a `jest.mock` factory: every request answers with an empty list.
 */
function adminApiMock(overrides = {}) {
  const handler = {
    get(target, name) {
      if (name === '__esModule') return true;
      if (name === 'then') return undefined;
      if (name === 'getAdminApiErrorMessage') return error => error?.message || 'failed';
      if (typeof name !== 'string') return undefined;
      if (Object.hasOwn(overrides, name)) return overrides[name];
      target[name] ??= jest.fn(emptyAnswer);
      return target[name];
    }
  };
  return new Proxy({}, handler);
}

/** The module `client/src/api/endpoints/config`: the shipped list of file formats, nothing else. */
function configApiMock() {
  const mimetypes = require('../../../../server/defaults/config/mimetypes.json');
  return adminApiMock({ fetchMimetypesConfig: () => Promise.resolve(mimetypes) });
}

/** The module `client/src/api/client`: an `apiClient` whose requests answer with an empty list. */
function apiClientMock() {
  const request = jest.fn(emptyAnswer);
  const apiClient = { request, get: request, post: request, put: request, delete: request };
  return { __esModule: true, apiClient, default: apiClient };
}

/** The module `shared/contexts/PlatformConfigContext`: an empty platform configuration. */
function platformConfigMock() {
  const value = { platformConfig: {}, loading: false };
  return { __esModule: true, usePlatformConfig: () => value };
}

/** The feature switches of the platform: all on, so the form shows every section. */
function featureFlagsMock() {
  const flags = { isEnabled: () => true, isAppFeatureEnabled: () => true };
  return { __esModule: true, default: () => flags, useFeatureFlags: () => flags };
}

/** A component module that renders a marker in place of a heavy child. */
function stubComponent(name) {
  const Stub = () => React.createElement('div', { 'data-testid': `stub-${name}` });
  return { __esModule: true, default: Stub };
}

/**
 * The `jest.mock` calls a test of the whole form needs, as text to keep the
 * list in one place. Copy it into the test file; `jest.mock` is hoisted per
 * file and cannot be called from here.
 *
 * @example
 * jest.mock('react-i18next', () => require('./helpers/appFormHarness').i18nMock());
 * jest.mock('../../../client/src/api/adminApi', () => require('./helpers/appFormHarness').adminApiMock());
 * jest.mock('../../../client/src/api/integrationsAdminApi', () => require('./helpers/appFormHarness').adminApiMock());
 * jest.mock('../../../client/src/api/documentTemplatesAdminApi', () => require('./helpers/appFormHarness').adminApiMock());
 * jest.mock('../../../client/src/api/endpoints/skills', () => require('./helpers/appFormHarness').adminApiMock());
 * jest.mock('../../../client/src/api/endpoints/config', () => require('./helpers/appFormHarness').configApiMock());
 * jest.mock('../../../client/src/api/client', () => require('./helpers/appFormHarness').apiClientMock());
 * jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => require('./helpers/appFormHarness').platformConfigMock());
 * jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => require('./helpers/appFormHarness').featureFlagsMock());
 * jest.mock('../../../client/src/utils/runtimeBasePath', () => require('./helpers/appFormHarness').basePathMock());
 */
function basePathMock() {
  // The real module uses `import.meta`, which the Jest transform cannot parse.
  return { getBasePath: () => '', buildPath: path => path, buildAssetUrl: path => path };
}

/**
 * The form as the editor page frames it: the page's state of the app, one
 * `useEditorGroups`, the index, the form inside its groups and the group
 * "Who can use this app" below it.
 *
 * @param {object} props
 * @param {object} props.initialApp - The app as the editor holds it after loading.
 * @param {object} [props.jsonSchema] - The JSON schema of an app.
 * @param {object[]} [props.models] - The models the author may use.
 * @param {object} [props.access] - The content-access view, for the summary of the access group.
 * @param {object} props.probe - Receives `app`, `groups`, `validation` and `changes` on every render.
 */
function FormFrame({ initialApp, jsonSchema, models, access, probe }) {
  // Required here, after the test file's `jest.mock` calls took effect.
  const { MemoryRouter } = require('react-router-dom');
  const AppFormEditor =
    require('../../../../client/src/features/admin/components/AppFormEditor').default;
  const EditorGroup =
    require('../../../../client/src/features/admin/components/app-form/EditorGroup').default;
  const EditorGroupNav =
    require('../../../../client/src/features/admin/components/app-form/EditorGroupNav').default;
  const {
    useEditorGroups
  } = require('../../../../client/src/features/admin/components/app-form/useEditorGroups');

  const [app, setApp] = React.useState(initialApp);
  const [validation, setValidation] = React.useState({ isValid: true, errors: [] });
  const language = translations[uiLanguage].i18n.language;
  const extra = React.useMemo(() => ({ models, language, access }), [models, language, access]);
  const groups = useEditorGroups({ app, errors: validation.errors, extra });
  const handleChange = next => {
    probe.changes.push(next);
    setApp(next);
  };
  Object.assign(probe, { app, groups, validation });

  return (
    <MemoryRouter>
      <EditorGroupNav groups={groups} />
      <AppFormEditor
        value={app}
        onChange={handleChange}
        onValidationChange={setValidation}
        availableModels={models}
        uiConfig={null}
        jsonSchema={jsonSchema}
        groups={groups}
      />
      <EditorGroup id="access" groups={groups}>
        <div data-testid="access-section" />
      </EditorGroup>
    </MemoryRouter>
  );
}

/**
 * Renders the form in its frame and waits for what its sections load.
 *
 * @param {object} app - The app as the editor holds it after loading.
 * @param {object} [options] - `jsonSchema`, `models`, `access`.
 * @returns {Promise<object>} The render result plus `probe`: `probe.app` is
 *   the app the form holds now, `probe.groups` the state of the groups,
 *   `probe.validation` what the form reported last, `probe.changes` every
 *   app it handed to `onChange`.
 */
async function renderForm(app, { jsonSchema, models = [], access } = {}) {
  const { act, render } = require('@testing-library/react');
  const probe = { changes: [] };
  let view;
  await act(async () => {
    view = render(
      <FormFrame
        initialApp={app}
        jsonSchema={jsonSchema}
        models={models}
        access={access}
        probe={probe}
      />
    );
  });
  return { ...view, probe };
}

/** The group with an ID: its wrapper, header button and panel. */
function groupParts(id) {
  return {
    group: document.getElementById(`app-group-${id}`),
    header: document.getElementById(`app-group-${id}-header`),
    panel: document.getElementById(`app-group-${id}-panel`)
  };
}

/** The IDs of the groups that are rendered and open, in page order. */
function openGroupIds() {
  return [...document.querySelectorAll('section[id^="app-group-"]')]
    .filter(section => section.querySelector(':scope > h2 > button[aria-expanded="true"]'))
    .map(section => section.id.replace('app-group-', ''));
}

/** The IDs of the groups that are rendered, in page order. */
function renderedGroupIds() {
  return [...document.querySelectorAll('section[id^="app-group-"]')].map(section =>
    section.id.replace('app-group-', '')
  );
}

module.exports = {
  localeT,
  setUiLanguage,
  i18nMock,
  adminApiMock,
  apiClientMock,
  configApiMock,
  platformConfigMock,
  featureFlagsMock,
  basePathMock,
  stubComponent,
  emptyAnswer,
  FormFrame,
  renderForm,
  groupParts,
  openGroupIds,
  renderedGroupIds
};
