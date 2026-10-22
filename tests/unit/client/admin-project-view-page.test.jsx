// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Projects → one project (read-only view): shows the description,
 * the instructions, the items and what links the project; leads to the edit
 * form; and "Estimate tokens" shows the size and the recommendation for the
 * project and for every item, web pages included.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  fetchAdminProject: jest.fn(),
  fetchAdminProjectKinds: jest.fn(),
  fetchAdminProjectDependencies: jest.fn(),
  estimateAdminProject: jest.fn(),
  testAdminProject: jest.fn(),
  fetchAdminProjectItemText: jest.fn()
};

jest.mock('../../../client/src/api/adminApi', () => {
  const forward =
    name =>
    (...args) =>
      mockApi[name](...args);
  return {
    fetchAdminProject: forward('fetchAdminProject'),
    fetchAdminProjectKinds: forward('fetchAdminProjectKinds'),
    fetchAdminProjectDependencies: forward('fetchAdminProjectDependencies'),
    estimateAdminProject: forward('estimateAdminProject'),
    testAdminProject: forward('testAdminProject'),
    fetchAdminProjectItemText: forward('fetchAdminProjectItemText'),
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
  mockApi.fetchAdminProjectDependencies.mockResolvedValue([
    { type: 'app', id: 'intrafind-websites-bot', name: 'IntraFind Website Bot' }
  ]);
});

describe('AdminProjectViewPage', () => {
  test('shows the project read-only and leads to the edit form', async () => {
    renderView();

    expect(
      await screen.findByRole('heading', { level: 1, name: /IntraFind Website/ })
    ).toBeInTheDocument();
    expect(screen.getByText('Pages of the IntraFind website')).toBeInTheDocument();
    expect(screen.getByText('Answer from the pages only.')).toBeInTheDocument();
    expect(screen.getAllByText('https://www.intrafind.com').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
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
