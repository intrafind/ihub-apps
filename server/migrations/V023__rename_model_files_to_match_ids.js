/**
 * Migration V023 — Rename model files and fix IDs to match filenames
 *
 * Fixes model deletion 404 error by ensuring model files have IDs that match
 * their filenames. The DELETE endpoint constructs paths as ${modelId}.json,
 * so files must be named accordingly.
 *
 * Changes:
 * - claude-4-haiku.json → claude-haiku-4-5.json (file rename)
 * - gemini-3.1-flash-light.json → gemini-3.1-flash-lite.json (file rename)
 * - gemini-3.1-flash-image.json: Fix ID from "gemini-3.1-pro-image" to "gemini-3.1-flash-image"
 */

export const version = '023';
export const description = 'rename_model_files_to_match_ids';

export async function up(ctx) {
  let changes = 0;

  // File renames (filename didn't match ID)
  const renames = [
    { from: 'models/claude-4-haiku.json', to: 'models/claude-haiku-4-5.json' },
    { from: 'models/gemini-3.1-flash-light.json', to: 'models/gemini-3.1-flash-lite.json' }
  ];

  for (const { from, to } of renames) {
    if (await ctx.fileExists(from)) {
      // Check if target already exists (in case migration is re-run)
      if (await ctx.fileExists(to)) {
        ctx.warn(`Target file ${to} already exists, skipping rename from ${from}`);
        // Delete the old file if both exist
        await ctx.deleteFile(from);
        ctx.log(`Deleted old file ${from} as ${to} already exists`);
        changes++;
      } else {
        await ctx.moveFile(from, to);
        ctx.log(`Renamed ${from} → ${to}`);
        changes++;
      }
    }
  }

  // Fix ID in gemini-3.1-flash-image.json if it has wrong ID
  const flashImagePath = 'models/gemini-3.1-flash-image.json';
  if (await ctx.fileExists(flashImagePath)) {
    try {
      const model = await ctx.readJson(flashImagePath);
      if (model.id === 'gemini-3.1-pro-image') {
        model.id = 'gemini-3.1-flash-image';
        await ctx.writeJson(flashImagePath, model);
        ctx.log(`Fixed ID in ${flashImagePath}: "gemini-3.1-pro-image" → "gemini-3.1-flash-image"`);
        changes++;
      }
    } catch (error) {
      ctx.warn(`Failed to update ID in ${flashImagePath}: ${error.message}`);
    }
  }

  // Handle case where gemini-3.1-pro-image.json exists with flash-image content
  // This shouldn't happen in new installations, but could in existing ones
  const proImagePath = 'models/gemini-3.1-pro-image.json';
  if (await ctx.fileExists(proImagePath)) {
    try {
      const model = await ctx.readJson(proImagePath);
      // Check if this is actually the flash-image model (wrong filename)
      if (model.modelId && model.modelId.includes('flash-image')) {
        // This is the flash-image model with wrong filename
        if (await ctx.fileExists(flashImagePath)) {
          // Both files exist - delete the misnamed one
          await ctx.deleteFile(proImagePath);
          ctx.log(`Deleted misnamed ${proImagePath} (was actually flash-image model)`);
          changes++;
        } else {
          // Rename to correct filename and fix ID
          await ctx.moveFile(proImagePath, flashImagePath);
          model.id = 'gemini-3.1-flash-image';
          await ctx.writeJson(flashImagePath, model);
          ctx.log(`Moved ${proImagePath} → ${flashImagePath} and fixed ID`);
          changes++;
        }
      }
    } catch (error) {
      ctx.warn(`Failed to process ${proImagePath}: ${error.message}`);
    }
  }

  if (changes === 0) {
    ctx.log('No model files needed updating (already migrated or files not found)');
  } else {
    ctx.log(`Successfully applied ${changes} change(s) to model files`);
  }
}
