// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { enhanceApiError, requestTooLargeBy } from '../../../client/src/api/utils/apiErrors';
import { uploadErrorCode } from '../../../client/src/features/chat/utils/chatFileUpload';

// What nginx answers when `client_max_body_size` (1 MB by default) is exceeded
const NGINX_413 = '<html><head><title>413 Request Entity Too Large</title></head></html>';

const refused = (status, data) => ({
  message: `Request failed with status code ${status}`,
  response: { status, data }
});

describe('requestTooLargeBy', () => {
  it('names a proxy when a 413 carries no iHub error (an HTML page, or nothing)', () => {
    expect(requestTooLargeBy(refused(413, NGINX_413))).toBe('proxy');
    expect(requestTooLargeBy(refused(413, undefined))).toBe('proxy');
    expect(requestTooLargeBy(refused(413, ''))).toBe('proxy');
  });

  it("names the server when iHub's own PAYLOAD_TOO_LARGE answered", () => {
    expect(
      requestTooLargeBy(refused(413, { code: 'PAYLOAD_TOO_LARGE', detail: 'Payload Too Large' }))
    ).toBe('server');
  });

  it('leaves a 413 that names its own cause to its own message', () => {
    expect(requestTooLargeBy(refused(413, { code: 'QUOTA_FILE_BYTES' }))).toBeUndefined();
    expect(requestTooLargeBy(refused(413, { code: 'UPLOAD_TOO_LARGE' }))).toBeUndefined();
  });

  it('ignores every other status and errors without a response', () => {
    expect(requestTooLargeBy(refused(500, NGINX_413))).toBeUndefined();
    expect(requestTooLargeBy(refused(401, undefined))).toBeUndefined();
    expect(requestTooLargeBy(new Error('Network Error'))).toBeUndefined();
    expect(requestTooLargeBy(undefined)).toBeUndefined();
  });

  it('reads the response of an error that was enhanced already', () => {
    const enhanced = enhanceApiError(refused(413, NGINX_413));
    expect(requestTooLargeBy(enhanced)).toBe('proxy');
  });
});

describe('enhanceApiError for a request that was too large', () => {
  it('marks a proxy refusal and says so instead of "Request failed with status code 413"', () => {
    const error = enhanceApiError(refused(413, NGINX_413));
    expect(error.status).toBe(413);
    expect(error.requestTooLarge).toBe('proxy');
    expect(error.userFriendlyMessage).toMatch(/reverse proxy/);
    expect(error.userFriendlyMessage).not.toMatch(/status code 413/);
  });

  it("marks iHub's own refusal", () => {
    const error = enhanceApiError(
      refused(413, { code: 'PAYLOAD_TOO_LARGE', detail: 'Payload Too Large' })
    );
    expect(error.requestTooLarge).toBe('server');
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.userFriendlyMessage).toBe('The request is larger than iHub accepts.');
  });

  it('keeps the server text of a 413 that names its own cause', () => {
    const error = enhanceApiError(
      refused(413, { code: 'QUOTA_FILE_BYTES', detail: 'A file may be at most 25 MB' })
    );
    expect(error.requestTooLarge).toBeUndefined();
    expect(error.userFriendlyMessage).toBe('A file may be at most 25 MB');
  });

  it('does not mark other failures', () => {
    expect(enhanceApiError(refused(500, undefined)).requestTooLarge).toBeUndefined();
    expect(enhanceApiError(refused(404, undefined)).requestTooLarge).toBeUndefined();
  });
});

describe('uploadErrorCode for a refused upload', () => {
  it('names the proxy for a 413 no iHub answered, raw or enhanced', () => {
    expect(uploadErrorCode(refused(413, NGINX_413))).toBe('PROXY_BODY_LIMIT');
    expect(uploadErrorCode(enhanceApiError(refused(413, NGINX_413)))).toBe('PROXY_BODY_LIMIT');
  });

  it('keeps the code of every 413 iHub answered', () => {
    expect(uploadErrorCode(refused(413, { code: 'QUOTA_FILE_BYTES' }))).toBe('QUOTA_FILE_BYTES');
    expect(uploadErrorCode(refused(413, { code: 'PAYLOAD_TOO_LARGE' }))).toBe('PAYLOAD_TOO_LARGE');
  });

  it("is still 'FAILED' when nothing says why", () => {
    expect(uploadErrorCode(refused(500, undefined))).toBe('FAILED');
    expect(uploadErrorCode(new Error('boom'))).toBe('FAILED');
  });
});
