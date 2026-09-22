import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api', () => ({
  fetchAuthStatus: jest.fn(),
  invalidateAuthStatusCache: jest.fn()
}));
jest.mock('../../../client/src/api/client.js', () => ({
  apiClient: { get: jest.fn(), post: jest.fn() }
}));
jest.mock('../../../client/src/api/utils/cache', () => ({
  clearApiCache: jest.fn()
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: path => path,
  buildApiUrl: path => path,
  getApiBaseUrlOverride: () => null
}));

import { fetchAuthStatus, invalidateAuthStatusCache } from '../../../client/src/api';
import { apiClient } from '../../../client/src/api/client.js';
import { clearApiCache } from '../../../client/src/api/utils/cache';
import { AuthProvider, useAuth } from '../../../client/src/shared/contexts/AuthContext';

/**
 * AuthContext and PlatformConfigContext both need /auth/status on boot.
 * AuthContext used to call the endpoint directly, bypassing the shared cached
 * and deduplicated helper, so every page load, OIDC callback and token-expiry
 * check fired it twice (#1783). It now goes through `fetchAuthStatus()`, which
 * means anything that changes who is signed in has to drop the cached entry
 * first or the refetch hands back the old identity.
 */

const ANONYMOUS = {
  success: true,
  authenticated: false,
  authMode: 'local',
  anonymousAuth: { enabled: true },
  authMethods: { local: { enabled: true, showDemoAccounts: true } }
};
const SIGNED_IN = {
  ...ANONYMOUS,
  authenticated: true,
  user: { id: 'admin', name: 'Demo Administrator' }
};

function Probe() {
  const { user, isLoading, authConfig } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="user">{user?.id || 'none'}</span>
      <span data-testid="demo">{String(authConfig?.authMethods?.local?.showDemoAccounts)}</span>
    </div>
  );
}

const renderProbe = async () => {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
};

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
});

test('boot loads auth status through the shared cached helper', async () => {
  fetchAuthStatus.mockResolvedValue(SIGNED_IN);
  await renderProbe();

  expect(fetchAuthStatus).toHaveBeenCalledTimes(1);
  expect(apiClient.get).not.toHaveBeenCalledWith('/auth/status', expect.anything());
  expect(apiClient.get).not.toHaveBeenCalledWith('/auth/status');
  expect(screen.getByTestId('user')).toHaveTextContent('admin');
  expect(screen.getByTestId('demo')).toHaveTextContent('true');
});

test('an auth-gate login clears the API cache before refetching', async () => {
  fetchAuthStatus.mockResolvedValueOnce(ANONYMOUS).mockResolvedValueOnce(SIGNED_IN);
  await renderProbe();
  expect(screen.getByTestId('user')).toHaveTextContent('none');

  await act(async () => {
    window.dispatchEvent(new CustomEvent('authGateSuccess'));
  });

  await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('admin'));
  expect(clearApiCache).toHaveBeenCalledTimes(1);
  expect(clearApiCache.mock.invocationCallOrder[0]).toBeLessThan(
    fetchAuthStatus.mock.invocationCallOrder[1]
  );
});

test('an expired token drops the cached status before re-checking it', async () => {
  fetchAuthStatus.mockResolvedValueOnce(SIGNED_IN).mockResolvedValueOnce(ANONYMOUS);
  await renderProbe();
  expect(screen.getByTestId('user')).toHaveTextContent('admin');

  await act(async () => {
    window.dispatchEvent(new CustomEvent('authTokenExpired'));
  });

  await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'));
  expect(fetchAuthStatus).toHaveBeenCalledTimes(2);
  expect(invalidateAuthStatusCache).toHaveBeenCalledTimes(1);
  expect(invalidateAuthStatusCache.mock.invocationCallOrder[0]).toBeLessThan(
    fetchAuthStatus.mock.invocationCallOrder[1]
  );
  expect(apiClient.get).not.toHaveBeenCalled();
});
