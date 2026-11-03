// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import crypto from 'node:crypto';
import { migrationModuleFiles } from '../../../validators/integrationDefinitionSchema.js';

/**
 * The code a definition may bring, and the hash check every code file of a
 * marketplace package passes.
 *
 * A `script` definition brings its entry module (the connector), and any
 * definition may bring migration modules (`migrations/<name>.js`, named by
 * `module` steps of its `migrations`, versioning phase 3). Each is exactly one
 * file with nothing imported from the folder.
 *
 * The native adapter imports the connector with a cache-buster in the URL
 * (`?v=<version>-<mtime>`), so a re-installed folder runs fresh code. That
 * applies to the entry module only: a relative `import './lib.js'` inside it
 * resolves to the plain file URL, which Node's module cache already holds from
 * the previous version, so a fix shipped in a helper file would silently not
 * take effect until the server restarts. Migration modules are imported from
 * the hashed bytes themselves (`migrationModules.js`), where a relative import
 * cannot resolve at all. Code is therefore bundled into one file (esbuild,
 * rollup) before it is published, and both the install
 * (`ContentInstaller.verifyIntegrationCode`) and the write of the folder
 * (`IntegrationRegistry.writeInstalled`) refuse anything else.
 */

/** A file that Node would run. */
export const CODE_FILE_PATTERN = /\.(m?js|cjs)$/i;

/**
 * A relative import of a sibling in ESM or CommonJS form: `from './x'`,
 * `import './x'`, `import('./x')`, `export … from '../x'`, `require('./x')`.
 * A plain text check over the source, comments and strings included, so a
 * module that mentions one in a comment is refused too; the error says so.
 */
const RELATIVE_IMPORT_PATTERN = /\b(?:from|import|require)\s*\(?\s*['"`](\.{1,2}\/[^'"`]*)['"`]/g;

/**
 * The relative imports a source names, each once.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function relativeImportsOf(source) {
  if (typeof source !== 'string') return [];
  return [...new Set([...source.matchAll(RELATIVE_IMPORT_PATTERN)].map(match => match[1]))];
}

/**
 * The code files a definition may carry: the connector of a `script`
 * definition and the migration modules its `module` steps name.
 *
 * @param {{ protocol?: { type?: string, module?: string }, migrations?: Array<object> }} definition
 * @returns {string[]}
 */
export function declaredCodeFiles(definition) {
  const files = [];
  if (definition?.protocol?.type === 'script' && definition.protocol.module) {
    files.push(definition.protocol.module);
  }
  for (const file of migrationModuleFiles(definition?.migrations)) {
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * Check the code files of a `script` definition folder.
 *
 * @param {{ id: string, protocol: { type: string, module?: string }, migrations?: Array<object> }} definition - validated definition
 * @param {Record<string, string|object>} files - relative path → content, as `writeInstalled` takes them
 * @throws {Error & { code: 'SCRIPT_EXTRA_CODE_FILES' | 'SCRIPT_RELATIVE_IMPORT' }}
 */
export function checkScriptCodeFiles(definition, files) {
  if (definition?.protocol?.type !== 'script') return;
  const moduleFile = definition.protocol.module;
  const allowed = new Set(declaredCodeFiles(definition));
  const extra = Object.keys(files)
    .filter(file => CODE_FILE_PATTERN.test(file) && !allowed.has(file))
    .sort((a, b) => a.localeCompare(b));
  if (extra.length) {
    const error = new Error(
      `Integration ${definition.id}: a script integration carries one code file, its module ` +
        `"${moduleFile}" (and the migration modules its migrations name); bundle the connector ` +
        `into it and drop ${extra.join(', ')}`
    );
    error.code = 'SCRIPT_EXTRA_CODE_FILES';
    throw error;
  }
  const imports = relativeImportsOf(files[moduleFile]);
  if (imports.length) {
    const error = new Error(
      `Integration ${definition.id}: the module "${moduleFile}" imports ${imports.join(', ')} ` +
        'from its folder; a connector is bundled into one file, because only the module itself is ' +
        'reloaded when the integration is updated (this is a text check over the source, so the ' +
        'path must not appear in a comment either)'
    );
    error.code = 'SCRIPT_RELATIVE_IMPORT';
    throw error;
  }
}

/**
 * Check the migration modules a definition's `module` steps name against
 * the package files: each is present as text and imports nothing from the
 * folder. Applies to every protocol.
 *
 * @param {{ id: string, migrations?: Array<object> }} definition - validated definition
 * @param {Record<string, string|object>} files - relative path → content
 * @throws {Error & { code: 'MIGRATION_MODULE_MISSING' | 'MIGRATION_MODULE_RELATIVE_IMPORT' }}
 */
export function checkMigrationModuleFiles(definition, files) {
  for (const file of migrationModuleFiles(definition?.migrations)) {
    if (typeof files[file] !== 'string') {
      const error = new Error(
        `Integration ${definition.id}: the migration module "${file}" is missing from the integration files`
      );
      error.code = 'MIGRATION_MODULE_MISSING';
      throw error;
    }
    const imports = relativeImportsOf(files[file]);
    if (imports.length) {
      const error = new Error(
        `Integration ${definition.id}: the migration module "${file}" imports ${imports.join(', ')} ` +
          'from its folder; a migration module is bundled into one file (this is a text check ' +
          'over the source, so the path must not appear in a comment either)'
      );
      error.code = 'MIGRATION_MODULE_RELATIVE_IMPORT';
      throw error;
    }
  }
}

/**
 * Whether `text` has the hash `expected` (`sha256-<base64>` or a hex digest),
 * the form a catalog's `source.integrity` lists per file.
 *
 * @param {string} text
 * @param {string} expected
 * @returns {boolean}
 */
export function matchesIntegrity(text, expected) {
  if (typeof expected !== 'string' || !expected) return false;
  const digest = crypto.createHash('sha256').update(text, 'utf8');
  const value = expected.startsWith('sha256-') ? expected.slice('sha256-'.length) : expected;
  if (/^[0-9a-f]{64}$/i.test(value)) return digest.digest('hex') === value.toLowerCase();
  return digest.digest('base64') === value;
}
