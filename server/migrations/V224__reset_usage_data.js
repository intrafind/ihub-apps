// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Migration V224 — reset usage reporting data
 *
 * Usage reporting moved to one call record (schema v2) per model call,
 * written by LLMClient for every surface, keyed on the real user. The old
 * data counted chat only, counted each exchange twice and keyed users on
 * chat sessions, so it cannot be merged with the new records: it is
 * deleted once. The quota ledger (`data/quota-usage.json`) is left alone.
 */

export const version = '224';
export const description = 'reset_usage_data';

const TARGETS = [
  'data/usage.json',
  'data/usage-events.jsonl',
  'data/usage-daily',
  'data/usage-monthly'
];

export async function precondition(ctx) {
  for (const target of TARGETS) {
    if (await ctx.fileExists(target)) return true;
  }
  return false;
}

export async function up(ctx) {
  for (const target of TARGETS) {
    if (!(await ctx.fileExists(target))) continue;
    await fs.rm(path.join(ctx.contentsDir, target), { recursive: true, force: true });
    ctx.log(`Removed ${target}`);
  }
}
