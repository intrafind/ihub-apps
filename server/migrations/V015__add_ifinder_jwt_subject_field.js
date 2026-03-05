export const version = '015';
export const description = 'add_ifinder_jwt_subject_field';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'iFinder.jwtSubjectField', 'email');

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added iFinder.jwtSubjectField default (email)');
}
