// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Save bar on the remaining edit pages (batch 1): the integration builder and the
 * scheduled-tasks settings show the bar only after a change, hide it again when the
 * change is reverted, restore the saved state on Discard and report a failed save
 * in the bar. The real unsaved-changes hook is used, so "dirty" is the page's own.
 */

jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  const interpolate = (text, options = {}) =>
    Object.entries(options || {}).reduce(
      (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
      text
    );
  const translate = (key, fallbackOrOptions, maybeOptions) => {
    const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions;
    const fallback = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key;
    const text = typeof lookup(key) === 'string' ? lookup(key) : fallback;
    return interpolate(text, options);
  };
  const translation = { t: translate, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="icon" />
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error',
  listCredentials: jest.fn(async () => [{ id: 'erp-token', type: 'bearer', name: 'ERP' }])
}));

const mockApi = {
  createCustomIntegration: jest.fn(),
  saveCustomIntegration: jest.fn(),
  fetchBuilderDraft: jest.fn(),
  exportCustomIntegration: jest.fn(),
  importBuilderActions: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  createCustomIntegration: (...args) => mockApi.createCustomIntegration(...args),
  saveCustomIntegration: (...args) => mockApi.saveCustomIntegration(...args),
  fetchBuilderDraft: (...args) => mockApi.fetchBuilderDraft(...args),
  exportCustomIntegration: (...args) => mockApi.exportCustomIntegration(...args),
  importBuilderActions: (...args) => mockApi.importBuilderActions(...args)
}));

jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => <nav data-testid="breadcrumb" />
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: path => path,
  getBasePath: () => ''
}));

const { makeAdminApiCall } = require('../../../client/src/api/adminApi');
const AdminIntegrationBuilderPage =
  require('../../../client/src/features/admin/pages/AdminIntegrationBuilderPage').default;
const AdminScheduledTasksPage =
  require('../../../client/src/features/admin/pages/AdminScheduledTasksPage').default;

const SAVE = { name: 'Save Changes' };
const CREATE = { name: 'Create integration' };

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  makeAdminApiCall.mockReset();
});

describe('integration builder save bar', () => {
  const saved = () => ({
    instanceId: 'orders',
    name: { en: 'Orders' },
    source: 'http',
    auth: { mode: 'none' },
    http: { baseUrl: 'https://erp.example.com' },
    actions: [{ name: 'a', request: { method: 'GET', url: '/a' }, sideEffect: 'read' }]
  });

  function renderPage(path) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/admin/integrations/builder/:instanceId"
            element={<AdminIntegrationBuilderPage />}
          />
          <Route path="/admin/integrations/:instanceId" element={<p>installation page</p>} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('shows no bar until something changed, and hides it when the change is reverted', async () => {
    mockApi.fetchBuilderDraft.mockResolvedValue(saved());
    await act(async () => {
      renderPage('/admin/integrations/builder/orders');
    });
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();

    const name = screen.getAllByRole('textbox')[0];
    fireEvent.change(name, { target: { value: 'Orders 2' } });
    expect(screen.getByRole('button', SAVE)).toBeInTheDocument();

    fireEvent.change(name, { target: { value: 'Orders' } });
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();
  });

  it('Discard restores the saved draft', async () => {
    mockApi.fetchBuilderDraft.mockResolvedValue(saved());
    await act(async () => {
      renderPage('/admin/integrations/builder/orders');
    });
    const name = screen.getAllByRole('textbox')[0];
    fireEvent.change(name, { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: /Discard/ }));

    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Orders');
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();
  });

  it('a new integration shows the bar on the first change, labelled Create', async () => {
    mockApi.createCustomIntegration.mockResolvedValue({ instance: { id: 'orders' } });
    await act(async () => {
      renderPage('/admin/integrations/builder/new');
    });
    expect(screen.queryByRole('button', CREATE)).not.toBeInTheDocument();

    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Orders' } });
    expect(screen.getByRole('button', CREATE)).toBeInTheDocument();
  });

  it('a refused save stays in the bar and keeps the draft for a retry', async () => {
    mockApi.fetchBuilderDraft.mockResolvedValue(saved());
    mockApi.saveCustomIntegration.mockRejectedValueOnce(new Error('The integration is not valid'));
    await act(async () => {
      renderPage('/admin/integrations/builder/orders');
    });
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Orders 2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', SAVE));
    });

    expect(screen.getByText('The integration is not valid')).toBeInTheDocument();
    expect(screen.getByRole('button', SAVE)).toBeEnabled();
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Orders 2');
  });
});

describe('scheduled tasks settings save bar', () => {
  const SETTINGS = {
    enabled: true,
    memoryEnabled: true,
    maxTasksPerUser: 10,
    minIntervalMinutes: 15,
    maxConcurrentRuns: 4,
    maxConcurrentRunsPerUser: 2,
    staggerMinutes: 0,
    catchUpWindowHours: 24,
    maxConsecutiveFailures: 5,
    approvalTimeoutHours: 24,
    runRetentionDays: 30,
    maxRunsPerTask: 100,
    maxRunChatsPerTask: 20,
    maxInstructionLength: 8000,
    maxRunMinutes: 10,
    memoryMaxChars: 8000,
    maxHistoryReadChars: 8000
  };

  function mockServer({ failPut = false } = {}) {
    makeAdminApiCall.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/scheduled-tasks/settings' && options.method === 'PUT') {
        if (failPut) throw new Error('Storage unavailable');
        return { data: { settings: { ...SETTINGS, ...options.body }, changed: ['x'] } };
      }
      return { data: { items: [], settings: SETTINGS } };
    });
  }

  async function renderPage() {
    await act(async () => {
      render(
        <MemoryRouter>
          <AdminScheduledTasksPage />
        </MemoryRouter>
      );
    });
  }

  it('shows the bar after an edit, counting the saved value typed back as unchanged', async () => {
    mockServer();
    await renderPage();
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();

    const limit = screen.getByLabelText('Tasks per user');
    fireEvent.change(limit, { target: { value: '11' } });
    expect(screen.getByRole('button', SAVE)).toBeInTheDocument();

    // The input holds text; "10" is the saved number 10.
    fireEvent.change(limit, { target: { value: '10' } });
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();
  });

  it('Discard restores the saved limits', async () => {
    mockServer();
    await renderPage();
    fireEvent.change(screen.getByLabelText('Tasks per user'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /Discard/ }));

    expect(screen.getByLabelText('Tasks per user')).toHaveValue(10);
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();
  });

  it('saves from the bar and hides it afterwards', async () => {
    mockServer();
    await renderPage();
    fireEvent.change(screen.getByLabelText('Tasks per user'), { target: { value: '12' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', SAVE));
    });

    const put = makeAdminApiCall.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(put[1].body.maxTasksPerUser).toBe(12);
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();
  });

  it('a failed save is reported in the bar and can be retried', async () => {
    mockServer({ failPut: true });
    await renderPage();
    fireEvent.change(screen.getByLabelText('Tasks per user'), { target: { value: '12' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', SAVE));
    });

    expect(screen.getByText('Storage unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', SAVE)).toBeEnabled();
  });

  it('Enter in a field saves like the bar', async () => {
    mockServer();
    await renderPage();
    fireEvent.change(screen.getByLabelText('Tasks per user'), { target: { value: '12' } });
    expect(screen.getByTestId('implicit-submit')).toBeEnabled();
  });
});
