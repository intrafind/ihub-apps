import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fsp from 'fs/promises';

const fs = fsp;
import { join } from 'path';
import { tmpdir } from 'os';
import { stageAndSwapContents } from '../routes/admin/backup.js';

describe('stageAndSwapContents', () => {
  let workDir;
  let contentsPath;
  let extractedContentsPath;
  let stagingPath;
  let backupPath;

  beforeEach(async () => {
    workDir = join(
      tmpdir(),
      `backup-swap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(workDir, { recursive: true });

    contentsPath = join(workDir, 'contents');
    extractedContentsPath = join(workDir, 'extracted', 'contents');
    stagingPath = join(workDir, 'contents-staging');
    backupPath = join(workDir, 'contents-backup');

    await fs.mkdir(contentsPath, { recursive: true });
    await fs.writeFile(join(contentsPath, 'old.json'), JSON.stringify({ old: true }));

    await fs.mkdir(extractedContentsPath, { recursive: true });
    await fs.writeFile(join(extractedContentsPath, 'new.json'), JSON.stringify({ new: true }));
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it('moves the old contents to the backup path and activates the new contents', async () => {
    await stageAndSwapContents({ contentsPath, extractedContentsPath, stagingPath, backupPath });

    const liveFiles = await fs.readdir(contentsPath);
    assert.deepStrictEqual(liveFiles, ['new.json']);

    const backedUpFiles = await fs.readdir(backupPath);
    assert.deepStrictEqual(backedUpFiles, ['old.json']);

    await assert.rejects(() => fs.access(stagingPath));
  });

  it('aborts without touching the live directory when staging fails', async () => {
    const missingSource = join(workDir, 'does-not-exist');

    await assert.rejects(
      () =>
        stageAndSwapContents({
          contentsPath,
          extractedContentsPath: missingSource,
          stagingPath,
          backupPath
        }),
      /Failed to stage imported configuration/
    );

    const liveFiles = await fs.readdir(contentsPath);
    assert.deepStrictEqual(liveFiles, ['old.json']);
    await assert.rejects(() => fs.access(backupPath));
    await assert.rejects(() => fs.access(stagingPath));
  });

  it('aborts without touching the live directory when the safety-backup rename fails', async () => {
    // Pre-create backupPath as a non-empty directory so fs.rename(contentsPath, backupPath)
    // fails with ENOTEMPTY/EEXIST instead of succeeding.
    await fs.mkdir(backupPath, { recursive: true });
    await fs.writeFile(join(backupPath, 'placeholder.txt'), 'occupied');

    await assert.rejects(
      () => stageAndSwapContents({ contentsPath, extractedContentsPath, stagingPath, backupPath }),
      /Failed to back up the current configuration/
    );

    const liveFiles = await fs.readdir(contentsPath);
    assert.deepStrictEqual(liveFiles, ['old.json']);
    await assert.rejects(() => fs.access(stagingPath));
  });

  it('rolls back to the original contents when activating the staged directory fails', async () => {
    const originalRename = fsp.rename;
    let renameCalls = 0;
    mock.method(fsp, 'rename', async (src, dest) => {
      renameCalls += 1;
      if (renameCalls === 2) {
        throw new Error('simulated rename failure');
      }
      return originalRename(src, dest);
    });

    await assert.rejects(
      () => stageAndSwapContents({ contentsPath, extractedContentsPath, stagingPath, backupPath }),
      /Failed to activate imported configuration; rolled back/
    );

    // contentsPath restored from backup with the original data.
    const liveFiles = await fs.readdir(contentsPath);
    assert.deepStrictEqual(liveFiles, ['old.json']);
    // No leftover backup or staging directories after rollback.
    await assert.rejects(() => fs.access(backupPath));
    await assert.rejects(() => fs.access(stagingPath));
  });
});
