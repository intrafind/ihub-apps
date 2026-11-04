// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as migration from '../../../../server/migrations/V217__reset_usage_data.js';

let dir;

function ctx() {
  return {
    contentsDir: dir,
    fileExists: async p => fs.existsSync(path.join(dir, p)),
    log: () => {}
  };
}

function write(rel, content = '{}') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v217-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('V217 reset usage data', () => {
  it('is skipped when there is nothing to reset', async () => {
    write('data/quota-usage.json');
    await expect(migration.precondition(ctx())).resolves.toBe(false);
  });

  it('deletes the old usage stores and keeps the quota ledger', async () => {
    write('data/usage.json');
    write('data/usage-events.jsonl', '{"type":"chat_request"}\n');
    write('data/usage-daily/2026-11-01.json');
    write('data/usage-monthly/2026-10.json');
    write('data/quota-usage.json', '{"keep":true}');
    write('data/usage-events/2026-11-04.jsonl', '{"v":2}\n');

    await expect(migration.precondition(ctx())).resolves.toBe(true);
    await migration.up(ctx());

    expect(fs.existsSync(path.join(dir, 'data/usage.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'data/usage-events.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'data/usage-daily'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'data/usage-monthly'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'data/quota-usage.json'), 'utf8')).toBe('{"keep":true}');
    expect(fs.existsSync(path.join(dir, 'data/usage-events/2026-11-04.jsonl'))).toBe(true);
  });
});
