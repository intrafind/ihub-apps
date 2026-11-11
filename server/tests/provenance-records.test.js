// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Provenance records (#3327): the frozen `nfc-trim` normalization, the object
 * shape and watermark matrix, the record store (including the "store contains
 * no text" guarantee), the retention sweep and the installation id.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestStorage } from './helpers/testStorage.js';
import {
  buildProvenance,
  buildWatermark,
  getContentMarking,
  hashText,
  isOutputId,
  newOutputId,
  normalizeText
} from '../services/provenance/records.js';
import { provenanceSchema } from '../services/provenance/provenanceSchema.js';
import {
  ALLOWED_RECORD_KEYS,
  MAX_RECORDS_PER_HASH,
  ProvenanceStore
} from '../services/provenance/ProvenanceStore.js';
import { sweepProvenance } from '../services/provenance/provenanceRetention.js';
import { getProvenanceStore } from '../services/provenance/ProvenanceStore.js';
import { recordTextOutput } from '../services/provenance/turnProvenance.js';

const DAY = 24 * 60 * 60 * 1000;

describe('nfc-trim normalization', () => {
  it('has a frozen golden hash', () => {
    assert.equal(
      hashText('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('applies NFC, line endings and trim, and keeps inner whitespace', () => {
    assert.equal(hashText('é'), hashText('é'));
    assert.equal(hashText('a\r\nb\rc'), hashText('a\nb\nc'));
    assert.equal(hashText('  \n hi there \n'), hashText('hi there'));
    assert.notEqual(hashText('hi  there'), hashText('hi there'));
    assert.notEqual(hashText('Hi'), hashText('hi'));
    assert.equal(normalizeText('  x  '), 'x');
  });

  it('refuses a normalization it does not know', () => {
    assert.throws(() => hashText('x', 'nfc-trim-9'));
  });
});

describe('output ids', () => {
  it('are sortable ULIDs', () => {
    const a = newOutputId(1_700_000_000_000);
    const b = newOutputId(1_700_000_001_000);
    assert.ok(isOutputId(a) && isOutputId(b));
    assert.ok(a < b);
    assert.notEqual(newOutputId(1), newOutputId(1));
  });
});

describe('buildProvenance', () => {
  const base = {
    outputId: newOutputId(),
    text: 'Hello',
    model: { id: 'gpt-x' },
    installationId: 'inst_1',
    version: '9.9.9'
  };

  it('matches the spec shape', () => {
    const p = buildProvenance(base);
    assert.doesNotThrow(() => provenanceSchema.parse(p));
    assert.equal(p.spec, 'intrafind-provenance/1.0');
    assert.equal(p.ai_generated, true);
    assert.equal(p.generator.installation_id, 'inst_1');
    assert.deepEqual(p.content_hash, {
      alg: 'sha-256',
      normalization: 'nfc-trim',
      value: hashText('Hello')
    });
    assert.equal(p.kind, undefined, 'kind is omitted for text');
    assert.equal(p.digital_source_type, undefined, 'no digital_source_type for text');
    assert.equal(p.signature, undefined, 'no signature');
    assert.equal('verify' in p, false, 'no look-up URL: the client builds it from the API path');
  });

  it('has no content_hash for an output without text', () => {
    assert.equal(buildProvenance({ ...base, text: '   ' }).content_hash, undefined);
  });

  it('never carries the text', () => {
    const p = buildProvenance({ ...base, text: 'unique-marker-for-test-0123456789' });
    assert.equal(JSON.stringify(p).includes('unique-marker'), false);
  });

  it('takes a precomputed hash and kind for media records (#3328)', () => {
    const hash = 'a'.repeat(64);
    const p = buildProvenance({
      ...base,
      text: undefined,
      kind: 'image',
      hash,
      normalization: 'none'
    });
    assert.equal(p.kind, 'image');
    assert.deepEqual(p.content_hash, { alg: 'sha-256', normalization: 'none', value: hash });
  });
});

describe('watermark matrix', () => {
  it('absent contentMarking is "none"', () => {
    assert.deepEqual(getContentMarking({}), { by: 'none' });
    assert.deepEqual(buildWatermark({}), { by: 'none', applied: false });
  });

  it('provider is applied on the operator statement; statementRef stays out', () => {
    const model = {
      contentMarking: { text: { by: 'provider', scheme: 'synthid', statementRef: 'doc-1' } }
    };
    assert.deepEqual(buildWatermark(model), { by: 'provider', scheme: 'synthid', applied: true });
  });

  it('ihub is not applied until the generation path says so', () => {
    const model = { contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } } };
    assert.equal(buildWatermark(model).applied, false);
    assert.equal(buildWatermark(model, { watermarkApplied: false }).applied, false);
    assert.equal(buildWatermark(model, { watermarkApplied: true, keyId: 'wm-1' }).applied, true);
    assert.equal(buildWatermark(model, { watermarkApplied: true, keyId: 'wm-1' }).key_id, 'wm-1');
  });
});

describe('ProvenanceStore', () => {
  let storage;
  let store;
  before(async () => {
    storage = await startTestStorage({ prefix: 'ihub-provenance-' });
  });
  after(async () => {
    await storage.stop();
  });
  beforeEach(async () => {
    store = new ProvenanceStore({ documents: storage.provider.documents });
  });

  const make = (text, extra = {}) =>
    buildProvenance({
      outputId: newOutputId(),
      text,
      model: { id: 'm' },
      installationId: 'inst_t',
      version: '1.0.0',
      ...extra
    });

  it('records and finds by hash, newest first', async () => {
    const first = make('store-find-text');
    const second = make('store-find-text');
    await store.record(first);
    await store.record(second);
    const found = await store.findByHash(hashText('store-find-text'));
    assert.deepEqual(
      found.map(r => r.output_id),
      [second.output_id, first.output_id]
    );
    // The object has no look-up URL member at all (the client builds it from the API path).
    assert.equal('verify' in found[0], false);
  });

  it('returns nothing for an unknown or malformed hash', async () => {
    assert.deepEqual(await store.findByHash(hashText('never-recorded')), []);
    assert.deepEqual(await store.findByHash('not-a-hash'), []);
  });

  it('keeps at most MAX_RECORDS_PER_HASH per hash, dropping the oldest', async () => {
    const records = [];
    for (let i = 0; i < MAX_RECORDS_PER_HASH + 1; i += 1) {
      const r = make('cap-text');
      records.push(r);
      await store.record(r);
    }
    const found = await store.findByHash(hashText('cap-text'));
    assert.equal(found.length, MAX_RECORDS_PER_HASH);
    assert.equal(
      found.some(r => r.output_id === records[0].output_id),
      false
    );
  });

  it('survives concurrent writes of the same hash', async () => {
    const records = Array.from({ length: 6 }, () => make('concurrent-text'));
    await Promise.all(records.map(r => store.record(r)));
    const found = await store.findByHash(hashText('concurrent-text'));
    assert.equal(found.length, records.length);
  });

  it('indexes the final-step text of a multi-step turn under a second hash', async () => {
    const r = make('first step prose. final answer');
    await store.record(r, { extraHashes: [hashText('final answer')] });
    assert.equal((await store.findByHash(hashText('final answer')))[0].output_id, r.output_id);
    assert.equal(
      (await store.findByHash(hashText('first step prose. final answer')))[0].output_id,
      r.output_id
    );
  });

  it('contains no output text anywhere on disk', async () => {
    const text =
      'ZQXJ-secret-marker-9f3a This sentence must never be written to the provenance store anywhere.';
    await store.record(make(text));
    // Even a record built with the text still hidden in an unexpected field is cut down.
    const sneaky = { ...make(text), text, content: text, prompt: text };
    await store.record(sneaky);

    const files = [];
    const walk = async dir => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(storage.dir);
    const touched = [];
    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8');
      if (raw.includes('ZQXJ')) touched.push(file);
      for (let i = 0; i + 20 <= text.length; i += 5) {
        assert.equal(raw.includes(text.slice(i, i + 20)), false, `${file} holds text`);
      }
    }
    assert.deepEqual(touched, []);

    const [record] = await store.findByHash(hashText(text));
    for (const key of Object.keys(record)) assert.ok(ALLOWED_RECORD_KEYS.includes(key), key);
  });

  it('mints the installation id once and reuses it', async () => {
    const other = new ProvenanceStore({ documents: storage.provider.documents });
    const a = await store.installationId();
    const b = await other.installationId();
    assert.match(a, /^inst_[0-9a-f-]{36}$/);
    assert.equal(a, b);
  });

  it('prefers IHUB_INSTALLATION_ID', async () => {
    process.env.IHUB_INSTALLATION_ID = 'inst_operator';
    try {
      assert.equal(await store.installationId(), 'inst_operator');
    } finally {
      delete process.env.IHUB_INSTALLATION_ID;
    }
  });

  it('is a no-op without a document store', async () => {
    const none = new ProvenanceStore({ documents: null });
    assert.equal(await none.record(make('x')), false);
    assert.deepEqual(await none.findByHash(hashText('x')), []);
  });
});

describe('retention sweep', () => {
  let storage;
  before(async () => {
    storage = await startTestStorage({ prefix: 'ihub-provenance-sweep-' });
  });
  after(async () => {
    await storage.stop();
  });

  const at = (text, ageDays, now) =>
    buildProvenance({
      outputId: newOutputId(),
      createdAt: new Date(now - ageDays * DAY).toISOString(),
      text,
      model: { id: 'm' },
      installationId: 'inst_t',
      version: '1.0.0'
    });

  it('removes only records older than retentionDays and deletes empty documents', async () => {
    const store = getProvenanceStore();
    const now = Date.now();
    await store.record(at('old-only', 400, now));
    await store.record(at('mixed', 400, now));
    await store.record(at('mixed', 10, now));
    await store.record(at('fresh-only', 10, now));

    const result = await sweepProvenance({ retentionDays: 365, now: () => now });
    assert.equal(result.skipped, false);
    assert.equal(result.removedRecords, 2);
    assert.equal(result.removedDocuments, 1);
    assert.equal((await store.findByHash(hashText('old-only'))).length, 0);
    assert.equal((await store.findByHash(hashText('mixed'))).length, 1);
    assert.equal((await store.findByHash(hashText('fresh-only'))).length, 1);
  });

  it('keeps everything when retentionDays is 0', async () => {
    const store = getProvenanceStore();
    const now = Date.now();
    await store.record(at('ancient', 4000, now));
    const result = await sweepProvenance({ retentionDays: 0, now: () => now });
    assert.equal(result.skipped, true);
    assert.equal((await store.findByHash(hashText('ancient'))).length, 1);
  });
});

describe('recordTextOutput', () => {
  let storage;
  before(async () => {
    storage = await startTestStorage({ prefix: 'ihub-provenance-turn-' });
  });
  after(async () => {
    await storage.stop();
  });

  it('records the text and returns the object; no text, no object', async () => {
    const outputId = newOutputId();
    const p = await recordTextOutput({
      outputId,
      text: 'turn answer text',
      model: { id: 'm1' },
      modelConfig: { contentMarking: { text: { by: 'provider', scheme: 'synthid' } } }
    });
    assert.equal(p.output_id, outputId);
    assert.equal(p.model.watermark.applied, true);
    const found = await getProvenanceStore().findByHash(hashText('turn answer text'));
    assert.equal(found[0].output_id, outputId);
    assert.equal(await recordTextOutput({ text: '  ', model: { id: 'm1' } }), null);
  });

  it('indexes the final-step text of a multi-step turn', async () => {
    const p = await recordTextOutput({
      text: 'thinking out loud. The answer is 42.',
      finalText: 'The answer is 42.',
      model: { id: 'm1' }
    });
    const found = await getProvenanceStore().findByHash(hashText('The answer is 42.'));
    assert.equal(found[0].output_id, p.output_id);
  });
});
