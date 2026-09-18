/**
 * Migration V116 — add the Staan (staan.ai) web search provider
 *
 * Staan is the third search engine behind `WebSearchService`, and the one that
 * fits the common deployment best: Brave needs a paid subscription, and Qwant —
 * the keyless option — is fronted by DataDome, which answers requests from
 * data-centre IP ranges with a captcha. An install running on cloud hosting
 * therefore has exactly one working option today, and it costs money. Staan is
 * a keyed API that answers from anywhere, so it gives those installs a second.
 *
 * Only the `staan` provider entry is written here, so it shows up under
 * Admin → Providers next to Brave and Qwant with a field for its API key.
 * `tools/staanSearch.json` needs no migration — `copyDefaultConfiguration()`
 * backfills any file missing from `contents/` out of `server/defaults/` on every
 * boot, so the tool definition reaches upgrades on its own. providers.json is
 * an existing file, which is why its new entry does not.
 *
 * Apps are left alone: no app's `websearch.provider` is rewritten, and `"auto"`
 * still prefers Brave wherever a Brave key is configured. An install that adds
 * a Staan key but no Brave key moves from Qwant to Staan under `"auto"`, which
 * is the point — on most hosts Qwant is the one that cannot answer.
 *
 * Renumbered twice while this branch was open — V112, then V114, now V116: the
 * CIMD governance migrations took V112/V113 and the proxy-defaults fix took
 * V114, both on main in parallel, and the runner refuses to start on a
 * duplicate version. Installs that already ran this from the branch under
 * either old number are reconciled by `RENAMED_MIGRATIONS` in the runner, so it
 * is never applied twice.
 */

export const version = '116';
export const description = 'Add the Staan (staan.ai) web search provider';

/** Snapshot of the `staan` entry in server/defaults/config/providers.json as of V116. */
const STAAN_PROVIDER = {
  id: 'staan',
  name: {
    en: 'Staan Search',
    de: 'Staan Suche'
  },
  description: {
    en: 'Staan (staan.ai) web search API — European search index, requires an API key',
    de: 'Staan (staan.ai) Websuche-API – europäischer Suchindex, API-Schlüssel erforderlich'
  },
  enabled: true,
  category: 'websearch'
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

  // An admin who already added, disabled or edited the entry keeps their
  // version — re-adding it would wipe a configured API key.
  if (config.providers.some(p => p?.id === 'staan')) {
    ctx.log('Staan provider already present — leaving it as configured');
    return;
  }

  config.providers.push({ ...STAAN_PROVIDER });
  await ctx.writeJson('config/providers.json', config);
  ctx.log('Added the staan web search provider to providers.json');
}
