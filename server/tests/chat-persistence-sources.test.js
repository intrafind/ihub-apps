/**
 * `chatSources` — the sources behind a chat answer, as the chat stores them
 * with it — and what a share carries of them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boundStoredSources, MAX_STORED_SOURCES_BYTES } from '../services/chat/chatSources.js';
import { snapshotMessage } from '../services/chat/ChatShareRepository.js';
import { jsonByteLength } from '../services/mcp/mcpApps.js';
import { MAX_SOURCES, shareableSourceSet } from '../../shared/sources/index.js';

const page = n => ({
  id: `url:example.com/${n}`,
  provider: 'web',
  kind: 'page',
  url: `https://example.com/${n}`,
  title: `Page ${n}`,
  private: false
});

const documentSource = (n, extra = {}) => ({
  id: `ifinder:doc-${n}`,
  provider: 'ifinder',
  kind: 'document',
  title: `Document ${n}`,
  ref: { id: `doc-${n}`, scope: 'sales' },
  private: true,
  ...extra
});

describe('boundStoredSources: the normalized set, bounded', () => {
  it('keeps the known fields of each source, drops the rest and the supports', () => {
    const stored = boundStoredSources({
      items: [
        { ...page(1), injected: { script: true }, url: 'javascript:alert(1)' },
        documentSource(2, { passages: [{ text: 'p', marker: 's:1' }] })
      ],
      queries: ['q', 'q', '  '],
      supports: [{ text: 't', urls: ['https://example.com/1'] }]
    });
    assert.deepEqual(stored, {
      // A source whose only link was unsafe is identified by nothing else.
      items: [documentSource(2, { passages: [{ text: 'p', marker: 's:1' }] })],
      queries: ['q']
    });
  });

  it('caps the count and the stored size, passages first', () => {
    const many = boundStoredSources({
      items: Array.from({ length: MAX_SOURCES + 20 }, (_, i) => page(i))
    });
    assert.equal(many.items.length, MAX_SOURCES);

    const big = boundStoredSources({
      items: Array.from({ length: MAX_SOURCES }, (_, i) =>
        documentSource(i, {
          passages: Array.from({ length: 5 }, (_, p) => ({ text: `${p}${'x'.repeat(3990)}` }))
        })
      )
    });
    assert.ok(jsonByteLength(big) <= MAX_STORED_SOURCES_BYTES);
    assert.ok(
      big.items.every(source => source.passages.length === 1),
      'passages went first'
    );
    assert.ok(big.items.length < MAX_SOURCES, 'then sources');
    assert.equal(big.items[0].id, 'ifinder:doc-0', 'the first ones stay');
  });

  it('nothing left to store is null', () => {
    assert.equal(boundStoredSources(null), null);
    assert.equal(boundStoredSources({ items: [{ title: 'no id, no link' }], queries: [] }), null);
  });
});

describe('what a share carries of the sources', () => {
  const sources = {
    items: [
      page(1),
      documentSource(2),
      // Read by the page reader only: may be an intranet page.
      { ...page(3), private: true },
      // Claims to be public, but its provider fetches it with the owner's permissions.
      documentSource(4, { private: false })
    ],
    queries: ['wind']
  };

  it('keeps only public sources without a permission-bound ref', () => {
    assert.deepEqual(shareableSourceSet(sources), { items: [page(1)], queries: ['wind'] });
    assert.equal(shareableSourceSet({ items: [documentSource(2)], queries: ['q'] }), null);
  });

  it('is applied to the snapshot of a shared message; the stored one is untouched', () => {
    const snapshot = snapshotMessage({ id: 'm', role: 'assistant', content: 'a', sources });
    assert.deepEqual(snapshot.sources.items, [page(1)]);
    assert.equal(sources.items.length, 4);
    const privateOnly = snapshotMessage({
      id: 'm',
      role: 'assistant',
      content: 'a',
      sources: { items: [documentSource(2)], queries: [] }
    });
    assert.equal('sources' in privateOnly, false);
  });

  it('never carries the documents answers stored before the sources contract', () => {
    const snapshot = snapshotMessage({
      id: 'm',
      role: 'assistant',
      content: 'a',
      citations: { references: [], resultItems: [{ document_id: 'secret' }] }
    });
    assert.equal('citations' in snapshot, false);
  });
});
