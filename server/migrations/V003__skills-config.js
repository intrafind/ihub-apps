/**
 * Migration V003 — Skills configuration
 *
 * Adds the `skills` section to contents/config/platform.json and
 * the `skills` feature flag to contents/config/features.json for
 * existing installations that pre-date the Agent Skills integration.
 *
 * Fresh installs skip this automatically because performInitialSetup()
 * copies the defaults (which already include these fields) before
 * migrations run.
 */

export const version = '003';
export const description = 'Add skills section to platform.json and skills flag to features.json';

export async function precondition(ctx) {
  // Only run if at least one of the target files exists
  const hasPlatform = await ctx.fileExists('config/platform.json');
  const hasFeatures = await ctx.fileExists('config/features.json');
  return hasPlatform || hasFeatures;
}

export async function up(ctx) {
  // ── 1. platform.json — add skills settings ────────────────────────────────
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');

    const changed = ctx.setDefault(platform, 'skills', {
      skillsDirectory: 'contents/skills',
      maxSkillBodyTokens: 5000
    });

    if (changed) {
      await ctx.writeJson('config/platform.json', platform);
      ctx.log('Added skills section to platform.json');
    } else {
      ctx.log('platform.json already has skills section — skipping');
    }
  }

  // ── 2. features.json — add skills flag (disabled by default) ──────────────
  if (await ctx.fileExists('config/features.json')) {
    const features = await ctx.readJson('config/features.json');

    const changed = ctx.setDefault(features, 'skills', false);

    if (changed) {
      await ctx.writeJson('config/features.json', features);
      ctx.log('Added skills flag (false) to features.json');
    } else {
      ctx.log('features.json already has skills flag — skipping');
    }
  }
}
