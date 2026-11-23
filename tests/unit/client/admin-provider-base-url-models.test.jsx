// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Provider edit page after a change of the base URL: the server moves the linked
 * models built from the old base URL (`modelUrls` of the PUT response). The page
 * says how many now use the new address, lists the linked models it left alone
 * with their URL, and stays open so the admin can read it.
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
    t: (key, fallback, options) =>
      typeof fallback === 'string'
        ? fallback.replace('{{count}}', String(options?.count ?? ''))
        : key,
    i18n: { language: 'en' }
  })
}));

const AdminProviderEditPage =
  require('../../../client/src/features/admin/pages/AdminProviderEditPage').default;
const {
  summarizeModelUrlChanges
} = require('../../../client/src/features/admin/utils/providerModelUrls');

const OLD_BASE = 'https://hub.example.com/v1';
const NEW_BASE = 'https://proxy.example.com/v2';

let putResponse;

beforeEach(() => {
  jest.useRealTimers();
  mockMakeAdminApiCall.mockReset();
  putResponse = { provider: {}, updatedModels: [], modelUrls: { updated: [], skipped: [] } };
  mockMakeAdminApiCall.mockImplementation(async (url, options) => {
    if (url === '/admin/providers/hub' && options?.method === 'PUT') return { data: putResponse };
    if (url === '/admin/providers/hub') {
      return {
        data: {
          id: 'hub',
          name: 'Hub',
          description: '',
          enabled: true,
          category: 'llm',
          apiType: 'openai',
          baseUrl: OLD_BASE
        }
      };
    }
    if (url === '/admin/models') {
      return {
        data: {
          items: [
            { id: 'hub-a', name: { en: 'Hub A' }, providerId: 'hub', enabled: true },
            { id: 'hub-b', name: { en: 'Hub B' }, providerId: 'hub', enabled: true },
            { id: 'hub-own', name: { en: 'Hub Own' }, providerId: 'hub', enabled: true }
          ]
        }
      };
    }
    if (url === '/admin/llm-timeouts') return { data: {} };
    return { data: {} };
  });
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/admin/providers/hub']}>
      <Routes>
        <Route path="/admin/providers/:providerId" element={<AdminProviderEditPage />} />
        <Route path="/admin/providers" element={<div>provider list</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function saveNewBaseUrl() {
  fireEvent.change(await screen.findByDisplayValue(OLD_BASE), { target: { value: NEW_BASE } });
  const bar = screen.getByRole('region', { name: 'Save changes' });
  const buttons = within(bar).getAllByRole('button');
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1]);
  });
}

describe('provider edit page after a base URL change', () => {
  test('says how many linked models now use the new address', async () => {
    putResponse.modelUrls = { updated: ['hub-a', 'hub-b'], skipped: [] };
    renderPage();
    await saveNewBaseUrl();

    expect(screen.getByText('2 linked models now use the new address.')).toBeInTheDocument();
    const put = mockMakeAdminApiCall.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(put[1].body.baseUrl).toBe(NEW_BASE);
  });

  test('lists a linked model it did not change, with its URL, and stays on the page', async () => {
    putResponse.modelUrls = {
      updated: ['hub-a'],
      skipped: [{ id: 'hub-own', url: 'https://own.example.com/v1/chat/completions' }]
    };
    renderPage();
    await saveNewBaseUrl();

    const notice = screen.getByRole('status');
    expect(within(notice).getByText(/now use the new address/)).toBeInTheDocument();
    expect(within(notice).getByText(/were not changed/)).toBeInTheDocument();
    expect(within(notice).getByRole('link', { name: 'Hub Own' })).toHaveAttribute(
      'href',
      '/admin/models/hub-own'
    );
    expect(
      within(notice).getByText('https://own.example.com/v1/chat/completions')
    ).toBeInTheDocument();

    // No redirect while there is something to read.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1700));
    });
    expect(screen.queryByText('provider list')).toBeNull();
  });

  test('shows no notice when the save moved no model', async () => {
    renderPage();
    await saveNewBaseUrl();
    expect(screen.queryByText(/now use the new address/)).toBeNull();
    expect(screen.queryByText(/were not changed/)).toBeNull();
  });
});

describe('summarizeModelUrlChanges', () => {
  test('is null when nothing changed or the field is missing', () => {
    expect(summarizeModelUrlChanges(undefined)).toBeNull();
    expect(summarizeModelUrlChanges({ updated: [], skipped: [] })).toBeNull();
  });

  test('keeps the moved ids and the models left alone', () => {
    expect(
      summarizeModelUrlChanges({ updated: ['a'], skipped: [{ id: 'b', url: 'https://x' }] })
    ).toEqual({ updated: ['a'], skipped: [{ id: 'b', url: 'https://x' }] });
  });
});
