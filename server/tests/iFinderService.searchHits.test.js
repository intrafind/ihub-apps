// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shape of an iFinder search hit. `IFinderHandler.searchDocuments` (the
 * project item picker) and the source loader read `mimeType` and
 * `lastModified` from it, so they must stay on the hit.
 */
import { jest } from '@jest/globals';

const throttledFetchMock = jest.fn();

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: throttledFetchMock
}));

const DOC = {
  id: ['doc-1'],
  title: ['Quarterly report'],
  sourceName: ['SharePoint'],
  mediaType: ['application/pdf'],
  modificationDate: ['2026-03-01T10:00:00Z'],
  'file.name': ['report.pdf'],
  'file.size': [2048],
  navigationTree: ['Finance']
};

describe('iFinderService.search hit shape', () => {
  let iFinderService;
  let iFinderTokenProvider;

  beforeEach(async () => {
    jest.resetAllMocks();
    ({ default: iFinderService } = await import('../services/integrations/iFinderService.js'));
    ({ default: iFinderTokenProvider } =
      await import('../services/integrations/iFinderTokenProvider.js'));
    iFinderService.getConfig = () => ({
      enabled: true,
      baseUrl: 'https://ifinder.example',
      defaultSearchProfile: 'p1',
      endpoints: { search: '/profiles/{profileId}/_search' }
    });
    iFinderTokenProvider.getAuthorizationHeader = async () => 'Bearer test';
    throttledFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ document: DOC, metadata: { score: 1.5, teasers: [] } }],
        metadata: {}
      })
    });
  });

  test('carries mimeType and lastModified for the project picker', async () => {
    const result = await iFinderService.search({
      query: 'report',
      chatId: 'c1',
      user: { id: 'u1', name: 'Tester' }
    });
    const [hit] = result.results;
    expect(hit.mimeType).toBe('application/pdf');
    expect(hit.lastModified).toBe('2026-03-01T10:00:00Z');
    expect(hit.filename).toBe('report.pdf');
  });

  test('no longer repeats source, breadcrumbs and extension', async () => {
    const result = await iFinderService.search({
      query: 'report',
      chatId: 'c1',
      user: { id: 'u1', name: 'Tester' }
    });
    const [hit] = result.results;
    expect(hit.sourceName).toBe('SharePoint');
    expect(hit.navigationTree).toBe('Finance');
    expect(hit).not.toHaveProperty('source');
    expect(hit).not.toHaveProperty('breadcrumbs');
    expect(hit).not.toHaveProperty('extension');
  });
});
