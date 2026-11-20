// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:check` and `npm run storage:copy-blobs`
 * (server/storage/commands/) against the in-repo fake S3 server.
 *
 * The check: named steps, the codes of the start-up classifier, exit code 0
 * or 1, nothing lasting written. The copy: a dry run writes nothing, a run
 * copies and verifies, a second run copies nothing, no source file is ever
 * deleted or changed, no object in the bucket is overwritten, and the key
 * check object is written by the first writer into an empty prefix.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-storage-commands-'));
const MASTER_KEY = 'c3'.repeat(32);
const OTHER_MASTER_KEY = 'd4'.repeat(32);
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
process.env.TOKEN_ENCRYPTION_KEY = MASTER_KEY;
fsSync.mkdirSync(path.join(scratch, 'contents', 'config'), { recursive: true });

const keyModule = await import('../crypto/KeyProvider.js');
const { EncryptingBlobStore } = await import('../storage/EncryptingBlobStore.js');
const { createBlobBackend, resolveBlobStorageConfig } = await import('../storage/index.js');
const { FilesystemBlobStore } =
  await import('../storage/providers/filesystem/FilesystemBlobStore.js');
const {
  formatCopyBlobs,
  main: copyMain,
  runCopyBlobs
} = await import('../storage/commands/copyBlobs.js');
const {
  formatStorageCheck,
  main: checkMain,
  runStorageCheck
} = await import('../storage/commands/storageCheck.js');
const { startFakeS3Server } = await import('./support/fakeS3Server.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCESS_KEY_ID = 'AKIDSTORAGECOMMANDS';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI-K7MDENG-commandTestSecret';
const BUCKET = 'ihub-test';

let s3;
let caseNumber = 0;

before(async () => {
  s3 = await startFakeS3Server({ buckets: [BUCKET], accessKeyId: ACCESS_KEY_ID });
  await keyModule.ensureMasterKey();
});

after(async () => {
  await s3.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

/**
 * A configuration with its own data directory and its own prefix in the
 * bucket, so the cases do not see each other's blobs.
 */
function installation({ s3: s3Overrides = {}, encryption = true, blobsProvider = 's3' } = {}) {
  caseNumber += 1;
  const prefix = `case${caseNumber}`;
  const baseDir = path.join(scratch, prefix, 'data');
  const platformConfig = {
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir },
      encryption: { enabled: encryption },
      blobs: {
        provider: blobsProvider,
        s3: {
          endpoint: s3.endpoint,
          bucket: BUCKET,
          prefix,
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          maxAttempts: 1,
          ...s3Overrides
        }
      }
    }
  };
  return {
    platformConfig,
    prefix,
    baseDir,
    local: new FilesystemBlobStore(baseDir),
    /** Object names below this installation's prefix, as the bucket holds them. */
    objects: () => s3.rawObjects(BUCKET, `${prefix}/`).map(object => object.key),
    raw: name => s3.rawGet(BUCKET, `${prefix}/default/${name}`)
  };
}

/** Every file below a directory with the hash of its bytes. */
async function snapshot(dir) {
  const files = {};
  const walk = async current => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files[path.relative(dir, full)] = crypto
          .createHash('sha256')
          .update(await fs.readFile(full))
          .digest('hex');
      }
    }
  };
  await walk(dir);
  return files;
}

/** Read a blob the way the server would after the switch. */
async function readThroughServerPath(platformConfig, ns, key) {
  const blobs = resolveBlobStorageConfig(platformConfig, {});
  const backend = createBlobBackend(blobs.provider, blobs.config, {
    platformConfig: blobs.platformConfig,
    locks: null,
    encryption: blobs.encryption,
    loadKeys: async () => keyModule,
    env: {}
  });
  try {
    await backend.initialize();
    return (await backend.blobs.get(ns, key))?.data ?? null;
  } finally {
    await backend.shutdown();
  }
}

/** Requests of one kind the fake server saw for objects below a prefix. */
const requestsFor = (prefix, op) =>
  s3.requests.filter(
    request => request.op === op && String(request.key || '').startsWith(`${prefix}/default/`)
  );

/** Put three plaintext blobs in two namespaces on local disk. */
async function seedLocal(local) {
  await local.put('chat-files', 'chat__a__f1.txt', 'the first file');
  await local.put('chat-files', 'chat__a__f1.bin', crypto.randomBytes(3000));
  await local.put('artifacts', 'chat__a__art1', 'an artifact payload');
}

/** Run a command in its own process, as `npm run` does. */
function runCli(script, args, { platformConfig, env = {} }) {
  const contents = path.join(scratch, `cli-${crypto.randomUUID()}`);
  fsSync.mkdirSync(path.join(contents, 'config'), { recursive: true });
  fsSync.writeFileSync(
    path.join(contents, 'config', 'platform.json'),
    JSON.stringify(platformConfig)
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CONTENTS_DIR: contents,
        TOKEN_ENCRYPTION_KEY: MASTER_KEY,
        ...env
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('storage:check', () => {
  it('passes every named step on a usable bucket and writes nothing lasting', async () => {
    const setup = installation();
    const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });

    assert.equal(report.status, 'ok');
    assert.equal(report.provider, 's3');
    assert.equal(report.storageProvider, 'filesystem');
    assert.equal(report.source, 'platform.json');
    assert.deepEqual(report.encryption, { enabled: true });
    assert.deepEqual(
      report.steps.map(step => [step.name, step.status]),
      [
        ['config', 'ok'],
        ['key', 'ok'],
        ['connect', 'ok'],
        ['keycheck', 'ok'],
        ['roundtrip', 'ok'],
        ['leftovers', 'ok']
      ]
    );
    assert.ok(report.steps.every(step => typeof step.label === 'string' && step.label));
    assert.equal(report.error, null);
    assert.deepEqual(setup.objects(), [], 'no key check object and no test object is left');

    const text = formatStorageCheck(report);
    assert.match(text, /\[ok\] {4}1\/6 Configuration complete/);
    assert.match(text, /6\/6 No blobs left on local disk/);
    assert.match(text, /Result: usable\./);
    assert.equal(text.includes(SECRET_ACCESS_KEY), false);
    assert.equal(text.includes(ACCESS_KEY_ID), false);
  });

  it('names the setting that is missing', async () => {
    const setup = installation({ s3: { bucket: undefined } });
    const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'error');
    assert.equal(report.error.code, 'S3_CONFIG_INCOMPLETE');
    assert.equal(report.error.step, 'config');
    assert.match(report.error.detail, /storage\.blobs\.s3\.bucket/);
    assert.equal(report.steps[0].status, 'failed');
    const text = formatStorageCheck(report);
    assert.match(text, /\[FAIL\] {2}1\/\d Configuration complete/);
    assert.match(text, /S3_CONFIG_INCOMPLETE: storage\.blobs\.s3\.bucket is missing/);
    assert.match(text, /Result: not usable \(S3_CONFIG_INCOMPLETE\)/);
  });

  it('reports a bucket that does not exist and skips the steps after it', async () => {
    const setup = installation({ s3: { bucket: 'no-such-bucket' } });
    const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'error');
    assert.equal(report.error.code, 'S3_BUCKET_NOT_FOUND');
    assert.equal(report.error.step, 'connect');
    assert.match(report.error.hint, /does not create buckets/);
    assert.deepEqual(
      report.steps.map(step => [step.name, step.status]),
      [
        ['config', 'ok'],
        ['key', 'ok'],
        ['connect', 'failed'],
        ['keycheck', 'skipped'],
        ['roundtrip', 'skipped'],
        ['leftovers', 'skipped']
      ]
    );
  });

  it('reports an endpoint that cannot be reached', async () => {
    const closed = await startFakeS3Server({ buckets: [BUCKET], accessKeyId: ACCESS_KEY_ID });
    const endpoint = closed.endpoint;
    await closed.close();
    const setup = installation({ s3: { endpoint, connectTimeoutMs: 500 } });
    const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'error');
    assert.equal(report.error.code, 'S3_ENDPOINT_UNREACHABLE');
    assert.equal(report.error.step, 'connect');
  });

  it('reports a write the access key may not do', async () => {
    const setup = installation();
    const stop = s3.inject({ op: 'PutObject', status: 403, code: 'AccessDenied' });
    try {
      const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });
      assert.equal(report.status, 'error');
      assert.equal(report.error.code, 'S3_ACCESS_DENIED');
      assert.equal(report.error.step, 'roundtrip');
    } finally {
      if (typeof stop === 'function') stop();
      s3.clearInjections();
    }
  });

  it('warns about blobs on local disk, with counts, and still passes', async () => {
    const setup = installation();
    await seedLocal(setup.local);
    const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'ok');
    assert.deepEqual(
      [...report.localLeftovers].sort((a, b) => a.namespace.localeCompare(b.namespace)),
      [
        { namespace: 'artifacts', count: 1, capped: false },
        { namespace: 'chat-files', count: 2, capped: false }
      ]
    );
    const step = report.steps.at(-1);
    assert.equal(step.status, 'warning');
    assert.equal(step.code, 'BLOB_LOCAL_LEFTOVERS');
    assert.match(step.detail, /chat-files: 2/);
    assert.match(step.hint, /npm run storage:copy-blobs/);
    const text = formatStorageCheck(report);
    assert.match(text, /\[warn\] {2}6\/6/);
    assert.match(text, /Result: usable, 1 warning\./);
  });

  it('warns that an S3 backend without encryption stores readable files', async () => {
    const setup = installation({ encryption: false });
    const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.encryption, { enabled: false });
    assert.deepEqual(
      report.steps.map(step => step.name),
      ['config', 'connect', 'detect', 'roundtrip', 'leftovers']
    );
    assert.ok(report.warnings.some(warning => /Encryption is off/.test(warning)));
  });

  it('has nothing to contact when the blobs stay with the storage provider', async () => {
    const setup = installation({ blobsProvider: 'default' });
    const before = s3.requests.length;
    const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'ok');
    assert.equal(report.provider, 'default');
    assert.deepEqual(
      report.steps.map(step => [step.name, step.status]),
      [
        ['config', 'ok'],
        ['key', 'ok']
      ]
    );
    assert.equal(s3.requests.length, before);
    assert.match(formatStorageCheck(report), /kept by the "filesystem" storage provider/);
  });

  it('rejects an unknown backend and an unknown argument', async () => {
    const setup = installation({ blobsProvider: 'azure' });
    const report = await runStorageCheck({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'error');
    assert.equal(report.error.code, 'BLOB_PROVIDER_UNKNOWN');

    let printed = '';
    assert.equal(await checkMain(['--delete'], { out: text => (printed += text) }), 2);
    assert.match(printed, /Unknown argument: --delete/);
  });

  it('exits 0 or 1 as a command, prints JSON on request and no credential', async () => {
    const usable = installation();
    const passed = await runCli('storage-check.js', [], { platformConfig: usable.platformConfig });
    assert.equal(passed.code, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /Blob storage check/);
    assert.match(passed.stdout, /Result: usable/);
    assert.equal(passed.stdout.includes('"level"'), false, 'no server log line in the output');

    const asJson = await runCli('storage-check.js', ['--json'], {
      platformConfig: usable.platformConfig
    });
    assert.equal(asJson.code, 0);
    assert.equal(JSON.parse(asJson.stdout).status, 'ok');

    const broken = installation({ s3: { bucket: 'no-such-bucket' } });
    const failed = await runCli('storage-check.js', [], { platformConfig: broken.platformConfig });
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /S3_BUCKET_NOT_FOUND/);
    assert.match(failed.stdout, /Result: not usable/);

    for (const output of [passed, asJson, failed]) {
      assert.equal((output.stdout + output.stderr).includes(SECRET_ACCESS_KEY), false);
    }
  });

  it('refuses a bucket that was written with another master key', async () => {
    const setup = installation();
    await seedLocal(setup.local);
    const copied = await runCli('storage-copy-blobs.js', [], {
      platformConfig: setup.platformConfig
    });
    assert.equal(copied.code, 0, copied.stdout + copied.stderr);

    const checked = await runCli('storage-check.js', ['--json'], {
      platformConfig: setup.platformConfig,
      env: { TOKEN_ENCRYPTION_KEY: OTHER_MASTER_KEY }
    });
    assert.equal(checked.code, 1);
    const report = JSON.parse(checked.stdout);
    assert.equal(report.error.code, 'BLOB_KEY_MISMATCH');
    assert.equal(report.error.step, 'keycheck');

    // And the copy refuses to add blobs under a second key.
    const second = await runCli('storage-copy-blobs.js', ['--json'], {
      platformConfig: setup.platformConfig,
      env: { TOKEN_ENCRYPTION_KEY: OTHER_MASTER_KEY }
    });
    assert.equal(second.code, 1);
    assert.equal(JSON.parse(second.stdout).error.code, 'BLOB_KEY_MISMATCH');
  });
});

describe('storage:copy-blobs', () => {
  it('reports per namespace in a dry run and writes nothing', async () => {
    const setup = installation();
    await seedLocal(setup.local);
    const before = await snapshot(setup.baseDir);

    const report = await runCopyBlobs({
      platformConfig: setup.platformConfig,
      env: {},
      dryRun: true
    });
    assert.equal(report.status, 'ok');
    assert.equal(report.dryRun, true);
    assert.equal(report.error, null);
    assert.deepEqual(report.namespaces['chat-files'], {
      scanned: 2,
      copied: 2,
      alreadyPresent: 0,
      conflicts: 0,
      failed: 0,
      bytes: 'the first file'.length + 3000
    });
    assert.equal(report.namespaces.artifacts.copied, 1);
    assert.equal(report.namespaces['project-files'].scanned, 0);
    assert.equal(report.totals.copied, 3);
    assert.deepEqual(setup.objects(), [], 'nothing in the bucket, not even the key check object');
    assert.deepEqual(await snapshot(setup.baseDir), before);
    assert.match(formatCopyBlobs(report), /3 blob\(s\) .* would be copied/);
  });

  it('copies, encrypts, verifies and writes the key check object into an empty prefix', async () => {
    const setup = installation();
    await seedLocal(setup.local);
    const before = await snapshot(setup.baseDir);

    const report = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'ok');
    assert.equal(report.totals.scanned, 3);
    assert.equal(report.totals.copied, 3);
    assert.equal(report.totals.failed, 0);
    assert.deepEqual(setup.objects(), [
      `${setup.prefix}/default/_ihub/keycheck`,
      `${setup.prefix}/default/artifacts/chat__a__art1`,
      `${setup.prefix}/default/chat-files/chat__a__f1.bin`,
      `${setup.prefix}/default/chat-files/chat__a__f1.txt`
    ]);
    // What is in the bucket is not the content …
    assert.equal(setup.raw('chat-files/chat__a__f1.txt').includes('the first file'), false);
    // … and the server reads the content back.
    assert.equal(
      (
        await readThroughServerPath(setup.platformConfig, 'chat-files', 'chat__a__f1.txt')
      ).toString(),
      'the first file'
    );
    assert.equal(
      (await readThroughServerPath(setup.platformConfig, 'artifacts', 'chat__a__art1')).toString(),
      'an artifact payload'
    );
    // Every copy was read back, and nothing was deleted on either side.
    assert.equal(requestsFor(setup.prefix, 'GetObject').length >= 3, true);
    assert.deepEqual(
      requestsFor(setup.prefix, 'DeleteObject').filter(request => !request.key.includes('/_ihub/')),
      []
    );
    assert.deepEqual(await snapshot(setup.baseDir), before, 'the source files are untouched');
    const text = formatCopyBlobs(report);
    assert.match(text, /Result: complete\. 3 copied, 0 already present\./);
    assert.match(text, /remove contents\/data\/blobs yourself/);
    assert.match(text, /Run this while the server is stopped/);
    assert.equal(text.includes(SECRET_ACCESS_KEY), false);
  });

  it('is idempotent: a second run copies nothing and overwrites nothing', async () => {
    const setup = installation();
    await seedLocal(setup.local);
    await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    const stored = setup.objects().map(name => [name, s3.rawGet(BUCKET, name)]);
    const puts = requestsFor(setup.prefix, 'PutObject').filter(
      request => !request.key.includes('/_ihub/')
    ).length;
    const before = await snapshot(setup.baseDir);

    const again = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(again.status, 'ok');
    assert.equal(again.totals.copied, 0);
    assert.equal(again.totals.alreadyPresent, 3);
    assert.equal(again.totals.bytes, 0);
    assert.equal(
      requestsFor(setup.prefix, 'PutObject').filter(request => !request.key.includes('/_ihub/'))
        .length,
      puts,
      'no blob is uploaded twice'
    );
    for (const [name, bytes] of stored) {
      assert.ok(s3.rawGet(BUCKET, name).equals(bytes), `${name} is unchanged`);
    }
    assert.deepEqual(await snapshot(setup.baseDir), before);

    // A blob added later is the only one the next run copies.
    await setup.local.put('chat-files', 'chat__b__f2.txt', 'a later file');
    const third = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(third.totals.copied, 1);
    assert.equal(third.totals.alreadyPresent, 3);
  });

  it('copies a local blob that is already encrypted, and one that is not', async () => {
    const setup = installation();
    const sealing = new EncryptingBlobStore({
      inner: setup.local,
      keyProvider: () => keyModule.getKeyProvider(),
      maxBlobBytes: 1024 * 1024
    });
    await sealing.put('chat-files', 'chat__a__sealed.txt', 'sealed on local disk');
    await setup.local.put('chat-files', 'chat__a__plain.txt', 'plain on local disk');
    const onDisk = await fs.readFile(
      path.join(setup.baseDir, 'blobs', 'chat-files', 'chat__a__sealed.txt')
    );
    assert.equal(onDisk.includes('sealed on local disk'), false, 'the local blob is an envelope');

    const report = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'ok');
    assert.equal(report.totals.copied, 2);
    assert.equal(report.namespaces['chat-files'].bytes, 'sealed on local disk'.length * 2 - 1);
    for (const [key, content] of [
      ['chat__a__sealed.txt', 'sealed on local disk'],
      ['chat__a__plain.txt', 'plain on local disk']
    ]) {
      assert.equal(
        (await readThroughServerPath(setup.platformConfig, 'chat-files', key)).toString(),
        content
      );
      assert.equal(setup.raw(`chat-files/${key}`).includes(content), false);
    }
    // The envelope of the bucket is its own: bound to the bucket's address, not a copy of the file.
    assert.equal(setup.raw('chat-files/chat__a__sealed.txt').equals(onDisk), false);
  });

  it('leaves an object alone that the bucket holds with other content', async () => {
    const setup = installation();
    await seedLocal(setup.local);
    await runCopyBlobs({
      platformConfig: setup.platformConfig,
      env: {},
      namespaces: ['artifacts']
    });
    await setup.local.put('artifacts', 'chat__a__art1', 'changed on local disk afterwards');
    const inBucket = setup.raw('artifacts/chat__a__art1');

    const report = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'error', 'a conflict is not a complete copy');
    assert.equal(report.namespaces.artifacts.conflicts, 1);
    assert.equal(report.namespaces['chat-files'].copied, 2);
    assert.equal(report.totals.failed, 0);
    assert.ok(
      setup.raw('artifacts/chat__a__art1').equals(inBucket),
      'the bucket is not overwritten'
    );
    assert.equal(
      (await readThroughServerPath(setup.platformConfig, 'artifacts', 'chat__a__art1')).toString(),
      'an artifact payload'
    );
    assert.match(formatCopyBlobs(report), /1 blob\(s\) exist in the bucket with other content/);
  });

  it('refuses a prefix that holds objects but no key check object, unless told to adopt it', async () => {
    const setup = installation();
    await seedLocal(setup.local);
    s3.rawPut(BUCKET, `${setup.prefix}/default/chat-files/foreign`, 'who wrote this?');

    const refused = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(refused.status, 'error');
    assert.equal(refused.error.code, 'BLOB_KEY_CHECK_MISSING');
    assert.match(refused.error.hint, /IHUB_S3_ADOPT_BUCKET/);
    assert.equal(refused.totals.copied, 0);
    assert.deepEqual(setup.objects(), [`${setup.prefix}/default/chat-files/foreign`]);
    assert.match(formatCopyBlobs(refused), /Nothing was copied\. BLOB_KEY_CHECK_MISSING/);

    const adopted = await runCopyBlobs({
      platformConfig: setup.platformConfig,
      env: { IHUB_S3_ADOPT_BUCKET: 'true' }
    });
    assert.equal(adopted.status, 'ok');
    assert.equal(adopted.totals.copied, 3);
    assert.ok(setup.objects().includes(`${setup.prefix}/default/_ihub/keycheck`));
  });

  it('counts a blob that is too large as failed and copies the rest', async () => {
    const setup = installation({ s3: { maxObjectBytes: 1000 } });
    await seedLocal(setup.local);
    const before = await snapshot(setup.baseDir);
    const report = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'error');
    assert.equal(report.totals.copied, 2);
    assert.equal(report.totals.failed, 1);
    assert.deepEqual(
      report.failures.map(({ namespace, key, code }) => [namespace, key, code]),
      [['chat-files', 'chat__a__f1.bin', 'BLOB_TOO_LARGE']]
    );
    assert.deepEqual(await snapshot(setup.baseDir), before);
    assert.match(formatCopyBlobs(report), /Result: not complete/);
  });

  it('removes a copy that does not read back as the source and counts it as failed', async () => {
    const setup = installation({ encryption: false });
    await setup.local.put('chat-files', 'chat__a__f1.txt', 'the first file');
    // The service stores something else than it was sent.
    const stop = s3.inject({
      op: 'GetObject',
      key: 'chat__a__f1.txt',
      rawBody: 'not what was written'
    });
    let report;
    try {
      report = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    } finally {
      if (typeof stop === 'function') stop();
      s3.clearInjections();
    }
    assert.equal(report.status, 'error');
    // The first read says "there, with other content": nothing is written over it.
    assert.equal(report.totals.conflicts + report.totals.failed, 1);
    assert.equal(report.totals.copied, 0);
    assert.equal(
      await fs.readFile(path.join(setup.baseDir, 'blobs', 'chat-files', 'chat__a__f1.txt'), 'utf8'),
      'the first file'
    );
  });

  it('uploads as it is when encryption is off, without a key check object', async () => {
    const setup = installation({ encryption: false });
    await seedLocal(setup.local);
    const report = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.encryption, { enabled: false });
    assert.equal(report.totals.copied, 3);
    assert.equal(setup.raw('chat-files/chat__a__f1.txt').toString(), 'the first file');
    assert.equal(
      setup.objects().some(name => name.includes('_ihub/keycheck')),
      false
    );
    assert.match(formatCopyBlobs(report), /off: blobs are uploaded as they are/);
  });

  it('has no target while the blobs stay with the storage provider', async () => {
    const setup = installation({ blobsProvider: 'default' });
    await seedLocal(setup.local);
    const report = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'error');
    assert.equal(report.error.code, 'BLOB_COPY_NO_TARGET');
    assert.deepEqual(setup.objects(), []);
  });

  it('copies nothing when the bucket cannot be used, and says why', async () => {
    const setup = installation({ s3: { bucket: 'no-such-bucket' } });
    await seedLocal(setup.local);
    const before = await snapshot(setup.baseDir);
    const report = await runCopyBlobs({ platformConfig: setup.platformConfig, env: {} });
    assert.equal(report.status, 'error');
    assert.equal(report.error.code, 'S3_BUCKET_NOT_FOUND');
    assert.equal(report.totals.scanned, 0);
    assert.deepEqual(await snapshot(setup.baseDir), before);
  });

  it('has no option that deletes, and rejects an unknown namespace', async () => {
    let printed = '';
    const out = text => (printed += text);
    assert.equal(await copyMain(['--delete-source'], { out }), 2);
    assert.match(printed, /Unknown argument: --delete-source/);
    printed = '';
    assert.equal(await copyMain(['--namespace=users'], { out }), 2);
    assert.match(printed, /--namespace takes one of: .*chat-files/);
    printed = '';
    assert.equal(await copyMain(['--help'], { out }), 0);
    assert.match(printed, /Nothing on local disk is deleted or changed/);
  });

  it('runs as a command: dry run, copy, second copy, with exit codes', async () => {
    const setup = installation();
    await seedLocal(setup.local);
    const before = await snapshot(setup.baseDir);
    const cli = args =>
      runCli('storage-copy-blobs.js', args, { platformConfig: setup.platformConfig });

    const dry = await cli(['--dry-run']);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /dry run/);
    assert.match(dry.stdout, /3 blob\(s\) .* would be copied/);
    assert.deepEqual(setup.objects(), []);

    const first = await cli([]);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /Result: complete\. 3 copied, 0 already present/);
    assert.equal(setup.objects().length, 4);

    const second = await cli(['--json']);
    assert.equal(second.code, 0);
    const report = JSON.parse(second.stdout);
    assert.equal(report.totals.copied, 0);
    assert.equal(report.totals.alreadyPresent, 3);

    assert.deepEqual(await snapshot(setup.baseDir), before, 'the source files are untouched');
    for (const output of [dry, first, second]) {
      assert.equal((output.stdout + output.stderr).includes(SECRET_ACCESS_KEY), false);
    }

    const broken = installation({ s3: { bucket: 'no-such-bucket' } });
    const failed = await runCli('storage-copy-blobs.js', [], {
      platformConfig: broken.platformConfig
    });
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /Nothing was copied\. S3_BUCKET_NOT_FOUND/);
  });
});
