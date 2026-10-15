import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fsp from 'fs/promises';

const fs = fsp;
import { join } from 'path';
import { tmpdir } from 'os';
import {
  stageAndSwapContents,
  pruneImportBackups,
  IMPORT_BACKUPS_DIR
} from '../routes/admin/backup.js';

const BACKUP_NAME = '2026-10-15T12-00-00-000Z';

/** A filesystem error the way Node reports one. */
function fsError(code, message, details = {}) {
  return Object.assign(new Error(`${code}: ${message}`), { code, ...details });
}

/**
 * Make fs.rename fail with the error `pickError` returns for a move, and do
 * every other move for real.
 */
function failRenames(pickError) {
  const originalRename = fsp.rename;
  mock.method(fsp, 'rename', (src, dest) => {
    const error = pickError(src, dest);
    return error ? Promise.reject(error) : originalRename(src, dest);
  });
}

describe('stageAndSwapContents', () => {
  let workDir = '';
  let contentsPath = '';
  let extractRoot = '';
  let extractedContentsPath = '';
  let backupsRoot = '';
  let backupPath = '';

  const swap = (overrides = {}) =>
    stageAndSwapContents({
      contentsPath,
      extractedContentsPath,
      extractRoot,
      backupName: BACKUP_NAME,
      ...overrides
    });

  beforeEach(async () => {
    workDir = join(
      tmpdir(),
      `backup-swap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(workDir, { recursive: true });

    contentsPath = join(workDir, 'contents');
    extractRoot = join(workDir, 'extracted');
    extractedContentsPath = join(extractRoot, 'contents');
    backupsRoot = join(contentsPath, IMPORT_BACKUPS_DIR);
    backupPath = join(backupsRoot, BACKUP_NAME);

    await fs.mkdir(join(contentsPath, 'apps'), { recursive: true });
    await fs.writeFile(join(contentsPath, 'apps', 'old.json'), JSON.stringify({ old: true }));
    await fs.writeFile(join(contentsPath, '.encryption-key'), 'old-key');

    await fs.mkdir(join(extractedContentsPath, 'apps'), { recursive: true });
    await fs.writeFile(
      join(extractedContentsPath, 'apps', 'new.json'),
      JSON.stringify({ new: true })
    );
    await fs.writeFile(join(extractedContentsPath, 'new-root.json'), '{}');
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.chmod(workDir, 0o755);
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('activates the new contents and keeps the old ones in .backups/<name>', async () => {
    const result = await swap();

    assert.strictEqual(result, backupPath);
    assert.deepStrictEqual((await fs.readdir(contentsPath)).sort(), [
      IMPORT_BACKUPS_DIR,
      'apps',
      'new-root.json'
    ]);
    assert.deepStrictEqual(await fs.readdir(join(contentsPath, 'apps')), ['new.json']);

    assert.deepStrictEqual((await fs.readdir(backupPath)).sort(), ['.encryption-key', 'apps']);
    assert.deepStrictEqual(await fs.readdir(join(backupPath, 'apps')), ['old.json']);

    // Only the backup is left in .backups, no staging folder.
    assert.deepStrictEqual(await fs.readdir(backupsRoot), [BACKUP_NAME]);
  });

  it('never renames the contents directory itself (a volume mount point in containers)', async () => {
    failRenames((src, dest) =>
      src === contentsPath || dest === contentsPath
        ? fsError('EBUSY', `resource busy or locked, rename '${src}'`)
        : null
    );

    await swap();

    assert.deepStrictEqual(await fs.readdir(join(contentsPath, 'apps')), ['new.json']);
  });

  it('works when the parent of the contents directory is not writable', async t => {
    if (process.getuid?.() === 0) {
      t.skip('root ignores directory permissions');
      return;
    }
    await fs.mkdir(join(extractRoot), { recursive: true });
    await fs.chmod(workDir, 0o555);

    await swap();

    assert.deepStrictEqual(await fs.readdir(join(contentsPath, 'apps')), ['new.json']);
  });

  it('keeps the backups of earlier imports in place', async () => {
    await fs.mkdir(join(backupsRoot, 'earlier'), { recursive: true });
    await fs.writeFile(join(backupsRoot, 'earlier', 'kept.json'), '{}');

    await swap();

    assert.deepStrictEqual((await fs.readdir(backupsRoot)).sort(), [BACKUP_NAME, 'earlier']);
    assert.deepStrictEqual(await fs.readdir(join(backupsRoot, 'earlier')), ['kept.json']);
  });

  it('does not import a .backups folder from the archive', async () => {
    await fs.mkdir(join(extractedContentsPath, IMPORT_BACKUPS_DIR, 'foreign'), {
      recursive: true
    });
    await fs.writeFile(join(extractedContentsPath, IMPORT_BACKUPS_DIR, 'foreign', 'x.json'), '{}');

    await swap();

    assert.deepStrictEqual(await fs.readdir(backupsRoot), [BACKUP_NAME]);
  });

  it('rejects an extractedContentsPath that escapes the extraction root', async () => {
    const outsideRoot = join(workDir, 'outside-extract-root');
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(join(outsideRoot, 'evil.json'), '{}');

    await assert.rejects(
      () => swap({ extractedContentsPath: outsideRoot }),
      /Refusing to stage imported configuration/
    );

    assert.deepStrictEqual(await fs.readdir(join(contentsPath, 'apps')), ['old.json']);
    await assert.rejects(() => fs.access(backupsRoot));
  });

  it('rejects a backup name that is not a plain folder name', async () => {
    for (const backupName of ['../escape', '.staging-x', 'a/b']) {
      await assert.rejects(() => swap({ backupName }), /backup name is invalid/);
    }
    await assert.rejects(() => fs.access(backupsRoot));
  });

  it('aborts without touching the live directory when staging fails', async () => {
    await assert.rejects(
      () => swap({ extractedContentsPath: join(extractRoot, 'does-not-exist') }),
      /Failed to stage the imported configuration/
    );

    assert.deepStrictEqual((await fs.readdir(contentsPath)).sort(), [
      IMPORT_BACKUPS_DIR,
      '.encryption-key',
      'apps'
    ]);
    assert.deepStrictEqual(await fs.readdir(backupsRoot), []);
  });

  it('aborts without touching the live directory when the backup name is taken', async () => {
    await fs.mkdir(backupPath, { recursive: true });
    await fs.writeFile(join(backupPath, 'placeholder.txt'), 'occupied');

    await assert.rejects(() => swap(), /Failed to stage the imported configuration/);

    assert.deepStrictEqual(await fs.readdir(join(contentsPath, 'apps')), ['old.json']);
    assert.deepStrictEqual(await fs.readdir(backupPath), ['placeholder.txt']);
    assert.deepStrictEqual(await fs.readdir(backupsRoot), [BACKUP_NAME]);
  });

  it('rolls back every move when one fails halfway through', async () => {
    // Fail while moving the staged entries in, after the old ones were moved out.
    failRenames((src, dest) =>
      dest === join(contentsPath, 'new-root.json')
        ? fsError('EBUSY', 'resource busy or locked')
        : null
    );

    const error = await swap().then(
      () => assert.fail('expected the swap to fail'),
      e => e
    );
    assert.match(error.message, /rolled back to the previous configuration/);
    assert.match(error.adminMessage, /separate mount point/);
    assert.match(error.adminMessage, /\(EBUSY\)$/);

    assert.deepStrictEqual((await fs.readdir(contentsPath)).sort(), [
      IMPORT_BACKUPS_DIR,
      '.encryption-key',
      'apps'
    ]);
    assert.deepStrictEqual(await fs.readdir(join(contentsPath, 'apps')), ['old.json']);
    assert.strictEqual(await fs.readFile(join(contentsPath, '.encryption-key'), 'utf8'), 'old-key');
    // No leftover backup or staging folders after the rollback.
    assert.deepStrictEqual(await fs.readdir(backupsRoot), []);
  });

  it('names a folder mounted separately inside contents, even when the error is EACCES', async () => {
    const appsPath = join(contentsPath, 'apps');
    // What a non-root user gets for renaming a mount point.
    failRenames((src, dest) =>
      src === appsPath
        ? fsError('EACCES', `permission denied, rename '${src}' -> '${dest}'`, { path: src, dest })
        : null
    );
    const originalReadFile = fsp.readFile;
    const realAppsPath = await fs.realpath(appsPath);
    mock.method(fsp, 'readFile', (file, ...rest) =>
      file === '/proc/self/mountinfo'
        ? Promise.resolve(
            `22 1 0:21 / / rw - overlay overlay rw\n35 22 8:1 /vol ${realAppsPath} rw - ext4 /dev/sda1 rw\n`
          )
        : originalReadFile(file, ...rest)
    );

    const error = await swap().then(
      () => assert.fail('expected the swap to fail'),
      e => e
    );
    assert.match(error.adminMessage, /rolled back to the previous configuration/);
    assert.match(error.adminMessage, /The folder "apps" in the contents directory is a separate/);
    assert.doesNotMatch(error.adminMessage, /not allowed to write/);
    assert.deepStrictEqual(await fs.readdir(appsPath), ['old.json']);
  });

  it('keeps backup and staging when the rollback itself fails', async () => {
    failRenames((src, dest) =>
      dest === join(contentsPath, 'new-root.json') ||
      (src === join(backupPath, 'apps') && dest === join(contentsPath, 'apps'))
        ? new Error('simulated rename failure')
        : null
    );

    await assert.rejects(
      () => swap(),
      /rollback failed as well; the previous configuration is in \.backups\//
    );

    assert.deepStrictEqual(await fs.readdir(join(backupPath, 'apps')), ['old.json']);
  });
});

describe('pruneImportBackups', () => {
  let contentsPath = '';
  let backupsRoot = '';

  beforeEach(async () => {
    contentsPath = join(
      tmpdir(),
      `backup-prune-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    backupsRoot = join(contentsPath, IMPORT_BACKUPS_DIR);
    await fs.mkdir(backupsRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(contentsPath, { recursive: true, force: true });
  });

  it('keeps the three newest backups', async () => {
    const names = [
      '2026-01-01T00-00-00-000Z',
      '2026-02-01T00-00-00-000Z',
      '2026-03-01T00-00-00-000Z',
      '2026-04-01T00-00-00-000Z',
      '2026-05-01T00-00-00-000Z'
    ];
    for (const name of names) {
      await fs.mkdir(join(backupsRoot, name));
    }

    await pruneImportBackups(contentsPath);

    assert.deepStrictEqual((await fs.readdir(backupsRoot)).sort(), names.slice(2));
  });

  it('removes stale staging folders but not one an import may still be filling', async () => {
    const stale = join(backupsRoot, '.staging-stale');
    const fresh = join(backupsRoot, '.staging-fresh');
    await fs.mkdir(stale);
    await fs.mkdir(fresh);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale, twoHoursAgo, twoHoursAgo);

    await pruneImportBackups(contentsPath);

    assert.deepStrictEqual(await fs.readdir(backupsRoot), ['.staging-fresh']);
  });

  it('does nothing when there are no backups yet', async () => {
    await fs.rm(backupsRoot, { recursive: true });
    await pruneImportBackups(contentsPath);
    await assert.rejects(() => fs.access(backupsRoot));
  });
});
