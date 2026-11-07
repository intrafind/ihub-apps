// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Applying the picked items of a gateway sync.
 *
 * What has to hold:
 *   - only a pick that still matches the drift is applied; a model config never
 *     comes from the caller;
 *   - an update is merged onto the stored model, so a field changed by another
 *     write in the meantime survives (the failure a stale read caused when an
 *     update was followed by a disable);
 *   - a model that is gone is disabled, never deleted;
 *   - every item has its own outcome and one failure does not stop the others.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGatewayDrift, itemKey, patchOf } from '../services/gatewaySyncApply.js';

const ADDED = {
  kind: 'added',
  remoteId: 'llama-4',
  name: 'llama-4',
  model: { id: 'gw-llama-4', modelId: 'llama-4', provider: 'openai', enabled: true }
};
const CHANGED = {
  kind: 'changed',
  remoteId: 'qwen3-vl',
  modelId: 'gw-qwen',
  changes: [
    { field: 'contextWindow', from: 32768, to: 65536 },
    { field: 'supportsVision', from: false, to: true }
  ]
};
const REMOVED = { kind: 'removed', remoteId: 'retired', modelId: 'gw-retired', reason: 'missing' };
const ITEMS = [CHANGED, ADDED, REMOVED];

/** An in-memory store that records what happened. */
function memoryStore(initial = {}, { failWrite = () => false } = {}) {
  const files = new Map(Object.entries(initial).map(([id, doc]) => [id, structuredClone(doc)]));
  const log = [];
  return {
    files,
    log,
    read: async id => (files.has(id) ? structuredClone(files.get(id)) : null),
    write: async (id, doc) => {
      if (failWrite(id)) throw new Error(`disk full for ${id}`);
      files.set(id, structuredClone(doc));
      log.push(`write ${id}`);
    },
    audit: async (action, id) => log.push(`audit ${action} ${id}`),
    snapshot: async (id, before, after) =>
      log.push(`snapshot ${id} ${before.enabled}->${after.enabled}`)
  };
}

const stored = () => ({
  'gw-qwen': { id: 'gw-qwen', modelId: 'qwen3-vl', contextWindow: 32768, enabled: true },
  'gw-retired': { id: 'gw-retired', modelId: 'retired', enabled: true, default: true }
});

// A pick names the iHub model for `changed` and `removed` (several can share a remote id).
const pick = item => ({
  kind: item.kind,
  remoteId: item.remoteId,
  ...(item.modelId ? { modelId: item.modelId } : {})
});
const outcomes = results => results.map(r => `${r.kind}:${r.remoteId}=${r.status}`);

test('keys and patches', () => {
  assert.equal(itemKey(ADDED), 'added:llama-4');
  // changed and removed are about one iHub model, not the remote model it points at
  assert.equal(itemKey(CHANGED), 'changed:gw-qwen');
  assert.equal(itemKey(REMOVED), 'removed:gw-retired');
  assert.deepEqual(patchOf(CHANGED.changes), { contextWindow: 65536, supportsVision: true });
  assert.deepEqual(patchOf(undefined), {});
});

test('creates the added model, updates the changed one, disables the removed one', async () => {
  const store = memoryStore(stored());
  const results = await applyGatewayDrift({ picks: ITEMS.map(pick), items: ITEMS, store });

  assert.deepEqual(outcomes(results), [
    'added:llama-4=applied',
    'changed:qwen3-vl=applied',
    'removed:retired=applied'
  ]);
  assert.deepEqual(results[0].modelId, 'gw-llama-4');
  assert.deepEqual(store.files.get('gw-llama-4'), ADDED.model);
  assert.deepEqual(store.files.get('gw-qwen'), {
    id: 'gw-qwen',
    modelId: 'qwen3-vl',
    contextWindow: 65536,
    supportsVision: true,
    enabled: true
  });
  assert.deepEqual(store.files.get('gw-retired'), {
    id: 'gw-retired',
    modelId: 'retired',
    enabled: false,
    default: false
  });
});

test('an update is merged onto the stored model, not onto what the drift saw', async () => {
  // Another write made the model the default after the admin looked at the drift.
  const files = stored();
  files['gw-qwen'].default = true;
  const store = memoryStore(files);

  await applyGatewayDrift({ picks: [pick(CHANGED)], items: ITEMS, store });

  assert.equal(store.files.get('gw-qwen').default, true);
  assert.equal(store.files.get('gw-qwen').contextWindow, 65536);
});

test('an update followed by a disable keeps both', async () => {
  const store = memoryStore(stored());
  await applyGatewayDrift({ picks: [pick(REMOVED), pick(CHANGED)], items: ITEMS, store });
  assert.equal(store.files.get('gw-qwen').contextWindow, 65536);
  assert.equal(store.files.get('gw-retired').enabled, false);
});

test('a model that is gone is disabled and its file is kept', async () => {
  const store = memoryStore(stored());
  await applyGatewayDrift({ picks: [pick(REMOVED)], items: ITEMS, store });
  assert.ok(store.files.has('gw-retired'));
  assert.equal(store.files.get('gw-retired').enabled, false);
});

test('only what is picked is applied', async () => {
  const store = memoryStore(stored());
  const results = await applyGatewayDrift({ picks: [pick(ADDED)], items: ITEMS, store });
  assert.deepEqual(outcomes(results), ['added:llama-4=applied']);
  assert.equal(store.files.get('gw-qwen').contextWindow, 32768);
  assert.equal(store.files.get('gw-retired').enabled, true);
});

test('a pick the gateway no longer reports is skipped, and nothing is written for it', async () => {
  const store = memoryStore(stored());
  const results = await applyGatewayDrift({
    picks: [
      { kind: 'added', remoteId: 'never-listed' },
      { kind: 'removed', remoteId: 'qwen3-vl' }
    ],
    items: ITEMS,
    store
  });
  assert.deepEqual(
    results.map(r => [r.status, r.detail]),
    [
      ['skipped', 'changedSinceReview'],
      ['skipped', 'changedSinceReview']
    ]
  );
  assert.deepEqual(store.log, []);
});

test('the caller cannot supply a model config', async () => {
  const store = memoryStore();
  const evil = { kind: 'added', remoteId: 'llama-4', model: { id: 'evil', provider: 'openai' } };
  await applyGatewayDrift({ picks: [evil], items: ITEMS, store });
  assert.ok(store.files.has('gw-llama-4'));
  assert.ok(!store.files.has('evil'));
});

test('a pick named twice is applied once', async () => {
  const store = memoryStore(stored());
  const results = await applyGatewayDrift({
    picks: [pick(CHANGED), pick(CHANGED)],
    items: ITEMS,
    store
  });
  assert.equal(results.length, 1);
  assert.equal(store.log.filter(line => line === 'write gw-qwen').length, 1);
});

test('one failure does not stop the others and names its reason', async () => {
  const store = memoryStore(stored(), { failWrite: id => id === 'gw-llama-4' });
  const results = await applyGatewayDrift({ picks: ITEMS.map(pick), items: ITEMS, store });

  assert.deepEqual(outcomes(results), [
    'added:llama-4=failed',
    'changed:qwen3-vl=applied',
    'removed:retired=applied'
  ]);
  assert.match(results[0].detail, /disk full for gw-llama-4/);
  assert.equal(results[0].modelId, 'gw-llama-4');
});

test('an added model is not written over one that exists by now', async () => {
  const store = memoryStore({ ...stored(), 'gw-llama-4': { id: 'gw-llama-4', hand: 'made' } });
  const [result] = await applyGatewayDrift({ picks: [pick(ADDED)], items: ITEMS, store });
  assert.equal(result.status, 'failed');
  assert.match(result.detail, /already exists/);
  assert.deepEqual(store.files.get('gw-llama-4'), { id: 'gw-llama-4', hand: 'made' });
});

test('a model that vanished from disk is a failure, not a crash', async () => {
  const store = memoryStore({});
  const results = await applyGatewayDrift({
    picks: [pick(CHANGED), pick(REMOVED)],
    items: ITEMS,
    store
  });
  assert.deepEqual(outcomes(results), ['changed:qwen3-vl=failed', 'removed:retired=failed']);
  assert.match(results[0].detail, /not found/);
});

test('every update and disable keeps its change history and audit entry', async () => {
  const store = memoryStore(stored());
  await applyGatewayDrift({ picks: ITEMS.map(pick), items: ITEMS, store });
  assert.deepEqual(
    store.log.filter(line => /^(snapshot|audit)/.test(line)),
    [
      'audit create gw-llama-4',
      'snapshot gw-qwen true->true',
      'audit update gw-qwen',
      'snapshot gw-retired true->false',
      'audit update gw-retired'
    ]
  );
});

test('no picks, nothing done', async () => {
  const store = memoryStore(stored());
  assert.deepEqual(await applyGatewayDrift({ picks: [], items: ITEMS, store }), []);
  assert.deepEqual(store.log, []);
});

// Two iHub models can share a remote id: a clone of an imported model keeps its
// `modelId` and its provider. Each is its own item and must be picked and applied alone.
const CLONE_A = { kind: 'removed', remoteId: 'retired', modelId: 'gw-retired', reason: 'missing' };
const CLONE_B = {
  kind: 'removed',
  remoteId: 'retired',
  modelId: 'gw-retired-copy',
  reason: 'missing'
};
const CLONES = [CLONE_A, CLONE_B];
const clonedFiles = () => ({
  'gw-retired': { id: 'gw-retired', modelId: 'retired', enabled: true },
  'gw-retired-copy': { id: 'gw-retired-copy', modelId: 'retired', enabled: true }
});

test('two models of one remote model are both applied when both are picked', async () => {
  const store = memoryStore(clonedFiles());
  const results = await applyGatewayDrift({ picks: CLONES.map(pick), items: CLONES, store });

  assert.deepEqual(
    results.map(r => [r.modelId, r.status]),
    [
      ['gw-retired', 'applied'],
      ['gw-retired-copy', 'applied']
    ]
  );
  assert.equal(store.files.get('gw-retired').enabled, false);
  assert.equal(store.files.get('gw-retired-copy').enabled, false);
});

test('picking one of two models of a remote model leaves the other alone', async () => {
  const store = memoryStore(clonedFiles());
  const results = await applyGatewayDrift({ picks: [pick(CLONE_B)], items: CLONES, store });

  assert.deepEqual(
    results.map(r => [r.modelId, r.status]),
    [['gw-retired-copy', 'applied']]
  );
  assert.equal(store.files.get('gw-retired').enabled, true);
  assert.equal(store.files.get('gw-retired-copy').enabled, false);
});

test('changes to two models of one remote model go to the right model each', async () => {
  const a = { ...CHANGED, modelId: 'gw-qwen' };
  const b = {
    ...CHANGED,
    modelId: 'gw-qwen-copy',
    changes: [{ field: 'contextWindow', from: 1, to: 999 }]
  };
  const store = memoryStore({
    'gw-qwen': { id: 'gw-qwen', contextWindow: 32768 },
    'gw-qwen-copy': { id: 'gw-qwen-copy', contextWindow: 1 }
  });
  await applyGatewayDrift({ picks: [pick(a), pick(b)], items: [a, b], store });
  assert.equal(store.files.get('gw-qwen').contextWindow, 65536);
  assert.equal(store.files.get('gw-qwen-copy').contextWindow, 999);
});

test('a pick that does not name the model of a changed or removed item is skipped', async () => {
  const store = memoryStore(clonedFiles());
  const results = await applyGatewayDrift({
    picks: [{ kind: 'removed', remoteId: 'retired' }],
    items: CLONES,
    store
  });
  assert.deepEqual(
    results.map(r => r.status),
    ['skipped']
  );
  assert.deepEqual(store.log, []);
});
