// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V228 — upload types that were left on the editor's default formats take the entire
 * format category
 *
 * Turning on an upload type in the app editor used to leave its format list at a short default
 * (or write that default into the app on the next save). The editor now starts a freshly enabled
 * type with "Use entire category", so the same apps are moved to it here.
 *
 * For every app, and every enabled upload type (`imageUpload`, `fileUpload`, `audioUpload`,
 * `videoUpload`), `supportedFormats` becomes the MIME types of that type's category in
 * `config/mimetypes.json` when it
 *
 *   - has no `supportedFormats`, or
 *   - lists exactly one of the formats the editor and the chat used as the default (`text/vtt` is
 *     ignored, since V126 added it to lists that took `text/plain`).
 *
 * A list an admin curated (anything else) is left alone, as is a type that is not enabled.
 */

export const version = '228';
export const description = 'upload_formats_entire_category';

const TYPE_CATEGORIES = {
  imageUpload: 'images',
  fileUpload: 'documents',
  audioUpload: 'audio',
  videoUpload: 'video'
};

const IGNORED = new Set(['text/vtt']);

// Every list the app editor or the chat fell back to, per upload type
const OLD_DEFAULTS = {
  imageUpload: [['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']],
  fileUpload: [
    // Upload card of the app editor
    [
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/json',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-outlook'
    ],
    // Defaults of the app editor page
    [
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/json',
      'text/html',
      'text/css',
      'text/javascript',
      'application/javascript',
      'text/xml',
      'message/rfc822',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-outlook',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation'
    ],
    // Fallback of the chat
    [
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/json',
      'text/html',
      'text/css',
      'text/javascript',
      'application/javascript',
      'application/pdf'
    ]
  ],
  audioUpload: [['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/mp4']],
  videoUpload: [['video/mp4', 'video/webm', 'video/quicktime']]
};

const significant = formats => new Set(formats.filter(format => !IGNORED.has(format)));

const sameFormats = (a, b) => {
  const left = significant(a);
  const right = significant(b);
  return left.size === right.size && [...left].every(format => right.has(format));
};

const isOldDefault = (uploadKey, formats) =>
  OLD_DEFAULTS[uploadKey].some(known => sameFormats(known, formats));

async function readMimetypes(ctx) {
  if (await ctx.fileExists('config/mimetypes.json')) return ctx.readJson('config/mimetypes.json');
  return ctx.readDefaultJson('config/mimetypes.json');
}

export async function precondition(ctx) {
  return await ctx.fileExists('apps');
}

export async function up(ctx) {
  const mimetypes = await readMimetypes(ctx);
  const appFiles = await ctx.listFiles('apps', '*.json');
  if (!Array.isArray(appFiles)) return;

  let migratedApps = 0;
  for (const file of appFiles) {
    const app = await ctx.readJson(`apps/${file}`);
    if (!app || typeof app !== 'object' || !app.upload || typeof app.upload !== 'object') continue;

    let changed = false;
    for (const [uploadKey, categoryId] of Object.entries(TYPE_CATEGORIES)) {
      const typeConfig = app.upload[uploadKey];
      if (!typeConfig || typeConfig.enabled !== true) continue;

      const category = mimetypes?.categories?.[categoryId]?.mimeTypes;
      if (!Array.isArray(category) || category.length === 0) continue;

      const formats = typeConfig.supportedFormats;
      const onDefault = !Array.isArray(formats) || isOldDefault(uploadKey, formats);
      if (!onDefault || (Array.isArray(formats) && sameFormats(formats, category))) continue;

      typeConfig.supportedFormats = [...category];
      changed = true;
    }

    if (changed) {
      await ctx.writeJson(`apps/${file}`, app);
      migratedApps++;
    }
  }

  if (migratedApps > 0) {
    ctx.log(`Selected the entire format category for upload types in ${migratedApps} app(s)`);
  }
}
