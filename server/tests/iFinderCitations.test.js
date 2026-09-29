/**
 * iFinder tool results → the citation result items the chat's Documents panel
 * renders (issue #2597). The shape is the iAssistant one: `document_id`,
 * `title`, `additional_document_metadata` and an ACCESS link naming the search
 * profile, which is what preview, download and "Add to email" are built on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CITATION_DOCUMENTS,
  createIFinderCitationCollector,
  extractIFinderCitationItems,
  isIFinderDocumentTool,
  withAccessLinks,
  withConversationAccessLinks
} from '../services/integrations/iFinderCitations.js';

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

test('isIFinderDocumentTool: only the tools whose result describes documents', () => {
  assert.equal(isIFinderDocumentTool('iFinder_search'), true);
  assert.equal(isIFinderDocumentTool('iFinder_getMetadata'), true);
  assert.equal(isIFinderDocumentTool('iFinder_getContent'), true);
  assert.equal(isIFinderDocumentTool('iFinder_getFacetValues'), false);
  assert.equal(isIFinderDocumentTool('iFinder_discover'), false);
  assert.equal(isIFinderDocumentTool('webSearch'), false);
  assert.equal(isIFinderDocumentTool(undefined), false);
});

test('search hits become result items with an ACCESS link in the searched profile', () => {
  const items = extractIFinderCitationItems('iFinder_search', searchResult);
  assert.deepEqual(items, [
    {
      document_id: 'sharepoint-7f3a9c',
      title: 'Supplier contract ACME',
      additional_document_metadata: {
        id: 'sharepoint-7f3a9c',
        title: 'Supplier contract ACME',
        'accessInfo.deepLink': 'https://sharepoint.example/sites/legal/acme-contract.pdf',
        'file.name': 'acme-contract.pdf',
        sourceType: 'SharePoint',
        sourceName: 'SharePoint',
        application: 'PDF'
      },
      links: [{ type: 'ACCESS', documentId: 'sharepoint-7f3a9c', searchProfile: 'sales' }]
    },
    {
      document_id: 'fs-0042aa',
      title: 'Framework agreement',
      additional_document_metadata: {
        id: 'fs-0042aa',
        title: 'Framework agreement',
        'file.name': 'framework.docx'
      },
      links: [{ type: 'ACCESS', documentId: 'fs-0042aa', searchProfile: 'sales' }]
    }
  ]);
});

test('the result may arrive as JSON text', () => {
  const items = extractIFinderCitationItems('iFinder_search', JSON.stringify(searchResult));
  assert.equal(items.length, 2);
});

test('a document location that is not a web link is never offered to open in the browser', () => {
  const [item] = extractIFinderCitationItems('iFinder_search', {
    searchProfile: 'p',
    results: [
      { id: 'doc-000001', title: 'A', url: 'file:///srv/a.pdf', deepLink: 'javascript:alert(1)' }
    ]
  });
  assert.equal(item.additional_document_metadata['accessInfo.deepLink'], undefined);

  const [web] = extractIFinderCitationItems('iFinder_search', {
    searchProfile: 'p',
    results: [{ id: 'doc-000002', title: 'B', url: 'https://intranet.example/b' }]
  });
  assert.equal(
    web.additional_document_metadata['accessInfo.deepLink'],
    'https://intranet.example/b'
  );
});

test('getMetadata and getContent each describe one document', () => {
  const [meta] = extractIFinderCitationItems('iFinder_getMetadata', {
    id: 'doc-123456',
    documentId: 'doc-123456',
    title: 'Price list',
    deepLink: 'https://ifinder.example/doc-123456',
    searchProfile: 'default',
    rawSearchResult: { results: [{ id: 'doc-123456' }] }
  });
  assert.equal(meta.document_id, 'doc-123456');
  assert.deepEqual(meta.links, [
    { type: 'ACCESS', documentId: 'doc-123456', searchProfile: 'default' }
  ]);

  const [content] = extractIFinderCitationItems('iFinder_getContent', {
    searchProfile: 'default',
    documentId: 'doc-654321',
    content: 'long text…',
    metadata: { title: 'Handbook', filename: 'handbook.pdf', url: 'smb://x/handbook.pdf' }
  });
  assert.deepEqual(content, {
    document_id: 'doc-654321',
    title: 'Handbook',
    additional_document_metadata: {
      id: 'doc-654321',
      title: 'Handbook',
      'file.name': 'handbook.pdf'
    },
    links: [{ type: 'ACCESS', documentId: 'doc-654321', searchProfile: 'default' }]
  });
});

test('nothing for other tools, failed calls, hits without an id or unparseable text', () => {
  assert.deepEqual(extractIFinderCitationItems('webSearch', searchResult), []);
  assert.deepEqual(extractIFinderCitationItems('iFinder_getFacetValues', searchResult), []);
  assert.deepEqual(
    extractIFinderCitationItems('iFinder_search', { error: true, message: 'boom' }),
    []
  );
  assert.deepEqual(
    extractIFinderCitationItems('iFinder_search', { results: [{ title: 'no id' }, null, 'x'] }),
    []
  );
  assert.deepEqual(extractIFinderCitationItems('iFinder_search', '{"results": [trunc'), []);
  assert.deepEqual(extractIFinderCitationItems('iFinder_search', null), []);
});

test('a hit without a profile gets an ACCESS link without one (the proxy falls back to the default)', () => {
  const [item] = extractIFinderCitationItems('iFinder_search', {
    results: [{ id: 'doc-777777', title: 'X' }]
  });
  assert.deepEqual(item.links, [{ type: 'ACCESS', documentId: 'doc-777777' }]);
});

test('collector: the turn’s documents, deduplicated in the order they were first found', () => {
  const collector = createIFinderCitationCollector();
  assert.equal(collector.add('iFinder_search', searchResult), true);
  assert.equal(collector.add('iFinder_search', searchResult), false, 'same hits again: no change');
  assert.equal(
    collector.add('iFinder_search', {
      searchProfile: 'sales',
      results: [
        { id: 'fs-0042aa', title: 'Framework agreement' },
        { id: 'new-99999', title: 'New' }
      ]
    }),
    true
  );
  assert.deepEqual(
    collector.items().map(item => item.document_id),
    ['sharepoint-7f3a9c', 'fs-0042aa', 'new-99999']
  );
  assert.equal(collector.add('webSearch', { results: [{ id: 'x', url: 'https://x' }] }), false);
});

test('collector: a later sighting fills in what the first one lacked, never overwrites it', () => {
  const collector = createIFinderCitationCollector();
  collector.add('iFinder_getContent', {
    documentId: 'doc-654321',
    metadata: { filename: 'handbook.pdf' }
  });
  assert.equal(
    collector.add('iFinder_getMetadata', {
      id: 'doc-654321',
      title: 'Handbook',
      filename: 'other-name.pdf',
      deepLink: 'https://ifinder.example/doc-654321',
      searchProfile: 'hr'
    }),
    true
  );
  const [item] = collector.items();
  assert.equal(item.title, 'Handbook');
  assert.equal(item.additional_document_metadata['file.name'], 'handbook.pdf');
  assert.equal(
    item.additional_document_metadata['accessInfo.deepLink'],
    'https://ifinder.example/doc-654321'
  );
  assert.deepEqual(item.links, [{ type: 'ACCESS', documentId: 'doc-654321', searchProfile: 'hr' }]);
});

test('collector: bounded per turn', () => {
  const collector = createIFinderCitationCollector();
  const results = Array.from({ length: MAX_CITATION_DOCUMENTS + 10 }, (_, i) => ({
    id: `doc-${String(i).padStart(6, '0')}`,
    title: `Doc ${i}`
  }));
  collector.add('iFinder_search', { searchProfile: 'p', results });
  assert.equal(collector.items().length, MAX_CITATION_DOCUMENTS);
  assert.equal(
    collector.add('iFinder_search', { searchProfile: 'p', results: [{ id: 'late-000001' }] }),
    false
  );
});

test('withAccessLinks: items without links get one into the profile; linked or id-less ones are left alone', () => {
  const own = [{ type: 'ACCESS', documentId: 'b', searchProfile: 'other' }];
  assert.deepEqual(
    withAccessLinks([{ document_id: 'a' }, { document_id: 'b', links: own }, { title: 'x' }], 'p'),
    [
      { document_id: 'a', links: [{ type: 'ACCESS', documentId: 'a', searchProfile: 'p' }] },
      { document_id: 'b', links: own },
      { title: 'x' }
    ]
  );
  assert.equal(withAccessLinks(undefined, 'p'), undefined);
});

test('withConversationAccessLinks: a resumed conversation’s documents get the links the live stream gives them', () => {
  const page = {
    messages: [
      { id: 'm1', type: 'USER', content: 'q' },
      {
        id: 'm2',
        type: 'ASSISTANT',
        content: 'a',
        references: [{ document_id: 'doc-1', content: 'passage' }],
        result_items: [{ document_id: 'doc-1', title: 'Doc 1' }]
      }
    ],
    next_cursor: 'c1'
  };
  const linked = withConversationAccessLinks(page, 'sales');
  const access = [{ type: 'ACCESS', documentId: 'doc-1', searchProfile: 'sales' }];
  assert.equal(linked.next_cursor, 'c1');
  assert.deepEqual(linked.messages[0], page.messages[0]);
  assert.deepEqual(linked.messages[1].references[0].links, access);
  assert.deepEqual(linked.messages[1].result_items[0].links, access);
  assert.equal(page.messages[1].result_items[0].links, undefined, 'the input is not mutated');

  const bare = withConversationAccessLinks([page.messages[1]], 'sales');
  assert.deepEqual(bare[0].result_items[0].links, access);
});

test('withConversationAccessLinks: without a known profile the page is returned as iFinder sent it', () => {
  const page = { messages: [{ result_items: [{ document_id: 'doc-1' }] }] };
  assert.equal(withConversationAccessLinks(page, undefined), page);
  assert.equal(withConversationAccessLinks(null, 'p'), null);
});
