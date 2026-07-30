import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateSourceConfig } from '../validators/sourceConfigSchema.js';

describe('Source Validation', () => {
  describe('Filesystem Source Validation', () => {
    it('should reject filesystem source with empty path', () => {
      const source = {
        id: 'test-source',
        name: { en: 'Test Source' },
        description: { en: 'Test description' },
        type: 'filesystem',
        enabled: true,
        exposeAs: 'prompt',
        config: {
          path: '',
          encoding: 'utf-8'
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors);
      assert.ok(result.errors.length > 0);
    });

    it('should accept filesystem source with whitespace-only path (Zod validation)', () => {
      // Note: Zod's min(1) validation doesn't trim strings automatically
      // The additional server-side validation in sources.js route checks for trim()
      const source = {
        id: 'test-source',
        name: { en: 'Test Source' },
        description: { en: 'Test description' },
        type: 'filesystem',
        enabled: true,
        exposeAs: 'prompt',
        config: {
          path: '   ',
          encoding: 'utf-8'
        }
      };

      const result = validateSourceConfig(source);
      // Zod validation passes because string length > 1
      // But the route handler will reject it with trim() check
      assert.strictEqual(result.success, true);
    });

    it('should accept filesystem source with valid path', () => {
      const source = {
        id: 'test-source',
        name: { en: 'Test Source' },
        description: { en: 'Test description' },
        type: 'filesystem',
        enabled: true,
        exposeAs: 'prompt',
        config: {
          path: 'sources/test-file.txt',
          encoding: 'utf-8'
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, true);
      assert.ok(result.data);
      assert.strictEqual(result.data.config.path, 'sources/test-file.txt');
    });

    it('should accept filesystem source with minimal config', () => {
      const source = {
        id: 'test-source',
        name: { en: 'Test Source' },
        type: 'filesystem',
        config: {
          path: 'data/file.txt'
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, true);
      assert.ok(result.data);
      // Should have default encoding
      assert.strictEqual(result.data.config.encoding, 'utf-8');
    });
  });

  describe('URL Source Validation', () => {
    it('should reject URL source with empty url', () => {
      const source = {
        id: 'test-url-source',
        name: { en: 'Test URL Source' },
        type: 'url',
        config: {
          url: ''
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, false);
    });

    it('should accept URL source with valid url', () => {
      const source = {
        id: 'test-url-source',
        name: { en: 'Test URL Source' },
        type: 'url',
        config: {
          url: 'https://example.com/data.json'
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, true);
    });
  });

  describe('iFinder Source Validation', () => {
    it('should accept iFinder source with a document ID', () => {
      const source = {
        id: 'test-ifinder',
        name: { en: 'Test iFinder' },
        type: 'ifinder',
        config: {
          documentId: 'doc-12345'
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.config.documentId, 'doc-12345');
      // Defaults applied
      assert.strictEqual(result.data.config.maxResults, 10);
      assert.strictEqual(result.data.config.maxLength, 10000);
    });

    it('should accept iFinder source with a search query', () => {
      const source = {
        id: 'test-ifinder',
        name: { en: 'Test iFinder' },
        type: 'ifinder',
        config: {
          query: 'product manual',
          searchProfile: 'searchprofile-standard',
          maxResults: 5
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.config.query, 'product manual');
      assert.strictEqual(result.data.config.maxResults, 5);
    });

    it('should reject prompt-exposed iFinder source without documentId or query', () => {
      const source = {
        id: 'test-ifinder',
        name: { en: 'Test iFinder' },
        type: 'ifinder',
        exposeAs: 'prompt',
        config: {}
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, false);
    });

    it('should treat empty strings as missing document selection', () => {
      const source = {
        id: 'test-ifinder',
        name: { en: 'Test iFinder' },
        type: 'ifinder',
        exposeAs: 'prompt',
        config: {
          documentId: '',
          query: '   ',
          searchProfile: ''
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, false);
    });

    it('should accept tool-exposed iFinder source without documentId or query', () => {
      // The model provides documentId/query as tool parameters at call time
      const source = {
        id: 'test-ifinder-tool',
        name: { en: 'Test iFinder Tool' },
        type: 'ifinder',
        exposeAs: 'tool',
        config: {}
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, true);
    });

    it('should reject legacy connection fields (now provided by the central integration)', () => {
      const source = {
        id: 'test-ifinder',
        name: { en: 'Test iFinder' },
        type: 'ifinder',
        config: {
          documentId: 'doc-12345',
          baseUrl: 'https://ifinder.example.com',
          apiKey: 'test-key'
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, false);
    });
  });

  describe('Page Source Validation', () => {
    it('should reject page source with empty pageId', () => {
      const source = {
        id: 'test-page',
        name: { en: 'Test Page' },
        type: 'page',
        config: {
          pageId: ''
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, false);
    });

    it('should accept page source with valid pageId', () => {
      const source = {
        id: 'test-page',
        name: { en: 'Test Page' },
        type: 'page',
        config: {
          pageId: 'faq'
        }
      };

      const result = validateSourceConfig(source);
      assert.strictEqual(result.success, true);
    });
  });
});
