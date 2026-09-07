/**
 * Migration V088 — cap provider-run web searches per model call
 *
 * Native web search on Anthropic models is billed per search, and nothing
 * capped how many searches one answer could trigger. `websearch.maxSearches`
 * (sent to Anthropic as `max_uses`) now defaults to 5 — Anthropic's own
 * example value, enough for factual and light comparative questions. Existing
 * apps with a `websearch` block get the default written out so the cap is
 * visible and editable in the app editor; apps without web search are left
 * alone.
 */

const DEFAULT_MAX_SEARCHES = 5;

export const version = '088';
export const description = 'add_websearch_max_searches';

export async function precondition(ctx) {
  const apps = await ctx.listFiles('apps', '*.json');
  return Array.isArray(apps) && apps.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  let patched = 0;

  for (const file of files) {
    const app = await ctx.readJson(`apps/${file}`);
    if (!app || typeof app !== 'object') continue;
    if (!app.websearch || typeof app.websearch !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(app.websearch, 'maxSearches')) continue;

    ctx.setDefault(app, 'websearch.maxSearches', DEFAULT_MAX_SEARCHES);
    await ctx.writeJson(`apps/${file}`, app);
    patched += 1;
    ctx.log(`Set websearch.maxSearches = ${DEFAULT_MAX_SEARCHES} on apps/${file}`);
  }

  if (patched === 0) ctx.log('No app needed a websearch.maxSearches default');
}
