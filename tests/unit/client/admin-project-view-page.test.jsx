// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Projects → one project (read-only view): shows the description,
 * the instructions, the items and what links the project; leads to the items
 * editor; and "Estimate tokens" shows the size and the recommendation for the
 * project and for every item, web pages included.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  fetchAdminProject: jest.fn(),
  fetchAdminProjectKinds: jest.fn(),
  fetchAdminProjectConfig: jest.fn(),
  addAdminProjectItem: jest.fn(),
  fetchAdminProjectDependencies: jest.fn(),
  estimateAdminProject: jest.fn(),
  testAdminProject: jest.fn(),
  fetchAdminProjectItemText: jest.fn(),
  updateAdminProjectItemText: jest.fn()
};

jest.mock('../../../client/src/api/adminApi', () => {
  const forward =
    name =>
    (...args) =>
      mockApi[name](...args);
  return {
    fetchAdminProject: forward('fetchAdminProject'),
    fetchAdminProjectKinds: forward('fetchAdminProjectKinds'),
    fetchAdminProjectConfig: forward('fetchAdminProjectConfig'),
    addAdminProjectItem: forward('addAdminProjectItem'),
    fetchAdminProjectDependencies: forward('fetchAdminProjectDependencies'),
    estimateAdminProject: forward('estimateAdminProject'),
    testAdminProject: forward('testAdminProject'),
    fetchAdminProjectItemText: forward('fetchAdminProjectItemText'),
    updateAdminProjectItemText: forward('updateAdminProjectItemText'),
    getAdminApiErrorMessage: err => err?.response?.data?.error ?? err?.message ?? 'error'
  };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);

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

const AdminProjectViewPage =
  require('../../../client/src/features/admin/pages/AdminProjectViewPage').default;

const PROJECT = {
  id: 'intrafind-website',
  ownership: 'admin',
  name: { en: 'IntraFind Website' },
  description: { en: 'Pages of the IntraFind website' },
  instructions: 'Answer from the pages only.',
  enabled: true,
  category: '',
  tags: [],
  items: [
    {
      id: 'itm_home',
      kind: 'url',
      name: 'https://www.intrafind.com',
      ref: { url: 'https://www.intrafind.com' },
      storage: 'link',
      status: 'ready',
      pinned: false
    },
    {
      id: 'itm_docs',
      kind: 'upload',
      name: 'handbook.md',
      storage: 'text',
      status: 'ready',
      pinned: false,
      provenance: { origin: 'uploaded' },
      text: { tokens: 1200 }
    }
  ]
};

const ESTIMATE = {
  projectId: 'intrafind-website',
  tokens: 31200,
  budgetTokens: 50000,
  share: 0.624,
  minContextWindow: 78000,
  unmeasured: 0,
  recommendation: 'prompt',
  reason: 'tight',
  items: [
    {
      id: 'itm_home',
      ok: true,
      tokens: 30000,
      recommendation: 'search',
      reason: 'large'
    },
    { id: 'itm_docs', ok: true, tokens: 1200, recommendation: 'prompt', reason: 'small' }
  ]
};

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/admin/projects/intrafind-website']}>
      <Routes>
        <Route path="/admin/projects/:id" element={<AdminProjectViewPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockApi.fetchAdminProject.mockResolvedValue(PROJECT);
  mockApi.fetchAdminProjectKinds.mockResolvedValue([
    { id: 'upload', name: { en: 'Upload' } },
    { id: 'url', name: { en: 'Web page (URL)' } }
  ]);
  mockApi.fetchAdminProjectConfig.mockResolvedValue({
    upload: { available: true, accept: ['.pdf'], mimeTypes: [], summary: 'PDF' },
    scan: { provider: 'none' },
    limits: { maxFileBytes: 1024 }
  });
  mockApi.fetchAdminProjectDependencies.mockResolvedValue([
    { type: 'app', id: 'intrafind-websites-bot', name: 'IntraFind Website Bot' }
  ]);
});

describe('AdminProjectViewPage', () => {
  test('adds an item straight from the view and reads the project again', async () => {
    mockApi.addAdminProjectItem.mockResolvedValue({ id: 'new', status: 'pending' });
    renderView();
    await screen.findByRole('heading', { level: 1 });
    // Who can use it shows once, in the side panel where it is changed.
    expect(screen.getByTestId('project-availability-badge')).toHaveTextContent('Linked apps only');

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Text' }));
    fireEvent.change(within(dialog).getByLabelText('Text'), { target: { value: 'Hello' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Greeting' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(mockApi.addAdminProjectItem).toHaveBeenCalledWith(
        'intrafind-website',
        expect.objectContaining({ name: 'Greeting', text: 'Hello' })
      )
    );
    await waitFor(() => expect(mockApi.fetchAdminProject).toHaveBeenCalledTimes(2));
  });

  test('shows the items read-only and leads to the items editor', async () => {
    renderView();

    expect(
      await screen.findByRole('heading', { level: 1, name: /IntraFind Website/ })
    ).toBeInTheDocument();
    expect(screen.getByText('Pages of the IntraFind website')).toBeInTheDocument();
    expect(screen.getByText('Answer from the pages only.')).toBeInTheDocument();
    expect(screen.getAllByText('https://www.intrafind.com').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Edit items' })).toHaveAttribute(
      'href',
      '/admin/projects/intrafind-website/edit'
    );
    expect(await screen.findByRole('link', { name: 'IntraFind Website Bot' })).toHaveAttribute(
      'href',
      '/admin/apps/intrafind-websites-bot'
    );
    // Read-only: no way to remove or pin from here.
    expect(screen.queryByRole('button', { name: 'Remove item' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Pin https://www.intrafind.com')).toBeDisabled();
  });

  test('estimates the tokens and recommends per project and per item', async () => {
    mockApi.estimateAdminProject.mockResolvedValue(ESTIMATE);
    renderView();
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Estimate tokens' }));

    await waitFor(() =>
      expect(mockApi.estimateAdminProject).toHaveBeenCalledWith('intrafind-website')
    );
    const panel = await screen.findByTestId('project-estimate');
    expect(panel).toHaveTextContent('Recommendation: in the prompt');
    expect(panel).toHaveTextContent('~31.2K tokens in total');
    expect(panel).toHaveTextContent('62 %');
    // The web page has no stored size; the estimate gives it one.
    expect(screen.getByTestId('item-estimate-itm_home')).toHaveTextContent('~30.0K tokens');
    expect(screen.getByTestId('item-estimate-itm_home')).toHaveTextContent('Search');
    expect(screen.getByTestId('item-estimate-itm_docs')).toHaveTextContent('Prompt');
  });

  test('lets an admin edit the text of an uploaded or written document from its preview', async () => {
    mockApi.fetchAdminProjectItemText.mockResolvedValue({
      text: 'Old text',
      chars: 8,
      truncated: false
    });
    mockApi.updateAdminProjectItemText.mockResolvedValue({
      ...PROJECT.items[1],
      text: { tokens: 3 }
    });
    renderView();
    await screen.findByRole('heading', { level: 1 });

    // The web page has no stored text to edit; only the uploaded document offers it.
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview text' })[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockApi.updateAdminProjectItemText).toHaveBeenCalledWith(
        'intrafind-website',
        'itm_docs',
        'New text'
      )
    );
  });

  test('names the context window only for a project that fits, and a dynamic search as searched', async () => {
    mockApi.estimateAdminProject.mockResolvedValueOnce({ ...ESTIMATE, minContextWindow: 78000 });
    renderView();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Estimate tokens' }));
    const fits = await screen.findByTestId('project-estimate');
    expect(fits).toHaveAttribute('role', 'status');
    expect(fits).toHaveTextContent('context window of about 78.0K tokens');

    mockApi.estimateAdminProject.mockResolvedValueOnce({
      ...ESTIMATE,
      tokens: 500000,
      share: 10,
      minContextWindow: 1250000,
      recommendation: 'search',
      reason: 'exceeds'
    });
    fireEvent.click(screen.getByRole('button', { name: 'Estimate tokens' }));
    await waitFor(() =>
      expect(screen.getByTestId('project-estimate')).toHaveTextContent(
        'Do not put it into the prompt'
      )
    );
    expect(screen.getByTestId('project-estimate')).not.toHaveTextContent('context window');

    mockApi.estimateAdminProject.mockResolvedValueOnce({
      ...ESTIMATE,
      recommendation: 'search',
      reason: 'dynamic'
    });
    fireEvent.click(screen.getByRole('button', { name: 'Estimate tokens' }));
    await waitFor(() =>
      expect(screen.getByTestId('project-estimate')).toHaveTextContent(
        'search that runs with the model'
      )
    );
  });

  test('says so when the estimate fails', async () => {
    mockApi.estimateAdminProject.mockRejectedValue(new Error('boom'));
    renderView();
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Estimate tokens' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The estimate could not be made. boom'
    );
    expect(screen.queryByTestId('project-estimate')).not.toBeInTheDocument();
  });
});
