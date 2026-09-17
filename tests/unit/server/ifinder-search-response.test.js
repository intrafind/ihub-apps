/**
 * @jest-environment node
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import iFinderService from '../../../server/services/integrations/iFinderService.js';

// The service talks to a remote iFinder over HTTP and signs every request with
// a per-user JWT. Everything below the response mapping is mocked away — these
// tests are about the shape of what search() hands back, nothing else.
const mockFetch = jest.fn();

jest.mock('../../../server/requestThrottler.js', () => ({
  __esModule: true,
  throttledFetch: (...args) => mockFetch(...args)
}));

jest.mock('../../../server/utils/iFinderJwt.js', () => ({
  __esModule: true,
  getIFinderAuthorizationHeader: jest.fn(() => 'Bearer test-token')
}));

jest.mock('../../../server/configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => ({
      iFinder: {
        baseUrl: 'https://ifinder.test',
        defaultSearchProfile: 'searchprofile-standard',
        endpoints: { search: '/public-api/retrieval/api/v1/search/{profileId}' },
        timeout: 5000
      }
    })
  }
}));

jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../../../server/utils/authDebugService.js', () => ({
  __esModule: true,
  default: { log: jest.fn() }
}));

jest.mock('../../../server/services/loop/RunStream.js', () => ({
  __esModule: true,
  emitToolProgress: jest.fn()
}));

const user = { id: 'user-1', name: 'Test User', groups: ['users'] };

/** Drive search() against a canned iFinder API response. */
function searchReturning(apiResponse) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => apiResponse
  });
  return iFinderService.search({ query: 'cloud offering', user, chatId: 'chat-1' });
}

describe('iFinder search response shape', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    iFinderService.resetConfig();
  });

  it('carries no verbatim echo of the API document or hit metadata', async () => {
    const { results } = await searchReturning({
      metadata: { total_hits: 1, took: '12ms' },
      results: [
        {
          document: { id: ['doc-1'], title: ['Cloud Offering.xlsx'] },
          metadata: { score: 4.2, teasers: [{ 'hit.teaser.content': ['…'] }] }
        }
      ]
    });

    expect(results).toHaveLength(1);
    // Both used to duplicate fields already mapped onto the hit, roughly
    // doubling every search response for no consumer in the codebase.
    expect(results[0]).not.toHaveProperty('rawDocument');
    expect(results[0]).not.toHaveProperty('rawHitMetadata');
    // …while score and teasers, the whole of hit.metadata, are still there.
    expect(results[0].score).toBe(4.2);
    expect(results[0].teasers).toEqual([{ 'hit.teaser.content': ['…'] }]);
  });

  it('omits fields the source has nothing for', async () => {
    const { results } = await searchReturning({
      metadata: { total_hits: 1 },
      results: [
        {
          document: { id: ['doc-1'], 'file.name': ['Cloud Offering.xlsx'] },
          metadata: { score: 1 }
        }
      ]
    });

    const hit = results[0];
    expect(hit.filename).toBe('Cloud Offering.xlsx');
    // A document without these carries no null placeholder for them.
    expect(hit).not.toHaveProperty('language');
    expect(hit).not.toHaveProperty('author');
    expect(hit).not.toHaveProperty('navigationTree');
    expect(hit).not.toHaveProperty('sourceLocations');
    // No size reported means no size shown — not a fabricated "0 B".
    expect(hit).not.toHaveProperty('sizeFormatted');
  });

  it('keeps values that are falsy but real', async () => {
    const { results } = await searchReturning({
      metadata: { total_hits: 1 },
      results: [
        {
          document: { id: ['doc-1'], contentLength: [0], title: ['Empty.txt'] },
          metadata: { score: 0 }
        }
      ]
    });

    expect(results[0].contentLength).toBe(0);
    expect(results[0].score).toBe(0);
  });

  it('formats a size that is actually reported', async () => {
    const { results } = await searchReturning({
      metadata: { total_hits: 1 },
      results: [
        {
          document: { id: ['doc-1'], 'file.size': [2048] },
          metadata: { score: 1 }
        }
      ]
    });

    expect(results[0].sizeFormatted).toBe('2 KB');
  });
});
