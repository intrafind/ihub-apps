// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V165 — Raise the document upload limit of the shipped apps from 5 MB to 20 MB
 *
 * Upload size limits are now enforced per file type: a document is held to
 * `upload.fileUpload.maxFileSizeMB` (before, every file was let in up to the
 * largest limit of all types). The default of that limit rose from 5 MB to
 * 20 MB with the change, and so did the value shipped in the default apps
 * (`server/defaults/apps/`).
 *
 * Installed apps keep the value that was written into their file when they were
 * first set up, so the shipped apps below would stay at 5 MB. This migration
 * raises `upload.fileUpload.maxFileSizeMB` of those apps from 5 to 20.
 *
 * What is changed:
 *   - Only the apps whose `id` is in SHIPPED_APP_IDS (the ones that shipped with
 *     5 MB). Other apps are never touched, whatever their limit is.
 *   - Only a limit that is still exactly 5. Any other value an admin set (3, 10,
 *     50, ...) stays as it is.
 *
 * What needs nothing: an app without `upload.fileUpload.maxFileSizeMB` takes the
 * new schema default of 20 MB by itself, and an app that already has 20 or more
 * has nothing to raise.
 *
 * An admin who deliberately chose 5 MB in one of these apps cannot be told apart
 * from the shipped value and gets 20 MB too; the limit can be set back in the
 * Upload Configuration of the app.
 *
 * Nothing else in an app file is changed, and files that cannot be read are left
 * alone. Running it again changes nothing: the limit is no longer 5.
 */

export const version = '165';
export const description = 'raise_shipped_apps_document_upload_limit';

/**
 * Ids of the default apps (server/defaults/apps/) that shipped with a document
 * upload limit of 5 MB.
 *
 * Snapshot as of V165 — do NOT replace with a read of server/defaults/apps/:
 * the shipped apps change, this migration must not.
 */
const SHIPPED_APP_IDS = new Set([
  'email-composer',
  'file-analysis',
  'ifinder-document-actions',
  'ihub-support-bot',
  'intrafind-websites-bot',
  'summarizer',
  'translator'
]);

/** The limit the shipped apps had, in megabytes. Only exactly this value is raised. */
const PREVIOUS_LIMIT_MB = 5;

/** The new document upload limit of the shipped apps, in megabytes. */
const NEW_LIMIT_MB = 20;

export async function precondition(ctx) {
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  let raised = 0;
  for (const file of files) {
    const relativePath = `apps/${file}`;
    let app;
    try {
      app = await ctx.readJson(relativePath);
    } catch (error) {
      ctx.warn(`Skipping ${relativePath}: ${error.message}`);
      continue;
    }
    if (!app || typeof app !== 'object' || Array.isArray(app)) continue;
    if (!SHIPPED_APP_IDS.has(app.id)) continue;

    const fileUpload = app.upload?.fileUpload;
    if (!fileUpload || typeof fileUpload !== 'object') continue;
    if (fileUpload.maxFileSizeMB !== PREVIOUS_LIMIT_MB) continue;

    fileUpload.maxFileSizeMB = NEW_LIMIT_MB;
    await ctx.writeJson(relativePath, app);
    raised += 1;
    ctx.log(
      `Raised upload.fileUpload.maxFileSizeMB of ${relativePath} from ${PREVIOUS_LIMIT_MB} to ${NEW_LIMIT_MB}`
    );
  }
  ctx.log(`Checked ${files.length} app file(s), raised the document upload limit of ${raised}`);
}
