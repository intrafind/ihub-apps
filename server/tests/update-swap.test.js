// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The file swap behind in-place updates (server/update/swap.cjs): applying a
 * staged release, swap-on-start through the launcher, counting failed starts
 * and restoring the previous version, configuration snapshots, rollback.
 *
 * Run: node --test server/tests/update-swap.test.js
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import swap from '../update/swap.cjs';

let root;
let contents;

const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

/** An installed 1.0.0 plus a staged 2.0.0. */
function install() {
  write('version.txt', '1.0.0');
  write('server/server.js', 'old server');
  write('public/index.html', 'old ui');
  write('launcher.cjs', 'old launcher');
  write('node', 'old node');
  write('ihub-apps-v1.0.0-linux', '#!/bin/bash old');
  write('config.env', 'PORT=3000');
  write('contents/config/platform.json', '{"v":1}');
  write('contents/.migration-history.json', '{"migrations":[1]}');
  write('contents/.encryption-key', 'secret');

  write('.update-staging/version.txt', '2.0.0');
  write('.update-staging/server/server.js', 'new server');
  write('.update-staging/public/index.html', 'new ui');
  write('.update-staging/launcher.cjs', 'new launcher');
  write('.update-staging/node', 'new node');
  write('.update-staging/ihub-apps-v2.0.0-linux', '#!/bin/bash new');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-update-swap-'));
  contents = path.join(root, 'contents');
  install();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('swapInStaged / restoreBackup', () => {
  it('moves the staged release in and the old one into the backup', () => {
    const backupDir = swap.prepareBackupDir(root, { version: '1.0.0', targetVersion: '2.0.0' });
    swap.swapInStaged(root, { backupDir, platform: 'linux' });

    assert.equal(read('version.txt'), '2.0.0');
    assert.equal(read('server/server.js'), 'new server');
    assert.equal(read('ihub-apps-v2.0.0-linux'), '#!/bin/bash new');
    assert.equal(fs.existsSync(path.join(root, 'ihub-apps-v1.0.0-linux')), false);
    assert.equal(read('config.env'), 'PORT=3000', 'config.env is never replaced');
    assert.equal(fs.existsSync(path.join(root, '.update-staging')), false);
    assert.equal(
      fs.readFileSync(path.join(backupDir, 'server', 'server.js'), 'utf8'),
      'old server'
    );
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(root, 'node')).mode & 0o111, 0o111);
    }

    const { restoredVersion } = swap.restoreBackup(root, backupDir, { platform: 'linux' });
    assert.equal(restoredVersion, '1.0.0');
    assert.equal(read('server/server.js'), 'old server');
    assert.equal(read('ihub-apps-v1.0.0-linux'), '#!/bin/bash old');
    assert.equal(fs.existsSync(path.join(root, 'ihub-apps-v2.0.0-linux')), false);
    assert.equal(fs.existsSync(path.join(root, '.update-backup')), false);
  });

  it('undoes every move when one fails, leaving the installation bootable', () => {
    const backupDir = swap.prepareBackupDir(root, { version: '1.0.0' });
    const original = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
      calls++;
      // Fail moving the staged public/ into place (Windows: a locked file).
      if (from === path.join(root, '.update-staging', 'public')) {
        const error = new Error('locked');
        error.code = 'EINVAL';
        throw error;
      }
      return original(from, to);
    };
    try {
      assert.throws(() => swap.swapInStaged(root, { backupDir, platform: 'linux' }), /locked/);
    } finally {
      fs.renameSync = original;
    }
    assert.ok(calls > 2);
    assert.equal(read('version.txt'), '1.0.0');
    assert.equal(read('server/server.js'), 'old server');
    assert.equal(read('public/index.html'), 'old ui');
    assert.equal(
      read('.update-staging/server/server.js'),
      'new server',
      'staging is intact for a retry'
    );
  });

  it('snapshots contents/config without the encryption key and restores it on request', () => {
    const backupDir = swap.prepareBackupDir(root, { version: '1.0.0' });
    swap.writeConfigSnapshot(backupDir, contents);
    const snapshot = path.join(backupDir, swap.CONFIG_SNAPSHOT_DIR);
    assert.equal(fs.existsSync(path.join(snapshot, 'config', 'platform.json')), true);
    assert.equal(fs.existsSync(path.join(snapshot, '.migration-history.json')), true);
    assert.deepEqual(
      fs.readdirSync(snapshot).sort(),
      ['.migration-history.json', 'config'],
      'nothing but config/ and the migration history'
    );
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(snapshot).mode & 0o777, 0o700);
    }

    swap.swapInStaged(root, { backupDir, platform: 'linux' });
    // The new version migrates the configuration.
    write('contents/config/platform.json', '{"v":2}');
    write('contents/.migration-history.json', '{"migrations":[1,2]}');

    const result = swap.restoreBackup(root, backupDir, {
      platform: 'linux',
      contentsDir: contents,
      restoreConfig: true
    });
    assert.equal(result.configRestored, true);
    assert.equal(read('contents/config/platform.json'), '{"v":1}');
    assert.equal(read('contents/.migration-history.json'), '{"migrations":[1]}');
    assert.equal(read('contents/.encryption-key'), 'secret');
  });

  it('lists backups newest first, not by version string', () => {
    const older = swap.prepareBackupDir(root, { version: '5.9.0' });
    fs.writeFileSync(
      path.join(older, 'backup-meta.json'),
      JSON.stringify({ version: '5.9.0', createdAt: '2026-01-01T00:00:00Z' })
    );
    const newer = swap.prepareBackupDir(root, { version: '5.10.0' });
    fs.writeFileSync(
      path.join(newer, 'backup-meta.json'),
      JSON.stringify({ version: '5.10.0', createdAt: '2026-02-01T00:00:00Z' })
    );
    assert.deepEqual(
      swap.listBackups(root).map(b => b.version),
      ['5.10.0', '5.9.0']
    );
  });
});

describe('swap on start (launcher)', () => {
  function requestUpdate() {
    const backupDir = swap.prepareBackupDir(root, { version: '1.0.0', targetVersion: '2.0.0' });
    swap.writeConfigSnapshot(backupDir, contents);
    swap.writePending(root, {
      action: 'update',
      targetVersion: '2.0.0',
      previousVersion: '1.0.0',
      backupDir,
      contentsDir: contents
    });
    return backupDir;
  }

  it('does nothing without a pending update', () => {
    assert.deepEqual(swap.applyPendingUpdate(root), { applied: false });
    assert.equal(
      swap.recordServerExit(root, 1),
      'none',
      'a crash without an update is the old behaviour'
    );
  });

  it('applies the pending update once and confirms it when the server comes up', () => {
    requestUpdate();
    const outcome = swap.applyPendingUpdate(root);
    assert.equal(outcome.applied, true);
    assert.equal(read('version.txt'), '2.0.0');
    assert.equal(swap.readPending(root), null, 'the marker is gone, a crash cannot loop');
    assert.equal(swap.readAttempt(root).targetVersion, '2.0.0');

    assert.deepEqual(swap.applyPendingUpdate(root), { applied: false });

    const result = swap.confirmUpdateAttempt(root, '2.0.0');
    assert.equal(result.status, 'success');
    assert.equal(swap.readResult(root).status, 'success');
    assert.equal(swap.readAttempt(root), null);
  });

  it('retries a failing start, then restores the previous version and its configuration', () => {
    requestUpdate();
    swap.applyPendingUpdate(root);
    // The new version migrated the configuration before crashing.
    write('contents/config/platform.json', '{"v":2}');

    for (let i = 1; i < swap.MAX_FAILED_STARTS; i++) {
      assert.equal(swap.recordServerExit(root, 1), 'retry');
      assert.equal(read('version.txt'), '2.0.0');
    }
    assert.equal(swap.recordServerExit(root, 1), 'rolled-back');
    assert.equal(read('version.txt'), '1.0.0');
    assert.equal(read('server/server.js'), 'old server');
    assert.equal(read('contents/config/platform.json'), '{"v":1}');
    const result = swap.readResult(root);
    assert.equal(result.status, 'rolled-back');
    assert.match(result.reason, /failed to start 3 times/);
    assert.equal(swap.readAttempt(root), null);
    assert.equal(swap.recordServerExit(root, 1), 'none', 'the restored version is not counted');
  });

  it('does not count a clean exit or a restart request as a failed start', () => {
    requestUpdate();
    swap.applyPendingUpdate(root);
    assert.equal(swap.recordServerExit(root, 0), 'none');
    assert.equal(swap.recordServerExit(root, 75), 'none');
    assert.equal(swap.readAttempt(root).failedStarts, 0);
  });

  it('reports a failed swap and keeps the old version', () => {
    requestUpdate();
    fs.rmSync(path.join(root, '.update-staging'), { recursive: true });
    const outcome = swap.applyPendingUpdate(root);
    assert.equal(outcome.applied, false);
    assert.equal(read('version.txt'), '1.0.0');
    assert.equal(swap.readResult(root).status, 'failed');
  });

  it('refuses a pending marker that points outside .update-backup', () => {
    swap.writePending(root, { action: 'update', targetVersion: '2.0.0', backupDir: os.tmpdir() });
    const outcome = swap.applyPendingUpdate(root);
    assert.equal(outcome.applied, false);
    assert.equal(read('version.txt'), '1.0.0');
  });

  it('performs a requested rollback before the server starts', () => {
    const backupDir = swap.prepareBackupDir(root, { version: '1.0.0', targetVersion: '2.0.0' });
    swap.writeConfigSnapshot(backupDir, contents);
    swap.swapInStaged(root, { backupDir, platform: 'linux' });
    write('contents/config/platform.json', '{"v":2}');

    swap.writePending(root, {
      action: 'rollback',
      backupDir,
      targetVersion: '1.0.0',
      restoreConfig: false,
      contentsDir: contents
    });
    const outcome = swap.applyPendingUpdate(root);
    assert.equal(outcome.rolledBack, true);
    assert.equal(read('version.txt'), '1.0.0');
    assert.equal(read('contents/config/platform.json'), '{"v":2}', 'config kept unless asked');
    assert.equal(swap.readResult(root).status, 'rolled-back');
  });
});
