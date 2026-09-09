import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../../../client/src/api', () => ({ fetchApps: jest.fn() }));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: jest.fn()
}));

import { fetchApps } from '../../../client/src/api';
import { useAuth } from '../../../client/src/shared/contexts/AuthContext';
import useApps, { invalidateAppsCache } from '../../../client/src/shared/hooks/useApps';

/**
 * useApps backs the sidebar, the start page and the apps browser with ONE
 * shared request per user and keeps all mounted consumers in sync. These
 * tests pin that contract.
 */

const APPS = [{ id: 'chat' }, { id: 'translator' }];
const authed = { user: { id: 'u1' }, isAuthenticated: true, isLoading: false };

beforeEach(() => {
  invalidateAppsCache();
  fetchApps.mockReset();
  useAuth.mockReturnValue(authed);
});

test('two consumers mounted together issue a single request', async () => {
  fetchApps.mockResolvedValue(APPS);
  const sidebar = renderHook(() => useApps());
  const startPage = renderHook(() => useApps());

  await waitFor(() => expect(sidebar.result.current.loading).toBe(false));
  await waitFor(() => expect(startPage.result.current.loading).toBe(false));

  expect(fetchApps).toHaveBeenCalledTimes(1);
  expect(sidebar.result.current.apps).toEqual(APPS);
  expect(startPage.result.current.apps).toEqual(APPS);
});

test('does not fetch while authentication is still resolving', async () => {
  useAuth.mockReturnValue({ user: null, isAuthenticated: false, isLoading: true });
  fetchApps.mockResolvedValue(APPS);
  const { result, rerender } = renderHook(() => useApps());

  expect(result.current.loading).toBe(true);
  expect(fetchApps).not.toHaveBeenCalled();

  useAuth.mockReturnValue(authed);
  rerender();
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(fetchApps).toHaveBeenCalledTimes(1);
});

test('a failed request surfaces error and leaves the cache empty for the next consumer', async () => {
  fetchApps.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(APPS);
  const first = renderHook(() => useApps());
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  expect(first.result.current.error).toBeInstanceOf(Error);
  expect(first.result.current.apps).toEqual([]);

  const second = renderHook(() => useApps());
  await waitFor(() => expect(second.result.current.apps).toEqual(APPS));
  expect(fetchApps).toHaveBeenCalledTimes(2);
});

test('invalidating the cache refetches and updates every mounted consumer', async () => {
  fetchApps.mockResolvedValueOnce(APPS).mockResolvedValueOnce([...APPS, { id: 'new' }]);
  const sidebar = renderHook(() => useApps());
  const list = renderHook(() => useApps());
  await waitFor(() => expect(list.result.current.apps).toEqual(APPS));

  act(() => {
    invalidateAppsCache();
  });

  await waitFor(() => expect(sidebar.result.current.apps).toHaveLength(3));
  expect(list.result.current.apps).toHaveLength(3);
  expect(fetchApps).toHaveBeenCalledTimes(2);
});

test('a different user gets a fresh request', async () => {
  fetchApps.mockResolvedValueOnce(APPS).mockResolvedValueOnce([{ id: 'other' }]);
  const { result, rerender } = renderHook(() => useApps());
  await waitFor(() => expect(result.current.apps).toEqual(APPS));

  useAuth.mockReturnValue({ user: { id: 'u2' }, isAuthenticated: true, isLoading: false });
  rerender();
  await waitFor(() => expect(result.current.apps).toEqual([{ id: 'other' }]));
  expect(fetchApps).toHaveBeenCalledTimes(2);
});
