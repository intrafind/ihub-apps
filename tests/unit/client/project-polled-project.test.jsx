// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `usePolledProject` (#1036): React Router keeps the project page mounted
 * when only `:projectId` changes, so the hook itself has to drop the previous
 * project the moment the id changes — or the old project's items (and their
 * destructive actions) would show under the new URL until it loads, or for
 * good when it fails.
 */
import { act, renderHook } from '@testing-library/react';

const {
  usePolledProject
} = require('../../../client/src/features/projects/hooks/usePolledProject');

/** A loader whose answer for each id stays out until the test settles it. */
function deferredLoader() {
  const pending = {};
  const load = jest.fn(
    id =>
      new Promise((resolve, reject) => {
        pending[id] = { resolve, reject };
      })
  );
  return { load, pending };
}

test('shows nothing of project A while project B is loading', async () => {
  const { load, pending } = deferredLoader();
  const errorMessage = err => err.message;
  const { result, rerender } = renderHook(
    ({ id }) => usePolledProject(id, { load, errorMessage }),
    {
      initialProps: { id: 'prj_a' }
    }
  );

  await act(async () => {
    pending.prj_a.resolve({ id: 'prj_a', items: [{ id: 'itm_1', status: 'ready' }] });
  });
  expect(result.current.project).toEqual(expect.objectContaining({ id: 'prj_a' }));
  expect(result.current.loading).toBe(false);

  rerender({ id: 'prj_b' });
  expect(result.current.project).toBeNull();
  expect(result.current.loading).toBe(true);
  expect(result.current.error).toBeNull();

  await act(async () => {
    pending.prj_b.resolve({ id: 'prj_b', items: [] });
  });
  expect(result.current.project).toEqual({ id: 'prj_b', items: [] });
  expect(result.current.loading).toBe(false);
});
