export const version = '032';
export const description = 'telemetry_auto_instrumentation_default';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Surfaces the autoInstrumentation flag in the platform config so the
  // admin UI can render its toggle. Default off because turning it on
  // adds Node auto-instrumentations (HTTP/Express/DNS/fs/net) which
  // produce spans on every request - operators should opt in.
  ctx.setDefault(platform, 'telemetry.autoInstrumentation', false);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added telemetry.autoInstrumentation default');
}
