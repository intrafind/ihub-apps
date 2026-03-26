/**
 * Migration V021 — Migrate microphone mode from 'auto'/'continuous' to 'automatic'
 *
 * The microphone mode enum was corrected to use 'automatic' instead of 'auto'
 * or 'continuous'. This migration updates all app configurations that may have
 * used the old values.
 */

export const version = '021';
export const description = 'migrate_microphone_mode';

export async function up(ctx) {
  let updatedCount = 0;

  // Process apps in contents/apps/
  const appsFiles = await ctx.listFiles('apps', '*.json');
  for (const filename of appsFiles) {
    const appPath = `apps/${filename}`;
    const app = await ctx.readJson(appPath);

    // Check if the app has a microphone mode configuration
    const oldMode = app.inputMode?.microphone?.mode;
    if (oldMode === 'auto' || oldMode === 'continuous') {
      app.inputMode.microphone.mode = 'automatic';
      await ctx.writeJson(appPath, app);
      ctx.log(`Updated ${filename}: changed mode from '${oldMode}' to 'automatic'`);
      updatedCount++;
    }
  }

  if (updatedCount === 0) {
    ctx.log('No apps found with old microphone mode values (auto/continuous)');
  } else {
    ctx.log(`Updated ${updatedCount} app(s) to use 'automatic' microphone mode`);
  }
}
