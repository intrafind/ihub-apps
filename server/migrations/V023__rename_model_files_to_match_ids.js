/**
 * Migration V023 — Rename model files to match their IDs
 *
 * Fixes model deletion 404 error by renaming model files that have filenames
 * that don't match their internal IDs. The DELETE endpoint constructs paths
 * as ${modelId}.json, so files must be named accordingly.
 *
 * Files to rename:
 * - claude-4-haiku.json → claude-haiku-4-5.json
 * - gemini-3.1-flash-image.json → gemini-3.1-pro-image.json
 * - gemini-3.1-flash-light.json → gemini-3.1-flash-lite.json
 */

export const version = '023';
export const description = 'rename_model_files_to_match_ids';

export async function up(ctx) {
  const renames = [
    { from: 'models/claude-4-haiku.json', to: 'models/claude-haiku-4-5.json' },
    { from: 'models/gemini-3.1-flash-image.json', to: 'models/gemini-3.1-pro-image.json' },
    { from: 'models/gemini-3.1-flash-light.json', to: 'models/gemini-3.1-flash-lite.json' }
  ];

  let renamed = 0;

  for (const { from, to } of renames) {
    if (await ctx.fileExists(from)) {
      // Check if target already exists (in case migration is re-run)
      if (await ctx.fileExists(to)) {
        ctx.warn(`Target file ${to} already exists, skipping rename from ${from}`);
        // Optionally delete the old file if both exist
        await ctx.deleteFile(from);
        ctx.log(`Deleted old file ${from} as ${to} already exists`);
      } else {
        await ctx.moveFile(from, to);
        ctx.log(`Renamed ${from} → ${to}`);
        renamed++;
      }
    }
  }

  if (renamed === 0) {
    ctx.log('No model files needed renaming (already migrated or files not found)');
  } else {
    ctx.log(`Successfully renamed ${renamed} model file(s) to match their IDs`);
  }
}
