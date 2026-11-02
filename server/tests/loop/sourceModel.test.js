// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The source model (shared/sources): one shape for everything a producer
 * found, normalized the same way on the server and the client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySourceSet,
  MAX_SCOPES,
  mergeSource,
  mergeSources,
  normalizeSource,
  normalizeSourceScope,
  shareableSourceSet,
  storedSourceSet
} from '../../../shared/sources/index.js';
import { boundStoredSources } from '../../services/chat/chatSources.js';

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

// ── Where a source was found (#3056) ───────────────────────────────────────

test('normalizeSource: scopeName names the ref’s scope and is kept only beside one', () => {
  const found = normalizeSource({
    provider: 'ifinder',
    ref: { id: 'doc-1', scope: 'contracts' },
    scopeName: '  Contracts   2026 '
  });
  assert.equal(found.scopeName, 'Contracts 2026');
  assert.deepEqual(normalizeSource(found), found);
  // Without a scope there is nothing to name.
  assert.equal(
    normalizeSource({ provider: 'ifinder', ref: { id: 'doc-1' }, scopeName: 'X' }).scopeName,
    undefined
  );
  assert.equal(
    normalizeSource({ provider: 'web', url: 'https://a.example/', scopeName: 'X' }).scopeName,
    undefined
  );
  assert.equal(
    normalizeSource({ provider: 'ifinder', ref: { id: 'd', scope: 's' }, scopeName: 42 }).scopeName,
    undefined
  );
});

test('mergeSource: the scope name follows the scope the merged source keeps', () => {
  const inContracts = normalizeSource({
    provider: 'ifinder',
    ref: { id: 'doc-1', scope: 'contracts' },
    scopeName: 'Contracts'
  });
  const inHr = normalizeSource({
    provider: 'ifinder',
    ref: { id: 'doc-1', scope: 'hr' },
    scopeName: 'HR policies'
  });
  const merged = mergeSource(inContracts, inHr);
  assert.deepEqual([merged.ref.scope, merged.scopeName], ['contracts', 'Contracts']);

  // A first sighting without a name does not borrow another scope's name.
  const unnamed = normalizeSource({ provider: 'ifinder', ref: { id: 'doc-1', scope: 'legal' } });
  const kept = mergeSource(unnamed, inHr);
  assert.equal(kept.ref.scope, 'legal');
  assert.equal(kept.scopeName, undefined);

  // A sighting without a scope takes the later one's scope and its name.
  const noScope = normalizeSource({ provider: 'ifinder', ref: { id: 'doc-1' } });
  const filled = mergeSource(noScope, inHr);
  assert.deepEqual([filled.ref.scope, filled.scopeName], ['hr', 'HR policies']);
});

test('normalizeSourceScope: an integration scope with a checked id, name and action', () => {
  assert.deepEqual(
    normalizeSourceScope({
      integrationId: 'iassistant',
      id: 'assistant:hr-bot',
      name: { en: 'HR assistant', de: 'HR-Assistent', 'bad key!': 'x' },
      action: 'ask',
      extra: 'dropped'
    }),
    {
      integrationId: 'iassistant',
      id: 'assistant:hr-bot',
      name: { en: 'HR assistant', de: 'HR-Assistent' },
      action: 'ask'
    }
  );
  assert.deepEqual(
    normalizeSourceScope({ integrationId: 'ifinder', id: 'contracts', action: 'fly' }),
    { integrationId: 'ifinder', id: 'contracts' }
  );
  assert.equal(normalizeSourceScope({ integrationId: 'ifinder' }), null);
  assert.equal(normalizeSourceScope({ integrationId: 'bad id!', id: 'x' }), null);
  assert.equal(normalizeSourceScope({ integrationId: 'ifinder', id: 'a\u0000b' }), null);
  assert.equal(normalizeSourceScope({ integrationId: 'ifinder', id: 'x'.repeat(257) }), null);
  assert.equal(normalizeSourceScope(['x']), null);
});

test('mergeSources: scopes are folded once each, a later sighting may name one', () => {
  const contracts = { integrationId: 'ifinder', id: 'contracts', action: 'search' };
  let set = mergeSources(emptySourceSet(), { items: [], queries: ['q'], scopes: [contracts] });
  assert.deepEqual(set.scopes, [contracts]);
  // Same scope again, now with its name: named, not repeated.
  set = mergeSources(set, { scopes: [{ ...contracts, name: 'Contracts' }] });
  assert.deepEqual(set.scopes, [{ ...contracts, name: 'Contracts' }]);
  // Nothing new: the very same set.
  assert.equal(mergeSources(set, { scopes: [{ ...contracts, name: 'Other' }] }), set);
  // A set without scopes has no `scopes` key at all.
  assert.equal('scopes' in mergeSources(emptySourceSet(), { queries: ['q'] }), false);
  // Bounded.
  const many = Array.from({ length: MAX_SCOPES + 5 }, (_, i) => ({
    integrationId: 'ifinder',
    id: `p${i}`
  }));
  assert.equal(mergeSources(emptySourceSet(), { scopes: many }).scopes.length, MAX_SCOPES);
});

test('storedSourceSet keeps the scopes with the sources; a share drops them', () => {
  const set = {
    items: [{ provider: 'ifinder', ref: { id: 'doc-1', scope: 'hr' }, scopeName: 'HR' }],
    queries: [],
    scopes: [{ integrationId: 'iassistant', id: 'all', name: { en: 'All' }, action: 'ask' }]
  };
  const stored = storedSourceSet(set);
  assert.deepEqual(stored.scopes, set.scopes);
  assert.equal(stored.items[0].scopeName, 'HR');
  assert.deepEqual(storedSourceSet(stored), stored);
  // Scopes alone are no answer's sources.
  assert.equal(storedSourceSet({ items: [], queries: [], scopes: set.scopes }), null);
  // A share carries neither the private sources nor where they were found.
  const shared = shareableSourceSet({
    ...set,
    items: [...set.items, { provider: 'web', url: 'https://a.example/' }]
  });
  assert.equal('scopes' in shared, false);
  assert.equal(shared.items.length, 1);
});

test('boundStoredSources keeps the scopes when it has to drop sources', () => {
  const big = 'x'.repeat(3000);
  const items = Array.from({ length: 100 }, (_, i) => ({
    provider: 'ifinder',
    ref: { id: `doc-${i}`, scope: 'hr' },
    scopeName: 'HR',
    passages: [`${i} ${big}`, `${i} second ${big}`]
  }));
  const scopes = [{ integrationId: 'ifinder', id: 'hr', name: 'HR', action: 'search' }];
  const bounded = boundStoredSources({ items, queries: ['q'], scopes });
  assert.ok(bounded.items.length < items.length);
  assert.deepEqual(bounded.scopes, scopes);
});
