// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V250 — no setting for how many files are read at once
 *
 * Every server process now reads one file at a time on its own extraction
 * thread; more files at once come from more `WORKERS`. Removed:
 * - `projects.ingest.concurrency` (conversions at once per process)
 * - `projects.extraction.threads` (added in 5.7.0-RC9)
 *
 * In the load test a second thread per process made chats slower without
 * reading faster, so there is nothing to carry over.
 */

export const version = '250';
export const description = 'remove_file_concurrency_settings';

const KEYS = ['projects.ingest.concurrency', 'projects.extraction.threads'];

function has(obj, dotPath) {
  const parts = dotPath.split('.');
  const last = parts.pop();
  const parent = parts.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  return Boolean(parent && typeof parent === 'object' && last in parent);
}

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const present = KEYS.filter(key => has(platform, key));
  if (present.length === 0) {
    ctx.log('No file concurrency settings — nothing to remove');
    return;
  }
  for (const key of present) ctx.removeKey(platform, key);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Removed ${present.join(', ')}: one file is read at a time per server process`);
}
