// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The legacy workflow path still imports parts of the removed Agent Factory
 * (#3773, #3784): the frozen executors read the agent validators, the memory
 * and inbox modules and the artifact store, and the applied migrations V052 to
 * V054 import the profile serializer. A module that was deleted with the
 * Agent Factory and is still imported breaks the legacy workflows, or stops an
 * upgrade from an old version at a migration.
 *
 * - Every executor under `server/services/workflow/executors/` and every
 *   migration module loads without an error.
 * - So do the modules kept for the legacy path, and the startup modules.
 * - No relative import in `server/` (static or `import()` with a literal)
 *   names a file that does not exist.
 *
 * A failure here is fixed by keeping the imported file, never by editing a
 * frozen executor or an applied migration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The order `sort()` has without a comparator, said out loud: by UTF-16 code unit. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every `.js` file below a directory of `server/`, relative to `server/`, sorted. */
function jsFilesBelow(directory, { skip = [] } = {}) {
  const root = path.join(SERVER, directory);
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.relative(SERVER, path.join(entry.parentPath, entry.name)))
    .map(file => file.split(path.sep).join('/'))
    .filter(file => !skip.some(part => file.split('/').includes(part)))
    .sort(byCodeUnit);
}

/** The modules the legacy path keeps until it is removed (#3784), and the startup modules. */
const KEPT = Object.freeze([
  'validators/agentProfileSchema.js',
  'validators/agentInboxSchema.js',
  'agents/profile/reviewSettings.js',
  'agents/profile/profileWorkflowSerializer.js',
  'agents/memory/memoryFile.js',
  'agents/inbox/inboxStore.js',
  'agents/runtime/agentToolRegistrar.js',
  'agents/runtime/artifactStore.js',
  'agents/runtime/taskRecord.js',
  'agents/runtime/titleGenerator.js',
  'tools/agentTools.js',
  'resourceLoaders.js',
  'services/workflow/WorkflowEngine.js',
  'services/workflow/agentFactoryRuns.js',
  'services/workflow/resumeManager.js',
  'services/workflow/orphanSweeper.js',
  'startup/routes.js',
  'startup/worker.js'
]);

const EXECUTORS = jsFilesBelow('services/workflow/executors');
const MIGRATIONS = jsFilesBelow('migrations').filter(file =>
  /^migrations\/V\d+__.+\.js$/.test(file)
);

async function importAll(files) {
  const failures = [];
  for (const file of files) {
    try {
      await import(pathToFileURL(path.join(SERVER, file)).href);
    } catch (error) {
      failures.push(`${file}: ${error.message}`);
    }
  }
  return failures;
}

test('every legacy executor loads', async () => {
  assert.ok(EXECUTORS.length > 20, `found only ${EXECUTORS.length} executors`);
  // Loaded the way the engine loads them, through the index first: a few executors are in an
  // import cycle with it, and one of them loaded on its own fails before the index is
  // initialised (a frozen file, so the cycle stays as it is).
  const index = 'services/workflow/executors/index.js';
  assert.deepEqual(await importAll([index, ...EXECUTORS.filter(file => file !== index)]), []);
});

test('every migration module loads', async () => {
  assert.ok(MIGRATIONS.length > 200, `found only ${MIGRATIONS.length} migrations`);
  assert.ok(MIGRATIONS.includes('migrations/V053__fix_inbox_item_text_accessor.js'));
  assert.deepEqual(await importAll(MIGRATIONS), []);
});

test('the modules kept for the legacy path and the startup modules load', async () => {
  assert.deepEqual(await importAll(KEPT), []);
});

/** Relative specifiers of `import … from '…'`, `export … from '…'` and `import('…')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"\n]+)\1/gm;

test('no relative import in server/ names a file that does not exist', () => {
  const missing = [];
  for (const file of jsFilesBelow('.', { skip: ['node_modules', 'tests'] })) {
    // Code only: doc comments carry import examples that are not imports.
    const source = fs
      .readFileSync(path.join(SERVER, file), 'utf8')
      .split('\n')
      .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    for (const match of source.matchAll(SPECIFIER)) {
      const target = path.resolve(path.dirname(path.join(SERVER, file)), match[2]);
      if (!fs.existsSync(target)) missing.push(`${file} -> ${match[2]}`);
    }
  }
  assert.deepEqual(missing, []);
});
