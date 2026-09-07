// server/migrations/V083__simplify_ifinder_source_config.js
export const version = '083';
export const description = 'simplify_ifinder_source_config';

export async function precondition(ctx) {
  return await ctx.fileExists('config/sources.json');
}

/**
 * iFinder sources no longer carry their own connection settings — the base URL
 * and JWT authentication come from the central iFinder integration in
 * platform.json. The per-source `baseUrl`/`apiKey` fields were never read by
 * the handler, and `queryTemplate`/`filters` never reached it either. The new
 * schema rejects unknown keys, so stored configs must be cleaned up.
 */
export async function up(ctx) {
  const sources = await ctx.readJson('config/sources.json');

  if (!Array.isArray(sources)) {
    ctx.warn('config/sources.json is not an array — skipping');
    return;
  }

  let changed = 0;

  for (const source of sources) {
    if (source?.type !== 'ifinder' || typeof source.config !== 'object' || source.config === null) {
      continue;
    }

    const config = source.config;
    let touched = false;

    // Connection settings now come from the central iFinder integration.
    for (const key of ['baseUrl', 'apiKey']) {
      if (key in config) {
        delete config[key];
        touched = true;
      }
    }

    // queryTemplate never reached the handler; carry its value over to the
    // new `query` field, which selects the documents to load.
    if ('queryTemplate' in config) {
      if (
        typeof config.queryTemplate === 'string' &&
        config.queryTemplate.trim() !== '' &&
        !config.query
      ) {
        config.query = config.queryTemplate.trim();
      }
      delete config.queryTemplate;
      touched = true;
    }

    // Dead schema-only field, never used by the handler.
    if ('filters' in config) {
      delete config.filters;
      touched = true;
    }

    // 'default' was auto-injected by the old schema rather than chosen by an
    // admin; dropping it lets the platform-wide search profile apply.
    // Explicitly configured profiles are kept.
    if (config.searchProfile === 'default') {
      delete config.searchProfile;
      touched = true;
    }

    if (touched) {
      source.updated = new Date().toISOString();
      changed++;
    }
  }

  if (changed > 0) {
    await ctx.writeJson('config/sources.json', sources);
  }
  ctx.log(
    `Simplified ${changed} iFinder source config(s) — connection settings now come from the central iFinder integration`
  );
}
