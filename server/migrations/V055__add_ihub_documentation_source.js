/**
 * Migration V052 — Add the standard "iHub Documentation" source
 *
 * Adds a filesystem source that exposes the full, consolidated iHub Apps
 * documentation so apps can use it as a knowledge source.
 *
 * This migration only registers the source entry in config/sources.json. The
 * content file (sources/ihub-documentation.md) is generated at build time by
 * scripts/export-docs-markdown.js and kept in sync in the contents directory
 * by syncManagedDefaultFiles() on every server startup, so it never goes stale
 * after an upgrade.
 *
 * Fresh installs receive the source entry automatically via
 * server/defaults/config/sources.json during performInitialSetup().
 */
export const version = '055';
export const description = 'add_ihub_documentation_source';

const SOURCE_ID = 'ihub-documentation';
const CONTENT_PATH = 'sources/ihub-documentation.md';

export async function precondition(ctx) {
  return await ctx.fileExists('config/sources.json');
}

export async function up(ctx) {
  const sources = await ctx.readJson('config/sources.json');
  if (!Array.isArray(sources)) {
    ctx.warn('config/sources.json is not an array — skipping');
    return;
  }

  const added = ctx.addIfMissing(
    sources,
    {
      id: SOURCE_ID,
      name: {
        en: 'iHub Documentation',
        de: 'iHub-Dokumentation'
      },
      description: {
        en: 'Full iHub Apps documentation (consolidated from the docs/ folder): configuration, authentication, features, and operations. Use as a knowledge source for apps that answer questions about the iHub platform.',
        de: 'Vollständige iHub-Apps-Dokumentation (zusammengeführt aus dem Ordner docs/): Konfiguration, Authentifizierung, Funktionen und Betrieb. Als Wissensquelle für Apps, die Fragen zur iHub-Plattform beantworten.'
      },
      type: 'filesystem',
      enabled: true,
      exposeAs: 'tool',
      category: 'documentation',
      tags: ['documentation', 'ihub', 'help'],
      config: {
        path: CONTENT_PATH,
        encoding: 'utf-8'
      },
      caching: {
        ttl: 3600,
        strategy: 'static',
        enabled: true
      }
    },
    'id'
  );

  if (added) {
    await ctx.writeJson('config/sources.json', sources);
    ctx.log('Added iHub Documentation source');
  } else {
    ctx.log('iHub Documentation source already present — skipping');
  }
}
