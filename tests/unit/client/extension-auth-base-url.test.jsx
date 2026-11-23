// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

jest.mock('../../../client/src/api/client', () => ({
  apiClient: { defaults: {} },
  streamingApiClient: { defaults: {} }
}));
jest.mock('../../../client/src/features/office/api/officeAuthBridge', () => ({
  installOfficeAuthInterceptor: jest.fn()
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  setApiBaseUrlOverride: jest.fn()
}));

import { apiClient, streamingApiClient } from '../../../client/src/api/client';
import { installOfficeAuthInterceptor } from '../../../client/src/features/office/api/officeAuthBridge';
import { setApiBaseUrlOverride } from '../../../client/src/utils/runtimeBasePath';
import { installExtensionAuth } from '../../../client/src/features/extension/installExtensionAuth';

const mockApiClient = apiClient;
const mockStreamingClient = streamingApiClient;
const mockSetOverride = setApiBaseUrlOverride;
const mockInstallInterceptor = installOfficeAuthInterceptor;

const configFor = baseUrl => ({ baseUrl, clientId: 'c', redirectUri: 'https://x.invalid/cb' });

describe('installExtensionAuth base URL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApiClient.defaults = {};
    mockStreamingClient.defaults = {};
  });

  it.each([
    ['https://ihub.example.com', 'https://ihub.example.com'],
    ['https://ihub.example.com/ihub/', 'https://ihub.example.com/ihub'],
    // A proxy chain once baked "https,https://host" into the packaged config.
    ['https,https://ihub.example.com', 'https://ihub.example.com']
  ])('points both clients at %p', (raw, expected) => {
    installExtensionAuth(configFor(raw));
    expect(mockApiClient.defaults.baseURL).toBe(`${expected}/api`);
    expect(mockStreamingClient.defaults.baseURL).toBe(`${expected}/api`);
    expect(mockSetOverride).toHaveBeenCalledWith(expected);
    expect(mockInstallInterceptor).toHaveBeenCalled();
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', '/api', 'ihub.example.com', '', undefined])(
    'refuses %p without touching the clients or installing the interceptor',
    raw => {
      expect(() => installExtensionAuth(configFor(raw))).toThrow('not a valid http(s) URL');
      expect(mockApiClient.defaults.baseURL).toBeUndefined();
      expect(mockSetOverride).not.toHaveBeenCalled();
      expect(mockInstallInterceptor).not.toHaveBeenCalled();
    }
  );
});
