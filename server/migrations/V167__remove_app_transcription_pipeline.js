/**
 * Migration V167 — Remove the per-app transcription pipeline
 *
 * Transcription models (`modelType: "transcription"`) are now picked in the
 * chat's model selector; audio always goes to the selected model. The hidden
 * per-app pipeline is gone, and with it the app block
 * `transcription: { enabled, defaultEnabled, modelId, inputs, streaming,
 * maxDurationSeconds }` and the platform setting
 * `speech.transcription.defaultModelId`.
 *
 * Per app file:
 *   - If `transcription.enabled === true` and a model is named
 *     (`transcription.modelId`, else the platform's
 *     `speech.transcription.defaultModelId`), and the app restricts
 *     `allowedModels` (a non-empty array) without that model, the model id is
 *     appended so users can still select it.
 *   - The `transcription` block is deleted.
 *
 * Then `speech.transcription` is removed from `config/platform.json`.
 *
 * Dictation (`speech.dictation`, `speech.defaultService`,
 * `settings.speechRecognition`) is not touched. Running it again changes
 * nothing: no `transcription` keys are left.
 */

export const version = '167';
export const description = 'remove_app_transcription_pipeline';

const PLATFORM_PATH = 'config/platform.json';

/** The model an app transcribed with, when its transcription was on. */
function transcriptionModelOf(app, platformDefault) {
  const block = app.transcription;
  if (block?.enabled !== true) return '';
  return block.modelId || platformDefault || '';
}

async function migrateApp(ctx, relativePath, platformDefault) {
  let app;
  try {
    app = await ctx.readJson(relativePath);
  } catch (error) {
    ctx.warn(`Skipping ${relativePath}: ${error.message}`);
    return;
  }
  if (!app || typeof app !== 'object' || Array.isArray(app)) return;
  if (!Object.hasOwn(app, 'transcription')) return;

  const modelId = transcriptionModelOf(app, platformDefault);
  const restricted = Array.isArray(app.allowedModels) && app.allowedModels.length > 0;
  if (modelId && restricted && !app.allowedModels.includes(modelId)) {
    app.allowedModels.push(modelId);
    ctx.log(`Added transcription model ${modelId} to allowedModels of ${relativePath}`);
  }
  delete app.transcription;
  await ctx.writeJson(relativePath, app);
  ctx.log(`Removed transcription block from ${relativePath}`);
}

export async function up(ctx) {
  let platform = null;
  if (await ctx.fileExists(PLATFORM_PATH)) {
    try {
      platform = await ctx.readJson(PLATFORM_PATH);
    } catch (error) {
      ctx.warn(`Could not read ${PLATFORM_PATH}: ${error.message}`);
    }
  }
  const platformDefault = platform?.speech?.transcription?.defaultModelId;

  const files = await ctx.listFiles('apps', '*.json');
  // One app at a time: the log reads in file order.
  for (const file of files) await migrateApp(ctx, `apps/${file}`, platformDefault);

  if (
    platform?.speech &&
    typeof platform.speech === 'object' &&
    'transcription' in platform.speech
  ) {
    delete platform.speech.transcription;
    await ctx.writeJson(PLATFORM_PATH, platform);
    ctx.log('Removed speech.transcription from platform.json');
  }
}
