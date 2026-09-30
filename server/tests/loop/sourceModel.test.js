/**
 * The source model (shared/sources): one shape for everything a producer
 * found, normalized the same way on the server and the client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySourceSet,
  mergeSource,
  mergeSources,
  normalizeSource
} from '../../../shared/sources/index.js';

test('normalizeSource: identity from ref, then the provider’s id, then the link', () => {
  assert.equal(normalizeSource({ provider: 'ifinder', ref: { id: 7 } }).id, 'ifinder:7');
  assert.equal(normalizeSource({ provider: 'jira', id: 'X-1' }).id, 'jira:X-1');
  assert.equal(
    normalizeSource({ provider: 'web', url: 'https://www.a.example/p/' }).id,
    'url:a.example/p'
  );
  assert.equal(normalizeSource({ title: 'nothing to identify it by' }), null);
  assert.equal(normalizeSource(null), null);
  assert.equal(normalizeSource(['x']), null);
});

test('normalizeSource: kinds, defaults and safe values', () => {
  assert.equal(normalizeSource({ ref: { id: 'd' } }).kind, 'document');
  assert.equal(normalizeSource({ url: 'https://a.example/' }).kind, 'page');
  assert.equal(normalizeSource({ id: 'r1' }).kind, 'item');
  assert.equal(normalizeSource({ id: 'r1', kind: 'bogus' }).kind, 'item');
  assert.equal(normalizeSource({ id: 'r1', provider: 'bad provider!' }).provider, 'unknown');
  const source = normalizeSource(
    {
      id: 'r1',
      title: ['  First   title ', 'second'],
      url: 'javascript:alert(1)',
      snippet: '<b>bold</b> text',
      passages: ['one', 'one', { text: 'two', marker: 'bad marker!' }],
      markers: ['r:1', 'r:1', '<x>'],
      read: { ok: true, words: -1 },
      cited: 'yes'
    },
    { provider: 'tool', private: true }
  );
  assert.deepEqual(source, {
    id: 'tool:r1',
    provider: 'tool',
    kind: 'item',
    title: 'First title',
    snippet: 'bold text',
    passages: [{ text: 'one' }, { text: 'two' }],
    read: { ok: true },
    markers: ['r:1'],
    private: true
  });
});

test('normalizeSource: idempotent — a stored or wire source comes out the same', () => {
  for (const input of [
    { provider: 'ifinder', ref: { id: 'doc-1', scope: 'hr' }, title: 'Doc', private: true },
    { provider: 'web', url: 'https://example.com/a?b=1', title: 'Page', cited: true },
    { provider: 'jira', id: 'X-1', title: 'Issue' }
  ]) {
    const once = normalizeSource(input);
    assert.deepEqual(normalizeSource(once), once);
    // A normalized source keeps its own privacy, whatever the defaults say.
    assert.deepEqual(normalizeSource(once, { private: !once.private }).private, once.private);
  }
});

test('mergeSource: the first sighting keeps its values, the later one fills gaps', () => {
  const first = normalizeSource({
    provider: 'ifinder',
    ref: { id: 'd' },
    title: 'Title',
    passages: ['a'],
    private: true
  });
  const later = normalizeSource({
    provider: 'ifinder',
    ref: { id: 'd', scope: 'sales' },
    title: 'Other title',
    fileName: 'd.pdf',
    passages: ['b'],
    markers: ['r:1'],
    read: { ok: true },
    cited: true,
    private: true
  });
  assert.deepEqual(mergeSource(first, later), {
    id: 'ifinder:d',
    provider: 'ifinder',
    kind: 'document',
    title: 'Title',
    fileName: 'd.pdf',
    ref: { id: 'd', scope: 'sales' },
    passages: [{ text: 'a' }, { text: 'b' }],
    markers: ['r:1'],
    read: { ok: true },
    cited: true,
    private: true
  });
});

test('mergeSource: a success wins over a failed read; public if any sighting was', () => {
  const failed = normalizeSource({ url: 'https://a.example/', read: { ok: false }, private: true });
  const read = normalizeSource({
    url: 'https://a.example/',
    read: { ok: true, words: 5, truncated: true }
  });
  const merged = mergeSource(failed, read);
  assert.deepEqual(merged.read, { ok: true, words: 5, truncated: true });
  assert.equal(merged.private, false);
  assert.deepEqual(mergeSource(read, failed).read, { ok: true, words: 5, truncated: true });
});

test('mergeSource: a public sighting never makes public what a private one reported', () => {
  const found = normalizeSource({
    provider: 'crm',
    url: 'https://acme.example/',
    title: 'ACME — key account',
    snippet: 'Deal size 5M, renewal at risk',
    passages: [{ text: 'internal note' }],
    private: true
  });
  const searched = normalizeSource({
    provider: 'web',
    url: 'https://acme.example',
    title: 'ACME Corp',
    snippet: 'We build anvils.',
    private: false
  });
  const read = normalizeSource({
    provider: 'web',
    url: 'https://acme.example/',
    title: 'ACME (read)',
    read: { ok: true, words: 900 },
    cited: true,
    private: true
  });
  for (const merged of [
    mergeSource(found, searched),
    mergeSource(searched, found),
    mergeSource(mergeSource(found, searched), read),
    mergeSource(mergeSource(read, found), searched)
  ]) {
    assert.equal(merged.private, false);
    assert.equal(merged.provider, 'web');
    assert.equal(merged.title, 'ACME Corp');
    assert.equal(merged.snippet, 'We build anvils.');
    assert.equal(merged.passages, undefined);
  }
  // What the private sightings did with it still counts: read and cited.
  const all = mergeSource(mergeSource(found, searched), read);
  assert.deepEqual(all.read, { ok: true, words: 900 });
  assert.equal(all.cited, true);
  // Two private sightings still add up, for the owner's own view.
  assert.deepEqual(mergeSource(found, read).passages, [{ text: 'internal note' }]);
  assert.equal(mergeSource(found, read).title, 'ACME — key account');
});

test('mergeSources: frames only add, in order; an empty frame returns the set unchanged', () => {
  const one = mergeSources(emptySourceSet(), {
    items: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }],
    queries: ['q']
  });
  assert.equal(mergeSources(one, { items: [{ url: 'https://a.example' }] }), one);
  assert.equal(mergeSources(one, null), one);
  const two = mergeSources(one, {
    items: [{ url: 'https://c.example/' }, { url: 'http://a.example', title: 'A' }],
    queries: ['q', 'r'],
    supports: [{ text: 'claim', urls: ['https://a.example/', 'javascript:x'] }]
  });
  assert.deepEqual(
    two.items.map(item => [item.id, item.title]),
    [
      ['url:a.example', 'A'],
      ['url:b.example', undefined],
      ['url:c.example', undefined]
    ]
  );
  assert.deepEqual(two.queries, ['q', 'r']);
  assert.deepEqual(two.supports, [{ text: 'claim', urls: ['https://a.example/'] }]);
  assert.equal(one.items.length, 2, 'the set passed in is not changed');
});
