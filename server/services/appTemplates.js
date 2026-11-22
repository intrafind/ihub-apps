// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The templates of the app builder (`GET /api/admin/app-templates`, Admin →
 * Apps → New): short starting texts for common apps.
 *
 * A template is a file in `server/appTemplates/`, written for the gallery. It
 * holds content only: texts, input fields, conversation starters, icon,
 * colour and category, in English and German. It binds nothing and changes no
 * setting, so an app started from a template differs from an empty one only
 * in what its author reads on the first screen of the editor.
 *
 * The directory is outside `server/defaults/` on purpose: the setup copies
 * everything under `server/defaults/` into an installation's `contents/`, and
 * a template must not become a file an admin edits.
 *
 * @module services/appTemplates
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { newAppDefaults } from '../../shared/appDefaults.js';
import { unusedVariables } from '../../shared/appPlaceholders.js';

const COMPONENT = 'AppTemplates';

/** Where the template files live: `server/appTemplates/`, next to this module's directory. */
export const APP_TEMPLATES_DIR = fileURLToPath(new URL('../appTemplates/', import.meta.url));

/** The templates, in the order the gallery shows them. Each is `<id>.json` in the directory. */
export const APP_TEMPLATE_IDS = Object.freeze([
  'summarizer',
  'translator',
  'email-composer',
  'plain-language',
  'meeting-minutes',
  'idea-coach'
]);

/** The only keys a template file may hold. */
export const APP_TEMPLATE_KEYS = Object.freeze([
  'id',
  'name',
  'description',
  'icon',
  'color',
  'category',
  'system',
  'prompt',
  'messagePlaceholder',
  'variables',
  'starterPrompts',
  'allowEmptyContent'
]);

/** The languages every text of a template is written in. */
const APP_TEMPLATE_LANGUAGES = Object.freeze(['en', 'de']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Every localized text of a template, as `[path, value]`. */
export function localizedTextsOf(template) {
  const texts = [];
  for (const key of ['name', 'description', 'system', 'prompt', 'messagePlaceholder']) {
    if (template[key] !== undefined) texts.push([key, template[key]]);
  }
  (Array.isArray(template.variables) ? template.variables : []).forEach((variable, index) => {
    const base = `variables[${index}]`;
    for (const key of ['label', 'description', 'placeholder', 'defaultValue']) {
      if (variable?.[key] !== undefined) texts.push([`${base}.${key}`, variable[key]]);
    }
    (Array.isArray(variable?.predefinedValues) ? variable.predefinedValues : []).forEach(
      (option, at) => texts.push([`${base}.predefinedValues[${at}].label`, option?.label])
    );
  });
  (Array.isArray(template.starterPrompts) ? template.starterPrompts : []).forEach(
    (starter, index) => {
      for (const key of ['title', 'message', 'description']) {
        if (starter?.[key] !== undefined) {
          texts.push([`starterPrompts[${index}].${key}`, starter[key]]);
        }
      }
    }
  );
  return texts;
}

/**
 * What is wrong with a template, as a list of sentences; empty when it can be
 * served.
 *
 * - It is an object whose `id` is the one it was asked for.
 * - It holds no key outside {@link APP_TEMPLATE_KEYS}: no binding, no model,
 *   no upload or user setting, no `enabled`.
 * - Every localized text has text in English and in German.
 * - Every input field is used by the instructions or the message template.
 * - The defaults of a new app plus the template pass the app schema.
 *
 * @param {string} id - The ID the template is listed under.
 * @param {unknown} template - The parsed file.
 * @returns {string[]}
 */
export function appTemplateProblems(id, template) {
  if (!isPlainObject(template)) return ['is not a JSON object'];
  const problems = [];
  if (template.id !== id) problems.push(`has the id "${template.id}" instead of "${id}"`);

  const foreign = Object.keys(template).filter(key => !APP_TEMPLATE_KEYS.includes(key));
  if (foreign.length > 0)
    problems.push(`holds keys a template may not hold: ${foreign.join(', ')}`);

  for (const key of ['name', 'description', 'system']) {
    if (!isPlainObject(template[key])) problems.push(`has no ${key}`);
  }
  for (const [at, value] of localizedTextsOf(template)) {
    for (const language of APP_TEMPLATE_LANGUAGES) {
      if (!isPlainObject(value) || typeof value[language] !== 'string' || !value[language].trim()) {
        problems.push(`has no ${language} text for ${at}`);
      }
    }
  }

  const unused = unusedVariables(template).map(variable => variable.name);
  if (unused.length > 0) {
    problems.push(`has input fields that no text uses: ${unused.join(', ')}`);
  }

  const checked = appConfigSchema.safeParse({ ...newAppDefaults('en'), ...template });
  if (!checked.success) {
    const issues = checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
    problems.push(`does not pass the app schema (${issues.join('; ')})`);
  }
  return problems;
}

/** A template as the gallery lists it. `app` is the content a draft is made from. */
function toListItem(template) {
  const { id, ...app } = template;
  return {
    id,
    name: template.name,
    description: template.description,
    icon: template.icon,
    color: template.color,
    category: template.category,
    hasInputFields: Array.isArray(template.variables) && template.variables.length > 0,
    app
  };
}

async function readTemplate(dir, id) {
  let template;
  try {
    template = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
  } catch (error) {
    logger.error('An app template could not be read and is left out', {
      component: COMPONENT,
      templateId: id,
      error: error.message
    });
    return null;
  }
  const problems = appTemplateProblems(id, template);
  if (problems.length > 0) {
    logger.error('An app template failed its check and is left out', {
      component: COMPONENT,
      templateId: id,
      problems
    });
    return null;
  }
  return toListItem(template);
}

let cached = null;

/**
 * The templates of the gallery, in the order of {@link APP_TEMPLATE_IDS}. The
 * files are read once per process; they ship with the server and do not
 * change while it runs. A file that is missing, unreadable or fails
 * {@link appTemplateProblems} is logged and left out, so one broken template
 * does not take the gallery down.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - Another directory to read from. Its result is not cached.
 * @returns {Promise<Array<{ id: string, name: object, description: object, icon: string, color: string, category: string, hasInputFields: boolean, app: object }>>}
 */
export async function loadAppTemplates({ dir } = {}) {
  const read = from =>
    Promise.all(APP_TEMPLATE_IDS.map(id => readTemplate(from, id))).then(items =>
      items.filter(Boolean)
    );
  if (dir) return read(dir);
  cached ??= read(APP_TEMPLATES_DIR);
  return structuredClone(await cached);
}
