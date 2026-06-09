/**
 * Tests for iFinderService.discover()
 *
 * Stubs the singleton's `search()` method and verifies the discovery
 * pipeline normalises facets / sample docs and produces the markdown body
 * the admin "build memory from tool" endpoint relies on.
 */
import iFinderService from '../services/integrations/iFinderService.js';

describe('iFinderService.discover', () => {
  let originalSearch;

  beforeEach(() => {
    originalSearch = iFinderService.search.bind(iFinderService);
  });

  afterEach(() => {
    iFinderService.search = originalSearch;
  });

  test('requires a searchProfile', async () => {
    await expect(
      iFinderService.discover({
        chatId: 'c1',
        user: { id: 'u1', email: 'u@example.com' }
      })
    ).rejects.toThrow(/searchProfile is required/);
  });

  test('forwards facets to search and returns a normalised payload', async () => {
    let capturedArgs = null;
    iFinderService.search = async args => {
      capturedArgs = args;
      return {
        totalFound: 4231,
        facets: [
          {
            field: 'sourceName',
            values: [
              { value: 'Stellungnahmen 2024', count: 2310 },
              { value: 'Stellungnahmen 2023', count: 1921 }
            ]
          },
          {
            field: 'language',
            values: [{ value: 'de', count: 4200 }]
          }
        ],
        results: [
          {
            id: 'doc-abc',
            title: 'BfArM Stellungnahme zum KHVVG',
            sourceName: 'Stellungnahmen 2024',
            mediaType: 'application/pdf',
            language: 'de'
          }
        ]
      };
    };

    const result = await iFinderService.discover({
      searchProfile: 'searchprofile-stellungnahmen',
      query: 'Krankengeld',
      facets: ['sourceName', 'language'],
      sampleSize: 5,
      chatId: 'c1',
      user: { id: 'u1', email: 'u@example.com', name: 'Tester' }
    });

    expect(capturedArgs.searchProfile).toBe('searchprofile-stellungnahmen');
    expect(capturedArgs.returnFacets).toEqual(['sourceName', 'language']);
    expect(capturedArgs.maxResults).toBe(5);

    expect(result.searchProfile).toBe('searchprofile-stellungnahmen');
    expect(result.query).toBe('Krankengeld');
    expect(result.totalFound).toBe(4231);
    expect(result.sampleDocs).toHaveLength(1);
    expect(result.sampleDocs[0].docId).toBe('doc-abc');

    expect(typeof result.markdown).toBe('string');
    expect(result.markdown).toContain('searchprofile-stellungnahmen');
    expect(result.markdown).toContain('Stellungnahmen 2024');
    expect(result.markdown).toContain('BfArM Stellungnahme zum KHVVG');
    expect(result.markdown).toContain('Krankengeld');
  });

  test('defaults query to *:* when not provided', async () => {
    let capturedArgs = null;
    iFinderService.search = async args => {
      capturedArgs = args;
      return { totalFound: 0, facets: null, results: [] };
    };

    const result = await iFinderService.discover({
      searchProfile: 'p1',
      chatId: 'c1',
      user: { id: 'u1', email: 'u@example.com' }
    });
    expect(capturedArgs.query).toBe('*:*');
    // Default facet list matches iFinder's actual `.keyword` field naming.
    expect(capturedArgs.returnFacets).toEqual([
      'sourceName.keyword',
      'application.keyword',
      'language.keyword',
      'creators.keyword',
      'navigationTree'
    ]);
    expect(result.query).toBe('*:*');
    expect(result.sampleDocs).toEqual([]);
  });

  test('normalises facets returned as a plain object', async () => {
    iFinderService.search = async () => ({
      totalFound: 3,
      facets: {
        mediaType: [
          { key: 'pdf', doc_count: 2 },
          { key: 'docx', doc_count: 1 }
        ]
      },
      results: []
    });

    const result = await iFinderService.discover({
      searchProfile: 'p1',
      chatId: 'c1',
      user: { id: 'u1', email: 'u@example.com' }
    });

    expect(result.markdown).toContain('mediaType');
    expect(result.markdown).toContain('pdf');
    expect(result.markdown).toContain('docx');
  });
});
