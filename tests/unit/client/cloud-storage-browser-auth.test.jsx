// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cloud file browser's "connect first" state: a browse request refused
 * with `409 INTEGRATION_AUTH_REQUIRED` keeps the reason and, for a missing
 * permission, the scopes the reconnect has to ask for, so the Connect card
 * shows the new permission and the reconnect requests it.
 */
import { renderHook, act } from '@testing-library/react';

const mockGet = jest.fn();
jest.mock('../../../client/src/api/client', () => ({
  apiClient: { get: (...args) => mockGet(...args) }
}));
jest.mock('../../../client/src/api/userIntegrationsApi', () => ({
  fetchUserIntegration: jest.fn(async () => null)
}));
jest.mock('../../../client/src/features/upload/utils/cloudFileProcessing', () => ({
  processCloudFile: jest.fn()
}));

const {
  useCloudStorageBrowser
} = require('../../../client/src/features/upload/hooks/useCloudStorageBrowser');

const adapter = {
  basePath: '/integrations/nextcloud',
  buildFolderQuery: () => ({}),
  buildDownloadQuery: () => ({}),
  buildBreadcrumbFromItem: () => ({}),
  buildBreadcrumbTarget: () => null,
  buildDriveBreadcrumb: () => ({}),
  initialFolderTarget: null
};

const refused = data => Object.assign(new Error('409'), { response: { status: 409, data } });

describe('useCloudStorageBrowser: a refused browse request', () => {
  beforeEach(() => mockGet.mockReset());

  test('keeps the scopes of insufficient_scope', async () => {
    mockGet.mockRejectedValueOnce(
      refused({
        code: 'INTEGRATION_AUTH_REQUIRED',
        details: { reason: 'insufficient_scope', scopes: ['files.read', '', 7] }
      })
    );
    const { result } = renderHook(() => useCloudStorageBrowser(adapter, { providerId: 'nc' }));
    await act(async () => {
      await result.current.loadSources();
    });
    expect(result.current.authStatus).toBe('not_connected');
    expect(result.current.authReason).toBe('insufficient_scope');
    expect(result.current.authScopes).toEqual(['files.read']);
  });

  test('has no scopes for a plain expired connection', async () => {
    mockGet.mockRejectedValueOnce(
      refused({ code: 'INTEGRATION_AUTH_REQUIRED', details: { reason: 'expired' } })
    );
    const { result } = renderHook(() => useCloudStorageBrowser(adapter, { providerId: 'nc' }));
    await act(async () => {
      await result.current.loadSources();
    });
    expect(result.current.authReason).toBe('expired');
    expect(result.current.authScopes).toEqual([]);
  });
});
