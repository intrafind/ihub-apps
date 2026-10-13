/**
 * Migration V164 — the local model for anonymous users
 *
 * The shipped `anonymous` group could use only `gemini-flash-latest`. A
 * self-hosted endpoint (`local-vllm`, provider `local`) that an installation
 * enables therefore stayed invisible to anonymous visitors until an admin
 * granted it by hand. The shipped default now grants it too.
 *
 * This adds `local-vllm` to `groups.anonymous.permissions.models` in existing
 * installations. Nothing else changes:
 *
 * - The grant only takes effect once the model is enabled; a disabled model is
 *   still not served.
 * - A `models` permission of `*` already covers it and is left alone.
 * - A grant that is already listed is not added twice.
 *
 * Idempotent: once the id is listed, the migration writes nothing.
 */

export const version = '164';
export const description = 'anonymous_local_model';

export const ANONYMOUS_MODEL_ID = 'local-vllm';

export async function precondition(ctx) {
  return await ctx.fileExists('config/groups.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/groups.json');
  const anonymous = config?.groups?.anonymous;
  if (!anonymous || typeof anonymous !== 'object') {
    ctx.warn('groups.json has no anonymous group — skipping the local model grant');
    return;
  }

  const models = anonymous.permissions?.models;
  if (!Array.isArray(models)) {
    ctx.warn('anonymous group has no models list — skipping the local model grant');
    return;
  }
  if (models.includes('*') || models.includes(ANONYMOUS_MODEL_ID)) return;

  models.push(ANONYMOUS_MODEL_ID);
  await ctx.writeJson('config/groups.json', config);
  ctx.log(`Granted ${ANONYMOUS_MODEL_ID} to the anonymous group`);
}
