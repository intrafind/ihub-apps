/**
 * Migration V141 — provider names and descriptions become plain text
 *
 * Provider entries in `config/providers.json` carried their `name` and
 * `description` as per-language objects (`{ "en": "OpenAI", "de": "OpenAI" }`).
 * The admin Providers pages now edit them as one plain string each, like the
 * provider's id, so every localized value is collapsed into a string here.
 *
 * The text kept is the one in the platform's default language, else English,
 * else the first non-empty one. Values that already are strings are left
 * alone, and so is everything else on the entry (keys, category, flags).
 */

export const version = '141';
export const description = 'provider_plain_names';

const PROVIDERS_FILE = 'config/providers.json';

export async function precondition(ctx) {
  return await ctx.fileExists(PROVIDERS_FILE);
}

/**
 * Collapse a per-language object into one string.
 * @param {unknown} value
 * @param {string} language - Preferred language
 * @returns {unknown} The string, or the value unchanged when it is not an object
 */
export function toPlainText(value, language) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const candidates = [value[language], value.en, ...Object.values(value)];
  const text = candidates.find(v => typeof v === 'string' && v.trim());
  return text ? text.trim() : '';
}

export async function up(ctx) {
  const file = await ctx.readJson(PROVIDERS_FILE);
  const providers = Array.isArray(file) ? file : file?.providers;
  if (!Array.isArray(providers)) {
    ctx.warn(`${PROVIDERS_FILE} has no providers array — skipping`);
    return;
  }

  const platform = await ctx.readJson('config/platform.json');
  const language =
    typeof platform?.defaultLanguage === 'string' && platform.defaultLanguage
      ? platform.defaultLanguage
      : 'en';

  const changed = [];
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    let touched = false;
    for (const field of ['name', 'description']) {
      const plain = toPlainText(provider[field], language);
      if (plain !== provider[field]) {
        provider[field] = plain;
        touched = true;
      }
    }
    if (!provider.name) {
      provider.name = provider.id;
      touched = true;
    }
    if (touched) changed.push(provider.id);
  }

  if (changed.length === 0) {
    ctx.log('Provider names and descriptions are already plain text');
    return;
  }
  await ctx.writeJson(PROVIDERS_FILE, file);
  ctx.log(`Converted name/description to plain text for: ${changed.join(', ')}`);
}
