// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder tier of projects (#3024): a smart collection is listed and opened
 * as a project.
 *
 * Read-only (iteration 1, and still the state wherever the caller is not the
 * owner or `_config.ifinder.writable` is off): the page shows the tier badge, the
 * documents and a way to chat with them, and none of the controls that change a
 * project. A list that could not include the collections says so.
 *
 * Managed (iteration 2): the owner, where writes are on, renames the collection
 * and adds and removes documents. The controls follow `permissions.canEdit` and
 * the capability, not a blanket: instructions, pins, members, catalog, delete,
 * share and the token estimate stay hidden.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  fetchProject: jest.fn(),
  fetchProjects: jest.fn(),
  fetchProjectWarnings: jest.fn(),
  fetchProjectsConfig: jest.fn(),
  fetchProjectCatalog: jest.fn(),
  fetchProjectItemText: jest.fn(),
  searchPickerIFinder: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  fetchProject: (...args) => mockApi.fetchProject(...args),
  fetchProjects: (...args) => mockApi.fetchProjects(...args),
  fetchProjectList: async (...args) => ({
    items: await mockApi.fetchProjects(...args),
    warnings: mockApi.fetchProjectWarnings() || []
  }),
  fetchProjectsConfig: (...args) => mockApi.fetchProjectsConfig(...args),
  fetchProjectCatalog: (...args) => mockApi.fetchProjectCatalog(...args),
  fetchProjectItemText: (...args) => mockApi.fetchProjectItemText(...args),
  fetchProjectChats: () => Promise.resolve({ items: [], nextCursor: null, total: 0 }),
  fetchPickerPages: () => Promise.resolve([]),
  searchPickerIFinder: (...args) => mockApi.searchPickerIFinder(...args),
  checkPickerUrl: () => Promise.resolve({}),
  previewPickerUrl: () => Promise.resolve({}),
  crawlPickerUrl: () => Promise.resolve({}),
  fetchPickerCloudProviders: () => Promise.resolve([]),
  estimateProjectTokens: jest.fn(),
  addProjectItem: jest.fn(),
  uploadProjectItem: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  deleteProjectItem: jest.fn(),
  createProject: jest.fn()
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({
    platformConfig: { projects: { enabled: true, userProjects: true } },
    isLoading: false
  })
}));
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  useOptionalAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u_42', name: 'Ann' }
  })
}));
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [{ id: 'chat', name: { en: 'Chat' } }], loading: false, error: null })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/AppChatStarter', () => ({
  __esModule: true,
  default: ({ app }) => <textarea aria-label={`Message ${app?.id}`} />
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

const ProjectPage = require('../../../client/src/features/projects/pages/ProjectPage').default;
const ProjectsPage = require('../../../client/src/features/projects/pages/ProjectsPage').default;
const ProjectTierBadge =
  require('../../../client/src/features/projects/components/ProjectTierBadge').default;
const {
  invalidateProjectsConfig,
  invalidateProjectsList
} = require('../../../client/src/features/projects/hooks/useProjects');
const { isIFinderProject } = require('../../../client/src/features/projects/utils/projectView');
const AnswerSourceBadge =
  require('../../../client/src/features/chat/components/AnswerSourceBadge').default;

const COLLECTION_ID = 'ifc_00000000-0000-4000-8000-000000000001';

const CONFIG = {
  enabled: true,
  userProjects: { enabled: true, canCreate: true, canShare: true, maxProjects: 20, used: 1 },
  limits: { maxFiles: 25, maxFileBytes: 20971520, maxProjectBytes: 209715200 },
  sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowCatalog: true },
  kinds: [{ id: 'url', name: { en: 'Web page (URL)' }, picker: { type: 'url' } }],
  upload: { available: true, accept: ['.pdf'], summary: 'PDF' },
  ifinder: { available: true, writable: false, maxDocuments: 200 }
};

const READ_ONLY_PERMISSIONS = {
  canUse: true,
  canEdit: false,
  canShare: false,
  canDelete: false,
  canTransfer: false,
  readsAllChats: false,
  canHoldChats: false,
  isOwner: true,
  readOnly: true
};

const COLLECTION = {
  id: COLLECTION_ID,
  ownership: 'user',
  tier: 'ifinder',
  readOnly: true,
  source: { type: 'smart-collection', collectionId: COLLECTION_ID.slice(4) },
  name: 'Contracts',
  description: 'Lease and NDA',
  instructions: '',
  owner: { id: 'u_42', name: 'Ann', active: true },
  memberCount: 0,
  usage: { items: 2, bytes: 0 },
  role: 'owner',
  permissions: READ_ONLY_PERMISSIONS,
  items: [
    {
      id: 'itm_a',
      kind: 'ifinder-document',
      name: 'Lease 2026',
      ref: { documentId: 'doc-a' },
      status: 'ready',
      pinned: false,
      provenance: { origin: 'linked', source: { site: 'iFinder' } }
    },
    {
      id: 'itm_b',
      kind: 'ifinder-document',
      name: 'doc-b',
      ref: { documentId: 'doc-b' },
      status: 'ready',
      pinned: false,
      provenance: { origin: 'linked', source: { site: 'iFinder' } }
    }
  ]
};

const LOCAL = {
  id: 'prj_mine',
  ownership: 'user',
  tier: 'ihub',
  name: 'Case 2026-114',
  usage: { items: 3, bytes: 1000 },
  memberCount: 2,
  members: [{ type: 'user', id: 'u_1', role: 'user' }],
  role: 'owner',
  permissions: { canUse: true, canEdit: true, canDelete: true, isOwner: true }
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/projects/${COLLECTION_ID}`]}>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/projects']}>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<div>project page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  const api = require('../../../client/src/api');
  for (const name of ['addProjectItem', 'updateProject', 'deleteProjectItem', 'createProject']) {
    api[name].mockReset();
  }
  mockApi.fetchProjectsConfig.mockResolvedValue(CONFIG);
  mockApi.fetchProjects.mockResolvedValue([]);
  mockApi.fetchProjectWarnings.mockReturnValue([]);
  mockApi.fetchProjectCatalog.mockResolvedValue({ enabled: false, items: [] });
  mockApi.fetchProject.mockResolvedValue(COLLECTION);
  invalidateProjectsList();
  invalidateProjectsConfig();
});

describe('isIFinderProject', () => {
  it('is decided by the namespaced id together with the tier', () => {
    expect(isIFinderProject(COLLECTION)).toBe(true);
    expect(isIFinderProject(LOCAL)).toBe(false);
    // A stored project cannot opt in by its tier, nor can an id alone.
    expect(isIFinderProject({ id: 'prj_x', tier: 'ifinder' })).toBe(false);
    expect(isIFinderProject({ id: COLLECTION_ID, tier: 'ihub' })).toBe(false);
    expect(isIFinderProject(null)).toBe(false);
    expect(isIFinderProject({})).toBe(false);
  });

  it('shows a badge for the iFinder tier only', () => {
    const { container, rerender } = render(<ProjectTierBadge project={LOCAL} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ProjectTierBadge project={COLLECTION} />);
    expect(screen.getByTestId('project-tier-badge')).toHaveTextContent('iFinder');
    expect(screen.getByTestId('project-tier-badge')).toHaveTextContent('read-only');
  });
});

describe('the project list', () => {
  it('marks a smart collection with the tier badge and a local project with its role', async () => {
    mockApi.fetchProjects.mockResolvedValue([COLLECTION, LOCAL]);
    renderList();
    const collection = (await screen.findByRole('link', { name: 'Contracts' })).closest('li');
    expect(within(collection).getByTestId('project-tier-badge')).toBeInTheDocument();
    expect(within(collection).queryByText('Owner')).not.toBeInTheDocument();
    expect(within(collection).queryByText(/members/)).not.toBeInTheDocument();
    expect(within(collection).getByText('2 items')).toBeInTheDocument();
    const local = screen.getByRole('link', { name: 'Case 2026-114' }).closest('li');
    expect(within(local).queryByTestId('project-tier-badge')).not.toBeInTheDocument();
    expect(within(local).getByText('Owner')).toBeInTheDocument();
    expect(screen.queryByTestId('projects-ifinder-warning')).not.toBeInTheDocument();
  });

  it('counts a collection under "Mine"', async () => {
    mockApi.fetchProjects.mockResolvedValue([COLLECTION, LOCAL]);
    renderList();
    await screen.findByRole('link', { name: 'Contracts' });
    expect(screen.getByRole('tab', { name: /Mine/ })).toHaveTextContent('(2)');
    fireEvent.click(screen.getByRole('tab', { name: /Mine/ }));
    expect(screen.getByRole('link', { name: 'Contracts' })).toBeInTheDocument();
  });

  it('says so when iFinder could not be asked, and still lists the local projects', async () => {
    mockApi.fetchProjects.mockResolvedValue([LOCAL]);
    mockApi.fetchProjectWarnings.mockReturnValue([
      { code: 'IFINDER_UNAVAILABLE', tier: 'ifinder' }
    ]);
    renderList();
    expect(await screen.findByRole('link', { name: 'Case 2026-114' })).toBeInTheDocument();
    const warning = screen.getByTestId('projects-ifinder-warning');
    expect(warning).toHaveTextContent(/iFinder smart collections could not be loaded/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('a smart collection opened as a project', () => {
  it('shows the tier, the read-only note, its documents and a way to chat with them', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Contracts' })).toBeInTheDocument();
    expect(screen.getByTestId('project-tier-badge')).toBeInTheDocument();
    expect(screen.getByTestId('project-ifinder-banner')).toHaveTextContent(
      /smart collection from iFinder/
    );
    // The documents, read-only: the name shown is the title (or the id when the user has none).
    expect(screen.getByText('Lease 2026')).toBeInTheDocument();
    expect(screen.getByText('doc-b')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Preview text' })).toHaveLength(2);
    // Its side panel says where it lives; the chat starts outside it, with it attached.
    expect(screen.getByTestId('project-ifinder-source')).toHaveTextContent(/stay in iFinder/);
    expect(screen.getByRole('textbox', { name: 'Message chat' })).toBeInTheDocument();
  });

  it('offers no control that changes the project where writes are off', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    for (const name of [
      /delete/i,
      /add documents/i,
      /edit/i,
      /rename/i,
      /share/i,
      /publish/i,
      /transfer/i,
      /remove/i,
      /refresh/i,
      /retry/i,
      /estimate/i,
      /upload/i,
      /leave/i,
      /catalog/i
    ]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // No pins, no selection, no instructions, no members, no usage against local limits.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /instructions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/chats in this project/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-read-only')).not.toBeInTheDocument();
  });

  it('sends no request that changes anything', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    const {
      estimateProjectTokens,
      addProjectItem,
      uploadProjectItem,
      updateProject,
      deleteProject
    } = require('../../../client/src/api');
    for (const call of [
      estimateProjectTokens,
      addProjectItem,
      uploadProjectItem,
      updateProject,
      deleteProject
    ]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('reads a document through the preview', async () => {
    mockApi.fetchProjectItemText.mockResolvedValue({ text: 'The deposit is returned.' });
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview text' })[0]);
    await waitFor(() =>
      expect(mockApi.fetchProjectItemText).toHaveBeenCalledWith(
        COLLECTION_ID,
        'itm_a',
        expect.anything()
      )
    );
    // No edit is offered in the preview of a read-only project.
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });
});

describe('the chat badge for a collection iFinder could not deliver', () => {
  const renderBadge = projects =>
    render(
      <MemoryRouter>
        <AnswerSourceBadge answerSource={{ sources: [] }} knowledgeScope={{ projects }} />
      </MemoryRouter>
    );

  it('says in amber which collection was not available, and why', () => {
    renderBadge([
      { id: COLLECTION_ID, name: 'Contracts', mode: 'unavailable', reason: 'IFINDER_UNAVAILABLE' }
    ]);
    const notice = screen.getByTestId('knowledge-scope-missing');
    expect(notice).toHaveTextContent('Contracts · not available');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice.getAttribute('title')).toMatch(/Contracts: iFinder could not be reached/);
    // Nothing is claimed as used: no "unavailable" inside a purple badge, no link to a page.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps the reached projects as they were and adds the notice beside them', () => {
    renderBadge([
      { id: 'prj_case', name: 'Case 2026-114', mode: 'loaded' },
      { id: COLLECTION_ID, name: 'Contracts', mode: 'unavailable', reason: 'IFINDER_UNAVAILABLE' }
    ]);
    expect(screen.getByRole('link', { name: 'Case 2026-114 · loaded in full' })).toHaveAttribute(
      'href',
      '/projects/prj_case'
    );
    expect(screen.getByTestId('knowledge-scope-missing')).toHaveTextContent(
      'Contracts · not available'
    );
  });

  it('names an unnamed iFinder collection generically, and counts several', () => {
    const { unmount } = renderBadge([
      { id: COLLECTION_ID, name: '', mode: 'unavailable', reason: 'IFINDER_UNAVAILABLE' }
    ]);
    expect(screen.getByTestId('knowledge-scope-missing')).toHaveTextContent(
      'iFinder collection · not available'
    );
    unmount();
    renderBadge([
      { id: COLLECTION_ID, name: 'A', mode: 'unavailable', reason: 'IFINDER_UNAVAILABLE' },
      { id: 'ifc_00000000-0000-4000-8000-000000000002', name: 'B', mode: 'unavailable' }
    ]);
    // The mock translator returns the key for a counted phrase.
    expect(screen.getByTestId('knowledge-scope-missing')).toHaveTextContent(
      'chatMessage.knowledgeScope.missing'
    );
  });

  it('shows no notice when every project was reached', () => {
    renderBadge([{ id: 'faq', name: 'FAQ', mode: 'searched' }]);
    expect(screen.queryByTestId('knowledge-scope-missing')).not.toBeInTheDocument();
  });
});

// --- iteration 2: manage the membership -----------------------------------------

const OWNER_PERMISSIONS = {
  ...READ_ONLY_PERMISSIONS,
  canEdit: true,
  readOnly: false
};
const MANAGED = { ...COLLECTION, readOnly: false, permissions: OWNER_PERMISSIONS };
const WRITABLE_CONFIG = {
  ...CONFIG,
  kinds: [
    ...CONFIG.kinds,
    {
      id: 'ifinder-document',
      name: { en: 'iFinder document' },
      picker: { type: 'ifinder', mode: 'document' }
    },
    { id: 'ifinder-query', name: { en: 'iFinder search' }, picker: { type: 'ifinder' } }
  ],
  ifinder: { available: true, writable: true, maxDocuments: 200 }
};

describe('a smart collection its owner manages', () => {
  const NOT_OFFERED = [/delete/i, /share/i, /publish/i, /transfer/i, /estimate/i, /upload/i];

  beforeEach(() => {
    mockApi.fetchProjectsConfig.mockResolvedValue(WRITABLE_CONFIG);
    mockApi.fetchProject.mockResolvedValue(MANAGED);
  });

  it('offers rename, add and remove, and still hides what does not apply', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    expect(screen.getByTestId('rename-collection-button')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add documents/i })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: /remove item/i })).toHaveLength(2);
    expect(screen.getByTestId('project-ifinder-banner')).toHaveTextContent(/never the document/);
    expect(screen.getByTestId('project-tier-badge')).not.toHaveTextContent('read-only');
    for (const name of NOT_OFFERED) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // Nothing of a stored project: no pins, no refresh or rename of a document, no
    // instructions, members or catalog.
    expect(screen.queryByRole('button', { name: /refresh|retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /instructions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/chats in this project/i)).not.toBeInTheDocument();
    // The documents count against iFinder's cap, and there is no storage bar.
    const usage = screen.getByTestId('project-usage');
    expect(usage).toHaveTextContent('2 of 200');
    expect(usage).not.toHaveTextContent(/storage/i);
    expect(screen.getByTestId('project-ifinder-source')).toHaveTextContent('2 of 200 documents');
  });

  it.each([
    [
      'writes are off on this installation',
      { ...WRITABLE_CONFIG, ifinder: { available: true, writable: false, maxDocuments: 200 } },
      MANAGED
    ],
    ['the caller is not the owner', WRITABLE_CONFIG, COLLECTION],
    [
      'the permission block says read-only',
      WRITABLE_CONFIG,
      { ...MANAGED, permissions: { ...OWNER_PERMISSIONS, readOnly: true } }
    ]
  ])('stays read-only when %s', async (_label, config, project) => {
    mockApi.fetchProjectsConfig.mockResolvedValue(config);
    mockApi.fetchProject.mockResolvedValue(project);
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    expect(screen.queryByTestId('rename-collection-button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add documents/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove item/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('project-tier-badge')).toHaveTextContent('read-only');
    expect(screen.getByTestId('project-ifinder-banner')).toHaveTextContent(/add, remove or rename/);
  });

  it('adds a document from the iFinder picker only, sends the reference alone, and reloads', async () => {
    const { addProjectItem } = require('../../../client/src/api');
    addProjectItem.mockResolvedValue({ item: { id: 'itm_c' } });
    mockApi.searchPickerIFinder.mockResolvedValue([
      { documentId: 'doc-c', title: 'Policy', mimeType: 'application/pdf' }
    ]);
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    fireEvent.click(screen.getByRole('button', { name: /add documents/i }));
    const dialog = await screen.findByRole('dialog');
    // One tab: the iFinder document. No upload, text, web page, cloud, search or project link.
    expect(
      within(dialog)
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual(['iFinder document']);
    expect(within(dialog).queryByLabelText(/pinned/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('project-usage')).toHaveTextContent('2 of 200');
    fireEvent.change(within(dialog).getByLabelText('Search iFinder'), {
      target: { value: 'policy' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /Policy/ }));
    mockApi.fetchProject.mockClear();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(addProjectItem).toHaveBeenCalledWith(COLLECTION_ID, {
        kind: 'ifinder-document',
        ref: { documentId: 'doc-c' }
      })
    );
    await waitFor(() => expect(mockApi.fetchProject).toHaveBeenCalled());
  });

  it('shows why an add was refused, in the dialog', async () => {
    const { addProjectItem } = require('../../../client/src/api');
    addProjectItem.mockRejectedValue(
      Object.assign(new Error('x'), {
        originalError: {
          response: {
            status: 413,
            data: {
              error: 'A smart collection holds at most 200 documents',
              details: { code: 'QUOTA_COLLECTION_DOCUMENTS', limit: 200, used: 200 }
            }
          }
        }
      })
    );
    mockApi.searchPickerIFinder.mockResolvedValue([{ documentId: 'doc-c', title: 'Policy' }]);
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    fireEvent.click(screen.getByRole('button', { name: /add documents/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Search iFinder'), { target: { value: 'p' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /Policy/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'at most 200 documents; this one already has 200'
    );
  });

  it('removes only the membership, and says the document stays', async () => {
    const { deleteProjectItem } = require('../../../client/src/api');
    deleteProjectItem.mockResolvedValue(undefined);
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    fireEvent.click(screen.getAllByRole('button', { name: /remove item/i })[0]);
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/The document stays in iFinder/);
    fireEvent.click(within(confirm).getByRole('button', { name: /remove item/i }));
    await waitFor(() => expect(deleteProjectItem).toHaveBeenCalledWith(COLLECTION_ID, 'itm_a'));
    // The project is read again afterwards.
    await waitFor(() => expect(mockApi.fetchProject.mock.calls.length).toBeGreaterThan(1));
  });

  it('shows the error of a failed remove, with the document still listed', async () => {
    const { deleteProjectItem } = require('../../../client/src/api');
    const error = Object.assign(new Error('iFinder reported an error'), {
      originalError: {
        response: {
          status: 502,
          data: {
            error: 'iFinder reported an error and nothing was changed',
            details: { code: 'IFINDER_WRITE_FAILED', outcome: 'none', not: ['doc-a'] }
          }
        }
      }
    });
    deleteProjectItem.mockRejectedValue(error);
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    fireEvent.click(screen.getAllByRole('button', { name: /remove item/i })[0]);
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /remove item/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was changed/);
    expect(screen.getByText('Lease 2026')).toBeInTheDocument();
  });

  it('renames with only the fields that changed', async () => {
    const { updateProject } = require('../../../client/src/api');
    updateProject.mockResolvedValue({ ...MANAGED, name: 'Contracts 2027' });
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    fireEvent.click(screen.getByTestId('rename-collection-button'));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: ' Contracts 2027 ' }
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith(COLLECTION_ID, { name: 'Contracts 2027' })
    );
    expect(updateProject.mock.calls[0][1]).not.toHaveProperty('description');
    expect(updateProject.mock.calls[0][1]).not.toHaveProperty('instructions');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Contracts 2027' })).toBeInTheDocument()
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('refuses an empty name without sending it', async () => {
    const { updateProject } = require('../../../client/src/api');
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    fireEvent.click(screen.getByTestId('rename-collection-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '   ' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/name is required/i);
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('keeps the add button off when the collection is full', async () => {
    mockApi.fetchProject.mockResolvedValue({ ...MANAGED, usage: { items: 200, bytes: 0 } });
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    expect(screen.getByRole('button', { name: /add documents/i })).toBeDisabled();
    expect(screen.getByTestId('project-usage')).toHaveTextContent('200 of 200');
  });

  it('keeps the add button off when the iFinder document kind is switched off', async () => {
    mockApi.fetchProjectsConfig.mockResolvedValue({
      ...WRITABLE_CONFIG,
      kinds: CONFIG.kinds
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Contracts' });
    expect(screen.queryByRole('button', { name: /add documents/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('rename-collection-button')).toBeInTheDocument();
  });
});

describe('creating a collection', () => {
  const openDialog = async config => {
    mockApi.fetchProjectsConfig.mockResolvedValue(config);
    mockApi.fetchProjects.mockResolvedValue([]);
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: /new project/i }));
    return screen.findByRole('dialog');
  };

  it('offers the tier only where collections can be changed', async () => {
    const dialog = await openDialog(CONFIG);
    expect(within(dialog).queryByTestId('create-project-tier')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Instructions')).toBeInTheDocument();
  });

  it('creates a smart collection with a name and a description, and no instructions', async () => {
    const { createProject } = require('../../../client/src/api');
    createProject.mockResolvedValue({ ...MANAGED, id: COLLECTION_ID });
    const dialog = await openDialog(WRITABLE_CONFIG);
    expect(within(dialog).getByLabelText(/^In iHub/)).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText(/^As an iFinder smart collection/));
    expect(within(dialog).queryByLabelText('Instructions')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Contracts ' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Lease and NDA' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create collection' }));
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        name: 'Contracts',
        description: 'Lease and NDA',
        tier: 'ifinder'
      })
    );
    expect(await screen.findByText('project page')).toBeInTheDocument();
  });

  it('creates a local project as before, whatever was typed under the other tier', async () => {
    const { createProject } = require('../../../client/src/api');
    createProject.mockResolvedValue({ ...LOCAL });
    const dialog = await openDialog(WRITABLE_CONFIG);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local' } });
    fireEvent.change(within(dialog).getByLabelText('Instructions'), {
      target: { value: 'Be brief' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({ name: 'Local', instructions: 'Be brief' })
    );
  });
});
