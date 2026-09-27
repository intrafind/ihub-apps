/**
 * Editing one language of a localized config field (`{ en: '…', de: '…' }`)
 * in a plain text input without losing the other languages.
 *
 * Admin forms such as the A2A agents dialog edit a name or description in a
 * single input, while the stored value may carry several translations and the
 * PUT route replaces the whole record. `editableText` picks the text to show,
 * `mergeLocalizedText` writes the edited text back into the stored value.
 *
 * @example
 *   const stored = { en: 'Langdock', de: 'Langdock-Agent' };
 *   const { text, lang } = editableText(stored); // { text: 'Langdock', lang: 'en' }
 *   mergeLocalizedText(stored, 'Langdock agent', lang);
 *   // → { en: 'Langdock agent', de: 'Langdock-Agent' }
 */

/**
 * The text a form edits for a localized-or-plain value, and the language it
 * belongs to: English when present, else the first language stored.
 *
 * @param {string|Object<string,string>|undefined|null} value
 * @returns {{text: string, lang: string}}
 */
export function editableText(value) {
  if (!value) return { text: '', lang: 'en' };
  if (typeof value === 'string') return { text: value, lang: 'en' };
  if (typeof value.en === 'string' && value.en) return { text: value.en, lang: 'en' };
  const [lang, text] = Object.entries(value).find(([, v]) => typeof v === 'string' && v) || [];
  return lang ? { text, lang } : { text: '', lang: 'en' };
}

/**
 * The value to save: the stored translations with `lang` set to `text`. An
 * empty `text` removes that language; nothing left gives `undefined`.
 *
 * @param {string|Object<string,string>|undefined|null} original - What was stored
 * @param {string} text - The edited text
 * @param {string} [lang='en'] - The language the text is in
 * @returns {Object<string,string>|undefined}
 */
export function mergeLocalizedText(original, text, lang = 'en') {
  const base =
    original && typeof original === 'object' && !Array.isArray(original) ? { ...original } : {};
  if (text) base[lang] = text;
  else delete base[lang];
  return Object.keys(base).length > 0 ? base : undefined;
}
