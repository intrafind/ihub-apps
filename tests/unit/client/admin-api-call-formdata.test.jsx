/**
 * Regression test for issue #2334.
 *
 * Admin uploads (backup import, UI asset upload, skill import) send a FormData
 * body through `makeAdminApiCall`. The shared axios instance in api/client.js
 * declares `Content-Type: application/json` as an INSTANCE DEFAULT, which still
 * applies to a request whose own headers merely omit the key. Axios' default
 * `transformRequest` then sees a JSON content type on a FormData payload and
 * serialises the form to JSON (`{"backup":{}}`), so the file never leaves the
 * browser and the server answers `400 No ZIP file uploaded`.
 *
 * These tests drive the real helper against a real axios instance and assert on
 * what the adapter would actually put on the wire — a source-text check cannot
 * catch this, because the buggy code *looked* correct.
 */

import fs from 'fs';
import path from 'path';

// The real api/client.js reads `import.meta.env`, which the Jest CJS transform
// cannot parse. Stand in a real axios instance configured the same way — the
// JSON instance default is the whole point of this regression, and the
// premise test below asserts the real module still declares it.
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

// runtimeBasePath also uses `import.meta`.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: p => `/api/${p}`,
  buildPath: p => p,
  buildAssetUrl: p => p
}));

import { apiClient } from '../../../client/src/api/client.js';
import { makeAdminApiCall } from '../../../client/src/api/adminApi.js';

/**
 * Swaps in an adapter that resolves immediately and records the request exactly
 * as axios hands it over — after transformRequest has run, which is where the
 * FormData payload was being destroyed.
 */
function captureOutgoingRequest() {
  const captured = {};
  const originalAdapter = apiClient.defaults.adapter;

  apiClient.defaults.adapter = config => {
    captured.data = config.data;
    captured.contentType = config.headers.getContentType();
    return Promise.resolve({ data: { ok: true }, status: 200, headers: {}, config });
  };

  return {
    captured,
    restore: () => {
      apiClient.defaults.adapter = originalAdapter;
    }
  };
}

describe('makeAdminApiCall FormData handling (issue #2334)', () => {
  let harness;

  beforeEach(() => {
    harness = captureOutgoingRequest();
    localStorage.clear();
  });

  afterEach(() => {
    harness.restore();
  });

  test('premise: the shared axios instance still declares a JSON content type default', () => {
    // If this default is ever dropped, the FormData workaround below is no
    // longer load-bearing — but until then, removing it silently breaks uploads.
    const source = fs.readFileSync(path.join(process.cwd(), 'client/src/api/client.js'), 'utf8');
    expect(source).toMatch(/'Content-Type':\s*'application\/json'/);
  });

  test('sends a FormData body untouched instead of serialising it to JSON', async () => {
    const formData = new FormData();
    formData.append('backup', new Blob(['PK'], { type: 'application/zip' }), 'b.zip');

    await makeAdminApiCall('/admin/backup/import', { method: 'POST', body: formData });

    // The payload must still be the FormData instance. Before the fix this was
    // the string '{"backup":{}}' and the uploaded file was silently dropped.
    expect(harness.captured.data).toBe(formData);
    expect(typeof harness.captured.data).not.toBe('string');
  });

  test('does not put a JSON content type on a FormData request', async () => {
    const formData = new FormData();
    formData.append('asset', new Blob(['x'], { type: 'image/png' }), 'logo.png');

    await makeAdminApiCall('/admin/ui/upload-asset', { method: 'POST', body: formData });

    // A JSON content type is what triggers axios' formToJSON serialisation. Any
    // other value (or none) is fine: for a FormData body the browser adapter
    // unsets Content-Type so the browser can add the multipart boundary.
    expect(harness.captured.contentType ?? '').not.toContain('application/json');
  });

  test('still sends plain object bodies as JSON', async () => {
    await makeAdminApiCall('/admin/apps/test-app', {
      method: 'PUT',
      body: { id: 'test-app', enabled: true }
    });

    expect(harness.captured.contentType).toContain('application/json');
    expect(JSON.parse(harness.captured.data)).toEqual({ id: 'test-app', enabled: true });
  });

  test('a caller-supplied Content-Type does not reintroduce JSON serialisation', async () => {
    const formData = new FormData();
    formData.append('skill', new Blob(['PK'], { type: 'application/zip' }), 's.zip');

    await makeAdminApiCall('/admin/skills/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: formData
    });

    expect(harness.captured.data).toBe(formData);
    expect(harness.captured.contentType ?? '').not.toContain('application/json');
  });
});
