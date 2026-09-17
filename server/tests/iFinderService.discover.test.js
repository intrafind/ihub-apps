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

  let originalGetFields;

  beforeEach(() => {
    originalSearch = iFinderService.search.bind(iFinderService);
    // discover() also probes the field catalog; these cases are about the
    // facet/sample pipeline, so answer it with an empty catalog.
    originalGetFields = iFinderService.getFields.bind(iFinderService);
    iFinderService.getFields = async () => ({
      schemaType: 'document',
      totalFields: 0,
      fields: {},
      fullTextSearchable: [],
      filterable: [],
      aggregatable: [],
      sortable: []
    });
  });

  afterEach(() => {
    iFinderService.search = originalSearch;
    iFinderService.getFields = originalGetFields;
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

  test('renders the facet envelope the public API actually returns', async () => {
    // `FacetsResult` — `{ metadata, results: [{ id, has_more, values }] }`. Read
    // as a plain map this yields facets literally named `metadata` and
    // `results`, and every value renders as `(unknown)`.
    iFinderService.search = async () => ({
      totalFound: 51,
      facets: {
        metadata: { took: '12ms' },
        results: [
          {
            id: 'sourceName.keyword',
            type: 'TERMS',
            has_more: true,
            values: [
              { value: 'Intranet', count: 40 },
              { value: 'Confluence', count: 11 }
            ]
          }
        ]
      },
      results: []
    });

    const result = await iFinderService.discover({
      searchProfile: 'p1',
      chatId: 'c1',
      user: { id: 'u1', email: 'u@example.com' },
      includeFields: false
    });

    expect(result.facets).toEqual([
      {
        field: 'sourceName.keyword',
        hasMore: true,
        values: [
          { value: 'Intranet', count: 40 },
          { value: 'Confluence', count: 11 }
        ]
      }
    ]);
    expect(result.markdown).toContain('**sourceName.keyword**');
    expect(result.markdown).toContain('Intranet — 40 docs');
    expect(result.markdown).not.toContain('(unknown)');
    // `has_more` means the block is truncated — point at the way to see the rest.
    expect(result.markdown).toContain('getFacetValues');
  });

  test('includeFields: false skips the field catalog probe', async () => {
    iFinderService.search = async () => ({ totalFound: 0, facets: null, results: [] });
    let fieldCalls = 0;
    const originalGetFields = iFinderService.getFields;
    iFinderService.getFields = async () => {
      fieldCalls += 1;
      return {};
    };

    try {
      const result = await iFinderService.discover({
        searchProfile: 'p1',
        chatId: 'c1',
        user: { id: 'u1', email: 'u@example.com' },
        includeFields: false
      });
      expect(fieldCalls).toBe(0);
      expect(result.fields).toBeNull();
    } finally {
      iFinderService.getFields = originalGetFields;
    }
  });

  test('a field catalog the deployment cannot serve does not fail the probe', async () => {
    iFinderService.search = async () => ({ totalFound: 7, facets: null, results: [] });
    const originalGetFields = iFinderService.getFields;
    iFinderService.getFields = async () => {
      throw new Error('iFinderFields failed with status 404: not found');
    };

    try {
      const result = await iFinderService.discover({
        searchProfile: 'p1',
        chatId: 'c1',
        user: { id: 'u1', email: 'u@example.com' }
      });
      expect(result.totalFound).toBe(7);
      expect(result.fields).toBeNull();
    } finally {
      iFinderService.getFields = originalGetFields;
    }
  });
});
