// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → OAuth → Clients: the kind badge says how a client was provisioned
 * (static / personal / dynamic / client metadata). It must never read "admin",
 * which sounds like the RBAC group, and it carries a tooltip saying so.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/OAuthTabsHeader', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useFilterState', () => ({
  useFilterState: (_key, initial) => [initial === 'standard' ? 'all' : initial, jest.fn()]
}));
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }));
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replace(`{{${name}}}`, value),
    text
  );
};
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

const { clientKind } = require('../../../client/src/features/admin/utils/oauthClientKind');
const AdminOAuthClientsPage =
  require('../../../client/src/features/admin/pages/AdminOAuthClientsPage').default;

const CIMD_CLIENT = {
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  name: 'Claude Code',
  active: true,
  metadata: { cimd: true, host: 'claude.ai', displayName: 'Claude Code' }
};
const STATIC_CLIENT = { clientId: 'svc-1', name: 'Service', active: true };
const PERSONAL_CLIENT = { clientId: 'me-1', name: 'Mine', active: true, personal: true };
const DYNAMIC_CLIENT = {
  clientId: 'dcr-1',
  name: 'Dyn',
  active: true,
  metadata: { dcr: true, firstUserName: 'Alice' }
};

function renderPage(clients) {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async url => {
    if (url === '/admin/configs/platform')
      return { data: { oauth: { enabled: { clients: true } } } };
    if (url === '/admin/oauth/clients') return { data: { clients, cimdClients: [] } };
    return { data: {} };
  });
  render(<AdminOAuthClientsPage />);
}

describe('clientKind', () => {
  test('classifies each provisioning path and never returns "admin"', () => {
    expect(clientKind(DYNAMIC_CLIENT)).toBe('dynamic');
    expect(clientKind(PERSONAL_CLIENT)).toBe('personal');
    expect(clientKind(CIMD_CLIENT)).toBe('cimd');
    expect(clientKind(STATIC_CLIENT)).toBe('static');
    expect(clientKind(undefined)).toBe('static');
  });

  test('dynamic registration and personal win over cimd metadata', () => {
    expect(clientKind({ personal: true, metadata: { cimd: true } })).toBe('personal');
    expect(clientKind({ metadata: { dcr: true, cimd: true } })).toBe('dynamic');
  });
});

describe('AdminOAuthClientsPage kind badge', () => {
  test('labels a CIMD client "Client metadata", not "Admin", and explains the badge', async () => {
    renderPage([CIMD_CLIENT]);
    const badge = await screen.findByText('Client metadata', { selector: 'span[title]' });
    expect(badge).toHaveAttribute('title', expect.stringContaining('not the permissions'));
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  test('shows CIMD display name and host on the row', async () => {
    renderPage([CIMD_CLIENT]);
    expect(await screen.findByText('Claude Code · claude.ai')).toBeInTheDocument();
  });

  test('labels admin-configured clients "Static"', async () => {
    renderPage([STATIC_CLIENT]);
    const badge = await screen.findByText('Static', { selector: 'span[title]' });
    expect(badge).toHaveAttribute('title', expect.stringContaining('administrator'));
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  test('keeps personal and dynamic badges', async () => {
    renderPage([PERSONAL_CLIENT, DYNAMIC_CLIENT]);
    await waitFor(() =>
      expect(screen.getByText('Personal', { selector: 'span[title]' })).toBeInTheDocument()
    );
    expect(screen.getByText('Dynamic', { selector: 'span[title]' })).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
