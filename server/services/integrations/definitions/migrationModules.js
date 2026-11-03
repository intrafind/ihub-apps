// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs } from 'node:fs';
import { resolveAndValidatePath } from '../../../utils/pathSecurity.js';
import {
  MIGRATION_MODULE_PATTERN,
  migrationModuleFiles
} from '../../../validators/integrationDefinitionSchema.js';
import { matchesIntegrity, relativeImportsOf } from './scriptModule.js';

/**
 * Migration modules (versioning concept §1, phase 3): the `module` steps of
 * a definition's migrations name JavaScript files of the definition folder
 * (`migrations/1.4.0.js`) whose `up()` rewrites an installation in code.
 *
 * A module runs only when the code is trusted, with the rule of the `script`
 * protocol (`ContentInstaller.verifyIntegrationCode`):
 *
 * - a **built-in** definition (shipped with the server) always;
 * - an **installed** definition only when the registry it came from is
 *   trusted for code (`trustCode`) and the catalog listed a hash for the file
 *   (`source.integrity`), which the file must match. The marketplace update
 *   passes the registry's flag and the catalog's hashes of the package it just
 *   fetched; a later run (re-run, manual migration) reads the registry's
 *   current flag and the hashes the installation manifest recorded
 *   (`codeIntegrity`) when the package was installed.
 *
 * The hash is checked over the bytes read, and those very bytes are imported
 * (as a `data:` module URL), so the file cannot change between the check and
 * the run; a module therefore cannot import a sibling file either (the text
 * check of `scriptModule.js` refuses one with a clear message, like for a
 * connector). Every module of a run is loaded and checked before the first
 * step runs, so an untrusted or tampered module fails the migration before
 * any code executes.
 *
 * The module is trusted code in the server process; the "sandbox" is the
 * contract, which the planner enforces on the result
 * (`migrationPlanner.planMigrationAsync`): `up()` gets copies, never the
 * installation's `auth` block or a credential, may change `values` and
 * `actions` of the instance and the binding entries of the apps it is given,
 * and nothing else is written. A run that takes longer than
 * {@link MODULE_TIMEOUT_MS} fails.
 *
 * @module services/integrations/definitions/migrationModules
 */

/** How long one `up()` may take. */
export const MODULE_TIMEOUT_MS = 30_000;

/** Error codes of a module that may not or cannot run. */
export const MODULE_ERRORS = Object.freeze({
  NOT_TRUSTED: 'MIGRATION_MODULE_NOT_TRUSTED',
  INTEGRITY_REQUIRED: 'MIGRATION_MODULE_INTEGRITY_REQUIRED',
  INTEGRITY_MISMATCH: 'MIGRATION_MODULE_INTEGRITY_MISMATCH',
  MISSING: 'MIGRATION_MODULE_MISSING',
  RELATIVE_IMPORT: 'MIGRATION_MODULE_RELATIVE_IMPORT',
  NO_UP: 'MIGRATION_MODULE_NO_UP',
  TIMEOUT: 'MIGRATION_MODULE_TIMEOUT'
});

function moduleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Whether code of a definition may run here, and against which hashes.
 *
 * @typedef {object} ModuleTrust
 * @property {boolean} builtIn - the definition ships with the server
 * @property {boolean} trustCode - its registry is trusted for code
 * @property {Record<string, string>} integrity - path → hash the catalog listed
 * @property {string} [source] - where the trust was read from, for messages
 */

/**
 * Read, check and import one migration module.
 *
 * @param {object} input
 * @param {string} input.definitionId - for messages
 * @param {string} input.dir - the definition folder (absolute)
 * @param {string} input.file - the module path as the step names it
 * @param {ModuleTrust} input.trust
 * @returns {Promise<(context: object) => unknown>} the module's `up`
 * @throws {Error} with a {@link MODULE_ERRORS} code
 */
export async function loadMigrationModule({ definitionId, dir, file, trust }) {
  const label = `Integration ${definitionId}: migration module "${file}"`;
  if (!trust?.builtIn && trust?.trustCode !== true) {
    throw moduleError(
      MODULE_ERRORS.NOT_TRUSTED,
      `${label} is code, and the registry the definition came from is not trusted for code${trust?.source ? ` (${trust.source})` : ''}; only declarative steps run for it`
    );
  }
  if (typeof file !== 'string' || !MIGRATION_MODULE_PATTERN.test(file)) {
    throw moduleError(MODULE_ERRORS.MISSING, `${label} is not a path a module may have`);
  }
  const expected = trust.builtIn ? null : trust.integrity?.[file];
  if (!trust.builtIn && !expected) {
    throw moduleError(
      MODULE_ERRORS.INTEGRITY_REQUIRED,
      `${label} has no hash in the catalog the definition was installed from; a module runs only when its hash was listed`
    );
  }
  const target = dir ? await resolveAndValidatePath(file, dir) : null;
  if (!target) throw moduleError(MODULE_ERRORS.MISSING, `${label} leaves the definition folder`);
  let source;
  try {
    source = await fs.readFile(target, 'utf8');
  } catch {
    throw moduleError(MODULE_ERRORS.MISSING, `${label} is missing from the definition folder`);
  }
  if (expected && !matchesIntegrity(source, expected)) {
    throw moduleError(
      MODULE_ERRORS.INTEGRITY_MISMATCH,
      `${label} does not match the hash the catalog listed; it was changed after it was installed`
    );
  }
  const imports = relativeImportsOf(source);
  if (imports.length) {
    throw moduleError(
      MODULE_ERRORS.RELATIVE_IMPORT,
      `${label} imports ${imports.join(', ')} from its folder; a migration module is bundled into one file`
    );
  }
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  const loaded = await import(url);
  const up = typeof loaded.up === 'function' ? loaded.up : loaded.default?.up;
  const fn = typeof up === 'function' ? up : loaded.default;
  if (typeof fn !== 'function') {
    throw moduleError(MODULE_ERRORS.NO_UP, `${label} exports no function up()`);
  }
  return fn;
}

/**
 * Load every module the migrations of a run name, before any of them runs.
 *
 * @param {object} input
 * @param {string} input.definitionId
 * @param {string} input.dir - the definition folder the modules are read from
 * @param {Array<{ steps?: Array<object> }>} input.migrations - the migrations of the run
 * @param {ModuleTrust} input.trust
 * @returns {Promise<Map<string, Function>>} file → `up`, empty without module steps
 * @throws {Error} the first module that may not or cannot run
 */
export async function loadMigrationModules({ definitionId, dir, migrations, trust }) {
  const modules = new Map();
  // Sequential on purpose: the first module refused names the error, and none ran.
  for (const file of migrationModuleFiles(migrations)) {
    modules.set(file, await loadMigrationModule({ definitionId, dir, file, trust }));
  }
  return modules;
}

/**
 * Run a module's `up()` with a time limit.
 *
 * @param {Function} up
 * @param {object} context - what the planner hands the module
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>} what `up()` returned
 */
export async function runMigrationModule(up, context, timeoutMs = MODULE_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          moduleError(
            MODULE_ERRORS.TIMEOUT,
            `the migration module took longer than ${timeoutMs} ms`
          )
        ),
      timeoutMs
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(() => up(context)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
