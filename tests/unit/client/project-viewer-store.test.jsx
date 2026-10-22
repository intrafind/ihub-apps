// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `createViewerStore` (#1036) backs the project list and the projects
 * configuration (with its creation quota). `invalidate()` starts a
 * replacement request while an older one may still be out; when the two
 * answer out of order, the older answer must neither land in the cache nor
 * replace what a consumer shows — or creating a project while the first list
 * request is pending hides the new project again.
 */
import { act, renderHook } from '@testing-library/react';

const { createViewerStore } = require('../../../client/src/features/projects/hooks/projectStore');

/** A loader whose every call stays out until the test settles it. */
function deferredLoader() {
  const calls = [];
  const load = jest.fn(
    () =>
      new Promise((resolve, reject) => {
        calls.push({ resolve, reject });
      })
  );
  return { load, calls };
}

test('an answer superseded by invalidate() neither reaches the consumer nor the cache', async () => {
  const { load, calls } = deferredLoader();
  const store = createViewerStore(load);
  const { result } = renderHook(() => store.use('auth:u1', true));
  expect(load).toHaveBeenCalledTimes(1);

  // A project is created while the first list request is out.
  act(() => store.invalidate());
  expect(load).toHaveBeenCalledTimes(2);

  // The replacement answers first…
  await act(async () => {
    calls[1].resolve(['old', 'new']);
  });
  expect(result.current.data).toEqual(['old', 'new']);
  expect(result.current.loading).toBe(false);

  // …then the initial request, with the list from before the create.
  await act(async () => {
    calls[0].resolve(['old']);
  });
  expect(result.current.data).toEqual(['old', 'new']);

  // A consumer mounted now reads the newer answer from the cache.
  const later = renderHook(() => store.use('auth:u1', true));
  expect(later.result.current.data).toEqual(['old', 'new']);
  expect(load).toHaveBeenCalledTimes(2);
});

test('a superseded request that fails leaves the newer answer alone', async () => {
  const { load, calls } = deferredLoader();
  const store = createViewerStore(load);
  const { result } = renderHook(() => store.use('auth:u1', true));

  act(() => store.invalidate());
  await act(async () => {
    calls[1].resolve(['fresh']);
  });
  await act(async () => {
    calls[0].reject(new Error('network'));
  });

  expect(result.current.error).toBeNull();
  expect(result.current.data).toEqual(['fresh']);
});

test('the consumer waits for the newer request when the superseded one answers first', async () => {
  const { load, calls } = deferredLoader();
  const store = createViewerStore(load);
  const { result } = renderHook(() => store.use('auth:u1', true));

  act(() => store.invalidate());
  await act(async () => {
    calls[0].resolve(['stale']);
  });
  expect(result.current.data).toBeUndefined();
  expect(result.current.loading).toBe(true);

  await act(async () => {
    calls[1].resolve(['fresh']);
  });
  expect(result.current.data).toEqual(['fresh']);
  expect(result.current.loading).toBe(false);
});
