// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `/projects/:projectId` (#1036, slice 5): the owner edits the settings
 * (only what changed is sent), sees each item's status with the spec's
 * messages and the provenance of picked items, uploads several files (one
 * request each), pins, and deletes with confirmation; a *user* member sees
 * everything read-only; an editor listed by name may leave; a project whose
 * owner is gone shows the read-only banner; the chat list filters to "mine".
 */
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

const mockApi = {
  fetchProject: jest.fn(),
  fetchProjects: jest.fn(),
  fetchProjectsConfig: jest.fn(),
  fetchProjectChats: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  updateProjectItem: jest.fn(),
  refreshProjectItem: jest.fn(),
  deleteProjectItem: jest.fn(),
  addProjectItem: jest.fn(),
  uploadProjectItem: jest.fn(),
  fetchProjectItemText: jest.fn(),
  fetchPickerPages: jest.fn(),
  searchPickerIFinder: jest.fn(),
  checkPickerUrl: jest.fn(),
  fetchPickerCloudProviders: jest.fn(),
  updateProjectMembers: jest.fn(),
  fetchProjectShareTargets: jest.fn(),
  transferProject: jest.fn()
};
jest.mock('../../../client/src/api', () =>
  Object.fromEntries(
    [
      'fetchProject',
      'fetchProjects',
      'fetchProjectsConfig',
      'fetchProjectChats',
      'updateProject',
      'deleteProject',
      'updateProjectItem',
      'refreshProjectItem',
      'deleteProjectItem',
      'addProjectItem',
      'uploadProjectItem',
      'fetchProjectItemText',
      'fetchPickerPages',
      'searchPickerIFinder',
      'checkPickerUrl',
      'fetchPickerCloudProviders',
      'updateProjectMembers',
      'fetchProjectShareTargets',
      'transferProject'
    ].map(name => [name, (...args) => mockApi[name](...args)])
  )
);
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

const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en-GB' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const ProjectPage = require('../../../client/src/features/projects/pages/ProjectPage').default;
const ProjectSettingsCard =
  require('../../../client/src/features/projects/components/ProjectSettingsCard').default;
const {
  invalidateProjectsConfig,
  invalidateProjectsList,
  useMyProjects
} = require('../../../client/src/features/projects/hooks/useProjects');

const CONFIG = {
  enabled: true,
  userProjects: { enabled: true, canCreate: true, canShare: true, maxProjects: 20, used: 1 },
  limits: { maxFiles: 25, maxFileBytes: 20971520, maxProjectBytes: 209715200 },
  sharing: { allowUsers: true, allowGroups: true, allowEveryone: false },
  kinds: [
    { id: 'upload', name: { en: 'Upload' }, picker: { type: 'upload' } },
    { id: 'url', name: { en: 'Web page (URL)' }, picker: { type: 'url' } }
  ],
  upload: { available: true, accept: ['.pdf'], summary: 'PDF' }
};

const ITEMS = [
  {
    id: 'itm_ready',
    kind: 'office365',
    name: 'Lease.pdf',
    status: 'ready',
    pinned: false,
    text: { tokens: 1200 },
    provenance: { origin: 'picked', source: { site: 'OneDrive / SharePoint' } },
    snapshotAt: '2026-10-12T08:00:00Z'
  },
  {
    id: 'itm_failed',
    kind: 'upload',
    name: 'scan.pdf',
    status: 'failed',
    error: { code: 'NO_TEXT', message: 'no text' },
    provenance: { origin: 'uploaded' }
  }
];

const OWNER_PERMISSIONS = {
  canUse: true,
  canEdit: true,
  canShare: true,
  canDelete: true,
  canTransfer: true,
  isOwner: true,
  readOnly: false
};

function makeProject(overrides = {}) {
  return {
    id: 'prj_a',
    ownership: 'user',
    name: 'Case 2026-114',
    description: 'Tenancy dispute',
    instructions: 'Answer briefly.',
    owner: { id: 'u_17', name: 'Dana', active: true },
    members: [],
    usage: { items: 2, bytes: 1000 },
    items: ITEMS,
    role: 'owner',
    permissions: OWNER_PERMISSIONS,
    ...overrides
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="location-notice">{location.state?.notice || ''}</div>
    </>
  );
}

// In-app navigation the way Back/Forward moves the router: the page stays
// mounted, only `:projectId` changes.
const mockRouter = { navigate: null };
function NavigationProbe() {
  mockRouter.navigate = useNavigate();
  return null;
}

// A consumer of the shared project list, as the list page and the chat's
// project labels are.
function ListProbe() {
  const { projects } = useMyProjects();
  return <div data-testid="list-probe">{projects.map(project => project.name).join('|')}</div>;
}

function renderPage({ withList = false } = {}) {
  return render(
    <MemoryRouter initialEntries={['/projects/prj_a']}>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
      <NavigationProbe />
      {withList && <ListProbe />}
    </MemoryRouter>
  );
}

/** A promise the test settles. */
function deferred() {
  let resolve;
  const promise = new Promise(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchProjectsConfig.mockResolvedValue(CONFIG);
  mockApi.fetchProjects.mockResolvedValue([]);
  mockApi.fetchProjectChats.mockResolvedValue({
    items: [
      {
        id: 'chat-1',
        title: 'Notice period',
        appId: 'chat',
        lastMessageAt: '2026-10-20T10:00:00Z',
        owner: { mine: true }
      }
    ],
    nextCursor: null,
    total: 1
  });
  invalidateProjectsList();
  invalidateProjectsConfig();
});

describe('ProjectPage – owner', () => {
  test('shows the items with status, provenance, usage and chats', async () => {
    mockApi.fetchProject.mockResolvedValue(makeProject());
    renderPage();

    expect(await screen.findByText('Lease.pdf')).toBeInTheDocument();
    expect(screen.getByText('Picked from OneDrive / SharePoint')).toBeInTheDocument();
    expect(screen.getByText('text taken 12 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText(/Run it through OCR/)).toBeInTheDocument();
    // A failed upload has no source to read again: the file has to be added
    // anew, so no Retry (the server would refuse the refresh).
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // A picked, ready document can be read again from its source.
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(await screen.findByText('2 of 25')).toBeInTheDocument();
    expect(await screen.findByText('Notice period')).toHaveAttribute('href', '/apps/chat/c/chat-1');
    expect(screen.queryByTestId('project-read-only')).not.toBeInTheDocument();
  });

  test('starts a chat from the header and lists the chats above the documents', async () => {
    mockApi.fetchProject.mockResolvedValue(makeProject());
    renderPage();
    await screen.findByText('Lease.pdf');

    const newChat = screen.getByRole('button', { name: 'New chat' });
    // In the header, beside the title, not in the chats card.
    expect(newChat.closest('section')).toBeNull();
    // Chats come first, so many documents cannot push them down.
    const chats = screen.getByRole('heading', { name: 'Chats' });
    const documents = screen.getByRole('heading', { name: 'Documents' });
    expect(
      chats.compareDocumentPosition(documents) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(newChat);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  test('pages a long chat list instead of growing the page', async () => {
    const chat = index => ({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      appId: 'chat',
      lastMessageAt: '2026-10-20T10:00:00Z',
      owner: { mine: true }
    });
    mockApi.fetchProject.mockResolvedValue(makeProject());
    mockApi.fetchProjectChats.mockImplementation(async (_id, { cursor }) =>
      cursor === '10'
        ? { items: [chat(11), chat(12)], nextCursor: null, total: 12 }
        : { items: Array.from({ length: 10 }, (_, i) => chat(i + 1)), nextCursor: '10', total: 12 }
    );
    renderPage();

    expect(await screen.findByText('Chat 1')).toBeInTheDocument();
    expect(screen.queryByText('Chat 11')).not.toBeInTheDocument();
    expect(screen.getByText('Chats 1–10 of 12')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText('Chat 11')).toBeInTheDocument();
    expect(screen.queryByText('Chat 1')).not.toBeInTheDocument();
    expect(screen.getByText('Chats 11–12 of 12')).toBeInTheDocument();
    expect(mockApi.fetchProjectChats).toHaveBeenLastCalledWith('prj_a', {
      filter: 'all',
      limit: 10,
      cursor: '10'
    });

    // Another filter starts again at the first page.
    fireEvent.click(screen.getByRole('button', { name: 'My chats' }));
    await waitFor(() =>
      expect(mockApi.fetchProjectChats).toHaveBeenLastCalledWith('prj_a', {
        filter: 'mine',
        limit: 10,
        cursor: null
      })
    );
  });

  test('shows no pager while the chats fit one page', async () => {
    mockApi.fetchProject.mockResolvedValue(makeProject());
    renderPage();
    await screen.findByText('Notice period');
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  test('a long document list scrolls inside its card', async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `itm_${index}`,
      kind: 'upload',
      name: `file-${index}.md`,
      status: 'ready',
      pinned: false,
      text: { tokens: 10 },
      provenance: { origin: 'uploaded' }
    }));
    mockApi.fetchProject.mockResolvedValue({ ...makeProject(), items: many });
    renderPage();
    await screen.findByText('file-0.md');
    expect(screen.getByTestId('project-items-scroll')).toHaveClass('overflow-y-auto');
  });

  test('saves only the changed settings', async () => {
    mockApi.fetchProject.mockResolvedValue(makeProject());
    mockApi.updateProject.mockResolvedValue(makeProject({ instructions: 'Answer in German.' }));
    renderPage();

    const instructions = await screen.findByLabelText('Instructions');
    fireEvent.change(instructions, { target: { value: 'Answer in German.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockApi.updateProject).toHaveBeenCalledWith('prj_a', {
        instructions: 'Answer in German.'
      })
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  test('a save still out for the previous project never replaces the one on screen', async () => {
    const projectB = makeProject({ id: 'prj_b', name: 'Team wiki', instructions: 'Be terse.' });
    mockApi.fetchProject.mockImplementation(id =>
      Promise.resolve(id === 'prj_b' ? projectB : makeProject())
    );
    const save = deferred();
    mockApi.updateProject.mockReturnValue(save.promise);
    renderPage();

    fireEvent.change(await screen.findByLabelText('Instructions'), {
      target: { value: 'Answer in German.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockApi.updateProject).toHaveBeenCalledWith('prj_a', expect.any(Object));

    // Back/Forward to project B while A's save is out.
    await act(async () => {
      mockRouter.navigate('/projects/prj_b');
    });
    expect(await screen.findByRole('heading', { name: 'Team wiki' })).toBeInTheDocument();

    await act(async () => {
      save.resolve(makeProject({ instructions: 'Answer in German.' }));
    });
    expect(screen.getByRole('heading', { name: 'Team wiki' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Case 2026-114' })).toBeNull();
    expect(screen.getByLabelText('Instructions')).toHaveValue('Be terse.');
  });

  test('a saved rename reaches the shared project list', async () => {
    mockApi.fetchProject.mockResolvedValue(makeProject());
    mockApi.fetchProjects
      .mockResolvedValueOnce([makeProject()])
      .mockResolvedValue([makeProject({ name: 'Case 2026-115' })]);
    mockApi.updateProject.mockResolvedValue(makeProject({ name: 'Case 2026-115' }));
    renderPage({ withList: true });
    await waitFor(() =>
      expect(screen.getByTestId('list-probe')).toHaveTextContent('Case 2026-114')
    );

    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Case 2026-115' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByTestId('list-probe')).toHaveTextContent('Case 2026-115')
    );
    expect(mockApi.fetchProjects).toHaveBeenCalledTimes(2);
  });

  test('follows a refresh until the new snapshot is stored', async () => {
    // A refresh keeps the item `ready` (its old snapshot stays readable) and
    // marks it with `refreshingAt` until the queued job has stored the new one.
    const refreshing = { ...ITEMS[0], refreshingAt: '2026-10-22T09:00:00Z' };
    const refreshed = { ...ITEMS[0], snapshotAt: '2026-10-22T09:00:05Z' };
    mockApi.fetchProject
      .mockResolvedValueOnce(makeProject())
      .mockResolvedValueOnce(makeProject({ items: [refreshing, ITEMS[1]] }))
      .mockResolvedValue(makeProject({ items: [refreshed, ITEMS[1]] }));
    mockApi.refreshProjectItem.mockResolvedValue(refreshing);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(mockApi.refreshProjectItem).toHaveBeenCalledWith('prj_a', 'itm_ready')
    );
    expect(screen.getByText('text taken 12 Oct 2026')).toBeInTheDocument();

    // The page keeps polling while the item is being refreshed.
    expect(
      await screen.findByText('text taken 22 Oct 2026', {}, { timeout: 4000 })
    ).toBeInTheDocument();
    expect(mockApi.fetchProject).toHaveBeenCalledTimes(3);
  });

  test('pins an item and deletes the project after confirmation', async () => {
    mockApi.fetchProject.mockResolvedValue(makeProject());
    mockApi.updateProjectItem.mockResolvedValue({ ...ITEMS[0], pinned: true });
    mockApi.deleteProject.mockResolvedValue();
    renderPage();

    fireEvent.click(await screen.findByLabelText('Pin Lease.pdf'));
    await waitFor(() =>
      expect(mockApi.updateProjectItem).toHaveBeenCalledWith('prj_a', 'itm_ready', { pinned: true })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(mockApi.deleteProject).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockApi.deleteProject).toHaveBeenCalledWith('prj_a'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects'));
  });

  test('uploads several files one by one and shows a quota refusal', async () => {
    mockApi.fetchProject.mockResolvedValue(makeProject());
    mockApi.uploadProjectItem
      .mockResolvedValueOnce({ id: 'itm_new', status: 'pending' })
      .mockRejectedValueOnce(
        Object.assign(new Error('quota'), {
          originalError: {
            response: { status: 413, data: { details: { code: 'QUOTA_FILES', limit: 25 } } }
          }
        })
      );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Add documents' }));
    const dialog = await screen.findByRole('dialog');
    // Kinds the installation does not offer are hidden for users.
    expect(within(dialog).queryByRole('tab', { name: 'iFinder document' })).not.toBeInTheDocument();
    const a = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' });
    const b = new File(['%PDF'], 'b.pdf', { type: 'application/pdf' });
    fireEvent.change(within(dialog).getByLabelText('File'), { target: { files: [a, b] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockApi.uploadProjectItem).toHaveBeenCalledTimes(2));
    expect(mockApi.uploadProjectItem).toHaveBeenNthCalledWith(1, 'prj_a', {
      file: a,
      name: undefined,
      pinned: false
    });
    expect(
      await within(dialog).findByText(
        'b.pdf: This project already holds 25 items, the most it may hold.'
      )
    ).toBeInTheDocument();

    // Add again: only the file that failed goes out — no second copy of a.pdf.
    mockApi.uploadProjectItem.mockResolvedValueOnce({ id: 'itm_b', status: 'pending' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockApi.uploadProjectItem).toHaveBeenCalledTimes(3));
    expect(mockApi.uploadProjectItem.mock.calls[2][1].file).toBe(b);
  });
});

describe('ProjectPage – documents linked from other projects', () => {
  const SOURCE = makeProject({
    id: 'prj_docs',
    name: 'Delivery docs',
    items: [
      { id: 'itm_install', kind: 'upload', name: 'Install.md', status: 'ready' },
      { id: 'itm_ops', kind: 'upload', name: 'Operations.md', status: 'ready' }
    ]
  });

  test('links the ticked documents of another project', async () => {
    const config = {
      ...CONFIG,
      kinds: [
        ...CONFIG.kinds,
        { id: 'project-item', name: { en: 'From another project' }, picker: { type: 'project' } }
      ]
    };
    mockApi.fetchProjectsConfig.mockResolvedValue(config);
    mockApi.fetchProject.mockImplementation(async id =>
      id === 'prj_docs'
        ? SOURCE
        : makeProject({
            items: [
              {
                id: 'itm_link',
                kind: 'project-item',
                name: 'Install.md',
                status: 'ready',
                ref: { projectId: 'prj_docs', itemId: 'itm_install' },
                provenance: { origin: 'linked', source: { site: 'Delivery docs' } },
                link: { state: 'forbidden' }
              }
            ]
          })
    );
    mockApi.fetchProjects.mockResolvedValue([
      makeProject({ items: undefined }),
      { ...SOURCE, items: undefined, role: 'user' }
    ]);
    mockApi.addProjectItem.mockResolvedValue({ id: 'itm_new', kind: 'project-item' });
    renderPage();

    // A link the viewer may not read says so.
    expect(await screen.findByText('No access')).toBeInTheDocument();
    expect(screen.getByText('Linked from Delivery docs')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add documents' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'From another project' }));
    const select = await screen.findByLabelText('Project');
    // Only the other project is offered.
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.value)
    ).toEqual(['', 'prj_docs']);
    fireEvent.change(select, { target: { value: 'prj_docs' } });

    // The document linked already cannot be ticked again.
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('checkbox', { name: /Install\.md/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Operations\.md/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link 1 documents' }));

    await waitFor(() =>
      expect(mockApi.addProjectItem).toHaveBeenCalledWith('prj_a', {
        kind: 'project-item',
        ref: { projectId: 'prj_docs', itemId: 'itm_ops' },
        pinned: false
      })
    );
  });
});

describe('ProjectPage – transfer ownership', () => {
  async function pickNewOwner() {
    fireEvent.click(await screen.findByRole('button', { name: 'Transfer ownership' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'ben' } });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Ben Baker/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer to Ben Baker' }));
    return dialog;
  }

  beforeEach(() => {
    mockApi.fetchProject.mockResolvedValue(makeProject());
    mockApi.fetchProjectShareTargets.mockResolvedValue({
      users: [{ id: 'u_ben', name: 'Ben Baker', email: 'ben@example.com' }],
      groups: []
    });
  });

  test('asks again and explains the transfer before anything is sent', async () => {
    renderPage();
    const dialog = await pickNewOwner();

    expect(
      within(dialog).getByRole('heading', { name: 'Transfer “Case 2026-114” to Ben Baker?' })
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Ben Baker becomes the owner/)).toBeInTheDocument();
    expect(within(dialog).getByText(/You are no longer the owner/)).toBeInTheDocument();
    expect(mockApi.transferProject).not.toHaveBeenCalled();

    // Back returns to the choice, still without a request.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByRole('button', { name: 'Transfer to Ben Baker' })).toBeEnabled();
    expect(mockApi.transferProject).not.toHaveBeenCalled();
  });

  test('an administrator who handed the project over goes back to the list', async () => {
    // The server still shows the project to a full admin, for compliance.
    mockApi.transferProject.mockResolvedValue(
      makeProject({
        owner: { name: 'Ben Baker', active: true },
        role: 'admin',
        permissions: { ...OWNER_PERMISSIONS, canEdit: false, isOwner: false }
      })
    );
    renderPage();
    const dialog = await pickNewOwner();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, transfer ownership' }));

    await waitFor(() => expect(mockApi.transferProject).toHaveBeenCalledWith('prj_a', 'u_ben'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects'));
    expect(screen.getByTestId('location-notice')).toHaveTextContent(
      /^“Case 2026-114” now belongs to Ben Baker\.$/
    );
  });

  test('warns about group shares and says why the project is still listed', async () => {
    mockApi.fetchProject.mockResolvedValue(
      makeProject({
        members: [
          { type: 'group', id: 'sales', name: 'Sales', role: 'editor' },
          { type: 'everyone', id: null, role: 'user' }
        ]
      })
    );
    mockApi.transferProject.mockResolvedValue(
      makeProject({
        owner: { name: 'Ben Baker', active: true },
        role: 'editor',
        permissions: { ...OWNER_PERMISSIONS, canDelete: false, isOwner: false }
      })
    );
    renderPage();
    const dialog = await pickNewOwner();
    expect(
      within(dialog).getByText(
        'It stays shared with Sales, everyone signed in. If you belong to one of them, you keep that access.'
      )
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, transfer ownership' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects'));
    expect(screen.getByTestId('location-notice')).toHaveTextContent(
      'You still see it under “Shared with me”, because a share reaches you.'
    );
  });
});

describe('ProjectPage – members and read-only', () => {
  test('a user member sees the project read-only and can filter the chats', async () => {
    mockApi.fetchProject.mockResolvedValue(
      makeProject({
        role: 'user',
        members: undefined,
        memberCount: 3,
        permissions: { canUse: true, isOwner: false }
      })
    );
    renderPage();

    expect(await screen.findByText('Lease.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add documents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Instructions' })).not.toBeInTheDocument();
    expect(screen.getByText('Answer briefly.')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'My chats' }));
    await waitFor(() =>
      expect(mockApi.fetchProjectChats).toHaveBeenLastCalledWith('prj_a', {
        filter: 'mine',
        limit: 10,
        cursor: null
      })
    );
  });

  test('an editor listed by name may leave the project', async () => {
    mockApi.fetchProject.mockResolvedValue(
      makeProject({
        role: 'editor',
        members: [
          { type: 'user', id: 'u_42', name: 'Ann', role: 'editor' },
          { type: 'group', id: 'legal', role: 'user' }
        ],
        permissions: { canUse: true, canEdit: true, canShare: true, isOwner: false }
      })
    );
    mockApi.updateProjectMembers.mockResolvedValue({});
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Leave project' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave project' }));
    await waitFor(() =>
      expect(mockApi.updateProjectMembers).toHaveBeenCalledWith('prj_a', [
        { type: 'group', id: 'legal', role: 'user' }
      ])
    );
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects'));
  });

  test('shows the read-only banner when the owner is gone', async () => {
    mockApi.fetchProject.mockResolvedValue(
      makeProject({
        role: 'editor',
        owner: { name: 'Dana', active: false },
        permissions: {
          canUse: true,
          canEdit: false,
          canShare: false,
          isOwner: false,
          readOnly: true
        }
      })
    );
    renderPage();
    expect(await screen.findByTestId('project-read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add documents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();
  });

  test('says so when the project is gone or not shared with the viewer', async () => {
    mockApi.fetchProject.mockRejectedValue(
      Object.assign(new Error('not found'), {
        originalError: {
          response: { status: 404, data: { details: { code: 'PROJECT_NOT_FOUND' } } }
        }
      })
    );
    renderPage();
    expect(
      await screen.findByText('This project does not exist or you no longer have access to it.')
    ).toBeInTheDocument();
  });
});

describe('ProjectSettingsCard – a newer copy arrives while editing', () => {
  test('takes another editor’s instructions and sends only the local edit', async () => {
    const onSaved = jest.fn();
    const first = makeProject();
    const { rerender } = render(<ProjectSettingsCard project={first} editable onSaved={onSaved} />);
    // A poll (an item is still extracting) brings another editor's update.
    rerender(
      <ProjectSettingsCard
        project={makeProject({ instructions: 'Answer in German.' })}
        editable
        onSaved={onSaved}
      />
    );
    expect(screen.getByLabelText('Instructions')).toHaveValue('Answer in German.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    // An unsaved local edit survives the next poll.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Case 2026-115' } });
    rerender(
      <ProjectSettingsCard
        project={makeProject({ instructions: 'Answer in German.', usage: { items: 3 } })}
        editable
        onSaved={onSaved}
      />
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Case 2026-115');

    mockApi.updateProject.mockResolvedValue(
      makeProject({ name: 'Case 2026-115', instructions: 'Answer in German.' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockApi.updateProject).toHaveBeenCalledWith('prj_a', { name: 'Case 2026-115' })
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('ProjectSettingsCard – while a save is out', () => {
  test('the fields are read-only, so no edit is lost when the answer arrives', async () => {
    const save = deferred();
    mockApi.updateProject.mockReturnValue(save.promise);
    render(<ProjectSettingsCard project={makeProject()} editable onSaved={jest.fn()} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Case 2026-115' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    for (const label of ['Name', 'Description', 'Instructions']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    await act(async () => {
      save.resolve(makeProject({ name: 'Case 2026-115' }));
    });
    expect(screen.getByLabelText('Instructions')).toBeEnabled();
    expect(screen.getByLabelText('Name')).toHaveValue('Case 2026-115');
  });
});
