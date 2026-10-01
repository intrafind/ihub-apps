/**
 * iFinder documents as sources (services/sources/producers/ifinder.js): what
 * the iFinder tools and the iAssistant conversation API report becomes
 * `provider: 'ifinder'` documents with a `ref` of document id and search
 * profile — what the `ifinder` source provider previews, downloads, attaches
 * and describes them through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  iAssistantSourceFrame,
  iFinderSourceProducer,
  isIFinderDocumentTool,
  withConversationSources
} from '../services/sources/producers/ifinder.js';
import { extractToolSources, MAX_FRAME_SOURCES } from '../services/sources/index.js';

const searchResult = {
  query: 'contract',
  searchProfile: 'sales',
  totalFound: 2,
  results: [
    {
      id: 'sharepoint-7f3a9c',
      title: 'Supplier contract ACME',
      sourceName: 'SharePoint',
      sourceType: 'SharePoint',
      application: 'PDF',
      filename: 'acme-contract.pdf',
      url: 'smb://files/contracts/acme-contract.pdf',
      deepLink: 'https://sharepoint.example/sites/legal/acme-contract.pdf',
      teasers: ['… notice period of <em>three months</em> …']
    },
    { id: 'fs-0042aa', title: ['Framework agreement'], file: { name: 'framework.docx' } }
  ]
};

const extract = (toolId, result, args = {}) =>
  extractToolSources({ toolId, toolDef: { id: toolId }, args, result });

test('isIFinderDocumentTool: only the tools whose result describes documents', () => {
  assert.equal(isIFinderDocumentTool('iFinder_search'), true);
  assert.equal(isIFinderDocumentTool('iFinder_getMetadata'), true);
  assert.equal(isIFinderDocumentTool('iFinder_getContent'), true);
  assert.equal(isIFinderDocumentTool('iFinder_getFacetValues'), false);
  assert.equal(isIFinderDocumentTool('iFinder_discover'), false);
  assert.equal(isIFinderDocumentTool('webSearch'), false);
  assert.equal(isIFinderDocumentTool(undefined), false);
});

test('search hits become private documents with a ref into the searched profile', () => {
  const frame = extract('iFinder_search', searchResult, { query: 'contract' });
  assert.deepEqual(frame.queries, ['contract']);
  assert.deepEqual(frame.items, [
    {
      id: 'ifinder:sharepoint-7f3a9c',
      provider: 'ifinder',
      kind: 'document',
      title: 'Supplier contract ACME',
      url: 'https://sharepoint.example/sites/legal/acme-contract.pdf',
      site: 'SharePoint',
      snippet: '… notice period of three months …',
      fileName: 'acme-contract.pdf',
      type: 'PDF',
      ref: { id: 'sharepoint-7f3a9c', scope: 'sales' },
      private: true
    },
    {
      id: 'ifinder:fs-0042aa',
      provider: 'ifinder',
      kind: 'document',
      title: 'Framework agreement',
      fileName: 'framework.docx',
      ref: { id: 'fs-0042aa', scope: 'sales' },
      private: true
    }
  ]);
});

test('the result may arrive as JSON text; a match-all query is not a query', () => {
  const frame = extract('iFinder_search', JSON.stringify(searchResult), { query: '*' });
  assert.equal(frame.items.length, 2);
  assert.deepEqual(frame.queries, []);
});

test('a document location that is not a web link is never offered to open in the browser', () => {
  const [item] = extract('iFinder_search', {
    searchProfile: 'p',
    results: [
      { id: 'doc-000001', title: 'A', url: 'file:///srv/a.pdf', deepLink: 'javascript:alert(1)' }
    ]
  }).items;
  assert.equal(item.url, undefined);

  const [web] = extract('iFinder_search', {
    searchProfile: 'p',
    results: [{ id: 'doc-000002', title: 'B', url: 'https://intranet.example/b' }]
  }).items;
  assert.equal(web.url, 'https://intranet.example/b');
});

test('getMetadata names one document; getContent reads one', () => {
  const [meta] = extract('iFinder_getMetadata', {
    id: 'doc-123456',
    documentId: 'doc-123456',
    title: 'Price list',
    deepLink: 'https://ifinder.example/doc-123456',
    searchProfile: 'default',
    rawSearchResult: { results: [{ id: 'doc-123456' }] }
  }).items;
  assert.deepEqual(meta.ref, { id: 'doc-123456', scope: 'default' });
  assert.equal(meta.read, undefined);

  const [content] = extract('iFinder_getContent', {
    searchProfile: 'default',
    documentId: 'doc-654321',
    content: 'long text…',
    metadata: { title: 'Handbook', filename: 'handbook.pdf', url: 'smb://x/handbook.pdf' }
  }).items;
  assert.deepEqual(content, {
    id: 'ifinder:doc-654321',
    provider: 'ifinder',
    kind: 'document',
    title: 'Handbook',
    fileName: 'handbook.pdf',
    ref: { id: 'doc-654321', scope: 'default' },
    read: { ok: true },
    private: true
  });
});

test('nothing for other tools, failed calls, hits without an id or unparseable text', () => {
  assert.equal(iFinderSourceProducer.matches({ toolId: 'iFinder_getFacetValues' }), false);
  assert.equal(extract('iFinder_getFacetValues', searchResult), null);
  assert.equal(extract('iFinder_search', { error: true, message: 'boom' }), null);
  assert.equal(extract('iFinder_search', { results: [{ title: 'no id' }, null, 'x'] }), null);
  assert.equal(extract('iFinder_search', '{"results": [trunc'), null);
  assert.equal(extract('iFinder_search', null), null);
  // A failed search still says what it searched for.
  assert.deepEqual(
    extractToolSources({
      toolId: 'iFinder_search',
      args: { query: 'budget' },
      result: { error: true },
      failed: true
    }),
    { items: [], queries: ['budget'] }
  );
});

test('a hit without a profile gets a ref without one (the provider falls back to the default)', () => {
  const [item] = extract('iFinder_search', { results: [{ id: 'doc-777777', title: 'X' }] }).items;
  assert.deepEqual(item.ref, { id: 'doc-777777' });
});

test('one call reports at most MAX_FRAME_SOURCES documents', () => {
  const results = Array.from({ length: MAX_FRAME_SOURCES + 10 }, (_, i) => ({
    id: `doc-${String(i).padStart(6, '0')}`,
    title: `Doc ${i}`
  }));
  assert.equal(extract('iFinder_search', { searchProfile: 'p', results }).items.length, 50);
});

// ── iAssistant ─────────────────────────────────────────────────────────────

const resultItem = (id, title, extra = {}) => ({
  document_id: id,
  title,
  additional_document_metadata: {
    id,
    title,
    'accessInfo.deepLink': `https://ifinder.example/${id}`,
    'file.name': `${id}.pdf`,
    sourceName: 'Confluence',
    application: 'PDF'
  },
  ...extra
});

test('iAssistant: result items are documents cited by position, references are passages cited by index', () => {
  const frame = iAssistantSourceFrame(
    {
      resultItems: [
        resultItem('doc-a', 'Travel policy', {
          links: [{ type: 'ACCESS', documentId: 'doc-a', searchProfile: 'hr' }]
        }),
        resultItem('doc-b', 'Expense rules')
      ],
      references: [
        {
          document_id: 'doc-b',
          title: 'Expense rules',
          content: 'Receipts within 30 days.',
          index: 4
        }
      ]
    },
    { searchProfile: 'default' }
  );
  assert.deepEqual(frame.items[0], {
    provider: 'ifinder',
    kind: 'document',
    private: true,
    ref: { id: 'doc-a', scope: 'hr' },
    title: 'Travel policy',
    url: 'https://ifinder.example/doc-a',
    site: 'Confluence',
    fileName: 'doc-a.pdf',
    type: 'PDF',
    markers: ['r:1']
  });
  // The conversation's profile for a document whose ACCESS link names none.
  assert.deepEqual(frame.items[1].ref, { id: 'doc-b', scope: 'default' });
  assert.deepEqual(frame.items[1].markers, ['r:2']);
  assert.deepEqual(frame.items[2].passages, [{ text: 'Receipts within 30 days.', marker: 's:4' }]);
});

test('iAssistant: result items without a title and no passage are not listed (iFinder bug)', () => {
  const frame = iAssistantSourceFrame({
    resultItems: [{ document_id: 'publicpush-1', title: null }, resultItem('doc-a', 'Kept')]
  });
  assert.deepEqual(
    frame.items.map(item => item.ref.id),
    ['doc-a']
  );
  // Its position still counts: the kept document is the second result item.
  assert.deepEqual(frame.items[0].markers, ['r:2']);
  assert.equal(iAssistantSourceFrame({ resultItems: [], references: [] }), null);
  assert.equal(iAssistantSourceFrame(null), null);
});

test('withConversationSources: a resumed conversation’s answers carry their documents as sources', () => {
  const page = {
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'a <cite type="r">1</cite>',
        result_items: [resultItem('doc-a', 'Travel policy')],
        references: []
      }
    ]
  };
  const resumed = withConversationSources(page, 'sales');
  assert.equal(resumed.messages[0].sources, undefined);
  assert.deepEqual(resumed.messages[1].sources.items[0].ref, { id: 'doc-a', scope: 'sales' });
  assert.equal(resumed.messages[1].sources.items[0].id, 'ifinder:doc-a');
  assert.deepEqual(resumed.messages[1].sources.queries, []);
  const bare = withConversationSources([page.messages[1]], undefined);
  assert.deepEqual(bare[0].sources.items[0].ref, { id: 'doc-a' });
  assert.equal(withConversationSources(null, 'p'), null);
});
