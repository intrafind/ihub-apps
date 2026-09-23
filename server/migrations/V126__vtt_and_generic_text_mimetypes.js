/**
 * Migration V126 — WebVTT and "any text file" upload formats
 *
 * Microsoft Teams exports meeting transcripts as WebVTT (`.vtt`, `text/vtt`),
 * which the upload picker did not know about. This migration:
 *
 *   1. config/mimetypes.json — registers `text/vtt` (.vtt) and the wildcard
 *      `text/*` ("Any text file") in the `documents` category and the
 *      `mimeTypes` detail map, so both show up in the admin format selector.
 *   2. apps/*.json — adds `text/vtt` to every `upload.fileUpload.supportedFormats`
 *      that already accepts `text/plain`: a transcript is plain text, so an app
 *      that takes `.txt` should take `.vtt` too.
 *
 * `text/*` is opt-in and is never added to an app — accepting arbitrary text
 * files stays an explicit admin choice. Entries an admin already defined are
 * left untouched.
 */

export const version = '126';
export const description = 'vtt_and_generic_text_mimetypes';

const VTT_TYPE = 'text/vtt';
const GENERIC_TEXT_TYPE = 'text/*';

const NEW_MIME_TYPES = {
  [VTT_TYPE]: { extensions: ['.vtt'], displayName: 'VTT', category: 'documents' },
  [GENERIC_TEXT_TYPE]: { extensions: [], displayName: 'Any text file', category: 'documents' }
};

export async function precondition(ctx) {
  return (await ctx.fileExists('config/mimetypes.json')) || (await ctx.fileExists('apps'));
}

export async function up(ctx) {
  // 1. Register the new types in config/mimetypes.json
  if (await ctx.fileExists('config/mimetypes.json')) {
    const mimetypes = await ctx.readJson('config/mimetypes.json');
    let changed = false;

    if (mimetypes && typeof mimetypes === 'object') {
      if (!mimetypes.mimeTypes || typeof mimetypes.mimeTypes !== 'object') {
        mimetypes.mimeTypes = {};
      }
      for (const [mimeType, details] of Object.entries(NEW_MIME_TYPES)) {
        if (!Object.prototype.hasOwnProperty.call(mimetypes.mimeTypes, mimeType)) {
          mimetypes.mimeTypes[mimeType] = { ...details, extensions: [...details.extensions] };
          changed = true;
        }
      }

      const documents = mimetypes.categories?.documents;
      if (documents && Array.isArray(documents.mimeTypes)) {
        for (const mimeType of Object.keys(NEW_MIME_TYPES)) {
          if (!documents.mimeTypes.includes(mimeType)) {
            documents.mimeTypes.push(mimeType);
            changed = true;
          }
        }
      }
    }

    if (changed) {
      await ctx.writeJson('config/mimetypes.json', mimetypes);
      ctx.log(`Registered ${VTT_TYPE} and ${GENERIC_TEXT_TYPE} in config/mimetypes.json`);
    }
  }

  // 2. Let apps that accept plain text also accept WebVTT transcripts
  const appFiles = await ctx.listFiles('apps', '*.json');
  if (!Array.isArray(appFiles)) return;

  let migrated = 0;
  for (const file of appFiles) {
    const app = await ctx.readJson(`apps/${file}`);
    const formats = app?.upload?.fileUpload?.supportedFormats;
    if (!Array.isArray(formats) || !formats.includes('text/plain') || formats.includes(VTT_TYPE)) {
      continue;
    }
    formats.push(VTT_TYPE);
    await ctx.writeJson(`apps/${file}`, app);
    migrated++;
  }
  if (migrated > 0) {
    ctx.log(`Added ${VTT_TYPE} to fileUpload.supportedFormats in ${migrated} app(s)`);
  }
}
