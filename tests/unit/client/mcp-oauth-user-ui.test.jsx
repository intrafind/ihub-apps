/**
 * Per-user OAuth for MCP servers — admin and settings UI fixes:
 *
 *   - the server form offers "OAuth — each user signs in" only for HTTP
 *     transports and resets it when the transport switches to stdio;
 *   - a refused config shows the schema's own message, not just
 *     "Invalid server config";
 *   - the connected-users badge has plural forms (en, de);
 *   - Settings → Integrations names the server by its display name after a
 *     sign-in (the one `integration_connected` / `integration_error` result),
 *     not by its id.
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

const mockFetchUserIntegrations = jest.fn();
jest.mock('../../../client/src/api/userIntegrationsApi', () => ({
  fetchUserIntegrations: (...args) => mockFetchUserIntegrations(...args),
  disconnectUserIntegration: jest.fn(),
  fetchUserIntegration: jest.fn(async () => null),
  requestConnectUrl: jest.fn()
}));

const IntegrationsPage =
  require('../../../client/src/features/settings/pages/IntegrationsPage').default;
const {
  resetConnectResultForTests
} = require('../../../client/src/features/integrations/connect/connectResult');

describe('connected-users badge', () => {
  test.each([
    ['en', en, '1 connected user', '3 connected users'],
    ['de', de, '1 verbundene Person', '3 verbundene Personen']
  ])('has plural forms in %s', async (lng, resources, one, other) => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: resources } } });
    expect(i18n.t('admin.integrationCatalog.status.userConnections', { count: 1 })).toBe(one);
    expect(i18n.t('admin.integrationCatalog.status.userConnections', { count: 3 })).toBe(other);
  });
});

describe('Settings → Integrations after an MCP sign-in', () => {
  beforeEach(() => {
    resetConnectResultForTests();
    mockFetchUserIntegrations.mockResolvedValue([
      {
        id: 'okta-whoami',
        name: 'Okta Who Am I',
        protocol: 'mcp',
        actions: [],
        connection: { mode: 'personal', status: 'connected', account: null }
      }
    ]);
    // The other cards of the page answer "not enabled".
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  test('names the server by its display name', async () => {
    window.history.replaceState(
      null,
      '',
      '/settings/integrations?integration_connected=okta-whoami'
    );
    render(
      <MemoryRouter initialEntries={['/settings/integrations']}>
        <IntegrationsPage />
      </MemoryRouter>
    );
    expect(await screen.findByText('Okta Who Am I connected successfully.')).toBeInTheDocument();
    // The result parameters are gone from the address bar.
    expect(window.location.search).toBe('');
  });

  test('names the server in an error too', async () => {
    window.history.replaceState(
      null,
      '',
      '/settings/integrations?integration_error=public_url_mismatch&integration=okta-whoami'
    );
    render(
      <MemoryRouter initialEntries={['/settings/integrations']}>
        <IntegrationsPage />
      </MemoryRouter>
    );
    expect(
      await screen.findByText(
        // The test `t` falls back to the default text.
        'Connecting Okta Who Am I failed: The sign-in did not succeed.'
      )
    ).toBeInTheDocument();
  });
});
