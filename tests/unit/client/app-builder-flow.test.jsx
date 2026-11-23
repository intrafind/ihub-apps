// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The "New app" page (`/admin/apps/new`) and the apps list that leads to it.
 *
 * The page, its screens and the shared core are the real ones, with the real
 * English and German texts and the real template files. Only the API module
 * is a stub (and what the Jest transform cannot load: the icon component and
 * the two contexts that read the server's configuration).
 *
 * Each `describe` block follows one acceptance criterion of slice S3
 * (concepts/app-builder-rework-2026-11/README.md, section 6.2).
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import emailTemplate from '../../../server/appTemplates/email-composer.json';
import summarizerTemplate from '../../../server/appTemplates/summarizer.json';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { newAppDefaults } from '../../../shared/appDefaults.js';

const mockApi = {
  createAdminApp: jest.fn(),
  fetchAdminApp: jest.fn(),
  fetchAdminApps: jest.fn(),
  fetchAdminAppTemplates: jest.fn(),
  fetchAppIntegrationStatus: jest.fn(),
  fetchAppStartTemplates: jest.fn(),
  generateAppDraft: jest.fn(),
  makeAdminApiCall: jest.fn(),
  reorderApps: jest.fn(),
  toggleApps: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  createAdminApp: (...args) => mockApi.createAdminApp(...args),
  fetchAdminApp: (...args) => mockApi.fetchAdminApp(...args),
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAdminAppTemplates: (...args) => mockApi.fetchAdminAppTemplates(...args),
  fetchAppIntegrationStatus: (...args) => mockApi.fetchAppIntegrationStatus(...args),
  fetchAppStartTemplates: (...args) => mockApi.fetchAppStartTemplates(...args),
  generateAppDraft: (...args) => mockApi.generateAppDraft(...args),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args),
  reorderApps: (...args) => mockApi.reorderApps(...args),
  toggleApps: (...args) => mockApi.toggleApps(...args)
}));

const mockGeneral = { fetchModels: jest.fn(), fetchUIConfig: jest.fn() };
jest.mock('../../../client/src/api', () => ({
  fetchAppDetails: jest.fn(),
  fetchModels: (...args) => mockGeneral.fetchModels(...args),
  fetchUIConfig: (...args) => mockGeneral.fetchUIConfig(...args)
}));

// The UI configuration as the app-wide `DocumentTitle` reads it.
const mockUi = { uiConfig: {}, isLoading: false };
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: mockUi.uiConfig, isLoading: mockUi.isLoading })
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: jest.fn().mockResolvedValue({ items: [] })
}));

// The loader of another language's texts: the real one fetches them from the server.
const mockLanguages = { load: jest.fn() };
jest.mock('../../../client/src/services/i18nService', () => ({
  __esModule: true,
  default: { loadFullTranslations: (...args) => mockLanguages.load(...args) }
}));

// What the page reads about the installation and the person.
const mockEnv = { platformConfig: {}, user: {} };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockEnv.platformConfig })
}));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockEnv.user })
}));

// runtimeBasePath and Icon use `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/AppDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const AdminAppCreatePage =
  require('../../../client/src/features/admin/pages/AdminAppCreatePage').default;
const AdminAppsPage = require('../../../client/src/features/admin/pages/AdminAppsPage').default;
const DocumentTitle = require('../../../client/src/shared/components/DocumentTitle').default;
const {
  APP_DRAFT_STORAGE_KEY
} = require('../../../client/src/features/admin/components/app-create/useAppDraft');

const {
  APP_COLOR_SWATCHES
} = require('../../../client/src/features/admin/components/app-create/ColorSwatchPicker');

const CREATE = en.admin.apps.create;
const CREATE_DE = de.admin.apps.create;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`
  });
});

/** An item of `GET /api/admin/app-templates`, built from the shipped file as the server does. */
function templateItem(file) {
  const { id, ...app } = file;
  return {
    id,
    name: file.name,
    description: file.description,
    icon: file.icon,
    color: file.color,
    category: file.category,
    hasInputFields: Array.isArray(file.variables) && file.variables.length > 0,
    app
  };
}

/** A stored app with everything a copy must and must not take over. */
const TRAVEL_APP = {
  ...newAppDefaults('en'),
  id: 'travel-policy',
  order: 7,
  name: { en: 'Travel policy', de: 'Reiserichtlinie' },
  description: { en: 'Answers travel questions.', de: 'Beantwortet Reisefragen.' },
  system: { en: 'You answer questions about travel.', de: 'Sie beantworten Reisefragen.' },
  enabled: true,
  parentId: 'chat',
  inheritanceLevel: 1,
  overriddenFields: ['name', 'system'],
  allowInheritance: true,
  integrations: { jira: { actions: ['searchIssues'] } },
  upload: { enabled: true, fileUpload: { enabled: true, maxFileSizeMB: 5 } }
};

const CHAT_APP = { id: 'chat', name: { en: 'Chat', de: 'Chat' }, enabled: true };
const DRAFT_APP = { id: 'draft-app', name: { en: 'Unfinished' }, enabled: false };

const GEMINI = {
  id: 'gemini-flash',
  name: { en: 'Gemini Flash' },
  provider: 'google',
  default: true
};

function apiProblem(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

beforeEach(async () => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  document.title = 'iHub Apps';
  mockUi.uiConfig = {};
  mockUi.isLoading = false;
  await mockI18n.changeLanguage('en');
  mockEnv.platformConfig = { defaultLanguage: 'en', featuresMap: {} };
  mockEnv.user = { id: 'admin', isAdmin: true, permissions: { adminAccess: true } };
  mockGeneral.fetchModels.mockResolvedValue([GEMINI]);
  mockGeneral.fetchUIConfig.mockResolvedValue({
    appsList: {
      categories: {
        list: [
          { id: 'all', name: { en: 'All' } },
          { id: 'utility', name: { en: 'Utility', de: 'Werkzeuge' } },
          { id: 'writing', name: { en: 'Writing', de: 'Schreiben' } }
        ]
      }
    }
  });
  mockApi.fetchAdminApps.mockResolvedValue([CHAT_APP, TRAVEL_APP, DRAFT_APP]);
  mockApi.fetchAdminAppTemplates.mockResolvedValue([CHAT_APP, TRAVEL_APP]);
  mockApi.fetchAppStartTemplates.mockResolvedValue([
    templateItem(summarizerTemplate),
    templateItem(emailTemplate)
  ]);
  mockApi.fetchAppIntegrationStatus.mockResolvedValue({});
  mockApi.fetchAdminApp.mockImplementation(async id => {
    if (id === TRAVEL_APP.id) return TRAVEL_APP;
    throw apiProblem(404, { code: 'NOT_FOUND', detail: 'App not found' });
  });
  mockApi.createAdminApp.mockImplementation(async payload => payload);
  mockLanguages.load.mockResolvedValue(undefined);
});

// A state update outside act() means a test ended, or went on, before the page had settled.
let consoleError;
beforeEach(() => {
  consoleError = jest.spyOn(console, 'error');
});
afterEach(() => {
  const unsettled = consoleError.mock.calls.filter(call =>
    String(call[0]).includes('not wrapped in act')
  );
  consoleError.mockRestore();
  expect(unsettled).toEqual([]);
});

/** Shows where the router is, so a test can read a navigation. */
function Where({ label }) {
  const location = useLocation();
  return (
    <div data-testid="where">
      {label}:{location.pathname}
      {location.search}
    </div>
  );
}

function createTree(url = '/admin/apps/new') {
  return (
    <MemoryRouter initialEntries={[url]}>
      <DocumentTitle />
      <Routes>
        <Route path="/admin/apps" element={<Where label="LIST" />} />
        <Route
          path="/admin/apps/new"
          element={
            <>
              <AdminAppCreatePage />
              <Where label="NEW" />
            </>
          }
        />
        <Route path="/admin/apps/:appId" element={<Where label="EDITOR" />} />
        <Route path="/admin/models" element={<Where label="MODELS" />} />
        <Route path="/admin/marketplace" element={<Where label="MARKETPLACE" />} />
      </Routes>
    </MemoryRouter>
  );
}

const renderCreate = url => render(createTree(url));

const where = () => screen.getByTestId('where').textContent;
const type = (element, value) => fireEvent.change(element, { target: { value } });
const nameField = () => screen.getByLabelText(/^Name/);
const descriptionField = () => screen.getByLabelText(/^(Short description|Kurzbeschreibung)/);
const instructionsField = () => screen.getByLabelText(/^(Instructions|Anweisungen)/);
const heading = () => screen.getByRole('heading', { level: 1 });

/** The Start screen has its templates: nothing is still loading. */
const startSettled = () =>
  screen.findByRole('button', { name: /Text Summarizer|Textzusammenfassung/ });

/** The Start screen with its lists loaded. */
async function openStart(url) {
  const view = renderCreate(url);
  await screen.findByRole('button', { name: /^(Start empty|Leer beginnen)$/ });
  await screen.findByRole('button', { name: /Text Summarizer|Textzusammenfassung/ });
  return view;
}

async function startEmpty() {
  await openStart();
  fireEvent.click(screen.getByRole('button', { name: /^(Start empty|Leer beginnen)$/ }));
}

async function submit() {
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: /^(Create and test|Erstellen und testen)$/ })
    );
  });
}

function fillEssentials({ name = 'Plain-language summary' } = {}) {
  type(nameField(), name);
  type(descriptionField(), 'Rewrites a text so that everyone understands it.');
  type(instructionsField(), 'You rewrite texts in plain language.');
}

/** The card that opens the copy dialog: its name, then its description. */
const COPY_CARD = new RegExp(`^${CREATE.start.copy}`);

const lastPayload = () => mockApi.createAdminApp.mock.calls.at(-1)[0];
const lastOrigin = () => mockApi.createAdminApp.mock.calls.at(-1)[1];

describe('Start screen', () => {
  it('shows the description box, the templates and "Start empty", and nothing else to choose', async () => {
    await openStart();
    expect(heading()).toHaveTextContent('New app');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await screen.findByLabelText(CREATE.start.label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Email Composer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeInTheDocument();

    // Copying is the last card of the templates grid, not under "Other ways to start".
    const cards = within(screen.getByRole('region', { name: CREATE.start.templates.heading }))
      .getAllByRole('button')
      .map(card => card.textContent);
    expect(cards.at(-1)).toBe(`${CREATE.start.copy}${CREATE.start.copyHelp}`);

    const other = screen.getByRole('button', { name: CREATE.start.other });
    expect(other).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(CREATE.start.link.action)).not.toBeInTheDocument();
    expect(screen.queryByText(CREATE.start.marketplace)).not.toBeInTheDocument();

    fireEvent.click(other);
    expect(other).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText(CREATE.start.copy)).toHaveLength(1);
    expect(screen.getByRole('button', { name: CREATE.start.link.action })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: CREATE.start.marketplace })).toBeInTheDocument();
  });

  it('opens the copy dialog from its card, and gives the focus back to the card on close', async () => {
    await openStart();
    const card = screen.getByRole('button', { name: COPY_CARD });
    card.focus();
    fireEvent.click(card);
    const dialog = await screen.findByRole('dialog', { name: CREATE.copy.heading });
    expect(within(dialog).getByLabelText(CREATE.copy.search)).toHaveFocus();
    expect(
      await within(dialog).findByRole('button', { name: /Travel policy/ })
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(card).toHaveFocus());
  });

  it('shows the copy card when the templates cannot be loaded', async () => {
    mockApi.fetchAppStartTemplates.mockRejectedValueOnce(new Error('boom'));
    renderCreate();
    expect(
      await screen.findByText(CREATE.start.templates.loadError, { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY_CARD })).toBeInTheDocument();
  });

  it('shows the copy card without a Templates heading when there are no templates', async () => {
    mockApi.fetchAppStartTemplates.mockResolvedValue([]);
    renderCreate();
    await screen.findByRole('button', { name: 'Start empty' });
    // The heading is there while the templates load, and goes once the list is empty.
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: CREATE.start.templates.heading })
      ).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: COPY_CARD })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: CREATE.start.templates.heading })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: CREATE.start.templates.heading })
    ).not.toBeInTheDocument();
  });

  it('names the step in a nav with aria-current, and the screen in the document title', async () => {
    await openStart();
    const step = screen.getByText('Step 1 of 2: Start');
    expect(step).toHaveAttribute('aria-current', 'step');
    expect(step.closest('nav')).not.toBeNull();
    expect(document.title).toBe('New app | Admin | iHub Apps');

    fireEvent.click(screen.getByRole('button', { name: 'Start empty' }));
    expect(screen.getByText('Step 2 of 2: Essentials')).toHaveAttribute('aria-current', 'step');
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.blank);
    expect(heading()).toHaveFocus();
    expect(document.title).toBe('Describe your app | Admin | iHub Apps');
  });

  it('keeps the screen in the title when the UI configuration arrives after the page', async () => {
    mockUi.isLoading = true;
    const view = renderCreate();
    await startSettled();
    // Nothing writes a half title while the configuration loads.
    expect(document.title).toBe('iHub Apps');

    mockUi.isLoading = false;
    mockUi.uiConfig = { title: { en: 'Acme AI' } };
    view.rerender(createTree());
    expect(document.title).toBe('New app | Admin | Acme AI');

    // A later change of the configuration keeps the screen's name, too.
    mockUi.uiConfig = { title: { en: 'Acme Assistants' } };
    view.rerender(createTree());
    expect(document.title).toBe('New app | Admin | Acme Assistants');

    // Leaving the page takes the name out of the title.
    view.unmount();
    render(
      <MemoryRouter initialEntries={['/admin/apps']}>
        <DocumentTitle />
      </MemoryRouter>
    );
    expect(document.title).toBe('Admin | Acme Assistants');
  });

  it('shows a template with its badge, and no badge for a template without input fields', async () => {
    mockApi.fetchAppStartTemplates.mockResolvedValue([
      templateItem(summarizerTemplate),
      { ...templateItem(emailTemplate), hasInputFields: false }
    ]);
    await openStart();
    const summarizer = screen.getByRole('button', { name: /Text Summarizer/ });
    expect(summarizer).toHaveTextContent(CREATE.start.badge.inputFields);
    expect(summarizer).toHaveTextContent('Summarizes a text that you paste.');
    expect(summarizer).not.toHaveTextContent('summarizer');
    expect(screen.getByRole('button', { name: /Email Composer/ })).not.toHaveTextContent(
      CREATE.start.badge.inputFields
    );
  });

  it('says when the templates cannot be loaded, offers to retry, and keeps the rest usable', async () => {
    mockApi.fetchAppStartTemplates.mockRejectedValueOnce(new Error('boom'));
    renderCreate();
    expect(
      await screen.findByText(CREATE.start.templates.loadError, { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CREATE.retry }));
    });
    expect(await screen.findByRole('button', { name: /Text Summarizer/ })).toBeInTheDocument();
  });

  it('hides the Marketplace from a content admin and when the feature is off', async () => {
    mockEnv.user = { id: 'builder', permissions: { contentAdmin: true } };
    const first = await openStart();
    fireEvent.click(screen.getByRole('button', { name: CREATE.start.other }));
    expect(screen.queryByText(CREATE.start.marketplace)).not.toBeInTheDocument();
    first.unmount();

    mockEnv.user = { id: 'admin', isAdmin: true };
    mockEnv.platformConfig = { defaultLanguage: 'en', featuresMap: { marketplace: false } };
    await openStart();
    fireEvent.click(screen.getByRole('button', { name: CREATE.start.other }));
    expect(screen.queryByText(CREATE.start.marketplace)).not.toBeInTheDocument();
  });
});

describe('model check before the first click', () => {
  it('with a model: no notice, and the page names the model the description goes to', async () => {
    await openStart();
    expect(
      await screen.findByText('Your description is sent to the AI model Gemini Flash.')
    ).toBeInTheDocument();
    expect(screen.queryByText(CREATE.noModel.title)).not.toBeInTheDocument();
  });

  it('with no model: the notice replaces the box, an admin gets the link, the other starts work', async () => {
    mockGeneral.fetchModels.mockResolvedValue([]);
    await openStart();
    expect(await screen.findByText(CREATE.noModel.title)).toBeInTheDocument();
    expect(screen.getByText(CREATE.noModel.body)).toBeInTheDocument();
    expect(screen.queryByLabelText(CREATE.start.label)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: CREATE.noModel.actionAdmin })).toHaveAttribute(
      'href',
      '/admin/models'
    );
    expect(screen.queryByText(CREATE.noModel.actionOther)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeEnabled();
    expect(mockGeneral.fetchModels).toHaveBeenCalledWith({ skipCache: true });
  });

  it('a content admin cannot open the models page and is told whom to ask', async () => {
    mockEnv.user = { id: 'builder', permissions: { contentAdmin: true } };
    mockGeneral.fetchModels.mockResolvedValue([]);
    await openStart();
    expect(await screen.findByText(CREATE.noModel.actionOther)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: CREATE.noModel.actionAdmin })
    ).not.toBeInTheDocument();
  });

  it('an image model alone cannot draft', async () => {
    mockGeneral.fetchModels.mockResolvedValue([
      { id: 'img', name: { en: 'Painter' }, supportsImageGeneration: true }
    ]);
    await openStart();
    expect(await screen.findByText(CREATE.noModel.title)).toBeInTheDocument();
  });

  it('with drafting switched off, one line replaces the box', async () => {
    mockEnv.platformConfig = { defaultLanguage: 'en', featuresMap: { appGenerator: false } };
    await openStart();
    expect(screen.getByText(CREATE.generatorOff)).toBeInTheDocument();
    expect(screen.queryByLabelText(CREATE.start.label)).not.toBeInTheDocument();
    expect(screen.queryByText(CREATE.noModel.title)).not.toBeInTheDocument();
  });
});

describe('empty start', () => {
  it('ends in one POST and opens the editor with ?created=1', async () => {
    await startEmpty();
    fillEssentials();
    await submit();

    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
    const payload = lastPayload();
    expect(lastOrigin()).toEqual({ origin: 'blank' });
    expect(payload.id).toBe('plain-language-summary');
    expect(payload.enabled).toBe(false);
    expect(payload).not.toHaveProperty('parentId');
    expect(payload).not.toHaveProperty('inheritanceLevel');
    expect(payload).not.toHaveProperty('overriddenFields');
    expect(appConfigSchema.safeParse(payload).success).toBe(true);
    expect(where()).toBe('EDITOR:/admin/apps/plain-language-summary?created=1');
    // Nothing of the draft is kept once the app exists.
    expect(window.sessionStorage.getItem(APP_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('in en-US stores the texts under "en" only', async () => {
    await mockI18n.changeLanguage('en-US');
    await startEmpty();
    fillEssentials();
    await submit();
    const payload = lastPayload();
    expect(payload.name).toEqual({ en: 'Plain-language summary' });
    expect(payload.description).toEqual({ en: 'Rewrites a text so that everyone understands it.' });
    expect(payload.system).toEqual({ en: 'You rewrite texts in plain language.' });
  });

  it('in a German UI stores "de" only, and the page is German', async () => {
    await mockI18n.changeLanguage('de-DE');
    await startEmpty();
    expect(heading()).toHaveTextContent(CREATE_DE.essentials.heading.blank);
    type(nameField(), 'Übersetzer für Verträge');
    type(descriptionField(), 'Übersetzt Verträge.');
    type(instructionsField(), 'Sie übersetzen Verträge.');
    // The UI language differs from the platform's default language: the page says which one is written.
    expect(
      screen.getByText('Sie schreiben auf Deutsch. Weitere Sprachen können Sie im Editor ergänzen.')
    ).toBeInTheDocument();
    await submit();
    const payload = lastPayload();
    expect(payload.name).toEqual({ de: 'Übersetzer für Verträge' });
    expect(payload.description).toEqual({ de: 'Übersetzt Verträge.' });
    expect(payload.system).toEqual({ de: 'Sie übersetzen Verträge.' });
    expect(payload.id).toBe('uebersetzer-fuer-vertraege');
    expect(where()).toBe('EDITOR:/admin/apps/uebersetzer-fuer-vertraege?created=1');
  });

  it('shows no language line while the UI language is the platform default', async () => {
    await startEmpty();
    expect(screen.queryByText(/You are writing in/)).not.toBeInTheDocument();
  });
});

describe('template start', () => {
  async function startFromEmailTemplate() {
    await openStart();
    fireEvent.click(screen.getByRole('button', { name: /Email Composer|E-Mail-Verfasser/ }));
  }

  it('shows the template notice, no "(copy)", and the name ready to be replaced', async () => {
    await startFromEmailTemplate();
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.template);
    expect(
      screen.getByText('Started from the template "Email Composer". Change anything you like.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Copied from/)).not.toBeInTheDocument();
    expect(nameField()).toHaveValue('Email Composer');
    expect(nameField()).toHaveFocus();
    expect(nameField().selectionStart).toBe(0);
    expect(nameField().selectionEnd).toBe('Email Composer'.length);
  });

  it('creates the app without typing anything', async () => {
    await startFromEmailTemplate();
    await submit();
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
    expect(lastOrigin()).toEqual({ origin: 'template' });
    const payload = lastPayload();
    expect(payload.id).toBe('email-composer');
    expect(payload.enabled).toBe(false);
    expect(payload.name).toEqual({ en: 'Email Composer' });
    expect(payload.variables.map(field => field.name)).toEqual(['tone']);
    expect(appConfigSchema.safeParse(payload).success).toBe(true);
    expect(where()).toBe('EDITOR:/admin/apps/email-composer?created=1');
  });

  it('in a German UI stores every text in "de" only', async () => {
    await mockI18n.changeLanguage('de');
    await startFromEmailTemplate();
    expect(nameField()).toHaveValue('E-Mail-Verfasser');
    expect(
      screen.getByText('Begonnen mit der Vorlage „E-Mail-Verfasser“. Ändern Sie, was Sie möchten.')
    ).toBeInTheDocument();
    await submit();
    const payload = lastPayload();
    const languagesOf = value => Object.keys(value);
    expect(languagesOf(payload.name)).toEqual(['de']);
    expect(languagesOf(payload.description)).toEqual(['de']);
    expect(languagesOf(payload.system)).toEqual(['de']);
    expect(languagesOf(payload.prompt)).toEqual(['de']);
    expect(languagesOf(payload.messagePlaceholder)).toEqual(['de']);
    for (const field of payload.variables) {
      expect(languagesOf(field.label)).toEqual(['de']);
      for (const option of field.predefinedValues || []) {
        expect(languagesOf(option.label)).toEqual(['de']);
      }
    }
    // The greeting is the default of every new app, in both languages; no text of the template is.
    const { greeting, ...content } = payload;
    expect(Object.keys(greeting).sort()).toEqual(['de', 'en']);
    expect(JSON.stringify(content)).not.toContain('"en"');
  });

  it('warns about an existing name only after the author has left the name field', async () => {
    mockApi.fetchAdminApps.mockResolvedValue([
      CHAT_APP,
      { id: 'mail', name: { en: 'Email Composer' }, enabled: true }
    ]);
    await startFromEmailTemplate();
    const warning = 'An app named "Email Composer" already exists. You can still use the name.';
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    fireEvent.blur(nameField());
    expect(screen.getByText(warning)).toBeInTheDocument();
    // It does not block.
    await submit();
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
  });

  it("takes a free ID when the template's own is taken", async () => {
    mockApi.fetchAdminApps.mockResolvedValue([{ id: 'email-composer', name: { en: 'Mail' } }]);
    await startFromEmailTemplate();
    await submit();
    expect(lastPayload().id).toBe('email-composer-2');
  });
});

describe('copy start (?from=<id>)', () => {
  async function openCopy() {
    renderCreate(`/admin/apps/new?from=${TRAVEL_APP.id}`);
    await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
  }

  it('opens Essentials with the copy, says what is copied, and cleans the URL', async () => {
    await openCopy();
    expect(mockApi.fetchAdminApp).toHaveBeenCalledWith('travel-policy');
    expect(nameField()).toHaveValue('Travel policy (copy)');
    expect(nameField()).toHaveFocus();
    expect(nameField().selectionEnd).toBe('Travel policy (copy)'.length);
    expect(
      screen.getByText(
        'Copied from "Travel policy". Everything is copied, including connected systems and file settings. Group access is not copied.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Started from the template/)).not.toBeInTheDocument();
    // A reload now brings back the draft instead of a fresh copy. The router
    // applies a change of the URL as a transition, which may land a moment later.
    await waitFor(() => expect(where()).toBe('NEW:/admin/apps/new'));
  });

  it('keeps the languages of the source and drops the lineage; one click creates it', async () => {
    await openCopy();
    await submit();
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
    expect(lastOrigin()).toEqual({ origin: 'copy' });
    const payload = lastPayload();
    expect(payload.name).toEqual({ en: 'Travel policy (copy)', de: 'Reiserichtlinie (Kopie)' });
    expect(payload.description).toEqual(TRAVEL_APP.description);
    expect(payload.system).toEqual(TRAVEL_APP.system);
    expect(payload.id).toBe('travel-policy-copy');
    expect(payload.enabled).toBe(false);
    for (const key of [
      'parentId',
      'inheritanceLevel',
      'overriddenFields',
      'allowInheritance',
      'order'
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
    // Connected systems and file settings come along.
    expect(payload.integrations).toEqual(TRAVEL_APP.integrations);
    expect(payload.upload.fileUpload.maxFileSizeMB).toBe(5);
    expect(appConfigSchema.safeParse(payload).success).toBe(true);
    expect(where()).toBe('EDITOR:/admin/apps/travel-policy-copy?created=1');
  });

  describe('in a UI that holds only the texts of its own language, as in the browser', () => {
    const loadGerman = async language => {
      mockI18n.addResourceBundle(language, 'translation', de, true, true);
    };
    beforeEach(() => {
      mockI18n.removeResourceBundle('de', 'translation');
    });
    afterEach(() => {
      mockI18n.addResourceBundle('de', 'translation', de, true, true);
    });

    it('loads the other language of the name, so each name gets its own "(copy)"', async () => {
      mockLanguages.load.mockImplementation(loadGerman);
      await openCopy();
      expect(mockLanguages.load.mock.calls).toEqual([['de']]);
      await submit();
      expect(lastPayload().name).toEqual({
        en: 'Travel policy (copy)',
        de: 'Reiserichtlinie (Kopie)'
      });
    });

    it('does the same for an app picked from the list', async () => {
      mockLanguages.load.mockImplementation(loadGerman);
      await openStart();
      fireEvent.click(screen.getByRole('button', { name: COPY_CARD }));
      const dialog = await screen.findByRole('dialog', { name: CREATE.copy.heading });
      fireEvent.click(await within(dialog).findByRole('button', { name: /Travel policy/ }));
      await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
      expect(mockLanguages.load.mock.calls).toEqual([['de']]);
      await submit();
      expect(lastPayload().name.de).toBe('Reiserichtlinie (Kopie)');
    });

    it('opens the copy all the same when that language cannot be loaded', async () => {
      mockLanguages.load.mockRejectedValue(new Error('offline'));
      await openCopy();
      expect(nameField()).toHaveValue('Travel policy (copy)');
      await submit();
      expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
      expect(lastPayload().name.de).toBe('Reiserichtlinie (copy)');
    });
  });

  it('after the author changed the instructions, says so and stores them in one language', async () => {
    await openCopy();
    expect(screen.queryByText(CREATE.copy.languagesNote)).not.toBeInTheDocument();
    type(instructionsField(), 'You answer questions about the new travel policy.');
    expect(screen.getByText(CREATE.copy.languagesNote)).toBeInTheDocument();
    await submit();
    const payload = lastPayload();
    expect(payload.system).toEqual({ en: 'You answer questions about the new travel policy.' });
    // A text the author did not touch keeps all its languages.
    expect(Object.keys(payload.name).sort()).toEqual(['de', 'en']);
    expect(Object.keys(payload.description).sort()).toEqual(['de', 'en']);
  });

  it('edits a German-only app in German for an author with an English UI', async () => {
    const germanOnly = {
      ...TRAVEL_APP,
      id: 'reisen',
      name: { de: 'Reisen' },
      description: { de: 'Beantwortet Reisefragen.' },
      system: { de: 'Sie beantworten Reisefragen.' }
    };
    mockApi.fetchAdminApp.mockResolvedValue(germanOnly);
    renderCreate('/admin/apps/new?from=reisen');
    await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
    expect(nameField()).toHaveValue('Reisen (Kopie)');
    expect(instructionsField()).toHaveValue('Sie beantworten Reisefragen.');
    expect(
      screen.getByText('You are writing in German. You can add other languages in the editor.')
    ).toBeInTheDocument();
    // The page itself stays in the author's language: the category names are English.
    fireEvent.click(screen.getByRole('button', { name: CREATE.essentials.details }));
    const categories = within(screen.getByLabelText(CREATE.essentials.category));
    expect(categories.getByRole('option', { name: 'Utility' })).toBeInTheDocument();
    expect(categories.queryByRole('option', { name: 'Werkzeuge' })).not.toBeInTheDocument();
  });

  it('copies an app without instructions without asking for some', async () => {
    const { system, ...plain } = TRAVEL_APP;
    void system;
    mockApi.fetchAdminApp.mockResolvedValue({ ...plain, id: 'plain' });
    renderCreate('/admin/apps/new?from=plain');
    await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
    await submit();
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
    expect(lastPayload()).not.toHaveProperty('system');
  });

  it('says when the app to copy is gone, and offers the other starts', async () => {
    renderCreate('/admin/apps/new?from=deleted-app');
    expect(await screen.findByText(CREATE.copy.sourceGone)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Start empty' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Text Summarizer/ })).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe('NEW:/admin/apps/new'));
  });

  it('offers to retry when the app to copy could not be loaded', async () => {
    mockApi.fetchAdminApp.mockRejectedValueOnce(apiProblem(500, { code: 'INTERNAL_ERROR' }));
    renderCreate(`/admin/apps/new?from=${TRAVEL_APP.id}`);
    expect(await screen.findByText(CREATE.copy.loadError, { exact: false })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CREATE.retry }));
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy })
    ).toBeInTheDocument();
  });

  it('a copy that could not be loaded leaves the URL, and another start ends it', async () => {
    mockApi.fetchAdminApp.mockRejectedValueOnce(apiProblem(500, { code: 'INTERNAL_ERROR' }));
    const first = renderCreate(`/admin/apps/new?from=${TRAVEL_APP.id}`);
    expect(await screen.findByText(CREATE.copy.loadError, { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe('NEW:/admin/apps/new'));

    fireEvent.click(await screen.findByRole('button', { name: 'Start empty' }));
    type(nameField(), 'My own app');
    // No stale "Try again" above a draft it would replace.
    expect(screen.queryByText(CREATE.copy.loadError, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CREATE.retry })).not.toBeInTheDocument();
    expect(mockApi.fetchAdminApp).toHaveBeenCalledTimes(1);

    // A reload brings the typed draft back, not the copy.
    first.unmount();
    renderCreate('/admin/apps/new');
    expect(await screen.findByText(CREATE.restored, { exact: false })).toBeInTheDocument();
    expect(nameField()).toHaveValue('My own app');
  });

  it('"no longer exists" is said on the Start screen only', async () => {
    renderCreate('/admin/apps/new?from=deleted-app');
    expect(await screen.findByText(CREATE.copy.sourceGone)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Start empty' }));
    // The sentence is about the start the author did not get, not about this draft.
    expect(screen.queryByText(CREATE.copy.sourceGone)).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.blank);
  });

  it('"Copy an existing app" lists the apps in a searchable dialog and copies the pick', async () => {
    await openStart();
    fireEvent.click(screen.getByRole('button', { name: COPY_CARD }));
    const dialog = await screen.findByRole('dialog', { name: CREATE.copy.heading });
    const card = await within(dialog).findByRole('button', { name: /Travel policy/ });
    expect(card).not.toHaveTextContent('travel-policy');

    type(within(dialog).getByLabelText(CREATE.copy.search), 'zzz');
    expect(within(dialog).getByText('No app matches "zzz".')).toBeInTheDocument();
    type(within(dialog).getByLabelText(CREATE.copy.search), 'travel');
    fireEvent.click(within(dialog).getByRole('button', { name: /Travel policy/ }));

    await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(nameField()).toHaveValue('Travel policy (copy)');
    await submit();
    expect(lastOrigin()).toEqual({ origin: 'copy' });
  });

  it('says when there is no app to copy', async () => {
    mockApi.fetchAdminAppTemplates.mockResolvedValue([]);
    await openStart();
    fireEvent.click(screen.getByRole('button', { name: COPY_CARD }));
    expect(await screen.findByText(CREATE.copy.none)).toBeInTheDocument();
  });
});

describe('link start', () => {
  async function startLink() {
    await openStart();
    fireEvent.click(screen.getByRole('button', { name: CREATE.start.other }));
    fireEvent.click(screen.getByRole('button', { name: CREATE.start.link.action }));
  }

  it('asks for a website address instead of instructions', async () => {
    await startLink();
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.link);
    expect(screen.queryByLabelText(/^Instructions/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Website address/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: CREATE.link.redirect })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: new RegExp(`^${CREATE.link.iframe}`) })
    ).not.toBeChecked();
  });

  it('refuses an address that is not http(s), then creates a link that opens the website', async () => {
    await startLink();
    type(nameField(), 'Intranet');
    type(descriptionField(), 'Opens the intranet.');
    type(screen.getByLabelText(/^Website address/), 'intranet.example');
    await submit();
    expect(mockApi.createAdminApp).not.toHaveBeenCalled();
    expect(screen.getAllByText(CREATE.error.urlFormat, { exact: false }).length).toBeGreaterThan(0);

    type(screen.getByLabelText(/^Website address/), 'https://intranet.example/start');
    await submit();
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
    expect(lastOrigin()).toEqual({ origin: 'link' });
    const payload = lastPayload();
    expect(payload.type).toBe('redirect');
    expect(payload.redirectConfig.url).toBe('https://intranet.example/start');
    expect(payload).not.toHaveProperty('system');
    expect(payload).not.toHaveProperty('iframeConfig');
    expect(payload.enabled).toBe(false);
    expect(appConfigSchema.safeParse(payload).success).toBe(true);
    expect(where()).toBe('EDITOR:/admin/apps/intranet?created=1');
  });

  it('"Show the website inside iHub" creates an embedded app with the same address', async () => {
    await startLink();
    type(nameField(), 'Wiki');
    type(descriptionField(), 'Shows the wiki.');
    type(screen.getByLabelText(/^Website address/), 'https://wiki.example');
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${CREATE.link.iframe}`) }));
    await submit();
    const payload = lastPayload();
    expect(payload.type).toBe('iframe');
    expect(payload.iframeConfig.url).toBe('https://wiki.example');
    expect(payload).not.toHaveProperty('redirectConfig');
    expect(appConfigSchema.safeParse(payload).success).toBe(true);
  });
});

describe('describe start', () => {
  const RESULT = {
    app: {
      ...newAppDefaults('en'),
      id: 'reply-helper',
      name: { en: 'Reply helper' },
      description: { en: 'Drafts a reply to a customer.' },
      system: { en: 'You draft replies to customer emails.' }
    },
    suggestions: { websearch: true, integrations: [{ id: 'jira', label: 'Jira', actions: [] }] },
    warnings: [],
    model: { id: 'gemini-flash', name: 'Gemini Flash' }
  };

  it('sends the description in the content language and opens the draft on Essentials', async () => {
    mockApi.generateAppDraft.mockResolvedValue(RESULT);
    await openStart();
    type(await screen.findByLabelText(CREATE.start.label), 'An assistant that drafts replies.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CREATE.start.generate }));
    });
    expect(mockApi.generateAppDraft).toHaveBeenCalledTimes(1);
    expect(mockApi.generateAppDraft.mock.calls[0][0]).toMatchObject({
      description: 'An assistant that drafts replies.',
      language: 'en'
    });
    expect(mockApi.generateAppDraft.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);

    expect(heading()).toHaveTextContent(CREATE.essentials.heading.draft);
    expect(screen.getByText(CREATE.draft.intro)).toBeInTheDocument();
    expect(nameField()).toHaveValue('Reply helper');
    // The description is still there, in the draft notice.
    expect(screen.getByLabelText(CREATE.start.label)).toHaveValue(
      'An assistant that drafts replies.'
    );

    await submit();
    expect(lastOrigin()).toEqual({ origin: 'generated' });
    const payload = lastPayload();
    expect(payload.id).toBe('reply-helper');
    expect(payload.enabled).toBe(false);
    // Nothing is bound unless the author ticked it.
    expect(payload).not.toHaveProperty('websearch');
    expect(payload).not.toHaveProperty('integrations');
  });

  it('binds what the author ticked, and nothing else', async () => {
    mockApi.generateAppDraft.mockResolvedValue(RESULT);
    await openStart();
    type(await screen.findByLabelText(CREATE.start.label), 'An assistant that drafts replies.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CREATE.start.generate }));
    });
    fireEvent.click(screen.getByRole('checkbox', { name: CREATE.draft.webSearch }));
    await submit();
    const payload = lastPayload();
    expect(payload.websearch).toEqual({ enabled: true });
    expect(payload).not.toHaveProperty('integrations');
  });

  it('Back from an unchanged draft does not ask and keeps the description in the box', async () => {
    mockApi.generateAppDraft.mockResolvedValue(RESULT);
    await openStart();
    type(await screen.findByLabelText(CREATE.start.label), 'An assistant that drafts replies.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CREATE.start.generate }));
    });
    fireEvent.click(screen.getByRole('button', { name: CREATE.back }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent('New app');
    expect(await screen.findByLabelText(CREATE.start.label)).toHaveValue(
      'An assistant that drafts replies.'
    );
    await startSettled();
  });

  // The notice is wired by the page (EssentialsNotice): what the author changed
  // and the draft as edited come from the page's state, not from the notice.
  const DESCRIPTION = 'An assistant that drafts replies.';
  const WITH_FIELD = {
    ...RESULT,
    app: {
      ...RESULT.app,
      variables: [{ name: 'tone', label: { en: 'Tone' }, type: 'string', required: false }]
    }
  };
  const regenerateButton = () => screen.getByRole('button', { name: CREATE.draft.regenerate });
  const fieldsCheckbox = () =>
    screen.getByRole('checkbox', { name: CREATE.draft.inputFields.replace('{{names}}', 'Tone') });

  async function openDraft(result = RESULT) {
    mockApi.generateAppDraft.mockResolvedValue(result);
    await openStart();
    type(await screen.findByLabelText(CREATE.start.label), DESCRIPTION);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CREATE.start.generate }));
    });
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.draft);
  }

  it('"Prepare a new draft" from an untouched draft does not ask', async () => {
    await openDraft();
    type(screen.getByLabelText(CREATE.start.label), `${DESCRIPTION} In a friendly tone.`);
    await act(async () => {
      fireEvent.click(regenerateButton());
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockApi.generateAppDraft).toHaveBeenCalledTimes(2);
    expect(mockApi.generateAppDraft.mock.calls[1][0].description).toBe(
      `${DESCRIPTION} In a friendly tone.`
    );
  });

  it('"Prepare a new draft" asks first when the author changed a field of the draft', async () => {
    await openDraft();
    type(nameField(), 'Customer reply helper');
    type(screen.getByLabelText(CREATE.start.label), `${DESCRIPTION} In a friendly tone.`);
    await act(async () => {
      fireEvent.click(regenerateButton());
    });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(CREATE.draft.regenerateWarning);
    expect(mockApi.generateAppDraft).toHaveBeenCalledTimes(1);
    expect(nameField()).toHaveValue('Customer reply helper');

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: CREATE.draft.regenerate }));
    });
    expect(mockApi.generateAppDraft).toHaveBeenCalledTimes(2);
    expect(nameField()).toHaveValue('Reply helper');
  });

  it('locks the input fields while the edited instructions use one of them', async () => {
    await openDraft(WITH_FIELD);
    expect(fieldsCheckbox()).toBeChecked();
    expect(fieldsCheckbox()).toBeEnabled();
    expect(screen.queryByText(CREATE.draft.fieldsLocked)).not.toBeInTheDocument();

    type(instructionsField(), 'You draft replies in a {{tone}} tone.');
    expect(fieldsCheckbox()).toBeDisabled();
    expect(fieldsCheckbox()).toHaveAccessibleDescription(CREATE.draft.fieldsLocked);

    type(instructionsField(), 'You draft replies to customer emails.');
    expect(fieldsCheckbox()).toBeEnabled();
    expect(screen.queryByText(CREATE.draft.fieldsLocked)).not.toBeInTheDocument();
  });

  it('creates the app with the input fields, and without them when unticked', async () => {
    await openDraft(WITH_FIELD);
    fireEvent.click(fieldsCheckbox());
    expect(fieldsCheckbox()).not.toBeChecked();
    await submit();
    expect(lastPayload().variables ?? []).toEqual([]);
  });

  it('keeps the input fields of the draft unless the author unticks them', async () => {
    await openDraft(WITH_FIELD);
    await submit();
    expect(lastPayload().variables.map(variable => variable.name)).toEqual(['tone']);
  });
});

describe('Essentials screen', () => {
  it('shows one sentence above the button and keeps "More details" closed, without an ID', async () => {
    await startEmpty();
    expect(screen.getByText(CREATE.essentials.audience)).toBeInTheDocument();
    expect(screen.queryByText(CREATE.essentials.audienceLive)).not.toBeInTheDocument();
    // The model is named on the Start screen, not here.
    expect(screen.queryByText(/Gemini Flash/)).not.toBeInTheDocument();

    const details = screen.getByRole('button', { name: CREATE.essentials.details });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(/^App ID/)).not.toBeInTheDocument();
    type(nameField(), 'Plain-language summary');
    expect(screen.queryByText('plain-language-summary')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('plain-language-summary')).not.toBeInTheDocument();

    fireEvent.click(details);
    expect(screen.getByLabelText(/^App ID/)).toHaveValue('plain-language-summary');
    expect(screen.getByLabelText(CREATE.essentials.category)).toHaveValue('utility');
  });

  it('marks required fields once each and says what the asterisk means', async () => {
    await startEmpty();
    expect(screen.getByText(CREATE.requiredHint)).toBeInTheDocument();
    for (const field of [nameField(), descriptionField(), instructionsField()]) {
      expect(field).toHaveAttribute('aria-required', 'true');
      expect(field).toHaveAttribute('aria-describedby');
    }
  });

  it('opens the tips for good instructions on request', async () => {
    await startEmpty();
    const tips = screen.getByRole('button', { name: CREATE.essentials.tips.toggle });
    expect(screen.queryByText(CREATE.essentials.tips.role)).not.toBeInTheDocument();
    fireEvent.click(tips);
    expect(tips).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(CREATE.essentials.tips.role)).toBeInTheDocument();
    expect(screen.getByText(CREATE.essentials.tips.limits)).toBeInTheDocument();
  });

  it('lets the author pick an icon from a named list, which Escape closes, and sends the pick', async () => {
    await startEmpty();
    fillEssentials();
    // The button is named by its label and by the icon it shows.
    const trigger = screen.getByRole('button', { name: 'Icon chat-bubbles' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'chat-bubbles' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // Escape closes the list and nothing else: the screen and its input stay.
    fireEvent.keyDown(screen.getByRole('textbox', { name: /searchIcons|Search icons/ }), {
      key: 'Escape'
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    expect(nameField()).toHaveValue('Plain-language summary');

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'globe' }));
    expect(screen.getByRole('button', { name: 'Icon globe' })).toHaveFocus();
    await submit();
    expect(lastPayload().icon).toBe('globe');
  });

  it('lets the author pick a colour and a category, and sends both', async () => {
    await startEmpty();
    fillEssentials();
    const green = APP_COLOR_SWATCHES.find(swatch => swatch.value === '#059669');
    const swatch = () => screen.getByRole('button', { name: mockI18n.t(green.labelKey) });
    expect(swatch()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(swatch());
    expect(swatch()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: CREATE.essentials.details }));
    type(screen.getByLabelText(CREATE.essentials.category), 'writing');
    await submit();
    expect(lastPayload().color).toBe('#059669');
    expect(lastPayload().category).toBe('writing');
  });
});

describe('app ID', () => {
  it('follows the name until the author edits it', async () => {
    await startEmpty();
    fireEvent.click(screen.getByRole('button', { name: CREATE.essentials.details }));
    const idField = () => screen.getByLabelText(/^App ID/);
    type(nameField(), 'Plain-language summary');
    expect(idField()).toHaveValue('plain-language-summary');
    type(nameField(), 'Release notes');
    expect(idField()).toHaveValue('release-notes');

    type(idField(), 'my-notes');
    type(nameField(), 'Something else');
    expect(idField()).toHaveValue('my-notes');
    expect(screen.getByText(CREATE.essentials.idFree)).toBeInTheDocument();
  });

  it('gives a name that is taken the next free suffix', async () => {
    await startEmpty();
    type(nameField(), 'Chat');
    fireEvent.click(screen.getByRole('button', { name: CREATE.essentials.details }));
    expect(screen.getByLabelText(/^App ID/)).toHaveValue('chat-2');
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
  });

  it('shows "already exists" before submit when the author types a taken ID', async () => {
    await startEmpty();
    fireEvent.click(screen.getByRole('button', { name: CREATE.essentials.details }));
    type(screen.getByLabelText(/^App ID/), 'chat');
    expect(
      screen.getByText('An app with the ID "chat" already exists. Choose another ID.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^App ID/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(CREATE.essentials.idFree)).not.toBeInTheDocument();
    expect(mockApi.createAdminApp).not.toHaveBeenCalled();
  });

  it.each([
    ['new', '"new" cannot be used as an app ID. Choose another ID.'],
    ['_generate', '"_generate" cannot be used as an app ID. Choose another ID.'],
    ['My App', /^Use only lowercase letters, digits, hyphens, dots and underscores/],
    ['a'.repeat(51), CREATE.error.idTooLong]
  ])('refuses the ID "%s" while the author types', async (id, message) => {
    await startEmpty();
    fireEvent.click(screen.getByRole('button', { name: CREATE.essentials.details }));
    type(screen.getByLabelText(/^App ID/), id);
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('retries once with the next free ID when the server says 409 and the ID was never touched', async () => {
    mockApi.createAdminApp
      .mockRejectedValueOnce(
        apiProblem(409, { code: 'CONFLICT', detail: 'App with this ID already exists' })
      )
      .mockImplementation(async payload => payload);
    await startEmpty();
    fillEssentials();
    await submit();
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(2);
    expect(mockApi.createAdminApp.mock.calls[0][0].id).toBe('plain-language-summary');
    expect(mockApi.createAdminApp.mock.calls[1][0].id).toBe('plain-language-summary-2');
    expect(where()).toBe('EDITOR:/admin/apps/plain-language-summary-2?created=1');
  });

  it('retries only once', async () => {
    mockApi.createAdminApp.mockRejectedValue(apiProblem(409, { code: 'CONFLICT' }));
    await startEmpty();
    fillEssentials();
    await submit();
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(2);
    expect(where()).toBe('NEW:/admin/apps/new');
    expect(screen.getByLabelText(/^App ID/)).toHaveFocus();
  });

  it('with an ID the author chose: no retry, the field gets the focus and the message, the input stays', async () => {
    mockApi.createAdminApp.mockRejectedValue(apiProblem(409, { code: 'CONFLICT' }));
    await startEmpty();
    fillEssentials();
    fireEvent.click(screen.getByRole('button', { name: CREATE.essentials.details }));
    type(screen.getByLabelText(/^App ID/), 'my-summary');
    // Closed again: the page must open it for the author.
    fireEvent.click(screen.getByRole('button', { name: CREATE.essentials.details }));
    expect(screen.queryByLabelText(/^App ID/)).not.toBeInTheDocument();

    await submit();
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
    const idField = screen.getByLabelText(/^App ID/);
    expect(idField).toHaveFocus();
    expect(idField).toHaveValue('my-summary');
    expect(idField).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getAllByText('An app with the ID "my-summary" already exists. Choose another ID.', {
        exact: false
      }).length
    ).toBeGreaterThan(0);
    expect(nameField()).toHaveValue('Plain-language summary');
    expect(instructionsField()).toHaveValue('You rewrite texts in plain language.');
    expect(where()).toBe('NEW:/admin/apps/new');
  });
});

describe('validation', () => {
  it('shows no error before input, and keeps the primary button enabled', async () => {
    await startEmpty();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    // Leaving a field the author never typed in is not input.
    fireEvent.blur(nameField());
    fireEvent.blur(instructionsField());
    expect(screen.queryByText(CREATE.error.nameRequired)).not.toBeInTheDocument();
    expect(screen.queryByText(CREATE.error.instructionsRequired)).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: CREATE.submit });
    expect(create).toBeEnabled();
    expect(create).not.toHaveAttribute('aria-disabled');
  });

  it("shows a field's message once the author typed in it and left it", async () => {
    await startEmpty();
    type(nameField(), 'x');
    type(nameField(), '');
    expect(screen.queryByText(CREATE.error.nameRequired)).not.toBeInTheDocument();
    fireEvent.blur(nameField());
    expect(screen.getByText(CREATE.error.nameRequired)).toBeInTheDocument();
    expect(nameField()).toHaveAttribute('aria-invalid', 'true');
    // The other fields stay quiet.
    expect(screen.queryByText(CREATE.error.descriptionRequired)).not.toBeInTheDocument();
  });

  it('what leaving a field shows waits until a pressed button was released', async () => {
    jest.useFakeTimers();
    try {
      await startEmpty();
      type(nameField(), 'x');
      type(nameField(), '');
      // The author presses "Create and test" while the name field has the focus:
      // the message under the name must not push the button away before the click.
      const create = screen.getByRole('button', { name: CREATE.submit });
      fireEvent.pointerDown(create);
      fireEvent.blur(nameField());
      expect(screen.queryByText(CREATE.error.nameRequired)).not.toBeInTheDocument();
      fireEvent.pointerUp(create);
      expect(screen.queryByText(CREATE.error.nameRequired)).not.toBeInTheDocument();
      act(() => {
        jest.runOnlyPendingTimers();
      });
      expect(screen.getByText(CREATE.error.nameRequired)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a submit with errors moves the focus to a summary that links to each field', async () => {
    await startEmpty();
    await submit();
    expect(mockApi.createAdminApp).not.toHaveBeenCalled();
    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent('3 fields need your attention.');
    const links = within(summary).getAllByRole('link');
    expect(links.map(link => link.textContent)).toEqual([
      'Name',
      'Short description',
      'Instructions'
    ]);
    expect(summary).toHaveTextContent(`Instructions: ${CREATE.error.instructionsRequired}`);
    expect(links[0]).toHaveAttribute('href', `#${nameField().id}`);

    fireEvent.click(links[2]);
    expect(instructionsField()).toHaveFocus();
  });

  it('one error reads "1 field needs your attention."', async () => {
    await startEmpty();
    type(nameField(), 'Plain-language summary');
    type(descriptionField(), 'Rewrites a text.');
    await submit();
    const summary = screen.getByRole('alert');
    expect(summary).toHaveTextContent('1 field needs your attention.');
    expect(summary).not.toHaveTextContent('fields need');
    // The summary goes away once the field is filled in.
    type(instructionsField(), 'You rewrite texts.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is German in a German UI', async () => {
    await mockI18n.changeLanguage('de');
    await startEmpty();
    type(nameField(), 'Zusammenfassung');
    type(descriptionField(), 'Fasst zusammen.');
    await submit();
    const summary = screen.getByRole('alert');
    expect(summary).toHaveTextContent('1 Feld benötigt Ihre Aufmerksamkeit.');
    expect(summary).toHaveTextContent(`Anweisungen: ${CREATE_DE.error.instructionsRequired}`);
  });
});

describe('answers of the server', () => {
  it('a 400 with the refused fields marks them and names them by their labels', async () => {
    mockApi.createAdminApp.mockRejectedValue(
      apiProblem(400, {
        code: 'VALIDATION_FAILED',
        detail: 'Invalid app configuration',
        errors: [
          { pointer: '/name/en', code: 'too_big', message: 'Too big' },
          { pointer: '/system/en', code: 'too_big', message: 'Too big' },
          { pointer: '/variables/0/name', code: 'invalid_format', message: 'Invalid' }
        ]
      })
    );
    await startEmpty();
    fillEssentials();
    await submit();

    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent(
      'The app could not be created because these entries are not accepted: Name, Instructions, variables.0.name.'
    );
    expect(summary).toHaveTextContent('2 fields need your attention.');
    expect(summary).not.toHaveTextContent('Too big');
    expect(nameField()).toHaveAttribute('aria-invalid', 'true');
    expect(nameField().getAttribute('aria-describedby')).toContain(summary.id);
    expect(instructionsField()).toHaveAttribute('aria-invalid', 'true');
    expect(descriptionField()).not.toHaveAttribute('aria-invalid');
    // The mark goes when the author changes the field.
    type(nameField(), 'Shorter');
    expect(nameField()).not.toHaveAttribute('aria-invalid');
  });

  it('reads the fields from details.issues too', async () => {
    mockApi.createAdminApp.mockRejectedValue(
      apiProblem(400, {
        code: 'VALIDATION_FAILED',
        details: { issues: [{ path: 'description.en', code: 'too_big', message: 'Too big' }] }
      })
    );
    await startEmpty();
    fillEssentials();
    await submit();
    expect(descriptionField()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('not accepted: Short description.');
  });

  it('a 403 says the author may not create apps and keeps the input', async () => {
    mockApi.createAdminApp.mockRejectedValue(
      apiProblem(403, { code: 'FORBIDDEN', detail: 'Forbidden' })
    );
    await startEmpty();
    fillEssentials();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent(CREATE.error.forbidden);
    expect(nameField()).toHaveValue('Plain-language summary');
    expect(descriptionField()).toHaveValue('Rewrites a text so that everyone understands it.');
    expect(instructionsField()).toHaveValue('You rewrite texts in plain language.');
    expect(where()).toBe('NEW:/admin/apps/new');
  });

  it('a request without an answer says the server cannot be reached', async () => {
    mockApi.createAdminApp.mockRejectedValue(new Error('Network Error'));
    await startEmpty();
    fillEssentials();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent(CREATE.error.offline);
    expect(nameField()).toHaveValue('Plain-language summary');
  });

  it("any other answer shows the server's own sentence", async () => {
    mockApi.createAdminApp.mockRejectedValue(
      apiProblem(500, { code: 'INTERNAL_ERROR', detail: 'The disk is full.' })
    );
    await startEmpty();
    fillEssentials();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The app could not be created. The disk is full.'
    );
  });

  it('a second submit sends one request at a time', async () => {
    let release;
    mockApi.createAdminApp.mockImplementation(
      payload => new Promise(resolve => (release = () => resolve(payload)))
    );
    await startEmpty();
    fillEssentials();
    await submit();
    expect(screen.getByRole('button', { name: CREATE.submitting })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: CREATE.submitting }));
    });
    expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(where()).toBe('EDITOR:/admin/apps/plain-language-summary?created=1');
  });
});

describe('leaving', () => {
  const discardDialog = () => screen.queryByRole('alertdialog', { name: CREATE.discard.title });

  it('Back from an unchanged template does not ask', async () => {
    await openStart();
    fireEvent.click(screen.getByRole('button', { name: /Email Composer/ }));
    fireEvent.click(screen.getByRole('button', { name: CREATE.back }));
    expect(discardDialog()).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent('New app');
    expect(heading()).toHaveFocus();
    await startSettled();
  });

  it('Back from an unchanged copy does not ask', async () => {
    renderCreate(`/admin/apps/new?from=${TRAVEL_APP.id}`);
    await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
    fireEvent.click(screen.getByRole('button', { name: CREATE.back }));
    expect(discardDialog()).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Start empty' })).toBeInTheDocument();
    await startSettled();
  });

  it('Back with typed input asks once; "Keep editing" keeps everything', async () => {
    await startEmpty();
    type(nameField(), 'My app');
    fireEvent.click(screen.getByRole('button', { name: CREATE.back }));
    const dialog = discardDialog();
    expect(dialog).toHaveTextContent(CREATE.discard.body);
    fireEvent.click(within(dialog).getByRole('button', { name: CREATE.discard.keep }));
    expect(discardDialog()).not.toBeInTheDocument();
    expect(nameField()).toHaveValue('My app');

    fireEvent.click(screen.getByRole('button', { name: CREATE.back }));
    fireEvent.click(within(discardDialog()).getByRole('button', { name: CREATE.discard.confirm }));
    expect(discardDialog()).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent('New app');
    // The discarded input does not come back.
    fireEvent.click(screen.getByRole('button', { name: 'Start empty' }));
    expect(nameField()).toHaveValue('');
  });

  it('Cancel with typed input asks once, then leaves for the list and keeps nothing', async () => {
    await startEmpty();
    type(nameField(), 'My app');
    fireEvent.click(screen.getByRole('button', { name: CREATE.cancel }));
    expect(where()).toBe('NEW:/admin/apps/new');
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await act(async () => {
      fireEvent.click(
        within(discardDialog()).getByRole('button', { name: CREATE.discard.confirm })
      );
    });
    expect(where()).toBe('LIST:/admin/apps');
    expect(window.sessionStorage.getItem(APP_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('Cancel without input leaves at once', async () => {
    await startEmpty();
    fireEvent.click(screen.getByRole('button', { name: CREATE.cancel }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(where()).toBe('LIST:/admin/apps');
    expect(window.sessionStorage.getItem(APP_DRAFT_STORAGE_KEY)).toBeNull();
  });
});

describe('a reload restores the draft', () => {
  it('brings back the Essentials input and says so; "Start over" clears it', async () => {
    const first = renderCreate();
    await screen.findByRole('button', { name: 'Start empty' });
    fireEvent.click(screen.getByRole('button', { name: 'Start empty' }));
    type(nameField(), 'Half done');
    type(instructionsField(), 'You do half the work.');
    first.unmount();

    renderCreate();
    expect(await screen.findByText(CREATE.restored, { exact: false })).toBeInTheDocument();
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.blank);
    expect(nameField()).toHaveValue('Half done');
    expect(instructionsField()).toHaveValue('You do half the work.');
    // A restored draft still counts as typed input.
    fireEvent.click(screen.getByRole('button', { name: CREATE.startOver }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', {
          name: CREATE.discard.confirm
        })
      );
    });
    expect(heading()).toHaveTextContent('New app');
    expect(screen.queryByText(CREATE.restored, { exact: false })).not.toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(APP_DRAFT_STORAGE_KEY)).toBeNull());
    await startSettled();
  });

  it('brings back the description on the Start screen', async () => {
    const first = await openStart();
    type(await screen.findByLabelText(CREATE.start.label), 'An assistant that counts words.');
    first.unmount();

    await openStart();
    expect(await screen.findByLabelText(CREATE.start.label)).toHaveValue(
      'An assistant that counts words.'
    );
    expect(screen.getByText(CREATE.restored, { exact: false })).toBeInTheDocument();
  });

  it('a page opened to copy an app starts from that app, not from what the tab kept', async () => {
    const first = renderCreate();
    await screen.findByRole('button', { name: 'Start empty' });
    fireEvent.click(screen.getByRole('button', { name: 'Start empty' }));
    type(nameField(), 'Half done');
    first.unmount();

    renderCreate(`/admin/apps/new?from=${TRAVEL_APP.id}`);
    await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
    expect(nameField()).toHaveValue('Travel policy (copy)');
    expect(screen.queryByText(CREATE.restored, { exact: false })).not.toBeInTheDocument();
  });

  it('ignores an entry it cannot read', async () => {
    window.sessionStorage.setItem(
      APP_DRAFT_STORAGE_KEY,
      '{"version":1,"state":{"screen":"essentials"}}'
    );
    await openStart();
    expect(heading()).toHaveTextContent('New app');
    expect(screen.queryByText(CREATE.restored, { exact: false })).not.toBeInTheDocument();
  });
});

describe('apps list', () => {
  function renderList(url = '/admin/apps') {
    return render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/admin/apps" element={<AdminAppsPage />} />
          <Route path="/admin/apps/new" element={<Where label="NEW" />} />
          <Route path="/admin/apps/:appId" element={<Where label="EDITOR" />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('"New app" opens the create page', async () => {
    renderList();
    await screen.findByText('Travel policy');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Apps');
    fireEvent.click(screen.getByRole('button', { name: 'New app' }));
    expect(where()).toBe('NEW:/admin/apps/new');
  });

  it('the empty state explains what an app is and opens the create page', async () => {
    mockApi.fetchAdminApps.mockResolvedValue([]);
    renderList();
    expect(await screen.findByText(en.admin.apps.empty.title)).toBeInTheDocument();
    expect(screen.getByText(en.admin.apps.empty.body)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'New app' });
    fireEvent.click(buttons.at(-1));
    expect(where()).toBe('NEW:/admin/apps/new');
  });

  it('an empty search says what did not match', async () => {
    renderList('/admin/apps?q=zzz');
    expect(await screen.findByText('No app matches "zzz".')).toBeInTheDocument();
  });

  it.each([
    ['a published app', 'Travel policy', 'travel-policy'],
    ['an unpublished app', 'Unfinished', 'draft-app']
  ])('"Duplicate" opens the create page with ?from=<id> for %s', async (_case, name, id) => {
    renderList();
    const row = (await screen.findByText(name)).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: /more actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(where()).toBe(`NEW:/admin/apps/new?from=${id}`);
  });

  describe('"Upload a config file" works as before', () => {
    /** A chosen file as the page reads it (jsdom's File has no `text()`). */
    const chosen = (name, content) => ({ name, text: async () => content });

    async function upload(file) {
      renderList();
      await screen.findByText('Travel policy');
      expect(screen.getByRole('button', { name: 'Upload a config file' })).toBeInTheDocument();
      await act(async () => {
        fireEvent.change(document.querySelector('input[type="file"]'), {
          target: { files: [file] }
        });
      });
    }

    it('stores the file as it is, with the "enabled" value it carries, and reloads the list', async () => {
      const config = {
        id: 'imported',
        name: { en: 'Imported' },
        description: { en: 'From a file.' },
        system: { en: 'Be brief.' },
        enabled: true,
        parentId: 'chat'
      };
      await upload(chosen('app-imported.json', JSON.stringify(config)));
      expect(mockApi.createAdminApp).toHaveBeenCalledTimes(1);
      expect(mockApi.createAdminApp).toHaveBeenCalledWith(config, { origin: 'upload' });
      // Once for the page, once after the upload.
      expect(mockApi.fetchAdminApps).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each([
      ['a file that is not JSON by name', chosen('app.txt', '{}'), 'Please select a JSON file'],
      [
        'a file that cannot be parsed',
        chosen('app.json', '{ not json'),
        'Invalid JSON file format'
      ],
      [
        'a file without the required fields',
        chosen('app.json', JSON.stringify({ id: 'x' })),
        /missing required fields/
      ]
    ])('refuses %s and sends nothing', async (_case, file, message) => {
      await upload(file);
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(mockApi.createAdminApp).not.toHaveBeenCalled();
    });
  });

  it('"Reorder" works as before: it lists every app and saves the order shown', async () => {
    mockApi.reorderApps.mockResolvedValue({});
    renderList('/admin/apps?q=travel');
    await screen.findByText('Travel policy');
    fireEvent.click(screen.getByRole('button', { name: 'Reorder' }));
    // Every app, whatever the search says; an app that is not published is marked.
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('(Not published)')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    // `order` first (Travel policy has 7), then by name.
    expect(mockApi.reorderApps).toHaveBeenCalledWith(['travel-policy', 'chat', 'draft-app']);
  });

  it.each([
    ['en', 'Published', 'Not published'],
    ['de', 'Veröffentlicht', 'Nicht veröffentlicht']
  ])(
    'in "%s" the status reads published or not, and the old words are gone',
    async (lng, on, off) => {
      await mockI18n.changeLanguage(lng);
      renderList();
      const published = (
        await screen.findByText(lng === 'de' ? 'Reiserichtlinie' : 'Travel policy')
      ).closest('tr');
      expect(within(published).getByText(on)).toBeInTheDocument();
      const unpublished = screen.getByText('Unfinished').closest('tr');
      expect(within(unpublished).getByText(off)).toBeInTheDocument();

      // The row menu carries its name in the language of the page.
      fireEvent.click(
        within(unpublished).getByRole('button', {
          name: lng === 'de' ? de.common.moreActions : /more actions/i
        })
      );
      await screen.findByRole('menuitem', { name: lng === 'de' ? 'Duplizieren' : 'Duplicate' });
      const page = document.body.textContent;
      const attributes = [...document.body.querySelectorAll('[title], [aria-label]')]
        .map(
          element =>
            `${element.getAttribute('title') ?? ''} ${element.getAttribute('aria-label') ?? ''}`
        )
        .join(' ');
      for (const text of [page, attributes]) {
        expect(text).not.toMatch(
          /\b(Clone|Klonen|Enabled?|Disabled?|Aktiviert|Deaktiviert|Aktivieren|Deaktivieren)\b/
        );
      }
      expect(page).not.toContain('MISSING:admin.apps.status');
    }
  );
});
