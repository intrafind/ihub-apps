// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The code a `script` definition may bring: exactly one file, its entry
 * module, with nothing imported from the folder.
 *
 * The native adapter imports the entry module with a cache-buster in the URL
 * (`?v=<version>-<mtime>`), so a re-installed folder runs fresh code. That
 * applies to the entry module only: a relative `import './lib.js'` inside it
 * resolves to the plain file URL, which Node's module cache already holds from
 * the previous version, so a fix shipped in a helper file would silently not
 * take effect until the server restarts. Connectors are therefore bundled into
 * one file (esbuild, rollup) before they are published, and both the install
 * (`ContentInstaller.verifyIntegrationCode`) and the write of the folder
 * (`IntegrationRegistry.writeInstalled`) refuse anything else.
 */

/** A file that Node would run. */
export const CODE_FILE_PATTERN = /\.(m?js|cjs)$/i;

/**
 * A relative import of a sibling in ESM or CommonJS form: `from './x'`,
 * `import './x'`, `import('./x')`, `export … from '../x'`, `require('./x')`.
 * A plain text check over the source, comments and strings included, so a
 * connector that mentions one in a comment is refused too; the error says so.
 */
const RELATIVE_IMPORT_PATTERN = /\b(?:from|import|require)\s*\(?\s*['"`](\.{1,2}\/[^'"`]*)['"`]/g;

/**
 * Check the code files of a `script` definition folder.
 *
 * @param {{ id: string, protocol: { type: string, module?: string } }} definition - validated definition
 * @param {Record<string, string|object>} files - relative path → content, as `writeInstalled` takes them
 * @throws {Error & { code: 'SCRIPT_EXTRA_CODE_FILES' | 'SCRIPT_RELATIVE_IMPORT' }}
 */
export function checkScriptCodeFiles(definition, files) {
  if (definition?.protocol?.type !== 'script') return;
  const moduleFile = definition.protocol.module;
  const extra = Object.keys(files)
    .filter(file => CODE_FILE_PATTERN.test(file) && file !== moduleFile)
    .sort();
  if (extra.length) {
    const error = new Error(
      `Integration ${definition.id}: a script integration carries one code file, its module ` +
        `"${moduleFile}"; bundle the connector into it and drop ${extra.join(', ')}`
    );
    error.code = 'SCRIPT_EXTRA_CODE_FILES';
    throw error;
  }
  const source = files[moduleFile];
  if (typeof source !== 'string') return;
  const imports = [...source.matchAll(RELATIVE_IMPORT_PATTERN)].map(match => match[1]);
  if (imports.length) {
    const error = new Error(
      `Integration ${definition.id}: the module "${moduleFile}" imports ${[...new Set(imports)].join(', ')} ` +
        'from its folder; a connector is bundled into one file, because only the module itself is ' +
        'reloaded when the integration is updated (this is a text check over the source, so the ' +
        'path must not appear in a comment either)'
    );
    error.code = 'SCRIPT_RELATIVE_IMPORT';
    throw error;
  }
}
