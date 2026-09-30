/**
 * Migration V136 — prompt library texts use `{{content}}`, not `[content]`
 *
 * The prompt library had its own placeholder: `[content]` marked where the
 * user's text goes, while everything else on the platform — app system
 * prompts, prompt templates, the global prompt variables — writes `{{name}}`.
 * Prompt variables (#2519) make the library use `{{name}}` too, and there is
 * one format: `[content]` is no longer recognized, so every prompt that still
 * uses it is rewritten here.
 *
 * Rewritten: each language of `prompt` in every `contents/prompts/*.json`,
 * and in the legacy `config/prompts.json` when an installation still has one.
 * Nothing else in a prompt file is touched, and a file without `[content]` is
 * not written at all.
 */

export const version = '136';
export const description = 'prompt_content_placeholder';

/** The old placeholder and the one that replaces it. */
export const LEGACY_PLACEHOLDER = '[content]';
export const PLACEHOLDER = '{{content}}';

/**
 * A prompt text (a string or a localized object) with the old placeholder
 * replaced, or `null` when there was nothing to replace.
 *
 * @param {*} value - The prompt's `prompt` field.
 * @returns {string|Object|null}
 */
export function migratePromptText(value) {
  if (typeof value === 'string') {
    return value.includes(LEGACY_PLACEHOLDER)
      ? value.split(LEGACY_PLACEHOLDER).join(PLACEHOLDER)
      : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let changed = false;
  const next = {};
  for (const [language, text] of Object.entries(value)) {
    if (typeof text === 'string' && text.includes(LEGACY_PLACEHOLDER)) {
      next[language] = text.split(LEGACY_PLACEHOLDER).join(PLACEHOLDER);
      changed = true;
    } else {
      next[language] = text;
    }
  }
  return changed ? next : null;
}

/**
 * Rewrite one prompt object in place.
 *
 * @param {Object} prompt - A prompt definition.
 * @returns {boolean} Whether it changed.
 */
export function migratePrompt(prompt) {
  if (!prompt || typeof prompt !== 'object') return false;
  const next = migratePromptText(prompt.prompt);
  if (next === null) return false;
  prompt.prompt = next;
  return true;
}

export async function precondition(ctx) {
  const files = await ctx.listFiles('prompts', '*.json');
  return files.length > 0 || (await ctx.fileExists('config/prompts.json'));
}

export async function up(ctx) {
  const updated = [];
  for (const file of await ctx.listFiles('prompts', '*.json')) {
    const relPath = `prompts/${file}`;
    let prompt;
    try {
      prompt = await ctx.readJson(relPath);
    } catch (error) {
      ctx.warn(`${relPath} is not valid JSON — left as is (${error.message})`);
      continue;
    }
    if (migratePrompt(prompt)) {
      await ctx.writeJson(relPath, prompt);
      updated.push(file);
    }
  }

  if (await ctx.fileExists('config/prompts.json')) {
    try {
      const legacy = await ctx.readJson('config/prompts.json');
      const list = Array.isArray(legacy) ? legacy : [];
      let changed = false;
      for (const prompt of list) changed = migratePrompt(prompt) || changed;
      if (changed) {
        await ctx.writeJson('config/prompts.json', legacy);
        updated.push('config/prompts.json');
      }
    } catch (error) {
      ctx.warn(`config/prompts.json could not be migrated — left as is (${error.message})`);
    }
  }

  if (updated.length > 0) {
    ctx.log(
      `Replaced [content] with {{content}} in ${updated.length} prompt file(s): ${updated.join(', ')}`
    );
  } else {
    ctx.log('No prompt used [content]; nothing to change');
  }
}
