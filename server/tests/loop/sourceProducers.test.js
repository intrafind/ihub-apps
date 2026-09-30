/**
 * Source producers (services/sources): how what a tool returned becomes the
 * sources the chat shows — web search and the page reader, a tool's own
 * `sources` envelope, MCP `resource_link`s, a declaration in the tool
 * definition, a registered producer — and the frame the loop reports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetSourceProducers,
  extractToolSources,
  finalizeSourceFrame,
  MAX_FRAME_BYTES,
  registerSourceProducer
} from '../../services/sources/index.js';
import { isWebSearchTool } from '../../services/sources/producers/web.js';
import { declarationOf } from '../../services/sources/producers/declared.js';
import {
  _resetSourceProviders,
  hasSourceProvider,
  registerSourceProvider
} from '../../services/sources/providers.js';
import { sourcesAddedData } from '../../services/loop/contracts/runLogEvents.js';

const extract = (toolId, result, extra = {}) =>
  extractToolSources({ toolId, toolDef: { id: toolId }, result, ...extra });

// ── web search and the page reader ─────────────────────────────────────────

test('web: search results become public pages, in order, with the query', () => {
  const frame = extract(
    'braveSearch',
    {
      results: [
        { title: 'Example', url: 'https://example.com/a', description: 'x' },
        { title: 'Other', url: 'https://other.org/' }
      ]
    },
    { args: { query: 'example' } }
  );
  assert.deepEqual(frame, {
    items: [
      {
        id: 'url:example.com/a',
        provider: 'web',
        kind: 'page',
        title: 'Example',
        url: 'https://example.com/a',
        snippet: 'x',
        private: false
      },
      {
        id: 'url:other.org',
        provider: 'web',
        kind: 'page',
        title: 'Other',
        url: 'https://other.org/',
        private: false
      }
    ],
    queries: ['example']
  });
});

test('web: a source carries what its card shows, and no markup or unsafe link', () => {
  const [page, bad] = extract('braveSearch', {
    results: [
      {
        title: 'Example',
        url: 'https://example.com/a',
        description: 'The <strong>matched</strong>   terms <<script>script>alert(1)</script>',
        publishedDate: '2026-09-01T10:00:00Z',
        favicon: 'https://imgs.search.brave.com/icon.png'
      },
      { title: 'Bad favicon', url: 'https://other.org/', favicon: 'javascript:alert(1)' }
    ]
  }).items;
  assert.equal(page.snippet.includes('<'), false);
  assert.match(page.snippet, /^The matched terms/);
  assert.equal(page.publishedDate, '2026-09-01T10:00:00.000Z');
  assert.equal(page.favicon, 'https://imgs.search.brave.com/icon.png');
  assert.equal(bad.favicon, undefined);
});

test('web: extracted pages are read or not readable; one sighting per page', () => {
  const { items } = extract('qwantSearch', {
    results: [
      { title: 'A', url: 'https://a.example/' },
      { title: 'B', url: 'https://b.example/' }
    ],
    extractedContent: [
      { title: 'A', url: 'https://a.example/', contentExtracted: true },
      { title: 'B', url: 'https://b.example/', contentExtracted: false }
    ]
  });
  assert.deepEqual(
    items.map(item => [item.url, item.read]),
    [
      ['https://a.example/', { ok: true }],
      ['https://b.example/', { ok: false }]
    ]
  );
});

test('web: a page the reader read is private, with words read and truncation', () => {
  const [page] = extract('webContentExtractor', {
    url: 'https://intranet.example/long',
    title: 'Long page',
    content: 'Some words here',
    wordCount: 3,
    truncated: false,
    incomplete: true
  }).items;
  assert.deepEqual(page, {
    id: 'url:intranet.example/long',
    provider: 'web',
    kind: 'page',
    title: 'Long page',
    url: 'https://intranet.example/long',
    read: { ok: true, words: 3, truncated: true },
    private: true
  });
});

test('web: a failed page read is still a page the turn tried', () => {
  assert.deepEqual(
    extractToolSources({
      toolId: 'webContentExtractor',
      args: { url: 'https://down.example/' },
      result: { error: true },
      failed: true
    }).items.map(item => [item.url, item.read, item.private]),
    [['https://down.example/', { ok: false }, true]]
  );
});

test('web: which tools are web search', () => {
  for (const id of ['braveSearch', 'qwantSearch', 'staanSearch', 'webSearch', 'tavily_search']) {
    assert.equal(isWebSearchTool(id), true, id);
  }
  for (const id of ['iFinder_search', 'source_handbook', 'app__websearch', 'jira_search']) {
    assert.equal(isWebSearchTool(id), false, id);
  }
});

test('web: MCP search tools named after an engine are read from JSON text', () => {
  const text = JSON.stringify([{ link: 'https://example.com/', name: 'Ex' }]);
  assert.deepEqual(
    extract('mcp_web_search', text).items.map(item => [item.url, item.title]),
    [['https://example.com/', 'Ex']]
  );
  assert.equal(extract('mcp_web_search', 'plain text answer'), null);
  assert.equal(
    extract('braveSearch', { results: [{ url: 'javascript:alert(1)' }, { url: 'nope' }] }),
    null
  );
});

test('web: only the platform’s own web search makes its hits public', () => {
  const hits = { results: [{ title: 'Intranet page', url: 'https://wiki.corp.example/x' }] };
  const privacyOf = (toolId, toolDef) =>
    extractToolSources({ toolId, toolDef: toolDef ?? { id: toolId }, result: hits }).items[0]
      .private;
  assert.equal(privacyOf('braveSearch'), false);
  assert.equal(privacyOf('webSearch'), false);
  // Named after an engine, but it may search anything: listed, not shareable.
  assert.equal(privacyOf('mcp_brave_search', { _mcp: { serverId: 'brave' } }), true);
  assert.equal(privacyOf('braveSearch', { id: 'braveSearch', _mcp: { serverId: 'x' } }), true);
  assert.equal(privacyOf('intranet_web_search'), true);
  assert.equal(privacyOf('tavily_search'), true);
});

// ── a tool's own report ────────────────────────────────────────────────────

test('envelope: any tool reports what it found as `sources`, private unless it says otherwise', () => {
  const frame = extract('crm_lookup', {
    accounts: [{ name: 'ACME' }],
    sources: [
      { title: 'ACME account', url: 'https://crm.example/acme', kind: 'item' },
      { title: 'ACME homepage', url: 'https://acme.example/', private: false },
      'not a source'
    ]
  });
  assert.deepEqual(frame.items, [
    {
      id: 'url:crm.example/acme',
      provider: 'crm_lookup',
      kind: 'item',
      title: 'ACME account',
      url: 'https://crm.example/acme',
      private: true
    },
    {
      id: 'url:acme.example',
      provider: 'crm_lookup',
      kind: 'page',
      title: 'ACME homepage',
      url: 'https://acme.example/',
      private: false
    }
  ]);
  assert.equal(extract('crm_lookup', { accounts: [] }), null);
});

test('envelope: MCP resource_link blocks and structuredContent.sources are sources of the server', () => {
  const toolDef = { id: 'mcp_docs_find', _mcp: { serverId: 'docs' } };
  const frame = extractToolSources({
    toolId: 'mcp_docs_find',
    toolDef,
    result: [
      { type: 'text', text: 'Found two documents.' },
      {
        type: 'resource_link',
        uri: 'https://docs.example/guide',
        name: 'guide',
        title: 'Install guide',
        mimeType: 'text/html'
      },
      {
        type: 'resource_link',
        uri: 'docs://reports/q3.pdf',
        name: 'Q3 report',
        description: 'Quarterly numbers',
        mimeType: 'application/pdf'
      }
    ]
  });
  assert.deepEqual(frame.items, [
    {
      id: 'url:docs.example/guide',
      provider: 'mcp:docs',
      kind: 'page',
      title: 'Install guide',
      url: 'https://docs.example/guide',
      private: true
    },
    {
      id: 'mcp:docs:docs://reports/q3.pdf',
      provider: 'mcp:docs',
      kind: 'document',
      title: 'Q3 report',
      snippet: 'Quarterly numbers',
      type: 'application/pdf',
      private: true
    }
  ]);
  const structured = extractToolSources({
    toolId: 'mcp_docs_find',
    toolDef,
    result: { structuredContent: { sources: [{ title: 'S', url: 'https://s.example/' }] } }
  });
  assert.equal(structured.items[0].provider, 'mcp:docs');
});

test('envelope: an app invoked as a tool hands its sources on as they were', () => {
  const frame = extract('app__research', {
    content: 'Answer',
    sources: [
      {
        id: 'ifinder:doc-1',
        provider: 'ifinder',
        kind: 'document',
        title: 'Policy',
        ref: { id: 'doc-1', scope: 'hr' },
        private: true
      },
      // The gateway states `private` on every source it forwards.
      {
        id: 'url:example.com',
        provider: 'web',
        kind: 'page',
        url: 'https://example.com/',
        private: false
      }
    ]
  });
  assert.deepEqual(
    frame.items.map(item => [item.id, item.provider, item.private]),
    [
      ['ifinder:doc-1', 'ifinder', true],
      ['url:example.com', 'web', false]
    ]
  );
});

// ── a declaration in the tool definition ───────────────────────────────────

const jiraTool = {
  id: 'jira',
  functions: {
    search: {
      sources: {
        provider: 'jira',
        kind: 'item',
        list: 'issues',
        fields: {
          id: 'key',
          title: 'fields.summary',
          url: 'browseUrl',
          snippet: 'fields.status.name',
          publishedDate: 'fields.updated'
        },
        query: 'jql'
      }
    }
  }
};

test('declared: a tool maps its result to sources without code', () => {
  const frame = extractToolSources({
    toolId: 'jira_search',
    toolDef: { ...jiraTool, id: 'jira_search', method: 'search' },
    args: { jql: 'project = ACME' },
    result: JSON.stringify({
      issues: [
        {
          key: 'ACME-1',
          browseUrl: 'https://jira.example/browse/ACME-1',
          fields: { summary: 'Login fails', status: { name: 'Open' }, updated: '2026-09-29' }
        },
        { key: 'ACME-2', fields: { summary: 'No link' } }
      ]
    })
  });
  assert.deepEqual(frame, {
    items: [
      {
        id: 'jira:ACME-1',
        provider: 'jira',
        kind: 'item',
        title: 'Login fails',
        url: 'https://jira.example/browse/ACME-1',
        snippet: 'Open',
        publishedDate: '2026-09-29T00:00:00.000Z',
        private: true
      },
      { id: 'jira:ACME-2', provider: 'jira', kind: 'item', title: 'No link', private: true }
    ],
    queries: ['project = ACME']
  });
});

test('declared: a ref to a registered provider gets its actions; others lose the ref', () => {
  const declaration = {
    provider: 'ifinder',
    list: 'hits',
    fields: { title: 'name', url: 'accessInfo.deepLink' },
    ref: { id: 'docId', scope: 'profile' },
    public: true
  };
  const frame = extractToolSources({
    toolId: 'custom_docs',
    toolDef: { id: 'custom_docs', sources: declaration },
    result: {
      hits: [
        {
          docId: 'doc-9',
          profile: 'legal',
          name: 'NDA',
          'accessInfo.deepLink': 'https://ifinder.example/doc-9'
        }
      ]
    }
  });
  assert.deepEqual(frame.items[0], {
    id: 'ifinder:doc-9',
    provider: 'ifinder',
    kind: 'document',
    title: 'NDA',
    url: 'https://ifinder.example/doc-9',
    ref: { id: 'doc-9', scope: 'legal' },
    // Fetched with the user's permissions: private whatever the declaration says.
    private: true
  });

  const unknown = extractToolSources({
    toolId: 'custom_docs',
    toolDef: { id: 'custom_docs', sources: { ...declaration, provider: 'nowhere' } },
    result: { hits: [{ docId: 'doc-9', name: 'NDA' }] }
  });
  assert.equal(unknown.items[0].ref, undefined);
  assert.equal(unknown.items[0].id, 'nowhere:doc-9');
});

test('declared: an invalid declaration is ignored and the tool falls through', () => {
  const toolDef = { id: 'odd', sources: { fields: { nope: 'x' } } };
  assert.equal(declarationOf(toolDef), null);
  assert.equal(
    extractToolSources({
      toolId: 'odd',
      toolDef,
      result: { sources: [{ url: 'https://o.example/' }] }
    }).items[0].url,
    'https://o.example/'
  );
});

// ── registration and the frame ─────────────────────────────────────────────

test('registered producer: an integration with its own result shape', t => {
  t.after(() => _resetSourceProducers());
  registerSourceProducer({
    id: 'confluence',
    matches: ({ toolId }) => toolId.startsWith('confluence_'),
    fromToolResult: ({ result }) => ({
      items: result.pages.map(page => ({
        provider: 'confluence',
        id: page.id,
        title: page.title,
        url: page.link
      })),
      queries: [result.cql]
    })
  });
  const frame = extract('confluence_search', {
    cql: 'text ~ "onboarding"',
    pages: [{ id: '42', title: 'Onboarding', link: 'https://wiki.example/42' }]
  });
  assert.deepEqual(frame.items[0].id, 'confluence:42');
  assert.deepEqual(frame.queries, ['text ~ "onboarding"']);
  assert.throws(() => registerSourceProducer({ id: 'x' }), TypeError);
});

test('a producer that throws never fails the tool call', t => {
  t.after(() => _resetSourceProducers());
  registerSourceProducer({
    id: 'broken',
    matches: () => true,
    fromToolResult: () => {
      throw new Error('boom');
    }
  });
  assert.equal(extract('anything', {}), null);
});

test('registered provider: its refs survive the frame', t => {
  t.after(() => _resetSourceProviders());
  assert.equal(hasSourceProvider('nextcloud'), false);
  registerSourceProvider({ id: 'nextcloud', content: async () => ({ body: '' }) });
  assert.equal(hasSourceProvider('nextcloud'), true);
  const frame = finalizeSourceFrame({
    items: [{ provider: 'nextcloud', ref: { id: '/Docs/a.pdf' }, title: 'a.pdf' }]
  });
  assert.deepEqual(frame.items[0].ref, { id: '/Docs/a.pdf' });
  assert.throws(() => registerSourceProvider({ id: 'x' }), TypeError);
});

test('frame: what the ledger and the wire accept', () => {
  const frame = finalizeSourceFrame(
    {
      items: [{ url: 'https://example.com/', title: 'Ex' }, {}, null],
      queries: ['  q  ', 'q', 3],
      supports: [{ text: 'A claim.', urls: ['https://example.com/'] }]
    },
    { provider: 'web', private: false }
  );
  assert.deepEqual(frame.queries, ['q']);
  assert.equal(frame.items.length, 1);
  assert.deepEqual(sourcesAddedData.parse({ step: 1, callId: 'c', ...frame }).items, frame.items);
  assert.equal(finalizeSourceFrame({ items: [], queries: [] }), null);
  assert.equal(finalizeSourceFrame(null), null);
});

test('frame: bounded in size — extra passages go first, then sources from the end', () => {
  const passages = Array.from({ length: 10 }, (_, p) => `${p} ${'x'.repeat(3990)}`);
  const frame = finalizeSourceFrame(
    {
      items: Array.from({ length: 50 }, (_, i) => ({
        provider: 'ifinder',
        ref: { id: `doc-${i}` },
        title: `Doc ${i}`,
        passages
      }))
    },
    { private: true }
  );
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= MAX_FRAME_BYTES);
  assert.ok(frame.items.every(item => item.passages.length === 1));
  assert.equal(frame.items.length, 50, 'one passage each fits');
  assert.equal(frame.items[0].id, 'ifinder:doc-0');
});
