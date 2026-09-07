// Plain-node test (node server/tests/keyColdStartRace.test.js).
//
// On the first start of an installation the JWT signing key and the secret
// encryption key do not exist yet, so with WORKERS>1 every worker reaches the
// "generate and persist" branch of TokenStorageService at the same moment.
// Before the exclusive-create guard each kept the key it generated itself: a
// token signed by one worker failed verification on the others (intermittent
// 401s under round-robin) and a secret encrypted by one was undecryptable
// everywhere else.
//
// The race only exists across processes, so this forks real ones against a
// throwaway CONTENTS_DIR rather than mocking the filesystem.

import assert from 'assert';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRootDir } from '../pathUtils.js';

const __filename = fileURLToPath(import.meta.url);
const PROCESS_COUNT = 4;

// CONTENTS_DIR is joined onto the app root rather than used verbatim, so the
// throwaway directory has to be relative and is resolved the same way here.
const RELATIVE_CONTENTS_DIR = `.key-race-test-${process.pid}`;

if (process.env.KEY_RACE_CHILD) {
  await runChild();
} else {
  await runDriver();
}

async function runDriver() {
  const contentsDir = path.join(getRootDir(), RELATIVE_CONTENTS_DIR);
  await fs.mkdir(contentsDir, { recursive: true });

  let failed = false;
  const check = (label, fn) => {
    try {
      fn();
      console.log(`✅ ${label}`);
    } catch (error) {
      failed = true;
      console.error(`❌ ${label}\n   ${error.message}`);
    }
  };

  try {
    // All children start from an empty directory, so each generates its own
    // candidate keys before any file exists — the cold-start condition.
    const results = await Promise.all(Array.from({ length: PROCESS_COUNT }, () => runOne()));

    const encryptionKeys = new Set(results.map(r => r.encryptionKey));
    const privateKeys = new Set(results.map(r => r.privateKey));
    const publicKeys = new Set(results.map(r => r.publicKey));

    check('every process ends up with the same encryption key', () =>
      assert.strictEqual(
        encryptionKeys.size,
        1,
        `${encryptionKeys.size} distinct encryption keys across ${PROCESS_COUNT} processes`
      )
    );
    check('every process ends up with the same RSA private key', () =>
      assert.strictEqual(
        privateKeys.size,
        1,
        `${privateKeys.size} distinct private keys across ${PROCESS_COUNT} processes`
      )
    );
    check('every process ends up with the same RSA public key', () =>
      assert.strictEqual(publicKeys.size, 1)
    );

    // The surviving keys must be the ones on disk, or a restart would break
    // every token and secret the cluster just produced.
    const onDisk = {
      encryptionKey: (await fs.readFile(path.join(contentsDir, '.encryption-key'), 'utf8')).trim(),
      privateKey: await fs.readFile(path.join(contentsDir, '.jwt-private-key.pem'), 'utf8'),
      publicKey: await fs.readFile(path.join(contentsDir, '.jwt-public-key.pem'), 'utf8')
    };
    check('the shared keys are the ones persisted to disk', () => {
      assert.strictEqual([...encryptionKeys][0], onDisk.encryptionKey);
      assert.strictEqual([...privateKeys][0], onDisk.privateKey);
      assert.strictEqual([...publicKeys][0], onDisk.publicKey);
    });

    // A pair must never be mixed: the public key has to belong to the private
    // key, or verification fails even with every process agreeing.
    check('the persisted pair is internally consistent', () => {
      const derived = results.find(r => r.derivedPublicKey)?.derivedPublicKey;
      assert.ok(derived, 'no process reported a derived public key');
      assert.strictEqual(derived.trim(), onDisk.publicKey.trim());
    });
  } catch (error) {
    failed = true;
    console.error(`❌ test driver failed: ${error.message}`);
  } finally {
    await fs.rm(contentsDir, { recursive: true, force: true });
  }

  if (failed) {
    console.error('\nkeyColdStartRace: FAILED');
    process.exit(1);
  }
  console.log('\nkeyColdStartRace: all checks passed');
  process.exit(0);
}

function runOne() {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [], {
      env: { ...process.env, KEY_RACE_CHILD: '1', CONTENTS_DIR: RELATIVE_CONTENTS_DIR },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child did not report its keys in time'));
    }, 30000);
    child.once('message', message => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (message.error) reject(new Error(message.error));
      else resolve(message);
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runChild() {
  try {
    // Env-var overrides would short-circuit generation, which is the branch
    // under test.
    delete process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;

    const crypto = await import('node:crypto');
    const { default: tokenStorageService } = await import('../services/TokenStorageService.js');

    await tokenStorageService.initializeEncryptionKey();
    await tokenStorageService.initializeRSAKeyPair();

    const pair = tokenStorageService.getRSAKeyPair();
    process.send({
      encryptionKey: tokenStorageService.getEncryptionKey?.() ?? tokenStorageService.encryptionKey,
      privateKey: pair?.privateKey,
      publicKey: pair?.publicKey,
      // Derive the public key from the private one so the driver can prove the
      // persisted pair was not spliced together from two different generations.
      derivedPublicKey: crypto
        .createPublicKey(pair.privateKey)
        .export({ type: 'spki', format: 'pem' })
    });
  } catch (error) {
    process.send({ error: error.message });
  }
}
