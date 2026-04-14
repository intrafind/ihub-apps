/**
 * Migration V026 — Add supportsAudio/supportsVision flags and remove deprecated models
 *
 * Changes:
 * - Adds supportsAudio: true and supportsVision: true to all Google provider models
 * - Adds supportsAudio: true to OpenAI models that support audio input (gpt-4o, gpt-5, o-series)
 * - Deletes deprecated gemini-2.0-flash-exp and gemini-2.0-flash-thinking-exp-01-21 model files
 * - Updates audio-transcription app: removes allowedModels, updates preferredModel
 */

export const version = '026';
export const description = 'add_audio_vision_support_flags';

const DEPRECATED_MODELS = [
  'models/gemini-2.0-flash-exp.json',
  'models/gemini-2.0-flash-thinking-exp-01-21.json'
];

const OPENAI_AUDIO_MODEL_PATTERNS = ['gpt-4o', 'gpt-5', 'o1', 'o3', 'o4'];

export async function up(ctx) {
  let changes = 0;

  // 1. Update model files with audio/vision flags
  const modelFiles = await ctx.listFiles('models', '*.json');
  for (const file of modelFiles) {
    const filePath = `models/${file}`;
    try {
      const model = await ctx.readJson(filePath);
      let modified = false;

      if (model.provider === 'google') {
        if (model.supportsAudio === undefined) {
          model.supportsAudio = true;
          modified = true;
        }
        if (model.supportsVision === undefined) {
          model.supportsVision = true;
          modified = true;
        }
      }

      if (
        (model.provider === 'openai' || model.provider === 'openai-responses') &&
        model.supportsAudio === undefined
      ) {
        const modelId = (model.modelId || model.id || '').toLowerCase();
        if (OPENAI_AUDIO_MODEL_PATTERNS.some(pattern => modelId.includes(pattern))) {
          model.supportsAudio = true;
          modified = true;
        }
      }

      if (modified) {
        await ctx.writeJson(filePath, model);
        ctx.log(`Updated ${filePath}: added audio/vision flags`);
        changes++;
      }
    } catch (error) {
      ctx.warn(`Failed to process ${filePath}: ${error.message}`);
    }
  }

  // 2. Delete deprecated model files
  for (const modelPath of DEPRECATED_MODELS) {
    if (await ctx.fileExists(modelPath)) {
      await ctx.deleteFile(modelPath);
      ctx.log(`Deleted deprecated model: ${modelPath}`);
      changes++;
    }
  }

  // 3. Update audio-transcription app
  const appPath = 'apps/audio-transcription.json';
  if (await ctx.fileExists(appPath)) {
    try {
      const app = await ctx.readJson(appPath);
      let appModified = false;

      if (app.allowedModels) {
        ctx.removeKey(app, 'allowedModels');
        appModified = true;
        ctx.log('Removed allowedModels restriction from audio-transcription app');
      }

      if (
        app.preferredModel === 'gemini-2.0-flash-exp' ||
        app.preferredModel === 'gemini-2.0-flash-thinking-exp-01-21'
      ) {
        app.preferredModel = 'gemini-flash-latest';
        appModified = true;
        ctx.log('Updated audio-transcription preferredModel to gemini-flash-latest');
      }

      if (appModified) {
        await ctx.writeJson(appPath, app);
        changes++;
      }
    } catch (error) {
      ctx.warn(`Failed to update audio-transcription app: ${error.message}`);
    }
  }

  if (changes === 0) {
    ctx.log('No changes needed (already migrated)');
  } else {
    ctx.log(`Applied ${changes} change(s) for audio/vision support`);
  }
}
