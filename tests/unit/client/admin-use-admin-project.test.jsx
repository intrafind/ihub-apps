// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `useAdminProject` (#1036): React Router keeps the admin editor mounted when
 * only `:projectId` changes, so the hook has to drop project A the moment the
 * id changes. Otherwise a failed load of B leaves A's settings editable under
 * B's URL, and a late answer for A must not land on B either.
 */
import { act, renderHook } from '@testing-library/react';

const pending = {};
const mockFetch = jest.fn(
  id =>
    new Promise((resolve, reject) => {
      pending[id] = { resolve, reject };
    })
);

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminProject: (...args) => mockFetch(...args),
  getAdminApiErrorMessage: err => err?.message ?? 'error'
}));

const { useAdminProject } = require('../../../client/src/features/admin/hooks/useAdminProject');
const {
  ITEM_POLL_INTERVAL_MS
} = require('../../../client/src/features/projects/utils/projectItems');

beforeEach(() => {
  mockFetch.mockClear();
  for (const key of Object.keys(pending)) delete pending[key];
});

test('drops project A as soon as the id changes to B', async () => {
  const { result, rerender } = renderHook(({ id }) => useAdminProject(id), {
    initialProps: { id: 'prj_a' }
  });

  await act(async () => {
    pending.prj_a.resolve({ id: 'prj_a', items: [] });
  });
  expect(result.current.project).toEqual({ id: 'prj_a', items: [] });
  expect(result.current.loading).toBe(false);

  rerender({ id: 'prj_b' });
  expect(result.current.project).toBeNull();
  expect(result.current.error).toBeNull();
  expect(result.current.loading).toBe(true);

  await act(async () => {
    pending.prj_b.resolve({ id: 'prj_b', items: [] });
  });
  expect(result.current.project).toEqual({ id: 'prj_b', items: [] });
  expect(result.current.loading).toBe(false);
});

test("a failed load of B shows B's error, not A's project", async () => {
  const { result, rerender } = renderHook(({ id }) => useAdminProject(id), {
    initialProps: { id: 'prj_a' }
  });
  await act(async () => {
    pending.prj_a.resolve({ id: 'prj_a', items: [] });
  });

  rerender({ id: 'prj_b' });
  await act(async () => {
    pending.prj_b.reject(new Error('Project not found'));
  });
  expect(result.current.project).toBeNull();
  expect(result.current.error).toBe('Project not found');
  expect(result.current.loading).toBe(false);
});

test("a late answer for A does not land on B's page", async () => {
  const { result, rerender } = renderHook(({ id }) => useAdminProject(id), {
    initialProps: { id: 'prj_a' }
  });

  rerender({ id: 'prj_b' });
  await act(async () => {
    pending.prj_a.resolve({ id: 'prj_a', items: [] });
  });
  expect(result.current.project).toBeNull();
  expect(result.current.loading).toBe(true);

  await act(async () => {
    pending.prj_b.resolve({ id: 'prj_b', items: [] });
  });
  expect(result.current.project).toEqual({ id: 'prj_b', items: [] });
});

test('keeps polling while an item is being refreshed', async () => {
  jest.useFakeTimers();
  try {
    const { result } = renderHook(() => useAdminProject('prj_a'));
    const refreshing = { id: 'itm_1', status: 'ready', refreshingAt: '2026-01-01T00:00:00Z' };
    await act(async () => {
      pending.prj_a.resolve({ id: 'prj_a', items: [refreshing] });
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The refresh outlasts the first read: the next poll picks up the new text.
    await act(async () => {
      jest.advanceTimersByTime(ITEM_POLL_INTERVAL_MS);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const done = { id: 'itm_1', status: 'ready', refreshingAt: null, text: { chars: 9 } };
    await act(async () => {
      pending.prj_a.resolve({ id: 'prj_a', items: [done] });
    });
    expect(result.current.project.items[0]).toEqual(done);

    // Settled: no further polls.
    await act(async () => {
      jest.advanceTimersByTime(ITEM_POLL_INTERVAL_MS * 2);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});
