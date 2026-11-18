// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every admin form that saves platform.json with a full `POST` keeps the
 * revision it was loaded from in a holder of its own (CodeRabbit on #3769).
 *
 * The holder is filled by the read that fills the form, sent as `If-Match` on
 * each save, and kept after a `412`: closing the conflict dialog and saving
 * again is refused again. Only a reload of the form or "Keep my changes and
 * overwrite" (which re-reads into the refused form's holder) moves it on, and a
 * successful save advances it. A save may re-read platform.json to merge the
 * settings it does not show, but that read's ETag never reaches the holder;
 * before this fix each save took the ETag of its own fresh read, so the second
 * save after a closed conflict dialog silently overwrote the other change.
 *
 * The tests run against a fake server that refuses a `POST` whose `If-Match`
 * is not its current revision, like the real route does.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockRequest = jest.fn();
jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: (...args) => mockRequest(...args)
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`,
  buildPath: path => `/${path}`,
  buildAssetUrl: path => path,
  getBasePath: () => ''
}));
jest.mock('../../../client/src/api/endpoints/projects.js', () => ({
  CRAWL_REQUEST_TIMEOUT_MS: 1000
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));
jest.mock('react-router-dom', () => ({
  __esModule: true,
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
  Link: ({ children }) => <span>{children}</span>
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: {}, refreshConfig: jest.fn() })
}));
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useAiAcknowledgementAdmin', () => ({
  __esModule: true,
  useAiAcknowledgementAdmin: () => ({ reload: jest.fn(), settings: { requiredVersion: 1 } })
}));
jest.mock('../../../client/src/features/admin/components/euAiAct/EuAiActStateNote', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/feedback/FeedbackReview', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/OAuthTabsHeader', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useFilterState', () => ({
  useFilterState: (_key, initial) => [initial, jest.fn()]
}));
jest.mock('../../../client/src/features/admin/components/voice/VoiceInputTestPanel', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/voice/VoiceModeSettings', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/voice/components/ReadAloudButton', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/voice/hooks/useReadAloudPlayback', () => ({
  __esModule: true,
  default: () => ({})
}));
jest.mock('../../../client/src/features/voice/utils/readAloud', () => ({
  stop: jest.fn()
}));

const AdminConfigConflictNotice =
  require('../../../client/src/features/admin/components/AdminConfigConflictNotice').default;
const AiAcknowledgementSettingsCard =
  require('../../../client/src/features/admin/components/AiAcknowledgementSettingsCard').default;
const AiNoticeSettingsCard =
  require('../../../client/src/features/admin/components/AiNoticeSettingsCard').default;
const AdminTelemetryPage =
  require('../../../client/src/features/admin/pages/AdminTelemetryPage').default;
const AdminVoiceInputPage =
  require('../../../client/src/features/admin/pages/AdminVoiceInputPage').default;
const AdminFeedbackPage =
  require('../../../client/src/features/admin/pages/AdminFeedbackPage').default;
const AdminLoggingPage =
  require('../../../client/src/features/admin/pages/AdminLoggingPage').default;
const AdminOAuthClientsPage =
  require('../../../client/src/features/admin/pages/AdminOAuthClientsPage').default;
const AdminOAuthServerPage =
  require('../../../client/src/features/admin/pages/AdminOAuthServerPage').default;

const PLATFORM_URL = '/admin/configs/platform';

/** The fake server: platform.json and its revision, plus the other reads the pages make. */
const DEFAULT_PLATFORM = { features: {}, oauth: { enabled: {} } };
const server = { revision: 1, posts: [], platform: DEFAULT_PLATFORM };
const etagOf = revision => `"rev-${revision}"`;
const ok = (data, etag) => ({ status: 200, data, headers: etag ? { etag } : {} });
const conflict = () => {
  const error = new Error('Request failed with status code 412');
  error.response = {
    status: 412,
    data: { code: 'PRECONDITION_FAILED', status: 412, detail: 'changed' }
  };
  return error;
};

const OTHER_READS = {
  '/admin/features': { items: [{ id: 'feedback', enabled: true }] },
  '/admin/apps': { items: [] },
  '/admin/models': { items: [] },
  '/admin/oauth/clients': { clients: [], cimdClients: [] },
  '/admin/logging/config': {},
  '/admin/audit-log/settings': {}
};

beforeEach(() => {
  server.revision = 1;
  server.posts = [];
  server.platform = DEFAULT_PLATFORM;
  localStorage.clear();
  mockRequest.mockReset();
  mockRequest.mockImplementation(async config => {
    const method = String(config.method || 'GET').toUpperCase();
    const path = config.url.split('?')[0];
    if (path === PLATFORM_URL && method === 'GET') {
      return ok(structuredClone(server.platform), etagOf(server.revision));
    }
    if (path === PLATFORM_URL && method === 'POST') {
      const ifMatch = config.headers?.['If-Match'] ?? null;
      server.posts.push(ifMatch);
      if (ifMatch && ifMatch !== etagOf(server.revision)) throw conflict();
      server.revision += 1;
      return ok({}, etagOf(server.revision));
    }
    return ok(OTHER_READS[path] ?? {});
  });
});

/** Another admin saves platform.json after this form loaded. */
const someoneElseSaves = () => {
  server.revision += 1;
};

const posts = () => server.posts;

/**
 * The three steps every form must pass: refused, refused again after Close,
 * and accepted after "Keep my changes and overwrite".
 *
 * @param {() => HTMLElement} saveControl - The control that saves the form
 */
async function expectRefusedUntilOverwrite(saveControl) {
  // Loaded at rev-1; someone else saved rev-2.
  someoneElseSaves();

  fireEvent.click(saveControl());
  await screen.findByRole('alertdialog');
  expect(posts()).toEqual([etagOf(1)]);

  // Close only: the next save still sends the revision the form was loaded from.
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  fireEvent.click(saveControl());
  await screen.findByRole('alertdialog');
  expect(posts()).toEqual([etagOf(1), etagOf(1)]);

  // Explicit overwrite: the dialog re-reads the current revision into this form's holder.
  fireEvent.click(
    screen.getByRole('button', { name: 'Keep my changes and overwrite on next save' })
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  await act(async () => {});
  fireEvent.click(saveControl());
  await waitFor(() => expect(posts()).toHaveLength(3));
  expect(posts()[2]).toBe(etagOf(2));
  expect(server.revision).toBe(3);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
}

/** A successful save advances the holder: the next save sends the new revision. */
async function expectSaveAdvancesRevision(saveControl) {
  fireEvent.click(saveControl());
  await waitFor(() => expect(posts()).toHaveLength(1));
  await waitFor(() => expect(saveControl()).not.toBeDisabled());
  fireEvent.click(saveControl());
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()).toEqual([etagOf(1), etagOf(2)]);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
}

const renderWithNotice = element =>
  render(
    <>
      {element}
      <AdminConfigConflictNotice onReload={jest.fn()} />
    </>
  );

/** The pages, each with how to reach the control that saves its platform.json form. */
const FORMS = [
  {
    name: 'EU AI Act → AI acknowledgement card',
    element: <AiAcknowledgementSettingsCard />,
    save: () => screen.getByRole('button', { name: 'Save' })
  },
  {
    name: 'EU AI Act → AI notice card',
    element: <AiNoticeSettingsCard />,
    save: () => screen.getByRole('button', { name: 'Save' })
  },
  {
    name: 'Telemetry',
    element: <AdminTelemetryPage />,
    save: () => screen.getByRole('button', { name: 'Save Telemetry Settings' })
  },
  {
    name: 'Voice input',
    element: <AdminVoiceInputPage />,
    save: () => screen.getByRole('button', { name: 'Save' })
  },
  {
    name: 'Logging → authentication debug',
    element: <AdminLoggingPage />,
    save: () => screen.getByRole('button', { name: 'Save Authentication Debug Settings' })
  },
  {
    name: 'OAuth clients → enable toggle',
    element: <AdminOAuthClientsPage />,
    save: () => screen.getByRole('button', { name: 'OAuth Clients' })
  },
  {
    name: 'OAuth server → enable toggle',
    element: <AdminOAuthServerPage />,
    save: () => screen.getByRole('button', { name: 'OAuth 2.0 Authorization Server' })
  },
  {
    name: 'OAuth server → settings',
    element: <AdminOAuthServerPage />,
    // The settings are shown while the authorization server is on.
    platform: { oauth: { enabled: { authz: true } } },
    save: () => screen.getByRole('button', { name: /Save Settings/i })
  }
];

describe.each(FORMS)('$name', ({ element, save, platform }) => {
  test('a refused save stays refused after Close, until "Keep my changes and overwrite"', async () => {
    if (platform) server.platform = platform;
    renderWithNotice(element);
    await waitFor(() => expect(save()).toBeInTheDocument());
    // The load's read finished (it set the form's revision).
    await waitFor(() =>
      expect(
        mockRequest.mock.calls.some(
          ([config]) => config.url === PLATFORM_URL && (config.method ?? 'GET') === 'GET'
        )
      ).toBe(true)
    );
    await act(async () => {});
    await expectRefusedUntilOverwrite(save);
  });
});

describe('a successful save advances the form revision', () => {
  test('Telemetry: two saves in a row send rev-1, then the rev-2 the first save returned', async () => {
    renderWithNotice(<AdminTelemetryPage />);
    const save = () => screen.getByRole('button', { name: 'Save Telemetry Settings' });
    await waitFor(() => expect(save()).toBeInTheDocument());
    await expectSaveAdvancesRevision(save);
  });
});

describe('Feedback settings', () => {
  const storeSwitch = () => screen.getByRole('switch', { name: 'Store feedback' });
  const saveButton = () => screen.getByRole('button', { name: 'Save Changes' });

  test('a refused storage save stays refused after Close, until "Keep my changes and overwrite"', async () => {
    renderWithNotice(<AdminFeedbackPage />);
    await waitFor(() => expect(storeSwitch()).toBeInTheDocument());
    fireEvent.click(storeSwitch());
    await expectRefusedUntilOverwrite(saveButton);
  });

  test('a collection change that was saved before the platform save was refused is not sent again', async () => {
    renderWithNotice(<AdminFeedbackPage />);
    await waitFor(() => expect(storeSwitch()).toBeInTheDocument());
    const collectionSwitch = screen.getByRole('switch', { name: /Collect feedback/i });
    fireEvent.click(collectionSwitch);
    fireEvent.click(storeSwitch());
    someoneElseSaves();

    fireEvent.click(saveButton());
    await screen.findByRole('alertdialog');
    const featurePuts = () =>
      mockRequest.mock.calls.filter(
        ([config]) => config.url === '/admin/features' && config.method === 'PUT'
      );
    expect(featurePuts()).toHaveLength(1);

    // The collection PUT succeeded: its baseline moved on, the storage one did not.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(featurePuts()).toHaveLength(1);
  });
});
