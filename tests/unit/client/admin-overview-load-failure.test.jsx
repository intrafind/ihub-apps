// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
/**
 * SH-B2: when the apps request of the admin Overview fails (429, 5xx), the
 * dashboard used to turn into a "fresh install": apps 0, KPIs and activity gone,
 * the getting-started checklist shown, and no error. A failed request must never
 * yield `isFreshInstance`; it yields `loadError` and an in-place `retry()`.
 */

import '@testing-library/jest-dom';
import { act, renderHook, waitFor } from '@testing-library/react';

const mockMakeAdminApiCall = jest.fn();
const mockFetchAdminApps = jest.fn();
const mockFetchAdminPrompts = jest.fn();
const mockFetchAdminProjects = jest.fn();

jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  fetchAdminApps: (...args) => mockFetchAdminApps(...args),
  fetchAdminPrompts: (...args) => mockFetchAdminPrompts(...args),
  fetchAdminProjects: (...args) => mockFetchAdminProjects(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));

// A stable `t`, like the real one: the hook re-loads when `t` changes.
jest.mock('react-i18next', () => {
  const t = (key, fallback, values) =>
    typeof fallback === 'string'
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''))
      : key;
  return { __esModule: true, useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

jest.mock('../../../client/src/features/admin/hooks/useUpdateCheck', () => ({
  __esModule: true,
  useUpdateCheck: () => ({ updateInfo: null })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  __esModule: true,
  useUIConfig: () => ({ uiConfig: {} })
}));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ user: { isAdmin: true, permissions: { adminAccess: true } } })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: {} })
}));
jest.mock('../../../client/src/features/admin/components/AdminDemoAccountsAlert', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

import { useOverviewData } from '../../../client/src/features/admin/hooks/useOverviewData';

function rateLimited() {
  const err = new Error('Request failed with status code 429');
  err.response = {
    status: 429,
    data: { status: 429, code: 'RATE_LIMITED', detail: 'Too many requests' },
    headers: { 'retry-after': '5' }
  };
  return err;
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset().mockResolvedValue({ data: {} });
  mockFetchAdminApps.mockReset();
  mockFetchAdminPrompts.mockReset().mockResolvedValue([]);
  mockFetchAdminProjects.mockReset().mockResolvedValue([]);
});

describe('useOverviewData when the apps request fails', () => {
  test('is not a fresh install, and reports the error', async () => {
    mockFetchAdminApps.mockRejectedValue(rateLimited());

    const { result } = renderHook(() => useOverviewData());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isFreshInstance).toBe(false);
    expect(result.current.loadError).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    // No made-up "0 apps".
    expect(result.current.stats.apps.value).toBe('—');
  });

  test('also for a content admin', async () => {
    mockFetchAdminApps.mockRejectedValue(new Error('Network Error'));

    const { result } = renderHook(() => useOverviewData({ contentAdminOnly: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isFreshInstance).toBe(false);
    expect(result.current.loadError).toMatchObject({ status: null, detail: 'Network Error' });
  });

  test('retry() loads again in place and clears the error', async () => {
    mockFetchAdminApps
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce([{ id: 'chat', enabled: true }]);

    const { result } = renderHook(() => useOverviewData());
    await waitFor(() => expect(result.current.loadError).not.toBeNull());

    let retried;
    act(() => {
      retried = result.current.retry();
    });
    await waitFor(() => expect(result.current.loadError).toBeNull());
    await act(() => retried); // the promise settles once the attempt finished

    expect(mockFetchAdminApps).toHaveBeenCalledTimes(2);
    expect(result.current.stats.apps.value).toBe(1);
    expect(result.current.isFreshInstance).toBe(false);
  });

  test('a loaded, empty apps list is still a fresh install', async () => {
    mockFetchAdminApps.mockResolvedValue([]);

    const { result } = renderHook(() => useOverviewData());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isFreshInstance).toBe(true);
    expect(result.current.loadError).toBeNull();
  });
});

describe('AdminOverview with a failed apps request', () => {
  test('shows the error with Retry instead of the getting-started checklist', async () => {
    const { render, screen, fireEvent } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    mockFetchAdminApps.mockRejectedValue(rateLimited());
    // The other dashboard requests answer, without platform details.
    mockMakeAdminApiCall.mockResolvedValue({ data: null });

    const { default: AdminOverview } =
      await import('../../../client/src/features/admin/pages/AdminOverview');
    render(
      <MemoryRouter>
        <AdminOverview />
      </MemoryRouter>
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the overview");
    expect(screen.queryByText('Platform installed')).not.toBeInTheDocument();

    mockFetchAdminApps.mockResolvedValue([{ id: 'chat', enabled: true }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mockFetchAdminApps).toHaveBeenCalledTimes(2);
  });
});
