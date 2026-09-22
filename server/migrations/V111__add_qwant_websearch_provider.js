/**
 * Migration V111 — add the keyless Qwant web search provider
 *
 * Until now the only script-backed search engine was Brave, which needs a
 * subscription token. An install without `BRAVE_SEARCH_API_KEY` therefore had
 * web search that failed on every call: the tool was offered to the model, the
 * model called it, and the call came back "Brave Search API key is not
 * configured". Qwant needs no key at all, so it gives those installs working
 * search instead of a tool that only ever errors.
 *
 * Only the `qwant` provider entry is written here, so it shows up under
 * Admin → Providers next to Brave; `requiresApiKey: false` is what stops that
 * page labelling it "Not Configured" when there is nothing to configure.
 * `tools/qwantSearch.json` needs no migration — `copyDefaultConfiguration()`
 * backfills any file missing from `contents/` out of `server/defaults/` on every
 * boot, so the tool definition reaches upgrades on its own. providers.json is
 * an existing file, which is why its new entry does not.
 *
 * Apps are left alone: no app's `websearch.provider` is rewritten. An app set
 * to `"auto"` picks Brave whenever a Brave key is present, so an install that
 * has one keeps searching exactly as before.
 *
 * Shipped as V110 and renumbered to V111: the outbound-proxy defaults landed on
 * main as V110 in parallel, and the runner refuses to start on a duplicate
 * version. Installs that already ran it under the old number are reconciled by
 * `RENAMED_MIGRATIONS` in the runner, so it is not applied twice.
 */

export const version = '111';
export const description = 'Add the keyless Qwant web search provider';

/** Snapshot of the `qwant` entry in server/defaults/config/providers.json as of V111. */
const QWANT_PROVIDER = {
  id: 'qwant',
  name: {
    en: 'Qwant Search',
    de: 'Qwant Suche'
  },
  description: {
    en: 'Qwant web search API — privacy-focused, no API key required',
    de: 'Qwant Websuche-API – datenschutzorientiert, kein API-Schlüssel erforderlich'
  },
  enabled: true,
  category: 'websearch',
  requiresApiKey: false
};

export async function precondition(ctx) {
  return await ctx.fileExists('config/providers.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/providers.json');

  if (!config || !Array.isArray(config.providers)) {
    ctx.warn('providers.json has no providers array — skipping');
    return;
  }

  // An admin who already disabled or edited the entry keeps their version.
  if (config.providers.some(p => p?.id === 'qwant')) {
    ctx.log('Qwant provider already present — leaving it as configured');
    return;
  }

  config.providers.push({ ...QWANT_PROVIDER });
  await ctx.writeJson('config/providers.json', config);
  ctx.log('Added the qwant web search provider to providers.json');
}
