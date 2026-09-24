/**
 * Migration V130 — Tell the model the iHub Documentation source holds the release notes
 *
 * The bundled "iHub Documentation" source (V055) now also carries a Release
 * Notes chapter: the breaking changes, new features and fixes of every
 * release, generated from docs/releases/ by scripts/export-docs-markdown.js.
 * The source is exposed as a tool, and its description is the tool
 * description the model reads when it decides whether to call it — so unless
 * the description mentions the release notes, the iHub Support Bot has no
 * reason to look there for "what changed in 5.5.x?" or "what breaks when I
 * upgrade?".
 *
 * Each language of the description is replaced only while it still reads
 * exactly as V055 shipped it; a description an admin rewrote stays as it is.
 * Fresh installs get the new text from server/defaults/config/sources.json.
 */
export const version = '130';
export const description = 'ihub_documentation_release_notes_description';

const SOURCE_ID = 'ihub-documentation';

export const PREVIOUS_DESCRIPTION = Object.freeze({
  en: 'Full iHub Apps documentation (consolidated from the docs/ folder): configuration, authentication, features, and operations. Use as a knowledge source for apps that answer questions about the iHub platform.',
  de: 'Vollständige iHub-Apps-Dokumentation (zusammengeführt aus dem Ordner docs/): Konfiguration, Authentifizierung, Funktionen und Betrieb. Als Wissensquelle für Apps, die Fragen zur iHub-Plattform beantworten.'
});

export const DESCRIPTION = Object.freeze({
  en: 'Full iHub Apps documentation (consolidated from the docs/ folder): configuration, authentication, features, and operations, plus the release notes of every version (breaking changes, new features, and fixes). Use as a knowledge source for apps that answer questions about the iHub platform, including what changed in a release and what to check before upgrading.',
  de: 'Vollständige iHub-Apps-Dokumentation (zusammengeführt aus dem Ordner docs/): Konfiguration, Authentifizierung, Funktionen und Betrieb, dazu die Versionshinweise jeder Version (Breaking Changes, neue Funktionen und Fehlerbehebungen). Als Wissensquelle für Apps, die Fragen zur iHub-Plattform beantworten – auch dazu, was sich in einem Release geändert hat und was vor einem Upgrade zu prüfen ist.'
});

export async function precondition(ctx) {
  return await ctx.fileExists('config/sources.json');
}

export async function up(ctx) {
  const sources = await ctx.readJson('config/sources.json');
  if (!Array.isArray(sources)) {
    ctx.warn('config/sources.json is not an array — skipping');
    return;
  }

  const source = sources.find(s => s?.id === SOURCE_ID);
  if (!source) {
    ctx.log('iHub Documentation source not present — skipping');
    return;
  }

  const current = source.description;
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    ctx.log('iHub Documentation source has a custom description — leaving it unchanged');
    return;
  }

  const updated = Object.keys(DESCRIPTION).filter(
    lang => current[lang] === PREVIOUS_DESCRIPTION[lang]
  );
  if (updated.length === 0) {
    ctx.log('iHub Documentation source description already updated or customized — skipping');
    return;
  }

  for (const lang of updated) {
    current[lang] = DESCRIPTION[lang];
  }
  await ctx.writeJson('config/sources.json', sources);
  ctx.log(
    `Updated iHub Documentation source description to mention the release notes (${updated.join(', ')})`
  );
}
