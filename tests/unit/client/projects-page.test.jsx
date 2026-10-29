// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `/projects` (#1036, slice 5): lists the viewer's projects (owned, shared
 * with them, from their apps) with filters and search, creates a project
 * and moves on to its page, and respects the creation quota from
 * `GET /api/projects/_config`. The route itself is gated by the platform
 * config's `projects.userProjects` and a signed-in viewer.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mockApi = {
  fetchProjects: jest.fn(),
  fetchProjectsConfig: jest.fn(),
  createProject: jest.fn(),
  fetchProjectCatalog: jest.fn(),
  addCatalogProject: jest.fn(),
  removeCatalogProject: jest.fn()
};
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [], loading: false, error: null })
}));
jest.mock('../../../client/src/api', () => ({
  fetchProjects: (...args) => mockApi.fetchProjects(...args),
  fetchProjectList: (...args) =>
    Promise.resolve(mockApi.fetchProjects(...args)).then(items => ({ items, warnings: [] })),
  fetchProjectsConfig: (...args) => mockApi.fetchProjectsConfig(...args),
  createProject: (...args) => mockApi.createProject(...args),
  fetchProjectCatalog: (...args) => mockApi.fetchProjectCatalog(...args),
  addCatalogProject: (...args) => mockApi.addCatalogProject(...args),
  removeCatalogProject: (...args) => mockApi.removeCatalogProject(...args)
}));

let mockPlatform = { projects: { enabled: true, userProjects: true } };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatform, isLoading: false })
}));
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  useOptionalAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u_17', name: 'Dana' }
  })
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

const ProjectsPage = require('../../../client/src/features/projects/pages/ProjectsPage').default;
const {
  invalidateProjectsConfig,
  invalidateProjectsList,
  useProjectsRouteState
} = require('../../../client/src/features/projects/hooks/useProjects');

const CONFIG = {
  enabled: true,
  userProjects: { enabled: true, canCreate: true, canShare: true, maxProjects: 20, used: 1 },
  limits: { maxFiles: 25, maxFileBytes: 20971520, maxProjectBytes: 209715200 },
  kinds: [],
  upload: { available: true }
};
const PROJECTS = [
  {
    id: 'prj_mine',
    ownership: 'user',
    name: 'Case 2026-114',
    description: 'Tenancy dispute',
    usage: { items: 3, bytes: 1000 },
    members: [],
    role: 'owner',
    permissions: { isOwner: true, canEdit: true }
  },
  {
    id: 'prj_team',
    ownership: 'user',
    name: 'Team wiki',
    owner: { name: 'Ann' },
    usage: { items: 1, bytes: 10 },
    memberCount: 4,
    role: 'user',
    permissions: { isOwner: false, canUse: true }
  },
  {
    id: 'faq',
    ownership: 'admin',
    name: { en: 'FAQ' },
    usage: { items: 2, bytes: 10 },
    role: 'linked',
    permissions: { isOwner: false }
  }
];

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage(entry = '/projects') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ProjectsPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchProjects.mockResolvedValue(PROJECTS);
  mockApi.fetchProjectsConfig.mockResolvedValue(CONFIG);
  mockPlatform = { projects: { enabled: true, userProjects: true } };
  invalidateProjectsList();
  invalidateProjectsConfig();
});

describe('ProjectsPage', () => {
  test('lists owned and shared projects with filters, and not the ones admins created', async () => {
    renderPage();
    expect(await screen.findByText('Case 2026-114')).toBeInTheDocument();
    expect(screen.getByText('Team wiki')).toBeInTheDocument();
    // An admin project is linked to apps and managed by admins: no chat can start in it.
    expect(screen.queryByText('FAQ')).not.toBeInTheDocument();
    expect(screen.queryByText('From an app')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /From apps/ })).not.toBeInTheDocument();
    expect(screen.getByText('Owner: Ann')).toBeInTheDocument();
    expect(await screen.findByText('1 of 20 own projects')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Shared with me/ }));
    expect(screen.queryByText('Case 2026-114')).not.toBeInTheDocument();
    expect(screen.getByText('Team wiki')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'tenancy' } });
    expect(screen.getByText('Case 2026-114')).toBeInTheDocument();
    expect(screen.queryByText('Team wiki')).not.toBeInTheDocument();
  });

  test('lists an admin project the viewer added from the catalog, as shared with them', async () => {
    mockApi.fetchProjects.mockResolvedValue([
      ...PROJECTS,
      {
        id: 'policies',
        ownership: 'admin',
        name: { en: 'Company policies' },
        usage: { items: 5, bytes: 10 },
        role: 'catalog',
        subscribed: true,
        permissions: { isOwner: false, canUse: true }
      }
    ]);
    renderPage();
    expect(await screen.findByText('Company policies')).toBeInTheDocument();
    expect(screen.queryByText('FAQ')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Shared with me/ }));
    expect(screen.getByText('Company policies')).toBeInTheDocument();
    expect(screen.getByText('Team wiki')).toBeInTheDocument();
  });

  test('pages a long list of projects and starts again at the first page when searching', async () => {
    const many = Array.from({ length: 23 }, (_, index) => ({
      id: `prj_${index}`,
      ownership: 'user',
      name: `Project ${String(index).padStart(2, '0')}`,
      usage: { items: 0, bytes: 0 },
      members: [],
      role: 'owner',
      permissions: { isOwner: true, canEdit: true }
    }));
    mockApi.fetchProjects.mockResolvedValue(many);
    renderPage();

    expect(await screen.findByText('Project 00')).toBeInTheDocument();
    expect(screen.getByText('Project 09')).toBeInTheDocument();
    expect(screen.queryByText('Project 10')).not.toBeInTheDocument();
    expect(screen.getByText('Projects 1–10 of 23')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Project 10')).toBeInTheDocument();
    expect(screen.queryByText('Project 00')).not.toBeInTheDocument();

    // A search shortens the list and shows its first page.
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'Project 2' } });
    expect(screen.getByText('Project 20')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  test('creates a project and opens its page', async () => {
    mockApi.createProject.mockResolvedValue({ id: 'prj_new', name: 'Due diligence' });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await within(dialog).findByText('A name is required.')).toBeInTheDocument();
    expect(mockApi.createProject).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: ' Due diligence ' }
    });
    fireEvent.change(within(dialog).getByLabelText('Instructions'), {
      target: { value: 'Answer in German.' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    await waitFor(() =>
      expect(mockApi.createProject).toHaveBeenCalledWith({
        name: 'Due diligence',
        instructions: 'Answer in German.'
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/projects/prj_new')
    );
  });

  test('shows the message the previous page left once, and closes it', async () => {
    renderPage({ pathname: '/projects', state: { notice: '“Old case” now belongs to Ben.' } });
    expect(await screen.findByRole('status')).toHaveTextContent('“Old case” now belongs to Ben.');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('marks projects shared with everyone or published', async () => {
    mockApi.fetchProjects.mockResolvedValue([
      { ...PROJECTS[0], audience: { everyone: true, catalog: false } },
      { ...PROJECTS[1], role: 'catalog', audience: { everyone: false, catalog: true } }
    ]);
    renderPage();
    expect(await screen.findByText('Global')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('From the catalog')).toBeInTheDocument();
  });

  test('offers no catalog while it is off', async () => {
    renderPage();
    await screen.findByText('Case 2026-114');
    expect(screen.queryByRole('button', { name: 'Browse catalog' })).toBeNull();
  });

  test('adds a project from the catalog', async () => {
    mockApi.fetchProjectsConfig.mockResolvedValue({
      ...CONFIG,
      sharing: { allowCatalog: true }
    });
    mockApi.fetchProjectCatalog.mockResolvedValue({
      enabled: true,
      items: [
        {
          id: 'prj_docs',
          ownership: 'user',
          name: 'iHub knowledge',
          description: 'Curated delivery docs',
          owner: { name: 'Ann' },
          usage: { items: 12 },
          role: 'catalog',
          subscribed: false
        },
        { ...PROJECTS[0], subscribed: false },
        {
          id: 'company-faq',
          ownership: 'admin',
          name: { en: 'Company FAQ' },
          owner: null,
          usage: { items: 3 },
          role: 'catalog',
          subscribed: false
        }
      ]
    });
    mockApi.addCatalogProject.mockResolvedValue({ id: 'prj_docs', subscribed: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Browse catalog' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('iHub knowledge')).toBeInTheDocument();
    // A project of your own is in your list already.
    expect(within(dialog).getByText('In your projects')).toBeInTheDocument();
    // An admin project available to everyone is added to the list the same way.
    const faq = within(dialog).getByText('Company FAQ').closest('li');
    expect(faq).toHaveTextContent('From the administrators');
    mockApi.addCatalogProject.mockResolvedValueOnce({ id: 'company-faq', subscribed: true });
    fireEvent.click(within(faq).getByRole('button', { name: 'Add Company FAQ to my projects' }));
    await waitFor(() => expect(mockApi.addCatalogProject).toHaveBeenCalledWith('company-faq'));
    expect(
      await within(faq).findByRole('button', { name: 'Remove Company FAQ from my projects' })
    ).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Add iHub knowledge to my projects' })
    );
    await waitFor(() => expect(mockApi.addCatalogProject).toHaveBeenCalledWith('prj_docs'));
    expect(
      await within(dialog).findByRole('button', { name: 'Remove iHub knowledge from my projects' })
    ).toBeInTheDocument();
  });

  test('disables "New project" at the quota and hides it without the permission', async () => {
    mockApi.fetchProjectsConfig.mockResolvedValue({
      ...CONFIG,
      userProjects: { ...CONFIG.userProjects, used: 20 }
    });
    const { unmount } = renderPage();
    expect(await screen.findByRole('button', { name: 'New project' })).toBeDisabled();
    unmount();

    invalidateProjectsConfig();
    mockApi.fetchProjectsConfig.mockResolvedValue({
      ...CONFIG,
      userProjects: { ...CONFIG.userProjects, canCreate: false }
    });
    renderPage();
    expect(await screen.findByText('Case 2026-114')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });
});

describe('useProjectsRouteState', () => {
  function Probe() {
    return <span data-testid="state">{useProjectsRouteState()}</span>;
  }

  test('is ready only while user projects are on', () => {
    const { rerender } = render(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    mockPlatform = { projects: { enabled: true, userProjects: false } };
    rerender(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('unavailable');
    mockPlatform = {};
    rerender(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('unavailable');
  });
});
