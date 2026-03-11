export const version = '019';
export const description = 'add_stt_platform_config';

/**
 * Precondition: only run if platform.json exists.
 * New installations get the default via performInitialSetup; this migration
 * handles existing installations that do not yet have the speechRecognition block.
 *
 * @param {object} ctx - Migration context
 * @returns {Promise<boolean>} true when platform.json is present
 */
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Add speechRecognition defaults to platform.json.
 * ctx.setDefault is a no-op when the key already exists, so existing
 * custom values are never overwritten.
 *
 * @param {object} ctx - Migration context
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'speechRecognition', {
    defaultService: 'default',
    defaultModel: 'whisper-tiny',
    modelsBasePath: '/api/stt-models'
  });

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speechRecognition platform defaults');
}
