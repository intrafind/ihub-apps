// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Enable All / Disable All (AI-B2): they toggle every app, model or prompt
 * for every user, so they ask first. The dialog states how many items change
 * and names them; Disable All on Models states the default-model consequence
 * the server applies (`models.js` clears `default` on every disabled model,
 * and `ensureStoredDefault` later promotes the first enabled chat model).
 * Cancel sends no write.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchAdminApps: jest.fn(),
  fetchAppIntegrationStatus: jest.fn(),
  toggleApps: jest.fn(),
  toggleModels: jest.fn(),
  makeAdminApiCall: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAppIntegrationStatus: (...args) => mockApi.fetchAppIntegrationStatus(...args),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args),
  reorderApps: jest.fn(),
  toggleApps: (...args) => mockApi.toggleApps(...args),
  toggleModels: (...args) => mockApi.toggleModels(...args)
}));
jest.mock('../../../client/src/api', () => ({
  fetchUIConfig: jest.fn().mockResolvedValue({})
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: jest.fn().mockResolvedValue({ items: [] })
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { admin: { pages: {} } } })
}));
jest.mock('../../../client/src/features/apps/components/AppDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/AppCreationWizard', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/AppTemplateSelector', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UploadConfigButton', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/ModelDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ModelImportDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useApiKeyStatus', () => ({
  __esModule: true,
  default: () => ({ statuses: {}, reload: () => {} })
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: (_name, fallback) => fallback })
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const AdminAppsPage = require('../../../client/src/features/admin/pages/AdminAppsPage').default;
const AdminModelsPage = require('../../../client/src/features/admin/pages/AdminModelsPage').default;
const {
  buildBulkToggleConfirm
} = require('../../../client/src/features/admin/utils/bulkToggleConfirm');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  });
});

beforeEach(() => {
  jest.clearAllMocks();
});

const app = (id, enabled) => ({ id, name: { en: `App ${id}` }, enabled });

describe('Apps: Enable All / Disable All', () => {
  async function renderApps(apps) {
    mockApi.fetchAdminApps.mockResolvedValue(apps);
    mockApi.fetchAppIntegrationStatus.mockResolvedValue({});
    render(
      <MemoryRouter>
        <AdminAppsPage />
      </MemoryRouter>
    );
    await screen.findByText(apps[0].name.en);
  }

  it('Enable All names the count and the disabled apps; Cancel sends nothing', async () => {
    await renderApps([app('a', true), app('b', false), app('c', false)]);
    fireEvent.click(screen.getByRole('button', { name: 'Enable All' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Enable all apps?' });
    expect(dialog).toHaveTextContent('2 of 3 apps are disabled now and will be enabled.');
    const names = within(dialog)
      .getAllByRole('listitem')
      .map(item => item.textContent);
    expect(names).toEqual(['App b', 'App c']);
    expect(mockApi.toggleApps).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockApi.toggleApps).not.toHaveBeenCalled();
  });

  it('Disable All toggles every app only after the confirm button', async () => {
    mockApi.toggleApps.mockResolvedValue({});
    await renderApps([app('a', true), app('b', true), app('c', false)]);
    fireEvent.click(screen.getByRole('button', { name: 'Disable All' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Disable all apps?' });
    expect(dialog).toHaveTextContent('2 of 3 apps are enabled now and will be disabled.');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disable All' }));
    });
    expect(mockApi.toggleApps).toHaveBeenCalledWith('*', false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('Models: Disable All', () => {
  const model = (id, extra = {}) => ({
    id,
    name: { en: `Model ${id}` },
    description: { en: '' },
    provider: 'openai',
    enabled: true,
    ...extra
  });

  async function renderModels(models) {
    mockApi.makeAdminApiCall.mockImplementation(async path => {
      if (path === '/admin/models') return { data: { items: models } };
      if (path === '/admin/providers') return { data: { items: [] } };
      return { data: {} };
    });
    render(
      <MemoryRouter initialEntries={['/admin/models']}>
        <AdminModelsPage />
      </MemoryRouter>
    );
    await screen.findByText(models[0].name.en);
  }

  it('states the count and the default-model consequence; Cancel sends no toggle', async () => {
    await renderModels([
      model('gpt', { default: true }),
      model('claude'),
      model('old', { enabled: false })
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'More model actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable All' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Disable all models?' });
    expect(dialog).toHaveTextContent('2 of 3 models are enabled now and will be disabled.');
    expect(dialog).toHaveTextContent(
      'The default model setting is cleared ("Model gpt" is the default now).'
    );
    expect(dialog).toHaveTextContent('the first chat model in the list becomes the default');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockApi.toggleModels).not.toHaveBeenCalled();
  });

  it('Enable All reloads the list, so the default the server chose shows', async () => {
    await renderModels([model('gpt', { enabled: false }), model('claude', { enabled: false })]);
    expect(screen.queryByText('Default')).not.toBeInTheDocument();
    // After enabling, the server has made "claude" the default.
    mockApi.makeAdminApiCall.mockImplementation(async path => {
      if (path === '/admin/models')
        return { data: { items: [model('gpt'), model('claude', { default: true })] } };
      if (path === '/admin/providers') return { data: { items: [] } };
      return { data: {} };
    });
    mockApi.toggleModels.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'More model actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable All' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Enable all models?' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Enable/ }));
    });
    expect(mockApi.toggleModels).toHaveBeenCalledWith('*', true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const claudeRow = (await screen.findByText('Model claude')).closest('tr');
    expect(within(claudeRow).getByText('Default')).toBeInTheDocument();
  });
});

describe('buildBulkToggleConfirm', () => {
  const t = mockI18n.t.bind(mockI18n);
  const getName = item => item.id;

  it('blocks a no-op instead of offering it', () => {
    const request = buildBulkToggleConfirm({
      items: [{ id: 'a', enabled: true }],
      enable: true,
      itemsLabel: 'prompts',
      getName,
      t
    });
    expect(request.blocked.reason).toBe('All 1 prompts are already enabled.');
  });

  it('lists at most five names, then "and N more"', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, enabled: false }));
    const request = buildBulkToggleConfirm({
      items,
      enable: true,
      itemsLabel: 'prompts',
      getName,
      t
    });
    expect(request.consequences).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'and 3 more']);
    expect(request.message).toBe(
      '8 of 8 prompts are disabled now and will be enabled. Users with access see them right away:'
    );
    expect(request.danger).toBe(false);
  });

  it('uses the singular for one item', () => {
    const request = buildBulkToggleConfirm({
      items: [
        { id: 'a', enabled: true },
        { id: 'b', enabled: false }
      ],
      enable: false,
      itemsLabel: 'prompts',
      getName,
      t
    });
    expect(request.message).toBe(
      '1 of 2 prompts is enabled now and will be disabled. Users lose access right away:'
    );
    expect(request.danger).toBe(true);
  });
});
