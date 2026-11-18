// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The configuration export carries the encryption key, the JWT signing keys and
 * password hashes. Its response must not be cached (`Cache-Control: no-store`),
 * and the per-file "Adding to archive" line (user ids in the paths) is debug
 * output, never info.
 *
 * Run: node --test server/tests/backup-export-hygiene.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-backup-export-'));
process.env.CONTENTS_DIR = contentsDir;

const { exportConfig } = await import('../routes/admin/backup.js');
const { default: logger } = await import('../utils/logger.js');

/**
 * A writable response double: the archive is piped into it, and its headers
 * are recorded.
 */
function streamingResponse() {
  const res = new PassThrough();
  const headers = new Map();
  res.headersSent = false;
  res.setHeader = (name, value) => headers.set(name.toLowerCase(), value);
  res.removeHeader = name => headers.delete(name.toLowerCase());
  res.getHeader = name => headers.get(name.toLowerCase());
  res.resume(); // drain the ZIP bytes
  return res;
}

describe('backup export hygiene', () => {
  const calls = { info: [], debug: [] };
  const original = {};

  before(() => {
    fs.mkdirSync(path.join(contentsDir, 'data', 'users'), { recursive: true });
    fs.writeFileSync(path.join(contentsDir, 'data', 'users', 'user-123.json'), '{}');
    fs.writeFileSync(path.join(contentsDir, '.encryption-key'), 'k');
    for (const level of ['info', 'debug']) {
      original[level] = logger[level];
      logger[level] = (message, meta) => {
        calls[level].push({ message, meta });
      };
    }
  });

  after(() => {
    for (const level of Object.keys(original)) logger[level] = original[level];
    fs.rmSync(contentsDir, { recursive: true, force: true });
  });

  it('answers with Cache-Control: no-store and logs each file at debug only', async () => {
    const res = streamingResponse();
    let forwarded;
    await exportConfig({ headers: {}, user: { id: 'admin' } }, res, error => {
      forwarded = error;
    });

    assert.equal(forwarded, undefined, 'the export succeeds');
    assert.equal(res.getHeader('cache-control'), 'no-store');
    assert.equal(res.getHeader('content-type'), 'application/zip');

    const perFileInfo = calls.info.filter(call => call.message === 'Adding to archive');
    assert.deepEqual(perFileInfo, [], 'no per-file line at info');
    const perFileDebug = calls.debug.filter(call => call.message === 'Adding to archive');
    assert.ok(perFileDebug.length >= 2, 'each file is still logged at debug');
  });
});
