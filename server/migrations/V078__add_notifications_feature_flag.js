export const version = '078';
export const description = 'add_notifications_feature_flag';

export async function precondition(ctx) {
  return await ctx.fileExists('config/features.json');
}

export async function up(ctx) {
  const features = await ctx.readJson('config/features.json');

  ctx.setDefault(features, 'notifications', false);

  await ctx.writeJson('config/features.json', features);
  ctx.log('Added notifications feature flag default (false)');
}
