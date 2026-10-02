// server/migrations/V144__remove_app_wizard_fields.js
export const version = '144';
export const description = 'remove_app_wizard_fields';

/**
 * Fields the app creation wizard used to save into app files along with the
 * app. They are the wizard's own form state and are not part of an app
 * configuration; nothing reads them. (Image uploads are configured under
 * `upload.imageUpload`, not a top-level `imageUpload`.)
 */
const WIZARD_FIELDS = [
  'useAI',
  'useTemplate',
  'useManual',
  'aiGenerated',
  'aiPrompt',
  'imageUpload'
];

export async function precondition(ctx) {
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

/**
 * Saving an app through the admin API now checks it against the app schema,
 * which rejects unknown fields. Apps created with the wizard in earlier
 * releases would fail that check only because of the fields above (and a
 * `parentId` of `null`), so they are removed here. Nothing else in an app file
 * is changed, and files that cannot be read are left alone.
 */
export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  let cleaned = 0;
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

    const removed = WIZARD_FIELDS.filter(field => Object.hasOwn(app, field));
    for (const field of removed) delete app[field];
    if (Object.hasOwn(app, 'parentId') && app.parentId === null) {
      delete app.parentId;
      removed.push('parentId');
    }
    if (removed.length === 0) continue;

    await ctx.writeJson(relativePath, app);
    cleaned += 1;
    ctx.log(`Removed unused wizard fields from ${relativePath}: ${removed.join(', ')}`);
  }
  ctx.log(`Checked ${files.length} app file(s), cleaned ${cleaned}`);
}
