// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Regression tests for the review of storage encryption: what a running
 * server does.
 *
 * - server S1: a worker takes the encryption switch from its primary, never
 *   writes the state record, and is not re-forked in a tight loop;
 * - server S5: a contents directory that holds data does not get the default
 *   `platform.json` with encryption switched on;
 * - security S1: an unreadable document is not "absent" for a sweep that deletes;
 * - security S4: the file stores do not default to plaintext while storage
 *   is not started, and are reset after the provider has shut down;
 * - security N1: a storage failure does not name objects or keys to a caller.
 */
import { contentsDir, dataDir, scratchRoot } from './support/scratchContents.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, after } from 'node:test';
import { providerInMode, testKeys } from './support/atRestTestSupport.js';

const storage = await import('../storage/index.js');
const { readAtRestState, writeAtRestState, CURRENT_FACETS } =
  await import('../storage/atRest/state.js');
const { FilesystemStorageProvider } = await import('../storage/providers/filesystem/index.js');
const { createRespawnBackoff } = await import('../startup/respawnBackoff.js');
const setup = await import('../utils/setupUtils.js');
const { walkDocuments } = await import('../storage/walk.js');
const { CorruptBlobError, CorruptDocumentError, KeyUnavailableError } =
  await import('../storage/errors.js');
const { ChatEvidenceRepository, evidenceScope } =
  await import('../services/chat/ChatEvidenceRepository.js');
const { RUNTIME_NAMESPACES, BLOB_NAMESPACES } = await import('../storage/namespaces.js');
const sealedFiles = await import('../storage/atRest/sealedFiles.js');
const { isSealedFile } = await import('../crypto/fileSeal.js');
const { toErrorResponse } = await import('../utils/errorResponse.js');

const keys = testKeys();
const loadKeys = async () => keys;
let counter = 0;
async function scratchBase() {
  counter += 1;
  const baseDir = path.join(scratchRoot, `runtime-${counter}`, 'data');
  await fs.mkdir(baseDir, { recursive: true });
  return baseDir;
}
const completeState = async () => ({
  state: 'complete',
  facets: { ...CURRENT_FACETS },
  keyId: await keys.getKeyProvider().currentKeyId()
});
const workerProvider = (baseDir, mode) =>
  new FilesystemStorageProvider({
    baseDir,
    flushIntervalMs: 25,
    fenceSweepIntervalMs: 0,
    encryption: { mode, loadKeys, writeState: false }
  });

describe('a worker takes the encryption switch from its primary (server S1)', () => {
  const on = { storage: { encryption: { enabled: true } } };
  const off = { storage: { encryption: { enabled: false } } };

  it('the primary hands its decision to the fork environment', () => {
    assert.deepEqual(storage.encryptionDecisionEnv(on, {}), {
      [storage.ENCRYPTION_DECISION_ENV_VAR]: 'on'
    });
    assert.deepEqual(storage.encryptionDecisionEnv({}, {}), {
      [storage.ENCRYPTION_DECISION_ENV_VAR]: 'off'
    });
  });

  it('a worker uses the decision, whatever platform.json says by now', () => {
    const decided = value => ({ [storage.ENCRYPTION_DECISION_ENV_VAR]: value });
    const worker = { isWorker: true };
    // Saved "off" while the cluster runs with encryption on: a replacement stays on.
    const stillOn = storage.withStartDecision(off, decided('on'), worker);
    assert.equal(storage.resolveStorageConfig(stillOn, {}).encryption.enabled, true);
    // Saved "on" while the cluster runs with encryption off: a replacement stays off.
    const stillOff = storage.withStartDecision(on, decided('off'), worker);
    assert.equal(storage.resolveStorageConfig(stillOff, {}).encryption.enabled, false);
    assert.equal(off.storage.encryption.enabled, false, 'the configuration is not changed');
    // Not a way to override the switch from the environment outside a worker.
    assert.equal(storage.withStartDecision(off, decided('on'), { isWorker: false }), off);
    assert.equal(storage.withStartDecision(off, decided('maybe'), worker), off);
    assert.equal(storage.withStartDecision(off, {}, worker), off);
  });

  it('a worker never writes the state record', async () => {
    // Started with the switch off on a converted data directory.
    const baseDir = await scratchBase();
    await writeAtRestState(baseDir, await completeState());
    const offWorker = workerProvider(baseDir, 'off');
    await offWorker.initialize();
    assert.equal((await readAtRestState(baseDir)).state, 'complete', 'not set to off');
    await offWorker.shutdown();
    // The process that prepares the data directory does write it.
    const single = providerInMode(baseDir, 'off', { keys });
    await single.initialize();
    assert.equal((await readAtRestState(baseDir)).state, 'off');
    await single.shutdown();

    // Started with the switch on in an empty data directory without a record.
    const empty = await scratchBase();
    const onWorker = workerProvider(empty, 'auto');
    await assert.rejects(onWorker.initialize(), { code: 'ENCRYPTION_NOT_CONVERTED' });
    assert.equal(await readAtRestState(empty), null, 'no record written');
    await onWorker.shutdown();
  });

  it('a worker that cannot start is replaced after a growing pause', () => {
    const backoff = createRespawnBackoff();
    assert.equal(backoff.next(5 * 60_000), 0, 'a worker that served is replaced at once');
    assert.deepEqual(
      [200, 150, 180, 90, 100, 100, 100].map(lived => backoff.next(lived)),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    );
    assert.equal(backoff.next(61_000), 0, 'a stable worker resets it');
    assert.equal(backoff.next(10), 1000);
  });
});

describe('the default platform.json and a contents directory that holds data (server S5)', () => {
  const defaultsWithEncryption = async root => {
    const defaults = path.join(root, 'defaults');
    await fs.mkdir(path.join(defaults, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(defaults, 'config', 'platform.json'),
      JSON.stringify({ storage: { encryption: { enabled: true } }, other: 1 })
    );
    await fs.mkdir(path.join(defaults, 'data'), { recursive: true });
    await fs.writeFile(path.join(defaults, 'data', '.gitkeep'), '');
    return defaults;
  };
  const enabledIn = async contents =>
    JSON.parse(await fs.readFile(path.join(contents, 'config', 'platform.json'), 'utf8')).storage
      .encryption.enabled;

  it('decides "holds data" by a regular file under data/ or agents/memory/', async () => {
    const root = path.join(scratchRoot, 'setup-holds');
    await fs.mkdir(path.join(root, 'data', 'chats'), { recursive: true });
    assert.equal(await setup.contentsHoldStorageData(root), false, 'empty directories');
    await fs.writeFile(path.join(root, 'data', '.gitkeep'), '');
    assert.equal(await setup.contentsHoldStorageData(root), false, '.gitkeep is no data');
    await fs.mkdir(path.join(root, 'config'), { recursive: true });
    await fs.writeFile(path.join(root, 'config', 'ui.json'), '{}');
    assert.equal(await setup.contentsHoldStorageData(root), false, 'configuration is no data');
    await fs.writeFile(path.join(root, 'data', 'chats', 'c1.json'), '{}');
    assert.equal(await setup.contentsHoldStorageData(root), true);
    const memory = path.join(scratchRoot, 'setup-memory');
    await fs.mkdir(path.join(memory, 'agents', 'memory'), { recursive: true });
    await fs.writeFile(path.join(memory, 'agents', 'memory', 'p.md'), 'notes');
    assert.equal(await setup.contentsHoldStorageData(memory), true);
    assert.equal(await setup.contentsHoldStorageData(path.join(scratchRoot, 'nowhere')), false);
  });

  it('a fresh directory gets the switch on; one that holds data gets it written as off', async () => {
    const root = path.join(scratchRoot, 'setup-seed');
    const defaults = await defaultsWithEncryption(root);
    const seed = async contents => {
      const holdsData = await setup.contentsHoldStorageData(contents);
      await setup.copyDefaultConfiguration({ defaultsPath: defaults, contentsPath: contents });
      if (holdsData) await setup.disableEncryptionInSeededConfig(contents);
    };
    const fresh = path.join(root, 'fresh');
    await seed(fresh);
    assert.equal(await enabledIn(fresh), true);

    const existing = path.join(root, 'existing');
    await fs.mkdir(path.join(existing, 'data', 'chats'), { recursive: true });
    await fs.writeFile(path.join(existing, 'data', 'chats', 'c1.json'), '{}');
    await seed(existing);
    assert.equal(await enabledIn(existing), false);
    const written = JSON.parse(
      await fs.readFile(path.join(existing, 'config', 'platform.json'), 'utf8')
    );
    assert.equal(written.other, 1, 'nothing else of the default file changes');
    assert.equal(await setup.disableEncryptionInSeededConfig(existing), false, 'idempotent');
  });

  it('performInitialSetup does it for the contents directory of the installation', async () => {
    await fs.rm(path.join(contentsDir, 'config'), { recursive: true, force: true });
    await fs.mkdir(path.join(dataDir, 'chats'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'chats', 'kept.json'), '{}');
    await setup.performInitialSetup();
    assert.equal(setup.wasContentsFreshlySeeded(), true);
    assert.equal(await enabledIn(contentsDir), false);
    // An existing platform.json is never touched afterwards.
    await setup.performInitialSetup();
    assert.equal(setup.wasContentsFreshlySeeded(), false);
    await fs.rm(path.join(dataDir, 'chats'), { recursive: true, force: true });
  });
});

describe('an unreadable document is not absent for a sweep that deletes (security S1)', () => {
  it('a strict walk throws where a lenient one skips, and the evidence sweep keeps the packs', async () => {
    const baseDir = await scratchBase();
    await writeAtRestState(baseDir, await completeState());
    const provider = providerInMode(baseDir, 'enforced', { keys });
    await provider.initialize();
    const docs = RUNTIME_NAMESPACES.chatEvidence;
    const packs = BLOB_NAMESPACES.chatEvidenceContent;
    const scope = evidenceScope('chat-1');
    const repository = new ChatEvidenceRepository({
      documents: provider.documents,
      blobs: provider.blobs,
      locks: provider.locks
    });
    const packKey = id => repository._packKey('chat-1', id);
    await provider.documents.put(docs, `${scope}__${evidenceScope('m1')}`, {
      content: { a: 'pack-1' }
    });
    await provider.documents.put(docs, `${scope}__${evidenceScope('m2')}`, {
      content: { b: 'pack-2' }
    });
    await provider.blobs.put(packs, packKey('pack-1'), 'content of answer 1');
    await provider.blobs.put(packs, packKey('pack-2'), 'content of answer 2');
    await provider.blobs.put(packs, packKey('pack-3'), 'content nothing refers to');

    // The record of m2 stops opening: one character of its sealed payload changes.
    const file = provider.envelopeDocuments._docPath(docs, `${scope}__${evidenceScope('m2')}`);
    const stored = await fs.readFile(file, 'utf8');
    const at = stored.lastIndexOf('"', stored.length - 3) - 8;
    const swapped = stored[at] === 'A' ? 'B' : 'A';
    await fs.writeFile(file, stored.slice(0, at) + swapped + stored.slice(at + 1));
    await assert.rejects(provider.documents.get(docs, `${scope}__${evidenceScope('m2')}`), {
      code: 'CORRUPT_DOCUMENT'
    });

    const walk = async options => {
      const found = [];
      for await (const doc of walkDocuments(provider.documents, docs, options)) found.push(doc.key);
      return found;
    };
    assert.equal((await walk({ prefix: `${scope}__` })).length, 1, 'lenient: skipped');
    await assert.rejects(
      walk({ prefix: `${scope}__`, unreadable: 'throw' }),
      error => error instanceof CorruptDocumentError
    );

    assert.equal(await repository._sweepChatPacks('chat-1'), 0, 'nothing is swept this time');
    assert.ok(await provider.blobs.get(packs, packKey('pack-2')), 'the pack of m2 is kept');
    assert.ok(await provider.blobs.get(packs, packKey('pack-3')));

    // With every record readable the sweep works as before.
    await provider.documents.delete(docs, `${scope}__${evidenceScope('m2')}`).catch(() => {});
    await fs.rm(file, { force: true });
    assert.equal(await repository._sweepChatPacks('chat-1'), 2);
    assert.ok(await provider.blobs.get(packs, packKey('pack-1')));
    assert.equal(await provider.blobs.get(packs, packKey('pack-3')), null);
    await provider.shutdown();
  });

  it('a paged walk over a store without scan throws for a page that skipped documents', async () => {
    const store = {
      supportsScan: false,
      list: async () => ({ items: [{ key: 'a' }], nextCursor: null, skipped: 1 })
    };
    const walked = [];
    for await (const doc of walkDocuments(store, 'ns', {})) walked.push(doc.key);
    assert.deepEqual(walked, ['a']);
    await assert.rejects(async () => {
      for await (const _doc of walkDocuments(store, 'ns', { unreadable: 'throw' })) {
        // not reached
      }
    }, CorruptDocumentError);
  });
});

describe('the file stores while storage is not started (security S4)', () => {
  const platformFile = path.join(contentsDir, 'config', 'platform.json');
  const writePlatform = async enabled => {
    await fs.mkdir(path.dirname(platformFile), { recursive: true });
    await fs.writeFile(platformFile, JSON.stringify({ storage: { encryption: { enabled } } }));
  };
  after(async () => {
    sealedFiles.resetSealedFiles();
    await storage.shutdownStorage();
    await fs.rm(path.join(dataDir, '.at-rest.json'), { force: true });
  });

  it('seals a write when the switch is on, instead of defaulting to plaintext', async () => {
    const keyModule = await import('../crypto/KeyProvider.js');
    const master = await keyModule.ensureMasterKey();
    await fs.mkdir(dataDir, { recursive: true });
    await writeAtRestState(dataDir, {
      state: 'complete',
      facets: { ...CURRENT_FACETS },
      keyId: master.keyId
    });
    await writePlatform(true);
    sealedFiles.resetSealedFiles();
    assert.equal(await sealedFiles.resolveSealedFilesMode(), 'enforced');
    const written = await sealedFiles.sealForDisk('agent-memory', 'p.md', 'a private note');
    assert.equal(isSealedFile(written), true, 'not plaintext');
    assert.equal(
      (await sealedFiles.openFromDisk('agent-memory', 'p.md', written)).toString('utf8'),
      'a private note'
    );
    await assert.rejects(sealedFiles.openFromDisk('agent-memory', 'p.md', Buffer.from('planted')), {
      code: 'PLAINTEXT_FILE'
    });
    await assert.rejects(sealedFiles.assertPlaintextReadable('agent-memory', 'p.md'), {
      code: 'PLAINTEXT_FILE'
    });
  });

  it('writes plaintext when the switch is off, and reads the configuration again after a reset', async () => {
    await writePlatform(false);
    assert.equal(await sealedFiles.resolveSealedFilesMode(), 'enforced', 'not read per call');
    sealedFiles.resetSealedFiles();
    assert.equal(await sealedFiles.resolveSealedFilesMode(), 'off');
    assert.equal(await sealedFiles.sealForDisk('agent-memory', 'p.md', 'a note'), 'a note');
  });

  it('refuses instead of guessing when the state record cannot be read', async () => {
    await writePlatform(true);
    await fs.writeFile(path.join(dataDir, '.at-rest.json'), 'not json');
    sealedFiles.resetSealedFiles();
    await assert.rejects(sealedFiles.sealForDisk('agent-memory', 'p.md', 'a note'), {
      code: 'INVALID_AT_REST_STATE'
    });
    await fs.rm(path.join(dataDir, '.at-rest.json'));
  });

  it('is reset after the provider has shut down, not before', async () => {
    const baseDir = await scratchBase();
    let modeDuringShutdown = null;
    storage.registerProvider('review-shutdown-order', providerConfig => {
      const provider = new FilesystemStorageProvider(providerConfig);
      const shutdown = provider.shutdown.bind(provider);
      provider.shutdown = async () => {
        // What a write that is still running during the shutdown would see.
        modeDuringShutdown = sealedFiles.sealedFilesMode();
        return shutdown();
      };
      return provider;
    });
    await storage.initializeStorage({
      platformConfig: {
        storage: {
          provider: 'review-shutdown-order',
          'review-shutdown-order': { baseDir, fenceSweepIntervalMs: 0 },
          encryption: { enabled: true }
        }
      },
      env: {}
    });
    assert.equal(sealedFiles.sealedFilesMode(), 'enforced');
    await storage.shutdownStorage();
    assert.equal(modeDuringShutdown, 'enforced');
    assert.equal(sealedFiles.sealedFilesMode(), 'off', 'forgotten afterwards');
  });
});

describe('what an API caller is told about a storage failure (security N1)', () => {
  it('is the fixed text of the code, without the object name or the key id', () => {
    const cases = [
      new CorruptBlobError('Blob chat-files/chat__a__f.txt does not verify'),
      new KeyUnavailableError('No master key with id 1a2b3c4d is available', { keyId: '1a2b3c4d' }),
      new CorruptDocumentError('Document chats/c1 is present but unreadable')
    ];
    for (const error of cases) {
      const { status, body } = toErrorResponse(error);
      assert.ok(status >= 500);
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, /chat__a__f|chat-files|1a2b3c4d|chats\/c1/, error.code);
      assert.equal(body.code, error.code);
      assert.ok(body.detail.length > 0);
    }
  });
});
