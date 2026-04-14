/**
 * Migration V024 — Migrate websearch tools to unified websearch config
 *
 * Converts app configs that have individual websearch tool IDs in their tools[]
 * array to the new unified app.websearch config object. The old fragmented tools
 * (braveSearch, enhancedWebSearch, tavilySearch, googleSearch, webSearch,
 * webContentExtractor) are removed from app.tools and replaced by a single
 * app.websearch configuration that the server resolves to the right tool at
 * runtime based on the active model's provider.
 */

export const version = '024';
export const description = 'migrate_websearch_tools';

const WEBSEARCH_TOOL_IDS = [
  'braveSearch',
  'enhancedWebSearch',
  'tavilySearch',
  'googleSearch',
  'webSearch',
  'webContentExtractor'
];

export async function precondition(ctx) {
  // Only run if apps directory exists
  const files = await ctx.listFiles('apps', '*.json');
  return Array.isArray(files) && files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  let migrated = 0;

  for (const file of files) {
    const app = await ctx.readJson(`apps/${file}`);

    // Skip if no tools array or already has websearch config
    if (!Array.isArray(app.tools) || app.websearch) continue;

    const hasWebsearchTools = app.tools.some(t => WEBSEARCH_TOOL_IDS.includes(t));
    if (!hasWebsearchTools) continue;

    // Infer provider from which tools were configured
    const hasTavily = app.tools.includes('tavilySearch');
    const hasBrave = app.tools.includes('braveSearch') || app.tools.includes('enhancedWebSearch');
    let provider = 'auto';
    if (hasTavily && !hasBrave) {
      provider = 'tavily';
    } else if (hasBrave && !hasTavily) {
      provider = 'brave';
    }

    // Infer extractContent from whether content extraction was part of the config
    const extractContent =
      app.tools.includes('enhancedWebSearch') || app.tools.includes('webContentExtractor');

    app.websearch = {
      enabled: true,
      provider,
      useNativeSearch: true,
      maxResults: 5,
      extractContent,
      contentMaxLength: 3000,
      enabledByDefault: false
    };

    // Remove all websearch-related tool IDs from the tools array
    app.tools = app.tools.filter(t => !WEBSEARCH_TOOL_IDS.includes(t));

    await ctx.writeJson(`apps/${file}`, app);
    ctx.log(
      `Migrated websearch config in apps/${file} (provider: ${provider}, extractContent: ${extractContent})`
    );
    migrated++;
  }

  if (migrated === 0) {
    ctx.log('No apps required websearch migration');
  } else {
    ctx.log(`Migrated ${migrated} app(s) to unified websearch config`);
  }
}
