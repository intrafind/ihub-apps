/**
 * Fixed labels printed by the export renderers ("Exported on", "User",
 * "Assistant", the AI-label captions, ...), in English and German.
 *
 * The renderers run on the server and produce finished files, so they cannot
 * use the client's i18n bundles. The export language comes from the request
 * (`doc.language`); anything other than `de` falls back to English.
 *
 * Keys follow the pattern `export.<area>.<element>` so they can move into
 * `shared/i18n/*.json` later without renaming.
 *
 * @module services/provenance/export/renderers/strings
 */

/** Languages the renderers ship strings for. */
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'de']);

const STRINGS = Object.freeze({
  en: Object.freeze({
    'export.header.exportedOn': 'Exported on {date}',
    'export.header.exportedOnLabel': 'Exported on',
    'export.header.app': 'App',
    'export.header.title': 'Title',
    'export.role.user': 'User',
    'export.role.assistant': 'Assistant',
    'export.role.system': 'System',
    'export.role.continued': '{label} (continued)',
    'export.settings.title': 'Settings',
    'export.settings.chatTitle': 'Chat Settings',
    'export.settings.model': 'Model',
    'export.settings.temperature': 'Temperature',
    'export.settings.style': 'Style',
    'export.settings.outputFormat': 'Output Format',
    'export.settings.variables': 'Variables',
    'export.table.role': 'Role',
    'export.table.content': 'Content',
    'export.table.timestamp': 'Timestamp',
    'export.table.model': 'Model',
    'export.table.verification': 'Verification',
    'export.table.sheetMessages': 'Messages',
    'export.label.default': 'AI-generated content',
    'export.label.heading': 'AI label',
    'export.label.badgeCaption': 'AI GENERATED',
    'export.label.badgeAlt': 'AI generated',
    'export.label.humanReviewed': 'Reviewed by a human; editorial responsibility: {contact}',
    'export.label.humanReviewedNoContact': 'Reviewed by a human',
    'export.label.canvasEdited': 'AI-assisted, edited by user',
    'export.verification.notVerified': 'edited after generation / not verified',
    'export.verification.verified': 'verified',
    'export.verification.asserted': 'not verified',
    'export.verification.edited': 'edited after generation',
    'export.verification.human': 'written by a person',
    'export.content.image': 'Image',
    'export.footer.page': '{current} / {total}'
  }),
  de: Object.freeze({
    'export.header.exportedOn': 'Exportiert am {date}',
    'export.header.exportedOnLabel': 'Exportiert am',
    'export.header.app': 'App',
    'export.header.title': 'Titel',
    'export.role.user': 'Benutzer',
    'export.role.assistant': 'Assistent',
    'export.role.system': 'System',
    'export.role.continued': '{label} (Fortsetzung)',
    'export.settings.title': 'Einstellungen',
    'export.settings.chatTitle': 'Chat-Einstellungen',
    'export.settings.model': 'Modell',
    'export.settings.temperature': 'Temperatur',
    'export.settings.style': 'Stil',
    'export.settings.outputFormat': 'Ausgabeformat',
    'export.settings.variables': 'Variablen',
    'export.table.role': 'Rolle',
    'export.table.content': 'Inhalt',
    'export.table.timestamp': 'Zeitpunkt',
    'export.table.model': 'Modell',
    'export.table.verification': 'Prüfstatus',
    'export.table.sheetMessages': 'Nachrichten',
    'export.label.default': 'KI-generierter Inhalt',
    'export.label.heading': 'KI-Kennzeichnung',
    'export.label.badgeCaption': 'KI-GENERIERT',
    'export.label.badgeAlt': 'KI-generiert',
    'export.label.humanReviewed':
      'Von einem Menschen geprüft; redaktionelle Verantwortung: {contact}',
    'export.label.humanReviewedNoContact': 'Von einem Menschen geprüft',
    'export.label.canvasEdited': 'KI-gestützt, vom Benutzer bearbeitet',
    'export.verification.notVerified': 'nach der Erzeugung bearbeitet / nicht verifiziert',
    'export.verification.verified': 'verifiziert',
    'export.verification.asserted': 'nicht verifiziert',
    'export.verification.edited': 'nach der Erzeugung bearbeitet',
    'export.verification.human': 'von einer Person verfasst',
    'export.content.image': 'Bild',
    'export.footer.page': '{current} / {total}'
  })
});

/**
 * Resolve the language the renderers print in.
 *
 * @param {string} [language] - requested language, e.g. `de` or `de-DE`
 * @returns {'en'|'de'} a supported language
 */
export function resolveLanguage(language) {
  const base = String(language || '')
    .toLowerCase()
    .split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : 'en';
}

/**
 * Create a translate function for one export.
 *
 * Placeholders are written as `{name}` and replaced from `params`. A key
 * missing in German falls back to English, and a key missing everywhere is
 * returned as-is so a typo shows up in the file instead of crashing it.
 *
 * @param {string} language - export language (`en` or `de`)
 * @returns {(key: string, params?: Record<string, string|number>) => string} translate function
 * @example
 * const t = createTranslator('de');
 * t('export.header.exportedOn', { date: '29.09.2026' }); // "Exportiert am 29.09.2026"
 */
export function createTranslator(language) {
  const table = STRINGS[resolveLanguage(language)];
  return (key, params = {}) => {
    const template = table[key] ?? STRINGS.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    );
  };
}
