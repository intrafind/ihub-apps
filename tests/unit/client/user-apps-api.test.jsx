// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The personal apps API module (`api/endpoints/userApps.js`): what it hands
 * on of the server's answers. Drives the real helpers against a real axios
 * instance and answers in the adapter, as admin-projects-api.test.jsx does.
 */

jest.mock('../../../client/src/api/client.js', () => {
  const realAxios = jest.requireActual('axios');
  return {
    apiClient: realAxios.create({
      baseURL: '/api',
      headers: { 'Content-Type': 'application/json' },
      withCredentials: true
    })
  };
});

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: p => `/api/${p}`,
  buildPath: p => p,
  buildAssetUrl: p => p
}));

import { apiClient } from '../../../client/src/api/client.js';
import { fetchUserAppShareTargets } from '../../../client/src/api/endpoints/userApps.js';

function answer(data) {
  const requests = [];
  apiClient.defaults.adapter = config => {
    requests.push({ url: config.url, params: config.params });
    return Promise.resolve({ data, status: 200, headers: {}, config });
  };
  return requests;
}

describe('the share targets of a personal app', () => {
  test('hand on which kinds of target the installation allows', async () => {
    const requests = answer({
      allowed: { user: false, group: false, everyone: true },
      users: [],
      groups: [],
      everyone: true
    });
    const targets = await fetchUserAppShareTargets({ q: 'be' });
    expect(requests[0]).toEqual({ url: '/apps/_share-targets', params: { q: 'be' } });
    // Without `allowed` the share dialog would offer a search that can never find anyone.
    expect(targets).toEqual({
      allowed: { user: false, group: false, everyone: true },
      users: [],
      groups: [],
      everyone: true
    });
  });

  test('an answer without `allowed` says so with null', async () => {
    answer({ users: [{ id: 'ben', name: 'Ben' }], groups: [], everyone: false });
    const targets = await fetchUserAppShareTargets();
    expect(targets.allowed).toBeNull();
    expect(targets.users).toEqual([{ id: 'ben', name: 'Ben' }]);
  });
});
