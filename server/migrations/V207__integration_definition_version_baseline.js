// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V207 — integration definition version baseline
 *
 * Phase 2 of the integration versioning concept
 * (`concepts/2026-10-31 Integration Versioning and Migrations/README.md` §3)
 * migrates an installation from its `definitionVersion` to the loaded
 * definition with the definition's own declarative migrations. An
 * installation whose `definitionVersion` is missing or not a semantic
 * version has no starting point for that and is marked `needsReview` at
 * load. Installations written before versioning (or by a config migration
 * that did not record the version) would all end there.
 *
 * No definition migration predates this one, so the version of the
 * definition this release ships is the right baseline: every installation in
 * `config/integrations.json` without a valid `definitionVersion` gets the
 * version of its definition — the installed copy under
 * `contents/integration-definitions/` (from the marketplace, which wins at
 * load) or else the shipped one under `server/defaults/integration-definitions/`.
 * An installation whose definition is found nowhere is left alone; it loads
 * as `needsReview` (definition missing) and the admin decides.
 *
 * Idempotent: an installation that has a valid version is never touched, so
 * a second run changes nothing. Values, actions, auth and credentials are not
 * read or written.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const version = '207';
export const description = 'integration_definition_version_baseline';

const INTEGRATIONS_FILE = 'config/integrations.json';
const DEFINITIONS_DIR = 'integration-definitions';
const DEFINITION_FILE = 'integration.json';

// Snapshot of `isStrictSemver` (validators/integrationDefinitionSchema.js) as
// of V207: MAJOR.MINOR.PATCH with an optional prerelease, no leading zeros,
// no `v` prefix, no build metadata. Do NOT replace with an import —
// migrations must be self-contained.

/** A MAJOR, MINOR or PATCH number: digits without a leading zero. */
const VERSION_NUMBER = /^(?:0|[1-9]\d*)$/;

/** One dot-separated prerelease identifier: a number without a leading zero, or alphanumerics and `-` with at least one non-digit. */
const PRERELEASE_IDENTIFIER = /^(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)$/;

/**
 * Whether a value is a version in the exact form a definition writes it:
 * `MAJOR.MINOR.PATCH`, optionally `-` and dot-separated prerelease
 * identifiers (`1.4.0`, `2.0.0-rc.1`), at most 64 characters. The numbers
 * hold no `-`, so the first `-` starts the prerelease.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStrictVersion(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const dash = value.indexOf('-');
  const core = dash < 0 ? value : value.slice(0, dash);
  const numbers = core.split('.');
  if (numbers.length !== 3 || !numbers.every(part => VERSION_NUMBER.test(part))) return false;
  return (
    dash < 0 ||
    value
      .slice(dash + 1)
      .split('.')
      .every(id => PRERELEASE_IDENTIFIER.test(id))
  );
}

/**
 * The definitions in one tree: definition id → version. Unreadable folders,
 * dot-folders (staging, backups) and definitions without a valid id or
 * version are skipped.
 *
 * @param {string} root - absolute folder holding definition folders
 * @returns {Promise<Map<string, string>>}
 */
export async function readDefinitionVersions(root) {
  const versions = new Map();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return versions;
    throw error;
  }
  const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  // Independent reads that never throw (unreadable is null); applied in folder order.
  const definitions = await Promise.all(
    folders.map(entry => readDefinition(join(root, entry.name, DEFINITION_FILE)))
  );
  for (const definition of definitions) {
    if (typeof definition?.id !== 'string' || !isStrictVersion(definition.version)) continue;
    versions.set(definition.id, definition.version);
  }
  return versions;
}

/** A parsed definition file, or null when it cannot be read or parsed. */
async function readDefinition(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Stamp the baseline on the installations of a parsed `integrations.json`.
 *
 * @param {{ installed?: Array<object> }} config - modified in place
 * @param {Map<string, string>} versions - definition id → version
 * @returns {{ stamped: Array<{ id: string, version: string, previous: unknown }>, missing: string[] }}
 */
export function stampBaseline(config, versions) {
  const stamped = [];
  const missing = [];
  for (const instance of Array.isArray(config?.installed) ? config.installed : []) {
    if (!instance || typeof instance !== 'object') continue;
    if (isStrictVersion(instance.definitionVersion)) continue;
    const found = versions.get(instance.definition);
    if (!found) {
      missing.push(instance.id);
      continue;
    }
    stamped.push({ id: instance.id, version: found, previous: instance.definitionVersion });
    instance.definitionVersion = found;
  }
  return { stamped, missing };
}

export async function precondition(ctx) {
  return await ctx.fileExists(INTEGRATIONS_FILE);
}

export async function up(ctx) {
  const config = await ctx.readJson(INTEGRATIONS_FILE);
  if (!Array.isArray(config?.installed) || config.installed.length === 0) {
    ctx.log('No installed integrations; nothing to stamp');
    return;
  }
  // Shipped first, installed second: an installed definition wins at load,
  // as it does in the integration registry.
  const versions = await readDefinitionVersions(join(ctx.defaultsDir, DEFINITIONS_DIR));
  for (const [id, found] of await readDefinitionVersions(join(ctx.contentsDir, DEFINITIONS_DIR))) {
    versions.set(id, found);
  }
  const { stamped, missing } = stampBaseline(config, versions);
  if (stamped.length > 0) {
    await ctx.writeJson(INTEGRATIONS_FILE, config);
    ctx.log(
      `Stamped the definition version baseline on ${stamped.length} installation(s): ${stamped
        .map(entry => `${entry.id}@${entry.version}`)
        .join(', ')}`
    );
  } else {
    ctx.log('Every installation already records a valid definition version');
  }
  if (missing.length > 0) {
    ctx.warn(
      `No definition found for ${missing.join(', ')}; left without a version, these load as "needs review"`
    );
  }
}
