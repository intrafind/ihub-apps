// server/migrations/V142__add_text_to_speech.js
export const version = '142';
export const description = 'add_text_to_speech';

const MODEL_PATH = 'models/voxtral-mini-tts.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Read aloud (issue #2642): a play button on every chat message, spoken by a
 * `modelType: "tts"` model.
 *   - platform.speech.tts.enabled / defaultModelId: off, and no model, so
 *     nothing changes until an admin switches it on under Admin → Voice Input.
 *   - models/voxtral-mini-tts.json: the Mistral Voxtral TTS model, disabled
 *     (it needs a Mistral API key), so an admin only has to enable it.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'speech.tts.enabled', false);
  ctx.setDefault(platform, 'speech.tts.defaultModelId', '');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speech.tts defaults (read aloud off)');

  // Don't clobber an admin-customized model file.
  if (await ctx.fileExists(MODEL_PATH)) {
    ctx.log('Voxtral TTS model already present; skipping');
    return;
  }
  let model;
  try {
    model = await ctx.readDefaultJson(MODEL_PATH);
  } catch {
    ctx.warn('Default Voxtral TTS model not found in defaults; skipping');
    return;
  }
  await ctx.writeJson(MODEL_PATH, { ...model, enabled: false, default: false });
  ctx.log(`Seeded ${MODEL_PATH} (disabled); enable it and set a Mistral API key to use it`);
}
