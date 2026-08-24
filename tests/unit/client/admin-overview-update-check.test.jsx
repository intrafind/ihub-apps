/**
 * Regression tests for #2150: the admin homepage showed nothing but grey
 * animated skeleton boxes in deployments without outbound internet access.
 *
 * `useOverviewData` batched `/admin/version/check-update` — the only endpoint
 * that leaves the machine — into the same `Promise.allSettled` as the local
 * dashboard queries. `allSettled` settles when the *slowest* promise does, so a
 * request to an unreachable api.github.com held `isLoading` true indefinitely
 * and the whole dashboard stayed on its loading skeletons.
 *
 * The update check now runs on its own via `useUpdateCheck`, so these tests
 * pin: the dashboard finishes loading while the check is still pending, and the
 * check still reports its result (including across the server's `checking`
 * hand-off) once it arrives.
 */

import '@testing-library/jest-dom';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockMakeAdminApiCall = jest.fn();
const mockFetchAdminApps = jest.fn();
const mockFetchAdminPrompts = jest.fn();
const mockFetchAdminSources = jest.fn();

jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  fetchAdminApps: (...args) => mockFetchAdminApps(...args),
  fetchAdminPrompts: (...args) => mockFetchAdminPrompts(...args),
  fetchAdminSources: (...args) => mockFetchAdminSources(...args),
  getAdminApiErrorMessage: err => err?.message ?? 'error'
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, fallback) => fallback ?? key })
}));

import { useOverviewData } from '../../../client/src/features/admin/hooks/useOverviewData';
import { useUpdateCheck } from '../../../client/src/features/admin/hooks/useUpdateCheck';

const CHECK_UPDATE = '/admin/version/check-update';

beforeEach(() => {
  jest.useRealTimers();
  mockMakeAdminApiCall.mockReset();
  mockFetchAdminApps.mockReset();
  mockFetchAdminPrompts.mockReset();
  mockFetchAdminSources.mockReset();

  mockFetchAdminApps.mockResolvedValue([{ id: 'chat', enabled: true }]);
  mockFetchAdminPrompts.mockResolvedValue([]);
  mockFetchAdminSources.mockResolvedValue([]);
});

describe('useOverviewData', () => {
  test('finishes loading while the GitHub update check is still pending', async () => {
    // Never settles — an unreachable api.github.com behind the endpoint.
    mockMakeAdminApiCall.mockImplementation(url =>
      url === CHECK_UPDATE ? new Promise(() => {}) : Promise.resolve({ data: {} })
    );

    const { result } = renderHook(() => useOverviewData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stats).not.toBeNull();
  });

  test('does not request the update check at all', async () => {
    mockMakeAdminApiCall.mockResolvedValue({ data: {} });

    const { result } = renderHook(() => useOverviewData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockMakeAdminApiCall.mock.calls.map(([url]) => url)).not.toContain(CHECK_UPDATE);
  });

  test('still renders stats when a local endpoint fails', async () => {
    mockMakeAdminApiCall.mockImplementation(url =>
      url === '/admin/overview/stats'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ data: {} })
    );

    const { result } = renderHook(() => useOverviewData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stats.apps.value).toBe(1);
  });
});

describe('useUpdateCheck', () => {
  test('reports an available update', async () => {
    mockMakeAdminApiCall.mockResolvedValue({
      data: { updateAvailable: true, latestVersion: '9.9.9', checking: false }
    });

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.updateInfo?.updateAvailable).toBe(true));
    expect(result.current.updateInfo.latestVersion).toBe('9.9.9');
  });

  test('polls again while the server reports a check in flight', async () => {
    jest.useFakeTimers();
    mockMakeAdminApiCall
      .mockResolvedValueOnce({ data: { updateAvailable: false, checking: true } })
      .mockResolvedValueOnce({
        data: { updateAvailable: true, latestVersion: '9.9.9', checking: false }
      });

    const { result } = renderHook(() => useUpdateCheck());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.updateInfo).toMatchObject({ checking: true });

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    await waitFor(() => expect(result.current.updateInfo?.updateAvailable).toBe(true));
    expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2);
  });

  test('surfaces a failed check instead of throwing', async () => {
    mockMakeAdminApiCall.mockRejectedValue(new Error('Network Error'));

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.updateInfo?.error).toBe('Network Error'));
    expect(result.current.updateInfo.updateAvailable).toBe(false);
  });

  test('skips the request when disabled (content-admin-only users)', async () => {
    mockMakeAdminApiCall.mockResolvedValue({ data: { updateAvailable: true } });

    const { result } = renderHook(() => useUpdateCheck({ enabled: false }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockMakeAdminApiCall).not.toHaveBeenCalled();
    expect(result.current.updateInfo).toBeNull();
  });
});
