/**
 * Per-user OAuth for MCP servers — admin and settings UI fixes:
 *
 *   - the server form offers "OAuth — each user signs in" only for HTTP
 *     transports and resets it when the transport switches to stdio;
 *   - a refused config shows the schema's own message, not just
 *     "Invalid server config";
 *   - the connected-users badge has plural forms (en, de);
 *   - Settings → Integrations names the server by its display name after a
 *     sign-in, not by its id.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: endpoint => `/api/${String(endpoint).replace(/^\//, '')}`
}));
jest.mock('../../../client/src/api/adminApi', () => ({ makeAdminApiCall: jest.fn() }));
jest.mock('../../../client/src/features/admin/components/OpenApiToolEditor', () => ({
  CredentialRefSelect: () => null
}));
jest.mock('../../../client/src/features/admin/components/McpServerCatalogDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));
// Stable values: the page's effects depend on them.
const mockUser = { id: 'alice' };
const mockPlatform = { platformConfig: { cloudStorage: { enabled: false, providers: [] } } };
jest.mock('../../../client/src/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => mockPlatform
}));
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replace(`{{${name}}}`, value),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  useTranslation: () => mockI18n
}));

const {
  authFields,
  apiErrorText,
  formWithTransportType
} = require('../../../client/src/features/admin/pages/AdminMcpServersPage');
const IntegrationsPage =
  require('../../../client/src/features/settings/pages/IntegrationsPage').default;

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

describe('admin MCP server form', () => {
  test('offers per-user sign-in for HTTP transports only', () => {
    const { container, unmount } = render(
      authFields({ type: 'none' }, jest.fn(), t, { type: 'streamableHttp', url: '' })
    );
    expect(container.querySelector('option[value="oauthUser"]')).not.toBeNull();
    unmount();

    render(authFields({ type: 'none' }, jest.fn(), t, { type: 'stdio', command: '' }));
    expect(document.querySelector('option[value="oauthUser"]')).toBeNull();
    expect(screen.getByText(/Streamable HTTP and SSE transports only/)).toBeInTheDocument();
  });

  test('switching to stdio resets per-user sign-in', () => {
    const form = {
      transport: { type: 'streamableHttp', url: 'https://x' },
      auth: { type: 'oauthUser' }
    };
    expect(formWithTransportType(form, 'stdio')).toMatchObject({
      transport: { type: 'stdio', command: '', args: [] },
      auth: { type: 'none' }
    });
    expect(formWithTransportType(form, 'sse').auth).toEqual({ type: 'oauthUser' });
    const bearer = { ...form, auth: { type: 'bearer', tokenRef: 'r' } };
    expect(formWithTransportType(bearer, 'stdio').auth).toEqual({ type: 'bearer', tokenRef: 'r' });
  });

  test("a refused config shows the schema's message", () => {
    const err = {
      message: 'Request failed with status code 400',
      response: {
        data: {
          error: 'Invalid server config',
          details: [{ message: 'auth.type "oauthUser" requires a streamableHttp or sse transport' }]
        }
      }
    };
    expect(apiErrorText(err)).toBe(
      'Invalid server config: auth.type "oauthUser" requires a streamableHttp or sse transport'
    );
    expect(apiErrorText(new Error('Network Error'))).toBe('Network Error');
  });
});

describe('connected-users badge', () => {
  test.each([
    ['en', en, '1 user connected', '3 users connected'],
    ['de', de, '1 Person verbunden', '3 Personen verbunden']
  ])('has plural forms in %s', async (lng, resources, one, other) => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: resources } } });
    expect(i18n.t('admin.mcp.servers.status.connectedUsers', { count: 1 })).toBe(one);
    expect(i18n.t('admin.mcp.servers.status.connectedUsers', { count: 3 })).toBe(other);
  });
});

describe('Settings → Integrations after an MCP sign-in', () => {
  beforeEach(() => {
    global.fetch = jest.fn(async url => {
      if (String(url).endsWith('mcp/oauth/connections')) {
        return {
          ok: true,
          json: async () => ({
            servers: [
              {
                serverId: 'okta-whoami',
                name: { en: 'Okta Who Am I' },
                connected: true,
                connectUrl: '/api/mcp/oauth/authorize?serverId=okta-whoami'
              }
            ]
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
  });

  test('names the server by its display name', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/integrations?mcp_connected=okta-whoami']}>
        <IntegrationsPage />
      </MemoryRouter>
    );
    expect(await screen.findByText('Okta Who Am I connected successfully.')).toBeInTheDocument();
  });

  test('names the server in an error too', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          '/settings/integrations?mcp_error=public_url_mismatch&mcp_server=okta-whoami'
        ]}
      >
        <IntegrationsPage />
      </MemoryRouter>
    );
    expect(
      await screen.findByText(
        // The test `t` falls back to the code itself.
        'Connecting Okta Who Am I failed: public_url_mismatch'
      )
    ).toBeInTheDocument();
  });
});
