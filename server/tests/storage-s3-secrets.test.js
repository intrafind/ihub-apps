// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `storage.blobs.s3.secretAccessKey` is a platform secret: encrypted when
 * `platform.json` is saved, redacted when an admin reads the configuration,
 * put back when the redacted form is saved, and masked in log output.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-secrets-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
fsSync.mkdirSync(path.join(scratch, 'contents', 'config'), { recursive: true });

const { encryptPlatformSecrets, decryptPlatformSecrets } =
  await import('../utils/configSecrets.js');
const { PLATFORM_SECRET_PATHS, SECRET_MARKER, redactForRead, restoreRedacted } =
  await import('../utils/redactedSecrets.js');
const { isSecretName } = await import('../utils/secretNames.js');
const { platformConfigSchema } = await import('../validators/platformConfigSchema.js');
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
const { openConfigSecret } = await import('../crypto/KeyProvider.js');
const { default: logger } = await import('../utils/logger.js');

const SECRET = 'wJalrXUtnFEMI-K7MDENG-bPxRfiCY-EXAMPLEKEY';
const platform = secretAccessKey => ({
  defaultLanguage: 'en',
  storage: {
    provider: 'filesystem',
    blobs: {
      provider: 's3',
      s3: {
        endpoint: 'https://s3.internal',
        bucket: 'ihub',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey
      }
    }
  }
});

before(async () => {
  await tokenStorageService.initializeEncryptionKey();
});

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('S3 secret access key at rest', () => {
  it('is encrypted on save without changing the argument, and opened by the storage path', async () => {
    const input = platform(SECRET);
    const output = await encryptPlatformSecrets(input);
    const stored = output.storage.blobs.s3.secretAccessKey;
    assert.ok(tokenStorageService.isEncrypted(stored));
    assert.equal(JSON.stringify(output).includes(SECRET), false);
    assert.equal(input.storage.blobs.s3.secretAccessKey, SECRET, 'the argument is not modified');
    assert.equal(output.storage.blobs.s3.accessKeyId, 'AKIDEXAMPLE');
    assert.equal(output.storage.provider, 'filesystem');
    assert.equal(openConfigSecret(stored), SECRET);
    assert.equal(openConfigSecret(SECRET), SECRET, 'a plain value passes through');
    // Twice is harmless.
    assert.equal(await encryptPlatformSecrets(output), output);
  });

  it('leaves a placeholder, a file without the block and other shapes alone', async () => {
    const placeholder = platform('${IHUB_S3_SECRET_ACCESS_KEY}');
    assert.equal(await encryptPlatformSecrets(placeholder), placeholder);
    const none = { defaultLanguage: 'en', storage: { provider: 'filesystem' } };
    assert.equal(await encryptPlatformSecrets(none), none);
    const odd = { storage: { blobs: { s3: [] } } };
    assert.equal(await encryptPlatformSecrets(odd), odd);
    assert.equal(await encryptPlatformSecrets(null), null);
  });

  it('stays encrypted in the runtime cache: nothing there needs it', async () => {
    const stored = await encryptPlatformSecrets(platform(SECRET));
    const cached = decryptPlatformSecrets(structuredClone(stored));
    assert.ok(tokenStorageService.isEncrypted(cached.storage.blobs.s3.secretAccessKey));
  });

  it('is redacted on an admin read and put back on save', async () => {
    assert.ok(
      PLATFORM_SECRET_PATHS.some(entry => entry.path === 'storage.blobs.s3.secretAccessKey')
    );
    const stored = await encryptPlatformSecrets(platform(SECRET));
    const shown = redactForRead(stored);
    assert.equal(shown.storage.blobs.s3.secretAccessKey, SECRET_MARKER);
    assert.equal(shown.storage.blobs.s3.accessKeyId, 'AKIDEXAMPLE', 'the id is not a secret');
    assert.equal(JSON.stringify(shown).includes('ENC['), false);
    assert.equal(
      redactForRead(platform('${IHUB_S3_SECRET_ACCESS_KEY}')).storage.blobs.s3.secretAccessKey,
      '${IHUB_S3_SECRET_ACCESS_KEY}',
      'a placeholder is shown as it is'
    );

    const sentBack = structuredClone(shown);
    restoreRedacted(sentBack, stored, PLATFORM_SECRET_PATHS);
    assert.equal(
      sentBack.storage.blobs.s3.secretAccessKey,
      stored.storage.blobs.s3.secretAccessKey,
      'the marker is replaced by what is stored'
    );
    const omitted = structuredClone(shown);
    delete omitted.storage.blobs.s3.secretAccessKey;
    restoreRedacted(omitted, stored, PLATFORM_SECRET_PATHS);
    assert.equal(omitted.storage.blobs.s3.secretAccessKey, stored.storage.blobs.s3.secretAccessKey);
  });

  it('is masked in log output', () => {
    assert.equal(isSecretName('secretAccessKey'), true);
    assert.equal(isSecretName('secret_access_key'), true);
    assert.equal(isSecretName('accessKeyId'), false);
    const lines = [];
    const original = process.stdout.write;
    process.stdout.write = chunk => {
      lines.push(String(chunk));
      return true;
    };
    try {
      logger.info('S3 settings', { component: 'Test', s3: platform(SECRET).storage.blobs.s3 });
    } finally {
      process.stdout.write = original;
    }
    const output = lines.join('');
    assert.match(output, /S3 settings/);
    assert.equal(output.includes(SECRET), false);
    assert.match(output, /AKIDEXAMPLE/);
  });
});

describe('platform schema: storage.encryption and storage.blobs', () => {
  it('leaves a configuration without the blocks as it is, with encryption off', () => {
    const parsed = platformConfigSchema.parse({ storage: { provider: 'filesystem' } });
    assert.equal(parsed.storage.encryption.enabled, false);
    assert.equal(parsed.storage.blobs, undefined, 'no blobs block is invented');
    assert.equal(platformConfigSchema.parse({}).storage.encryption.enabled, false);
  });

  it('accepts the S3 block and adds no defaults to it', () => {
    const block = platform('${IHUB_S3_SECRET_ACCESS_KEY}').storage;
    const parsed = platformConfigSchema.parse({
      storage: { ...block, encryption: { enabled: true } }
    });
    assert.deepEqual(parsed.storage.blobs, block.blobs);
    assert.equal(parsed.storage.encryption.enabled, true);
    assert.equal(
      platformConfigSchema.safeParse({ storage: { blobs: { s3: { forcePathStyle: 'yes' } } } })
        .success,
      false
    );
    assert.equal(
      platformConfigSchema.safeParse({ storage: { encryption: { enabled: 'yes' } } }).success,
      false
    );
  });

  it('switches encryption on for a fresh installation', async () => {
    const defaults = JSON.parse(
      await fs.readFile(
        path.resolve(import.meta.dirname, '..', 'defaults', 'config', 'platform.json'),
        'utf8'
      )
    );
    assert.equal(defaults.storage.encryption.enabled, true);
    assert.equal(defaults.storage.blobs, undefined, 'S3 is never preconfigured');
  });
});
