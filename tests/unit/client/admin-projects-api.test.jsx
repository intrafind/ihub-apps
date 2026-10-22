// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin projects API helpers (#1036): a file upload leaves the browser as
 * multipart with the field `file` (plus `name` and `pinned`), JSON items go
 * out as JSON, and the text preview reads the X-Item-* headers.
 *
 * Drives the real helpers against a real axios instance, as
 * admin-api-call-formdata.test.jsx does, and records what the adapter gets.
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
import {
  addAdminProjectItem,
  fetchAdminProjectItemText,
  toggleAdminProjects,
  uploadAdminProjectItem
} from '../../../client/src/api/adminApi.js';

function captureRequests(response = { data: { item: { id: 'i1' } }, status: 202, headers: {} }) {
  const requests = [];
  apiClient.defaults.adapter = config => {
    requests.push({
      url: config.url,
      method: config.method,
      data: config.data,
      contentType: config.headers.getContentType()
    });
    return Promise.resolve({ ...response, config });
  };
  return requests;
}

describe('admin projects API', () => {
  test('uploads a file as multipart with the field "file"', async () => {
    const requests = captureRequests();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    const item = await uploadAdminProjectItem('handbook', { file, name: 'Notes', pinned: true });

    expect(item).toEqual({ id: 'i1' });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.method).toBe('post');
    expect(request.url).toBe('/admin/projects/handbook/items');
    expect(request.data).toBeInstanceOf(FormData);
    expect(request.data.get('file')).toBeInstanceOf(File);
    expect(request.data.get('file').name).toBe('notes.txt');
    expect(request.data.get('name')).toBe('Notes');
    expect(request.data.get('pinned')).toBe('true');
    expect(request.contentType || '').not.toMatch(/application\/json/);
  });

  test('sends link and text items as JSON', async () => {
    const requests = captureRequests({ data: { item: { id: 'i2' } }, status: 201, headers: {} });

    await addAdminProjectItem('handbook', { kind: 'url', ref: { url: 'https://example.com' } });

    expect(requests[0].url).toBe('/admin/projects/handbook/items');
    expect(JSON.parse(requests[0].data)).toEqual({
      kind: 'url',
      ref: { url: 'https://example.com' }
    });
  });

  test('toggles several projects with the ids list', async () => {
    const requests = captureRequests({ data: { message: 'ok' }, status: 200, headers: {} });
    await toggleAdminProjects(['a', 'b'], false);
    expect(requests[0].url).toBe('/admin/projects/_toggle');
    expect(JSON.parse(requests[0].data)).toEqual({ ids: ['a', 'b'], enabled: false });
  });

  test('reads the item text with its length and truncation headers', async () => {
    const requests = captureRequests({
      data: 'The first part',
      status: 200,
      headers: { 'x-item-chars': '50000', 'x-item-truncated': 'true' }
    });

    const result = await fetchAdminProjectItemText('handbook', 'item 1', { maxChars: 20000 });

    expect(requests[0].url).toBe('/admin/projects/handbook/items/item%201/text?maxChars=20000');
    expect(result).toEqual({ text: 'The first part', chars: 50000, truncated: true });
  });
});
