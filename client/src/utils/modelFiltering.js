/**
 * Filter models based on app requirements.
 * Mirrors the server-side filterModelsForApp logic in
 * server/services/chat/RequestBuilder.js so client and server agree on
 * which models are valid for a given app.
 *
 * Applies, in order:
 *   1. app.allowedModels — restrict to listed model IDs
 *   2. app.tools / app.websearch.enabled — require model.supportsTools
 *   3. app.settings.model.filter — match arbitrary model properties
 *
 * @param {Array<Object>} models - Full list of available models
 * @param {Object} app - App configuration
 * @returns {Array<Object>} Filtered models compatible with the app
 */
export function filterModelsForApp(models, app) {
  if (!Array.isArray(models)) return [];
  let filtered = models;

  if (app?.allowedModels && app.allowedModels.length > 0) {
    filtered = filtered.filter(model => app.allowedModels.includes(model.id));
  }

  if ((app?.tools && app.tools.length > 0) || app?.websearch?.enabled) {
    filtered = filtered.filter(model => model.supportsTools);
  }

  if (app?.settings?.model?.filter) {
    const filter = app.settings.model.filter;
    filtered = filtered.filter(model => {
      for (const [key, value] of Object.entries(filter)) {
        if (model[key] !== value) return false;
      }
      return true;
    });
  }

  return filtered;
}

/**
 * Pick the initial model ID for an app from a list of available models.
 * Prefers, in order: app.preferredModel (if compatible), a compatible model
 * flagged default, then the first compatible model. Falls back to the full
 * list's default or first entry when no compatible model exists, to avoid
 * leaving the chat without any selection.
 *
 * @param {Array<Object>} models - Full list of available models
 * @param {Object} app - App configuration
 * @returns {string|null} Initial model ID, or null if no models exist
 */
export function pickInitialModelForApp(models, app) {
  if (!Array.isArray(models) || models.length === 0) return null;

  const compatible = filterModelsForApp(models, app);
  const pool = compatible.length > 0 ? compatible : models;

  if (app?.preferredModel && pool.some(m => m.id === app.preferredModel)) {
    return app.preferredModel;
  }

  const defaultModel = pool.find(m => m.default);
  if (defaultModel) return defaultModel.id;

  return pool[0]?.id || null;
}
