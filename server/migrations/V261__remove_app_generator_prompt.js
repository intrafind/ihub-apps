// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V261 — remove the App Generator prompt
 *
 * The prompt `app-generator` (`contents/prompts/app-generator.json`) prepared
 * app drafts in the old "Generate with AI" wizard. Apps are now drafted by the
 * app builder (`POST /api/admin/apps/_generate`, `POST /api/apps/_generate`),
 * which always uses the server's own brief (`server/services/appGeneratorBrief.js`).
 * The prompt no longer steers anything, but it was still listed in the prompt
 * library for every user.
 *
 * The file is deleted whether it is the shipped copy or one an admin changed:
 * the owner decided the prompt goes away completely. A prompt with the id
 * `app-generator` stored under another file name is not touched; only the
 * shipped file name is removed.
 *
 * Idempotent: once the file is gone, the precondition skips the migration.
 */

export const version = '261';
export const description = 'remove_app_generator_prompt';

/** The prompt file this migration removes, relative to `contents/`. */
export const FILE = 'prompts/app-generator.json';

export async function precondition(ctx) {
  return await ctx.fileExists(FILE);
}

export async function up(ctx) {
  if (!(await ctx.fileExists(FILE))) {
    ctx.log(`${FILE} does not exist — no changes needed`);
    return;
  }
  await ctx.deleteFile(FILE);
  ctx.log(`Removed ${FILE}: the App Generator prompt is no longer part of the prompt library`);
}
