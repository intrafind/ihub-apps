// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Named, dependency-aware deletes:
 *   - AX-B14: deleting a registry names it; a registry iHub ships asks for its
 *     id to be typed (there is no "restore default"); Cancel deletes nothing.
 *   - IN-B3 (client part): deleting a credential lists the installed
 *     integrations that use it.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockAdminApi = {
  fetchMarketplaceRegistries: jest.fn(),
  deleteMarketplaceRegistry: jest.fn(),
  listCredentials: jest.fn(),
  deleteCredential: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchMarketplaceRegistries: (...a) => mockAdminApi.fetchMarketplaceRegistries(...a),
  deleteMarketplaceRegistry: (...a) => mockAdminApi.deleteMarketplaceRegistry(...a),
  refreshMarketplaceRegistry: jest.fn(),
  updateMarketplaceRegistry: jest.fn(),
  listCredentials: (...a) => mockAdminApi.listCredentials(...a),
  createCredential: jest.fn(),
  updateCredential: jest.fn(),
  deleteCredential: (...a) => mockAdminApi.deleteCredential(...a),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
const mockFetchInstalled = jest.fn();
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...a) => mockFetchInstalled(...a)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/marketplace/RegistryFormDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const AdminMarketplaceRegistriesPage =
  require('../../../client/src/features/admin/pages/AdminMarketplaceRegistriesPage').default;
const AdminCredentialsPage =
  require('../../../client/src/features/admin/pages/AdminCredentialsPage').default;
const {
  SHIPPED_REGISTRY_IDS
} = require('../../../client/src/features/admin/utils/shippedRegistries');
const {
  installationsUsingCredential
} = require('../../../client/src/features/admin/utils/credentialUsage');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registry delete (AX-B14)', () => {
  const OFFICIAL = { id: 'ihub-official', name: 'iHub Official Marketplace', enabled: true };
  const TEAM = { id: 'team-catalog', name: 'Team catalog', enabled: true };

  async function renderPage() {
    mockAdminApi.fetchMarketplaceRegistries.mockResolvedValue([OFFICIAL, TEAM]);
    mockAdminApi.deleteMarketplaceRegistry.mockResolvedValue({});
    render(
      <MemoryRouter>
        <AdminMarketplaceRegistriesPage />
      </MemoryRouter>
    );
    await screen.findByText(OFFICIAL.name);
  }

  const deleteButtonOf = name =>
    within(screen.getByText(name).closest('tr')).getByRole('button', { name: 'Delete' });

  it('keeps the client list of shipped registries in sync with the server defaults', () => {
    const defaults = require('../../../server/defaults/config/registries.json');
    expect([...SHIPPED_REGISTRY_IDS].sort()).toEqual(defaults.registries.map(r => r.id).sort());
  });

  it('names the shipped registry and asks for its id; Cancel and Escape delete nothing', async () => {
    await renderPage();
    fireEvent.click(deleteButtonOf(OFFICIAL.name));
    const dialog = screen.getByRole('alertdialog', {
      name: 'Delete registry "iHub Official Marketplace"?'
    });
    expect(dialog).toHaveTextContent('This registry ships with iHub.');
    expect(within(dialog).getByRole('textbox')).toHaveFocus();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(mockAdminApi.deleteMarketplaceRegistry).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(deleteButtonOf(OFFICIAL.name));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockAdminApi.deleteMarketplaceRegistry).not.toHaveBeenCalled();
  });

  it('deletes the shipped registry once its id is typed', async () => {
    await renderPage();
    fireEvent.click(deleteButtonOf(OFFICIAL.name));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'ihub-official' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(mockAdminApi.deleteMarketplaceRegistry).toHaveBeenCalledWith('ihub-official');
  });

  it('asks a named confirmation without typing for another registry', async () => {
    await renderPage();
    fireEvent.click(deleteButtonOf(TEAM.name));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete registry "Team catalog"?' });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(mockAdminApi.deleteMarketplaceRegistry).toHaveBeenCalledWith('team-catalog');
  });
});

describe('credential delete (IN-B3, client part)', () => {
  const INSTALLED = [
    {
      id: 'brave',
      label: 'Brave Search',
      auth: { mode: 'none' },
      values: { apiKeyRef: 'brave-key' }
    },
    {
      id: 'jira',
      label: 'Jira',
      auth: { mode: 'service-account', credentialRef: 'brave-key' },
      values: {}
    },
    { id: 'other', label: 'Other', values: { nested: { list: ['not-brave-key'] } } }
  ];

  it('finds installations by managed secret and by a stored value', () => {
    expect(installationsUsingCredential(INSTALLED, 'brave-key')).toEqual([
      { id: 'brave', label: 'Brave Search' },
      { id: 'jira', label: 'Jira' }
    ]);
    expect(installationsUsingCredential(INSTALLED, 'unused')).toEqual([]);
    expect(installationsUsingCredential(null, 'brave-key')).toEqual([]);
  });

  it('lists the installations that use the credential in the dialog', async () => {
    mockAdminApi.listCredentials.mockResolvedValue([
      { id: 'brave-key', name: 'Brave key', type: 'secret' }
    ]);
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    render(<AdminCredentialsPage />);
    const remove = await screen.findByRole('button', { name: 'Delete credential "brave-key"' });
    await act(async () => {
      fireEvent.click(remove);
    });

    const dialog = screen.getByRole('alertdialog', { name: 'Delete credential "brave-key"?' });
    expect(dialog).toHaveTextContent('Used by 2 installed integrations, which stop working:');
    const items = within(dialog)
      .getAllByRole('listitem')
      .map(item => item.textContent);
    expect(items.slice(0, 2)).toEqual(['Brave Search', 'Jira']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mockAdminApi.deleteCredential).not.toHaveBeenCalled();
  });

  it('says so when it cannot check, and still allows the delete', async () => {
    mockAdminApi.listCredentials.mockResolvedValue([{ id: 'k1', name: 'Key', type: 'secret' }]);
    mockFetchInstalled.mockRejectedValue(new Error('offline'));
    mockAdminApi.deleteCredential.mockResolvedValue({});
    render(<AdminCredentialsPage />);
    const remove = await screen.findByRole('button', { name: 'Delete credential "k1"' });
    await act(async () => {
      fireEvent.click(remove);
    });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Couldn\'t check which integrations use "k1".');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(mockAdminApi.deleteCredential).toHaveBeenCalledWith('k1');
  });
});
