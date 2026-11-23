// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Provider (create, edit) and short link editors: the sticky save bar is absent until
 * something changes, says Create for a new resource, and Discard restores the saved state.
 * The real unsaved-changes hook decides what is a change.
 */

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  fetchAdminApps: jest.fn(async () => []),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({ getBasePath: () => '' }));
jest.mock('../../../client/src/features/admin/hooks/useAdminPageAccess', () => ({
  __esModule: true,
  default: () => ({ models: true })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => <nav data-testid="breadcrumb" />
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

const AdminProviderCreatePage =
  require('../../../client/src/features/admin/pages/AdminProviderCreatePage').default;
const AdminProviderEditPage =
  require('../../../client/src/features/admin/pages/AdminProviderEditPage').default;
const AdminShortLinkEditPage =
  require('../../../client/src/features/admin/pages/AdminShortLinkEditPage').default;

const bar = () => screen.queryByRole('region', { name: 'Save changes' });
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function renderAt(path) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/providers/new" element={<AdminProviderCreatePage />} />
        <Route path="/admin/providers/:providerId" element={<AdminProviderEditPage />} />
        <Route path="/admin/shortlinks/:code" element={<AdminShortLinkEditPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async url => {
    if (url === '/admin/providers/gw') {
      return {
        data: { id: 'gw', name: 'Gateway', description: '', enabled: true, category: 'llm' }
      };
    }
    if (url === '/shortlinks/abc') {
      return { data: { code: 'abc', appId: '', path: '', url: '', params: { a: '1' } } };
    }
    if (url === '/admin/models') return { data: { items: [] } };
    if (url === '/admin/llm-timeouts') return { data: {} };
    return { data: {} };
  });
});

describe('new provider', () => {
  test('no bar until a change; then Create; Discard empties the form', async () => {
    renderAt('/admin/providers/new');
    expect(bar()).toBeNull();

    const name = screen.getByRole('textbox', { name: /Name/ });
    fireEvent.change(name, { target: { value: 'My gateway' } });

    expect(within(bar()).getByRole('button', { name: 'Create' })).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }));

    expect(screen.getByRole('textbox', { name: /Name/ })).toHaveValue('');
    expect(bar()).toBeNull();
  });
});

describe('existing provider', () => {
  test('no bar until a change; then Save Changes; Discard restores the stored name', async () => {
    renderAt('/admin/providers/gw');
    const name = await screen.findByDisplayValue('Gateway');
    expect(bar()).toBeNull();

    fireEvent.change(name, { target: { value: 'Gateway 2' } });

    expect(within(bar()).getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }));

    expect(screen.getByDisplayValue('Gateway')).toBeInTheDocument();
    expect(bar()).toBeNull();
  });

  test('the bar saves through the form: the provider is sent with a PUT', async () => {
    renderAt('/admin/providers/gw');
    fireEvent.change(await screen.findByDisplayValue('Gateway'), {
      target: { value: 'Gateway 2' }
    });

    const buttons = within(bar()).getAllByRole('button');
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });

    const put = mockMakeAdminApiCall.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(put[0]).toBe('/admin/providers/gw');
    expect(put[1].body.name).toBe('Gateway 2');
  });
});

describe('short link', () => {
  test('a new link: no bar until the params change (they are not part of the link); Discard resets them', async () => {
    renderAt('/admin/shortlinks/new');
    await settle();
    expect(bar()).toBeNull();

    fireEvent.change(screen.getByLabelText('Params (JSON)'), { target: { value: '{"x":1}' } });

    expect(within(bar()).getByRole('button', { name: 'Create' })).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }));

    expect(screen.getByLabelText('Params (JSON)')).toHaveValue('{}');
    expect(bar()).toBeNull();
  });

  test('an existing link: Save Changes appears with a params edit; Discard restores the stored params', async () => {
    renderAt('/admin/shortlinks/abc');
    await settle();
    const stored = screen.getByLabelText('Params (JSON)').value;
    expect(JSON.parse(stored)).toEqual({ a: '1' });
    expect(bar()).toBeNull();

    fireEvent.change(screen.getByLabelText('Params (JSON)'), { target: { value: '{"a":"2"}' } });
    expect(within(bar()).getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Params (JSON)')).toHaveValue(stored);
    expect(bar()).toBeNull();
  });
});
