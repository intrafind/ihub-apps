/**
 * Migration V064 — Deduplicate the MSG (Outlook) MIME type
 *
 * `.msg` files were registered under two MIME types: `application/vnd.ms-outlook`
 * (the de-facto standard Outlook type) and the non-standard `application/x-msg`.
 * Both mapped to the same `.msg` extension and "MSG" display name, so the admin
 * upload-format selector rendered "MSG (.msg)" twice and apps listing both ended
 * up with a redundant entry.
 *
 * Browsers never emit `application/x-msg`, and `.msg` selection/processing relies
 * on the file extension anyway, so the extra type adds nothing. This migration
 * removes `application/x-msg` from existing installations:
 *
 *   1. config/mimetypes.json — drop it from every category list and from the
 *      `mimeTypes` detail map.
 *   2. apps/*.json — drop it from any `upload.*.supportedFormats` array.
 *
 * `application/vnd.ms-outlook` remains as the single canonical MSG type.
 */

export const version = '064';
export const description = 'dedupe_msg_mimetype';

const LEGACY_MSG_TYPE = 'application/x-msg';

export async function precondition(ctx) {
  return await ctx.fileExists('config/mimetypes.json');
}

export async function up(ctx) {
  // 1. Clean config/mimetypes.json
  const mimetypes = await ctx.readJson('config/mimetypes.json');
  let mimetypesChanged = false;

  if (mimetypes?.categories && typeof mimetypes.categories === 'object') {
    for (const category of Object.values(mimetypes.categories)) {
      if (Array.isArray(category?.mimeTypes) && category.mimeTypes.includes(LEGACY_MSG_TYPE)) {
        category.mimeTypes = category.mimeTypes.filter(type => type !== LEGACY_MSG_TYPE);
        mimetypesChanged = true;
      }
    }
  }

  if (
    mimetypes?.mimeTypes &&
    Object.prototype.hasOwnProperty.call(mimetypes.mimeTypes, LEGACY_MSG_TYPE)
  ) {
    delete mimetypes.mimeTypes[LEGACY_MSG_TYPE];
    mimetypesChanged = true;
  }

  if (mimetypesChanged) {
    await ctx.writeJson('config/mimetypes.json', mimetypes);
    ctx.log(`Removed ${LEGACY_MSG_TYPE} from config/mimetypes.json`);
  }

  // 2. Clean apps/*.json upload.*.supportedFormats
  const appFiles = await ctx.listFiles('apps', '*.json');
  if (Array.isArray(appFiles)) {
    let migrated = 0;
    for (const file of appFiles) {
      const app = await ctx.readJson(`apps/${file}`);
      const upload = app?.upload;
      if (!upload || typeof upload !== 'object') continue;

      let appChanged = false;
      for (const section of Object.values(upload)) {
        if (
          Array.isArray(section?.supportedFormats) &&
          section.supportedFormats.includes(LEGACY_MSG_TYPE)
        ) {
          section.supportedFormats = section.supportedFormats.filter(
            type => type !== LEGACY_MSG_TYPE
          );
          appChanged = true;
        }
      }

      if (appChanged) {
        await ctx.writeJson(`apps/${file}`, app);
        migrated++;
      }
    }
    if (migrated > 0) {
      ctx.log(`Removed ${LEGACY_MSG_TYPE} from supportedFormats in ${migrated} app(s)`);
    }
  }
}
