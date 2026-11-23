// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Authentication saves through the shared bottom bar: no bar until a setting changed
 * (also one nested in a block), gone when it is put back or discarded, Save sends the whole
 * configuration, a failed save keeps the bar with the error next to it, and nothing is offered
 * while the configuration could not be loaded. Uses the real dirty tracking and the real form.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockApi(...args),
  listCredentials: jest.fn().mockResolvedValue([]),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  importBuilderActions: jest.fn()
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  getSchemaByType: jest.fn().mockResolvedValue({})
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {}, refreshConfig: jest.fn() })
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path
}));
jest.mock('../../../client/src/shared/components/MonacoJsonEditor', () => ({
  __esModule: true,
  default: () => <div data-testid="json-editor" />
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span />
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''))
        : key,
    i18n: { language: 'en' }
  })
}));

const AdminAuthPage = require('../../../client/src/features/admin/pages/AdminAuthPage').default;

const PLATFORM = {
  auth: { mode: 'local', authenticatedGroup: 'authenticated' },
  anonymousAuth: { enabled: false, defaultGroups: ['anonymous'] },
  localAuth: { enabled: true, sessionTimeoutMinutes: 480 },
  proxyAuth: { enabled: false },
  oidcAuth: { enabled: false, providers: [] }
};

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};
const bar = () => screen.queryByRole('region', { name: 'Save changes' });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
const discardButton = () => within(bar()).getByRole('button', { name: 'Discard' });
const timeout = value => screen.getByDisplayValue(String(value));
const writes = () => mockApi.mock.calls.filter(([, options]) => options?.method === 'POST');

const loadAs = platform =>
  mockApi.mockImplementation(async (url, options = {}) => {
    if (options.method === 'POST') return { data: {} };
    if (url === '/admin/configs/platform') return platform();
    if (url === '/admin/groups') return { data: { groups: {} } };
    throw new Error('not found');
  });

const renderPage = async () => {
  render(
    <MemoryRouter initialEntries={['/admin/auth']}>
      <Routes>
        <Route path="/admin/auth" element={<AdminAuthPage />} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
};

beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  jest.clearAllMocks();
  loadAs(async () => ({ data: PLATFORM }));
});

describe('Admin → Authentication save bar', () => {
  test('no bar after loading; a change nested in a block shows it, putting it back hides it', async () => {
    await renderPage();
    expect(timeout(480)).toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();

    // `localAuth.sessionTimeoutMinutes`: one value inside a block, nothing else changes.
    fireEvent.change(timeout(480), { target: { value: '60' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.change(timeout(60), { target: { value: '480' } });
    expect(bar()).not.toBeInTheDocument();
  });

  test('Discard puts the loaded value back and the bar goes away', async () => {
    await renderPage();
    fireEvent.change(timeout(480), { target: { value: '60' } });

    fireEvent.click(discardButton());

    expect(timeout(480)).toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save sends the whole configuration and the bar goes away', async () => {
    await renderPage();
    fireEvent.change(timeout(480), { target: { value: '60' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(writes()).toHaveLength(1);
    expect(writes()[0][1].body).toEqual({
      ...PLATFORM,
      localAuth: { ...PLATFORM.localAuth, sessionTimeoutMinutes: 60 }
    });
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-auth-message')).toHaveTextContent(
      'Authentication configuration saved.'
    );
  });

  test('a failed save keeps the bar and shows the error next to it; Discard clears both', async () => {
    mockApi.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') throw new Error('lockout refused');
      if (url === '/admin/configs/platform') return { data: PLATFORM };
      if (url === '/admin/groups') return { data: { groups: {} } };
      throw new Error('not found');
    });
    await renderPage();
    fireEvent.change(timeout(480), { target: { value: '60' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(within(bar()).getByText(/lockout refused/)).toBeInTheDocument();
    expect(screen.getByTestId('admin-auth-message')).toHaveTextContent('lockout refused');

    fireEvent.click(discardButton());
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-auth-message')).not.toBeInTheDocument();
  });

  test('after a failed save the bar stays when the field is put back, and Save sends it', async () => {
    let attempt = 0;
    mockApi.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') {
        attempt += 1;
        if (attempt === 1) throw new Error('response lost');
        return { data: {} };
      }
      if (url === '/admin/configs/platform') return { data: PLATFORM };
      if (url === '/admin/groups') return { data: { groups: {} } };
      throw new Error('not found');
    });
    await renderPage();
    fireEvent.change(timeout(480), { target: { value: '60' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();
    expect(within(bar()).getByText(/response lost/)).toBeInTheDocument();

    // The server may hold 60. Putting 480 back must still be savable.
    fireEvent.change(timeout(60), { target: { value: '480' } });
    expect(bar()).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(writes()).toHaveLength(2);
    expect(writes()[1][1].body).toEqual(PLATFORM);
    expect(bar()).not.toBeInTheDocument();
  });

  test('no bar, and nothing to save, when the configuration could not be loaded', async () => {
    loadAs(async () => {
      throw new Error('down');
    });
    await renderPage();
    expect(bar()).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });
});
