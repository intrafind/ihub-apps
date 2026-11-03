// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `createFileApi().upload` — the file endpoints of chats, scheduled tasks and
 * shares.
 *
 * Regression: the shared axios instance defaults to `Content-Type:
 * application/json`. A FormData body sent with that default is serialised to
 * JSON (`{}`), so the server received no file and answered 400 'Provide a
 * multipart "file" upload, …'. Drives the real helper against a real axios
 * instance and records what the adapter gets.
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

jest.mock('../../../client/src/utils/cache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn() },
  DEFAULT_CACHE_TTL: { MEDIUM: 0 }
}));

import { apiClient } from '../../../client/src/api/client.js';
import { createFileApi } from '../../../client/src/api/utils/fileApi.js';

function captureRequests() {
  const requests = [];
  apiClient.defaults.adapter = config => {
    requests.push({
      url: config.url,
      data: config.data,
      contentType: config.headers.getContentType()
    });
    return Promise.resolve({
      data: { file: { id: 'file-1' } },
      status: 201,
      headers: {},
      config
    });
  };
  return requests;
}

describe('createFileApi upload', () => {
  const api = createFileApi('/chats');

  test('sends a File as multipart FormData, not as the JSON default', async () => {
    const requests = captureRequests();
    const file = new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' });

    const result = await api.upload('chat-1', file, { fields: { appId: 'chat' } });

    expect(result).toEqual({ file: { id: 'file-1' } });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/chats/chat-1/files');
    // The body reaches the adapter as the form, not as the string "{}"
    expect(requests[0].data).toBeInstanceOf(FormData);
    expect(requests[0].data.get('file')).toBeInstanceOf(File);
    expect(requests[0].data.get('file').name).toBe('report.pdf');
    expect(requests[0].data.get('appId')).toBe('chat');
    // The JSON default must not be what is declared for the form
    expect(requests[0].contentType).not.toMatch(/application\/json/);
  });

  test('keeps sending extracted text as JSON', async () => {
    const requests = captureRequests();

    await api.upload('chat-1', { name: 'a.txt', mimeType: 'text/plain', text: 'hello' });

    expect(requests[0].contentType).toMatch(/application\/json/);
    expect(JSON.parse(requests[0].data)).toEqual({
      name: 'a.txt',
      mimeType: 'text/plain',
      text: 'hello'
    });
  });
});
