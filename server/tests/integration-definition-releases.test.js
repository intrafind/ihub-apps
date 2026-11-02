// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * #3092: a shipped integration definition that a config migration creates or
 * changes (`server/migrations/V*.js` names its id in a string literal, e.g.
 * `'com.intrafind/nextcloud'`) has a release history whose newest entry is its
 * current version, with notes files that exist. The admin reads there what
 * the migration did to their installations (Admin → Integrations → an
 * installation → Releases).
 *
 * Run with `npm run test:integrations`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, '..', 'migrations');
const DEFINITIONS_DIR = path.join(here, '..', 'defaults', 'integration-definitions');

/**
 * Definitions a migration creates or changes that have no release entry yet.
 * Empty since every migrated built-in got its entry (web search V204, LDAP
 * browser V205, storage providers V206, iHub V201). Do not add to this list:
 * give the definition a `releases` entry instead. The list only shrinks: a
 * definition on it that has an entry by now fails the last test below.
 */
const NOT_YET_RELEASED = new Set([]);

/** The shipped definitions by id, with the folder each lives in. */
function shippedDefinitions() {
  const out = new Map();
  for (const dir of fs.readdirSync(DEFINITIONS_DIR)) {
    const file = path.join(DEFINITIONS_DIR, dir, 'integration.json');
    if (!fs.existsSync(file)) continue;
    const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.set(definition.id, { definition, folder: path.join(DEFINITIONS_DIR, dir) });
  }
  return out;
}

/** The shipped definition ids the migrations name in a string literal, with the migrations naming each. */
function definitionsNamedByMigrations(shippedIds) {
  const named = new Map();
  const literal = /['"`]([a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*)['"`]/g;
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!/^V\d+__.*\.js$/.test(file)) continue;
    const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const match of source.matchAll(literal)) {
      const id = match[1];
      if (!shippedIds.has(id)) continue;
      if (!named.has(id)) named.set(id, new Set());
      named.get(id).add(file);
    }
  }
  return named;
}

/** Whether a definition has a release entry for its current version. */
function hasReleaseForVersion(definition) {
  return (
    Array.isArray(definition.releases) &&
    definition.releases.some(entry => entry?.version === definition.version)
  );
}

const shipped = shippedDefinitions();
const named = definitionsNamedByMigrations(new Set(shipped.keys()));

describe('release entries of migrated definitions (#3092)', () => {
  it('finds the definitions the migrations create or change', () => {
    for (const id of [
      'com.intrafind/ifinder',
      'com.intrafind/ihub',
      'com.intrafind/ldap-directory',
      'com.intrafind/ldap-browser',
      'com.intrafind/brave-search',
      'com.intrafind/staan-search',
      'com.intrafind/qwant-search',
      'com.intrafind/office365',
      'com.intrafind/google-drive',
      'com.intrafind/nextcloud'
    ]) {
      assert.ok(named.has(id), `${id} is named by a migration`);
    }
  });

  for (const [id, migrations] of named) {
    if (NOT_YET_RELEASED.has(id)) continue;
    const files = [...migrations].sort().join(', ');
    it(`${id} has a release entry for its version (${files})`, () => {
      const { definition, folder } = shipped.get(id);
      assert.ok(
        Array.isArray(definition.releases) && definition.releases.length > 0,
        `${id} is created or changed by ${files} but has no releases`
      );
      const [newest] = definition.releases;
      assert.equal(
        newest.version,
        definition.version,
        `${id}: the newest release (releases[0]) is version ${definition.version}`
      );
      assert.ok(definition.compatibility?.ihub, `${id} states the iHub versions it runs on`);
      for (const notes of Object.values(newest.notes || {})) {
        assert.ok(fs.existsSync(path.join(folder, notes)), `${id}: ${notes} exists`);
      }
    });
  }

  it('allow-lists only shipped definitions a migration names that still lack an entry', () => {
    for (const id of NOT_YET_RELEASED) {
      assert.ok(shipped.has(id), `${id} is a shipped definition`);
      assert.ok(named.has(id), `${id} is named by a migration`);
      assert.ok(
        !hasReleaseForVersion(shipped.get(id).definition),
        `${id} has a release entry now: remove it from NOT_YET_RELEASED`
      );
    }
  });
});
