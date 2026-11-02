// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * #3092: a shipped integration definition that a config migration creates or
 * changes (`server/migrations/V*.js` names its id) has a `releases` entry for
 * its current version, whose notes files exist. The admin reads there what
 * the migration did to their installations (Admin → Integrations → an
 * installation → Releases).
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
 * Do not add to this list: give the definition a `releases` entry instead.
 *
 * - The storage PR (migration V205) adds the entries of the three storage
 *   providers and removes them here.
 */
const NOT_YET_RELEASED = new Set([
  'com.intrafind/office365', // storage PR (V205)
  'com.intrafind/google-drive', // storage PR (V205)
  'com.intrafind/nextcloud' // storage PR (V205)
]);

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
      'com.intrafind/qwant-search'
    ]) {
      assert.ok(named.has(id), `${id} is named by a migration`);
    }
  });

  for (const [id, migrations] of named) {
    if (NOT_YET_RELEASED.has(id)) continue;
    it(`${id} has a release entry for its version (${[...migrations].join(', ')})`, () => {
      const { definition, folder } = shipped.get(id);
      assert.ok(Array.isArray(definition.releases), `${id} has no releases`);
      const release = definition.releases.find(entry => entry.version === definition.version);
      assert.ok(release, `${id} has no release entry for version ${definition.version}`);
      assert.ok(definition.compatibility?.ihub, `${id} states the iHub versions it runs on`);
      for (const notes of Object.values(release.notes || {})) {
        assert.ok(fs.existsSync(path.join(folder, notes)), `${id}: ${notes} exists`);
      }
    });
  }

  it('allow-lists only shipped definitions a migration names', () => {
    for (const id of NOT_YET_RELEASED) {
      assert.ok(shipped.has(id), `${id} is a shipped definition`);
      assert.ok(named.has(id), `${id} is named by a migration`);
    }
  });
});
