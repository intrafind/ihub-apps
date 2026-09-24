/**
 * `documentId` handling of iFinderService.getContent / getMetadata.
 *
 * Both reach the service from model tool calls, and a model that lost the id
 * of a document it listed earlier passes the title, the file name or the
 * deep link instead. These specs pin down that such a value is refused with
 * a hint that says what to pass, that getMetadata always fetches the hit's
 * own `id` and refuses a hit that is a different document, and that the
 * default metadata projection covers authors and dates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import iFinderService, {
  DOCUMENT_ID_HINT,
  DEFAULT_METADATA_FIELDS,
  looksLikeDocumentId
} from '../services/integrations/iFinderService.js';

const USER = { id: 'u1', email: 'u@example.com', name: 'Tester' };
const CHAT = 'c1';

/** Run `fn` with `search` stubbed, restoring the original afterwards. */
async function withSearch(stub, fn) {
  const original = iFinderService.search;
  const calls = [];
  iFinderService.search = async args => {
    calls.push(args);
    return stub(args);
  };
  try {
    return await fn(calls);
  } finally {
    iFinderService.search = original;
  }
}

test('looksLikeDocumentId: an opaque token yes, a title or link no', () => {
  assert.equal(looksLikeDocumentId('onedrive-d4HF8X5AZOWTbeGW'), true);
  assert.equal(looksLikeDocumentId('fileshare_ab12.cd34'), true);
  assert.equal(looksLikeDocumentId('Präsentation IntraFind Software AG'), false);
  assert.equal(looksLikeDocumentId('https://ifinder.sharepoint.com/sites/x/Doc.aspx'), false);
  assert.equal(looksLikeDocumentId('file://fs01/Public/report.pptx'), false);
  assert.equal(looksLikeDocumentId(''), false);
  assert.equal(looksLikeDocumentId(42), false);
});

test('getContent refuses a title before any request is made', async () => {
  await assert.rejects(
    iFinderService.getContent({
      documentId: 'Präsentation IntraFind Software AG',
      chatId: CHAT,
      user: USER
    }),
    error => {
      assert.match(error.message, /Invalid document ID "Präsentation IntraFind Software AG"/);
      assert.ok(error.message.includes(DOCUMENT_ID_HINT));
      return true;
    }
  );
  await assert.rejects(
    iFinderService.getContent({
      documentId: 'https://ifinder.sharepoint.com/sites/Vertrieb/Doc.aspx?file=a.pptx',
      chatId: CHAT,
      user: USER
    }),
    /Invalid document ID/
  );
});

test('getMetadata refuses a title with the same hint', async () => {
  await withSearch(
    () => {
      throw new Error('search must not run');
    },
    async calls => {
      await assert.rejects(
        iFinderService.getMetadata({
          documentId: 'Schulungsangebot 2026',
          chatId: CHAT,
          user: USER
        }),
        error => {
          assert.match(error.message, /Invalid document ID format "Schulungsangebot 2026"/);
          assert.ok(error.message.includes(DOCUMENT_ID_HINT));
          return true;
        }
      );
      assert.equal(calls.length, 0);
    }
  );
});

test('getMetadata queries by _id, always projects the id and returns the hit', async () => {
  const hit = {
    id: 'onedrive-d4HF8X5AZOWTbeGW',
    title: 'Schulungsangebot.pptx',
    creators: 'KÖGL, Franz',
    modificationDate: '2026-04-01T08:00:00Z',
    deepLink: 'https://ifinder.sharepoint.com/sites/Vertrieb/Doc.aspx?file=Schulungsangebot.pptx'
  };
  await withSearch(
    () => ({ searchProfile: 'p', took: 3, totalFound: 1, results: [hit] }),
    async calls => {
      const metadata = await iFinderService.getMetadata({
        documentId: 'onedrive-d4HF8X5AZOWTbeGW',
        chatId: CHAT,
        user: USER
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].query, '_id:"onedrive-d4HF8X5AZOWTbeGW"');
      assert.equal(calls[0].maxResults, 1);
      assert.deepEqual(calls[0].returnFields, DEFAULT_METADATA_FIELDS);
      assert.equal(metadata.documentId, 'onedrive-d4HF8X5AZOWTbeGW');
      assert.equal(metadata.title, 'Schulungsangebot.pptx');
      assert.equal(metadata.creators, 'KÖGL, Franz');
      assert.equal(metadata.searchProfile, 'p');
      assert.equal(metadata.totalFound, 1);
    }
  );
});

test('getMetadata adds id to a caller projection that lacks it', async () => {
  await withSearch(
    () => ({ results: [{ id: 'doc-1', title: 'T' }] }),
    async calls => {
      await iFinderService.getMetadata({
        documentId: 'doc-1',
        chatId: CHAT,
        user: USER,
        returnFields: ['title', 'modificationDate']
      });
      assert.deepEqual(calls[0].returnFields, ['id', 'title', 'modificationDate']);

      await iFinderService.getMetadata({
        documentId: 'doc-1',
        chatId: CHAT,
        user: USER,
        returnFields: ['*']
      });
      assert.deepEqual(calls[1].returnFields, ['*']);
    }
  );
});

test('getMetadata reports a hit that is another document as not found', async () => {
  await withSearch(
    () => ({ results: [{ id: 'other-doc', title: 'Schulungsangebot.pptx' }] }),
    async () => {
      await assert.rejects(
        iFinderService.getMetadata({
          documentId: 'Schulungsangebot.pptx',
          chatId: CHAT,
          user: USER
        }),
        error => {
          assert.match(error.message, /^Document not found: Schulungsangebot\.pptx\./);
          assert.ok(error.message.includes(DOCUMENT_ID_HINT));
          return true;
        }
      );
    }
  );
});

test('getMetadata reports an empty result as not found, with the hint', async () => {
  await withSearch(
    () => ({ results: [] }),
    async () => {
      await assert.rejects(
        iFinderService.getMetadata({ documentId: 'gone-1', chatId: CHAT, user: USER }),
        error => {
          assert.match(error.message, /Document not found: gone-1/);
          assert.ok(error.message.includes(DOCUMENT_ID_HINT));
          return true;
        }
      );
    }
  );
});

test('getMetadata accepts a hit whose projection carries no id', async () => {
  await withSearch(
    () => ({ results: [{ title: 'Legacy hit' }] }),
    async () => {
      const metadata = await iFinderService.getMetadata({
        documentId: 'doc-9',
        chatId: CHAT,
        user: USER
      });
      assert.equal(metadata.documentId, 'doc-9');
      assert.equal(metadata.title, 'Legacy hit');
    }
  );
});

test('the default metadata projection covers id, people and dates', () => {
  for (const field of ['id', 'creators', 'owners', 'creationDate', 'modificationDate', 'url']) {
    assert.ok(DEFAULT_METADATA_FIELDS.includes(field), field);
  }
  assert.ok(Object.isFrozen(DEFAULT_METADATA_FIELDS));
});

test('the hint avoids the words the generic error handler rewrites', () => {
  for (const word of ['JWT', 'authentication', 'timeout', 'ENOSPC']) {
    assert.ok(!DOCUMENT_ID_HINT.includes(word), word);
  }
});
