// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Projects list (#1036, successor of the sources page): renders the
 * admin projects with their items and the header statistics, toggles in bulk,
 * and refuses to delete a project that apps, workflows or agents still link.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  fetchAdminProjects: jest.fn(),
  fetchAdminProjectStats: jest.fn(),
  fetchAdminProjectKinds: jest.fn(),
  fetchAdminProjectDependencies: jest.fn(),
  deleteAdminProject: jest.fn(),
  toggleAdminProjects: jest.fn(),
  fetchProjectSettings: jest.fn(),
  saveProjectSettings: jest.fn()
};

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {}, refreshConfig: () => {} })
}));
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [], loading: false })
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminProjects: (...args) => mockApi.fetchAdminProjects(...args),
  fetchAdminProjectStats: (...args) => mockApi.fetchAdminProjectStats(...args),
  fetchAdminProjectKinds: (...args) => mockApi.fetchAdminProjectKinds(...args),
  fetchAdminProjectDependencies: (...args) => mockApi.fetchAdminProjectDependencies(...args),
  deleteAdminProject: (...args) => mockApi.deleteAdminProject(...args),
  toggleAdminProjects: (...args) => mockApi.toggleAdminProjects(...args),
  fetchProjectSettings: (...args) => mockApi.fetchProjectSettings(...args),
  saveProjectSettings: (...args) => mockApi.saveProjectSettings(...args),
  getAdminApiErrorMessage: err => err?.message ?? 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const AdminProjectsPage =
  require('../../../client/src/features/admin/pages/AdminProjectsPage').default;

const PROJECTS = [
  {
    id: 'handbook',
    name: { en: 'Employee handbook', de: 'Mitarbeiterhandbuch' },
    description: { en: 'Policies' },
    enabled: true,
    category: 'HR',
    tags: ['policy'],
    items: [
      { id: 'i1', kind: 'upload' },
      { id: 'i2', kind: 'upload' },
      { id: 'i3', kind: 'url' }
    ],
    updatedAt: '2026-10-01T10:00:00Z'
  },
  { id: 'website', name: { en: 'Website' }, enabled: false, tags: [], items: [] }
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/projects']}>
      <AdminProjectsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchAdminProjects.mockResolvedValue(PROJECTS);
  mockApi.fetchAdminProjectStats.mockResolvedValue({
    admin: { total: 2, enabled: 1, disabled: 1, byKind: {} },
    user: { total: 7, items: 12, bytes: 0, owners: 3 }
  });
  mockApi.fetchAdminProjectKinds.mockResolvedValue([
    { id: 'upload', name: { en: 'Upload' }, enabled: true },
    { id: 'url', name: { en: 'Web page (URL)' }, enabled: true }
  ]);
  mockApi.toggleAdminProjects.mockResolvedValue({ message: 'ok' });
  mockApi.deleteAdminProject.mockResolvedValue(undefined);
  mockApi.fetchProjectSettings.mockResolvedValue({
    sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowCatalog: false },
    tierPolicy: 'ihub'
  });
});

describe('AdminProjectsPage', () => {
  test('lists the projects with item kinds, category, tags and the statistics', async () => {
    renderPage();

    expect(await screen.findByText('Employee handbook')).toBeInTheDocument();
    expect(screen.getByText('Website')).toBeInTheDocument();
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(await screen.findByText(/Upload · 2/)).toBeInTheDocument();
    expect(screen.getByText(/Web page \(URL\) · 1/)).toBeInTheDocument();
    expect(screen.getByText('HR')).toBeInTheDocument();
    expect(screen.getByText('policy')).toBeInTheDocument();

    const stats = await screen.findByTestId('project-stats');
    expect(within(stats).getByText('User projects')).toBeInTheDocument();
    expect(within(stats).getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2 projects')).toBeInTheDocument();
  });

  test('merges only when two or more projects are selected', async () => {
    mockApi.fetchAdminProjectDependencies.mockResolvedValue([]);
    renderPage();
    await screen.findByText('Website');

    fireEvent.click(screen.getByLabelText('Select Website'));
    expect(screen.getByRole('button', { name: 'Merge…' })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Select Employee handbook'));
    const merge = screen.getByRole('button', { name: 'Merge…' });
    expect(merge).toBeEnabled();
    fireEvent.click(merge);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Merge projects', { selector: 'h2' })).toBeInTheDocument();
    // The project with the most items is the one that stays.
    expect(within(dialog).getByRole('radio', { name: /Employee handbook/ })).toBeChecked();
  });

  test('enables the selected projects in one request', async () => {
    renderPage();
    await screen.findByText('Website');

    fireEvent.click(screen.getByLabelText('Select Website'));
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() =>
      expect(mockApi.toggleAdminProjects).toHaveBeenCalledWith(['website'], true)
    );
  });

  test('refuses to delete a linked project and lists who links it', async () => {
    mockApi.fetchAdminProjectDependencies.mockResolvedValue([
      { type: 'app', id: 'hr-chat', name: 'HR chat' },
      { type: 'agent', id: 'onboarding', name: 'Onboarding agent' }
    ]);
    renderPage();
    await screen.findByText('Employee handbook');

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete project' })[0]);

    const list = await screen.findByTestId('project-dependencies');
    expect(within(list).getByText('HR chat')).toBeInTheDocument();
    expect(within(list).getByText('Onboarding agent')).toBeInTheDocument();
    expect(mockApi.fetchAdminProjectDependencies).toHaveBeenCalledWith('handbook');
    expect(mockApi.deleteAdminProject).not.toHaveBeenCalled();
  });

  test('deletes an unlinked project after confirmation', async () => {
    mockApi.fetchAdminProjectDependencies.mockResolvedValue([]);
    renderPage();
    await screen.findByText('Website');

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete project' })[1]);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockApi.deleteAdminProject).toHaveBeenCalledWith('website'));
    await waitFor(() => expect(screen.queryByText('Website')).not.toBeInTheDocument());
  });

  test('shows the dependency list when the server refuses the delete itself', async () => {
    mockApi.fetchAdminProjectDependencies.mockResolvedValue([]);
    mockApi.deleteAdminProject.mockRejectedValue(
      Object.assign(new Error('in use'), {
        response: {
          status: 400,
          data: {
            details: {
              code: 'PROJECT_IN_USE',
              dependencies: [{ type: 'workflow', id: 'review', name: 'Review flow' }]
            }
          }
        }
      })
    );
    renderPage();
    await screen.findByText('Website');

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete project' })[1]);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );

    expect(await screen.findByText('Review flow')).toBeInTheDocument();
    expect(screen.getByText('Website')).toBeInTheDocument();
  });
});

describe('AdminProjectsPage – sharing of user projects', () => {
  test('turns the catalog on and saves only on request', async () => {
    mockApi.saveProjectSettings.mockImplementation(async settings => settings);
    renderPage();
    const catalog = await screen.findByRole('checkbox', { name: /The project catalog/ });
    expect(catalog).not.toBeChecked();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.click(catalog);
    fireEvent.click(save);
    await waitFor(() =>
      expect(mockApi.saveProjectSettings).toHaveBeenCalledWith({
        sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowCatalog: true },
        tierPolicy: 'ihub'
      })
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  test('switches the tier policy to iFinder smart collections', async () => {
    mockApi.saveProjectSettings.mockImplementation(async settings => settings);
    renderPage();
    const ihub = await screen.findByRole('radio', { name: /iHub projects only/ });
    expect(ihub).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /iHub projects and iFinder smart/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockApi.saveProjectSettings).toHaveBeenCalledWith(
        expect.objectContaining({ tierPolicy: 'both' })
      )
    );
  });

  test('is not shown to a content admin', async () => {
    mockApi.fetchProjectSettings.mockRejectedValue(
      Object.assign(new Error('forbidden'), { response: { status: 403 } })
    );
    renderPage();
    await screen.findByTestId('project-stats');
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: /The project catalog/ })).toBeNull()
    );
  });
});
