// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V250 — one setting for how many files are read at once
 *
 * `projects.ingest.concurrency` now also sets the number of extraction threads
 * per server process, for project items and chat uploads alike, so
 * `projects.extraction.threads` (added in 5.7.0-RC9) is removed. A value above
 * `ingest.concurrency` is carried over to it, so nobody loses threads they
 * asked for. `threads: 0` (read on the event loop) no longer exists.
 */

export const version = '250';
export const description = 'one_file_concurrency_setting';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const extraction = platform?.projects?.extraction;
  if (!extraction || typeof extraction !== 'object' || !('threads' in extraction)) {
    ctx.log('No projects.extraction.threads — nothing to change');
    return;
  }

  const threads = Number(extraction.threads);
  const concurrency = Number(platform.projects.ingest?.concurrency ?? 2);
  if (Number.isInteger(threads) && threads > concurrency) {
    ctx.setDefault(platform, 'projects.ingest', {});
    platform.projects.ingest.concurrency = threads;
    ctx.log(`Carried projects.extraction.threads ${threads} over to projects.ingest.concurrency`);
  }
  if (threads === 0) {
    ctx.warn('projects.extraction.threads was 0; files are now always read in threads');
  }
  ctx.removeKey(platform, 'projects.extraction.threads');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Removed projects.extraction.threads');
}
