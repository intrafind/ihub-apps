/**
 * The shared SSE transport must not know about any embedded host. Hosts with
 * their own token lifecycle (Office add-in, browser extension, Nextcloud)
 * register an auth provider; the plain SPA registers none and only ever sends
 * its own `authToken`, with no refresh attempt on 401.
 */
import {
  fetchWithAuthRetry,
  getSseAuthHeaders,
  setSseAuthProvider
} from '../../../client/src/shared/utils/openSseStream';

const response = status => ({ status, ok: status >= 200 && status < 300 });

beforeEach(() => {
  localStorage.clear();
  setSseAuthProvider(null);
  global.fetch = jest.fn();
});

afterAll(() => {
  setSseAuthProvider(null);
  delete global.fetch;
});

describe('getSseAuthHeaders', () => {
  it('uses only the main app token when no provider is registered', () => {
    localStorage.setItem('office_ihubtoken', 'office-token');
    localStorage.setItem('authToken', 'app-token');
    expect(getSseAuthHeaders()).toEqual({ Authorization: 'Bearer app-token' });
  });

  it('returns no header when no token is available', () => {
    expect(getSseAuthHeaders()).toEqual({});
  });

  it("prefers the provider's token over the main app token", () => {
    localStorage.setItem('authToken', 'app-token');
    setSseAuthProvider({ getToken: () => 'host-token' });
    expect(getSseAuthHeaders()).toEqual({ Authorization: 'Bearer host-token' });
  });

  it('falls back to the main app token when the provider has none', () => {
    localStorage.setItem('authToken', 'app-token');
    setSseAuthProvider({ getToken: () => null });
    expect(getSseAuthHeaders()).toEqual({ Authorization: 'Bearer app-token' });
  });
});

describe('fetchWithAuthRetry', () => {
  it('returns a 401 as-is when no provider is registered', async () => {
    global.fetch.mockResolvedValueOnce(response(401));
    const res = await fetchWithAuthRetry('/api/stream');
    expect(res.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries once with the refreshed token when the provider recovers the 401', async () => {
    let token = 'expired';
    setSseAuthProvider({
      getToken: () => token,
      onUnauthorized: jest.fn(async () => {
        token = 'fresh';
        return true;
      })
    });
    global.fetch.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));

    const res = await fetchWithAuthRetry('/api/stream', {
      headers: { Accept: 'text/event-stream' }
    });

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][1].headers).toEqual({
      Accept: 'text/event-stream',
      Authorization: 'Bearer fresh'
    });
  });

  it('does not retry when the provider declines', async () => {
    const onUnauthorized = jest.fn(async () => false);
    setSseAuthProvider({ onUnauthorized });
    global.fetch.mockResolvedValueOnce(response(401));

    const res = await fetchWithAuthRetry('/api/stream');

    expect(res.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed refresh', async () => {
    setSseAuthProvider({
      onUnauthorized: async () => {
        throw new Error('refresh failed');
      }
    });
    global.fetch.mockResolvedValueOnce(response(401));

    await expect(fetchWithAuthRetry('/api/stream')).rejects.toThrow('refresh failed');
  });

  it('does not consult the provider for non-401 responses', async () => {
    const onUnauthorized = jest.fn();
    setSseAuthProvider({ onUnauthorized });
    global.fetch.mockResolvedValueOnce(response(500));

    await fetchWithAuthRetry('/api/stream');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
