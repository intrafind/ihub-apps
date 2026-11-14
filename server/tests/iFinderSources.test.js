// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
  isIFinderDocumentTool
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
      origin: { kind: 'ifinder' },
      kind: 'document',
      title: 'Supplier contract ACME',
      url: 'https://sharepoint.example/sites/legal/acme-contract.pdf',
      site: 'SharePoint',
      snippet: '… notice period of three months …',
      fileName: 'acme-contract.pdf',
      type: 'PDF',
      ref: { id: 'sharepoint-7f3a9c', scope: 'sales' },
      // No name in the result: the id stands in.
      scopeName: 'sales',
      private: true
    },
    {
      id: 'ifinder:fs-0042aa',
      provider: 'ifinder',
      origin: { kind: 'ifinder' },
      kind: 'document',
      title: 'Framework agreement',
      fileName: 'framework.docx',
      ref: { id: 'fs-0042aa', scope: 'sales' },
      scopeName: 'sales',
      private: true
    }
  ]);
  assert.deepEqual(frame.scopes, [
    { integrationId: 'ifinder', id: 'sales', name: 'sales', action: 'search' }
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
    origin: { kind: 'ifinder' },
    kind: 'document',
    title: 'Handbook',
    fileName: 'handbook.pdf',
    ref: { id: 'doc-654321', scope: 'default' },
    scopeName: 'default',
    read: { ok: true },
    private: true
  });
});

test('every document shows the display name of the profile it was found in (#3056)', () => {
  const frame = extract('iFinder_search', {
    ...searchResult,
    searchProfileName: 'Sales documents'
  });
  assert.deepEqual(
    frame.items.map(item => [item.ref.scope, item.scopeName]),
    [
      ['sales', 'Sales documents'],
      ['sales', 'Sales documents']
    ]
  );
  // Where the search ran, with its name.
  assert.deepEqual(frame.scopes, [
    { integrationId: 'ifinder', id: 'sales', name: 'Sales documents', action: 'search' }
  ]);
  // A search that found nothing still says where it searched.
  const empty = extract(
    'iFinder_search',
    { searchProfile: 'sales', searchProfileName: 'Sales documents', results: [] },
    { query: 'nothing' }
  );
  assert.deepEqual(empty.items, []);
  assert.deepEqual(
    empty.scopes.map(scope => scope.name),
    ['Sales documents']
  );

  // A read names the profile on the document, but is no search.
  const read = extract('iFinder_getContent', {
    searchProfile: 'default',
    searchProfileName: 'Everything',
    documentId: 'doc-654321',
    metadata: { title: 'Handbook' }
  });
  assert.equal(read.items[0].scopeName, 'Everything');
  assert.equal(read.scopes, undefined);
  const meta = extract('iFinder_getMetadata', {
    id: 'doc-1',
    title: 'Price list',
    searchProfile: 'default',
    searchProfileName: 'Everything'
  });
  assert.equal(meta.items[0].scopeName, 'Everything');
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
  const frame = extract('iFinder_search', { results: [{ id: 'doc-777777', title: 'X' }] });
  assert.deepEqual(frame.items[0].ref, { id: 'doc-777777' });
  assert.equal(frame.items[0].scopeName, undefined);
  assert.equal(frame.scopes, undefined);
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
    scopeName: 'hr',
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

test('iAssistant over all search profiles: each document names the profile iFinder reports (#3056)', () => {
  const scope = {
    integrationId: 'iassistant',
    id: 'all',
    name: { en: 'All my search profiles', de: 'Alle meine Suchprofile' },
    action: 'ask'
  };
  const frame = iAssistantSourceFrame(
    {
      resultItems: [
        resultItem('doc-a', 'Travel policy', {
          links: [{ type: 'ACCESS', documentId: 'doc-a', searchProfile: 'hr' }]
        }),
        resultItem('doc-b', 'Supplier contract', {
          links: [{ type: 'ACCESS', documentId: 'doc-b', searchProfile: 'contracts' }]
        }),
        resultItem('doc-c', 'Unknown profile', {
          links: [{ type: 'ACCESS', documentId: 'doc-c', searchProfile: 'archive' }]
        }),
        // Over all profiles the conversation has no profile of its own.
        resultItem('doc-d', 'No profile reported')
      ]
    },
    {
      scopeNames: new Map([
        ['hr', 'HR policies'],
        ['contracts', 'Contracts']
      ]),
      scope
    }
  );
  assert.deepEqual(
    frame.items.map(item => [item.ref.id, item.ref.scope, item.scopeName]),
    [
      ['doc-a', 'hr', 'HR policies'],
      ['doc-b', 'contracts', 'Contracts'],
      // Not in the user's list: the id stands in.
      ['doc-c', 'archive', 'archive'],
      ['doc-d', undefined, undefined]
    ]
  );
  // The answer records whom it asked.
  assert.deepEqual(frame.scopes, [scope]);
  // A plain object of names works as well.
  const named = iAssistantSourceFrame(
    { resultItems: [resultItem('doc-e', 'E')] },
    { searchProfile: 'hr', scopeNames: { hr: 'HR policies' } }
  );
  assert.equal(named.items[0].scopeName, 'HR policies');
  assert.equal(named.scopes, undefined);
  // Nothing found: no frame, whatever was asked.
  assert.equal(iAssistantSourceFrame({ resultItems: [] }, { scope }), null);
});
