/**
 * Tests for the iFinder discovery surface: `getFields`, `getFacetValues`,
 * `listProfiles`, and the facet normalisation they share with `discover`.
 *
 * The transport is stubbed at `_apiRequest`, so these assert the shapes this
 * service promises its callers — including the `FacetsResult` envelope the
 * public API actually returns, which the earlier normaliser read as if
 * `metadata` and `results` were facet names.
 */
import iFinderService from '../services/integrations/iFinderService.js';

const USER = { id: 'u1', email: 'u@example.com', name: 'Tester' };
const CHAT = 'c1';

/** The `FieldsResult` payload the public API answers with. */
const FIELDS_RESPONSE = {
  content: {
    type: 'text',
    full_text_search: 'content',
    filter: null,
    aggregation: null,
    sort: null
  },
  creators: {
    type: 'text',
    full_text_search: 'creators',
    filter: 'creators.keyword',
    aggregation: 'creators.keyword',
    sort: 'creators.keyword'
  },
  modificationDate: {
    type: 'date',
    full_text_search: null,
    filter: 'modificationDate',
    aggregation: 'modificationDate',
    sort: 'modificationDate'
  },
  'cust.classification': {
    type: 'text',
    full_text_search: 'cust.classification',
    filter: 'cust.classification.keyword',
    aggregation: 'cust.classification.keyword',
    sort: 'cust.classification.keyword'
  }
};

/** The `FacetsResult` envelope both the search and facet endpoints return. */
const FACETS_RESPONSE = {
  metadata: { took: '12ms' },
  results: [
    {
      id: 'creators.keyword',
      type: 'TERMS',
      has_more: true,
      values: [
        { value: 'DOE, John', count: 42 },
        { value: 'ROE, Jane', count: 17 }
      ]
    }
  ]
};

describe('iFinderService discovery surface', () => {
  let originalApiRequest;

  beforeEach(() => {
    originalApiRequest = iFinderService._apiRequest.bind(iFinderService);
    iFinderService.resetConfig();
  });

  afterEach(() => {
    iFinderService._apiRequest = originalApiRequest;
    iFinderService.resetConfig();
  });

  /** Stub the transport and record the requests the service makes. */
  function stubApi(responder) {
    const calls = [];
    iFinderService._apiRequest = async args => {
      calls.push(args);
      return responder(args);
    };
    return calls;
  }

  describe('getFields', () => {
    test('maps the field catalog onto per-purpose names', async () => {
      const calls = stubApi(() => FIELDS_RESPONSE);

      const result = await iFinderService.getFields({ user: USER, chatId: CHAT });

      expect(calls).toHaveLength(1);
      expect(calls[0].path).toBe('/public-api/retrieval/api/v1/schema-types/document/fields');
      expect(calls[0].method ?? 'GET').toBe('GET');

      expect(result.schemaType).toBe('document');
      expect(result.totalFields).toBe(4);

      // `creators` is the case the whole `.keyword` question turns on: searched
      // under its plain name, filtered/faceted/sorted under `.keyword`.
      expect(result.fields.creators).toEqual({
        type: 'text',
        fullTextSearch: 'creators',
        filter: 'creators.keyword',
        aggregation: 'creators.keyword',
        sort: 'creators.keyword'
      });
      // `content` serves full-text search only — a filter on it would match nothing.
      expect(result.fields.content.filter).toBeNull();
      // A date field takes no suffix at all.
      expect(result.fields.modificationDate.filter).toBe('modificationDate');

      expect(result.filterable).toContain('creators.keyword');
      expect(result.filterable).not.toContain('content');
      expect(result.sortable).toContain('modificationDate');
      expect(result.fullTextSearchable).toContain('content');
    });

    test('custom fields are reported like any other', async () => {
      stubApi(() => FIELDS_RESPONSE);
      const result = await iFinderService.getFields({
        user: USER,
        chatId: CHAT,
        filterPrefix: 'cust.'
      });

      expect(Object.keys(result.fields)).toEqual(['cust.classification']);
      expect(result.totalFields).toBe(1);
      expect(result.aggregatable).toEqual(['cust.classification.keyword']);
    });

    test('rejects an anonymous caller', async () => {
      stubApi(() => FIELDS_RESPONSE);
      await expect(
        iFinderService.getFields({ user: { id: 'anonymous' }, chatId: CHAT })
      ).rejects.toThrow(/authenticated user/);
    });
  });

  describe('getFacetValues', () => {
    test('POSTs the scope query with filters and unwraps the facet envelope', async () => {
      const calls = stubApi(() => FACETS_RESPONSE);

      const result = await iFinderService.getFacetValues({
        facet: 'creators.keyword',
        user: USER,
        chatId: CHAT,
        query: 'Krankengeld',
        filter: ['language.keyword:de'],
        maxValues: 25,
        searchProfile: 'searchprofile-legal'
      });

      const [call] = calls;
      expect(call.method).toBe('POST');
      expect(call.path).toContain(
        '/search-profiles/searchprofile-legal/facets/creators.keyword/_search'
      );
      expect(call.path).toContain('size=25');
      expect(call.path).toContain('sort=count%3Adesc');
      expect(call.body).toEqual({
        query: { query: 'Krankengeld', query_type: 'QueryStringQuery' },
        filters: [{ query: 'language.keyword:de', query_type: 'QueryStringQuery' }]
      });

      expect(result.facet).toBe('creators.keyword');
      expect(result.hasMore).toBe(true);
      expect(result.totalValues).toBe(2);
      expect(result.values).toEqual([
        { value: 'DOE, John', count: 42 },
        { value: 'ROE, Jane', count: 17 }
      ]);
    });

    test('omits filters entirely when there are none', async () => {
      const calls = stubApi(() => FACETS_RESPONSE);
      await iFinderService.getFacetValues({
        facet: 'creators.keyword',
        user: USER,
        chatId: CHAT
      });
      expect(calls[0].body.filters).toBeUndefined();
      expect(calls[0].body.query.query).toBe('*');
    });

    test('requires a facet', async () => {
      stubApi(() => FACETS_RESPONSE);
      await expect(iFinderService.getFacetValues({ user: USER, chatId: CHAT })).rejects.toThrow(
        /facet parameter is required/
      );
    });
  });

  describe('listProfiles', () => {
    test('derives profiles from the iAssistants the user can reach', async () => {
      const calls = stubApi(() => ({
        assistants: [
          {
            id: 'legal-advisor',
            name: 'Legal Advisor',
            description: 'Legal questions',
            search_profile_id: 'searchprofile-legal'
          },
          {
            id: 'hr-helper',
            name: 'HR Helper',
            search_profile_id: 'searchprofile-legal'
          }
        ],
        next_cursor: null
      }));

      const result = await iFinderService.listProfiles({ user: USER, chatId: CHAT });

      expect(calls[0].path).toBe('/public-api/v0/assistants?size=100');
      expect(result.source).toBe('assistants');
      expect(result.defaultSearchProfile).toBe('searchprofile-standard');

      const ids = result.profiles.map(p => p.id).sort();
      expect(ids).toEqual(['searchprofile-legal', 'searchprofile-standard']);

      const legal = result.profiles.find(p => p.id === 'searchprofile-legal');
      expect(legal.isDefault).toBe(false);
      expect(legal.assistants.map(a => a.id)).toEqual(['legal-advisor', 'hr-helper']);

      const standard = result.profiles.find(p => p.id === 'searchprofile-standard');
      expect(standard.isDefault).toBe(true);
    });

    test('degrades to the configured default when the assistants API is unavailable', async () => {
      stubApi(() => {
        throw new Error('iFinderAssistants failed with status 404: not found');
      });

      const result = await iFinderService.listProfiles({ user: USER, chatId: CHAT });

      expect(result.source).toBe('configured-default');
      expect(result.profiles).toEqual([
        { id: 'searchprofile-standard', isDefault: true, assistants: [] }
      ]);
      expect(result.assistants).toEqual([]);
    });
  });

  describe('_normaliseFacets', () => {
    test('unwraps the FacetsResult envelope the API actually returns', () => {
      // Read as a plain map, `metadata` and `results` would become facet names
      // and every value would come back as `(unknown)`.
      expect(iFinderService._normaliseFacets(FACETS_RESPONSE)).toEqual([
        {
          field: 'creators.keyword',
          hasMore: true,
          values: [
            { value: 'DOE, John', count: 42 },
            { value: 'ROE, Jane', count: 17 }
          ]
        }
      ]);
    });

    test('still accepts a bare facet list and a plain map', () => {
      expect(
        iFinderService._normaliseFacets([
          { field: 'language', values: [{ value: 'de', count: 3 }] }
        ])
      ).toEqual([{ field: 'language', hasMore: false, values: [{ value: 'de', count: 3 }] }]);

      expect(
        iFinderService._normaliseFacets({ mediaType: [{ key: 'pdf', doc_count: 2 }] })
      ).toEqual([{ field: 'mediaType', hasMore: false, values: [{ value: 'pdf', count: 2 }] }]);
    });

    test('an absent facet block is not an error', () => {
      expect(iFinderService._normaliseFacets(null)).toEqual([]);
      expect(iFinderService._normaliseFacets({ metadata: { took: '1ms' }, results: [] })).toEqual(
        []
      );
      // A response carrying only `metadata` is still the envelope, not a facet
      // called `metadata`.
      expect(iFinderService._normaliseFacets({ metadata: { took: '1ms' } })).toEqual([]);
    });
  });

  describe('_buildFilterQueries', () => {
    test('wraps each filter as its own query-string clause', () => {
      expect(iFinderService._buildFilterQueries(['a:1', ' b:2 '])).toEqual([
        { query: 'a:1', query_type: 'QueryStringQuery' },
        { query: 'b:2', query_type: 'QueryStringQuery' }
      ]);
    });

    test('nothing to send is null, not an empty array', () => {
      expect(iFinderService._buildFilterQueries([])).toBeNull();
      expect(iFinderService._buildFilterQueries(['   ', ''])).toBeNull();
      expect(iFinderService._buildFilterQueries(undefined)).toBeNull();
    });
  });
});
