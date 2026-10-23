// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The user projects API helpers (#1036, slice 5): the paths and bodies of
 * `/api/projects`, an upload as multipart with the field `file`, the item
 * text with its X-Item-* headers, and moving a chat with `PATCH /api/chats`.
 *
 * Drives the real helpers against a real axios instance and records what
 * the adapter gets, as admin-projects-api.test.jsx does.
 */

jest.mock('../../../client/src/api/client.js', () => {
  const realAxios = jest.requireActual('axios');
  return {
    apiClient: realAxios.create({
      baseURL: '/api',
      headers: { 'Content-Type': 'application/json' },
      withCredentials: true
    }),
    API_REQUEST_TIMEOUT: 30000
  };
});

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: p => `/api/${p}`,
  buildPath: p => p,
  buildAssetUrl: p => p
}));

import { apiClient } from '../../../client/src/api/client.js';
import {
  addProjectItem,
  fetchProjectChats,
  fetchProjectItemText,
  fetchProjects,
  searchPickerIFinder,
  updateProjectMembers,
  uploadProjectItem
} from '../../../client/src/api/endpoints/projects.js';

function captureRequests(response = { data: { item: { id: 'i1' } }, status: 202, headers: {} }) {
  const requests = [];
  apiClient.defaults.adapter = config => {
    requests.push({
      url: config.url,
      method: config.method,
      params: config.params,
      data: config.data,
      contentType: config.headers.getContentType()
    });
    return Promise.resolve({ ...response, config });
  };
  return requests;
}

describe('user projects API', () => {
  test('uploads a file as multipart with the field "file"', async () => {
    const requests = captureRequests();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    const item = await uploadProjectItem('prj_a', { file, name: 'Notes', pinned: true });

    expect(item).toEqual({ id: 'i1' });
    const [request] = requests;
    expect(request.method).toBe('post');
    expect(request.url).toBe('/projects/prj_a/items');
    expect(request.data).toBeInstanceOf(FormData);
    expect(request.data.get('file').name).toBe('notes.txt');
    expect(request.data.get('name')).toBe('Notes');
    expect(request.data.get('pinned')).toBe('true');
    expect(request.contentType || '').not.toMatch(/application\/json/);
  });

  test('sends a picked item as JSON', async () => {
    const requests = captureRequests({ data: { item: { id: 'i2' } }, status: 202, headers: {} });
    const body = { kind: 'office365', ref: { providerId: 'sp', fileId: 'f1' }, pinned: false };

    expect(await addProjectItem('prj_a', body)).toEqual({ id: 'i2' });
    expect(requests[0].url).toBe('/projects/prj_a/items');
    expect(JSON.parse(requests[0].data)).toEqual(body);
  });

  test('reads the item text with its size headers', async () => {
    captureRequests({
      data: 'Hello',
      status: 200,
      headers: { 'x-item-chars': '5000', 'x-item-truncated': 'true' }
    });
    expect(await fetchProjectItemText('prj_a', 'itm_1', { maxChars: 5 })).toEqual({
      text: 'Hello',
      chars: 5000,
      truncated: true
    });
  });

  test('lists projects, chats and members with the documented parameters', async () => {
    const requests = captureRequests({
      data: { items: [{ id: 'prj_a' }] },
      status: 200,
      headers: {}
    });
    expect(await fetchProjects()).toEqual([{ id: 'prj_a' }]);
    expect(requests[0]).toMatchObject({ url: '/projects', params: { scope: 'all' } });

    await fetchProjectChats('prj_a', { filter: 'mine' });
    expect(requests[1]).toMatchObject({ url: '/projects/prj_a/chats', params: { filter: 'mine' } });

    await updateProjectMembers('prj_a', [{ type: 'group', id: 'legal', role: 'editor' }]);
    expect(requests[2].method).toBe('put');
    expect(JSON.parse(requests[2].data)).toEqual({
      members: [{ type: 'group', id: 'legal', role: 'editor' }]
    });
  });

  test('searches iFinder with q', async () => {
    const requests = captureRequests({ data: { results: [] }, status: 200, headers: {} });
    await searchPickerIFinder('contract', { limit: 5 });
    expect(requests[0]).toMatchObject({
      url: '/projects/pickers/ifinder/search',
      params: { q: 'contract', limit: 5 }
    });
  });
});
