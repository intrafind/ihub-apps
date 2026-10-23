// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Projects → new / edit (#1036): the create form validates the id
 * before anything is sent, the items table shows each status, the page
 * polls while an item is extracted, the "Add item" dialog uploads a file as
 * multipart (through `uploadAdminProjectItem`) and sends text as JSON, and
 * an unscanned upload setup is flagged.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mockApi = {
  fetchAdminProject: jest.fn(),
  fetchAdminProjects: jest.fn(),
  fetchAdminProjectKinds: jest.fn(),
  fetchAdminProjectConfig: jest.fn(),
  createAdminProject: jest.fn(),
  updateAdminProject: jest.fn(),
  updateAdminProjectItem: jest.fn(),
  deleteAdminProjectItem: jest.fn(),
  refreshAdminProjectItem: jest.fn(),
  testAdminProject: jest.fn(),
  addAdminProjectItem: jest.fn(),
  uploadAdminProjectItem: jest.fn(),
  fetchAdminProjectItemText: jest.fn(),
  fetchProjectPickerPages: jest.fn(),
  searchProjectPickerIFinder: jest.fn(),
  checkProjectPickerUrl: jest.fn()
};

jest.mock('../../../client/src/api/adminApi', () => {
  const forward =
    name =>
    (...args) =>
      mockApi[name](...args);
  return {
    fetchAdminProject: forward('fetchAdminProject'),
    fetchAdminProjects: forward('fetchAdminProjects'),
    fetchAdminProjectKinds: forward('fetchAdminProjectKinds'),
    fetchAdminProjectConfig: forward('fetchAdminProjectConfig'),
    createAdminProject: forward('createAdminProject'),
    updateAdminProject: forward('updateAdminProject'),
    updateAdminProjectItem: forward('updateAdminProjectItem'),
    deleteAdminProjectItem: forward('deleteAdminProjectItem'),
    refreshAdminProjectItem: forward('refreshAdminProjectItem'),
    testAdminProject: forward('testAdminProject'),
    addAdminProjectItem: forward('addAdminProjectItem'),
    uploadAdminProjectItem: forward('uploadAdminProjectItem'),
    fetchAdminProjectItemText: forward('fetchAdminProjectItemText'),
    fetchProjectPickerPages: forward('fetchProjectPickerPages'),
    searchProjectPickerIFinder: forward('searchProjectPickerIFinder'),
    checkProjectPickerUrl: forward('checkProjectPickerUrl'),
    getAdminApiErrorMessage: err => err?.response?.data?.error ?? err?.message ?? 'error'
  };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);
// A plain English input stands in for the multi-language editor.
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: ({ value, onChange, placeholder, error }) => (
    <div>
      <input
        aria-label={placeholder}
        value={value?.en || ''}
        onChange={e => onChange({ ...value, en: e.target.value })}
      />
      {error && <p>{error}</p>}
    </div>
  )
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

const AdminProjectEditPage =
  require('../../../client/src/features/admin/pages/AdminProjectEditPage').default;

const KINDS = [
  { id: 'upload', name: { en: 'Upload' }, enabled: true },
  { id: 'url', name: { en: 'Web page (URL)' }, enabled: true },
  { id: 'page', name: { en: 'iHub page' }, enabled: true },
  { id: 'ifinder-document', name: { en: 'iFinder document' }, enabled: false },
  { id: 'ifinder-query', name: { en: 'iFinder search' }, enabled: false },
  { id: 'office365', name: { en: 'OneDrive / SharePoint' }, enabled: true }
];
const CONFIG = {
  upload: { available: true, accept: ['.pdf', '.docx'], mimeTypes: [], summary: 'PDF, Word' },
  scan: { provider: 'none' },
  limits: { maxFileBytes: 10 * 1024 * 1024 }
};

function makeProject(items) {
  return {
    id: 'handbook',
    ownership: 'admin',
    name: { en: 'Employee handbook' },
    description: { en: 'Policies' },
    instructions: 'Answer briefly.',
    enabled: true,
    category: 'HR',
    tags: ['policy'],
    items
  };
}

const READY = {
  id: 'i1',
  kind: 'upload',
  name: 'policies.pdf',
  status: 'ready',
  pinned: false,
  text: { tokens: 1200, chars: 4800 },
  error: null
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {['/admin/projects/new', '/admin/projects/:id/edit'].map(routePath => (
          <Route
            key={routePath}
            path={routePath}
            element={
              <>
                <AdminProjectEditPage />
                <LocationProbe />
              </>
            }
          />
        ))}
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchAdminProjectKinds.mockResolvedValue(KINDS);
  mockApi.fetchAdminProjectConfig.mockResolvedValue(CONFIG);
});

describe('AdminProjectEditPage – create', () => {
  test('validates the id before sending anything', async () => {
    renderAt('/admin/projects/new');

    fireEvent.click(screen.getByRole('button', { name: 'Create and add items' }));
    expect(await screen.findByText('The project ID is required.')).toBeInTheDocument();
    expect(screen.getByText('A name is required.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Project ID *'), { target: { value: 'prj_mine' } });
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and add items' }));
    expect(
      await screen.findByText('IDs starting with "prj_" are reserved for user projects.')
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Project ID *'), { target: { value: 'has space' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and add items' }));
    expect(
      await screen.findByText('Use only letters, numbers, dots, underscores and hyphens.')
    ).toBeInTheDocument();

    expect(mockApi.createAdminProject).not.toHaveBeenCalled();
  });

  test('creates the project and moves on to its page for the items', async () => {
    mockApi.createAdminProject.mockResolvedValue(makeProject([]));
    mockApi.fetchAdminProject.mockResolvedValue(makeProject([]));
    renderAt('/admin/projects/new');

    fireEvent.change(screen.getByLabelText('Project ID *'), { target: { value: 'handbook' } });
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Employee handbook' }
    });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'hr, policy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and add items' }));

    await waitFor(() => expect(mockApi.createAdminProject).toHaveBeenCalled());
    expect(mockApi.createAdminProject.mock.calls[0][0]).toEqual({
      id: 'handbook',
      name: { en: 'Employee handbook' },
      instructions: '',
      enabled: true,
      tags: ['hr', 'policy']
    });
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/admin/projects/handbook/edit')
    );
  });

  test('shows the server message when the id is taken', async () => {
    mockApi.createAdminProject.mockRejectedValue(
      Object.assign(new Error('conflict'), {
        response: {
          status: 409,
          data: { error: 'Project exists', details: { code: 'PROJECT_EXISTS' } }
        }
      })
    );
    renderAt('/admin/projects/new');

    fireEvent.change(screen.getByLabelText('Project ID *'), { target: { value: 'handbook' } });
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Handbook' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and add items' }));

    expect(await screen.findByText('A project with this ID already exists.')).toBeInTheDocument();
  });
});

describe('AdminProjectEditPage – items', () => {
  test('shows each item status and warns about unscanned uploads', async () => {
    mockApi.fetchAdminProject.mockResolvedValue(
      makeProject([
        READY,
        { id: 'i2', kind: 'url', name: 'Intranet', status: 'stale', ref: { url: 'https://intra' } },
        {
          id: 'i3',
          kind: 'upload',
          name: 'broken.pdf',
          status: 'failed',
          error: { code: 'EXTRACT_FAILED', message: 'The PDF is encrypted' }
        },
        {
          id: 'i4',
          kind: 'office365',
          name: 'Lease.docx',
          status: 'failed',
          ref: { providerId: 'o365', fileId: 'f1' },
          provenance: { origin: 'picked' },
          error: { code: 'FETCH_FAILED', message: 'The file could not be read' }
        }
      ])
    );
    renderAt('/admin/projects/handbook/edit');

    expect(await screen.findByText('policies.pdf')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Answer briefly.')).toBeInTheDocument();
    expect(screen.getByText(/~1.2K tokens|~1,200 tokens|~1200 tokens/)).toBeInTheDocument();
    expect(screen.getByText('Outdated')).toBeInTheDocument();
    expect(screen.getByText('The PDF is encrypted')).toBeInTheDocument();
    // Retry reads the item again from its source: offered for the failed
    // cloud document, not for the failed upload, which has no source to read.
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(
      within(screen.getByText('Lease.docx').closest('tr')).getByRole('button', { name: 'Retry' })
    ).toBeInTheDocument();
    expect(
      within(screen.getByText('broken.pdf').closest('tr')).queryByRole('button', { name: 'Retry' })
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(await screen.findByTestId('project-scan-warning')).toBeInTheDocument();
  });

  test('polls the project while an item is being extracted', async () => {
    mockApi.fetchAdminProject
      .mockResolvedValueOnce(makeProject([{ ...READY, status: 'pending', text: null }]))
      .mockResolvedValue(makeProject([READY]));
    renderAt('/admin/projects/handbook/edit');

    expect(await screen.findByText('Waiting')).toBeInTheDocument();
    expect(await screen.findByText('Ready', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(mockApi.fetchAdminProject).toHaveBeenCalledTimes(2);
  });

  test('offers to move the ticked items and forgets one that is gone', async () => {
    const pending = { ...READY, id: 'i2', name: 'draft.pdf', status: 'pending', text: null };
    mockApi.fetchAdminProjects.mockResolvedValue([
      makeProject([]),
      { id: 'other', name: { en: 'Other' }, items: [] }
    ]);
    mockApi.fetchAdminProject
      .mockResolvedValueOnce(makeProject([READY, pending]))
      // The poll finds the first item gone (moved or removed by someone else).
      .mockResolvedValue(makeProject([{ ...pending, status: 'ready' }]));
    renderAt('/admin/projects/handbook/edit');

    fireEvent.click(await screen.findByLabelText('Select policies.pdf'));
    const bar = screen.getByTestId('item-selection-bar');
    expect(bar).toHaveTextContent('1 items selected');
    fireEvent.click(within(bar).getByRole('button', { name: 'Move to…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Move or copy items')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('1 items of "Employee handbook"');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await waitFor(() => expect(screen.queryByTestId('item-selection-bar')).toBeNull(), {
      timeout: 4000
    });
  });

  test('uploads a file through the multipart helper from the dialog', async () => {
    mockApi.fetchAdminProject.mockResolvedValue(makeProject([]));
    mockApi.uploadAdminProjectItem.mockResolvedValue({ id: 'i9', status: 'pending' });
    renderAt('/admin/projects/handbook/edit');

    fireEvent.click(await screen.findByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('tab', { name: 'Upload' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    );
    const input = within(dialog).getByLabelText('File');
    await waitFor(() => expect(input).toHaveAttribute('accept', '.pdf,.docx'));

    const file = new File(['%PDF'], 'guide.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Guide' } });
    fireEvent.click(within(dialog).getByLabelText('Pinned (always in the prompt)'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(mockApi.uploadAdminProjectItem).toHaveBeenCalledWith('handbook', {
        file,
        name: 'Guide',
        pinned: true
      })
    );
    expect(mockApi.addAdminProjectItem).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('sends pasted text as a JSON upload item and keeps cloud kinds disabled', async () => {
    mockApi.fetchAdminProject.mockResolvedValue(makeProject([]));
    mockApi.addAdminProjectItem.mockResolvedValue({ id: 'i9', status: 'pending' });
    renderAt('/admin/projects/handbook/edit');

    fireEvent.click(await screen.findByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('tab', { name: 'OneDrive / SharePoint' }));
    expect(within(dialog).getByText('Coming in a later release.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Text' }));
    fireEvent.change(within(dialog).getByLabelText('Text'), {
      target: { value: 'Vacation is 30 days.' }
    });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Vacation' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(mockApi.addAdminProjectItem).toHaveBeenCalledWith('handbook', {
        kind: 'upload',
        ref: {},
        name: 'Vacation',
        pinned: false,
        text: 'Vacation is 30 days.'
      })
    );
  });
});
