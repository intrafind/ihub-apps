export const version = '020';
export const description = 'add_tools_service_feature_flag';

export async function precondition(ctx) {
  return await ctx.fileExists('config/features.json');
}

export async function up(ctx) {
  const features = await ctx.readJson('config/features.json');

  ctx.setDefault(features, 'toolsService', false);

  await ctx.writeJson('config/features.json', features);
  ctx.log('Added toolsService feature flag default (false)');
}
