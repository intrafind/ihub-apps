// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V255 — users' AI acknowledgements move from users.json into one
 * runtime document per user.
 *
 * Driven against the real filesystem provider over scratch directories. What
 * matters for an upgrade: nothing is lost, a second run changes nothing, a
 * document the server already wrote is merged rather than overwritten, two
 * imports at once lose nothing, and the live repository finds what the
 * migration wrote (same key, same shape).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { AiAcknowledgementRepository } from '../services/aiAcknowledgement/AiAcknowledgementRepository.js';
import {
  importAcknowledgements,
  locateUsersFile,
  moveAcknowledgements,
  precondition,
  version
} from '../migrations/V255__move_ai_acknowledgements_to_runtime_store.js';

const V1 = { version: 1, textHash: 'sha256:a', acknowledgedAt: '2026-01-01T00:00:00.000Z' };
const V2 = {
  version: 2,
  textHash: 'sha256:b',
  acknowledgedAt: '2026-02-01T00:00:00.000Z',
  language: 'de',
  client: 'office'
};

function legacyUsers() {
  return {
    users: {
      alice: { username: 'alice', aiAcknowledgements: [V1, V2] },
      bob: {
        username: 'bob',
        aiAcknowledgements: [],
        aiAcknowledgementsClearedAt: '2026-03-01T00:00:00.000Z'
      },
      carol: { username: 'carol' }
    },
    metadata: { version: '2.0.0' }
  };
}

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v255-'));
  const providers = [];
  const open = async () => {
    const provider = new FilesystemStorageProvider({ baseDir: dir, flushIntervalMs: 25 });
    await provider.initialize();
    providers.push(provider);
    return provider;
  };
  try {
    await fn(open);
  } finally {
    for (const provider of providers) await provider.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('V255 move AI acknowledgements to the runtime store', () => {
  it('has the right version', () => {
    assert.equal(version, '255');
  });

  it('moves every entry and cleared stamp, then strips the fields', async () => {
    await withStore(async open => {
      const provider = await open();
      const usersConfig = legacyUsers();
      const result = await importAcknowledgements({ documents: provider.documents, usersConfig });
      assert.deepEqual(result, { users: 2, entries: 2 });

      const repository = new AiAcknowledgementRepository({ documents: provider.documents });
      assert.deepEqual((await repository.get('alice')).aiAcknowledgements, [V1, V2]);
      assert.equal(
        (await repository.get('bob')).aiAcknowledgementsClearedAt,
        '2026-03-01T00:00:00.000Z'
      );
      assert.equal(await repository.get('carol'), null);
      for (const user of Object.values(usersConfig.users)) {
        assert.equal(Object.hasOwn(user, 'aiAcknowledgements'), false);
        assert.equal(Object.hasOwn(user, 'aiAcknowledgementsClearedAt'), false);
      }
      assert.equal(usersConfig.users.alice.username, 'alice');
    });
  });

  it('is idempotent: a second run (users.json not yet stripped) adds nothing', async () => {
    await withStore(async open => {
      const provider = await open();
      await importAcknowledgements({ documents: provider.documents, usersConfig: legacyUsers() });
      const before = await provider.documents.list('ai-acknowledgements');
      // The process stopped before users.json was written: the next start imports again.
      const again = await importAcknowledgements({
        documents: provider.documents,
        usersConfig: legacyUsers()
      });
      assert.equal(again.entries, 0);
      const after = await provider.documents.list('ai-acknowledgements');
      assert.deepEqual(
        after.items.map(doc => doc.etag),
        before.items.map(doc => doc.etag)
      );
    });
  });

  it('merges into a document the server already wrote; the stored entry wins', async () => {
    await withStore(async open => {
      const provider = await open();
      const repository = new AiAcknowledgementRepository({ documents: provider.documents });
      const newer = { ...V1, acknowledgedAt: '2026-04-01T00:00:00.000Z' };
      await repository.record('alice', newer);
      await importAcknowledgements({ documents: provider.documents, usersConfig: legacyUsers() });
      assert.deepEqual((await repository.get('alice')).aiAcknowledgements, [newer, V2]);
    });
  });

  it('two imports at once (two processes) lose nothing', async () => {
    await withStore(async open => {
      const [a, b] = [await open(), await open()];
      await Promise.all([
        importAcknowledgements({ documents: a.documents, usersConfig: legacyUsers() }),
        importAcknowledgements({ documents: b.documents, usersConfig: legacyUsers() })
      ]);
      const repository = new AiAcknowledgementRepository({ documents: a.documents });
      assert.deepEqual((await repository.get('alice')).aiAcknowledgements, [V1, V2]);
    });
  });

  it('runs only while users.json still carries the fields', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v255-pre-'));
    try {
      await fs.mkdir(path.join(dir, 'config'), { recursive: true });
      const ctx = {
        contentsDir: dir,
        fileExists: rel =>
          fs.access(path.join(dir, rel)).then(
            () => true,
            () => false
          ),
        readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'))
      };
      assert.equal(await precondition(ctx), false);
      const file = path.join(dir, 'config/users.json');
      await fs.writeFile(file, JSON.stringify(legacyUsers()));
      assert.equal(await precondition(ctx), true);
      const stripped = legacyUsers();
      delete stripped.users.alice.aiAcknowledgements;
      delete stripped.users.bob.aiAcknowledgements;
      delete stripped.users.bob.aiAcknowledgementsClearedAt;
      await fs.writeFile(file, JSON.stringify(stripped));
      assert.equal(await precondition(ctx), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('locates usersFile the way the server does (relative to the installation root)', () => {
    const rootDir = path.resolve('/srv/ihub');
    const contentsDir = path.join(rootDir, 'contents');
    const at = (configured, dirs = { rootDir, contentsDir }) => locateUsersFile(configured, dirs);
    assert.deepEqual(at('contents/config/users.json'), {
      fullPath: path.join(contentsDir, 'config/users.json'),
      relPath: 'config/users.json'
    });
    // Not under contents/: read and written outside it, never as <contents>/secrets/...
    assert.deepEqual(at('secrets/users.json'), {
      fullPath: path.join(rootDir, 'secrets/users.json'),
      relPath: null
    });
    // A renamed contents directory (CONTENTS_DIR=data).
    assert.equal(
      at('data/config/users.json', { rootDir, contentsDir: path.join(rootDir, 'data') }).relPath,
      'config/users.json'
    );
    assert.equal(at(path.join(contentsDir, 'auth/users.json')).relPath, 'auth/users.json');
    assert.equal(at(path.resolve('/mnt/secret/users.json')).relPath, null);
  });

  it('warns when a configured usersFile does not exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v255-missing-'));
    try {
      await fs.mkdir(path.join(dir, 'config'), { recursive: true });
      const missing = path.join(dir, 'nowhere/users.json');
      await fs.writeFile(
        path.join(dir, 'config/platform.json'),
        JSON.stringify({ localAuth: { usersFile: missing } })
      );
      const warnings = [];
      const ctx = {
        contentsDir: dir,
        fileExists: rel =>
          fs.access(path.join(dir, rel)).then(
            () => true,
            () => false
          ),
        readJson: async rel => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8')),
        warn: message => warnings.push(message)
      };
      assert.equal(await precondition(ctx), false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /does not exist/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps what older servers wrote to users.json while the documents were written', async () => {
    await withStore(async open => {
      const provider = await open();
      const snapshot = legacyUsers();
      // users.json as an older server left it after the snapshot was read:
      // a new user, an admin edit, and a confirmation that landed in the meantime.
      const fresh = legacyUsers();
      fresh.users.dave = { username: 'dave', aiAcknowledgements: [V1] };
      fresh.users.carol.name = 'Carol';
      fresh.users.alice.aiAcknowledgements.push({ ...V2, version: 3 });
      let written;
      const result = await moveAcknowledgements({
        documents: provider.documents,
        snapshot,
        update: async change => {
          written = await change(structuredClone(fresh));
        }
      });
      assert.equal(result.entries, 4);
      assert.equal(written.users.carol.name, 'Carol');
      assert.equal(written.users.dave.username, 'dave');
      for (const user of Object.values(written.users)) {
        assert.equal(Object.hasOwn(user, 'aiAcknowledgements'), false);
        assert.equal(Object.hasOwn(user, 'aiAcknowledgementsClearedAt'), false);
      }
      const repository = new AiAcknowledgementRepository({ documents: provider.documents });
      assert.deepEqual((await repository.get('dave')).aiAcknowledgements, [V1]);
      assert.deepEqual(
        (await repository.get('alice')).aiAcknowledgements.map(entry => entry.version),
        [1, 2, 3]
      );
    });
  });

  it('writes nothing under the lock when another run already stripped users.json', async () => {
    await withStore(async open => {
      const provider = await open();
      let written = 'untouched';
      await moveAcknowledgements({
        documents: provider.documents,
        snapshot: legacyUsers(),
        update: async change => {
          written = await change({ users: { carol: { username: 'carol' } } });
        }
      });
      assert.equal(written, undefined);
    });
  });
});
