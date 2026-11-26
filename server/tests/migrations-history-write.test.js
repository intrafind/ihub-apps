// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A migration that ran is not a failed migration when only writing the history
 * fails (issue #3998: a virus scanner holding .migration-history.json on
 * Windows). Runs the real runner against a temp contents and migrations dir;
 * the history is made unwritable by putting a directory where the file goes.
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runConfigMigrations } from '../migrations/runner.js';

const HISTORY = '.migration-history.json';

/** A migration whose up() writes a marker, then runs `body` (source code). */
const migrationSource = (version, body = '') => `
import fs from 'node:fs/promises';
export const version = '${version}';
export const description = 'test ${version}';
export async function up(ctx) {
  await ctx.writeJson('marker-${version}.json', { ran: true });
  ${body}
}
`;

describe('migration history write failures', () => {
  let tmp;
  let contentsDir;
  let migrationsDir;
  let historyPath;

  const run = () =>
    runConfigMigrations({
      contentsDir,
      migrationsDir,
      defaultsDir: path.join(tmp, 'defaults'),
      freshlySeeded: false
    });
  const readHistory = async () => JSON.parse(await fs.readFile(historyPath, 'utf8'));
  const writeMigration = (file, source) => fs.writeFile(path.join(migrationsDir, file), source);
  const setOnFailure = onFailure =>
    fs.writeFile(
      path.join(contentsDir, 'config', 'platform.json'),
      JSON.stringify({ migrations: { onFailure } })
    );
  // Replace the history file with a directory, so renaming onto it fails.
  const blockHistory = () =>
    `await fs.rm(${JSON.stringify(historyPath)}, { force: true });
     await fs.mkdir(${JSON.stringify(historyPath)});`;
  const unblockHistory = () =>
    `await fs.rm(${JSON.stringify(historyPath)}, { recursive: true, force: true });`;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-history-write-'));
    contentsDir = path.join(tmp, 'contents');
    migrationsDir = path.join(tmp, 'migrations');
    historyPath = path.join(contentsDir, HISTORY);
    await fs.mkdir(path.join(contentsDir, 'config'), { recursive: true });
    await fs.mkdir(migrationsDir, { recursive: true });
    await fs.mkdir(path.join(tmp, 'defaults'), { recursive: true });
    await fs.writeFile(
      historyPath,
      JSON.stringify({
        schemaVersion: '1.0',
        migrations: [{ version: '030', description: 'baseline', status: 'success' }]
      })
    );
    await setOnFailure('halt');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('halts with a history-write error, not a failed migration, when the migration ran', async () => {
    await writeMigration('V031__blocks.js', migrationSource('031', blockHistory()));
    await writeMigration('V032__later.js', migrationSource('032'));

    const error = await run().then(
      () => null,
      e => e
    );
    expect(error).not.toBeNull();
    expect(error.migrationHalt).toBe(true);
    expect(error.historyWriteFailed).toBe(true);
    expect(error.message).toMatch(/^Migration V031 \(blocks\) ran, but recording it in/);
    expect(error.message).not.toMatch(/failed: Migration/);
    // It stopped there: the next migration did not run unrecorded.
    await expect(fs.access(path.join(contentsDir, 'marker-032.json'))).rejects.toThrow();
  });

  it('with onFailure "continue", writes the row with the next save and records no failure', async () => {
    await setOnFailure('continue');
    await writeMigration('V031__blocks.js', migrationSource('031', blockHistory()));
    await writeMigration('V032__unblocks.js', migrationSource('032', unblockHistory()));

    const result = await run();
    expect(result).toEqual({ applied: 2, skipped: 0, failed: 0 });

    const rows = (await readHistory()).migrations.filter(m => m.version !== '030');
    expect(rows.map(m => [m.version, m.status])).toEqual([
      ['031', 'success'],
      ['032', 'success']
    ]);
  });

  it("reports the migration's own error when its failure cannot be recorded either", async () => {
    await writeMigration(
      'V031__breaks.js',
      migrationSource('031', `${blockHistory()}\n  throw new Error('bad config shape');`)
    );

    await expect(run()).rejects.toThrow('Migration V031 (breaks) failed: bad config shape');
  });

  it('still records a failed row when the migration itself fails', async () => {
    await writeMigration('V031__breaks.js', migrationSource('031', "throw new Error('nope');"));

    await expect(run()).rejects.toThrow('Migration V031 (breaks) failed: nope');
    const rows = (await readHistory()).migrations.filter(m => m.version === '031');
    expect(rows).toEqual([expect.objectContaining({ status: 'failed', error: 'nope' })]);
  });
});
