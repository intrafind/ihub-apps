// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as migration from '../../../../server/migrations/V226__reset_usage_limit_counters.js';

let dir;

function ctx() {
  return {
    fileExists: async p => fs.existsSync(path.join(dir, p)),
    deleteFile: async p => fs.promises.unlink(path.join(dir, p)),
    log: () => {}
  };
}

function write(rel, content = '{}') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v226-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('V226 reset usage limit counters', () => {
  it('is skipped when no counters were kept yet', async () => {
    await expect(migration.precondition(ctx())).resolves.toBe(false);
  });

  it('deletes the limit counters and keeps the usage reports', async () => {
    write('data/quota-usage.json', '{"version":1,"users":{"alice":{}}}');
    write('data/usage-events/2026-11-04.jsonl', '{"v":2}\n');
    write('data/usage-daily/2026-11-04.json');

    await expect(migration.precondition(ctx())).resolves.toBe(true);
    await migration.up(ctx());

    expect(fs.existsSync(path.join(dir, 'data/quota-usage.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'data/usage-events/2026-11-04.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'data/usage-daily/2026-11-04.json'))).toBe(true);
  });
});
