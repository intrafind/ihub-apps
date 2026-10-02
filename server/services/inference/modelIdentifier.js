/**
 * The `model` field of the inference API — a plain model, or an iHub app.
 *
 *   `<modelId>`                a model, no app (e.g. `gpt-5`)
 *   `app:<appId>`              an app on its default model: the app's
 *                              `preferredModel`, else the platform default
 *   `app:<appId>/<modelId>`    an app on an explicitly chosen model
 *
 * App ids and model ids are restricted to `[a-z0-9._-]` (models also allow
 * upper case) by their schemas, so neither can contain `:` or `/` and the
 * form is unambiguous.
 *
 * Resolving an app checks what the chat UI checks, and nothing is silently
 * substituted: the caller must be allowed to use the app and, for an explicit
 * model, the model; the model must be one the app allows (`allowedModels`,
 * `disallowModelSelection`) and must support what the app needs (tools,
 * structured output). The response echoes the resolved `app:<appId>/<modelId>`
 * so a caller can see which real model ran.
 *
 * @module services/inference/modelIdentifier
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import { filterModelsForApp } from '../chat/RequestBuilder.js';
import { findByIdCaseInsensitive, hasIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { InferenceApiError } from './errors.js';
import { appOutputFormat, assertStructuredOutputSupported } from './structuredOutput.js';

export const APP_MODEL_PREFIX = 'app:';

/**
 * Split a `model` value into its app and model parts.
 *
 * @param {unknown} value
 * @returns {{appId: string|null, modelId: string|null}}
 * @throws {InferenceApiError} 400 for a missing or malformed identifier.
 */
export function parseModelIdentifier(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InferenceApiError(400, 'missing_model', 'model is required', { param: 'model' });
  }
  if (!value.startsWith(APP_MODEL_PREFIX)) return { appId: null, modelId: value };
  const rest = value.slice(APP_MODEL_PREFIX.length);
  const slash = rest.indexOf('/');
  const appId = slash === -1 ? rest : rest.slice(0, slash);
  const modelId = slash === -1 ? null : rest.slice(slash + 1);
  if (!appId || (modelId !== null && (!modelId || modelId.includes('/')))) {
    throw new InferenceApiError(
      400,
      'invalid_model',
      `Invalid model identifier '${value}'. Use <modelId>, app:<appId> or app:<appId>/<modelId>.`,
      { param: 'model' }
    );
  }
  return { appId, modelId };
}

/** The identifier echoed for an app run on a model. */
export function appModelLabel(appId, modelId) {
  return `${APP_MODEL_PREFIX}${appId}/${modelId}`;
}

/**
 * Whether `user` may use the resource with `id` under `permissions[key]`.
 * Fails closed: a missing principal or permissions object grants nothing.
 */
function permitted(user, key, id) {
  if (!user?.permissions) return false;
  const allowed = user.permissions[key] || new Set();
  return allowed.has('*') || hasIdCaseInsensitive(allowed, id);
}

/** Whether the principal may use this model (`permissions.models`). */
export function isModelPermitted(user, model) {
  return permitted(user, 'models', model.id);
}

/** Whether the principal may use this app (`permissions.apps`). */
export function isAppPermitted(user, app) {
  return permitted(user, 'apps', app.id);
}

/**
 * The apps a principal may call through the API: enabled chat apps within
 * its app permissions.
 *
 * @param {Object|null} user
 * @returns {Object[]}
 */
export function listInvocableApps(user) {
  const { data: apps = [] } = configCache.getApps();
  return (apps || []).filter(
    app => app && (!app.type || app.type === 'chat') && isAppPermitted(user, app)
  );
}

/** Whether the app runs tools, so any model it uses must support them. */
function appNeedsTools(app) {
  const appToolsActive =
    Array.isArray(app?.apps) &&
    app.apps.length > 0 &&
    isFeatureEnabled('appAsTool', configCache.getFeatures());
  return (
    (Array.isArray(app?.tools) && app.tools.length > 0) ||
    appToolsActive ||
    app?.websearch?.enabled === true
  );
}

/**
 * Check an explicitly chosen model against an app's model rules.
 *
 * @param {Object} app
 * @param {Object} model
 * @param {string} identifier - The `model` value, for messages.
 * @throws {InferenceApiError}
 */
function assertModelFitsApp(app, model, identifier) {
  if (app.disallowModelSelection === true && model.id !== app.preferredModel) {
    throw new InferenceApiError(
      400,
      'model_selection_disabled',
      `App ${app.id} does not allow choosing a model${
        app.preferredModel ? `; use app:${app.id} (runs ${app.preferredModel})` : ''
      }`,
      { param: 'model' }
    );
  }
  if (
    Array.isArray(app.allowedModels) &&
    app.allowedModels.length > 0 &&
    !app.allowedModels.includes(model.id)
  ) {
    throw new InferenceApiError(
      400,
      'model_not_allowed_for_app',
      `Model ${model.id} is not allowed for app ${app.id}. Allowed: ${app.allowedModels.join(', ')}`,
      { param: 'model' }
    );
  }
  if (filterModelsForApp([model], app).length === 0) {
    const reason = appNeedsTools(app) && !model.supportsTools ? ' (tool calling)' : '';
    throw new InferenceApiError(
      400,
      'model_capability_missing',
      `Model ${model.id} does not support what app ${app.id} needs${reason}`,
      { param: 'model' }
    );
  }
  assertStructuredOutputSupported(model, appOutputFormat(app), identifier);
}

/**
 * Resolve the `model` of a request.
 *
 * For an app on its default model the model is left to the chat pipeline's
 * own resolution (`preferredModel`, else the default among the models the
 * app and the caller may use) and `model` is null here.
 *
 * @param {Object} options
 * @param {string} options.model - The request's `model`.
 * @param {Object|null} options.user - The principal, with permissions.
 * @param {(id: string) => Object|null} options.findModel - Enabled-model lookup.
 * @returns {{kind: 'model', model: Object, identifier: string}
 *   | {kind: 'app', app: Object, model: Object|null, modelId: string|null, identifier: string}}
 * @throws {InferenceApiError}
 */
export function resolveInferenceTarget({ model: identifier, user, findModel }) {
  const { appId, modelId } = parseModelIdentifier(identifier);

  if (!appId) {
    const model = findModel(modelId);
    if (!model) {
      throw new InferenceApiError(404, 'model_not_found', `Model not found: ${modelId}`, {
        param: 'model'
      });
    }
    if (!isModelPermitted(user, model)) {
      throw new InferenceApiError(
        403,
        'model_access_denied',
        `Not allowed to use model ${model.id}`,
        {
          param: 'model'
        }
      );
    }
    return { kind: 'model', model, identifier };
  }

  const { data: apps = [] } = configCache.getApps();
  const app = findByIdCaseInsensitive(apps || [], appId);
  // One answer for "does not exist" and "not yours", as `GET /api/apps/:appId` gives.
  if (!app || !isAppPermitted(user, app)) {
    throw new InferenceApiError(404, 'app_not_found', `App not found: ${appId}`, {
      param: 'model'
    });
  }
  if (app.type && app.type !== 'chat') {
    throw new InferenceApiError(
      400,
      'app_not_invocable',
      `App ${app.id} is a ${app.type} app and cannot be called through the API`,
      { param: 'model' }
    );
  }
  if (!modelId) return { kind: 'app', app, model: null, modelId: null, identifier };

  const model = findModel(modelId);
  if (!model) {
    throw new InferenceApiError(404, 'model_not_found', `Model not found: ${modelId}`, {
      param: 'model'
    });
  }
  if (!isModelPermitted(user, model)) {
    throw new InferenceApiError(
      403,
      'model_access_denied',
      `Not allowed to use model ${model.id}`,
      {
        param: 'model'
      }
    );
  }
  assertModelFitsApp(app, model, identifier);
  return { kind: 'app', app, model, modelId: model.id, identifier };
}
