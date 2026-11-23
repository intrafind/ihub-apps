// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The settings pages that read and write platform.json (Telemetry, Voice input, MCP gateway,
 * OAuth server) save through the shared bottom bar: it shows only while a setting changed,
 * a change of a NESTED setting counts, Discard puts everything back, Save sends the loaded
 * revision and the bar goes away, and a refused save keeps the bar and says why in it.
 *
 * Runs on the real dirty tracking, against a fake server that records every POST of
 * platform.json.
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
jest.mock('react-i18next', () => {
  const t = (key, fallback, options) => {
    const template = typeof fallback === 'string' ? fallback : key;
    const vars = (typeof fallback === 'object' ? fallback : options) || {};
    return template.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: {}, refreshConfig: jest.fn() })
}));
jest.mock('../../../client/src/features/admin/components/OAuthTabsHeader', () => ({
  __esModule: true,
  default: () => null
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
jest.mock('../../../client/src/features/voice/utils/readAloud', () => ({ stop: jest.fn() }));

const AdminTelemetryPage =
  require('../../../client/src/features/admin/pages/AdminTelemetryPage').default;
const AdminVoiceInputPage =
  require('../../../client/src/features/admin/pages/AdminVoiceInputPage').default;
const AdminMcpGatewayPage =
  require('../../../client/src/features/admin/pages/AdminMcpGatewayPage').default;
const AdminOAuthServerPage =
  require('../../../client/src/features/admin/pages/AdminOAuthServerPage').default;

const PLATFORM_URL = '/admin/configs/platform';
const etagOf = revision => `"rev-${revision}"`;
const ok = (data, etag) => ({ status: 200, data, headers: etag ? { etag } : {} });

/** The fake server: platform.json with its revision, and every POST it received. */
const server = { revision: 1, platform: {}, posts: [], failNextPost: false, azureTest: null };

beforeEach(() => {
  server.revision = 1;
  server.platform = {};
  server.posts = [];
  server.failNextPost = false;
  server.azureTest = null;
  mockRequest.mockReset();
  mockRequest.mockImplementation(async config => {
    const method = String(config.method || 'GET').toUpperCase();
    const path = config.url.split('?')[0];
    if (path === PLATFORM_URL && method === 'GET') {
      return ok(structuredClone(server.platform), etagOf(server.revision));
    }
    if (path === PLATFORM_URL && method === 'POST') {
      server.posts.push({ body: config.data, ifMatch: config.headers?.['If-Match'] ?? null });
      if (server.failNextPost) {
        server.failNextPost = false;
        const error = new Error('boom: the server refused');
        error.response = { status: 500, data: { status: 500, detail: 'boom: the server refused' } };
        throw error;
      }
      server.platform = structuredClone(config.data);
      server.revision += 1;
      return ok({}, etagOf(server.revision));
    }
    if (path === '/admin/voice/azure/_test') return server.azureTest();
    if (path === '/admin/models') return ok({ items: [] });
    return ok({});
  });
});

const bar = () => screen.queryByRole('region', { name: /save changes/i });
const saveButton = () => {
  const buttons = within(bar()).getAllByRole('button');
  return buttons[buttons.length - 1];
};
const discardButton = () => within(bar()).getByRole('button', { name: 'Discard' });
const settle = () => act(async () => {});

/**
 * The pages. `edit` changes ONE nested setting and nothing else; `restored` says the page
 * shows the loaded value again; `sent` says what the POST body holds after that edit.
 */
const PAGES = [
  {
    name: 'Telemetry',
    element: <AdminTelemetryPage />,
    platform: { telemetry: { spans: { enabled: true } } },
    ready: () => screen.getByLabelText(/Emit spans/),
    edit: () => fireEvent.click(screen.getByLabelText(/Emit spans/)),
    revert: () => fireEvent.click(screen.getByLabelText(/Emit spans/)),
    restored: () => expect(screen.getByLabelText(/Emit spans/)).toBeChecked(),
    sent: body => expect(body.telemetry.spans.enabled).toBe(false)
  },
  {
    name: 'Voice input',
    element: <AdminVoiceInputPage />,
    platform: { speech: { azure: { region: 'westeurope' } } },
    ready: () => screen.getByLabelText('Region'),
    edit: () => fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eastus' } }),
    revert: () =>
      fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'westeurope' } }),
    restored: () => expect(screen.getByLabelText('Region')).toHaveValue('westeurope'),
    sent: body => expect(body.speech.azure.region).toBe('eastus')
  },
  {
    name: 'MCP gateway',
    element: <AdminMcpGatewayPage />,
    platform: {
      mcpServer: { enabled: true, transports: { streamableHttp: { stateless: false } } }
    },
    ready: () => screen.getByRole('switch', { name: /Stateless mode/ }),
    edit: () => fireEvent.click(screen.getByRole('switch', { name: /Stateless mode/ })),
    revert: () => fireEvent.click(screen.getByRole('switch', { name: /Stateless mode/ })),
    restored: () =>
      expect(screen.getByRole('switch', { name: /Stateless mode/ })).toHaveAttribute(
        'aria-checked',
        'false'
      ),
    sent: body => expect(body.mcpServer.transports.streamableHttp.stateless).toBe(true)
  },
  {
    name: 'OAuth server',
    element: <AdminOAuthServerPage />,
    platform: { oauth: { enabled: { authz: true }, personalKeys: { enabled: false } } },
    ready: () => screen.getByRole('switch', { name: /Personal API Keys/ }),
    edit: () => fireEvent.click(screen.getByRole('switch', { name: /Personal API Keys/ })),
    revert: () => fireEvent.click(screen.getByRole('switch', { name: /Personal API Keys/ })),
    restored: () =>
      expect(screen.getByRole('switch', { name: /Personal API Keys/ })).toHaveAttribute(
        'aria-checked',
        'false'
      ),
    sent: body => expect(body.oauth.personalKeys.enabled).toBe(true)
  }
];

describe.each(PAGES)(
  '$name save bar',
  ({ element, platform, ready, edit, revert, restored, sent }) => {
    const open = async () => {
      server.platform = structuredClone(platform);
      render(element);
      await waitFor(() => expect(ready()).toBeInTheDocument());
      await settle();
    };

    test('no bar until something changed; a change of a nested setting shows it', async () => {
      await open();
      expect(bar()).not.toBeInTheDocument();

      edit();

      expect(bar()).toBeInTheDocument();
      expect(within(bar()).getByText('You have unsaved changes')).toBeInTheDocument();
    });

    test('Discard puts the setting back and takes the bar away', async () => {
      await open();
      edit();

      fireEvent.click(discardButton());

      restored();
      expect(bar()).not.toBeInTheDocument();
      expect(server.posts).toHaveLength(0);
    });

    test('Save sends the change with the loaded revision, and the bar goes away', async () => {
      await open();
      edit();

      await act(async () => {
        fireEvent.click(saveButton());
      });

      await waitFor(() => expect(server.posts).toHaveLength(1));
      expect(server.posts[0].ifMatch).toBe(etagOf(1));
      sent(server.posts[0].body);
      await waitFor(() => expect(bar()).not.toBeInTheDocument());
    });

    test('a refused save keeps the bar, says why in it, and can be tried again', async () => {
      await open();
      edit();
      server.failNextPost = true;

      await act(async () => {
        fireEvent.click(saveButton());
      });

      await waitFor(() =>
        expect(within(bar()).getByText(/boom: the server refused/)).toBeVisible()
      );
      expect(bar()).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(saveButton());
      });
      await waitFor(() => expect(server.posts).toHaveLength(2));
      await waitFor(() => expect(bar()).not.toBeInTheDocument());
    });
    test('after a refused save the bar stays even when the form is back at the loaded value', async () => {
      // The write may have gone through and only its answer been lost: the admin must still be
      // able to send the shown value again, or to discard.
      await open();
      edit();
      server.failNextPost = true;
      await act(async () => {
        fireEvent.click(saveButton());
      });
      await waitFor(() =>
        expect(within(bar()).getByText(/boom: the server refused/)).toBeVisible()
      );

      revert();
      restored();

      expect(bar()).toBeInTheDocument();
      fireEvent.click(discardButton());
      expect(bar()).not.toBeInTheDocument();
    });
  }
);

describe('Voice input: an Azure test that is still running when the credentials change', () => {
  test('its answer is dropped after Discard, and no result is shown for credentials that are gone', async () => {
    let answer;
    server.platform = { speech: { azure: { region: 'westeurope' } } };
    server.azureTest = () =>
      new Promise(resolve => {
        answer = () => resolve(ok({ ok: true, code: 'token-issued', region: 'eastus' }));
      });
    render(<AdminVoiceInputPage />);
    await screen.findByLabelText('Region');
    await settle();

    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eastus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(answer).toBeDefined());
    fireEvent.click(discardButton());
    expect(screen.getByLabelText('Region')).toHaveValue('westeurope');

    await act(async () => {
      answer();
    });

    expect(screen.queryByText(/Key accepted/)).not.toBeInTheDocument();
  });

  test('a failed test shows its error while the credentials are unchanged', async () => {
    server.platform = { speech: { azure: { region: 'westeurope' } } };
    server.azureTest = async () => {
      throw new Error('test request refused');
    };
    render(<AdminVoiceInputPage />);
    await screen.findByLabelText('Region');
    await settle();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    });

    expect(await screen.findByText(/test request refused/)).toBeInTheDocument();
  });
});
