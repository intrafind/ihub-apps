// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Integrations → Requests (#2926):
 *
 *   - the tab shows the number of open requests as its badge, and the page
 *     tells the sidebar the same number;
 *   - Approve approves and opens the install dialog for the definition; an
 *     approved request offers Install, which opens it without approving again;
 *   - Decline and Decline and hide ask for an optional note first;
 *   - an already installed definition links its installation;
 *   - closed requests are folded, hidden definitions can be shown again;
 *   - the sidebar puts the count next to Integrations.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchIntegrationRequests: jest.fn(),
  approveIntegrationRequest: jest.fn(),
  declineIntegrationRequest: jest.fn(),
  showHiddenIntegration: jest.fn(),
  dialogProps: null
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: () => Promise.resolve({ items: [] }),
  fetchIntegrationCatalog: () => Promise.resolve({ items: [] }),
  fetchIntegrationRequests: (...args) => mockApi.fetchIntegrationRequests(...args),
  approveIntegrationRequest: (...args) => mockApi.approveIntegrationRequest(...args),
  declineIntegrationRequest: (...args) => mockApi.declineIntegrationRequest(...args),
  showHiddenIntegration: (...args) => mockApi.showHiddenIntegration(...args),
  deleteInstalledIntegration: jest.fn(),
  setInstalledIntegrationEnabled: jest.fn(),
  reloadIntegrationCatalog: jest.fn(),
  testInstalledIntegration: jest.fn()
}));
const mockWebsites = { fetchWebsiteCorpusDomains: jest.fn() };
jest.mock('../../../client/src/api/websiteCorpusAdminApi', () => ({
  fetchWebsiteCorpusDomains: (...args) => mockWebsites.fetchWebsiteCorpusDomains(...args),
  addWebsiteCorpusDomain: jest.fn(),
  approveWebsiteCorpusDomain: jest.fn(),
  declineWebsiteCorpusDomain: jest.fn(),
  removeWebsiteCorpusDomain: jest.fn()
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: jest.fn().mockResolvedValue([]),
  fetchAdminGroups: jest.fn().mockResolvedValue({ groups: {} }),
  fetchAdminPlatformConfig: jest.fn().mockResolvedValue(null),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: jest.fn()
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: () => true })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/IntegrationTestResults', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock(
  '../../../client/src/features/admin/components/integrations/IntegrationInstallDialog',
  () => ({
    __esModule: true,
    default: props => {
      mockApi.dialogProps = props;
      return <div data-testid="install-dialog">{props.definitionId}</div>;
    }
  })
);
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: endpoint => `/api/${String(endpoint).replace(/^\//, '')}`,
  buildAssetUrl: url => url
}));
// The sidebar's contexts.
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin', isAdmin: true, permissions: { adminAccess: true } } })
}));
jest.mock('../../../client/src/features/admin/contexts/SidebarContext', () => ({
  useSidebar: () => ({
    isCollapsed: false,
    isMobileOpen: false,
    toggle: () => {},
    closeMobile: () => {},
    expandedSections: new Set(['integrations']),
    toggleSection: () => {},
    expandSection: () => {}
  })
}));
jest.mock('../../../client/src/shared/components/IHubLogo', () => ({
  __esModule: true,
  default: () => null
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const AdminIntegrationsPage =
  require('../../../client/src/features/admin/pages/AdminIntegrationsPage').default;
const AdminSidebar = require('../../../client/src/features/admin/components/AdminSidebar').default;
const {
  announceIntegrationRequestCount
} = require('../../../client/src/features/admin/hooks/useIntegrationRequestCount');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`
  });
});

const request = (id, overrides = {}) => ({
  id,
  definition: 'com.example/docs',
  definitionName: 'Docs',
  definitionAvailable: true,
  installedInstances: [],
  status: 'open',
  reason: null,
  requester: { id: 'alice', name: 'Alice', groups: ['users'] },
  createdAt: '2026-11-02T10:00:00Z',
  updatedAt: '2026-11-02T10:00:00Z',
  decidedAt: null,
  decidedBy: null,
  note: null,
  hidden: false,
  fulfilledBy: null,
  closedAt: null,
  ...overrides
});

const QUEUE = {
  requests: [
    request('ireq_a', { reason: 'For contracts' }),
    request('ireq_b', {
      definition: 'com.example/crm',
      definitionName: 'CRM',
      status: 'approved',
      requester: { id: 'bob', name: 'Bob', groups: ['users'] }
    }),
    request('ireq_c', {
      definition: 'com.example/hr',
      definitionName: 'HR',
      installedInstances: ['hr-main'],
      requester: { id: 'carol', name: 'Carol', groups: ['users'] }
    }),
    request('ireq_d', {
      definition: 'com.example/wiki',
      definitionName: 'Wiki',
      status: 'declined',
      note: 'Not licensed',
      closedAt: '2026-11-01T10:00:00Z'
    })
  ],
  hidden: [
    {
      definition: 'com.example/games',
      name: 'Games',
      hiddenAt: '2026-10-01T10:00:00Z',
      hiddenBy: { id: 'admin', name: 'Admin' }
    }
  ],
  openCount: 2
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.dialogProps = null;
  mockApi.fetchIntegrationRequests.mockResolvedValue(QUEUE);
  mockWebsites.fetchWebsiteCorpusDomains.mockResolvedValue({
    items: [],
    nextCursor: null,
    openCount: 0
  });
  mockApi.approveIntegrationRequest.mockResolvedValue({ ...QUEUE.requests[0], status: 'approved' });
  mockApi.declineIntegrationRequest.mockResolvedValue({ request: {}, alsoDeclined: 0 });
  mockApi.showHiddenIntegration.mockResolvedValue(undefined);
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/integrations?tab=requests']}>
      <AdminIntegrationsPage />
    </MemoryRouter>
  );

const cardOf = id =>
  screen
    .getAllByTestId('integration-request')
    .find(card => card.getAttribute('data-request') === id);

describe('Requests tab', () => {
  test('shows the open count on the tab and lists the open requests', async () => {
    const announced = jest.fn();
    window.addEventListener('admin:integration-requests-changed', e => announced(e.detail));
    renderPage();

    const tab = await screen.findByRole('tab', { name: /Requests/ });
    await waitFor(() => expect(tab).toHaveTextContent('2'));
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(announced).toHaveBeenCalledWith({ openCount: 2 });

    expect(await screen.findByRole('heading', { name: 'Open requests (3)' })).toBeInTheDocument();
    const alice = cardOf('ireq_a');
    expect(within(alice).getByText('For contracts')).toBeInTheDocument();
    expect(within(alice).getByText(/Requested by Alice/)).toBeInTheDocument();
    expect(within(alice).getByText('Open')).toBeInTheDocument();
    expect(within(cardOf('ireq_b')).getByText('Approved, not installed yet')).toBeInTheDocument();
    expect(within(cardOf('ireq_c')).getByRole('link', { name: 'hr-main' })).toHaveAttribute(
      'href',
      '/admin/integrations/hr-main'
    );
    expect(screen.getByText('Closed requests (1)')).toBeInTheDocument();
    expect(screen.getAllByTestId('closed-request')[0]).toHaveTextContent('Not licensed');
    expect(screen.queryByText(/MISSING:/)).toBeNull();
  });

  test('counts the open requests for internal websites on the tab too, as the sidebar badge does', async () => {
    mockWebsites.fetchWebsiteCorpusDomains.mockResolvedValue({
      items: [
        {
          id: 'wd_1',
          host: 'wiki.corp',
          status: 'requested',
          requesters: [
            { userId: 'u1', name: 'Alice', reason: 'sizing', at: '2026-11-01T10:00:00Z' }
          ],
          createdAt: '2026-11-01T10:00:00Z',
          updatedAt: '2026-11-01T10:00:00Z'
        }
      ],
      nextCursor: null,
      openCount: 1
    });
    renderPage();
    const tab = await screen.findByRole('tab', { name: /Requests/ });
    // 2 requests for integrations and 1 for a website, though no Website Corpus is installed.
    await waitFor(() => expect(tab).toHaveTextContent('3'));
    expect(await screen.findByText('wiki.corp')).toBeInTheDocument();
  });

  test('Approve approves and opens the install dialog for the definition', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Open requests (3)' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve the request of Alice for Docs' }));
    expect(await screen.findByTestId('install-dialog')).toHaveTextContent('com.example/docs');
    expect(mockApi.approveIntegrationRequest).toHaveBeenCalledWith('ireq_a');
  });

  test('an approved request offers Install without approving again', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Open requests (3)' });
    fireEvent.click(screen.getByRole('button', { name: 'Install CRM' }));
    expect(await screen.findByTestId('install-dialog')).toHaveTextContent('com.example/crm');
    expect(mockApi.approveIntegrationRequest).not.toHaveBeenCalled();
  });

  test('Decline asks for a note, then declines', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Open requests (3)' });
    fireEvent.click(screen.getByRole('button', { name: 'Decline the request of Alice for Docs' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Decline the request for Docs?')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Note to the requester (optional)'), {
      target: { value: ' Not licensed ' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(mockApi.declineIntegrationRequest).toHaveBeenCalledWith('ireq_a', {
        note: 'Not licensed',
        hide: false
      })
    );
    expect(await screen.findByText('Request for Docs declined.')).toBeInTheDocument();
    expect(mockApi.fetchIntegrationRequests).toHaveBeenCalledTimes(2);
  });

  test('Decline and hide says what it does, then hides', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Open requests (3)' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Decline the request of Alice for Docs and hide it' })
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('the other open requests for it are declined too');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline and hide' }));
    await waitFor(() =>
      expect(mockApi.declineIntegrationRequest).toHaveBeenCalledWith('ireq_a', {
        note: '',
        hide: true
      })
    );
    expect(
      await screen.findByText('Request declined; Docs is hidden from users.')
    ).toBeInTheDocument();
  });

  test('a hidden definition can be shown again', async () => {
    renderPage();
    const hidden = await screen.findByTestId('hidden-definition');
    expect(hidden).toHaveTextContent('Games');
    fireEvent.click(within(hidden).getByRole('button', { name: 'Show Games again' }));
    await waitFor(() =>
      expect(mockApi.showHiddenIntegration).toHaveBeenCalledWith('com.example/games')
    );
  });

  test('an empty queue says so', async () => {
    mockApi.fetchIntegrationRequests.mockResolvedValue({ requests: [], hidden: [], openCount: 0 });
    renderPage();
    expect(await screen.findByTestId('no-open-requests')).toHaveTextContent('No open requests.');
  });
});

describe('Admin sidebar', () => {
  test('shows the open requests next to Integrations and follows the page', async () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <AdminSidebar />
      </MemoryRouter>
    );
    const badges = await screen.findAllByTestId('nav-badge-integrations');
    expect(badges[0]).toHaveTextContent('2');
    expect(badges[0]).toHaveTextContent('2 open requests (integrations and websites)');

    announceIntegrationRequestCount(0);
    await waitFor(() => expect(screen.queryByTestId('nav-badge-integrations')).toBeNull());
  });
});
