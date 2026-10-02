// server/migrations/V147__seed_google_tts_models.js
export const version = '147';
export const description = 'seed_google_tts_models';

/** Google's Gemini text-to-speech models, next to Voxtral TTS. */
const MODEL_PATHS = ['models/gemini-3.8-flash-tts.json', 'models/gemini-3.8-flash-lite-tts.json'];

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Read aloud can speak with Google's Gemini TTS models: both are seeded
 * disabled (they need the Google API key and send the text to Google), so an
 * admin only has to enable one and pick it under Admin → Voice Input.
 */
export async function up(ctx) {
  for (const path of MODEL_PATHS) {
    // Don't clobber an admin-customized model file.
    if (await ctx.fileExists(path)) {
      ctx.log(`${path} already present; skipping`);
      continue;
    }
    let model;
    try {
      model = await ctx.readDefaultJson(path);
    } catch {
      ctx.warn(`Default ${path} not found in defaults; skipping`);
      continue;
    }
    await ctx.writeJson(path, { ...model, enabled: false, default: false });
    ctx.log(`Seeded ${path} (disabled); enable it to read messages aloud with Gemini TTS`);
  }
}
