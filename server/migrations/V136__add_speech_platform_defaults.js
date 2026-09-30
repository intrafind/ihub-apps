// server/migrations/V136__add_speech_platform_defaults.js
export const version = '136';
export const description = 'add_speech_platform_defaults';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Platform-wide voice-input defaults (Admin → Voice Input → Defaults):
 *   - speech.defaultService: the dictation service used by every app whose
 *     settings.speechRecognition.service is "default" (or unset).
 *   - speech.transcription.defaultModelId: the transcription model used for
 *     record/upload transcription when an app enables transcription but picks
 *     no model of its own.
 *
 * The seeded values keep today's behaviour: "browser" is what "default" always
 * resolved to, and an empty model id means "no platform default".
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'speech.defaultService', 'browser');
  ctx.setDefault(platform, 'speech.transcription.defaultModelId', '');

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speech.defaultService and speech.transcription.defaultModelId defaults');
}
