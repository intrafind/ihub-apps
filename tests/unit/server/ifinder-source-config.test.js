/**
 * @jest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  validateSourceConfig,
  validateSourcesArray,
  getDefaultSourceConfig
} from '../../../server/validators/sourceConfigSchema.js';

// The validator logs rejected configs — keep the test output clean.
jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

/**
 * iFinder source configuration schema tests
 *
 * iFinder sources no longer carry their own connection settings — the base
 * URL and JWT authentication come from the central iFinder integration in
 * platform.json. A source only selects documents: a pinned documentId or a
 * search query loading the top maxResults matches.
 */

const baseSource = {
  id: 'test-ifinder',
  name: { en: 'Test iFinder' },
  type: 'ifinder'
};

describe('iFinder source config schema', () => {
  it('accepts a source pinned to a document ID and applies defaults', () => {
    const result = validateSourceConfig({
      ...baseSource,
      config: { documentId: 'doc-12345' }
    });

    expect(result.success).toBe(true);
    expect(result.data.config.documentId).toBe('doc-12345');
    expect(result.data.config.maxResults).toBe(10);
    expect(result.data.config.maxLength).toBe(10000);
    // No injected connection or profile values
    expect(result.data.config.searchProfile).toBeUndefined();
  });

  it('accepts a query-based source', () => {
    const result = validateSourceConfig({
      ...baseSource,
      config: { query: 'product manual', maxResults: 5, searchProfile: 'searchprofile-standard' }
    });

    expect(result.success).toBe(true);
    expect(result.data.config.query).toBe('product manual');
    expect(result.data.config.maxResults).toBe(5);
    expect(result.data.config.searchProfile).toBe('searchprofile-standard');
  });

  it('rejects prompt-exposed sources without a document ID or query', () => {
    const result = validateSourceConfig({
      ...baseSource,
      exposeAs: 'prompt',
      config: {}
    });

    expect(result.success).toBe(false);
  });

  it('treats empty strings as missing values', () => {
    const result = validateSourceConfig({
      ...baseSource,
      exposeAs: 'prompt',
      config: { documentId: '', query: '   ', searchProfile: '' }
    });

    expect(result.success).toBe(false);
  });

  it('allows tool-exposed sources without a document ID or query', () => {
    // The model supplies documentId/query as tool parameters at call time
    const result = validateSourceConfig({
      ...baseSource,
      exposeAs: 'tool',
      config: {}
    });

    expect(result.success).toBe(true);
  });

  it('rejects the legacy connection fields', () => {
    const result = validateSourceConfig({
      ...baseSource,
      config: {
        documentId: 'doc-12345',
        baseUrl: 'https://ifinder.example.com',
        apiKey: 'secret'
      }
    });

    expect(result.success).toBe(false);
  });

  it('provides a default config without connection settings', () => {
    const defaults = getDefaultSourceConfig('ifinder');

    expect(defaults.config).toEqual({
      documentId: '',
      query: '',
      searchProfile: '',
      maxResults: 10,
      maxLength: 10000
    });
  });
});

describe('shipped default sources', () => {
  it('validate against the sources schema', () => {
    const sourcesPath = path.join(process.cwd(), 'server/defaults/config/sources.json');
    const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));

    const result = validateSourcesArray(sources);
    expect(result.success).toBe(true);
  });
});
