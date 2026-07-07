/**
 * Migration V063 — Remove the Tavily web search implementation
 *
 * The Tavily web search provider and its `tavilySearch` tool have been removed
 * from the platform. This migration cleans up existing installations:
 *
 *   1. Removes the `tavilySearch` tool from config/tools.json
 *   2. Removes the `tavily` provider from config/providers.json
 *   3. Rewrites any app whose unified websearch config used `provider: "tavily"`
 *      to `provider: "brave"` (the remaining server-side search provider), so the
 *      app config still passes schema validation. Admins should configure a Brave
 *      Search API key if they previously relied on Tavily.
 */

export const version = '063';
export const description = 'remove_tavily_websearch';

export async function up(ctx) {
  // 1. Remove the tavilySearch tool from config/tools.json
  if (await ctx.fileExists('config/tools.json')) {
    const tools = await ctx.readJson('config/tools.json');
    if (Array.isArray(tools)) {
      const removed = ctx.removeById(tools, 'tavilySearch');
      if (removed) {
        await ctx.writeJson('config/tools.json', tools);
        ctx.log('Removed tavilySearch tool from config/tools.json');
      }
    }
  }

  // 2. Remove the tavily provider from config/providers.json
  if (await ctx.fileExists('config/providers.json')) {
    const providersConfig = await ctx.readJson('config/providers.json');
    if (Array.isArray(providersConfig?.providers)) {
      const removed = ctx.removeById(providersConfig.providers, 'tavily');
      if (removed) {
        await ctx.writeJson('config/providers.json', providersConfig);
        ctx.log('Removed tavily provider from config/providers.json');
      }
    }
  }

  // 3. Rewrite apps that selected the tavily websearch provider
  const appFiles = await ctx.listFiles('apps', '*.json');
  if (Array.isArray(appFiles)) {
    let migrated = 0;
    for (const file of appFiles) {
      const app = await ctx.readJson(`apps/${file}`);
      if (app?.websearch?.provider === 'tavily') {
        app.websearch.provider = 'brave';
        await ctx.writeJson(`apps/${file}`, app);
        ctx.warn(
          `apps/${file} used websearch provider "tavily"; switched to "brave". ` +
            'Configure a Brave Search API key if web search is required.'
        );
        migrated++;
      }
    }
    if (migrated > 0) {
      ctx.log(`Switched ${migrated} app(s) from tavily to brave websearch provider`);
    }
  }
}
