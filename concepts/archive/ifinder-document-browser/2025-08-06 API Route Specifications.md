# iFinder Document Browser API Route Specifications

## Overview

This document defines the API routes that need to be implemented to support the iFinder Document Browser React component. These routes extend the existing iFinder integration to provide browser-optimized search and metadata retrieval.

## Required API Routes

### 1. Enhanced Search Endpoint

**Route:** `GET /api/ifinder/browser/search`

**Purpose:** Provides browser-optimized search with faceting, filtering, and pagination support.

**Authentication:** Required (JWT token)

**Query Parameters:**
```javascript
{
  // Search parameters
  query?: string,                    // Search query
  searchProfile?: string,            // Search profile ID (default: 'default')
  
  // Pagination
  page?: number,                     // Page number (default: 1)
  limit?: number,                    // Results per page (default: 20, max: 100)
  
  // Filtering
  documentTypes?: string[],          // Array of document types to filter by
  dateField?: 'created' | 'modified', // Date field to filter on (default: 'modified')
  dateStart?: string,                // ISO date string for date range start
  dateEnd?: string,                  // ISO date string for date range end
  authors?: string[],                // Array of author names to filter by
  sources?: string[],                // Array of source names to filter by
  sizeMin?: number,                  // Minimum file size in bytes
  sizeMax?: number,                  // Maximum file size in bytes
  
  // Sorting
  sortBy?: 'relevance' | 'title' | 'author' | 'created' | 'modified' | 'size',
  sortDirection?: 'asc' | 'desc',    // Sort direction (default: 'desc')
  
  // Response options
  includePreview?: boolean,          // Include content preview snippets (default: false)
  includeFacets?: boolean,           // Include facet data (default: false)
  includeThumbnails?: boolean,       // Include thumbnail URLs (default: false)
  maxPreviewLength?: number          // Maximum preview length (default: 200)
}
```

**Response Format:**
```javascript
{
  results: Array<{
    id: string,
    title: string,
    author: string,
    documentType: string,
    mimeType: string,
    size: number,
    sizeFormatted: string,
    createdDate: string,
    lastModified: string,
    url?: string,
    filename?: string,
    snippet?: string,              // Preview snippet if requested
    thumbnailUrl?: string,         // Thumbnail URL if available
    score: number,                 // Relevance score
    metadata: Record<string, any>  // Additional metadata
  }>,
  
  totalCount: number,              // Total number of matching documents
  page: number,                    // Current page
  pageSize: number,                // Results per page
  totalPages: number,              // Total number of pages
  hasMore: boolean,                // Whether more results are available
  
  facets?: {                       // Facet data if requested
    documentTypes: Array<{
      value: string,
      count: number,
      label: string
    }>,
    authors: Array<{
      value: string,
      count: number,
      displayName: string
    }>,
    sources: Array<{
      value: string,
      count: number,
      displayName: string
    }>,
    dateRanges: {
      created: { min: string, max: string },
      modified: { min: string, max: string }
    },
    sizeRange: { min: number, max: number }
  },
  
  searchProfile: string,           // Search profile used
  queryTime: number,               // Search execution time in milliseconds
  query: string                    // Original query
}
```

**Implementation Example:**
```javascript
// server/routes/integrations/ifinderBrowserRoutes.js
import express from 'express';
import { authRequired } from '../../middleware/authRequired.js';
import iFinderService from '../../services/integrations/iFinderService.js';
import { validateSearchParams } from '../../validators/browserSearchValidator.js';

const router = express.Router();

router.get('/search', authRequired, async (req, res) => {
  try {
    const params = validateSearchParams(req.query);
    
    // Generate chat ID for tracking
    const chatId = `browser-${req.user.id}-${Date.now()}`;
    
    // Call enhanced search with browser-specific options
    const searchResults = await iFinderService.searchWithFacets({
      query: params.query,
      chatId,
      user: req.user,
      searchProfile: params.searchProfile,
      filters: {
        documentTypes: params.documentTypes,
        dateRange: params.dateStart || params.dateEnd ? {
          field: params.dateField || 'modified',
          start: params.dateStart ? new Date(params.dateStart) : null,
          end: params.dateEnd ? new Date(params.dateEnd) : null
        } : null,
        authors: params.authors,
        sources: params.sources,
        sizeRange: params.sizeMin || params.sizeMax ? {
          min: params.sizeMin,
          max: params.sizeMax
        } : null
      },
      sorting: {
        field: params.sortBy || 'relevance',
        direction: params.sortDirection || 'desc'
      },
      pagination: {
        page: params.page || 1,
        limit: Math.min(params.limit || 20, 100)
      },
      options: {
        includePreview: params.includePreview === 'true',
        includeFacets: params.includeFacets === 'true',
        includeThumbnails: params.includeThumbnails === 'true',
        maxPreviewLength: params.maxPreviewLength || 200
      }
    });
    
    res.json(searchResults);
  } catch (error) {
    console.error('Browser search error:', error);
    res.status(500).json({ 
      error: 'Search failed',
      message: error.message 
    });
  }
});

export default router;
```

### 2. Search Suggestions Endpoint

**Route:** `POST /api/ifinder/browser/search-suggestions`

**Purpose:** Provides auto-complete suggestions for search queries.

**Authentication:** Required (JWT token)

**Request Body:**
```javascript
{
  query: string,                   // Partial query string (minimum 2 characters)
  searchProfile: string,           // Search profile ID
  limit?: number,                  // Maximum suggestions (default: 5, max: 10)
  types?: string[]                 // Types of suggestions to include
}
```

**Response Format:**
```javascript
{
  suggestions: Array<{
    text: string,                  // Suggested search text
    type: 'query' | 'title' | 'author' | 'content',
    score: number,                 // Relevance score
    documentCount?: number,        // Number of documents matching suggestion
    metadata?: Record<string, any> // Additional metadata
  }>,
  query: string,                   // Original query
  searchProfile: string            // Search profile used
}
```

### 3. Batch Document Preview Endpoint

**Route:** `POST /api/ifinder/browser/batch-preview`

**Purpose:** Efficiently retrieves metadata and preview content for multiple documents.

**Authentication:** Required (JWT token)

**Request Body:**
```javascript
{
  documentIds: string[],           // Array of document IDs (max: 50)
  searchProfile: string,           // Search profile ID
  includeContent?: boolean,        // Include content preview (default: true)
  maxContentLength?: number,       // Maximum content length (default: 500)
  includeMetadata?: boolean,       // Include full metadata (default: true)
  includeThumbnails?: boolean      // Include thumbnail URLs (default: false)
}
```

**Response Format:**
```javascript
{
  documents: Array<{
    id: string,
    success: boolean,
    metadata?: {
      title: string,
      author: string,
      documentType: string,
      mimeType: string,
      size: number,
      sizeFormatted: string,
      createdDate: string,
      lastModified: string,
      url?: string,
      filename?: string,
      thumbnailUrl?: string,
      additionalMetadata: Record<string, any>
    },
    preview?: string,              // Content preview if requested
    error?: string                 // Error message if retrieval failed
  }>,
  searchProfile: string,           // Search profile used
  processedCount: number,          // Number of documents processed
  successCount: number,            // Number of successful retrievals
  queryTime: number                // Total processing time
}
```

### 4. Document Facets Endpoint

**Route:** `GET /api/ifinder/browser/facets`

**Purpose:** Retrieves available filter options (facets) for a search profile.

**Authentication:** Required (JWT token)

**Query Parameters:**
```javascript
{
  searchProfile?: string,          // Search profile ID (default: 'default')
  query?: string,                  // Optional query to filter facets
  includeEmpty?: boolean           // Include facets with zero count (default: false)
}
```

**Response Format:**
```javascript
{
  facets: {
    documentTypes: Array<{
      value: string,               // Document type identifier
      count: number,               // Number of documents of this type
      label: string,               // Human-readable label
      mimeTypes: string[]          // Associated MIME types
    }>,
    
    authors: Array<{
      value: string,               // Author identifier
      count: number,               // Number of documents by this author
      displayName: string,         // Author's display name
      email?: string               // Author's email if available
    }>,
    
    sources: Array<{
      value: string,               // Source identifier
      count: number,               // Number of documents from this source
      displayName: string,         // Source display name
      description?: string         // Source description
    }>,
    
    dateRanges: {
      created: {
        min: string,               // Earliest creation date (ISO string)
        max: string,               // Latest creation date (ISO string)
        buckets?: Array<{          // Date histogram buckets
          date: string,
          count: number
        }>
      },
      modified: {
        min: string,               // Earliest modification date
        max: string,               // Latest modification date
        buckets?: Array<{
          date: string,
          count: number
        }>
      }
    },
    
    sizeRanges: {
      min: number,                 // Smallest file size in bytes
      max: number,                 // Largest file size in bytes
      buckets: Array<{             // Size range buckets
        min: number,
        max: number,
        count: number,
        label: string              // Human-readable size range
      }>
    },
    
    languages: Array<{
      value: string,               // Language code
      count: number,               // Number of documents in this language
      displayName: string          // Language display name
    }>,
    
    customFields?: Record<string, Array<{
      value: any,
      count: number,
      label?: string
    }>>
  },
  
  searchProfile: string,           // Search profile used
  totalDocuments: number,          // Total number of documents in profile
  queryTime: number                // Facet generation time
}
```

## Enhanced iFinder Service Methods

The existing `iFinderService.js` needs to be extended with browser-specific methods:

### Extended Search Method

```javascript
// server/services/integrations/iFinderService.js

/**
 * Enhanced search with browser-specific features
 * @param {Object} params - Enhanced search parameters
 * @returns {Object} Enhanced search results
 */
async searchWithFacets({
  query,
  chatId,
  user,
  searchProfile,
  filters = {},
  sorting = { field: 'relevance', direction: 'desc' },
  pagination = { page: 1, limit: 20 },
  options = {}
}) {
  // Validate parameters
  this.validateCommon(user, chatId);
  
  const config = this.getConfig();
  const profileId = searchProfile || config.defaultSearchProfile;
  
  // Build enhanced search parameters
  const searchParams = this.buildEnhancedSearchParams({
    query,
    filters,
    sorting,
    pagination,
    options
  });
  
  // Execute search with faceting
  const searchResults = await this.executeEnhancedSearch(
    profileId, 
    searchParams, 
    user
  );
  
  // Process and format results
  return this.formatBrowserSearchResults(searchResults, options);
}

/**
 * Build enhanced search parameters for iFinder API
 */
buildEnhancedSearchParams({ query, filters, sorting, pagination, options }) {
  const params = new URLSearchParams();
  
  // Basic search parameters
  if (query) params.append('query', query);
  params.append('size', pagination.limit.toString());
  params.append('from', ((pagination.page - 1) * pagination.limit).toString());
  
  // Sorting
  if (sorting.field !== 'relevance') {
    const sortField = this.mapSortField(sorting.field);
    params.append('sort', `${sortField}:${sorting.direction}`);
  }
  
  // Filters
  if (filters.documentTypes && filters.documentTypes.length > 0) {
    const typeFilter = filters.documentTypes.map(type => 
      `mediaType:${type}`
    ).join(' OR ');
    params.append('filter', `(${typeFilter})`);
  }
  
  if (filters.dateRange) {
    const dateField = filters.dateRange.field === 'created' ? 'created' : 'modified';
    const startDate = filters.dateRange.start?.toISOString();
    const endDate = filters.dateRange.end?.toISOString();
    
    if (startDate && endDate) {
      params.append('filter', `${dateField}:[${startDate} TO ${endDate}]`);
    } else if (startDate) {
      params.append('filter', `${dateField}:[${startDate} TO *]`);
    } else if (endDate) {
      params.append('filter', `${dateField}:[* TO ${endDate}]`);
    }
  }
  
  if (filters.authors && filters.authors.length > 0) {
    const authorFilter = filters.authors.map(author => 
      `author:"${author}"`
    ).join(' OR ');
    params.append('filter', `(${authorFilter})`);
  }
  
  if (filters.sizeRange) {
    const { min, max } = filters.sizeRange;
    if (min !== undefined && max !== undefined) {
      params.append('filter', `size:[${min} TO ${max}]`);
    } else if (min !== undefined) {
      params.append('filter', `size:[${min} TO *]`);
    } else if (max !== undefined) {
      params.append('filter', `size:[* TO ${max}]`);
    }
  }
  
  // Faceting
  if (options.includeFacets) {
    params.append('return_facets', 'mediaType');
    params.append('return_facets', 'author');
    params.append('return_facets', 'sourceName');
    params.append('return_facets', 'language');
    params.append('return_facets', 'modified');
    params.append('return_facets', 'size');
  }
  
  // Return fields
  const returnFields = [
    'id', 'title', 'author', 'mediaType', 'size', 'created', 'modified',
    'url', 'filename', 'sourceName', 'language', 'description_texts'
  ];
  
  if (options.includePreview) {
    returnFields.push('content');
  }
  
  returnFields.forEach(field => {
    params.append('return_fields', field);
  });
  
  return params;
}

/**
 * Format search results for browser consumption
 */
formatBrowserSearchResults(rawResults, options) {
  const results = {
    results: [],
    totalCount: rawResults.metadata?.total_hits || 0,
    page: Math.floor((rawResults.metadata?.from || 0) / (rawResults.metadata?.size || 20)) + 1,
    pageSize: rawResults.metadata?.size || 20,
    hasMore: false,
    facets: null,
    searchProfile: rawResults.searchProfile,
    queryTime: rawResults.metadata?.took || 0,
    query: rawResults.query
  };
  
  // Calculate pagination
  results.totalPages = Math.ceil(results.totalCount / results.pageSize);
  results.hasMore = results.page < results.totalPages;
  
  // Format document results
  if (rawResults.results && Array.isArray(rawResults.results)) {
    results.results = rawResults.results.map(hit => {
      const doc = hit.document || {};
      const metadata = hit.metadata || {};
      
      const formattedDoc = {
        id: doc.id,
        title: doc.title || doc.filename || 'Untitled Document',
        author: doc.author || 'Unknown Author',
        documentType: doc.documentType || doc.mediaType || 'unknown',
        mimeType: doc.mediaType || 'application/octet-stream',
        size: doc.size || 0,
        sizeFormatted: this._formatFileSize(doc.size || 0),
        createdDate: doc.created || doc.createdDate,
        lastModified: doc.modified || doc.lastModified,
        url: doc.url,
        filename: doc.filename || doc.file?.name,
        score: metadata.score || 0,
        metadata: {
          language: doc.language,
          sourceName: doc.sourceName,
          breadcrumbs: doc.navigationTree || []
        }
      };
      
      // Add preview snippet if requested
      if (options.includePreview && doc.content) {
        const maxLength = options.maxPreviewLength || 200;
        formattedDoc.snippet = doc.content.length > maxLength
          ? doc.content.substring(0, maxLength) + '...'
          : doc.content;
      }
      
      return formattedDoc;
    });
  }
  
  // Format facets if included
  if (options.includeFacets && rawResults.facets) {
    results.facets = this.formatFacets(rawResults.facets);
  }
  
  return results;
}

/**
 * Format facets for browser consumption
 */
formatFacets(rawFacets) {
  const facets = {
    documentTypes: [],
    authors: [],
    sources: [],
    languages: [],
    dateRanges: {
      created: { min: null, max: null },
      modified: { min: null, max: null }
    },
    sizeRange: { min: 0, max: 0 }
  };
  
  // Process document type facets
  if (rawFacets.mediaType) {
    facets.documentTypes = rawFacets.mediaType.buckets.map(bucket => ({
      value: bucket.key,
      count: bucket.doc_count,
      label: this.getDocumentTypeLabel(bucket.key)
    }));
  }
  
  // Process author facets
  if (rawFacets.author) {
    facets.authors = rawFacets.author.buckets.map(bucket => ({
      value: bucket.key,
      count: bucket.doc_count,
      displayName: bucket.key
    }));
  }
  
  // Process source facets
  if (rawFacets.sourceName) {
    facets.sources = rawFacets.sourceName.buckets.map(bucket => ({
      value: bucket.key,
      count: bucket.doc_count,
      displayName: bucket.key
    }));
  }
  
  // Process language facets
  if (rawFacets.language) {
    facets.languages = rawFacets.language.buckets.map(bucket => ({
      value: bucket.key,
      count: bucket.doc_count,
      displayName: this.getLanguageLabel(bucket.key)
    }));
  }
  
  // Process date range facets
  if (rawFacets.modified) {
    const modifiedStats = rawFacets.modified;
    facets.dateRanges.modified = {
      min: modifiedStats.min_as_string,
      max: modifiedStats.max_as_string
    };
  }
  
  // Process size range facets
  if (rawFacets.size) {
    const sizeStats = rawFacets.size;
    facets.sizeRange = {
      min: sizeStats.min,
      max: sizeStats.max
    };
  }
  
  return facets;
}
```

## Validation Schemas

### Browser Search Validation

```javascript
// server/validators/browserSearchValidator.js
import { z } from 'zod';

const browserSearchSchema = z.object({
  query: z.string().max(500).optional(),
  searchProfile: z.string().max(100).default('default'),
  
  // Pagination
  page: z.coerce.number().min(1).max(1000).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  
  // Filtering
  documentTypes: z.array(z.string()).max(20).optional(),
  dateField: z.enum(['created', 'modified']).default('modified'),
  dateStart: z.string().datetime().optional(),
  dateEnd: z.string().datetime().optional(),
  authors: z.array(z.string()).max(50).optional(),
  sources: z.array(z.string()).max(20).optional(),
  sizeMin: z.coerce.number().min(0).optional(),
  sizeMax: z.coerce.number().min(0).optional(),
  
  // Sorting
  sortBy: z.enum(['relevance', 'title', 'author', 'created', 'modified', 'size']).default('relevance'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  
  // Response options
  includePreview: z.coerce.boolean().default(false),
  includeFacets: z.coerce.boolean().default(false),
  includeThumbnails: z.coerce.boolean().default(false),
  maxPreviewLength: z.coerce.number().min(50).max(2000).default(200)
});

export function validateSearchParams(params) {
  try {
    return browserSearchSchema.parse(params);
  } catch (error) {
    throw new Error(`Invalid search parameters: ${error.message}`);
  }
}
```

## Error Handling

All API endpoints should implement consistent error handling:

```javascript
// Standard error response format
{
  error: string,           // Error type ('validation', 'auth', 'server', etc.)
  message: string,         // Human-readable error message
  details?: any,           // Additional error details
  code?: number,           // Internal error code
  timestamp: string        // ISO timestamp
}

// HTTP Status Codes:
// 400 - Bad Request (validation errors)
// 401 - Unauthorized (authentication required)
// 403 - Forbidden (insufficient permissions)
// 404 - Not Found (document/profile not found)
// 413 - Payload Too Large (request too large)
// 429 - Too Many Requests (rate limiting)
// 500 - Internal Server Error (server errors)
```

## Performance Considerations

### Caching Strategy

```javascript
// Implement multiple cache layers
const browserCacheConfig = {
  searchResults: {
    ttl: 5 * 60 * 1000,      // 5 minutes
    maxSize: 1000             // entries
  },
  facets: {
    ttl: 15 * 60 * 1000,     // 15 minutes
    maxSize: 100              // entries
  },
  suggestions: {
    ttl: 30 * 60 * 1000,     // 30 minutes
    maxSize: 500              // entries
  },
  metadata: {
    ttl: 60 * 60 * 1000,     // 1 hour
    maxSize: 5000             // entries
  }
};
```

### Request Optimization

- Implement request debouncing on client side
- Use request cancellation for replaced searches
- Batch metadata requests efficiently
- Implement virtual scrolling for large result sets
- Use data compression for large responses

### Database/Index Optimization

- Ensure proper indexing on commonly filtered fields
- Implement query optimization for complex filter combinations
- Use connection pooling for database connections
- Monitor query performance and optimize slow queries

This API specification provides a comprehensive foundation for implementing the iFinder Document Browser functionality while maintaining consistency with existing patterns and ensuring optimal performance.