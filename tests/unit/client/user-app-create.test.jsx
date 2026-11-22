// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "New app" for a person's own app (`/apps/new`).
 *
 * The page, the create screens of increment 1 and the shared contract are the
 * real ones, with the real English and German texts and the real template
 * files. Only the API modules are stubs (and what the Jest transform cannot
 * load: the icon component and the context that reads the server's
 * configuration).
 *
 * Slice P7 of concepts/app-builder-rework-2026-11/02-personal-apps.md
 * (sections 11.3, 14.3 and 21).
 */

import '@testing-library/jest-dom';
import fs from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import emailTemplate from '../../../server/appTemplates/email-composer.json';
import summarizerTemplate from '../../../server/appTemplates/summarizer.json';
import { USER_APP_CONTENT_KEYS } from '../../../shared/userAppContent.js';

const mockApi = {
  fetchApps: jest.fn(),
  fetchUserApps: jest.fn(),
  fetchUserApp: jest.fn(),
  fetchModels: jest.fn(),
  fetchUserAppsConfig: jest.fn(),
  fetchUserAppTemplates: jest.fn(),
  createUserApp: jest.fn(),
  generateUserApp: jest.fn()
};
// What a created app makes stale: the apps list (sidebar, apps page) and the count of apps.
const mockStale = { apps: 0, config: 0 };
jest.mock('../../../client/src/shared/hooks/appsCache', () => ({
  invalidateAppsCache: () => {
    mockStale.apps += 1;
  }
}));
jest.mock('../../../client/src/shared/hooks/useUserApps', () => ({
  invalidateUserAppsConfig: () => {
    mockStale.config += 1;
  }
}));

jest.mock('../../../client/src/api', () => ({
  fetchApps: (...args) => mockApi.fetchApps(...args),
  fetchUserApps: (...args) => mockApi.fetchUserApps(...args),
  fetchUserApp: (...args) => mockApi.fetchUserApp(...args),
  fetchModels: (...args) => mockApi.fetchModels(...args),
  fetchUserAppsConfig: (...args) => mockApi.fetchUserAppsConfig(...args),
  fetchUserAppTemplates: (...args) => mockApi.fetchUserAppTemplates(...args),
  createUserApp: (...args) => mockApi.createUserApp(...args),
  generateUserApp: (...args) => mockApi.generateUserApp(...args)
}));

// The source sends no request of its own: a call past the API module fails the test.
const mockClient = { post: jest.fn() };
jest.mock('../../../client/src/api/client', () => ({
  apiClient: { post: (...args) => mockClient.post(...args) }
}));

// Every call of the admin API module fails the test that made it.
const mockAdminCalls = [];
jest.mock('../../../client/src/api/adminApi', () => {
  const refuse =
    name =>
    (...args) => {
      mockAdminCalls.push({ name, args });
      return Promise.reject(new Error(`adminApi.${name} was called`));
    };
  return new Proxy(
    { __esModule: true },
    {
      get: (target, name) =>
        name in target || typeof name !== 'string' ? target[name] : refuse(name)
    }
  );
});

// The loader of another language's texts: the real one fetches them from the server.
jest.mock('../../../client/src/services/i18nService', () => ({
  __esModule: true,
  default: { loadFullTranslations: () => Promise.resolve() }
}));

const mockEnv = { platformConfig: {} };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockEnv.platformConfig })
}));

// runtimeBasePath and Icon use `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: p => p,
  buildAssetUrl: p => p
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const UserAppCreatePage =
  require('../../../client/src/features/apps/pages/UserAppCreatePage').default;
const {
  USER_APP_DRAFT_STORAGE_KEY
} = require('../../../client/src/features/apps/pages/UserAppCreatePage');
const {
  userAppSource,
  buildUserAppBody,
  limitToAllowed,
  asCreateFailure
} = require('../../../client/src/features/apps/builder/userAppSource');
const {
  APP_DRAFT_STORAGE_KEY
} = require('../../../client/src/features/admin/components/app-create/useAppDraft');
const StartScreen =
  require('../../../client/src/features/admin/components/app-create/StartScreen').default;

const REPO = path.resolve(__dirname, '../../..');
const APP_CREATE_DIR = path.join(REPO, 'client/src/features/admin/components/app-create');

const CREATE = en.admin.apps.create;
const USER_CREATE = en.userApps.create;
const NEW_ID = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`
  });
});

/** An item of `GET /api/apps/_templates`, built from the shipped file as the server does. */
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

const GEMINI = {
  id: 'gemini-flash',
  name: { en: 'Gemini Flash' },
  provider: 'google',
  default: true
};

const ALL_ALLOWED = {
  modelChoice: true,
  upload: true,
  webSearch: true,
  skills: true,
  integrations: [
    {
      id: 'jira-main',
      label: 'Jira',
      actions: [
        { name: 'searchIssues', description: 'Search issues' },
        { name: 'getIssue', description: 'Read an issue' }
      ]
    }
  ]
};

const CONFIG = {
  enabled: true,
  canCreate: true,
  canShare: true,
  canPublish: false,
  maxApps: 20,
  used: 3,
  generator: true,
  capabilities: ALL_ALLOWED
};

/** The answer of `POST /api/apps/_generate`. */
const DRAFT = {
  app: {
    id: 'reply-helper',
    name: { en: 'Reply helper' },
    description: { en: 'Drafts a reply to a customer email.' },
    system: { en: 'You draft replies to customer emails.' },
    icon: 'envelope',
    color: '#4F46E5',
    category: 'communication',
    enabled: false,
    variables: [],
    starterPrompts: []
  },
  suggestions: {
    websearch: true,
    integrations: [{ id: 'jira-main', label: 'Jira', actions: ['searchIssues'] }]
  },
  warnings: [],
  model: { id: 'gemini-flash' },
  brief: 'default'
};

/**
 * `GET /api/apps`: the company apps the person may use. A chat app with
 * settings only a company app has, a link app, a website shown inside iHub
 * and an app that is switched off.
 */
const COMPANY_APPS = [
  {
    id: 'faq-bot',
    type: 'chat',
    enabled: true,
    order: 3,
    category: 'hr',
    name: { en: 'FAQ bot', de: 'FAQ-Bot' },
    description: { en: 'Answers HR questions.', de: 'Beantwortet Personalfragen.' },
    system: { en: 'You answer HR questions.', de: 'Sie beantworten Personalfragen.' },
    icon: 'question-mark-circle',
    color: '#0EA5E9',
    preferredModel: 'gemini-flash',
    allowedModels: ['gemini-flash'],
    tokenLimit: 4000,
    greeting: { en: { title: 'Hi', subtitle: 'Ask me' } },
    settings: { enabled: false },
    requiredFeatures: ['userApps'],
    websearch: { enabled: true },
    upload: { enabled: true },
    skillSettings: { enabled: true },
    integrations: {
      'jira-main': { actions: ['searchIssues', 'deleteIssue'] },
      'type:storage': { required: false }
    },
    variables: [
      {
        name: 'topic',
        label: { en: 'Topic' },
        type: 'string',
        required: false,
        description: { en: 'Only company apps describe a field' }
      }
    ],
    starterPrompts: [
      {
        title: { en: 'Leave' },
        message: { en: 'How many days of leave do I have?' },
        autoSend: true
      }
    ]
  },
  {
    id: 'intranet',
    type: 'redirect',
    enabled: true,
    name: { en: 'Intranet' },
    description: { en: 'Opens the intranet.' },
    redirectConfig: { url: 'https://intranet.example.com' }
  },
  {
    id: 'wiki-frame',
    type: 'iframe',
    enabled: true,
    name: { en: 'Wiki in a frame' },
    description: { en: 'Shows the wiki.' },
    iframeConfig: { url: 'https://wiki.example.com' }
  },
  {
    id: 'old-bot',
    type: 'chat',
    enabled: false,
    name: { en: 'Old bot' },
    description: { en: 'Switched off.' },
    system: { en: 'You are old.' }
  },
  {
    id: 'ask-documents',
    type: 'chat',
    enabled: true,
    name: { en: 'Ask the documents' },
    description: { en: 'Answers from the iAssistant.' },
    system: { en: 'You answer from the documents.' },
    iassistant: { assistantId: 'hr' },
    integrations: { iassistant: {} }
  }
];

const OWNED_ID = 'uap_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REDUCED_ID = 'uap_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RETIRED_ID = 'uap_cccccccccccccccccccccccccccccccc';
const OFFERED_ID = 'uap_dddddddddddddddddddddddddddddddd';

/** `GET /api/apps?scope=personal`, in the shapes of `userAppView` and its reduced forms. */
const PERSONAL_APPS = [
  {
    id: OWNED_ID,
    type: 'chat',
    enabled: true,
    ownership: 'user',
    language: 'en',
    name: { en: 'Meeting notes' },
    description: { en: 'Turns notes into minutes.' },
    system: { en: 'You turn notes into minutes.' },
    icon: 'document-text',
    color: '#16A34A',
    owner: { id: 'u-1', name: 'Ada' },
    permissions: { role: 'owner', canUse: true, canEdit: true },
    members: [{ type: 'user', id: 'u-2', role: 'editor' }],
    sharedWith: { users: 1, groups: 0, everyone: false },
    capabilities: [{ id: 'webSearch', requested: true, granted: true }],
    approval: { mode: 'always', chatGrants: false },
    state: 'active',
    disabled: null,
    revision: 4,
    updatedAt: '2026-11-20T10:00:00.000Z',
    pendingOwner: null,
    websearch: { enabled: true }
  },
  {
    id: REDUCED_ID,
    ownership: 'user',
    name: { en: 'Switched-off helper' },
    icon: null,
    color: null,
    owner: { id: 'u-3', name: 'Bo' },
    state: 'active',
    permissions: { role: 'user', canUse: false },
    disabled: { at: '2026-11-19T10:00:00.000Z', reason: 'admin' }
  },
  {
    id: RETIRED_ID,
    ownership: 'user',
    state: 'retired',
    publishedAs: { appId: 'faq-bot', name: { en: 'FAQ bot' }, enabled: true }
  },
  {
    id: OFFERED_ID,
    type: 'chat',
    ownership: 'user',
    name: { en: 'Offered app' },
    description: { en: 'Not yours yet.' },
    system: { en: 'You are offered.' },
    owner: { id: 'u-4', name: 'Cy' },
    permissions: { role: 'offered', canUse: false, canAcceptOffer: true },
    state: 'active',
    disabled: null
  }
];

function apiProblem(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

/** A failure as the shared API helper rejects with it (`enhanceApiError`). */
function enhanced(status, data) {
  const error = new Error('You do not have permission to access this resource.');
  error.status = status;
  error.code = data?.code;
  error.originalError = apiProblem(status, data);
  return error;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockAdminCalls.length = 0;
  mockStale.apps = 0;
  mockStale.config = 0;
  window.sessionStorage.clear();
  await mockI18n.changeLanguage('en');
  mockEnv.platformConfig = { defaultLanguage: 'en', featuresMap: { userApps: true } };
  mockApi.fetchModels.mockResolvedValue([GEMINI]);
  mockApi.fetchUserAppsConfig.mockResolvedValue(CONFIG);
  mockApi.fetchUserAppTemplates.mockResolvedValue([
    templateItem(summarizerTemplate),
    templateItem(emailTemplate)
  ]);
  mockApi.createUserApp.mockImplementation(async body => ({ ...body, id: NEW_ID }));
  mockApi.generateUserApp.mockResolvedValue(DRAFT);
  mockApi.fetchApps.mockResolvedValue(COMPANY_APPS);
  mockApi.fetchUserApps.mockResolvedValue(PERSONAL_APPS);
  mockApi.fetchUserApp.mockImplementation(async appId => {
    const app = [...COMPANY_APPS, ...PERSONAL_APPS].find(item => item.id === appId);
    if (!app) throw enhanced(404, { code: 'NOT_FOUND' });
    return structuredClone(app);
  });
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
  // A person without admin rights never calls the admin API.
  expect(mockAdminCalls).toEqual([]);
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

function renderCreate(entry = '/apps/new') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/apps" element={<Where label="LIST" />} />
        <Route
          path="/apps/new"
          element={
            <>
              <UserAppCreatePage />
              <Where label="NEW" />
            </>
          }
        />
        <Route path="/apps/:appId/edit" element={<Where label="EDITOR" />} />
      </Routes>
    </MemoryRouter>
  );
}

const where = () => screen.getByTestId('where').textContent;
const type = (element, value) => fireEvent.change(element, { target: { value } });
const nameField = () => screen.getByLabelText(/^Name/);
const descriptionField = () => screen.getByLabelText(/^(Short description|Kurzbeschreibung)/);
const instructionsField = () => screen.getByLabelText(/^(Instructions|Anweisungen)/);
const heading = () => screen.getByRole('heading', { level: 1 });
const lastBody = () => mockApi.createUserApp.mock.calls.at(-1)[0];

/** The Start screen with the description box and the templates loaded. */
async function openStart() {
  const view = renderCreate();
  await screen.findByRole('button', { name: /^(Start empty|Leer beginnen)$/ });
  await screen.findByRole('button', { name: /Text Summarizer|Textzusammenfassung/ });
  await screen.findByLabelText(/^(Your description|Ihre Beschreibung)$/);
  return view;
}

async function startEmpty() {
  await openStart();
  fireEvent.click(screen.getByRole('button', { name: 'Start empty' }));
}

async function draftFromDescription(description = 'An assistant that drafts replies.') {
  await openStart();
  type(screen.getByLabelText(CREATE.start.label), description);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: CREATE.start.generate }));
  });
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: CREATE.submit }));
  });
}

function fillEssentials({ name = 'Plain-language summary' } = {}) {
  type(nameField(), name);
  type(descriptionField(), 'Rewrites a text so that everyone understands it.');
  type(instructionsField(), 'You rewrite texts in plain language.');
}

const ALLOWED_BODY_KEYS = ['language', 'origin', ...USER_APP_CONTENT_KEYS];

describe('the Start screen of a personal app', () => {
  it('offers the description box, the templates and "Start empty"', async () => {
    await openStart();
    expect(heading()).toHaveTextContent('New app');
    expect(screen.getByLabelText(CREATE.start.label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Email Composer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeInTheDocument();
    expect(mockApi.fetchUserAppsConfig).toHaveBeenCalledWith({ language: 'en' });
    expect(mockApi.fetchUserAppTemplates).toHaveBeenCalledTimes(1);
  });

  it('offers "Copy an existing app" as the last card of the templates', async () => {
    await openStart();
    const cards = screen
      .getAllByRole('listitem')
      .filter(item => item.querySelector('button'))
      .map(item => item.textContent);
    expect(cards.at(-1)).toContain(CREATE.start.copy);
    expect(cards.at(-1)).toContain(CREATE.start.copyHelp);
    // The list is loaded when the dialog opens, not before.
    expect(mockApi.fetchApps).not.toHaveBeenCalled();
    expect(mockApi.fetchUserApps).not.toHaveBeenCalled();
  });

  it('has no link or Marketplace start, and no "Other ways to start"', async () => {
    await openStart();
    expect(screen.queryByRole('button', { name: CREATE.start.other })).not.toBeInTheDocument();
    expect(screen.queryByText(CREATE.start.link.action)).not.toBeInTheDocument();
    expect(screen.queryByText(CREATE.start.marketplace)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says under the description box that the app cannot use a document collection', async () => {
    await openStart();
    const line = screen.getByText(USER_CREATE.limits);
    expect(line).toBeInTheDocument();
    // The line belongs to the field: a screen reader reads it with the box.
    expect(screen.getByLabelText(CREATE.start.label).getAttribute('aria-describedby')).toContain(
      line.id
    );
  });

  it('says it in German with the formal address', async () => {
    await mockI18n.changeLanguage('de');
    await openStart();
    expect(screen.getByText(de.userApps.create.limits)).toBeInTheDocument();
    expect(mockApi.fetchUserAppsConfig).toHaveBeenCalledWith({ language: 'de' });
  });

  it('shows one line instead of the box when drafting is switched off', async () => {
    mockApi.fetchUserAppsConfig.mockResolvedValue({ ...CONFIG, generator: false });
    renderCreate();
    await screen.findByRole('button', { name: /Text Summarizer/ });
    expect(screen.getByText(CREATE.generatorOff)).toBeInTheDocument();
    expect(screen.queryByLabelText(CREATE.start.label)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeInTheDocument();
  });

  it('a screen without a source still offers every start (the admin page)', async () => {
    render(
      <MemoryRouter>
        <StartScreen
          describe={null}
          fetchTemplates={async () => []}
          fetchExistingApps={async () => []}
          language="en"
          onPickTemplate={() => {}}
          onStartBlank={() => {}}
          onPickExisting={() => {}}
          onStartLink={() => {}}
          marketplaceHref="/admin/marketplace"
        />
      </MemoryRouter>
    );
    // Copying is a card in the templates grid, shown even when there are no templates.
    expect(
      await screen.findByRole('button', { name: new RegExp(`^${CREATE.start.copy}`) })
    ).toBeInTheDocument();
    const other = screen.getByRole('button', { name: CREATE.start.other });
    fireEvent.click(other);
    expect(screen.getByRole('button', { name: CREATE.start.link.action })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: CREATE.start.marketplace })).toBeInTheDocument();
  });
});

describe('the Essentials screen of a personal app', () => {
  it('has no "More details", no App ID and no category', async () => {
    await startEmpty();
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.blank);
    expect(
      screen.queryByRole('button', { name: CREATE.essentials.details })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/App ID/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(CREATE.essentials.category)).not.toBeInTheDocument();
  });

  it('says above the button who can see the app, and not what the admin page says', async () => {
    await startEmpty();
    expect(screen.getByText(USER_CREATE.stateLine)).toBeInTheDocument();
    expect(screen.queryByText(CREATE.essentials.audience)).not.toBeInTheDocument();
    expect(screen.queryByText(CREATE.essentials.audienceLive)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: CREATE.submit })).toBeInTheDocument();
  });

  it('has no "Change the draft" control: the source has no refineDraft', async () => {
    expect(userAppSource).not.toHaveProperty('refineDraft');
    await draftFromDescription();
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.draft);
    // The one draft control is "Prepare a new draft"; nothing refines the draft in place.
    expect(screen.getByRole('button', { name: CREATE.draft.regenerate })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /change the draft|refine|improve/i })
    ).not.toBeInTheDocument();
  });

  it('says under the instructions that the people it is shared with can read them', async () => {
    await startEmpty();
    expect(screen.getByText(en.userApps.edit.instructionsDesc)).toBeInTheDocument();
    expect(screen.queryByText(CREATE.essentials.instructionsHelp)).not.toBeInTheDocument();
  });

  it('names a name that is missing, and never an app ID', async () => {
    await startEmpty();
    await submit();
    expect(mockApi.createUserApp).not.toHaveBeenCalled();
    expect(screen.getAllByText(CREATE.error.nameRequired).length).toBeGreaterThan(0);
    expect(screen.queryByText(/App ID/)).not.toBeInTheDocument();
  });

  it('creates an app whose name yields no app ID', async () => {
    await startEmpty();
    fillEssentials({ name: '日本語 !!!' });
    await submit();
    expect(mockApi.createUserApp).toHaveBeenCalledTimes(1);
    expect(lastBody().name).toEqual({ en: '日本語 !!!' });
    expect(where()).toBe(`EDITOR:/apps/${NEW_ID}/edit?created=1`);
  });
});

describe('creating a personal app', () => {
  it('an empty start posts the allow-listed body and opens the editor', async () => {
    await startEmpty();
    fillEssentials();
    await submit();

    expect(mockApi.createUserApp).toHaveBeenCalledTimes(1);
    const body = lastBody();
    expect(Object.keys(body).filter(key => !ALLOWED_BODY_KEYS.includes(key))).toEqual([]);
    expect(body).toMatchObject({
      language: 'en',
      origin: 'blank',
      name: { en: 'Plain-language summary' },
      description: { en: 'Rewrites a text so that everyone understands it.' },
      system: { en: 'You rewrite texts in plain language.' },
      capabilities: { upload: false, webSearch: false, skills: false, integrations: [] }
    });
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('category');
    expect(body).not.toHaveProperty('enabled');
    expect(where()).toBe(`EDITOR:/apps/${NEW_ID}/edit?created=1`);
    // The new app is in the apps list and the sidebar, and counts against the limit.
    expect(mockStale).toEqual({ apps: 1, config: 1 });
    // Nothing of the draft is kept for the tab.
    expect(window.sessionStorage.getItem(USER_APP_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('a template reaches the editor in two clicks', async () => {
    await openStart();
    fireEvent.click(screen.getByRole('button', { name: /Text Summarizer/ }));
    expect(heading()).toHaveTextContent(CREATE.essentials.heading.template);
    await submit();

    const body = lastBody();
    expect(Object.keys(body).filter(key => !ALLOWED_BODY_KEYS.includes(key))).toEqual([]);
    expect(body.origin).toBe('template');
    expect(body.language).toBe('en');
    expect(body.name).toEqual({ en: summarizerTemplate.name.en });
    expect(Object.keys(body.system)).toEqual(['en']);
    expect(where()).toBe(`EDITOR:/apps/${NEW_ID}/edit?created=1`);
  });

  it('a description reaches the editor in two clicks, over the personal draft route', async () => {
    await draftFromDescription('An assistant that drafts replies.');

    // The API module sends the draft request, with its timeout and the signal that cancels it.
    expect(mockClient.post).not.toHaveBeenCalled();
    expect(mockApi.generateUserApp).toHaveBeenCalledTimes(1);
    const [{ signal, ...request }] = mockApi.generateUserApp.mock.calls[0];
    expect(request).toEqual({ description: 'An assistant that drafts replies.', language: 'en' });
    expect(signal).toBeInstanceOf(AbortSignal);

    expect(nameField()).toHaveValue('Reply helper');
    await submit();
    const body = lastBody();
    expect(Object.keys(body).filter(key => !ALLOWED_BODY_KEYS.includes(key))).toEqual([]);
    expect(body.origin).toBe('generated');
    // A suggestion is bound only when the author ticked it.
    expect(body.capabilities).toEqual({
      upload: false,
      webSearch: false,
      skills: false,
      integrations: []
    });
    expect(where()).toBe(`EDITOR:/apps/${NEW_ID}/edit?created=1`);
  });

  it('binds the suggestions the author ticked, with their named actions', async () => {
    await draftFromDescription();
    fireEvent.click(screen.getByRole('checkbox', { name: CREATE.draft.webSearch }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Jira: searchIssues' }));
    await submit();
    expect(lastBody().capabilities).toEqual({
      upload: false,
      webSearch: true,
      skills: false,
      integrations: [{ id: 'jira-main', actions: ['searchIssues'] }]
    });
  });

  it('keeps its draft apart from a draft of the admin page', async () => {
    window.sessionStorage.setItem(
      APP_DRAFT_STORAGE_KEY,
      JSON.stringify({ version: 1, state: { screen: 'essentials', start: 'link' } })
    );
    await openStart();
    expect(heading()).toHaveTextContent('New app');
    expect(USER_APP_DRAFT_STORAGE_KEY).not.toBe(APP_DRAFT_STORAGE_KEY);
  });

  it('shows the limit as the server names it, and no message about an app ID', async () => {
    mockApi.createUserApp.mockRejectedValue(
      enhanced(409, { code: 'QUOTA_USER_APPS', detail: 'Limit reached', status: 409 })
    );
    await startEmpty();
    fillEssentials();
    await submit();
    expect(mockApi.createUserApp).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(en.apiErrors.QUOTA_USER_APPS);
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    expect(nameField()).toHaveValue('Plain-language summary');
    expect(where()).toBe('NEW:/apps/new');
  });

  it('marks the field the server refused', async () => {
    mockApi.createUserApp.mockRejectedValue(
      enhanced(400, {
        code: 'VALIDATION_FAILED',
        detail: 'Invalid',
        errors: [{ pointer: '/system/en', detail: 'Too long' }]
      })
    );
    await startEmpty();
    fillEssentials();
    await submit();
    expect(instructionsField()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Instructions');
  });

  it('says so when the caller may not create apps', async () => {
    mockApi.createUserApp.mockRejectedValue(
      enhanced(403, { code: 'PERMISSION_DENIED', detail: 'No', details: { required: 'userApps' } })
    );
    await startEmpty();
    fillEssentials();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent(CREATE.error.forbidden);
  });
});

describe('who gets the page', () => {
  it('someone who may not create is sent to the apps page', async () => {
    mockApi.fetchUserAppsConfig.mockResolvedValue({ ...CONFIG, canCreate: false });
    renderCreate();
    expect(await screen.findByText('LIST:/apps')).toBeInTheDocument();
    expect(mockApi.fetchUserAppTemplates).not.toHaveBeenCalled();
  });

  it('with the feature off the page sends to the apps page too', async () => {
    mockApi.fetchUserAppsConfig.mockResolvedValue({ enabled: false, canCreate: false });
    renderCreate();
    expect(await screen.findByText('LIST:/apps')).toBeInTheDocument();
  });

  it('someone at the limit reads so and gets no start', async () => {
    mockApi.fetchUserAppsConfig.mockResolvedValue({ ...CONFIG, maxApps: 3, used: 3 });
    renderCreate();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You have 3 apps, which is the limit.'
    );
    expect(screen.queryByRole('button', { name: 'Start empty' })).not.toBeInTheDocument();
    expect(mockApi.fetchUserAppTemplates).not.toHaveBeenCalled();
  });

  it('a limit of zero is no limit', async () => {
    mockApi.fetchUserAppsConfig.mockResolvedValue({ ...CONFIG, maxApps: 0, used: 40 });
    await openStart();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeInTheDocument();
  });

  it('works without the configuration; the server then decides', async () => {
    mockApi.fetchUserAppsConfig.mockRejectedValue(enhanced(500, { code: 'INTERNAL_ERROR' }));
    await startEmpty();
    fillEssentials();
    await submit();
    expect(mockApi.createUserApp).toHaveBeenCalledTimes(1);
  });
});

/** Opens "Copy an existing app" and waits for its list. */
async function openCopyDialog() {
  await openStart();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${CREATE.start.copy}`) }));
  });
  const dialog = await screen.findByRole('dialog');
  await screen.findByRole('button', { name: /FAQ bot/ });
  return dialog;
}

/** The names of the apps the copy dialog lists. */
const listedApps = dialog =>
  [...dialog.querySelectorAll('ul button')].map(button => button.textContent);

async function pickToCopy(name) {
  await openCopyDialog();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  });
  await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
}

/** The keys a copy must never carry: identity, people, sharing, publishing, company settings. */
const NEVER_COPIED = [
  'id',
  'owner',
  'members',
  'sharedWith',
  'permissions',
  'publishedAs',
  'pendingOwner',
  'state',
  'revision',
  'ownership',
  'category',
  'enabled',
  'type',
  'allowedModels',
  'greeting',
  'settings',
  'requiredFeatures',
  'websearch',
  'upload',
  'skillSettings',
  'integrations',
  'order'
];

describe('copying an existing app', () => {
  it('the dialog lists the apps the person can copy, from the user API only', async () => {
    const dialog = await openCopyDialog();
    expect(mockApi.fetchApps).toHaveBeenCalledTimes(1);
    expect(mockApi.fetchUserApps).toHaveBeenCalledWith({ scope: 'personal' });
    const listed = listedApps(dialog);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain('FAQ bot');
    expect(listed[1]).toContain('Meeting notes');
    // An iAssistant app, a link app, a website in a frame, a switched-off app, a
    // reduced body, a retired app and an open offer cannot become a personal app
    // of this person.
    for (const name of [
      'Ask the documents',
      'Intranet',
      'Wiki in a frame',
      'Old bot',
      'Switched-off helper',
      'Offered app'
    ]) {
      expect(dialog).not.toHaveTextContent(name);
    }
    // No admin route (checked after each test) and no request past the API module.
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it('still lists the company apps when the personal apps cannot be loaded', async () => {
    mockApi.fetchUserApps.mockRejectedValue(enhanced(503, { code: 'STORE_UNAVAILABLE' }));
    const dialog = await openCopyDialog();
    expect(listedApps(dialog)).toHaveLength(1);
  });

  it('picking a company app fills the form with what a personal app may hold', async () => {
    await pickToCopy('FAQ bot');
    // The item of the list is what the copy starts from: no second request.
    expect(mockApi.fetchUserApp).not.toHaveBeenCalled();
    expect(nameField()).toHaveValue('FAQ bot (copy)');
    expect(descriptionField()).toHaveValue('Answers HR questions.');
    expect(instructionsField()).toHaveValue('You answer HR questions.');
    // The personal notice, not the admin one ("Everything is copied …, group access …").
    expect(
      screen.getByText(mockI18n.t('userApps.create.copyNote', { name: 'FAQ bot' }))
    ).toBeInTheDocument();
    expect(screen.queryByText(/Group access is not copied/)).not.toBeInTheDocument();
    // The name is selected, ready to be replaced.
    expect(document.activeElement).toBe(nameField());

    await submit();
    expect(mockApi.createUserApp).toHaveBeenCalledTimes(1);
    const body = lastBody();
    expect(Object.keys(body).every(key => ALLOWED_BODY_KEYS.includes(key))).toBe(true);
    for (const key of NEVER_COPIED) expect(body).not.toHaveProperty(key);
    expect(body).toEqual({
      language: 'en',
      origin: 'copy',
      name: { en: 'FAQ bot (copy)', de: 'FAQ-Bot (Kopie)' },
      description: { en: 'Answers HR questions.', de: 'Beantwortet Personalfragen.' },
      system: { en: 'You answer HR questions.', de: 'Sie beantworten Personalfragen.' },
      icon: 'question-mark-circle',
      color: '#0EA5E9',
      preferredModel: 'gemini-flash',
      variables: [{ name: 'topic', label: { en: 'Topic' }, type: 'string', required: false }],
      starterPrompts: [
        { title: { en: 'Leave' }, message: { en: 'How many days of leave do I have?' } }
      ],
      // Only the actions the installation allows in an app of this person stay bound.
      capabilities: {
        upload: true,
        webSearch: true,
        skills: true,
        integrations: [{ id: 'jira-main', actions: ['searchIssues'] }]
      }
    });
    expect(where()).toBe(`EDITOR:/apps/${NEW_ID}/edit?created=1`);
  });

  it('leaves out what the installation does not allow in an app of this person', async () => {
    mockApi.fetchUserAppsConfig.mockResolvedValue({
      ...CONFIG,
      capabilities: {
        modelChoice: false,
        upload: false,
        webSearch: false,
        skills: false,
        integrations: []
      }
    });
    await pickToCopy('FAQ bot');
    await submit();
    const body = lastBody();
    expect(body.capabilities).toEqual({
      upload: false,
      webSearch: false,
      skills: false,
      integrations: []
    });
    expect(body).not.toHaveProperty('preferredModel');
  });

  it('picking a personal app copies its content and nothing of its owner or members', async () => {
    await pickToCopy('Meeting notes');
    expect(nameField()).toHaveValue('Meeting notes (copy)');
    await submit();
    const body = lastBody();
    for (const key of NEVER_COPIED) expect(body).not.toHaveProperty(key);
    expect(body).toMatchObject({
      origin: 'copy',
      name: { en: 'Meeting notes (copy)' },
      system: { en: 'You turn notes into minutes.' },
      capabilities: { upload: false, webSearch: true, skills: false, integrations: [] }
    });
  });

  it('a copy needs instructions, also when the source has none', async () => {
    const { system, ...withoutInstructions } = structuredClone(COMPANY_APPS[0]);
    expect(system).toBeDefined();
    mockApi.fetchApps.mockResolvedValue([withoutInstructions]);
    await pickToCopy('FAQ bot');
    expect(instructionsField()).toHaveValue('');
    await submit();
    expect(mockApi.createUserApp).not.toHaveBeenCalled();
    expect(instructionsField()).toHaveAttribute('aria-invalid', 'true');
  });

  it('?from=<id> opens the copy at once', async () => {
    renderCreate('/apps/new?from=faq-bot');
    await screen.findByRole('heading', { level: 1, name: CREATE.essentials.heading.copy });
    expect(mockApi.fetchUserApp).toHaveBeenCalledWith('faq-bot');
    expect(nameField()).toHaveValue('FAQ bot (copy)');
    // The copy has started: the URL no longer asks for one.
    await waitFor(() => expect(where()).toBe('NEW:/apps/new'));
  });

  it('?from=<id> of an app a personal app cannot become says so on the Start screen', async () => {
    renderCreate('/apps/new?from=intranet');
    expect(await screen.findByText(USER_CREATE.copyUnsupported)).toBeInTheDocument();
    expect(heading()).toHaveTextContent('New app');
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe('NEW:/apps/new'));
    await screen.findByRole('button', { name: /Text Summarizer/ });
  });

  it('?from=<id> of a reduced personal app is not copied either', async () => {
    renderCreate(`/apps/new?from=${REDUCED_ID}`);
    expect(await screen.findByText(USER_CREATE.copyUnsupported)).toBeInTheDocument();
    await screen.findByRole('button', { name: /Text Summarizer/ });
  });

  it('?from=<id> of an app that does not exist says that it is gone', async () => {
    renderCreate('/apps/new?from=no-such-app');
    expect(await screen.findByText(CREATE.copy.sourceGone)).toBeInTheDocument();
    await screen.findByRole('button', { name: /Text Summarizer/ });
  });

  it('says it in German with the formal address', async () => {
    await mockI18n.changeLanguage('de');
    renderCreate('/apps/new?from=intranet');
    expect(await screen.findByText(de.userApps.create.copyUnsupported)).toBeInTheDocument();
    expect(de.userApps.create.copyNote).not.toMatch(/\b(du|dein|deine|dir)\b/i);
    await screen.findByRole('button', { name: /Textzusammenfassung/ });
  });
});

describe('which apps a personal app can be copied from', () => {
  const {
    APP_NOT_COPYABLE,
    copyableApps,
    copySourceOf,
    isCopyableAsUserApp
  } = require('../../../client/src/features/apps/builder/userAppCopy');

  it('takes chat apps that are switched on, and full personal apps the person may use', () => {
    expect(copyableApps(COMPANY_APPS, PERSONAL_APPS).map(app => app.id)).toEqual([
      'faq-bot',
      OWNED_ID
    ]);
    expect(isCopyableAsUserApp({ id: 'plain', name: { en: 'Plain' } })).toBe(true);
    expect(isCopyableAsUserApp(null)).toBe(false);
    expect(isCopyableAsUserApp({ name: { en: 'No ID' } })).toBe(false);
  });

  it('leaves out apps connected to the iAssistant, by settings or by binding', () => {
    const chat = { id: 'ask', type: 'chat', name: { en: 'Ask' }, system: { en: 'Hi' } };
    expect(isCopyableAsUserApp(chat)).toBe(true);
    expect(isCopyableAsUserApp({ ...chat, iassistant: { assistantId: 'hr' } })).toBe(false);
    expect(isCopyableAsUserApp({ ...chat, integrations: { iassistant: {} } })).toBe(false);
    expect(isCopyableAsUserApp({ ...chat, integrations: ['iassistant'] })).toBe(false);
    expect(isCopyableAsUserApp({ ...chat, integrations: { 'jira-main': {} } })).toBe(true);
  });

  it('lists an app once', () => {
    expect(copyableApps([COMPANY_APPS[0]], [COMPANY_APPS[0]])).toHaveLength(1);
    expect(copyableApps(null, undefined)).toEqual([]);
  });

  it('keeps the ID for the screens and only content keys besides', () => {
    const source = copySourceOf(PERSONAL_APPS[0]);
    expect(Object.keys(source).sort()).toEqual(
      ['id', 'name', 'description', 'system', 'icon', 'color', 'capabilities'].sort()
    );
    expect(source.capabilities).toEqual({
      upload: false,
      webSearch: true,
      skills: false,
      integrations: []
    });
  });

  it('rejects with the code useCopySource reads', () => {
    const hook = require('../../../client/src/features/admin/components/app-create/useCopySource');
    expect(APP_NOT_COPYABLE).toBe(hook.APP_NOT_COPYABLE);
  });
});

describe('the body of POST /api/apps', () => {
  const TEMPLATE_DRAFT = {
    id: 'summarizer',
    category: 'utility',
    enabled: true,
    order: 3,
    name: { de: 'Helfer' },
    description: { de: 'Hilft.' },
    system: { de: 'Sie helfen.' },
    icon: 'sparkles',
    color: '#4F46E5',
    preferredModel: 'gpt-x',
    sources: ['handbook'],
    tools: ['braveSearch'],
    upload: { enabled: true },
    websearch: { enabled: true },
    skillSettings: { enabled: true },
    integrations: {
      'jira-main': { actions: ['searchIssues', 'deleteIssue'] },
      'sap-main': { actions: ['readOrder'] }
    },
    variables: [{ name: 'tone', label: { de: 'Ton' }, type: 'string', required: false }]
  };

  it('holds the language, the origin and only content keys', () => {
    const body = buildUserAppBody(TEMPLATE_DRAFT, { language: 'de', origin: 'template' });
    expect(Object.keys(body).filter(key => !ALLOWED_BODY_KEYS.includes(key))).toEqual([]);
    expect(body.language).toBe('de');
    expect(body.origin).toBe('template');
    expect(body.capabilities).toEqual({
      upload: true,
      webSearch: true,
      skills: true,
      integrations: [
        { id: 'jira-main', actions: ['searchIssues', 'deleteIssue'] },
        { id: 'sap-main', actions: ['readOrder'] }
      ]
    });
  });

  it('names an unknown start as an empty one', () => {
    expect(buildUserAppBody(TEMPLATE_DRAFT, { language: 'de', origin: 'link' }).origin).toBe(
      'blank'
    );
    expect(buildUserAppBody(TEMPLATE_DRAFT, { language: 'de' }).origin).toBe('blank');
  });

  it('leaves out what the installation does not allow in an app of this person', () => {
    const body = buildUserAppBody(TEMPLATE_DRAFT, {
      language: 'de',
      origin: 'template',
      allowed: { ...ALL_ALLOWED, modelChoice: false, upload: false, skills: false }
    });
    expect(body).not.toHaveProperty('preferredModel');
    expect(body.capabilities).toEqual({
      upload: false,
      webSearch: true,
      skills: false,
      // Only the action on the list; the installation that is not on it is gone.
      integrations: [{ id: 'jira-main', actions: ['searchIssues'] }]
    });
  });

  it('does not modify the content it limits', () => {
    const content = {
      preferredModel: 'gpt-x',
      capabilities: { upload: true, webSearch: true, skills: true, integrations: [] }
    };
    const copy = structuredClone(content);
    limitToAllowed(content, {
      modelChoice: false,
      upload: false,
      webSearch: false,
      skills: false,
      integrations: []
    });
    expect(content).toEqual(copy);
    expect(limitToAllowed(content, null)).toBe(content);
  });

  it('a failed create keeps its problem body and is not read as a taken ID', () => {
    const quota = asCreateFailure(enhanced(409, { code: 'QUOTA_USER_APPS' }));
    expect(quota.response.status).not.toBe(409);
    expect(quota.response.data).toEqual({ code: 'QUOTA_USER_APPS' });

    const denied = asCreateFailure(
      enhanced(403, { code: 'USER_APP_CAPABILITY_DENIED', details: { capability: 'upload' } })
    );
    expect(denied.response.status).not.toBe(403);
    expect(denied.response.data.details).toEqual({ capability: 'upload' });

    const forbidden = asCreateFailure(enhanced(403, { code: 'PERMISSION_DENIED' }));
    expect(forbidden.response.status).toBe(403);

    const offline = new Error('Network Error');
    expect(asCreateFailure(offline)).toBe(offline);
  });
});

describe('the source contract', () => {
  it('the personal source offers describe, templates, copy and empty, and hides ID and category', () => {
    expect(userAppSource.kind).toBe('personal');
    expect(userAppSource.starts).toEqual({
      describe: true,
      templates: true,
      empty: true,
      copy: true,
      link: false,
      marketplace: false
    });
    expect(userAppSource.showAppId).toBe(false);
    expect(userAppSource.showCategory).toBe(false);
    expect(userAppSource.copy).toEqual({
      stateLine: 'userApps.create.stateLine',
      submit: 'admin.apps.create.submit',
      limits: 'userApps.create.limits',
      // Members can read the instructions: not the admin sentence "users do not see it".
      instructionsHelp: 'userApps.edit.instructionsDesc',
      copyNote: 'userApps.create.copyNote',
      copyUnsupported: 'userApps.create.copyUnsupported'
    });
    for (const member of ['fetchApp', 'fetchExistingApps']) {
      expect(typeof userAppSource[member]).toBe('function');
    }
  });

  it('the admin source reproduces increment 1', () => {
    const { adminAppSource } = require('../../../client/src/features/admin/utils/adminAppSource');
    expect(adminAppSource.kind).toBe('admin');
    expect(Object.values(adminAppSource.starts)).toEqual([true, true, true, true, true, true]);
    expect(adminAppSource.showAppId).toBe(true);
    expect(adminAppSource.showCategory).toBe(true);
    expect(adminAppSource.copy.limits).toBeNull();
    expect(adminAppSource).not.toHaveProperty('refineDraft');
    for (const member of ['fetchTemplates', 'generateDraft', 'fetchModels', 'createApp']) {
      expect(typeof adminAppSource[member]).toBe('function');
      expect(typeof userAppSource[member]).toBe('function');
    }
  });

  it('no file in app-create/ imports an API module: every call goes through the source', () => {
    const files = fs.readdirSync(APP_CREATE_DIR).filter(name => /\.(js|jsx)$/.test(name));
    expect(files.length).toBeGreaterThan(20);
    const offenders = [];
    for (const name of files) {
      const text = fs.readFileSync(path.join(APP_CREATE_DIR, name), 'utf8');
      const imports = [
        ...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)
      ];
      for (const [, specifier] of imports) {
        if (/adminApi|(^|\/)api(\/|$)/.test(specifier)) offenders.push(`${name}: ${specifier}`);
      }
      if (/\badminApi\b|makeAdminApiCall|apiClient/.test(text))
        offenders.push(`${name}: names an API`);
    }
    expect(offenders).toEqual([]);
  });

  it('the personal page and its source name no admin route', () => {
    for (const file of [
      'client/src/features/apps/pages/UserAppCreatePage.jsx',
      'client/src/features/apps/builder/userAppSource.js',
      'client/src/features/apps/builder/userAppCopy.js'
    ]) {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      expect(text).not.toMatch(/from\s+['"][^'"]*adminApi['"]/);
      expect(text).not.toMatch(/['"`]\/admin\//);
    }
  });
});
