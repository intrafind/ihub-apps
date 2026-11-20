// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one-time conversion of existing data to its encrypted form and the
 * state record that steers it (`storage/atRest/prepare.js`, `state.js`), as a
 * server start composes it from `platform.json`:
 * dry run, conversion, a second run, an interrupted and resumed run, the
 * switch turned off after it was on, and the refusals (a start that did not
 * convert, a wrong or missing master key).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filesUnder, findReadable } from './support/atRestTestSupport.js';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-conversion-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
delete process.env.TOKEN_ENCRYPTION_KEY;
const storage = await import('../storage/index.js');
const {
  describeBlobStorage,
  describeStorageEncryption,
  bootstrapStorage,
  shutdownStorageBootstrap
} = await import('../storage/bootstrap.js');
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
const { beginAtRestPreparation, endAtRestPreparation } =
  await import('../storage/atRest/policy.js');
const { prepareStorageEncryption } = await import('../storage/atRest/prepare.js');
const { readAtRestState, atRestStatePath } = await import('../storage/atRest/state.js');
const { main: encryptCommand } = await import('../storage/commands/encryptStorage.js');
const { main: showCommand } = await import('../storage/commands/showStorage.js');

const MARKER = `PLAINTEXT-CANARY-${crypto.randomBytes(6).toString('hex')}`;
const OLD = new Date('2026-01-02T03:04:05.000Z');
const ANNA = 'anna@example.org';
let counter = 0;

/** A new data directory and the platform configuration that points at it. */
function installation() {
  counter += 1;
  const baseDir = path.join(scratch, `data-${counter}`);
  const platformConfig = enabled => ({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir, fenceSweepIntervalMs: 0, flushIntervalMs: 25 },
      encryption: { enabled }
    }
  });
  const start = enabled =>
    storage.initializeStorage({ env: {}, platformConfig: platformConfig(enabled) });
  const prepare = (enabled, options = {}) =>
    prepareStorageEncryption({ env: {}, platformConfig: platformConfig(enabled), ...options });
  return { baseDir, platformConfig, start, prepare };
}

/**
 * Fill a data directory the way an installation without encryption looks:
 * documents in several namespaces, a run ledger with a spilled payload,
 * blobs, and files of other subsystems that are not storage objects.
 *
 * @returns {Promise<Record<string, string>>} The etag of every document by `ns/key`.
 */
async function seedPlaintext({ baseDir, start }, { documents = 12 } = {}) {
  const provider = await start(false);
  const etags = {};
  for (let index = 0; index < documents; index += 1) {
    for (const ns of ['chats', 'chat-messages', 'artifacts']) {
      const key = `scope__${index}`;
      const body = { title: `${MARKER} ${ns} ${index}`, n: index };
      etags[`${ns}/${key}`] = (await provider.documents.put(ns, key, body, { ownerId: ANNA })).etag;
    }
  }
  // A namespace no release declares any more.
  etags['removed-feature/x'] = (
    await provider.documents.put('removed-feature', 'x', { note: MARKER })
  ).etag;
  for (const run of ['run-a', 'run-b']) {
    for (let seq = 1; seq <= 5; seq += 1) {
      await provider.logs.append(
        `run:${run}`,
        { type: 'message/user', data: { content: `${MARKER} ${seq}` } },
        seq
      );
    }
    await provider.logs.putBlob(`run:${run}`, 'tool-1.json', `${MARKER} spilled`);
  }
  await provider.logs.flush();
  await provider.blobs.put('chat-files', 'chat__a__file.txt', `${MARKER} upload `.repeat(60));
  await provider.blobs.put('artifacts', 'chat__a__art', `${MARKER} artifact`);
  await storage.shutdownStorage();

  // A document from before migration V247 (no etag, no size), an unfinished
  // log line, and a document that is not readable at all.
  await fs.writeFile(
    path.join(baseDir, 'chats', 'legacy.json'),
    JSON.stringify({
      v: 1,
      key: 'legacy',
      ownerId: ANNA,
      createdAt: 'c',
      updatedAt: 'u',
      data: { title: `${MARKER} legacy` }
    })
  );
  await fs.appendFile(
    path.join(baseDir, 'logs', 'run', 'run-b.jsonl'),
    `{"type":"message/user","data":{"content":"${MARKER} torn`
  );
  await fs.writeFile(
    path.join(baseDir, 'chats', 'torn.json'),
    '{"v":2,"key":"torn","data":{"title":"cut off'
  );
  // Not storage objects: they must come out byte-identical.
  await fs.mkdir(path.join(baseDir, 'integrations', 'jira'), { recursive: true });
  await fs.writeFile(
    path.join(baseDir, 'integrations', 'jira', 'anna.json'),
    '{"data":"ENC[token]"}'
  );
  await fs.writeFile(path.join(baseDir, 'quota-usage.json'), '{"v":2,"data":{"count":1}}');
  // Old enough that a rewrite would show in the modification time.
  for (const file of await filesUnder(baseDir)) await fs.utimes(file, OLD, OLD);
  return etags;
}

/** sha256 of every file under a directory, by relative path. */
async function fingerprint(dir) {
  const result = {};
  for (const file of await filesUnder(dir)) {
    if (
      file.includes(`${path.sep}.locks${path.sep}`) ||
      file.includes(`${path.sep}locks${path.sep}`)
    )
      continue;
    result[path.relative(dir, file)] = crypto
      .createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
  }
  return result;
}

/** Read every seeded object through a started provider and compare. */
async function assertAllReadable(provider, etags) {
  for (const [id, etag] of Object.entries(etags)) {
    const [ns, key] = id.split('/');
    const document = await provider.documents.get(ns, key);
    assert.equal(document?.etag, etag, `etag of ${id}`);
  }
  for (const run of ['run-a', 'run-b']) {
    const records = await provider.logs.read(`run:${run}`);
    assert.deepEqual(
      records.map(record => record.seq),
      [1, 2, 3, 4, 5],
      run
    );
    assert.equal(records[0].data.content, `${MARKER} 1`);
    assert.equal(
      (await provider.logs.getBlob(`run:${run}`, 'tool-1.json')).toString(),
      `${MARKER} spilled`
    );
  }
  assert.equal(
    (await provider.blobs.get('artifacts', 'chat__a__art')).data.toString(),
    `${MARKER} artifact`
  );
}

afterEach(async () => {
  endAtRestPreparation();
  await shutdownStorageBootstrap();
  await storage.shutdownStorage();
});

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('storage encryption: conversion of an existing installation', () => {
  it('dry run: counts what is plaintext, checks the preconditions and changes nothing', async () => {
    const site = installation();
    await seedPlaintext(site);
    const before = await fingerprint(site.baseDir);

    const result = await site.prepare(true, { dryRun: true });
    assert.equal(result.action, 'dry-run');
    const { report } = result;
    assert.deepEqual(
      [report.documents.plaintext, report.documents.sealed, report.documents.unreadable],
      [38, 0, 1]
    );
    assert.deepEqual([report.streams.plaintext, report.records, report.tornLines], [2, 10, 1]);
    assert.equal(report.spillBlobs.plaintext, 2);
    assert.equal(report.blobs.plaintext, 2);
    assert.ok(report.documents.plaintextBytes > 0 && report.documents.largestBytes > 0);
    assert.ok(result.estimateSeconds >= 1);
    assert.ok(result.neededBytes > 0);
    assert.deepEqual(report.unreadable, ['document chats/torn']);

    assert.deepEqual(await fingerprint(site.baseDir), before, 'no file was changed or added');
    assert.equal(await readAtRestState(site.baseDir), null);
    assert.equal(fsSync.existsSync(path.join(site.baseDir, 'blobs', '_ihub', 'keycheck')), false);
  });

  it('a start that did not convert is refused; a start with the switch off is not', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 2 });
    await assert.rejects(site.start(true), { code: 'ENCRYPTION_NOT_CONVERTED' });
    await assert.rejects(bootstrapStorage(site.platformConfig(true)), {
      code: 'STORAGE_BOOTSTRAP_FAILED',
      message: /npm run storage:encrypt/
    });
    const provider = await site.start(false);
    assert.equal(provider.getCapabilities().encryptionAtRest, 'off');
  });

  it('converts everything, keeps etags and modification times, and records it', async () => {
    const site = installation();
    const etags = await seedPlaintext(site);
    const foreign = await fingerprint(path.join(site.baseDir, 'integrations'));
    const quota = await fs.readFile(path.join(site.baseDir, 'quota-usage.json'), 'utf8');

    const result = await site.prepare(true);
    assert.equal(result.action, 'converted');
    const state = await readAtRestState(site.baseDir);
    assert.equal(state.state, 'complete');
    assert.deepEqual(state.facets, { blobs: 1, documents: 1, logs: 1, files: 1 });
    assert.deepEqual(state.converted, {
      documents: 38,
      streams: 2,
      spillBlobs: 2,
      blobs: 2,
      files: 0
    });
    assert.equal(state.skipped, 1, 'the unreadable document is counted, not converted');
    assert.equal(state.keyId.length, 8);

    // Nothing of the content is left on disk, except in what was unreadable before.
    const readable = await findReadable(site.baseDir, [MARKER]);
    assert.deepEqual(
      readable.map(hit => path.relative(site.baseDir, hit.file)),
      []
    );
    assert.equal(
      await fs.readFile(path.join(site.baseDir, 'chats', 'torn.json'), 'utf8'),
      '{"v":2,"key":"torn","data":{"title":"cut off'
    );
    // Files of other subsystems are untouched.
    assert.deepEqual(await fingerprint(path.join(site.baseDir, 'integrations')), foreign);
    assert.equal(await fs.readFile(path.join(site.baseDir, 'quota-usage.json'), 'utf8'), quota);
    // Retention judges streams, spill blobs and blobs by their age.
    for (const file of [
      'logs/run/run-a.jsonl',
      'logs/run/run-a.blobs/tool-1.json',
      'blobs/chat-files/chat__a__file.txt'
    ]) {
      assert.equal((await fs.stat(path.join(site.baseDir, file))).mtimeMs, OLD.getTime(), file);
    }

    const provider = await site.start(true);
    assert.equal(provider.getCapabilities().encryptionAtRest, 'enforced');
    assert.equal(provider.blobs.acceptsPlaintext, false);
    etags['chats/legacy'] = (await provider.documents.get('chats', 'legacy')).etag;
    await assertAllReadable(provider, etags);
    assert.deepEqual((await provider.documents.get('chats', 'legacy')).data, {
      title: `${MARKER} legacy`
    });
    await assert.rejects(provider.documents.get('chats', 'torn'), { code: 'CORRUPT_DOCUMENT' });
    const chats = await provider.documents.list('chats');
    assert.deepEqual([chats.items.length, chats.skipped], [13, 1]);
    assert.equal((await provider.documents.list('chats', { ownerId: ANNA })).items.length, 12);
  });

  it('a second run changes nothing', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 3 });
    await site.prepare(true);
    const before = await fingerprint(site.baseDir);
    const again = await site.prepare(true);
    assert.equal(again.action, 'verified');
    assert.deepEqual(await fingerprint(site.baseDir), before);
    // Also when the engine is made to walk everything again.
    await fs.writeFile(
      atRestStatePath(site.baseDir),
      JSON.stringify({ ...(await readAtRestState(site.baseDir)), state: 'converting', facets: {} })
    );
    const walked = await site.prepare(true);
    assert.equal(walked.action, 'converted');
    assert.deepEqual(walked.state.converted, {
      documents: 0,
      streams: 0,
      spillBlobs: 0,
      blobs: 0,
      files: 0
    });
    const after = await fingerprint(site.baseDir);
    delete before['.at-rest.json'];
    delete after['.at-rest.json'];
    assert.deepEqual(after, before, 'no sealed object was sealed again');
  });

  it('interrupted at any point and resumed: complete, everything readable, etags unchanged', async () => {
    // 44 objects are dealt with in all. Stop after a number of them, once
    // cleanly (the signal) and once the way a failing disk or a kill does
    // (an error out of the middle of the walk), then start again.
    const points = [0, 1, 2, 3, 5, 8, 13, 21, 27, 30, 34, 38, 39, 40, 41, 42, 43];
    for (const [round, stopAfter] of [...points, ...points.slice(1, 4)].entries()) {
      const site = installation();
      const etags = await seedPlaintext(site);
      const interrupt = new AbortController();
      const crash = round % 2 === 1;
      let seen = 0;
      if (stopAfter === 0) interrupt.abort();
      const first = await site
        .prepare(true, {
          signal: interrupt.signal,
          onObject: () => {
            seen += 1;
            if (seen !== stopAfter) return;
            if (crash) throw new Error('simulated crash');
            interrupt.abort();
          }
        })
        .catch(error => error);
      if (crash) assert.equal(first.message, 'simulated crash');
      else assert.equal(first.action, 'aborted', `stopped after ${stopAfter}`);
      const state = await readAtRestState(site.baseDir);
      assert.equal(state.state, 'converting', `after ${stopAfter} objects`);

      // Mixed state: a normal start is refused, the preparing process reads everything.
      await assert.rejects(site.start(true), { code: 'ENCRYPTION_NOT_CONVERTED' });
      beginAtRestPreparation();
      const mixed = await site.start(true);
      assert.equal(mixed.getCapabilities().encryptionAtRest, 'converting');
      await assertAllReadable(mixed, etags);
      await storage.shutdownStorage();
      endAtRestPreparation();

      const resumed = await site.prepare(true);
      assert.equal(resumed.action, 'converted');
      const done = await readAtRestState(site.baseDir);
      assert.equal(done.state, 'complete');
      assert.equal(done.startedAt, state.startedAt, 'the resumed run continues the first one');
      assert.deepEqual(await findReadable(site.baseDir, [MARKER]), []);
      const provider = await site.start(true);
      await assertAllReadable(provider, etags);
      await storage.shutdownStorage();
      await fs.rm(site.baseDir, { recursive: true, force: true });
    }
  });

  it('cleans up what a killed conversion left half-written', async () => {
    const site = installation();
    const etags = await seedPlaintext(site, { documents: 2 });
    // A scratch file of a stream rewrite and of an atomic document write.
    await fs.writeFile(
      path.join(site.baseDir, 'logs', 'run', 'run-a.jsonl.sealing'),
      '{"$key":1,"id":"half'
    );
    await fs.writeFile(
      path.join(site.baseDir, 'chats', '.tmp_half'),
      '{"v":3,"key":"scope__0","da'
    );
    const result = await site.prepare(true);
    assert.equal(result.action, 'converted');
    assert.equal(
      fsSync.existsSync(path.join(site.baseDir, 'logs', 'run', 'run-a.jsonl.sealing')),
      false
    );
    const provider = await site.start(true);
    await assertAllReadable(provider, etags);
    assert.equal((await provider.documents.list('chats')).items.length, 3);
  });
});

describe('storage encryption: the switch', () => {
  it('a new installation is recorded complete without a conversion, by the start-up step or the first start', async () => {
    const prepared = installation();
    assert.equal((await prepared.prepare(true)).action, 'converted');
    assert.equal((await readAtRestState(prepared.baseDir)).state, 'complete');

    const direct = installation();
    const provider = await direct.start(true);
    assert.equal(provider.getCapabilities().encryptionAtRest, 'enforced');
    assert.equal((await readAtRestState(direct.baseDir)).state, 'complete');
    await provider.documents.put('chats', 'c1', { title: MARKER }, { ownerId: ANNA });
    await provider.logs.append('run:r1', { type: 'x', data: MARKER }, 1);
    await provider.logs.flush();
    await provider.blobs.put('chat-files', 'chat__a__f', MARKER);
    assert.deepEqual(await findReadable(direct.baseDir, [MARKER]), []);
  });

  it('with the switch off nothing is converted and no state record is written', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 1 });
    const before = await fingerprint(site.baseDir);
    assert.equal((await site.prepare(false)).action, 'none');
    assert.deepEqual(await fingerprint(site.baseDir), before);
    assert.deepEqual(describeStorageEncryption(), {
      enabled: false,
      scope: 'none',
      conversion: { state: 'none', facets: {}, keyId: null, skipped: 0, completedAt: null },
      sealedDataExists: false
    });
  });

  it('off after on: plaintext is written, sealed data is still read; on again converts what was written meanwhile', async () => {
    const site = installation();
    const etags = await seedPlaintext(site, { documents: 2 });
    await site.prepare(true);

    // Off: the record says so before anything is written, and keeps the key id.
    assert.equal((await site.prepare(false)).action, 'disabled');
    const off = await readAtRestState(site.baseDir);
    assert.deepEqual([off.state, off.facets], ['off', {}]);
    assert.equal(off.keyId.length, 8);
    let provider = await bootstrapStorage(site.platformConfig(false));
    assert.deepEqual(
      [
        describeStorageEncryption().enabled,
        describeStorageEncryption().scope,
        describeStorageEncryption().sealedDataExists
      ],
      [false, 'none', true]
    );
    await assertAllReadable(provider, etags);
    const written = await provider.documents.put(
      'chats',
      'while-off',
      { title: `${MARKER} off` },
      { ownerId: ANNA }
    );
    await provider.logs.append('run:run-a', { type: 'x', data: `${MARKER} off` }, 6);
    await provider.logs.flush();
    await provider.blobs.put('chat-files', 'chat__a__off.txt', `${MARKER} off`);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(site.baseDir, 'chats', 'while-off.json'), 'utf8')).v,
      2
    );
    assert.equal((await findReadable(site.baseDir, [MARKER])).length > 0, true);
    await shutdownStorageBootstrap();

    // A worker that is started with the switch on now does not serve the mix.
    await assert.rejects(site.start(true), { code: 'ENCRYPTION_NOT_CONVERTED' });
    const again = await site.prepare(true);
    assert.equal(again.action, 'converted');
    assert.deepEqual(again.state.converted, {
      documents: 1,
      streams: 1,
      spillBlobs: 0,
      blobs: 1,
      files: 0
    });
    provider = await bootstrapStorage(site.platformConfig(true));
    const described = describeStorageEncryption();
    assert.deepEqual(
      [described.enabled, described.scope, described.conversion.state],
      [true, 'storage', 'complete']
    );
    assert.deepEqual(described.conversion.facets, { blobs: 1, documents: 1, logs: 1, files: 1 });
    // The public health output names the blob store and nothing about encryption.
    assert.deepEqual(describeBlobStorage(), { provider: 'default', status: 'ok' });
    assert.equal((await provider.documents.get('chats', 'while-off')).etag, written.etag);
    assert.equal((await provider.logs.read('run:run-a')).length, 6);
    assert.deepEqual(await findReadable(site.baseDir, [MARKER]), []);
  });

  it('a start with the switch off sets a stale record to "off" itself', async () => {
    const site = installation();
    await site.prepare(true);
    const provider = await site.start(false);
    assert.equal(provider.getCapabilities().encryptionAtRest, 'off');
    assert.equal((await readAtRestState(site.baseDir)).state, 'off');
  });

  it('an unreadable state record stops the start instead of reading as "never encrypted"', async () => {
    const site = installation();
    await site.prepare(true);
    await fs.writeFile(atRestStatePath(site.baseDir), '{"format":1,"state":"comp');
    await assert.rejects(site.start(true), { code: 'INVALID_AT_REST_STATE' });
    await assert.rejects(site.start(false), { code: 'INVALID_AT_REST_STATE' });
    await assert.rejects(site.prepare(true), { code: 'INVALID_AT_REST_STATE' });
  });
});

describe('storage encryption: the master key', () => {
  /** Run `fn` with the key service holding another key, or none. */
  async function withKey(key, fn, source = 'file') {
    const saved = [tokenStorageService.encryptionKey, tokenStorageService.keySource];
    tokenStorageService.encryptionKey = key;
    tokenStorageService.keySource = source;
    try {
      return await fn();
    } finally {
      [tokenStorageService.encryptionKey, tokenStorageService.keySource] = saved;
    }
  }

  it('another master key: nothing is converted and no start is possible', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 1 });
    await site.prepare(true);
    await shutdownStorageBootstrap();
    await fs.writeFile(
      path.join(site.baseDir, 'chats', 'planted.json'),
      '{"v":2,"key":"planted","etag":"x","size":1,"data":1}'
    );
    const before = await fingerprint(site.baseDir);
    await withKey('c3'.repeat(32), async () => {
      await assert.rejects(site.prepare(true), { code: 'KEY_UNAVAILABLE' });
      await assert.rejects(site.start(true), { code: 'KEY_UNAVAILABLE' });
      await assert.rejects(site.prepare(true, { dryRun: true }), { code: 'KEY_UNAVAILABLE' });
    });
    assert.deepEqual(await fingerprint(site.baseDir), before);
  });

  it('a key that would not survive a restart is refused before anything is sealed', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 1 });
    const before = await fingerprint(site.baseDir);
    await withKey(
      'd4'.repeat(32),
      () => assert.rejects(site.prepare(true), { code: 'KEY_UNAVAILABLE' }),
      'generated-unpersisted'
    );
    assert.deepEqual(await fingerprint(site.baseDir), before);
    assert.equal(await readAtRestState(site.baseDir), null);
  });

  it('a removed key check object stops the start, unless the data is adopted for one start', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 1 });
    await site.prepare(true);
    await fs.rm(path.join(site.baseDir, 'blobs', '_ihub', 'keycheck'));
    await assert.rejects(site.prepare(true), { code: 'KEY_CHECK_MISSING' });
    const adopted = await prepareStorageEncryption({
      env: { IHUB_S3_ADOPT_BUCKET: 'true' },
      platformConfig: site.platformConfig(true)
    });
    assert.equal(adopted.action, 'verified');
    assert.equal((await site.prepare(true)).action, 'verified');
  });

  it('missing or unreadable key file with sealed data: no new key is generated', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 1 });
    await site.prepare(true);
    const keyFile = path.join(scratch, 'keys', '.encryption-key');
    await fs.mkdir(path.dirname(keyFile), { recursive: true });
    const saved = [tokenStorageService.keyFilePath, tokenStorageService.sealedDataLocations];
    tokenStorageService.keyFilePath = keyFile;
    tokenStorageService.sealedDataLocations = new Set();
    tokenStorageService.addSealedDataLocation(site.baseDir);
    try {
      await withKey(null, async () => {
        await assert.rejects(tokenStorageService.initializeEncryptionKey(), {
          code: 'MASTER_KEY_REQUIRED',
          message: /No new key is generated/
        });
        assert.equal(tokenStorageService.encryptionKey, null);
        assert.equal(fsSync.existsSync(keyFile), false, 'no key file was created');

        await fs.writeFile(keyFile, 'not a key');
        await assert.rejects(tokenStorageService.initializeEncryptionKey(), {
          code: 'MASTER_KEY_REQUIRED'
        });
        assert.equal(await fs.readFile(keyFile, 'utf8'), 'not a key', 'the file was not replaced');

        // Also after the switch was turned off again: the sealed data is still there.
        await site.prepare(false);
        await assert.rejects(tokenStorageService.initializeEncryptionKey(), {
          code: 'MASTER_KEY_REQUIRED'
        });

        // The right key, with a final newline, is read.
        await fs.writeFile(keyFile, `${'e5'.repeat(32)}\n`);
        await tokenStorageService.initializeEncryptionKey();
        assert.equal(tokenStorageService.encryptionKey, 'e5'.repeat(32));

        // A data directory that never held encrypted data: a key is generated as before.
        await fs.rm(keyFile);
        tokenStorageService.encryptionKey = null;
        tokenStorageService.sealedDataLocations = new Set([installation().baseDir]);
        await tokenStorageService.initializeEncryptionKey();
        assert.match(tokenStorageService.encryptionKey, /^[0-9a-f]{64}$/);
        assert.equal(fsSync.existsSync(keyFile), true);
      });
    } finally {
      [tokenStorageService.keyFilePath, tokenStorageService.sealedDataLocations] = saved;
    }
  });
});

describe('storage encryption: commands', () => {
  const run = async (command, argv, io) => {
    let output = '';
    const code = await command(argv, { out: text => (output += text.toString()), env: {}, ...io });
    return { code, output };
  };

  it('storage:encrypt --dry-run reports and changes nothing; without it, it converts once', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 2 });
    const before = await fingerprint(site.baseDir);
    const platformConfig = site.platformConfig(false);

    const dry = await run(encryptCommand, ['--dry-run'], { platformConfig });
    assert.equal(dry.code, 0);
    assert.match(dry.output, /documents\s+8 of 9/);
    assert.match(dry.output, /log streams\s+2 of 2 \(10 records/);
    assert.match(dry.output, /Dry run: nothing was changed/);
    assert.deepEqual(await fingerprint(site.baseDir), before);

    const real = await run(encryptCommand, [], { platformConfig });
    assert.equal(real.code, 0);
    assert.match(real.output, /documents\s+8\n/);
    assert.match(real.output, /Set storage\.encryption\.enabled to true/);
    assert.deepEqual(await findReadable(site.baseDir, [MARKER]), []);

    const second = await run(encryptCommand, ['--json'], {
      platformConfig: site.platformConfig(true)
    });
    assert.equal(JSON.parse(second.output).action, 'verified');
    assert.equal((await run(encryptCommand, ['--nonsense'], { platformConfig })).code, 2);
  });

  it('storage:show prints a document, a stream and a spill blob decrypted', async () => {
    const site = installation();
    await seedPlaintext(site, { documents: 1 });
    await site.prepare(true);
    const platformConfig = site.platformConfig(true);

    const doc = await run(showCommand, ['--doc', 'chats', 'scope__0'], { platformConfig });
    assert.equal(doc.code, 0);
    assert.equal(JSON.parse(doc.output).data.title, `${MARKER} chats 0`);
    assert.equal(JSON.parse(doc.output).ownerId, ANNA);

    const stream = await run(showCommand, ['--stream', 'run:run-a'], { platformConfig });
    assert.deepEqual(
      stream.output
        .trim()
        .split('\n')
        .map(line => JSON.parse(line).seq),
      [1, 2, 3, 4, 5]
    );
    const blob = await run(showCommand, ['--blob', 'run:run-a', 'tool-1.json'], { platformConfig });
    assert.equal(blob.output, `${MARKER} spilled`);

    assert.equal(
      (await run(showCommand, ['--doc', 'chats', 'missing'], { platformConfig })).code,
      1
    );
    assert.equal((await run(showCommand, ['--doc', 'chats'], { platformConfig })).code, 2);
    assert.equal((await run(showCommand, [], { platformConfig })).code, 2);
    // It only reads: nothing on disk changed, not even with the switch off.
    const before = await fingerprint(site.baseDir);
    await run(showCommand, ['--doc', 'chats', 'scope__0'], {
      platformConfig: site.platformConfig(false)
    });
    assert.deepEqual(await fingerprint(site.baseDir), before);
  });
});
