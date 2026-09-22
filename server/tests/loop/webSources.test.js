/**
 * The pages behind a search / fetch tool call (services/loop/webSources.js),
 * which ride on `tool/completed` so the chat can show them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWebSources, MAX_WEB_SOURCES } from '../../services/loop/webSources.js';
import { toolCompletedData } from '../../services/loop/contracts/sseV2.js';
import { toolResultData } from '../../services/loop/contracts/runLogEvents.js';

test('extractWebSources: search results become sources, in order', () => {
  const sources = extractWebSources('braveSearch', {
    results: [
      { title: 'Example', url: 'https://example.com/a', description: 'x' },
      { title: 'Other', url: 'https://other.org/' }
    ]
  });
  assert.deepEqual(sources, [
    { url: 'https://example.com/a', title: 'Example' },
    { url: 'https://other.org/', title: 'Other' }
  ]);
});

test('extractWebSources: extracted pages are marked read or failed', () => {
  const sources = extractWebSources('qwantSearch', {
    query: 'q',
    results: [
      { title: 'A', url: 'https://a.example/' },
      { title: 'B', url: 'https://b.example/' }
    ],
    extractedContent: [
      { title: 'A', url: 'https://a.example/', contentExtracted: true },
      { title: 'B', url: 'https://b.example/', contentExtracted: false, extractionError: 'x' }
    ]
  });
  assert.deepEqual(sources, [
    { url: 'https://a.example/', title: 'A', read: true },
    { url: 'https://b.example/', title: 'B', readFailed: true }
  ]);
});

test('extractWebSources: a single fetched page is a read source', () => {
  assert.deepEqual(
    extractWebSources('webContentExtractor', {
      url: 'https://example.com/page',
      title: 'Page',
      content: 'text'
    }),
    [{ url: 'https://example.com/page', title: 'Page', read: true }]
  );
});

test('extractWebSources: JSON text results are parsed', () => {
  const text = JSON.stringify([{ link: 'https://example.com/', name: 'Ex' }]);
  assert.deepEqual(extractWebSources('mcp_web_search', text), [
    { url: 'https://example.com/', title: 'Ex' }
  ]);
  assert.deepEqual(extractWebSources('mcp_web_search', 'plain text answer'), []);
});

test('extractWebSources: other tools, errors and non-http URLs yield nothing', () => {
  assert.deepEqual(extractWebSources('write_memory', { results: [{ url: 'https://x.io' }] }), []);
  assert.deepEqual(extractWebSources('braveSearch', { error: true, message: 'boom' }), []);
  assert.deepEqual(
    extractWebSources('braveSearch', {
      results: [{ url: 'javascript:alert(1)' }, { url: 'file:///etc/passwd' }, { url: 'nope' }]
    }),
    []
  );
});

test('extractWebSources: deduplicates by URL and caps the list', () => {
  const results = Array.from({ length: MAX_WEB_SOURCES + 10 }, (_, i) => ({
    url: `https://example.com/${i % (MAX_WEB_SOURCES + 5)}`
  }));
  const sources = extractWebSources('braveSearch', { results });
  assert.equal(sources.length, MAX_WEB_SOURCES);
  assert.equal(new Set(sources.map(s => s.url)).size, MAX_WEB_SOURCES);
});

test('contracts: webSources survives tool/completed and the ledger tool result', () => {
  const webSources = [{ url: 'https://example.com/', title: 'Ex', read: true }];
  const sse = toolCompletedData.parse({
    step: 1,
    callId: 'c1',
    toolId: 'braveSearch',
    name: 'braveSearch',
    resultPreview: '…',
    webSources
  });
  assert.deepEqual(sse.webSources, webSources);
  const ledger = toolResultData.parse({
    step: 1,
    callId: 'c1',
    toolId: 'braveSearch',
    name: 'braveSearch',
    resultPreview: '…',
    durationMs: 3,
    webSources
  });
  assert.deepEqual(ledger.webSources, webSources);
});

test('extractWebSources: iFinder hits fall back to their deep link', () => {
  const sources = extractWebSources('iFinder_search', {
    totalFound: 2,
    results: [
      {
        id: 'fs-1',
        title: 'Contract.pdf',
        url: 'file://share/contracts/Contract.pdf',
        deepLink: 'https://ifinder.example.com/open?id=fs-1'
      },
      {
        id: 'conf-2',
        title: 'Onboarding',
        url: 'https://wiki.example.com/onboarding',
        deepLink: 'https://ifinder.example.com/open?id=conf-2'
      }
    ]
  });
  assert.deepEqual(sources, [
    {
      url: 'https://ifinder.example.com/open?id=fs-1',
      documentId: 'fs-1',
      title: 'Contract.pdf'
    },
    { url: 'https://wiki.example.com/onboarding', documentId: 'conf-2', title: 'Onboarding' }
  ]);
});

test('extractWebSources: an iFinder hit without a browser link is listed by document id', () => {
  const sources = extractWebSources('iFinder_search', {
    results: [{ id: 'fs-9', title: ['Memo.docx'], url: 'smb://share/Memo.docx' }]
  });
  assert.deepEqual(sources, [{ documentId: 'fs-9', title: 'Memo.docx' }]);
});

test('extractWebSources: iFinder_getContent is a read document', () => {
  const sources = extractWebSources('iFinder_getContent', {
    documentId: 'fs-1',
    content: 'The notice period is three months.',
    metadata: { title: 'Contract.pdf', url: 'file://share/contracts/Contract.pdf' }
  });
  assert.deepEqual(sources, [{ documentId: 'fs-1', title: 'Contract.pdf', read: true }]);
});

test('extractWebSources: iFinder_getMetadata names the document without reading it', () => {
  const sources = extractWebSources('iFinder_getMetadata', {
    id: 'conf-2',
    title: 'Onboarding',
    deepLink: 'https://ifinder.example.com/open?id=conf-2',
    content: null
  });
  assert.deepEqual(sources, [
    { url: 'https://ifinder.example.com/open?id=conf-2', documentId: 'conf-2', title: 'Onboarding' }
  ]);
});
