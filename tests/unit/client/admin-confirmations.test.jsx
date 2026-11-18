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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockAdminApi = {
  fetchMarketplaceRegistries: jest.fn(),
  deleteMarketplaceRegistry: jest.fn(),
  listCredentials: jest.fn(),
  deleteCredential: jest.fn(),
  fetchAdminSkills: jest.fn(),
  deleteSkill: jest.fn(),
  toggleSkill: jest.fn(),
  makeAdminApiCall: jest.fn()
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
  fetchAdminSkills: (...a) => mockAdminApi.fetchAdminSkills(...a),
  deleteSkill: (...a) => mockAdminApi.deleteSkill(...a),
  toggleSkill: (...a) => mockAdminApi.toggleSkill(...a),
  exportSkill: jest.fn(),
  importSkill: jest.fn(),
  makeAdminApiCall: (...a) => mockAdminApi.makeAdminApiCall(...a),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
const mockFetchInstalled = jest.fn();
const mockFetchDefinition = jest.fn();
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...a) => mockFetchInstalled(...a),
  fetchIntegrationDefinition: (...a) => mockFetchDefinition(...a)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/marketplace/RegistryFormDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminUserSkillsTab', () => ({
  __esModule: true,
  default: () => null
}));
// runtimeBasePath reads import.meta, which jest can't load.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildUploadUrl: path => path
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
const AdminSkillsPage = require('../../../client/src/features/admin/pages/AdminSkillsPage').default;
const AssetManager = require('../../../client/src/features/admin/components/AssetManager').default;
const { enT } = require('./helpers/i18nMock');
const {
  SHIPPED_REGISTRY_IDS
} = require('../../../client/src/features/admin/utils/shippedRegistries');
const {
  credentialFieldsByDefinition,
  installationsUsingCredential
} = require('../../../client/src/features/admin/utils/credentialUsage');

beforeEach(() => {
  jest.clearAllMocks();
  // Definitions unknown by default: credential fields fall back to the `…Ref` names.
  mockFetchDefinition.mockRejectedValue(new Error('not loaded'));
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

  it('after the delete, focus moves to the page heading (the row is gone)', async () => {
    await renderPage();
    mockAdminApi.fetchMarketplaceRegistries.mockResolvedValue([OFFICIAL]);
    const trigger = deleteButtonOf(TEAM.name);
    trigger.focus();
    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
      );
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await act(async () => {});
    expect(screen.queryByText(TEAM.name)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Marketplace Registries' })).toHaveFocus();
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
    { id: 'other', label: 'Other', values: { nested: { list: ['not-brave-key'] } } },
    // A plain value equal to the id is not a reference; only `…Ref` fields are.
    { id: 'plain', label: 'Plain', values: { product: 'brave-key', list: ['brave-key'] } }
  ];

  it('finds installations by managed secret and by a credential field', () => {
    expect(installationsUsingCredential(INSTALLED, 'brave-key')).toEqual([
      { id: 'brave', label: 'Brave Search' },
      { id: 'jira', label: 'Jira' }
    ]);
    expect(installationsUsingCredential(INSTALLED, 'unused')).toEqual([]);
    expect(installationsUsingCredential(null, 'brave-key')).toEqual([]);
  });

  it("uses the definition's credential fields where the definition is known", async () => {
    const installed = [
      // `token` is a credential field by its definition, though not named `…Ref`.
      { id: 'a', label: 'A', definition: 'def-a', values: { token: 'k' } },
      // `productRef` is not a credential field in its definition.
      { id: 'b', label: 'B', definition: 'def-b', values: { productRef: 'k' } },
      // Definition could not be loaded: the name convention still finds it.
      { id: 'c', label: 'C', definition: 'def-gone', values: { apiKeyRef: 'k' } }
    ];
    const definitions = {
      'def-a': { install: [{ key: 'token', type: 'credential' }] },
      'def-b': { install: [{ key: 'productRef', type: 'string' }] }
    };
    const fetchDefinition = jest.fn(async id => {
      if (!definitions[id]) throw new Error('404');
      return definitions[id];
    });
    const fields = await credentialFieldsByDefinition(installed, fetchDefinition);
    expect(fetchDefinition).toHaveBeenCalledTimes(3);
    expect(installationsUsingCredential(installed, 'k', fields)).toEqual([
      { id: 'a', label: 'A' },
      { id: 'c', label: 'C' }
    ]);
  });

  it('the dialog lists an installation by a credential field its definition declares', async () => {
    mockAdminApi.listCredentials.mockResolvedValue([{ id: 'k', name: 'Key', type: 'secret' }]);
    mockFetchInstalled.mockResolvedValue({
      items: [{ id: 'ldap', label: 'Directory', definition: 'ldap', values: { bindSecret: 'k' } }]
    });
    mockFetchDefinition.mockResolvedValue({
      install: [{ key: 'bindSecret', type: 'credential' }]
    });
    render(<AdminCredentialsPage />);
    const remove = await screen.findByRole('button', { name: 'Delete credential "k"' });
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(mockFetchDefinition).toHaveBeenCalledWith('ldap');
    const dialog = screen.getByRole('alertdialog', { name: 'Delete credential "k"?' });
    expect(dialog).toHaveTextContent('Used by 1 installed integration, which stops working:');
    expect(dialog).toHaveTextContent('Directory');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('says the check is incomplete when a definition cannot be read', async () => {
    mockAdminApi.listCredentials.mockResolvedValue([{ id: 'k', name: 'Key', type: 'secret' }]);
    // `apiKey` is a credential field, but its definition fails to load, so the
    // name rule cannot see it: the dialog must not claim nothing uses `k`.
    mockFetchInstalled.mockResolvedValue({
      items: [{ id: 'svc', label: 'Search service', definition: 'gone', values: { apiKey: 'k' } }]
    });
    mockFetchDefinition.mockRejectedValue(new Error('404'));
    render(<AdminCredentialsPage />);
    const remove = await screen.findByRole('button', { name: 'Delete credential "k"' });
    await act(async () => {
      fireEvent.click(remove);
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Delete credential "k"?' });
    expect(dialog).not.toHaveTextContent('No installed integration uses it.');
    expect(dialog).toHaveTextContent(
      'Couldn\'t fully check which integrations use "k": 1 installed integrations could not be read.'
    );
    expect(dialog).toHaveTextContent('Search service');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
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

  it('keeps the busy dialog mounted while the list reloads, then focuses the heading', async () => {
    let finishReload;
    mockAdminApi.listCredentials
      .mockResolvedValueOnce([{ id: 'k1', name: 'Key', type: 'secret' }])
      .mockImplementationOnce(() => new Promise(resolve => (finishReload = resolve)));
    mockFetchInstalled.mockResolvedValue({ items: [] });
    mockAdminApi.deleteCredential.mockResolvedValue({});
    render(<AdminCredentialsPage />);
    const remove = await screen.findByRole('button', { name: 'Delete credential "k1"' });
    await act(async () => {
      fireEvent.click(remove);
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Delete credential "k1"?' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    // The reload is still running: the page (and the busy dialog) stay.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Credentials' })).toBeInTheDocument();
    await act(async () => {
      finishReload([]);
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Credentials' })).toHaveFocus();
  });

  it('ignores a second Delete click while the first usage check runs', async () => {
    let finishCheck;
    mockAdminApi.listCredentials.mockResolvedValue([
      { id: 'a', name: 'A', type: 'secret' },
      { id: 'b', name: 'B', type: 'secret' }
    ]);
    mockFetchInstalled.mockImplementation(() => new Promise(resolve => (finishCheck = resolve)));
    render(<AdminCredentialsPage />);
    const deleteA = await screen.findByRole('button', { name: 'Delete credential "a"' });
    const deleteB = screen.getByRole('button', { name: 'Delete credential "b"' });
    fireEvent.click(deleteA);
    expect(deleteA).toHaveAttribute('aria-busy', 'true');
    expect(deleteB).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(deleteB);
    expect(mockFetchInstalled).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishCheck({ items: [] });
    });
    expect(screen.getByRole('alertdialog', { name: 'Delete credential "a"?' })).toBeInTheDocument();
    expect(deleteB).not.toHaveAttribute('aria-disabled');
  });
});

/**
 * A confirmed delete reloads the list without the first-load spinner, so the
 * busy dialog and the status line (role=status) stay mounted and the success
 * announcement is not lost.
 */
describe('delete keeps the page mounted while the list reloads', () => {
  it('skills: the list stays, the notice is announced and focus moves to the heading', async () => {
    let finishReload;
    mockAdminApi.fetchAdminSkills
      .mockResolvedValueOnce([
        { name: 's1', displayName: 'Skill one' },
        { name: 's2', displayName: 'Skill two' }
      ])
      .mockImplementationOnce(() => new Promise(resolve => (finishReload = resolve)));
    mockAdminApi.deleteSkill.mockResolvedValue({});
    render(
      <MemoryRouter>
        <AdminSkillsPage />
      </MemoryRouter>
    );
    const row = (await screen.findByText('Skill one')).closest('tr');
    await act(async () => {
      fireEvent.click(within(row).getByTitle('Delete'));
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Delete skill "s1"?' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(mockAdminApi.deleteSkill).toHaveBeenCalledWith('s1');
    // Reload running: the busy dialog and the list are still there.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Skill two')).toBeInTheDocument();
    await act(async () => {
      finishReload([{ name: 's2', displayName: 'Skill two' }]);
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Skill "s1" deleted.');
    expect(screen.getByText('Skill two')).toBeInTheDocument();
    expect(screen.queryByText('Skill one')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Skill Management' })).toHaveFocus();
  });

  it('assets: the busy dialog and the list stay while the list reloads', async () => {
    const ASSET = {
      id: 'a1',
      originalName: 'logo.svg',
      filename: 'a1.svg',
      mimetype: 'image/svg+xml',
      assetType: 'icon',
      size: 10,
      publicUrl: '/uploads/assets/a1.svg'
    };
    let finishReload;
    mockAdminApi.makeAdminApiCall.mockImplementation((url, options) => {
      if (options?.method === 'DELETE') return Promise.resolve({ data: {} });
      if (mockAdminApi.makeAdminApiCall.mock.calls.length === 1) {
        return Promise.resolve({ data: { items: [ASSET] } });
      }
      return new Promise(resolve => (finishReload = resolve));
    });
    render(<AssetManager t={enT} />);
    const remove = await screen.findByTitle('Delete asset');
    await act(async () => {
      fireEvent.click(remove);
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Delete asset "logo.svg"?' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText('Loading assets...')).not.toBeInTheDocument();
    await act(async () => {
      finishReload({ data: { items: [] } });
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByText('Asset deleted successfully')).toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Asset Management' })).toHaveFocus();
  });
});

describe('skills: overlapping reloads', () => {
  it('a reload that answers after a newer one does not overwrite the list', async () => {
    const reloads = [];
    mockAdminApi.fetchAdminSkills
      .mockResolvedValueOnce([
        { name: 's1', displayName: 'Skill one', enabled: true },
        { name: 's2', displayName: 'Skill two', enabled: true }
      ])
      .mockImplementation(() => new Promise(resolve => reloads.push(resolve)));
    mockAdminApi.toggleSkill.mockResolvedValue({});
    render(
      <MemoryRouter>
        <AdminSkillsPage />
      </MemoryRouter>
    );
    const rowOne = (await screen.findByText('Skill one')).closest('tr');
    const rowTwo = screen.getByText('Skill two').closest('tr');
    await act(async () => {
      fireEvent.click(within(rowOne).getByTitle('Disable'));
    });
    await act(async () => {
      fireEvent.click(within(rowTwo).getByTitle('Disable'));
    });
    expect(reloads).toHaveLength(2);

    // The newer reload answers first, then the older one with its stale list.
    await act(async () => {
      reloads[1]([
        { name: 's1', displayName: 'Skill one', enabled: false },
        { name: 's2', displayName: 'Skill two', enabled: false }
      ]);
    });
    await act(async () => {
      reloads[0]([
        { name: 's1', displayName: 'Skill one', enabled: false },
        { name: 's2', displayName: 'Skill two', enabled: true }
      ]);
    });
    const rowTwoAfter = screen.getByText('Skill two').closest('tr');
    expect(within(rowTwoAfter).getByTitle('Enable')).toBeInTheDocument();
  });
});
