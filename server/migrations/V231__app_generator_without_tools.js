// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V231 — the app generator prompt matches the app schema
 *
 * The shipped `app-generator` prompt (`contents/prompts/app-generator.json`,
 * Admin → Apps → New → Generate with AI) taught the model an app that the
 * schema rejects: its example carried an `actions` list, and its answer
 * schema required a `tools` list, which apps no longer have (#3275). The
 * wizard now sends the prompt's answer schema (it did not before) and adds
 * the installed integrations the app may bind.
 *
 * For the stored prompt, in every language:
 * - the `"actions": [...]` block is removed from the example app;
 * - `tools` leaves the answer schema's properties and `required`;
 * - the answer schema gains the fields the wizard applies — `color`, `icon`,
 *   `prompt`, `variables`, `websearch` — where it does not have them.
 *
 * The prompt text is otherwise the admin's own and is not touched.
 */

export const version = '231';
export const description = 'app_generator_without_tools';

const FILE = 'prompts/app-generator.json';

const LOCALIZED = {
  type: 'object',
  properties: { en: { type: 'string' }, de: { type: 'string' } }
};

const ADDED_PROPERTIES = {
  color: { type: 'string', description: 'Hex color such as #2563EB' },
  icon: { type: 'string' },
  prompt: LOCALIZED,
  variables: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        label: LOCALIZED,
        type: { type: 'string' },
        required: { type: 'boolean' }
      },
      required: ['name', 'label', 'type']
    }
  },
  websearch: {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled']
  }
};

/** The `"actions": [ ... ],` block of the example app (not a field of an app). */
const ACTIONS_BLOCK = /\n[ \t]*"actions": \[\n[\s\S]*?\n[ \t]*\],?(?=\n)/;

export async function precondition(ctx) {
  return await ctx.fileExists(FILE);
}

/**
 * @param {object} prompt - the parsed prompt file
 * @returns {boolean} whether it changed
 */
export function migratePrompt(prompt) {
  let changed = false;
  if (prompt?.prompt && typeof prompt.prompt === 'object') {
    for (const [lang, text] of Object.entries(prompt.prompt)) {
      if (typeof text !== 'string' || !text.includes('"actions"')) continue;
      const next = text.replace(ACTIONS_BLOCK, '');
      if (next !== text) {
        prompt.prompt[lang] = next;
        changed = true;
      }
    }
  }
  const schema = prompt?.outputSchema;
  if (schema && typeof schema === 'object' && schema.properties) {
    if ('tools' in schema.properties) {
      delete schema.properties.tools;
      changed = true;
    }
    if (Array.isArray(schema.required) && schema.required.includes('tools')) {
      schema.required = schema.required.filter(name => name !== 'tools');
      changed = true;
    }
    for (const [name, definition] of Object.entries(ADDED_PROPERTIES)) {
      if (!(name in schema.properties)) {
        schema.properties[name] = structuredClone(definition);
        changed = true;
      }
    }
  }
  return changed;
}

export async function up(ctx) {
  const prompt = await ctx.readJson(FILE);
  if (migratePrompt(prompt)) {
    await ctx.writeJson(FILE, prompt);
    ctx.log(`${FILE}: the example and the answer schema match the app schema`);
  }
}
