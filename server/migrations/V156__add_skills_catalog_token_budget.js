/**
 * Migration V156 — Token budget for the skills list
 *
 * Every turn of an app with skills lists the skills the model may activate,
 * with name and description, in the system prompt. `skills.maxCatalogTokens`
 * caps that list: over the budget, descriptions are shortened (then left out)
 * and the model searches the skills with the `find_skill` tool instead. Fresh
 * installs get the setting from server/defaults/config/platform.json.
 *
 * The value is only added where it is missing; an admin's value stays.
 */
export const version = '156';
export const description = 'add_skills_catalog_token_budget';

export const DEFAULT_MAX_CATALOG_TOKENS = 3000;

/**
 * Run only where a platform config exists.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<boolean>}
 */
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Add `skills.maxCatalogTokens` unless it is set.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  if (ctx.setDefault(platform, 'skills.maxCatalogTokens', DEFAULT_MAX_CATALOG_TOKENS)) {
    await ctx.writeJson('config/platform.json', platform);
    ctx.log(`Added skills.maxCatalogTokens (${DEFAULT_MAX_CATALOG_TOKENS})`);
  } else {
    ctx.log('skills.maxCatalogTokens already set — skipping');
  }
}
