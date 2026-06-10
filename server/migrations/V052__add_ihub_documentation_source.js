/**
 * Migration V052 — Add the standard "iHub Documentation" source
 *
 * Adds a filesystem source that exposes the full, consolidated iHub Apps
 * documentation so apps can use it as a knowledge source. The content file is
 * copied from server/defaults/sources/ihub-documentation.md into
 * contents/sources/ if it is not already present.
 *
 * The content file is generated at build time (and on `npm run setup:dev`) by
 * scripts/export-docs-markdown.js from the docs/ folder — it is not committed.
 * If it is missing (e.g. a dev checkout where docs were never exported), the
 * copy step is skipped with a warning and the source entry is still added;
 * the file appears on the next docs export / build.
 *
 * Fresh installs receive both the source entry and the content file
 * automatically via server/defaults during performInitialSetup().
 */
import { promises as fs } from 'fs';
import { join } from 'path';

export const version = '052';
export const description = 'add_ihub_documentation_source';

const SOURCE_ID = 'ihub-documentation';
const CONTENT_PATH = 'sources/ihub-documentation.md';

export async function precondition(ctx) {
  return await ctx.fileExists('config/sources.json');
}

export async function up(ctx) {
  // 1. Ensure the consolidated documentation file exists in contents/sources/.
  if (!(await ctx.fileExists(CONTENT_PATH))) {
    try {
      const defaultContent = await fs.readFile(join(ctx.defaultsDir, CONTENT_PATH), 'utf8');
      const targetDir = join(ctx.contentsDir, 'sources');
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(join(ctx.contentsDir, CONTENT_PATH), defaultContent, 'utf8');
      ctx.log(`Copied ${CONTENT_PATH} into contents`);
    } catch (error) {
      ctx.warn(`Could not copy ${CONTENT_PATH}: ${error.message}`);
    }
  }

  // 2. Add the source entry to config/sources.json if missing.
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
