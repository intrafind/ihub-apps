// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V217: integration token files in the AES-CBC or single-slot shape are deleted
 * (never decrypted); GCM files scoped to a provider and unrelated files are kept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition } from '../migrations/V217__drop_legacy_integration_token_files.js';

function fakeCtx(files) {
  const dirs = new Set(Object.keys(files).map(p => p.split('/').slice(0, -1).join('/')));
  const list = dir => {
    const prefix = `${dir}/`;
    const names = new Set();
    for (const p of Object.keys(files))
      if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]);
    return [...names];
  };
  return {
    files,
    listFiles: async (dir, pattern) =>
      list(dir).filter(n => !pattern || n.endsWith(pattern.replace('*', ''))),
    readJson: async p => {
      if (dirs.has(p) || !(p in files)) throw new Error('not a file');
      return files[p];
    },
    deleteFile: async p => {
      delete files[p];
    },
    log: () => {}
  };
}

const gcm = { encrypted: 'aa', iv: 'bb', authTag: 'cc', contextHash: 'dd', providerId: 'p1' };

test('deletes CBC and single-slot token files, keeps scoped GCM and other files', async () => {
  const ctx = fakeCtx({
    'integrations/office365/u1__p1.json': { ...gcm },
    'integrations/office365/u2.json': { encrypted: 'aa', iv: 'bb', contextHash: 'dd' },
    'integrations/nextcloud/u3__p2.json': { ...gcm, authTag: undefined },
    'integrations/nextcloud/u4.json': { ...gcm, providerId: null },
    'integrations/nextcloud/notes.json': { hello: 'world' }
  });
  assert.equal(await precondition(ctx), true);
  await up(ctx);
  assert.deepEqual(Object.keys(ctx.files).sort(), [
    'integrations/nextcloud/notes.json',
    'integrations/office365/u1__p1.json'
  ]);
});

test('is skipped without an integrations directory', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
});
