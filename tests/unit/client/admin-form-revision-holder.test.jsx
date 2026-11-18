// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How the admin pages save platform.json (CodeRabbit on #3769).
 *
 * A form that is the only platform.json writer on its page and POSTs the whole
 * config (Telemetry, Voice input, both OAuth pages) keeps the revision it was
 * loaded from in a holder of its own. The holder is filled by the read that
 * fills the form, sent as `If-Match` on each save, and kept after a `412`:
 * closing the conflict dialog and saving again is refused again. Only a reload
 * of the form or "Keep my changes and overwrite" (which re-reads into the
 * refused form's holder) moves it on, and a successful save advances it. A
 * save may re-read platform.json to merge the settings it does not show, but
 * that read's ETag never reaches the holder.
 *
 * A card that shares its page with other platform.json writers (the EU AI Act
 * cards, Logging → authentication debug, Feedback → storage) saves its own
 * fields with the scoped `PATCH` instead, so saving one card never makes a
 * sibling's save fail with 412.
 *
 * The tests run against a fake server that refuses a `POST` whose `If-Match`
 * is not its current revision, like the real route does, and counts every
 * write of platform.json (POST, PATCH, and the dedicated PUTs that write it).
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

const { localizedTextPatch } = require('../../../client/src/features/admin/utils/platformPatch');

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

/** Routes that write platform.json besides the config route itself. */
const PLATFORM_WRITING_PUTS = new Set([
  '/admin/logging/config',
  '/admin/audit-log/settings',
  '/admin/usage/meta'
]);

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
  server.patches = [];
  server.failPatch = false;
  server.platform = DEFAULT_PLATFORM;
  localStorage.clear();
  mockRequest.mockReset();
  mockRequest.mockImplementation(async config => {
    const method = String(config.method || 'GET').toUpperCase();
    const path = config.url.split('?')[0];
    if (path === PLATFORM_URL && method === 'GET') {
      return ok(structuredClone(server.platform), etagOf(server.revision));
    }
    if (path === PLATFORM_URL && method === 'PATCH') {
      server.patches.push({ body: config.data, ifMatch: config.headers?.['If-Match'] ?? null });
      if (server.failPatch) {
        server.failPatch = false;
        const error = new Error('Request failed with status code 500');
        error.response = { status: 500, data: { status: 500, detail: 'boom' } };
        throw error;
      }
      server.revision += 1;
      return ok(structuredClone(server.platform), etagOf(server.revision));
    }
    if (PLATFORM_WRITING_PUTS.has(path) && method === 'PUT') {
      // These routes write platform.json too: its revision moves on.
      server.revision += 1;
      return ok(OTHER_READS[path] ?? {});
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

describe('cards that share their page with other platform.json writers save with PATCH', () => {
  const patchBodies = () => server.patches.map(patch => patch.body);

  test('EU AI Act: the AI notice card, then the AI acknowledgement card, both save (no 412)', async () => {
    server.platform = {
      aiDisclosure: { firstTurnNotice: { enabled: true, text: {} } },
      aiAcknowledgement: { enabled: true, enforce: true, text: {}, policyUrl: '/policy' }
    };
    renderWithNotice(
      <>
        <div data-testid="notice">
          <AiNoticeSettingsCard />
        </div>
        <div data-testid="ack">
          <AiAcknowledgementSettingsCard />
        </div>
      </>
    );
    const saveIn = id => within(screen.getByTestId(id)).getByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveIn('notice')).toBeInTheDocument());
    await waitFor(() => expect(saveIn('ack')).toBeInTheDocument());

    fireEvent.click(saveIn('notice'));
    await waitFor(() => expect(server.patches).toHaveLength(1));

    // The admin clears the policy link: the PATCH removes it with null.
    fireEvent.change(screen.getByLabelText('AI policy link (https://… or /path)'), {
      target: { value: '' }
    });
    fireEvent.click(saveIn('ack'));
    await waitFor(() => expect(server.patches).toHaveLength(2));
    await act(async () => {});

    expect(patchBodies()[0]).toEqual({
      aiDisclosure: { firstTurnNotice: { enabled: true, text: {} }, guardrail: { text: null } }
    });
    expect(patchBodies()[1]).toEqual({
      aiAcknowledgement: { enabled: true, enforce: true, text: {}, policyUrl: null }
    });
    expect(server.patches.every(patch => patch.ifMatch === null)).toBe(true);
    expect(posts()).toEqual([]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getAllByText(/saved/).length).toBeGreaterThanOrEqual(2);
  });

  test('Logging: the logging save, then the authentication debug save, both succeed (no 412)', async () => {
    server.platform = { auth: { debug: { enabled: false } } };
    renderWithNotice(<AdminLoggingPage />);
    const saveLogging = () => screen.getByRole('button', { name: 'Save Logging Configuration' });
    const saveDebug = () =>
      screen.getByRole('button', { name: 'Save Authentication Debug Settings' });
    await waitFor(() => expect(saveDebug()).toBeInTheDocument());

    fireEvent.click(saveLogging());
    await waitFor(() => expect(server.revision).toBe(2));
    await waitFor(() => expect(saveDebug()).not.toBeDisabled());
    fireEvent.click(saveDebug());
    await waitFor(() => expect(server.patches).toHaveLength(1));
    await act(async () => {});

    const [body] = patchBodies();
    expect(Object.keys(body)).toEqual(['auth']);
    expect(Object.keys(body.auth)).toEqual(['debug']);
    expect(body.auth.debug.enabled).toBe(false);
    expect(posts()).toEqual([]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // The message renders after the PATCH resolves, which can take more than
    // the one flush above on a loaded runner.
    expect(
      await screen.findByText('Authentication debug configuration saved successfully')
    ).toBeInTheDocument();
  });

  describe('Feedback settings', () => {
    const storeSwitch = () => screen.getByRole('switch', { name: 'Store feedback' });
    const saveButton = () => screen.getByRole('button', { name: 'Save Changes' });

    test('storage and identification mode save, then storage again: no 412', async () => {
      renderWithNotice(<AdminFeedbackPage />);
      await waitFor(() => expect(storeSwitch()).toBeInTheDocument());

      // Storage off and a new identification mode (a PUT that writes platform.json).
      fireEvent.click(storeSwitch());
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'anonymous' } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(server.revision).toBe(3));
      await waitFor(() => expect(saveButton()).toBeDisabled());

      // Storage on again, after the mode save moved the revision on.
      fireEvent.click(storeSwitch());
      fireEvent.click(saveButton());
      await waitFor(() => expect(server.patches).toHaveLength(2));
      await act(async () => {});

      expect(patchBodies()).toEqual([
        { features: { feedbackTracking: false } },
        { features: { feedbackTracking: true } }
      ]);
      expect(posts()).toEqual([]);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    test('a collection change saved before the storage save failed is not sent again', async () => {
      renderWithNotice(<AdminFeedbackPage />);
      await waitFor(() => expect(storeSwitch()).toBeInTheDocument());
      fireEvent.click(screen.getByRole('switch', { name: /Collect feedback/i }));
      fireEvent.click(storeSwitch());
      server.failPatch = true;

      fireEvent.click(saveButton());
      await waitFor(() => expect(server.patches).toHaveLength(1));
      await waitFor(() => expect(saveButton()).not.toBeDisabled());
      const featurePuts = () =>
        mockRequest.mock.calls.filter(
          ([config]) => config.url === '/admin/features' && config.method === 'PUT'
        );
      expect(featurePuts()).toHaveLength(1);

      // The collection PUT succeeded: its baseline moved on, the storage one did not.
      fireEvent.click(saveButton());
      await waitFor(() => expect(server.patches).toHaveLength(2));
      expect(featurePuts()).toHaveLength(1);
    });
  });
});

describe('localizedTextPatch', () => {
  test('keeps the non-empty texts and sends null for a language that was emptied or removed', () => {
    expect(
      localizedTextPatch({ en: 'Hi', de: 'Hallo', fr: 'Salut' }, { en: 'Hello', de: '  ' })
    ).toEqual({ en: 'Hello', de: null, fr: null });
    expect(localizedTextPatch(undefined, { en: 'Hi' })).toEqual({ en: 'Hi' });
  });
});
