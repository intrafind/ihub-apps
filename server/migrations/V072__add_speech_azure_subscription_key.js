export const version = '072';
export const description = 'add_speech_azure_subscription_key';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // The Azure subscription key is now a server-side secret (encrypted at rest)
  // brokered into a short-lived token via /api/voice/azure/token, replacing the
  // former VITE_AZURE_SUBSCRIPTION_ID build-time client env var. Default empty;
  // admins set it under Admin → Voice Input.
  ctx.setDefault(platform, 'speech.azure.subscriptionKey', '');

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speech.azure.subscriptionKey default to platform.json');
}
