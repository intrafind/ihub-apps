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

const IntegrationsPage =
  require('../../../client/src/features/settings/pages/IntegrationsPage').default;

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
