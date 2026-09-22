import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import iFinder from '../tools/iFinder.js';
import IFinderHandler from '../sources/IFinderHandler.js';

/**
 * IFinderHandler tests
 *
 * The handler talks to iFinder through the `iFinder` tool wrapper (a plain
 * object export), so the network layer is stubbed by swapping the wrapper's
 * methods for the duration of each test.
 */

const user = { id: 'user-1', email: 'user@example.com' };
const chatId = 'chat-1';

const originals = {
  search: iFinder.search,
  getContent: iFinder.getContent,
  getMetadata: iFinder.getMetadata
};

function restore() {
  iFinder.search = originals.search;
  iFinder.getContent = originals.getContent;
  iFinder.getMetadata = originals.getMetadata;
}

describe('IFinderHandler', () => {
  let handler;

  beforeEach(() => {
    handler = new IFinderHandler();
  });

  afterEach(() => {
    restore();
  });

  describe('validateConfig', () => {
    it('accepts static config with documentId only', () => {
      assert.strictEqual(handler.validateConfig({ documentId: 'doc-1' }), true);
    });

    it('accepts static config with query only', () => {
      assert.strictEqual(handler.validateConfig({ query: 'manual' }), true);
    });

    it('does not require runtime context (user/chatId)', () => {
      // Stored source configs never contain user/chatId — they are injected
      // later by the SourceManager. validateConfig must not reject them.
      assert.strictEqual(handler.validateConfig({ query: 'manual' }), true);
    });

    it('rejects config without documentId and query', () => {
      assert.strictEqual(handler.validateConfig({}), false);
      assert.strictEqual(handler.validateConfig({ documentId: '  ', query: '' }), false);
      assert.strictEqual(handler.validateConfig(null), false);
    });
  });

  describe('loadContent - runtime requirements', () => {
    it('requires user', async () => {
      await assert.rejects(
        handler.loadContent({ documentId: 'doc-1', chatId }),
        /requires authenticated user/
      );
    });

    it('requires chatId', async () => {
      await assert.rejects(handler.loadContent({ documentId: 'doc-1', user }), /requires chatId/);
    });

    it('requires documentId or query', async () => {
      await assert.rejects(
        handler.loadContent({ user, chatId }),
        /requires either documentId or query/
      );
    });
  });

  describe('loadContent - single document mode', () => {
    it('loads content and metadata for a pinned document', async () => {
      iFinder.getContent = async params => {
        assert.strictEqual(params.documentId, 'doc-1');
        assert.strictEqual(params.user, user);
        assert.strictEqual(params.chatId, chatId);
        return {
          content: 'Document body',
          contentLength: 13,
          contentLengthFormatted: '13 characters',
          searchProfile: 'profile-1',
          truncated: false
        };
      };
      iFinder.getMetadata = async () => ({
        title: 'My Document',
        author: 'Alice',
        mimeType: 'application/pdf',
        url: 'https://ifinder.example.com/doc-1'
      });

      const result = await handler.loadContent({ documentId: 'doc-1', user, chatId });

      assert.strictEqual(result.content, 'Document body');
      assert.strictEqual(result.metadata.type, 'ifinder');
      assert.strictEqual(result.metadata.documentId, 'doc-1');
      assert.strictEqual(result.metadata.title, 'My Document');
      assert.strictEqual(result.metadata.link, 'https://ifinder.example.com/doc-1');
    });
  });

  describe('loadContent - query mode', () => {
    it('loads up to maxResults documents for a query', async () => {
      const hits = [
        { id: 'doc-1', title: 'First', url: 'https://example.com/1' },
        { id: 'doc-2', title: 'Second', deepLink: 'https://example.com/2' },
        { id: 'doc-3', title: 'Third' }
      ];

      let searchParams = null;
      iFinder.search = async params => {
        searchParams = params;
        return { results: hits, totalFound: 42, searchProfile: 'profile-1' };
      };
      const loadedIds = [];
      iFinder.getContent = async params => {
        loadedIds.push(params.documentId);
        return {
          content: `Content of ${params.documentId}`,
          contentLength: 20,
          truncated: false
        };
      };

      const result = await handler.loadContent({ query: 'manual', maxResults: 3, user, chatId });

      assert.strictEqual(searchParams.maxResults, 3);
      assert.strictEqual(searchParams.query, 'manual');
      assert.deepStrictEqual(loadedIds.sort(), ['doc-1', 'doc-2', 'doc-3']);

      // All three documents wrapped individually
      assert.match(
        result.content,
        /<document id="doc-1" title="First" link="https:\/\/example.com\/1">/
      );
      assert.match(
        result.content,
        /<document id="doc-2" title="Second" link="https:\/\/example.com\/2">/
      );
      assert.match(result.content, /<document id="doc-3" title="Third">/);
      assert.match(result.content, /Content of doc-2/);

      assert.strictEqual(result.metadata.type, 'ifinder');
      assert.strictEqual(result.metadata.searchQuery, 'manual');
      assert.strictEqual(result.metadata.totalFound, 42);
      assert.strictEqual(result.metadata.loadedDocuments, 3);
      assert.strictEqual(result.metadata.documents.length, 3);
      assert.strictEqual(result.metadata.documents[0].documentId, 'doc-1');
    });

    it('continues when individual documents fail to load', async () => {
      iFinder.search = async () => ({
        results: [
          { id: 'doc-ok', title: 'Works' },
          { id: 'doc-broken', title: 'Broken' }
        ],
        totalFound: 2,
        searchProfile: 'profile-1'
      });
      iFinder.getContent = async ({ documentId }) => {
        if (documentId === 'doc-broken') {
          throw new Error('Access denied');
        }
        return { content: 'ok', contentLength: 2, truncated: false };
      };

      const result = await handler.loadContent({ query: 'manual', user, chatId });

      assert.strictEqual(result.metadata.loadedDocuments, 1);
      assert.strictEqual(result.metadata.failedDocuments.length, 1);
      assert.strictEqual(result.metadata.failedDocuments[0].documentId, 'doc-broken');
      assert.match(result.content, /<document id="doc-ok"/);
      assert.ok(!result.content.includes('doc-broken'));
    });

    it('throws when the query matches nothing', async () => {
      iFinder.search = async () => ({ results: [], totalFound: 0 });

      await assert.rejects(
        handler.loadContent({ query: 'nothing', user, chatId }),
        /No documents found for query/
      );
    });

    it('throws when every matched document fails to load', async () => {
      iFinder.search = async () => ({
        results: [{ id: 'doc-1', title: 'First' }],
        totalFound: 1
      });
      iFinder.getContent = async () => {
        throw new Error('Access denied');
      };

      await assert.rejects(
        handler.loadContent({ query: 'manual', user, chatId }),
        /Failed to load documents for query/
      );
    });

    it('escapes attribute values in document wrappers', async () => {
      iFinder.search = async () => ({
        results: [{ id: 'doc-1', title: 'Says "hello" & <more>' }],
        totalFound: 1
      });
      iFinder.getContent = async () => ({ content: 'body', contentLength: 4, truncated: false });

      const result = await handler.loadContent({ query: 'manual', user, chatId });

      assert.match(result.content, /title="Says &quot;hello&quot; &amp; &lt;more&gt;"/);
    });
  });

  describe('getCacheKey', () => {
    it('differs per selection and per user', () => {
      const base = { query: 'manual', maxResults: 5, maxLength: 1000, user };
      const keyA = handler.getCacheKey(base);
      const keyB = handler.getCacheKey({ ...base, maxResults: 10 });
      const keyC = handler.getCacheKey({ ...base, user: { id: 'other' } });

      assert.notStrictEqual(keyA, keyB);
      assert.notStrictEqual(keyA, keyC);
    });
  });
});

describe('iFinderService.getMetadata document ID validation', () => {
  it('rejects IDs that could inject into the _id query', async () => {
    // documentId can arrive from model/tool parameters; getMetadata embeds it
    // in a quoted _id:"…" search expression and must reject unsafe values
    // before any request is built.
    const { default: iFinderService } = await import('../services/integrations/iFinderService.js');

    for (const bad of ['doc" OR *:*', 'a/b', '..', 'doc id with spaces']) {
      await assert.rejects(
        iFinderService.getMetadata({ documentId: bad, user, chatId }),
        /Invalid document ID format/,
        `expected rejection for ${JSON.stringify(bad)}`
      );
    }
  });
});
