// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The check that fails a test run which wrote into the real `contents/`
 * directory (`scripts/lib/realContentsGuard.js`, used by
 * `scripts/run-server-tests.js`), and the module that keeps tests out of it
 * (`support/scratchContents.js`).
 */
import { contentsDir, scratchRoot } from './support/scratchContents.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';
import { getContentsPath } from '../utils/contentsPath.js';
import {
  compareContents,
  formatContentsReport,
  snapshotContents
} from '../../scripts/lib/realContentsGuard.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-contents-guard-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Write a file below the watched directory, creating its folders. */
function write(relative, content = 'x') {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('scratchContents', () => {
  it('points the server at a temporary contents directory', () => {
    assert.equal(config.CONTENTS_DIR, contentsDir);
    assert.equal(getContentsPath(), contentsDir);
    assert.equal(process.env.CONTENTS_DIR, contentsDir);
    assert.ok(contentsDir.startsWith(scratchRoot + path.sep));
    assert.ok(scratchRoot.startsWith(os.tmpdir()));
  });

  it('removes the master key variables from the environment', () => {
    assert.equal(process.env.TOKEN_ENCRYPTION_KEY, undefined);
    assert.equal(process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS, undefined);
  });
});

describe('realContentsGuard', () => {
  it('reports nothing for a directory that does not exist, before and after', () => {
    const missing = path.join(dir, 'absent');
    const report = compareContents(snapshotContents(missing), snapshotContents(missing));
    assert.deepEqual(report, { violations: [], notices: [] });
    assert.deepEqual(formatContentsReport(report, missing), []);
  });

  it('fails a run that created the master key file', () => {
    const before = snapshotContents(dir);
    write('.encryption-key', 'k'.repeat(64));
    const report = compareContents(before, snapshotContents(dir));
    assert.deepEqual(report.violations, [
      { path: '.encryption-key', change: 'created', kind: 'key' }
    ]);
    assert.match(formatContentsReport(report, dir)[0], /FAILED/);
  });

  it('fails a run that changed or removed the master key file', () => {
    const before = snapshotContents(dir);
    write('.encryption-key', 'another key, another length');
    const changed = compareContents(before, snapshotContents(dir));
    assert.deepEqual(changed.violations, [
      { path: '.encryption-key', change: 'changed', kind: 'key' }
    ]);

    const present = snapshotContents(dir);
    fs.rmSync(path.join(dir, '.encryption-key'));
    const removed = compareContents(present, snapshotContents(dir));
    assert.deepEqual(removed.violations, [
      { path: '.encryption-key', change: 'removed', kind: 'key' }
    ]);
  });

  it('fails a run that wrote storage data, also when it only created a directory', () => {
    const before = snapshotContents(dir);
    write('data/blobs/chat-files/a.bin');
    fs.mkdirSync(path.join(dir, 'data', 'agent-inboxes'), { recursive: true });
    const report = compareContents(before, snapshotContents(dir));
    assert.deepEqual(
      report.violations.map(entry => `${entry.change} ${entry.path} ${entry.kind}`),
      [
        'created data storage',
        'created data/agent-inboxes storage',
        'created data/blobs storage',
        'created data/blobs/chat-files storage',
        'created data/blobs/chat-files/a.bin storage'
      ]
    );
  });

  it('reports other changes as notices, which do not fail the run', () => {
    const before = snapshotContents(dir);
    write('config/platform.json', '{}');
    const report = compareContents(before, snapshotContents(dir));
    assert.deepEqual(report.violations, []);
    assert.deepEqual(
      report.notices.map(entry => entry.path),
      ['config', 'config/platform.json']
    );
    assert.match(formatContentsReport(report, dir)[0], /notice/);
  });

  it('reports the known leaks of older tests as notices, and still fails on anything beside them', () => {
    const known = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-contents-guard-known-'));
    try {
      const before = snapshotContents(known);
      fs.mkdirSync(path.join(known, 'data', 'audit-log'), { recursive: true });
      fs.writeFileSync(path.join(known, 'data', 'audit-log', '2026-11-20.jsonl'), '{}\n');
      const onlyKnown = compareContents(before, snapshotContents(known));
      assert.deepEqual(onlyKnown.violations, []);
      assert.deepEqual(
        onlyKnown.notices.map(entry => `${entry.path} ${entry.kind}`),
        [
          'data known-leak',
          'data/audit-log known-leak',
          'data/audit-log/2026-11-20.jsonl known-leak'
        ]
      );

      fs.mkdirSync(path.join(known, 'data', 'chats'));
      fs.writeFileSync(path.join(known, 'data', 'audit-log', 'notes.txt'), 'x');
      const mixed = compareContents(before, snapshotContents(known));
      assert.deepEqual(
        mixed.violations.map(entry => entry.path),
        ['data', 'data/audit-log/notes.txt', 'data/chats']
      );
    } finally {
      fs.rmSync(known, { recursive: true, force: true });
    }
  });

  it('reports nothing when nothing changed', () => {
    const report = compareContents(snapshotContents(dir), snapshotContents(dir));
    assert.deepEqual(report, { violations: [], notices: [] });
  });
});
