// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * List noise on the admin Apps and Prompts lists (AI-B22, AI-B18):
 *
 * - one "All Categories" chip, even when `ui.json` lists an "All" entry of its own;
 * - an item without a category shows the category the filter (and the end-user
 *   list) counts it under, not "N/A";
 * - an app without a preferred model says it runs on the default model;
 * - a prompt linked to an app that does not exist says the app is missing,
 *   instead of a check mark;
 * - the Prompts tabs are a real tab list.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchAdminApps: jest.fn(),
  fetchAdminPrompts: jest.fn(),
  fetchAppIntegrationStatus: jest.fn(),
  fetchUIConfig: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAdminPrompts: (...args) => mockApi.fetchAdminPrompts(...args),
  fetchAppIntegrationStatus: (...args) => mockApi.fetchAppIntegrationStatus(...args),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: jest.fn().mockResolvedValue({ data: {} }),
  reorderApps: jest.fn(),
  toggleApps: jest.fn(),
  togglePrompts: jest.fn()
}));
jest.mock('../../../client/src/api', () => ({
  fetchUIConfig: (...args) => mockApi.fetchUIConfig(...args)
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: jest.fn().mockResolvedValue({ items: [] })
}));
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
jest.mock('../../../client/src/features/prompts/components/PromptDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UploadConfigButton', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminUserPromptsTab', () => ({
  __esModule: true,
  default: () => <div>user prompts tab</div>
}));
jest.mock('../../../client/src/features/admin/components/GlobalPromptVariablesEditor', () => ({
  __esModule: true,
  default: () => <div>variables editor</div>
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
const AdminPromptsPage =
  require('../../../client/src/features/admin/pages/AdminPromptsPage').default;

const categories = [
  { id: 'all', name: { en: 'All' }, color: '#000' },
  { id: 'utility', name: { en: 'Utility' }, color: '#111' },
  { id: 'creative', name: { en: 'Creative' }, color: '#222' }
];

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchAppIntegrationStatus.mockResolvedValue({});
  mockApi.fetchUIConfig.mockResolvedValue({
    appsList: { categories: { enabled: true, list: categories } },
    promptsList: { categories: { enabled: true, list: categories } }
  });
});

const rowOf = async name => (await screen.findByText(name)).closest('tr');

describe('Apps list', () => {
  async function renderApps() {
    mockApi.fetchAdminApps.mockResolvedValue([
      { id: 'plain', name: { en: 'Plain app' }, enabled: true, order: 1 },
      {
        id: 'tuned',
        name: { en: 'Tuned app' },
        enabled: true,
        category: 'creative',
        preferredModel: 'gpt-x',
        order: 2
      }
    ]);
    render(
      <MemoryRouter initialEntries={['/admin/apps']}>
        <AdminAppsPage />
      </MemoryRouter>
    );
    await screen.findByText('Plain app');
    await screen.findByRole('button', { name: 'All Categories' });
  }

  it('offers one "All" chip, not the page chip plus the ui.json entry', async () => {
    await renderApps();
    expect(screen.getByRole('button', { name: 'All Categories' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Utility' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('shows the category the filter counts an app under, not "N/A"', async () => {
    await renderApps();
    const plain = await rowOf('Plain app');
    expect(within(plain).getByText('Utility')).toBeInTheDocument();
    expect(within(plain).queryByText('N/A')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Utility' }));
    expect(await screen.findByText('Plain app')).toBeInTheDocument();
    expect(screen.queryByText('Tuned app')).not.toBeInTheDocument();
  });

  it('an app without a preferred model runs on the default model', async () => {
    await renderApps();
    expect(within(await rowOf('Plain app')).getByText('Default model')).toBeInTheDocument();
    expect(within(await rowOf('Tuned app')).getByText('gpt-x')).toBeInTheDocument();
  });
});

describe('Prompts list', () => {
  async function renderPrompts({ apps = [{ id: 'faq', name: { en: 'FAQ' } }] } = {}) {
    mockApi.fetchAdminPrompts.mockResolvedValue([
      { id: 'linked', name: { en: 'Linked prompt' }, prompt: { en: 'x' }, appId: 'faq' },
      { id: 'dangling', name: { en: 'Dangling prompt' }, prompt: { en: 'x' }, appId: 'gone' },
      { id: 'loose', name: { en: 'Loose prompt' }, prompt: { en: 'x' } }
    ]);
    mockApi.fetchAdminApps.mockResolvedValue(apps);
    render(
      <MemoryRouter initialEntries={['/admin/prompts']}>
        <AdminPromptsPage />
      </MemoryRouter>
    );
    await screen.findByText('Linked prompt');
  }

  it('the tabs are a tab list with the active tab selected', async () => {
    await renderPrompts();
    const tablist = screen.getByRole('tablist', { name: 'Prompt sections' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['Prompts', 'User prompts', 'Variables']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-prompts');

    fireEvent.click(tabs[2]);
    expect(screen.getByRole('tab', { name: 'Variables' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-variables');
  });

  it('offers one "All" chip and shows the fallback category of a prompt without one', async () => {
    await renderPrompts();
    await screen.findByRole('button', { name: 'All Categories' });
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    expect(within(await rowOf('Loose prompt')).getByText('Creative')).toBeInTheDocument();
  });

  it('names the linked app, and says so when it does not exist', async () => {
    await renderPrompts();
    expect(within(await rowOf('Linked prompt')).getByText('FAQ')).toBeInTheDocument();
    const dangling = await rowOf('Dangling prompt');
    expect(await within(dangling).findByText('Missing app: gone')).toBeInTheDocument();
    expect(within(await rowOf('Loose prompt')).queryByTestId('prompt-app-missing')).toBeNull();
  });

  it('without the app list the linked ID shows without a verdict', async () => {
    mockApi.fetchAdminApps.mockRejectedValue(new Error('no apps'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockApi.fetchAdminPrompts.mockResolvedValue([
      { id: 'dangling', name: { en: 'Dangling prompt' }, prompt: { en: 'x' }, appId: 'gone' }
    ]);
    render(
      <MemoryRouter initialEntries={['/admin/prompts']}>
        <AdminPromptsPage />
      </MemoryRouter>
    );
    const row = await rowOf('Dangling prompt');
    expect(within(row).getByText('gone')).toBeInTheDocument();
    expect(within(row).queryByTestId('prompt-app-missing')).toBeNull();
    console.error.mockRestore();
  });
});
