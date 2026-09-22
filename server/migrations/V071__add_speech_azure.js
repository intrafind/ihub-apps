export const version = '071';
export const description = 'add_speech_azure';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Platform-level defaults for the Azure Speech backend. The subscription key
  // is provided via the VITE_AZURE_SUBSCRIPTION_ID env var (client build) and is
  // intentionally NOT stored here. Apps may still override the host per-app.
  ctx.setDefault(platform, 'speech.azure.enabled', false);
  ctx.setDefault(platform, 'speech.azure.host', '');
  ctx.setDefault(platform, 'speech.azure.region', '');

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speech.azure defaults to platform.json');
}
