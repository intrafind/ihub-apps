// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V262 — anonymous visitors use only the default model
 *
 * The shipped `anonymous` group granted two named models
 * (`gemini-flash-latest`, and `local-vllm` since V164). Every signed-in user
 * inherits the anonymous group (`authenticated` inherits it), so those models
 * could never be restricted to a smaller group such as HR: removing them from
 * one group still left them granted through `anonymous`.
 *
 * The shipped default is now `["@default"]`: the default-model token
 * (`shared/modelPermissions.js`), which grants whichever model is the platform
 * default at the time of the check and follows when an admin makes another
 * model the default.
 *
 * This rewrites `groups.anonymous.permissions.models` to `["@default"]` only
 * when it still holds a shipped value, in any order:
 *
 * - `["gemini-flash-latest", "local-vllm"]` — shipped since V164;
 * - `["gemini-flash-latest"]` — shipped before V164 (an install whose V164
 *   ran already has the pair above; the single entry is kept for an install
 *   that restored an older `groups.json`);
 * - `["@default", "local-vllm"]` — a fresh install: it is seeded from the new
 *   defaults (`["@default"]`), then runs every migration above the baseline,
 *   and V164 appends `local-vllm`. The token did not exist before this
 *   release, so no admin can have chosen this list.
 *
 * Any other list — an admin's own choice, `*`, a list with more or fewer
 * models — is left alone, and the migration logs why. A missing group or list
 * is left alone too.
 *
 * Idempotent: once the list is `["@default"]`, the migration writes nothing.
 */

export const version = '262';
export const description = 'anonymous_default_model_only';

/** The default-model token; the value of `DEFAULT_MODEL_TOKEN` in `shared/modelPermissions.js`. */
export const DEFAULT_MODEL_TOKEN = '@default';

/** The lists that count as shipped, compared without regard to order. */
export const SHIPPED_ANONYMOUS_MODEL_LISTS = Object.freeze([
  ['gemini-flash-latest', 'local-vllm'],
  ['gemini-flash-latest'],
  [DEFAULT_MODEL_TOKEN, 'local-vllm']
]);

export async function precondition(ctx) {
  return await ctx.fileExists('config/groups.json');
}

/** The anonymous group's models list, or null when the group or list is missing. */
function anonymousModels(config) {
  const models = config?.groups?.anonymous?.permissions?.models;
  return Array.isArray(models) ? models : null;
}

/**
 * Whether `models` is one of the shipped lists, in any order.
 *
 * @param {unknown[]} models
 * @returns {boolean}
 */
export function isShippedAnonymousModelList(models) {
  if (!Array.isArray(models)) return false;
  const byId = (a, b) => a.localeCompare(b);
  const sorted = [...models].map(String).sort(byId);
  return SHIPPED_ANONYMOUS_MODEL_LISTS.some(shipped => {
    const expected = [...shipped].sort(byId);
    return expected.length === sorted.length && expected.every((id, index) => id === sorted[index]);
  });
}

export async function up(ctx) {
  const config = await ctx.readJson('config/groups.json');
  const models = anonymousModels(config);
  if (!models) {
    ctx.warn('groups.json has no anonymous models list — leaving it alone');
    return;
  }
  if (models.length === 1 && models[0] === DEFAULT_MODEL_TOKEN) return;
  if (!isShippedAnonymousModelList(models)) {
    ctx.log(
      `Left the anonymous group's models (${JSON.stringify(models)}) alone: ` +
        'they were changed from the shipped list, so they stay as the admin set them'
    );
    return;
  }

  config.groups.anonymous.permissions.models = [DEFAULT_MODEL_TOKEN];
  await ctx.writeJson('config/groups.json', config);
  ctx.log(
    `The anonymous group now uses only the default model (${DEFAULT_MODEL_TOKEN}) ` +
      `instead of ${JSON.stringify(models)}`
  );
}
