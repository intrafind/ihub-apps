/**
 * Regression test for issue #1731: a 5xx response used to be written into the
 * request cache as an error placeholder, and the cache-hit path had no
 * isErrorPlaceholder check, so the placeholder object was returned as if it
 * were successful data for up to a minute. handleApiResponse must never
 * cache a failed response, and a cache miss must always trigger a fresh
 * apiCall.
 */

// client.js and utils/cache.js both read import.meta.env at module scope,
// which the CommonJS jest transform can't evaluate. Mock them so the test
// exercises requestHandler.js's real logic without loading those modules.
jest.mock('../../../client/src/api/client', () => ({
  API_REQUEST_TIMEOUT: 30000
}));

jest.mock('../../../client/src/utils/cache', () => {
  const mockStore = new Map();
  return {
    __esModule: true,
    default: {
      get: jest.fn(key => (mockStore.has(key) ? mockStore.get(key) : null)),
      set: jest.fn((key, value) => {
        mockStore.set(key, value);
        return value;
      }),
      __mockStore: mockStore
    },
    DEFAULT_CACHE_TTL: { SHORT: 60 * 1000, MEDIUM: 5 * 60 * 1000 }
  };
});

const { handleApiResponse } = require('../../../client/src/api/utils/requestHandler');
const cache = require('../../../client/src/utils/cache').default;

beforeEach(() => {
  cache.__mockStore.clear();
  jest.clearAllMocks();
});

function serverError() {
  const error = new Error('Internal Server Error');
  error.response = { status: 500, data: { error: 'Internal Server Error' } };
  return error;
}

test('a 5xx failure rejects and is not written into the cache', async () => {
  const apiCall = jest.fn().mockRejectedValue(serverError());

  await expect(handleApiResponse(apiCall, 'test-key')).rejects.toMatchObject({
    status: 500
  });

  expect(cache.__mockStore.has('test-key')).toBe(false);
});

test('a cache miss after a prior 5xx triggers a fresh apiCall instead of replaying the error', async () => {
  const apiCall = jest
    .fn()
    .mockRejectedValueOnce(serverError())
    .mockResolvedValueOnce({ status: 200, data: { ok: true } });

  await expect(handleApiResponse(apiCall, 'test-key')).rejects.toMatchObject({ status: 500 });

  const result = await handleApiResponse(apiCall, 'test-key');

  expect(apiCall).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ ok: true });
});

test('a successful response is cached and served without re-invoking apiCall', async () => {
  const apiCall = jest.fn().mockResolvedValue({ status: 200, data: { ok: true } });

  const first = await handleApiResponse(apiCall, 'test-key');
  const second = await handleApiResponse(apiCall, 'test-key');

  expect(apiCall).toHaveBeenCalledTimes(1);
  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: true });
});
