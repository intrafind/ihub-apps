// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Regression tests for the review of storage encryption: the one-time
 * conversion (`storage/atRest/prepare.js`).
 *
 * - server B1: one process at a time (lease), scratch files with a name of
 *   their own, a verify pass that opens records;
 * - server S3: the key check object lives beside the state record;
 * - server S4: no artifact is skipped by its name;
 * - server S8: the free-space check counts blobs and files;
 * - security S2: a missing state record does not bring plaintext back;
 * - a provider built to look something up is shut down again (timers).
 */
import { scratchRoot } from './support/scratchContents.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { providerInMode, testKeys } from './support/atRestTestSupport.js';

const { prepareStorageEncryption, CONVERSION_LEASE, ACCEPT_PLAINTEXT_ENV_VAR } =
  await import('../storage/atRest/prepare.js');
const { readAtRestState, writeAtRestState, CURRENT_FACETS } =
  await import('../storage/atRest/state.js');
const { FilesystemLockManager, FilesystemStorageProvider } =
  await import('../storage/providers/filesystem/index.js');
const { registerProvider, resolveStorageBaseDir } = await import('../storage/index.js');
const { findSealedData } = await import('../storage/atRest/keyGuard.js');
const { beginAtRestPreparation, endAtRestPreparation } =
  await import('../storage/atRest/policy.js');
const { isStoreFile, SEALED_FILE_STORES } = await import('../storage/atRest/sealedFiles.js');
const { isSealedFile } = await import('../crypto/fileSeal.js');

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const keys = testKeys();
const loadKeys = async () => keys;

let counter = 0;
/** A contents directory of its own; `data` below it is the data directory. */
async function scratch() {
  counter += 1;
  const root = path.join(scratchRoot, `conversion-${counter}`);
  const baseDir = path.join(root, 'data');
  await fs.mkdir(baseDir, { recursive: true });
  return {
    root,
    baseDir,
    config: { storage: { filesystem: { baseDir }, encryption: { enabled: true } } }
  };
}

const prepare = (config, options = {}) =>
  prepareStorageEncryption({ platformConfig: config, env: {}, loadKeys, ...options });

const exists = file =>
  fs.stat(file).then(
    () => true,
    () => false
  );

/** Write plaintext data as a server with the switch off does. */
async function seedPlaintext(baseDir, { records = 50 } = {}) {
  const provider = providerInMode(baseDir, 'off', { keys });
  await provider.initialize();
  await provider.documents.put('chats', 'c1', { title: 'plain chat' });
  const items = [];
  for (let seq = 1; seq <= records; seq += 1) {
    items.push({ entry: { type: 'e', text: `${'x'.repeat(200)}${seq}` }, seq });
  }
  await provider.logs.appendBatch('run:r1', items);
  await provider.logs.flush();
  await provider.blobs.put('chat-files', 'f1', Buffer.alloc(4000, 7));
  const file = provider.logs.streamFilePath('run:r1');
  await provider.shutdown();
  return { streamFile: file };
}

describe('one process converts at a time (server B1)', () => {
  it('the command refuses while another process holds the lease, and a start waits for it', async () => {
    const { baseDir, config } = await scratch();
    await seedPlaintext(baseDir);
    const other = new FilesystemLockManager({ baseDir });
    let release;
    const held = new Promise(resolve => {
      release = resolve;
    });
    let taken;
    const holding = new Promise(resolve => {
      taken = resolve;
    });
    const lease = other.withLock(
      CONVERSION_LEASE,
      async () => {
        taken();
        await held;
      },
      { ttlMs: 60_000 }
    );
    await holding;

    await assert.rejects(prepare(config, { leaseWaitMs: 0 }), { code: 'CONVERSION_IN_PROGRESS' });
    assert.equal(await readAtRestState(baseDir), null, 'the refused run wrote nothing');

    let finished = false;
    const start = prepare(config).then(result => {
      finished = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(finished, false, 'a start waits while the lease is held');
    release();
    await lease;
    assert.equal((await start).action, 'converted');
    assert.equal((await readAtRestState(baseDir)).state, 'complete');
  });

  it('two processes converting the same data directory leave every stream readable', async () => {
    const { baseDir } = await scratch();
    const { streamFile } = await seedPlaintext(baseDir, { records: 6000 });
    const child = `
      await import('./tests/support/scratchContents.js');
      const { testKeys } = await import('./tests/support/atRestTestSupport.js');
      const { prepareStorageEncryption } = await import('./storage/atRest/prepare.js');
      const keys = testKeys();
      try {
        const result = await prepareStorageEncryption({
          platformConfig: { storage: { filesystem: { baseDir: process.argv[1] }, encryption: { enabled: true } } },
          env: {}, loadKeys: async () => keys
        });
        console.log('RESULT ' + result.action);
      } catch (error) { console.log('RESULT error ' + (error.code || error.message)); }
      process.exit(0);
    `;
    const run = () =>
      new Promise(resolve => {
        const proc = spawn(process.execPath, ['--input-type=module', '-e', child, baseDir], {
          cwd: serverDir,
          env: { ...process.env, ALLOW_UNSUPPORTED_NODE: '1' }
        });
        let out = '';
        proc.stdout.on('data', chunk => (out += chunk));
        proc.on('exit', () =>
          resolve(/RESULT (.*)/.exec(out)?.[1] || `no result: ${out.slice(-300)}`)
        );
      });
    const outcomes = (await Promise.all([run(), run()])).sort();
    // One converts; the other waits for the lease and finds the work done.
    assert.deepEqual(outcomes, ['converted', 'verified']);
    const reader = providerInMode(baseDir, 'enforced', { keys });
    assert.equal((await reader.logs.read('run:r1')).length, 6000);
    await reader.shutdown();
    const names = await fs.readdir(path.dirname(streamFile));
    assert.deepEqual(
      names.filter(name => name.endsWith('.sealing')),
      [],
      'no scratch file is left'
    );
  });

  it('a scratch file is removed only by the run that converts', async () => {
    const { baseDir, config } = await scratch();
    const { streamFile } = await seedPlaintext(baseDir);
    const foreign = `${streamFile}.0123456789abcdef.sealing`;
    const legacy = `${streamFile}.sealing`;
    await fs.writeFile(foreign, 'scratch of a conversion in another process');
    await fs.writeFile(legacy, 'scratch of an earlier build');
    await prepare(config, { dryRun: true });
    assert.equal(await exists(foreign), true, 'a dry run removes no scratch file');
    await prepare(config);
    assert.equal(await exists(foreign), false);
    assert.equal(await exists(legacy), false);
  });

  it('a stream whose records do not open is not recorded as converted', async () => {
    const { baseDir, config } = await scratch();
    const { streamFile } = await seedPlaintext(baseDir);
    await prepare(config);
    // What two writers into one scratch file left behind: sealed records
    // whose key line is not in the file.
    const lines = (await fs.readFile(streamFile, 'utf8')).split('\n').filter(Boolean);
    const withoutKeyLine = lines.filter(line => !line.includes('"$key"'));
    assert.equal(withoutKeyLine.length, lines.length - 1);
    await fs.writeFile(streamFile, `${withoutKeyLine.join('\n')}\n`);

    const provider = providerInMode(baseDir, 'converting', { keys });
    const plain = await provider.logs.inspectStreamFile(streamFile);
    assert.equal(plain.damaged, 0, 'counting line kinds does not see it');
    const verified = await provider.logs.inspectStreamFile(streamFile, { verify: true });
    assert.ok(verified.damaged > 0, 'opening records does');
    await provider.shutdown();

    const state = await readAtRestState(baseDir);
    await writeAtRestState(baseDir, {
      ...state,
      state: 'converting',
      facets: { blobs: 1, documents: 1 }
    });
    await assert.rejects(prepare(config), { code: 'ENCRYPTION_INCOMPLETE' });
    const after = await readAtRestState(baseDir);
    assert.equal(after.state, 'converting');
    assert.equal(after.facets.logs, undefined, 'the facet is not recorded');
  });
});

describe('the key check object lives beside the state record (server S3)', () => {
  it('is written outside the blob tree, and survives removing the blob tree', async () => {
    const { baseDir, config } = await scratch();
    await seedPlaintext(baseDir);
    await prepare(config);
    assert.equal(await exists(path.join(baseDir, '.at-rest-keycheck')), true);
    assert.equal(await exists(path.join(baseDir, 'blobs', '_ihub', 'keycheck')), false);
    await fs.rm(path.join(baseDir, 'blobs'), { recursive: true });
    assert.equal((await prepare(config)).action, 'verified');
  });

  it('moves a key check object from the former place, once', async () => {
    const { baseDir, config } = await scratch();
    await seedPlaintext(baseDir);
    await prepare(config);
    const current = path.join(baseDir, '.at-rest-keycheck');
    const former = path.join(baseDir, 'blobs', '_ihub', 'keycheck');
    await fs.mkdir(path.dirname(former), { recursive: true });
    await fs.rename(current, former);
    assert.equal((await findSealedData([baseDir])).reason, 'state-record');

    assert.equal((await prepare(config, { dryRun: true })).action, 'verified');
    assert.equal(await exists(former), true, 'a dry run moves nothing');
    assert.equal((await prepare(config)).action, 'verified');
    assert.equal(await exists(current), true);
    assert.equal(await exists(former), false);
  });

  it('the key guard finds a key check object at either place', async () => {
    const { baseDir } = await scratch();
    assert.equal(await findSealedData([baseDir]), null);
    await fs.mkdir(path.join(baseDir, 'blobs', '_ihub'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'blobs', '_ihub', 'keycheck'), 'x');
    assert.equal((await findSealedData([baseDir])).reason, 'key-check');
    await fs.rm(path.join(baseDir, 'blobs'), { recursive: true });
    await fs.writeFile(path.join(baseDir, '.at-rest-keycheck'), 'x');
    assert.equal((await findSealedData([baseDir])).reason, 'key-check');
  });
});

describe('no artifact is skipped by its name (server S4)', () => {
  it('seals yarn.lock, notes.tmp and dot files, and leaves only the scratch file of an atomic write', async () => {
    const { root, baseDir, config } = await scratch();
    const dir = path.join(baseDir, 'agent-artifacts', 'run1');
    await fs.mkdir(dir, { recursive: true });
    const names = ['report.md', 'yarn.lock', 'notes.tmp', 'poetry.lock'];
    for (const name of names) await fs.writeFile(path.join(dir, name), `secret ${name}`);
    const scratchFile = path.join(dir, '.tmp_0123456789abcdef');
    await fs.writeFile(scratchFile, 'half-written');
    assert.equal(path.dirname(baseDir), root);

    const result = await prepare(config);
    assert.equal(result.state.converted.files, names.length);
    for (const name of names) {
      assert.equal(isSealedFile(await fs.readFile(path.join(dir, name))), true, name);
    }
    assert.equal(await fs.readFile(scratchFile, 'utf8'), 'half-written');

    const artifacts = SEALED_FILE_STORES.find(store => store.id === 'agent-artifacts');
    assert.equal(isStoreFile(artifacts, 'yarn.lock'), true);
    assert.equal(isStoreFile(artifacts, '.tmp_0123456789abcdef'), false);
    assert.equal(isStoreFile(artifacts, '.tmp_notes'), true, 'only the exact scratch name');
  });
});

describe('the free-space check counts blobs and files (server S8)', () => {
  it('needs room for the largest plaintext blob and the largest file', async () => {
    const { baseDir, config } = await scratch();
    const blobBytes = 3 * 1024 * 1024;
    await fs.mkdir(path.join(baseDir, 'blobs', 'chat-files'), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, 'blobs', 'chat-files', 'big'),
      Buffer.alloc(blobBytes, 1)
    );
    const dry = await prepare(config, { dryRun: true });
    assert.equal(dry.report.blobs.plaintextBytes, blobBytes);
    assert.equal(dry.report.blobs.largestBytes, blobBytes);
    assert.ok(dry.neededBytes >= blobBytes, `neededBytes ${dry.neededBytes}`);

    const fileBytes = 5 * 1024 * 1024;
    await fs.mkdir(path.join(baseDir, 'agent-artifacts', 'run1'), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, 'agent-artifacts', 'run1', 'big.bin'),
      Buffer.alloc(fileBytes, 2)
    );
    const both = await prepare(config, { dryRun: true });
    assert.ok(both.neededBytes >= fileBytes + 2 * 1024, `neededBytes ${both.neededBytes}`);
  });
});

describe('a missing state record does not bring plaintext back (security S2)', () => {
  async function convertedWithoutRecord() {
    const made = await scratch();
    await seedPlaintext(made.baseDir);
    await prepare(made.config);
    await fs.rm(path.join(made.baseDir, '.at-rest.json'));
    return made;
  }

  /** A plaintext document as someone with write access to the directory plants it. */
  async function plant(baseDir) {
    const plain = new FilesystemStorageProvider({
      baseDir,
      flushIntervalMs: 25,
      fenceSweepIntervalMs: 0,
      encryption: { mode: 'off', loadKeys, writeState: false }
    });
    await plain.initialize();
    await plain.documents.put('chats', 'planted', { title: 'planted content' });
    await plain.shutdown();
  }

  it('writes the record again when only sealed data is found', async () => {
    const { baseDir, config } = await convertedWithoutRecord();
    const result = await prepare(config);
    assert.equal(result.action, 'verified');
    assert.equal(result.stateRecordMissing, true);
    const state = await readAtRestState(baseDir);
    assert.equal(state.state, 'complete');
    assert.deepEqual(state.facets, { ...CURRENT_FACETS });
    assert.ok(state.recreatedAt);
  });

  it('refuses plaintext found beside sealed data, and does not seal it', async () => {
    const { baseDir, config } = await convertedWithoutRecord();
    await plant(baseDir);
    await assert.rejects(prepare(config), { code: 'ENCRYPTION_STATE_MISSING' });
    assert.equal(await readAtRestState(baseDir), null);
    const reader = providerInMode(baseDir, 'enforced', { keys });
    await assert.rejects(reader.documents.get('chats', 'planted'), { code: 'PLAINTEXT_DOCUMENT' });
    await reader.shutdown();
  });

  it('seals it only when the operator confirms it for that run', async () => {
    const { baseDir, config } = await convertedWithoutRecord();
    await plant(baseDir);
    const result = await prepareStorageEncryption({
      platformConfig: config,
      env: { [ACCEPT_PLAINTEXT_ENV_VAR]: 'true' },
      loadKeys
    });
    assert.equal(result.action, 'converted');
    assert.equal(result.state.converted.documents, 1);
  });

  it('a first conversion that crashed right after the record was written continues', async () => {
    const { baseDir, config } = await scratch();
    await seedPlaintext(baseDir);
    // What a crash between the record and the key check object leaves.
    await writeAtRestState(baseDir, { state: 'converting', facets: {} });
    const result = await prepare(config);
    assert.equal(result.action, 'converted');
    assert.equal(result.state.keyId, await keys.getKeyProvider().currentKeyId());
  });

  it('storage started by a migration before the first conversion does not look like a lost record', async () => {
    const { baseDir, config } = await scratch();
    await seedPlaintext(baseDir);
    // A configuration migration starts storage in the preparing process: it
    // seals what it writes and creates the key check object, before the
    // conversion has run.
    beginAtRestPreparation();
    try {
      const early = providerInMode(baseDir, 'auto', { keys });
      await early.initialize();
      assert.equal(
        (await readAtRestState(baseDir)).state,
        'converting',
        'said before the first seal'
      );
      await early.documents.put('chats', 'by-migration', { title: 'sealed early' });
      await early.shutdown();
    } finally {
      endAtRestPreparation();
    }
    const result = await prepare(config);
    assert.equal(result.action, 'converted');
    assert.ok(result.state.converted.documents >= 1, 'the plaintext from before is converted');
  });

  it('a record that names a key and no key check object is refused', async () => {
    const { baseDir, config } = await scratch();
    await seedPlaintext(baseDir);
    await prepare(config);
    await fs.rm(path.join(baseDir, '.at-rest-keycheck'));
    await assert.rejects(prepare(config), { code: 'KEY_CHECK_MISSING' });
  });
});

describe('a provider built to look something up is shut down again', () => {
  it('on every way out of the preparation step and of the base directory lookup', async () => {
    const { baseDir } = await scratch();
    const open = new Set();
    registerProvider('review-counting', providerConfig => {
      const provider = new FilesystemStorageProvider(providerConfig);
      open.add(provider);
      const shutdown = provider.shutdown.bind(provider);
      provider.shutdown = async () => {
        open.delete(provider);
        return shutdown();
      };
      return provider;
    });
    const config = enabled => ({
      storage: {
        provider: 'review-counting',
        'review-counting': { baseDir },
        encryption: { enabled }
      }
    });
    // Defaults: switch off, no record. The early return.
    assert.equal((await prepare(config(false))).action, 'none');
    assert.equal(open.size, 0, 'switch off');
    assert.equal(await resolveStorageBaseDir(config(false), {}), baseDir);
    assert.equal(open.size, 0, 'base directory lookup');
    assert.equal((await prepare(config(true), { dryRun: true })).action, 'dry-run');
    assert.equal(open.size, 0, 'dry run');
    assert.equal((await prepare(config(true))).action, 'converted');
    assert.equal(open.size, 0, 'conversion');
    // Switch off again: the record is set to off, and nothing stays open.
    assert.equal((await prepare(config(false))).action, 'disabled');
    assert.equal(open.size, 0, 'disabled');
    assert.equal(await exists(path.join(baseDir, '.at-rest.json')), true);
  });
});
