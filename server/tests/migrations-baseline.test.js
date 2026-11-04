// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration baseline: V030 (release 5.3.0) is the oldest supported state.
 * Runs the real runner against a temp contents dir and a temp migrations dir.
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  runConfigMigrations,
  highestAppliedVersion,
  BASELINE_VERSION,
  BASELINE_RELEASE
} from '../migrations/runner.js';

const MIGRATION_SOURCE = (version, marker) => `
export const version = '${version}';
export const description = 'test ${version}';
export async function up(ctx) {
  await ctx.writeJson('marker-${marker}.json', { ran: '${version}' });
}
`;

describe('migration baseline', () => {
  let tmp;
  let contentsDir;
  let migrationsDir;
  let defaultsDir;

  const run = (opts = {}) =>
    runConfigMigrations({ contentsDir, migrationsDir, defaultsDir, freshlySeeded: false, ...opts });
  const readHistory = async () =>
    JSON.parse(await fs.readFile(path.join(contentsDir, '.migration-history.json'), 'utf8'));
  const writeHistory = migrations =>
    fs.writeFile(
      path.join(contentsDir, '.migration-history.json'),
      JSON.stringify({ schemaVersion: '1.0', migrations })
    );
  const setValidation = mode =>
    fs.writeFile(
      path.join(contentsDir, 'config', 'platform.json'),
      JSON.stringify({ migrations: { checksumValidation: mode } })
    );
  const exists = p =>
    fs.access(path.join(contentsDir, p)).then(
      () => true,
      () => false
    );
  const row = (version, extra = {}) => ({
    version,
    description: `d${version}`,
    file: `V${version}__d${version}.js`,
    checksum: 'checksum-of-a-file-that-no-longer-exists',
    appliedAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    ...extra
  });

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-baseline-'));
    contentsDir = path.join(tmp, 'contents');
    migrationsDir = path.join(tmp, 'migrations');
    defaultsDir = path.join(tmp, 'defaults');
    await fs.mkdir(path.join(contentsDir, 'config'), { recursive: true });
    await fs.mkdir(migrationsDir, { recursive: true });
    await fs.mkdir(defaultsDir, { recursive: true });
    await fs.writeFile(path.join(contentsDir, 'config', 'platform.json'), '{}');
    await fs.writeFile(path.join(migrationsDir, 'V031__first.js'), MIGRATION_SOURCE('031', 'a'));
    await fs.writeFile(path.join(migrationsDir, 'V032__second.js'), MIGRATION_SOURCE('032', 'b'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('declares V030 / release 5.3.0 as the baseline', () => {
    expect(BASELINE_VERSION).toBe('030');
    expect(BASELINE_RELEASE).toBe('5.3.0');
  });

  it('marks a fresh install as being at the baseline, then applies what is above it', async () => {
    const result = await run({ freshlySeeded: true });
    expect(result.applied).toBe(2);

    const history = await readHistory();
    expect(history.migrations.map(m => m.version)).toEqual(['030', '031', '032']);
    expect(history.migrations[0]).toMatchObject({ description: 'baseline', status: 'success' });
    // appliedAt of the first row is "this run": V204 reads it to detect a fresh install
    expect(Date.now() - Date.parse(history.migrations[0].appliedAt)).toBeLessThan(60_000);
  });

  it('treats an empty contents dir without platform.json as fresh', async () => {
    await fs.rm(path.join(contentsDir, 'config'), { recursive: true });
    await run();
    const history = await readHistory();
    expect(history.migrations[0].version).toBe('030');
  });

  it('refuses a contents dir with a configuration but no history, naming release 5.3.x', async () => {
    const error = await run().catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.belowBaseline).toBe(true);
    expect(error.message).toContain('5.3.x');
    expect(error.message).toContain('V030');
    expect(await exists('.migration-history.json')).toBe(false);
    expect(await exists('marker-a.json')).toBe(false);
  });

  it('refuses an install whose history ends below the baseline', async () => {
    await writeHistory([row('001'), row('015'), row('020')]);
    const error = await run().catch(e => e);
    expect(error.belowBaseline).toBe(true);
    expect(error.message).toContain('V020');
    expect(await exists('marker-a.json')).toBe(false);
  });

  it('computes the highest applied version from success and skipped rows only', () => {
    expect(
      highestAppliedVersion({
        migrations: [
          row('029'),
          row('030', { status: 'failed' }),
          row('025', { status: 'skipped' })
        ]
      })
    ).toBe(29);
    expect(highestAppliedVersion({ migrations: [] })).toBe(0);
  });

  it('keeps an install at the baseline working and applies V031 and up in order', async () => {
    await writeHistory([row('001'), row('030')]);
    const result = await run();
    expect(result.applied).toBe(2);
    const history = await readHistory();
    expect(history.migrations.map(m => m.version)).toEqual(['001', '030', '031', '032']);
  });

  it('does not validate history rows of removed versions, even in strict mode', async () => {
    await setValidation('strict');
    // 001..030 have recorded checksums and no files; strict mode must not throw
    await writeHistory(['001', '002', '018', '030'].map(v => row(v)));
    const result = await run();
    expect(result.applied).toBe(2);
  });

  it('still reports a removed file above the baseline in strict mode', async () => {
    await setValidation('strict');
    await writeHistory([row('030'), row('099')]);
    await expect(run()).rejects.toThrow(/V099/);
  });

  it('does not re-apply versions already recorded above the baseline', async () => {
    await setValidation('off');
    await writeHistory([row('030'), row('031', { checksum: null })]);
    const result = await run();
    expect(result.applied).toBe(1);
    expect(await exists('marker-a.json')).toBe(false);
    expect(await exists('marker-b.json')).toBe(true);
  });
});
