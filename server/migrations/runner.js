/**
 * Config Migration Runner
 *
 * Discovers and runs numbered migration scripts in this directory.
 * Each migration file must export:
 *   - id        {string}   Unique migration identifier (e.g. '001-skills-config')
 *   - describe  {string}   Human-readable description shown in logs
 *   - run       {Function} async () => void  — applies the migration
 *
 * Applied migrations are recorded in contents/config/migrations.json so
 * every migration runs exactly once, even across server restarts.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRootDir } from '../pathUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLIED_FILE_PATH = () => path.join(getRootDir(), 'contents', 'config', 'migrations.json');

/**
 * Load the set of already-applied migration IDs.
 * @returns {Promise<Set<string>>}
 */
async function loadApplied() {
  try {
    const raw = await fs.readFile(APPLIED_FILE_PATH(), 'utf8');
    const data = JSON.parse(raw);
    return new Set(Array.isArray(data.applied) ? data.applied : []);
  } catch {
    return new Set();
  }
}

/**
 * Persist the updated set of applied migration IDs.
 * @param {Set<string>} applied
 */
async function saveApplied(applied) {
  const filePath = APPLIED_FILE_PATH();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ applied: [...applied].sort() }, null, 2), 'utf8');
}

/**
 * Discover all migration modules in this directory (files matching NNN-*.js).
 * @returns {Promise<Array<{ id: string, describe: string, run: Function }>>}
 */
async function discoverMigrations() {
  const entries = await fs.readdir(__dirname);
  const migrationFiles = entries.filter(f => /^\d{3}-.*\.js$/.test(f)).sort(); // run in lexicographic (numbered) order

  const migrations = [];
  for (const file of migrationFiles) {
    const mod = await import(path.join(__dirname, file));
    if (typeof mod.run !== 'function' || !mod.id) {
      console.warn(`[migrations] Skipping ${file}: missing 'id' or 'run' export`);
      continue;
    }
    migrations.push({ id: mod.id, describe: mod.describe || file, run: mod.run });
  }
  return migrations;
}

/**
 * Run all pending migrations.
 * Should be called once at server startup before configCache.initialize().
 */
export async function runMigrations() {
  let applied;
  let migrations;

  try {
    applied = await loadApplied();
    migrations = await discoverMigrations();
  } catch (err) {
    console.error('[migrations] Failed to load migrations:', err.message);
    return;
  }

  const pending = migrations.filter(m => !applied.has(m.id));

  if (pending.length === 0) {
    console.log('[migrations] All migrations already applied.');
    return;
  }

  console.log(`[migrations] Running ${pending.length} pending migration(s)…`);

  for (const migration of pending) {
    try {
      console.log(`[migrations] ▶ ${migration.id}: ${migration.describe}`);
      await migration.run();
      applied.add(migration.id);
      await saveApplied(applied);
      console.log(`[migrations] ✔ ${migration.id} completed`);
    } catch (err) {
      console.error(`[migrations] ✖ ${migration.id} failed:`, err.message);
      // Do not mark as applied — it will retry on next startup
    }
  }
}
