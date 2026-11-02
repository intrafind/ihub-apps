// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every shipped integration definition that a config migration creates or
 * changes carries a release history (#3092): admins read in the
 * installation's **Releases** tab what the migration did to it. A definition
 * counts as touched by a migration when a `server/migrations/V*.js` names its
 * id in a string literal (`'com.intrafind/nextcloud'`).
 *
 * `WITHOUT_RELEASES` lists the definitions still waiting for their entry. It
 * only shrinks: the PR that rewrites a definition adds its release entry and
 * removes it from the list.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, '..', '..', 'migrations');
const DEFINITIONS_DIR = path.join(here, '..', '..', 'defaults', 'integration-definitions');

/**
 * Migrated definitions whose release entry comes with a later PR
 * (2026-11-02): iHub's own tools (#3100) and the LDAP people directory (V204).
 */
const WITHOUT_RELEASES = new Set(['com.intrafind/ihub', 'com.intrafind/ldap-directory']);

/** Shipped definitions by id: `{ id → { folder, definition } }`. */
function shippedDefinitions() {
  const out = new Map();
  for (const folder of fs.readdirSync(DEFINITIONS_DIR)) {
    const file = path.join(DEFINITIONS_DIR, folder, 'integration.json');
    if (!fs.existsSync(file)) continue;
    const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.set(definition.id, { folder, definition });
  }
  return out;
}

/** The ids of shipped definitions that some migration names, with the migrations naming each. */
function migratedDefinitionIds(shipped) {
  const named = new Map();
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => /^V\d+__.*\.js$/.test(f))) {
    const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const match of source.matchAll(/['"`]([a-z0-9.-]+\/[a-z0-9._-]+)['"`]/gi)) {
      const id = match[1];
      if (!shipped.has(id)) continue;
      if (!named.has(id)) named.set(id, new Set());
      named.get(id).add(file);
    }
  }
  return named;
}

describe('release history of migrated definitions (#3092)', () => {
  const shipped = shippedDefinitions();
  const migrated = migratedDefinitionIds(shipped);

  it('finds the migrated definitions', () => {
    for (const id of [
      'com.intrafind/office365',
      'com.intrafind/google-drive',
      'com.intrafind/nextcloud'
    ]) {
      assert.ok(migrated.has(id), `${id} should be named by a migration`);
    }
  });

  for (const [id, files] of migrated) {
    if (WITHOUT_RELEASES.has(id)) continue;
    it(`${id} (${[...files].sort().join(', ')}) has a release entry for its version`, () => {
      const { folder, definition } = shipped.get(id);
      assert.ok(
        Array.isArray(definition.releases) && definition.releases.length > 0,
        `${id} is created or changed by ${[...files].join(', ')} but has no "releases"`
      );
      const [latest] = definition.releases;
      assert.equal(latest.version, definition.version, `${id}: newest release is the version`);
      assert.ok(definition.compatibility?.ihub, `${id}: compatibility.ihub is set`);
      for (const note of Object.values(latest.notes || {})) {
        assert.ok(
          fs.existsSync(path.join(DEFINITIONS_DIR, folder, note)),
          `${id}: release notes file ${note} exists`
        );
      }
    });
  }

  it('lists only migrated definitions that still lack an entry', t => {
    for (const id of WITHOUT_RELEASES) {
      if (!shipped.has(id)) continue;
      if (Array.isArray(shipped.get(id).definition.releases)) {
        // Another PR added the entry: the allow-list entry can go.
        t.diagnostic(`${id} has a release entry now; remove it from WITHOUT_RELEASES`);
      }
    }
  });
});
