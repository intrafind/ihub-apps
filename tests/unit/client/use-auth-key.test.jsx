import { renderHook } from '@testing-library/react';

jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: jest.fn()
}));

import { useAuth } from '../../../client/src/shared/contexts/AuthContext';
import useAuthKey from '../../../client/src/shared/hooks/useAuthKey';

/**
 * useAuthKey identifies the viewer for permission-scoped lists (apps, models).
 * The start page and useApps key their fetches on it so a sidebar sign-in
 * reloads the lists instead of keeping the anonymous ones.
 */

test('is null while authentication is resolving', () => {
  useAuth.mockReturnValue({ user: null, isAuthenticated: false, isLoading: true });
  const { result } = renderHook(() => useAuthKey());
  expect(result.current).toBeNull();
});

test('distinguishes anonymous from signed-in viewers and changes on sign-in', () => {
  useAuth.mockReturnValue({ user: { id: 'anonymous' }, isAuthenticated: false, isLoading: false });
  const { result, rerender } = renderHook(() => useAuthKey());
  const anon = result.current;
  expect(anon).toBe('anon:anonymous');

  useAuth.mockReturnValue({ user: { id: 'admin' }, isAuthenticated: true, isLoading: false });
  rerender();
  expect(result.current).toBe('auth:admin');
  expect(result.current).not.toBe(anon);
});

test('is stable across re-renders for the same viewer', () => {
  useAuth.mockReturnValue({ user: { id: 'u1' }, isAuthenticated: true, isLoading: false });
  const { result, rerender } = renderHook(() => useAuthKey());
  const first = result.current;
  rerender();
  expect(result.current).toBe(first);
});
