// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * server/defaults must be the state every migration leaves it in.
 *
 * A fresh install records all migrations as applied and runs none of them
 * (`createdFromDefaults` in migrations/runner.js), so whatever a migration
 * would change in a freshly seeded contents directory is missing on every new
 * installation. This test seeds a contents directory the way startup does,
 * runs all migrations against it, and fails on any file they change.
 *
 * When it fails after you added a migration: make the same change in
 * server/defaults (the file named in the failure), so new installations start
 * where upgraded ones end up.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS_DIR = path.join(SERVER_DIR, 'defaults');
const MIGRATIONS_DIR = path.join(SERVER_DIR, 'migrations');

/**
 * Files old migrations create on a fresh install that the server deliberately
 * does not seed (setupUtils.js, IMPORT_ONLY_DEFAULT_FILES). A fresh install
 * that runs no migration does not get them, which is the intended state:
 *
 * - `tools/knowledge.json` (V173): retired by V202, read in place from
 *   server/defaults; a copy in contents/ only causes warnings.
 * - `sources/meeting-knowledge-base.md`: imported from server/defaults by the
 *   startup project import, which deletes an installation copy anyway.
 */
const NOT_SEEDED_ON_PURPOSE = new Set([
  'tools/knowledge.json',
  'sources/meeting-knowledge-base.md'
]);

/** Environment variables migrations fold into the configuration. */
const ENV_READ_BY_MIGRATIONS =
  /^(IHUB_PLATFORM__|AZURE_|MCP_SERVER_URL$|IFINDER_|[A-Z0-9_]+_API_KEY$)/;

async function listFiles(dir, prefix = '') {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files;
}

async function snapshot(dir) {
  const files = new Map();
  for (const rel of await listFiles(dir)) {
    if (rel.startsWith('.')) continue; // the history and the lock
    files.set(rel, await fs.readFile(path.join(dir, rel)));
  }
  return files;
}

describe('server/defaults is fully migrated', () => {
  let tmp;
  let contentsDir;
  const savedEnv = {};

  before(async () => {
    for (const key of Object.keys(process.env)) {
      if (ENV_READ_BY_MIGRATIONS.test(key)) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-defaults-current-'));
    contentsDir = path.join(tmp, 'contents');
    process.env.CONTENTS_DIR = contentsDir;
  });

  after(async () => {
    Object.assign(process.env, savedEnv);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('running every migration on a freshly seeded contents directory changes nothing', async () => {
    const { copyDefaultConfiguration } = await import('../utils/setupUtils.js');
    const { runConfigMigrations } = await import('../migrations/runner.js');

    await copyDefaultConfiguration({ defaultsPath: DEFAULTS_DIR, contentsPath: contentsDir });
    const seeded = await snapshot(contentsDir);

    const result = await runConfigMigrations({
      contentsDir,
      migrationsDir: MIGRATIONS_DIR,
      defaultsDir: DEFAULTS_DIR,
      freshlySeeded: true,
      createdFromDefaults: false
    });
    assert.equal(result.failed, 0);
    const migrated = await snapshot(contentsDir);

    const problems = [];
    for (const [rel, content] of migrated) {
      if (!seeded.has(rel)) {
        if (!NOT_SEEDED_ON_PURPOSE.has(rel)) problems.push(`${rel}: created by a migration`);
        continue;
      }
      const before = seeded.get(rel);
      if (rel.endsWith('.json')) {
        try {
          assert.deepStrictEqual(JSON.parse(content), JSON.parse(before));
        } catch (error) {
          problems.push(`${rel}: changed by a migration\n${error.message}`);
        }
      } else if (!content.equals(before)) {
        problems.push(`${rel}: changed by a migration`);
      }
    }
    for (const rel of seeded.keys()) {
      if (!migrated.has(rel)) problems.push(`${rel}: removed by a migration`);
    }

    assert.deepEqual(
      problems,
      [],
      'Make the same change in server/defaults, so a fresh install (which runs no migration) gets it:\n' +
        problems.join('\n\n')
    );
  });
});
