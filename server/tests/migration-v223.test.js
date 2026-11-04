// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V223 — single-slot integration token files are renamed to the
 * per-provider layout once, and only where the payload names its provider.
 *
 * Jira keeps its tokens in one unscoped slot on purpose, so a file without a
 * `providerId` must stay exactly where it is.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  precondition,
  scopeTokenFiles,
  version
} from '../migrations/V223__scope_integration_token_files.js';

function recordingLog() {
  const lines = [];
  return {
    lines,
    info: message => lines.push({ level: 'info', message }),
    warn: message => lines.push({ level: 'warn', message })
  };
}

async function withTokens(files, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v223-'));
  const baseDir = path.join(root, 'integrations');
  try {
    for (const [relative, body] of Object.entries(files)) {
      const file = path.join(baseDir, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    }
    await fn({ root, baseDir, log: recordingLog() });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const exists = async file =>
  fs.access(file).then(
    () => true,
    () => false
  );

/** Stands in for `TokenStorageService.decryptTokens`: the payload is a field. */
const decrypt = envelope => {
  if (envelope.broken) throw new Error('bad key');
  return envelope.payload || {};
};

describe('migration V223', () => {
  it('has the number it was created with', () => {
    assert.equal(version, '223');
  });

  it('runs only where an integrations directory has content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v223-pre-'));
    try {
      const listFiles = async directory => {
        try {
          return await fs.readdir(path.join(root, directory));
        } catch {
          return [];
        }
      };
      assert.equal(await precondition({ listFiles }), false);
      await fs.mkdir(path.join(root, 'integrations', 'office365'), { recursive: true });
      assert.equal(await precondition({ listFiles }), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('V223: scopeTokenFiles', () => {
  it('renames a single-slot file whose providerId is in plaintext', async () => {
    await withTokens(
      { 'office365/alice.json': { providerId: 'o365-corp', iv: 'x' } },
      async ({ baseDir, log }) => {
        const result = await scopeTokenFiles({ baseDir, decrypt, log });
        assert.deepEqual(result, { migrated: 1, skipped: 0 });
        assert.equal(await exists(path.join(baseDir, 'office365', 'alice.json')), false);
        assert.equal(await exists(path.join(baseDir, 'office365', 'alice__o365-corp.json')), true);
      }
    );
  });

  it('recovers the providerId from the encrypted payload of an older file', async () => {
    await withTokens(
      { 'googledrive/bob.json': { payload: { providerId: 'gd-1' } } },
      async ({ baseDir, log }) => {
        assert.equal((await scopeTokenFiles({ baseDir, decrypt, log })).migrated, 1);
        assert.equal(await exists(path.join(baseDir, 'googledrive', 'bob__gd-1.json')), true);
      }
    );
  });

  it('leaves an unscoped slot without a providerId alone (Jira)', async () => {
    await withTokens(
      { 'jira/carol.json': { payload: { accessToken: 'secret' } } },
      async ({ baseDir, log }) => {
        const result = await scopeTokenFiles({ baseDir, decrypt, log });
        assert.deepEqual(result, { migrated: 0, skipped: 1 });
        assert.equal(await exists(path.join(baseDir, 'jira', 'carol.json')), true);
      }
    );
  });

  it('leaves files it cannot read or decrypt, and says so', async () => {
    await withTokens(
      { 'office365/torn.json': '{"iv":', 'office365/locked.json': { broken: true } },
      async ({ baseDir, log }) => {
        const result = await scopeTokenFiles({ baseDir, decrypt, log });
        assert.deepEqual(result, { migrated: 0, skipped: 2 });
        assert.equal(await exists(path.join(baseDir, 'office365', 'torn.json')), true);
        assert.equal(await exists(path.join(baseDir, 'office365', 'locked.json')), true);
        assert.equal(log.lines.filter(line => line.level === 'warn').length, 2);
      }
    );
  });

  it('leaves already scoped files alone and removes a duplicate single-slot file', async () => {
    await withTokens(
      {
        'office365/dave__o365-corp.json': { providerId: 'o365-corp', current: true },
        'office365/dave.json': { providerId: 'o365-corp', stale: true },
        'nextcloud/erin__nc.json': { providerId: 'nc' }
      },
      async ({ baseDir, log }) => {
        const result = await scopeTokenFiles({ baseDir, decrypt, log });
        assert.equal(result.migrated, 1);
        assert.equal(await exists(path.join(baseDir, 'office365', 'dave.json')), false);
        const kept = JSON.parse(
          await fs.readFile(path.join(baseDir, 'office365', 'dave__o365-corp.json'), 'utf8')
        );
        assert.equal(kept.current, true, 'the scoped file wins');
        assert.equal(await exists(path.join(baseDir, 'nextcloud', 'erin__nc.json')), true);
      }
    );
  });

  it('refuses a providerId that is not a safe file name', async () => {
    await withTokens(
      { 'office365/frank.json': { providerId: '../escape' } },
      async ({ baseDir, root, log }) => {
        const result = await scopeTokenFiles({ baseDir, decrypt, log });
        assert.equal(result.migrated, 0);
        assert.equal(await exists(path.join(baseDir, 'office365', 'frank.json')), true);
        assert.equal(await exists(path.join(root, 'escape.json')), false);
      }
    );
  });

  it('does nothing on an install without an integrations directory', async () => {
    const log = recordingLog();
    const result = await scopeTokenFiles({
      baseDir: path.join(os.tmpdir(), 'ihub-v223-does-not-exist'),
      decrypt,
      log
    });
    assert.deepEqual(result, { migrated: 0, skipped: 0 });
  });
});
