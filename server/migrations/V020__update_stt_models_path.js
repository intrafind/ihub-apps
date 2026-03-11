export const version = '020';
export const description = 'update_stt_models_path';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Rename old default path only if admin has not customized it
  if (platform?.speechRecognition?.modelsBasePath === '/api/stt-models') {
    platform.speechRecognition.modelsBasePath = '/api/assets/models/stt';
    ctx.log('Updated speechRecognition.modelsBasePath to /api/assets/models/stt');
  }

  ctx.setDefault(platform, 'speechRecognition.allowAnonymousModelDownload', false);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speechRecognition.allowAnonymousModelDownload default');
}
