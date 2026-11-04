// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V218 - legacy resource arrays become individual files
 *
 * Apps, models, prompts, workflows and agent profiles used to be loadable from
 * one JSON array each (`config/apps.json`, `config/models.json`,
 * `config/prompts.json`, `config/workflows.json`, `config/agents.json`) next to
 * the per-resource files. The loader no longer reads those arrays. This moves
 * every entry that has no file yet into `<dir>/<id>.json` and removes the array
 * file. An entry that already has a file is dropped, because the individual
 * file always won. When an entry cannot be written (no usable id), the array is
 * left untouched and a warning names it, so nothing is lost silently.
 */

export const version = '218';
export const description = 'legacy_resource_arrays_to_files';

const LEGACY_ARRAYS = [
  { file: 'config/apps.json', dir: 'apps' },
  { file: 'config/models.json', dir: 'models' },
  { file: 'config/prompts.json', dir: 'prompts' },
  { file: 'config/workflows.json', dir: 'workflows' },
  { file: 'config/agents.json', dir: 'agents/profiles' }
];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function precondition(ctx) {
  for (const { file } of LEGACY_ARRAYS) {
    if (await ctx.fileExists(file)) return true;
  }
  return false;
}

async function migrateOne(ctx, { file, dir }) {
  if (!(await ctx.fileExists(file))) return;

  let entries;
  try {
    entries = await ctx.readJson(file);
  } catch (error) {
    ctx.warn(`Skipped ${file}: ${error.message}`);
    return;
  }
  if (!Array.isArray(entries)) {
    ctx.warn(`Skipped ${file}: not an array`);
    return;
  }

  let moved = 0;
  let dropped = 0;
  let blocked = 0;
  for (const entry of entries) {
    const id = entry && typeof entry === 'object' ? entry.id : null;
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
      ctx.warn(`${file}: entry without a usable id cannot be moved`);
      blocked++;
      continue;
    }
    const target = `${dir}/${id}.json`;
    if (await ctx.fileExists(target)) {
      dropped++;
      continue;
    }
    await ctx.writeJson(target, entry);
    moved++;
  }

  if (blocked > 0) {
    ctx.warn(`${file} kept: ${blocked} entr${blocked === 1 ? 'y' : 'ies'} could not be moved`);
  } else {
    await ctx.deleteFile(file);
  }
  ctx.log(`${file}: ${moved} moved to ${dir}/, ${dropped} already had a file`);
}

export async function up(ctx) {
  for (const spec of LEGACY_ARRAYS) {
    await migrateOne(ctx, spec);
  }
}
