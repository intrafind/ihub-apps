export const version = '073';
export const description = 'seed_voxtral_transcription_model';

const MODEL_PATH = 'models/voxtral-mini-realtime.json';

// Only seed when the models directory exists (an installed instance). Fresh
// installs already receive the default model file via performInitialSetup.
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  // Don't clobber an admin-customized model file.
  if (await ctx.fileExists(MODEL_PATH)) {
    ctx.log('Voxtral transcription model already present; skipping');
    return;
  }

  let model;
  try {
    model = await ctx.readDefaultJson(MODEL_PATH);
  } catch {
    ctx.warn('Default Voxtral transcription model not found in defaults; skipping');
    return;
  }

  // Carry over an already-configured platform.speech.realtime dictation backend
  // so existing installs get a working transcription model out of the box. The
  // apiKey is already encrypted at rest in platform.json, so it stays encrypted
  // on the model file (getApiKeyForModel / the provider decrypt it at runtime).
  try {
    const platform = await ctx.readJson('config/platform.json');
    const rt = platform?.speech?.realtime;
    if (rt && typeof rt === 'object') {
      if (rt.url) model.url = rt.url;
      if (rt.model) model.modelId = rt.model;
      if (rt.apiKey) model.apiKey = rt.apiKey;
      if (rt.enabled === true) model.enabled = true;
    }
  } catch {
    // No platform config or unreadable — seed the plain default model.
  }

  await ctx.writeJson(MODEL_PATH, model);
  ctx.log(
    `Seeded ${MODEL_PATH} (enabled=${model.enabled}); enable it and point its url at your vLLM realtime endpoint to use Voxtral transcription`
  );
}
