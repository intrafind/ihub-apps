import { emitToolProgress } from '../loop/RunStream.js';
import config from '../../config.js';
import { throttledFetch } from '../../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import { isValidId } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import authDebugService from '../../utils/authDebugService.js';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

/**
 * Unified iFinder Service Class
 * Provides search, content retrieval, metadata fetching, and download functionality
 * for the iFinder document management system.
 */

class IFinderService {
  constructor() {
    this.platform = null;
    this.config = null;
  }

  /**
   * Reset cached config so it will be reloaded on next access
   */
  resetConfig() {
    this.config = null;
    this.platform = null;
  }

  /**
   * Get iFinder API configuration
   * @returns {Object} iFinder API configuration
   */
  getConfig() {
    if (!this.config) {
      this.platform = configCache.getPlatform() || {};
      const iFinderConfig = this.platform.iFinder || {};

      this.config = {
        baseUrl:
          config.IFINDER_API_URL ||
          process.env.IFINDER_API_URL ||
          iFinderConfig.baseUrl ||
          'https://api.ifinder.example.com',
        endpoints: {
          search:
            iFinderConfig.endpoints?.search ||
            '/public-api/retrieval/api/v1/search-profiles/{profileId}/_search',
          document:
            iFinderConfig.endpoints?.document ||
            '/public-api/retrieval/api/v1/search-profiles/{profileId}/docs/{docId}',
          // Discovery endpoints. `fields` is profile-independent — it describes the
          // index schema, not a profile's view of it.
          fields:
            iFinderConfig.endpoints?.fields ||
            '/public-api/retrieval/api/v1/schema-types/{schemaType}/fields',
          facets:
            iFinderConfig.endpoints?.facets ||
            '/public-api/retrieval/api/v1/search-profiles/{profileId}/facets/{facetId}/_search',
          assistants: iFinderConfig.endpoints?.assistants || '/public-api/v0/assistants'
        },
        defaultSearchProfile:
          iFinderConfig.defaultSearchProfile ||
          process.env.IFINDER_SEARCH_PROFILE ||
          'searchprofile-standard',
        downloadDir:
          iFinderConfig.downloadDir || config.IFINDER_DOWNLOAD_DIR || '/tmp/ifinder-downloads',
        timeout: iFinderConfig.timeout || config.IFINDER_TIMEOUT || 30000
      };
    }
    return this.config;
  }

  /**
   * Validate common parameters
   * @param {Object} user - User object
   * @param {string} chatId - Chat ID for tracking
   */
  validateCommon(user, chatId) {
    if (!user || user.id === 'anonymous') {
      throw new Error('iFinder access requires authenticated user');
    }
    if (!chatId) {
      throw new Error('Chat ID is required for tracking');
    }
  }

  /**
   * Search for documents in iFinder
   * @param {Object} params - Search parameters
   * @returns {Object} Search results
   */
  async search({
    query,
    chatId,
    user,
    maxResults = 10,
    from = 0,
    searchProfile,
    returnFields = [
      'id',
      'accessInfo.deepLink',
      'accessInfo.download.itemId',
      'accessInfo.download.itemType',
      'accessInfo.download.subItemExtractionPath',
      'accessInfo.lastModifiedDate',
      'accessInfo.source',
      'agentTags',
      'agentType',
      'agentVersion',
      'application',
      'attachment.parent.id',
      'attachment.parent.mediaType',
      'attachment.parent.title',
      'contentHash',
      'contentLength',
      'context',
      'creationDate',
      'creators',
      'file.name',
      'file.size',
      'idHash',
      'indexingDate',
      'language',
      'languages',
      'links',
      'mediaType',
      'navigationTree',
      'navigationTreeDepth',
      'owners',
      'significantTerms_hint',
      'sourceLocations.label',
      'sourceLocations.url',
      'sourceName',
      'sourceType',
      'title',
      'url'
    ],
    returnFacets = [
      'sourceType.keyword',
      'application.keyword',
      'navigationTree',
      'creators.keyword',
      'language.keyword',
      'modificationDate'
    ],
    sort,
    filter,
    queryLogging = true,
    signal
  }) {
    if (!query) {
      throw new Error('Query parameter is required');
    }
    this.validateCommon(user, chatId);

    const config = this.getConfig();
    const profileId = searchProfile || config.defaultSearchProfile;

    logger.info('Searching for query in profile', {
      component: 'IFinderService',
      userId: user?.id,
      query,
      profileId
    });

    // Track the action
    emitToolProgress(chatId, {
      phase: 'ifinder_search',
      message: query,
      data: { query, searchProfile: profileId }
    });

    try {
      // Generate JWT token for the user
      const authHeader = getIFinderAuthorizationHeader(user);

      // Log authentication header with proper masking
      authDebugService.log('iFinder', 'info', 'JWT token generated for search request', {
        userId: user.id,
        userName: user.name,
        userGroups: user.groups,
        authHeader: authHeader,
        searchProfile: profileId
      });

      // Construct search URL with profile ID
      const searchEndpoint = config.endpoints.search.replace(
        '{profileId}',
        encodeURIComponent(profileId)
      );
      const baseUrl = `${config.baseUrl.replace(/\/+$/, '')}${searchEndpoint}`;

      // Build URL query parameters — paging, projection, sorting, logging.
      // The query string itself and filters move to the JSON body below
      // (the GET endpoint doesn't support filters, only POST does).
      // iFinder caps `size` at 100; pagination through larger result sets
      // is the caller's responsibility (vary `from` across calls).
      const params = new URLSearchParams();
      const pageSize = Math.min(Math.max(maxResults, 0), 100);
      params.append('size', pageSize.toString());
      if (from > 0) params.append('from', String(from));

      if (returnFields && returnFields.length > 0) {
        returnFields.forEach(field => params.append('return_fields', field));
      }

      if (returnFacets && returnFacets.length > 0) {
        returnFacets.forEach(facet => params.append('return_facets', facet));
      }

      if (sort && sort.length > 0) {
        sort.forEach(sortCriteria => params.append('sort', sortCriteria));
      }

      if (queryLogging) {
        params.append('query_logging', 'enable');
      }

      // Build request body. iFinder POST search expects:
      //   { "query":   { "query": "<q>",       "query_type": "QueryStringQuery" },
      //     "filters": [{ "query": "field:val", "query_type": "QueryStringQuery" }, …] }
      const requestBody = {
        query: {
          query,
          query_type: 'QueryStringQuery'
        }
      };
      const filterQueries = this._buildFilterQueries(filter);
      if (filterQueries) {
        requestBody.filters = filterQueries;
      }

      const searchUrl = `${baseUrl}?${params.toString()}`;
      logger.debug('Sending search request to profile', {
        component: 'IFinderService',
        profileId,
        filterCount: requestBody.filters?.length || 0
      });
      // Make API request — POST with JSON body so we can apply filters.
      const response = await throttledFetch('iFinderSearch', searchUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        timeout: config.timeout,
        signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Error fetching search results', {
          component: 'IFinderService',
          query,
          profileId,
          error: errorText
        });
        throw new Error(`iFinder search failed with status ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      // Diagnostic logging for metadata queries (_id: lookups)
      if (query.startsWith('_id:') && data.results?.length > 0) {
        const rawDoc = data.results[0].document || {};
        const rawKeys = Object.keys(rawDoc);
        const emptyKeys = rawKeys.filter(k => {
          const v = rawDoc[k];
          return v == null || (Array.isArray(v) && v.length === 0);
        });
        logger.info('Metadata raw doc keys', {
          component: 'IFinderService',
          keyCount: rawKeys.length,
          keys: rawKeys
        });
        if (emptyKeys.length > 0) {
          logger.info('Metadata empty keys', {
            component: 'IFinderService',
            emptyKeyCount: emptyKeys.length,
            emptyKeys
          });
        }
      }

      // Process and normalize the results
      const results = {
        query: query,
        searchProfile: profileId,
        metadata: data.metadata || {},
        totalFound: data.metadata?.total_hits || (data.results ? data.results.length : 0),
        took: data.metadata?.took,
        results: [],
        facets: data.facets || null
      };

      // Helper function to get array field values (iFinder returns most fields as arrays)
      const getFieldValue = (doc, fieldName, defaultValue = null) => {
        const value = doc[fieldName];
        if (Array.isArray(value)) {
          return value.length === 1 ? value[0] : value;
        }
        return value || defaultValue;
      };

      // Helper function to get nested dot-notation fields and group them
      const getNestedFields = (doc, prefix) => {
        const nested = {};
        Object.keys(doc).forEach(key => {
          if (key.startsWith(prefix + '.')) {
            const subKey = key.substring(prefix.length + 1);
            nested[subKey] = getFieldValue(doc, key);
          }
        });
        return Object.keys(nested).length > 0 ? nested : null;
      };

      // iFinder returns a different field subset per source, so a fixed hit shape
      // ships mostly nulls. Drop what the deployment has nothing for — an absent
      // key and a null one mean the same to every caller.
      const isEmpty = value =>
        value === null ||
        value === undefined ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(isEmpty));
      const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => !isEmpty(v)));

      // Normalize result format with enhanced field processing
      if (data.results && Array.isArray(data.results)) {
        results.results = data.results.map(hit => {
          const doc = hit.document || {};
          const hitMetadata = hit.metadata || {};

          return compact({
            // Document identification
            id: getFieldValue(doc, 'id'),
            score: hitMetadata.score,

            // Basic document fields (iFinder returns these as arrays)
            title: getFieldValue(doc, 'title'),
            sourceName: getFieldValue(doc, 'sourceName'),
            language: getFieldValue(doc, 'language'),
            mediaType: getFieldValue(doc, 'mediaType'),
            sourceType: getFieldValue(doc, 'sourceType'),
            application: getFieldValue(doc, 'application'),
            contentLength: getFieldValue(doc, 'contentLength'),

            // Timestamps (iFinder format)
            modificationDate: getFieldValue(doc, 'modificationDate'),
            indexingDate: getFieldValue(doc, 'indexingDate'),

            // Navigation (iFinder returns as array)
            navigationTree: getFieldValue(doc, 'navigationTree', []),

            // Nested objects from dot-notation fields
            accessInfo: getNestedFields(doc, 'accessInfo'),
            file: getNestedFields(doc, 'file'),
            sourceLocations: {
              url: getFieldValue(doc, 'sourceLocations.url', []),
              label: getFieldValue(doc, 'sourceLocations.label', [])
            },

            // Backward compatibility fields
            filename: getFieldValue(doc, 'file.name'),
            size: getFieldValue(doc, 'file.size'),
            extension: getFieldValue(doc, 'file.extension'),
            sizeFormatted: (() => {
              const bytes = getFieldValue(doc, 'file.size') || getFieldValue(doc, 'contentLength');
              return bytes ? this._formatFileSize(bytes) : null;
            })(),

            // Legacy/fallback fields for backward compatibility
            url: getFieldValue(doc, 'url'),
            deepLink: getFieldValue(doc, 'accessInfo.deepLink'),
            documentType: getFieldValue(doc, 'documentType'),
            mimeType: getFieldValue(doc, 'mediaType'), // Legacy alias
            content: getFieldValue(doc, 'content'),
            source: getFieldValue(doc, 'sourceName'), // Legacy alias
            breadcrumbs: getFieldValue(doc, 'navigationTree', []), // Legacy alias
            createdDate: getFieldValue(doc, 'createdDate'),
            lastModified:
              getFieldValue(doc, 'lastModified') || getFieldValue(doc, 'modificationDate'),
            author: getFieldValue(doc, 'author'),
            owner: getFieldValue(doc, 'owner'),

            // Document text fields (if available)
            description_texts: getFieldValue(doc, 'description_texts', []),
            summary_texts: getFieldValue(doc, 'summary_texts', []),

            // Search-specific metadata. `score` and `teasers` above are the whole
            // of hit.metadata, and every document field is mapped here, so the
            // response carries no verbatim echo of either.
            teasers: hitMetadata.teasers || []
          });
        });
      }

      logger.info('Search results found', {
        component: 'IFinderService',
        totalFound: results.totalFound,
        took: results.took
      });
      return results;
    } catch (error) {
      logger.error('Search error', { component: 'IFinderService', error });
      this._handleError(error);
    }
  }

  /**
   * Fetch document content for LLM processing
   * @param {Object} params - Content fetch parameters
   * @returns {Object} Document content and metadata
   */
  async getContent({ documentId, chatId, user, searchProfile, maxLength = 50000, signal }) {
    if (!documentId) {
      throw new Error('Document ID parameter is required');
    }
    this.validateCommon(user, chatId);

    const config = this.getConfig();
    const profileId = searchProfile || config.defaultSearchProfile;

    // Track the action
    emitToolProgress(chatId, {
      phase: 'ifinder_content',
      data: { documentId, searchProfile: profileId }
    });

    try {
      // Generate JWT token for the user
      const authHeader = getIFinderAuthorizationHeader(user);

      // Construct document URL
      const documentEndpoint = config.endpoints.document
        .replace('{profileId}', encodeURIComponent(profileId))
        .replace('{docId}', encodeURIComponent(documentId));
      const documentUrl = `${config.baseUrl.replace(/\/+$/, '')}${documentEndpoint}`;

      logger.info('Fetching content for document', {
        component: 'IFinderService',
        documentId,
        profileId,
        userId: user.email || user.id
      });

      // Make API request
      const response = await throttledFetch('iFinderContent', documentUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        },
        timeout: config.timeout + 30000, // Longer timeout for content fetch
        signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 404) throw new Error(`Document not found: ${documentId}`);
        if (response.status === 403)
          throw new Error(`Access denied to document content: ${documentId}`);
        if (response.status === 413)
          throw new Error(`Document content too large. Try reducing maxLength.`);
        throw new Error(
          `iFinder content fetch failed with status ${response.status}: ${errorText}`
        );
      }

      const data = await response.json();
      const doc = data.document || {};
      const apiMetadata = data.metadata || {};
      const content = doc.content || '';

      const result = {
        // API response metadata
        searchProfile: profileId,
        took: apiMetadata.took,

        // Document identification
        documentId: doc.id || documentId,

        // Content information
        content: content,
        contentLength: content.length,
        contentLengthFormatted: this._formatContentLength(content.length),

        // Document metadata
        metadata: {
          title: doc.title,
          documentType: doc.documentType || doc.type,
          mimeType: doc.mimeType,
          language: doc.language,
          size: doc.size,
          author: doc.author || doc.creator,
          createdDate: doc.createdDate || doc.created,
          lastModified: doc.lastModified || doc.modified,
          filename: doc.filename,
          url: doc.url
        }
      };

      // Apply the caller's length cap and report the outcome explicitly.
      // `truncated` is always a boolean and `maxLength` is echoed back, so a
      // caller can branch on the result alone without re-deriving the limit
      // or comparing lengths itself.
      result.maxLength = maxLength;
      result.originalContentLength = content.length;
      result.truncated = false;

      if (result.content.length === 0) {
        logger.warn('No content extracted for document', {
          component: 'IFinderService',
          documentId
        });
      } else if (result.content.length > maxLength) {
        logger.warn('Content truncated', { component: 'IFinderService', documentId, maxLength });
        result.content = result.content.substring(0, maxLength) + '... [Content truncated]';
        result.truncated = true;
      }
      result.returnedContentLength = result.content.length;

      logger.info('Successfully fetched document content', {
        component: 'IFinderService',
        documentId,
        contentLength: result.contentLength
      });
      return result;
    } catch (error) {
      logger.error('Content fetch error', { component: 'IFinderService', error });
      this._handleError(error);
    }
  }

  /**
   * Fetch metadata for a specific document using search endpoint
   * @param {Object} params - Metadata fetch parameters
   * @returns {Object} Document metadata
   */
  async getMetadata({
    documentId,
    chatId,
    user,
    searchProfile,
    returnFields = [
      'title',
      'language',
      'accessInfo.*',
      'mediaType',
      'sourceType',
      'file.*',
      'sourceLocations.*',
      'navigationTree',
      'modificationDate',
      'indexingDate',
      'application',
      'contentLength',
      'sourceName'
    ]
  }) {
    if (!documentId) {
      throw new Error('Document ID parameter is required');
    }

    // The ID is embedded in a quoted _id:"…" query below. Document IDs can
    // arrive from model/tool parameters, so validate against the central safe
    // ID allowlist to prevent query injection.
    if (!isValidId(documentId)) {
      throw new Error('Invalid document ID format');
    }

    // Use the search method with _id:documentId query
    const searchResult = await this.search({
      query: `_id:\"${documentId}\"`,
      chatId,
      user,
      maxResults: 1,
      searchProfile,
      returnFields
    });

    // Check if document was found
    if (!searchResult.results || searchResult.results.length === 0) {
      throw new Error(`Document not found: ${documentId}`);
    }

    // Get the single result and enhance it for metadata use case
    const result = searchResult.results[0];

    // Diagnostic logging: which metadata fields survived normalization
    const metaFields = [
      'title',
      'author',
      'sourceName',
      'sourceType',
      'application',
      'mediaType',
      'modificationDate',
      'indexingDate',
      'language',
      'size',
      'filename',
      'deepLink'
    ];
    const present = metaFields.filter(f => result[f] != null && result[f] !== '');
    const missing = metaFields.filter(f => result[f] == null || result[f] === '');
    logger.info('Metadata fields status', {
      component: 'IFinderService',
      documentId,
      present,
      missing
    });

    // Add metadata-specific fields and logging
    const metadata = {
      ...result,
      // Ensure we have the document ID
      documentId: result.id || documentId,

      // Add search metadata
      searchProfile: searchResult.searchProfile,
      took: searchResult.took,
      totalFound: searchResult.totalFound,

      // Keep raw data from search result
      rawSearchResult: searchResult
    };

    logger.info('Successfully fetched document metadata', {
      component: 'IFinderService',
      documentId,
      took: metadata.took,
      score: metadata.score
    });

    return metadata;
  }

  /**
   * Issue an authenticated request against an iFinder public-API endpoint and
   * return the parsed JSON body.
   *
   * Every discovery call needs the same four things — a user-scoped JWT, an
   * absolute URL built from the configured base, a timeout, and iFinder's
   * RFC-9457 `application/problem+json` error body turned into a readable
   * Error — so they share this instead of each repeating it.
   *
   * @param {Object} params
   * @param {string} params.path     Endpoint path, already interpolated.
   * @param {Object} params.user     Authenticated user (JWT subject).
   * @param {string} [params.label]  Throttle bucket / log label.
   * @param {string} [params.method] HTTP method, default GET.
   * @param {Object} [params.body]   JSON body for POST.
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Object>} Parsed JSON response
   */
  async _apiRequest({ path, user, label = 'iFinderApi', method = 'GET', body, signal }) {
    const cfg = this.getConfig();
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}${path}`;
    const authHeader = getIFinderAuthorizationHeader(user);

    const headers = { Authorization: authHeader, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await throttledFetch(label, url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      timeout: cfg.timeout,
      signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('iFinder API request failed', {
        component: 'IFinderService',
        label,
        status: response.status,
        error: errorText
      });
      throw new Error(`${label} failed with status ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  /**
   * Fetch the index field catalog from iFinder.
   *
   * Calls `GET /public-api/retrieval/api/v1/schema-types/{schemaType}/fields`,
   * which reads the live OpenSearch mapping and reports, per field, which name
   * to use for each purpose:
   *
   *   `full_text_search` — the analyzed name to put in a query (`creators`)
   *   `filter`           — the exact-match name (`creators.keyword`)
   *   `aggregation`      — the name valid as a facet id (`creators.keyword`)
   *   `sort`             — the name valid in a `sort` criterion
   *
   * A `null` means the field does not serve that purpose at all — the catalog
   * is therefore the authoritative answer to "does this field need `.keyword`?"
   * for a given deployment, including custom (`cust.*`) fields that no static
   * documentation can list.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.chatId
   * @param {string} [params.schemaType] Schema type to describe. Only `document` exists today.
   * @param {string} [params.filterPrefix] Return only fields whose name starts with this prefix.
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Object>} { schemaType, totalFields, fields, filterable, aggregatable, sortable, fullTextSearchable }
   */
  async getFields({ user, chatId, schemaType = 'document', filterPrefix, signal }) {
    this.validateCommon(user, chatId);

    if (!isValidId(schemaType)) {
      throw new Error('Invalid schema type');
    }

    emitToolProgress(chatId, {
      phase: 'ifinder_fields',
      data: { schemaType }
    });

    try {
      const cfg = this.getConfig();
      const path = cfg.endpoints.fields.replace('{schemaType}', encodeURIComponent(schemaType));
      const data = await this._apiRequest({ path, user, label: 'iFinderFields', signal });

      const raw = data && typeof data === 'object' ? data : {};
      const prefix = typeof filterPrefix === 'string' && filterPrefix ? filterPrefix : null;

      const fields = {};
      for (const [name, descriptor] of Object.entries(raw)) {
        if (prefix && !name.startsWith(prefix)) continue;
        const d = descriptor || {};
        fields[name] = {
          type: d.type ?? null,
          // Name to use in a query string for relevance-ranked matching.
          fullTextSearch: d.full_text_search ?? null,
          // Name to use in a filter / exact match — this is where `.keyword` shows up.
          filter: d.filter ?? null,
          // Name valid as a `returnFacets` entry.
          aggregation: d.aggregation ?? null,
          // Name valid in a `sort` criterion.
          sort: d.sort ?? null
        };
      }

      const pick = key =>
        Object.values(fields)
          .map(f => f[key])
          .filter(Boolean)
          .sort();

      const result = {
        schemaType,
        totalFields: Object.keys(fields).length,
        fields,
        fullTextSearchable: pick('fullTextSearch'),
        filterable: pick('filter'),
        aggregatable: pick('aggregation'),
        sortable: pick('sort')
      };

      logger.info('Fetched iFinder field catalog', {
        component: 'IFinderService',
        schemaType,
        totalFields: result.totalFields
      });

      return result;
    } catch (error) {
      logger.error('Field catalog error', { component: 'IFinderService', error });
      this._handleError(error);
    }
  }

  /**
   * Enumerate the values of a single facet.
   *
   * Calls `POST /public-api/retrieval/api/v1/search-profiles/{profileId}/facets/{facetId}/_search`,
   * which returns far more values than the capped facet block riding along with
   * a search response — the way to answer "which sources / authors / languages
   * exist here?" without paging through documents.
   *
   * `facet` must name an *aggregatable* field, which for text fields means the
   * `.keyword` variant (`creators.keyword`, not `creators`). `getFields()`
   * reports the correct name per field in its `aggregation` entry.
   *
   * @param {Object} params
   * @param {string} params.facet          Facet id — an aggregatable field name.
   * @param {Object} params.user
   * @param {string} params.chatId
   * @param {string} [params.query]        Scope query. Defaults to `*` (everything).
   * @param {Array<string>} [params.filter] Filter query strings, ANDed with the query.
   * @param {number} [params.maxValues]    Max values to return (default 50).
   * @param {string} [params.sort]         `count:desc` (default), `value:asc` or `value:desc`.
   * @param {string} [params.searchProfile]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Object>} { facet, searchProfile, query, totalValues, hasMore, values }
   */
  async getFacetValues({
    facet,
    user,
    chatId,
    query = '*',
    filter,
    maxValues = 50,
    sort = 'count:desc',
    searchProfile,
    signal
  }) {
    if (!facet || typeof facet !== 'string') {
      throw new Error('facet parameter is required');
    }
    this.validateCommon(user, chatId);

    const cfg = this.getConfig();
    const profileId = searchProfile || cfg.defaultSearchProfile;

    emitToolProgress(chatId, {
      phase: 'ifinder_facet_values',
      message: facet,
      data: { facet, searchProfile: profileId }
    });

    try {
      const endpoint = cfg.endpoints.facets
        .replace('{profileId}', encodeURIComponent(profileId))
        .replace('{facetId}', encodeURIComponent(facet));

      const params = new URLSearchParams();
      params.append('size', String(Math.min(Math.max(maxValues, 1), 1000)));
      if (sort) params.append('sort', sort);

      // POST so filters can be applied; the GET variant takes a query string only.
      const body = { query: { query, query_type: 'QueryStringQuery' } };
      const filters = this._buildFilterQueries(filter);
      if (filters) body.filters = filters;

      const data = await this._apiRequest({
        path: `${endpoint}?${params.toString()}`,
        user,
        label: 'iFinderFacetValues',
        method: 'POST',
        body,
        signal
      });

      const blocks = this._normaliseFacets(data);
      const block = blocks.find(b => b.field === facet) ||
        blocks[0] || { values: [], hasMore: false };

      logger.info('Fetched iFinder facet values', {
        component: 'IFinderService',
        facet,
        profileId,
        valueCount: block.values.length
      });

      return {
        facet,
        searchProfile: profileId,
        query,
        totalValues: block.values.length,
        hasMore: Boolean(block.hasMore),
        values: block.values
      };
    } catch (error) {
      logger.error('Facet values error', { component: 'IFinderService', facet, error });
      this._handleError(error);
    }
  }

  /**
   * List the search profiles reachable by the calling user.
   *
   * The public API has no "list search profiles" endpoint — profile listing
   * lives on the admin API, which an end-user token cannot reach. What it does
   * expose is `GET /public-api/v0/assistants`, and every iAssistant names the
   * search profile it is composed with, filtered to the ones the caller may
   * use. That makes the assistants list the only user-scoped source of profile
   * ids available here, so this derives the profiles from it and always
   * includes the configured default.
   *
   * A deployment with no iAssistants configured therefore reports just the
   * configured default. That is a limitation of the upstream API, not an error.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.chatId
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Object>} { defaultSearchProfile, profiles, assistants, source }
   */
  async listProfiles({ user, chatId, signal }) {
    this.validateCommon(user, chatId);

    const cfg = this.getConfig();
    const defaultProfile = cfg.defaultSearchProfile;

    emitToolProgress(chatId, { phase: 'ifinder_profiles', data: {} });

    let assistants = [];
    let source = 'configured-default';

    try {
      const data = await this._apiRequest({
        path: `${cfg.endpoints.assistants}?size=100`,
        user,
        label: 'iFinderAssistants',
        signal
      });
      assistants = Array.isArray(data?.assistants) ? data.assistants : [];
      source = 'assistants';
    } catch (error) {
      // A deployment older than the iAssistants API answers 404 here, and a
      // deployment without the feature answers 403. Neither is fatal: the
      // configured default is still a usable answer, so degrade instead of
      // failing the whole discovery flow.
      logger.warn('Could not list iFinder assistants; falling back to configured default', {
        component: 'IFinderService',
        error: error.message
      });
    }

    const byProfile = new Map();
    byProfile.set(defaultProfile, {
      id: defaultProfile,
      isDefault: true,
      assistants: []
    });

    for (const assistant of assistants) {
      const profileId = assistant?.search_profile_id;
      if (!profileId) continue;
      if (!byProfile.has(profileId)) {
        byProfile.set(profileId, { id: profileId, isDefault: false, assistants: [] });
      }
      byProfile.get(profileId).assistants.push({
        id: assistant.id,
        name: assistant.name,
        description: assistant.description ?? null
      });
    }

    logger.info('Listed iFinder search profiles', {
      component: 'IFinderService',
      profileCount: byProfile.size,
      source
    });

    return {
      defaultSearchProfile: defaultProfile,
      profiles: Array.from(byProfile.values()),
      assistants: assistants.map(a => ({
        id: a.id,
        name: a.name,
        searchProfileId: a.search_profile_id ?? null
      })),
      source
    };
  }

  /**
   * Probe a search profile to surface what is queryable.
   *
   * Runs one search() call with `return_facets` and a small sample size and
   * normalises the result into both a structured payload AND a ready-to-paste
   * markdown body — designed to be appended into an agent's long-term memory
   * under a heading like `## iFinder corpus map`. The intent is operator-driven
   * discovery: an admin triggers this once per search profile, the output
   * lands in memory, and agent runs auto-include it via the existing memory
   * plumbing.
   *
   * @param {Object} params
   * @param {string} params.searchProfile  Required iFinder search profile id.
   * @param {string} [params.query]        Optional scope query. Defaults to `*:*`.
   * @param {Array<string>} [params.facets] Facet fields to probe.
   * @param {number} [params.sampleSize]   Max sample documents to list.
   * @param {boolean} [params.includeFields] Also fetch the field catalog (default true).
   * @returns {Object} { searchProfile, query, totalFound, facets, fields, sampleDocs, markdown }
   */
  async discover({
    searchProfile,
    query = '*:*',
    chatId,
    user,
    facets = [
      'sourceName.keyword',
      'application.keyword',
      'language.keyword',
      'creators.keyword',
      'navigationTree'
    ],
    sampleSize = 10,
    includeFields = true
  }) {
    if (!searchProfile || typeof searchProfile !== 'string') {
      throw new Error('searchProfile is required for discovery');
    }
    this.validateCommon(user, chatId);

    logger.info('Running iFinder discovery', {
      component: 'IFinderService',
      searchProfile,
      query,
      facets,
      sampleSize
    });

    const searchResult = await this.search({
      query,
      chatId,
      user,
      searchProfile,
      maxResults: Math.max(0, sampleSize),
      returnFacets: facets,
      returnFields: ['id', 'title', 'sourceName', 'mediaType', 'language', 'navigationTree']
    });

    const sampleDocs = (searchResult.results || []).map(hit => ({
      docId: hit.id,
      title: hit.title,
      sourceName: hit.sourceName,
      mediaType: hit.mediaType,
      language: hit.language
    }));

    const facetBlocks = this._normaliseFacets(searchResult.facets);

    // The field catalog is profile-independent and a separate call, so a
    // deployment that cannot serve it (older iFinder, endpoint disabled) must
    // not take the rest of the probe down with it.
    let fieldCatalog = null;
    if (includeFields) {
      try {
        fieldCatalog = await this.getFields({ user, chatId });
      } catch (error) {
        logger.warn('Discovery could not fetch the field catalog', {
          component: 'IFinderService',
          error: error.message
        });
      }
    }

    const markdown = this._buildDiscoveryMarkdown({
      searchProfile,
      query,
      totalFound: searchResult.totalFound,
      facetBlocks,
      sampleDocs,
      fieldCatalog
    });

    return {
      searchProfile,
      query,
      totalFound: searchResult.totalFound,
      facets: facetBlocks,
      fields: fieldCatalog,
      sampleDocs,
      probedAt: new Date().toISOString(),
      markdown
    };
  }

  /**
   * Render a discovery probe as markdown.
   *
   * Written to be pasted straight into an agent's long-term memory, so it
   * carries the field names a follow-up query needs (`.keyword` variants
   * included) rather than prose about them.
   *
   * @param {Object} params
   * @returns {string} Markdown body
   */
  _buildDiscoveryMarkdown({
    searchProfile,
    query,
    totalFound,
    facetBlocks = [],
    sampleDocs = [],
    fieldCatalog = null
  }) {
    const lines = [];
    lines.push(`_Profile_: \`${searchProfile}\`  •  _Probed_: ${new Date().toISOString()}`);
    lines.push(`_Query_: \`${query}\`  •  _Hits_: ${totalFound ?? 0}`);
    lines.push('');

    for (const block of facetBlocks) {
      if (block.values.length === 0) continue;
      lines.push(`**${block.field}**`);
      for (const entry of block.values.slice(0, 8)) {
        lines.push(`- ${entry.value} — ${entry.count} docs`);
      }
      if (block.hasMore) {
        lines.push(`- … more values — enumerate with \`getFacetValues\` on \`${block.field}\``);
      }
      lines.push('');
    }

    if (sampleDocs.length > 0) {
      lines.push('**Sample titles**');
      for (const doc of sampleDocs) {
        const id = doc.docId ? ` (\`${doc.docId}\`)` : '';
        lines.push(`- ${doc.title || '(untitled)'}${id}`);
      }
      lines.push('');
    }

    if (fieldCatalog) {
      lines.push(`**Fields** — ${fieldCatalog.totalFields} in the index schema`);
      lines.push(`- Filterable: \`${fieldCatalog.filterable.slice(0, 25).join('`, `')}\``);
      lines.push(`- Facetable: \`${fieldCatalog.aggregatable.slice(0, 25).join('`, `')}\``);
      lines.push(`- Sortable: \`${fieldCatalog.sortable.slice(0, 25).join('`, `')}\``);
      lines.push('');
      lines.push('Call `getFields` for the full catalog with the exact name to use per purpose.');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Turn a list of filter query strings into the `filters` array iFinder's
   * search and facet endpoints expect: each entry is ANDed with the main query
   * but, unlike the query itself, contributes nothing to relevance ranking.
   *
   * @param {Array<string>} filter
   * @returns {Array<Object>|null} `filters` payload, or null when there is nothing to send
   */
  _buildFilterQueries(filter) {
    if (!Array.isArray(filter) || filter.length === 0) return null;
    const queries = filter
      .filter(f => typeof f === 'string' && f.trim())
      .map(f => ({ query: f.trim(), query_type: 'QueryStringQuery' }));
    return queries.length > 0 ? queries : null;
  }

  /**
   * Normalise a facet payload into `[{ field, values: [{value, count}], hasMore }]`.
   *
   * The public API answers with `FacetsResult` — `{ metadata, results: [{ id,
   * type, has_more, values: [{ value, count }] }] }` — on both the search
   * response's `facets` block and the dedicated facet endpoint. That envelope
   * is unwrapped first; without it `Object.entries` reads `metadata` and
   * `results` as if they were facet names and every value comes back as
   * `(unknown)`.
   *
   * Bare arrays and plain `{ field: values }` maps are still accepted so a
   * caller holding an already-unwrapped block keeps working.
   *
   * @param {Object|Array} facets
   * @returns {Array<{field: string, values: Array<{value: string, count: number}>, hasMore: boolean}>}
   */
  _normaliseFacets(facets) {
    if (!facets) return [];

    // `FacetsResult` envelope — unwrap to the facet list it carries.
    if (
      !Array.isArray(facets) &&
      typeof facets === 'object' &&
      ('results' in facets || 'metadata' in facets)
    ) {
      return Array.isArray(facets.results) ? this._normaliseFacets(facets.results) : [];
    }

    if (Array.isArray(facets)) {
      return facets
        .filter(f => f && typeof f === 'object')
        .map(f => ({
          field: f.id || f.field || f.name || 'facet',
          values: this._normaliseFacetValues(f.values || f.buckets || []),
          hasMore: Boolean(f.has_more ?? f.hasMore ?? false)
        }));
    }

    if (typeof facets === 'object') {
      return Object.entries(facets).map(([field, values]) => ({
        field,
        values: this._normaliseFacetValues(values),
        hasMore: false
      }));
    }

    return [];
  }

  _normaliseFacetValues(values) {
    if (!Array.isArray(values)) return [];
    return values
      .map(v => {
        if (typeof v === 'string') return { value: v, count: 0 };
        if (v && typeof v === 'object') {
          return {
            value: v.value ?? v.key ?? v.label ?? '(unknown)',
            count: v.count ?? v.doc_count ?? 0
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Download/save document content locally
   * @param {Object} params - Download parameters
   * @returns {Object} Download result or content info
   */
  async download({ documentId, chatId, user, searchProfile, action = 'content', filename }) {
    if (!documentId) {
      throw new Error('Document ID parameter is required');
    }
    this.validateCommon(user, chatId);

    if (!['content', 'save'].includes(action)) {
      throw new Error('Action must be either "content" or "save"');
    }

    const config = this.getConfig();
    const profileId = searchProfile || config.defaultSearchProfile;

    // Track the action
    emitToolProgress(chatId, {
      phase: 'ifinder_download',
      data: { documentId, searchProfile: profileId, downloadAction: action }
    });

    try {
      // Generate JWT token for the user
      const authHeader = getIFinderAuthorizationHeader(user);

      // Construct document URL
      const documentEndpoint = config.endpoints.document
        .replace('{profileId}', encodeURIComponent(profileId))
        .replace('{docId}', encodeURIComponent(documentId));
      const documentUrl = `${config.baseUrl.replace(/\/+$/, '')}${documentEndpoint}`;

      if (action === 'content') {
        // Return document content info without saving
        logger.info('Fetching document content info', {
          component: 'IFinderService',
          documentId,
          userId: user.email || user.id
        });

        return {
          documentId: documentId,
          action: 'content',
          searchProfile: profileId,
          documentUrl: documentUrl,
          note: 'Real iFinder API does not support direct file downloads. Use the document URL to retrieve content.',
          authRequired: true,
          authorizationHeader: authHeader,
          instructions: 'Use iFinder.getContent tool to get the actual document content.',
          alternativeTools: ['iFinder.getContent', 'iFinder.getMetadata']
        };
      }

      // Server-side save of document content
      logger.info('Saving document content', {
        component: 'IFinderService',
        documentId,
        userId: user.email || user.id
      });

      // Make API request to get document content
      const response = await throttledFetch('iFinderDownload', documentUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        },
        timeout: config.timeout + 90000 // Longer timeout for downloads
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 404) throw new Error(`Document not found: ${documentId}`);
        if (response.status === 403) throw new Error(`Access denied to document: ${documentId}`);
        throw new Error(
          `iFinder document fetch failed with status ${response.status}: ${errorText}`
        );
      }

      const data = await response.json();
      const doc = data.document || {};
      const apiMetadata = data.metadata || {};

      // Determine filename
      const actualFilename = filename || doc.filename || doc.title || `document_${documentId}.txt`;

      // Ensure download directory exists
      this._ensureDownloadDirectory(config.downloadDir);

      // Generate unique filename to avoid conflicts
      const timestamp = new Date().getTime();
      const safeFilename = actualFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
      const localFilename = `${timestamp}_${safeFilename}`;
      const localPath = path.join(config.downloadDir, localFilename);

      // Save document content to local storage
      const content = doc.content || '';
      const contentBuffer = Buffer.from(content, 'utf8');
      fs.writeFileSync(localPath, contentBuffer);

      const result = {
        documentId: documentId,
        action: 'save',
        success: true,
        searchProfile: profileId,
        took: apiMetadata.took,

        // File information
        filename: actualFilename,
        localFilename: localFilename,
        localPath: localPath,
        size: contentBuffer.length,
        sizeFormatted: this._formatFileSize(contentBuffer.length),
        savedAt: new Date().toISOString(),

        // Document information from API
        title: doc.title,
        documentType: doc.documentType || doc.type,
        mimeType: doc.mimeType,
        language: doc.language,
        author: doc.author,

        // Content metadata
        contentLength: content.length,
        hasContent: content.length > 0,

        // API metadata
        temporaryFile: true,
        note: 'Document content saved as text file. Real iFinder API does not provide original file downloads.'
      };

      // Optionally save metadata file
      const metadataFilename = `${timestamp}_${documentId}_metadata.json`;
      const metadataPath = path.join(config.downloadDir, metadataFilename);

      const metadata = {
        documentId: doc.id || documentId,
        title: doc.title,
        documentType: doc.documentType,
        language: doc.language,
        author: doc.author,
        size: doc.size,
        retrievedAt: new Date().toISOString(),
        searchProfile: profileId,
        apiMetadata: apiMetadata
      };

      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      result.metadataFile = {
        filename: metadataFilename,
        localPath: metadataPath
      };

      logger.info('Successfully saved document content', {
        component: 'IFinderService',
        documentId,
        sizeFormatted: result.sizeFormatted
      });
      return result;
    } catch (error) {
      logger.error('Download error', { component: 'IFinderService', error });
      this._handleError(error);
    }
  }

  /**
   * Ensure download directory exists
   * @param {string} downloadDir - Directory path
   */
  _ensureDownloadDirectory(downloadDir) {
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
  }

  /**
   * Format content length in human readable format
   * @param {number} length - Content length in characters
   * @returns {string} Formatted content length
   */
  _formatContentLength(length) {
    if (length < 1000) {
      return `${length} characters`;
    } else if (length < 1000000) {
      return `${Math.round((length / 1000) * 10) / 10}K characters`;
    } else {
      return `${Math.round((length / 1000000) * 10) / 10}M characters`;
    }
  }

  /**
   * Format file size in human readable format
   * @param {number} bytes - File size in bytes
   * @returns {string} Formatted file size
   */
  _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Resolve the download link for a document by searching iFinder's internal API.
   * The returned URL contains an opaque access token and is NOT the document ID.
   * @param {Object} params
   * @param {string} params.documentId - The document ID to look up
   * @param {Object} params.user - User object for authentication
   * @param {string} [params.searchProfile] - Optional search profile
   * @returns {string} Relative URL like "internal-api/v2/docs?action=fetchdocument&id=<token>"
   */
  async resolveDocumentLink({ documentId, user, searchProfile: _searchProfile }) {
    if (!documentId) {
      throw new Error('Document ID is required');
    }

    const config = this.getConfig();
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const authHeader = getIFinderAuthorizationHeader(user);

    // Validate documentId against the central safe ID allowlist to prevent
    // query injection into the sSearchTerm below.
    if (!isValidId(documentId)) {
      throw new Error('Invalid document ID format');
    }

    const searchUrl =
      `${baseUrl}/internal-api/v2/search?` +
      new URLSearchParams({
        action: 'search',
        sSearchTerm: `_id:"${documentId}"`,
        limit: '1'
      });

    logger.info('Searching for document link', { component: 'IFinderService', documentId });

    const response = await throttledFetch('iFinderDocLink', searchUrl, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
      timeout: config.timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`iFinder search failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    // The internal search API may return results under various keys — log for debugging
    logger.debug('Document link search response keys', {
      component: 'IFinderService',
      keys: Object.keys(data)
    });

    const result = data.documents?.[0] || data.results?.[0] || data[0];
    if (!result) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const links = result.links || result.document?.links || [];
    const accessLink = links.find(l => l.type === 'ACCESS');
    if (!accessLink?.url) {
      const linkTypes = links.map(l => l.type).join(', ');
      logger.warn('No ACCESS link found for document', {
        component: 'IFinderService',
        documentId,
        availableLinkTypes: linkTypes
      });
      throw new Error(`No download link found for document: ${documentId}`);
    }

    logger.info('Resolved download link for document', { component: 'IFinderService', documentId });
    return accessLink.url;
  }

  /**
   * Handle errors consistently across all methods
   * @param {Error} error - The error to handle
   */
  _handleError(error) {
    if (error.message.includes('JWT') || error.message.includes('authentication')) {
      throw new Error('iFinder authentication failed. Please check JWT configuration.');
    }

    if (error.message.includes('timeout')) {
      throw new Error('iFinder request timed out. Please try again.');
    }

    if (error.message.includes('ENOSPC')) {
      throw new Error('Insufficient disk space for saving document.');
    }

    throw new Error(`iFinder operation failed: ${error.message}`);
  }
}

// Export singleton instance
export default new IFinderService();
