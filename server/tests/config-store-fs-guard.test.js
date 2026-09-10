/**
 * The CI guard that keeps configuration on the storage provider.
 *
 * The point of #2307 is not that today's call sites go through
 * `ConfigStore` — it is that tomorrow's do too. Nothing in the language stops
 * the next admin route from reaching for `atomicWriteJSON` again, and the
 * regression would be invisible until a database-backed provider shipped and
 * one endpoint kept writing to a file nobody reads. `scripts/check-config-fs-access.js`
 * is what makes that a build failure instead, so this file tests the guard the
 * only way a guard can be tested: by introducing the violation it exists to
 * catch and requiring it to fail.
 *
 * Four subsystems are excluded by reasoned exception rather than by having
 * been quietly skipped — the migration runner (it runs before any provider
 * exists, and its 89 migrations are checksum-frozen), `TokenStorageService`'s
 * key material (needed before a provider can be constructed, and not JSON
 * documents), `routes/admin/backup.js` (a directory zip and an `fs.rename`
 * swap of the live tree) and the builtin `shared/i18n` locales (outside
 * `contents/` entirely). The guard prints them with their reasons when it
 * runs, so the exceptions stay visible instead of becoming folklore, and the
 * test below asserts that they do.
 *
 * Contract: `CONFIG_STORE_CONTRACT.md` §1 and §7.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);

/** Repository root — the guard scans the tree relative to it. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The guard, as `package.json` invokes it. */
const GUARD = 'scripts/check-config-fs-access.js';

/**
 * The deliberate violation. Named so it is obvious in a `git status` if a run
 * is ever killed between writing and removing it, and placed in the directory
 * the guard cares most about — `routes/admin/` held 37 of the
 * `atomicWriteJSON` call sites this change converted.
 */
const PROBE = 'server/routes/admin/__config-access-guard-probe__.js';

/** A config write of exactly the shape the guard has to reject. */
const PROBE_SOURCE = `/**
 * Temporary fixture written by server/tests/config-store-fs-guard.test.js.
 * If this file is still here, a test run was killed between writing it and
 * removing it again — delete it.
 */
import { atomicWriteJSON } from '../../utils/atomicWrite.js';

/**
 * @param {Object} data - Platform configuration to write
 * @returns {Promise<void>}
 */
export async function writeProbeConfig(data) {
  await atomicWriteJSON('contents/config/platform.json', data);
}
`;

/**
 * Run the guard and report how it went, whatever its exit status.
 *
 * @returns {Promise<{code: number, output: string}>} Exit code and the
 *   combined stdout/stderr the guard produced
 */
async function runGuard() {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [GUARD], { cwd: REPO_ROOT });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

describe('the config filesystem-access guard', () => {
  it('exists and is wired into the scripts CI runs', async () => {
    await fs.access(path.join(REPO_ROOT, GUARD));
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.match(
      pkg.scripts['lint:config-access'] || '',
      /check-config-fs-access/,
      'lint:config-access runs the guard'
    );
    assert.match(
      pkg.scripts['test:quick'] || '',
      /lint:config-access/,
      'and test:quick runs it, or the guard only fires when somebody remembers to ask'
    );
  });

  it('prints the reasoned exclusions every time it runs', async () => {
    const { output } = await runGuard();
    for (const exclusion of [
      /migrations/i,
      /backup\.js/i,
      /i18n/i,
      /encryption-key|TokenStorage/i
    ]) {
      assert.match(
        output,
        exclusion,
        'an exception printed with its reason stays a decision; a silent skip becomes folklore'
      );
    }
  });

  it('reports no direct filesystem configuration access in the tree', async () => {
    const { code, output } = await runGuard();
    assert.equal(
      code,
      0,
      `configuration is still being read or written outside the store:\n${output}`
    );
  });

  it('fails when a config write is added outside the storage layer', async () => {
    // Differential rather than absolute: what has to be true is that the
    // guard reacts to this file, not that the rest of the tree happens to be
    // clean — that is the assertion above, and it should fail on its own.
    const baseline = await runGuard();
    assert.doesNotMatch(baseline.output, /__config-access-guard-probe__/, 'the probe is not there');

    const probePath = path.join(REPO_ROOT, PROBE);
    await fs.writeFile(probePath, PROBE_SOURCE, 'utf8');
    let planted;
    try {
      planted = await runGuard();
    } finally {
      await fs.rm(probePath, { force: true });
    }

    assert.notEqual(
      planted.code,
      0,
      'a direct atomicWriteJSON of a config path must fail the build.\n' +
        `The guard exited 0 with the violation in place at ${PROBE}. A guard that only ` +
        'scans git-tracked files would miss it — it has to scan the working tree.\n' +
        planted.output
    );
    assert.match(
      planted.output,
      /__config-access-guard-probe__/,
      'and it has to name the file, per file, so the failure is actionable'
    );

    const after = await runGuard();
    assert.doesNotMatch(after.output, /__config-access-guard-probe__/, 'the probe is gone again');
    assert.equal(after.code, baseline.code, 'and the guard is back to what it said before');
  });
});
