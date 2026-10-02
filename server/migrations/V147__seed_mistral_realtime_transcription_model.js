// server/migrations/V147__seed_mistral_realtime_transcription_model.js
export const version = '147';
export const description = 'seed_mistral_realtime_transcription_model';

const MODEL_PATH = 'models/voxtral-mini-transcribe-realtime.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Mistral's hosted Voxtral realtime transcription
 * (`voxtral-mini-transcribe-realtime-2602`) next to the self-hosted vLLM
 * model: `models/voxtral-mini-transcribe-realtime.json`, disabled — it needs a
 * Mistral API key and sends audio to Mistral — so an admin only has to enable
 * it and pick it under Admin → Voice Input or on an app.
 */
export async function up(ctx) {
  // Don't clobber an admin-customized model file.
  if (await ctx.fileExists(MODEL_PATH)) {
    ctx.log('Mistral realtime transcription model already present; skipping');
    return;
  }
  let model;
  try {
    model = await ctx.readDefaultJson(MODEL_PATH);
  } catch {
    ctx.warn('Default Mistral realtime transcription model not found in defaults; skipping');
    return;
  }
  await ctx.writeJson(MODEL_PATH, { ...model, enabled: false, default: false });
  ctx.log(`Seeded ${MODEL_PATH} (disabled); enable it and set a Mistral API key to use it`);
}
