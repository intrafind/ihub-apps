// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedString } from '../utils/localize.js';
import { CREATE_DOCX_TOOL, EDIT_DOCX_TOOL } from './documents/docx/docxToolDefinitions.js';
import {
  CREATE_DASHBOARD_TOOL,
  EDIT_DASHBOARD_TOOL
} from './documents/webArtifacts/dashboardToolDefinitions.js';
import { CREATE_FILE_TOOL, CREATE_ZIP_TOOL } from './documents/files/fileToolDefinitions.js';
import { CREATE_PDF_TOOL, PREVIEW_PDF_TOOL } from './documents/pdf/pdfToolDefinitions.js';
import {
  CREATE_PPTX_TOOL,
  EDIT_PPTX_TOOL,
  RESTYLE_PPTX_TOOL
} from './documents/pptx/pptxToolDefinitions.js';
import {
  CREATE_WEB_ARTIFACT_TOOL,
  EDIT_WEB_ARTIFACT_TOOL
} from './documents/webArtifacts/webArtifactToolDefinitions.js';
import { CREATE_XLSX_TOOL, EDIT_XLSX_TOOL } from './documents/xlsx/xlsxToolDefinitions.js';

/**
 * Built-in tools that system skills bring with them.
 *
 * A system skill (see `skillLoader.js`) names the tools it needs in its
 * `allowed-tools` frontmatter; an app that enables the skill offers those
 * tools to the model. Only ids registered here can be provided that way, and
 * only by system skills — a skill an admin installs cannot enable tools.
 *
 * The tools are not in `contents/tools`, so admins cannot edit them; they are
 * governed by the skill they belong to (the `skills` feature, the app's
 * `skills` and the user's `permissions.skills`).
 */

const pdfTools = () => import('./documents/pdf/pdfTools.js');
const docxTools = () => import('./documents/docx/docxTools.js');
const pptxTools = () => import('./documents/pptx/pptxTools.js');
const xlsxTools = () => import('./documents/xlsx/xlsxTools.js');
const webArtifactTools = () => import('./documents/webArtifacts/webArtifactTools.js');
const dashboardTools = () => import('./documents/webArtifacts/dashboardTools.js');
const fileTools = () => import('./documents/files/fileTools.js');

const REGISTRY = new Map([
  [
    CREATE_PDF_TOOL.id,
    { definition: CREATE_PDF_TOOL, run: async params => (await pdfTools()).runCreatePdf(params) }
  ],
  [
    PREVIEW_PDF_TOOL.id,
    { definition: PREVIEW_PDF_TOOL, run: async params => (await pdfTools()).runPreviewPdf(params) }
  ],
  [
    CREATE_DOCX_TOOL.id,
    { definition: CREATE_DOCX_TOOL, run: async params => (await docxTools()).runCreateDocx(params) }
  ],
  [
    EDIT_DOCX_TOOL.id,
    { definition: EDIT_DOCX_TOOL, run: async params => (await docxTools()).runEditDocx(params) }
  ],
  [
    CREATE_PPTX_TOOL.id,
    { definition: CREATE_PPTX_TOOL, run: async params => (await pptxTools()).runCreatePptx(params) }
  ],
  [
    RESTYLE_PPTX_TOOL.id,
    {
      definition: RESTYLE_PPTX_TOOL,
      run: async params => (await pptxTools()).runRestylePptx(params)
    }
  ],
  [
    EDIT_PPTX_TOOL.id,
    { definition: EDIT_PPTX_TOOL, run: async params => (await pptxTools()).runEditPptx(params) }
  ],
  [
    CREATE_XLSX_TOOL.id,
    { definition: CREATE_XLSX_TOOL, run: async params => (await xlsxTools()).runCreateXlsx(params) }
  ],
  [
    EDIT_XLSX_TOOL.id,
    { definition: EDIT_XLSX_TOOL, run: async params => (await xlsxTools()).runEditXlsx(params) }
  ],
  [
    CREATE_WEB_ARTIFACT_TOOL.id,
    {
      definition: CREATE_WEB_ARTIFACT_TOOL,
      run: async params => (await webArtifactTools()).runCreateWebArtifact(params)
    }
  ],
  [
    EDIT_WEB_ARTIFACT_TOOL.id,
    {
      definition: EDIT_WEB_ARTIFACT_TOOL,
      run: async params => (await webArtifactTools()).runEditWebArtifact(params)
    }
  ],
  [
    CREATE_DASHBOARD_TOOL.id,
    {
      definition: CREATE_DASHBOARD_TOOL,
      run: async params => (await dashboardTools()).runCreateDashboard(params)
    }
  ],
  [
    EDIT_DASHBOARD_TOOL.id,
    {
      definition: EDIT_DASHBOARD_TOOL,
      run: async params => (await dashboardTools()).runEditDashboard(params)
    }
  ],
  [
    CREATE_FILE_TOOL.id,
    { definition: CREATE_FILE_TOOL, run: async params => (await fileTools()).runCreateFile(params) }
  ],
  [
    CREATE_ZIP_TOOL.id,
    { definition: CREATE_ZIP_TOOL, run: async params => (await fileTools()).runCreateZip(params) }
  ]
]);

/**
 * Whether any of the given skills brings a tool that renders in a document
 * template — then the caller looks the templates up (see
 * {@link systemSkillToolsFor}'s `templates` option).
 *
 * @param {Array<{ isSystem?: boolean, providedTools?: string[] }>} skills
 * @returns {boolean}
 */
export function usesDocumentTemplates(skills) {
  return (skills || []).some(
    skill =>
      skill?.isSystem &&
      (skill.providedTools || []).some(id => REGISTRY.get(id)?.definition.usesDocumentTemplate)
  );
}

const TEMPLATE_NOTES = {
  pinned: {
    en: 'Documents use the corporate document template "{name}": its fonts, colours, logo and page setup are applied automatically — do not set them.',
    de: 'Dokumente verwenden die Unternehmensvorlage "{name}": Schriften, Farben, Logo und Seitenformat werden automatisch angewendet – nicht selbst setzen.'
  },
  choice: {
    en: 'Corporate document templates are available (parameter "template"); a template overrides theme, colours and fonts.',
    de: 'Unternehmensvorlagen sind verfügbar (Parameter "template"); eine Vorlage ersetzt Design, Farben und Schriften.'
  },
  brand: {
    en: "Brand of the template (read-only): primary colour {primary}, accent colour {accent}, text colour {text}; palette {palette}; fonts: headings {heading}, body {body} (names only: the reader's computer may not have them).",
    de: 'Marke der Vorlage (nur lesen): Hauptfarbe {primary}, Akzentfarbe {accent}, Textfarbe {text}; Palette {palette}; Schriften: Überschriften {heading}, Text {body} (nur Namen: auf dem Rechner des Lesers können sie fehlen).'
  }
};

/** What the model is told about the brand of the template that applies, or an empty string. */
function brandNote(brand, language) {
  if (!brand) return '';
  const fonts = [brand.headingFont, brand.bodyFont];
  return getLocalizedString(TEMPLATE_NOTES.brand, language)
    .replace('{primary}', brand.primaryColor)
    .replace('{accent}', brand.accentColor)
    .replace('{text}', brand.textColor)
    .replace('{palette}', (brand.palette || []).join(', '))
    .replace('{heading}', fonts[0] || fonts[1] || '—')
    .replace('{body}', fonts[1] || fonts[0] || '—');
}

/**
 * The parameters a tool offers: without the ones a pinned template decides
 * (`removed`), and without the field parameters when no template has fields.
 */
function offeredParameters(definition, templates, removed = []) {
  const names = [...removed, ...(templates?.fieldsApply ? [] : definition.fieldParameters || [])];
  if (!names.length) return definition.parameters;
  const properties = { ...definition.parameters.properties };
  for (const name of names) delete properties[name];
  return { ...definition.parameters, properties };
}

/**
 * A tool definition adjusted to the app's document templates: with a pinned
 * template the brand parameters go (the template decides), otherwise a
 * `template` choice is offered when templates exist. The parameters for the
 * template's own fields are offered only when a template has fields.
 */
function withTemplates(definition, templates, language) {
  if (!definition.usesDocumentTemplate || !templates) {
    return {
      description: getLocalizedString(definition.description, language),
      parameters: offeredParameters(definition, templates)
    };
  }
  const guide = definition.templateGuide ? templates.guides?.[definition.templateGuide] : '';
  // Each tool is told the brand its own output uses (a Word document follows the Word theme first).
  const brand = brandNote(
    templates.brands && definition.templateGuide in templates.brands
      ? templates.brands[definition.templateGuide]
      : templates.brand,
    language
  );
  const description = [getLocalizedString(definition.description, language), guide, brand]
    .filter(Boolean)
    .join('\n\n');
  const note = key => getLocalizedString(TEMPLATE_NOTES[key], language);
  if (templates.pinned) {
    return {
      description: `${description} ${note('pinned').replace('{name}', templates.pinned.name)}`,
      parameters: offeredParameters(definition, templates, definition.brandParameters)
    };
  }
  const parameters = offeredParameters(definition, templates);
  if (!templates.choices?.length) return { description, parameters };
  const list = templates.choices
    .map(t => `"${t.id}": ${t.name}${t.description ? ` (${t.description})` : ''}`)
    .join('; ');
  return {
    description: `${description} ${note('choice')}`,
    parameters: {
      ...parameters,
      properties: {
        ...parameters.properties,
        template: {
          type: 'string',
          enum: ['default', ...templates.choices.map(t => t.id)],
          description: `Document template. "default" uses ${templates.defaultName ? `the default template "${templates.defaultName}"` : 'the built-in design'}. Others: ${list}. Pick another one only when the user asks for it.`
        }
      }
    }
  };
}

/** The ids of the tools system skills bring (`create_pdf`, `create_docx`, `edit_docx`, …). */
export const SYSTEM_SKILL_TOOL_IDS = Object.freeze([...REGISTRY.keys()]);

/**
 * Whether a tool id is a registered system skill tool.
 *
 * @param {string} toolId
 * @returns {boolean}
 */
export function isSystemSkillTool(toolId) {
  return REGISTRY.has(toolId);
}

/**
 * The tool definitions the given skills provide, localized.
 *
 * @param {Array<{ name: string, isSystem?: boolean, providedTools?: string[] }>} skills -
 *   Skills the app enables and the user may use.
 * @param {Object} [options]
 * @param {string} [options.language]
 * @param {Object} [options.model] - Model config; tools that need image input
 *   are left out for a model that cannot see images.
 * @param {Object} [options.templates] - The document templates for this app:
 *   `{ pinned: { id, name } | null, choices: [{ id, name, description }],
 *   defaultName, guides }` (see `documents/templates/DocumentTemplateService.js`).
 * @returns {Array<Object>}
 */
export function systemSkillToolsFor(
  skills,
  { language = 'en', model = null, templates = null } = {}
) {
  const seen = new Set();
  const acceptsImages = !model || model.supportsImages === true || model.supportsVision === true;
  const tools = [];
  for (const skill of skills || []) {
    for (const { definition } of providedEntries(skill, seen, acceptsImages)) {
      tools.push(toolOfDefinition(definition, skill.name, { templates, language }));
    }
  }
  return tools;
}

/**
 * The registered tools a system skill provides that are still to be offered:
 * not offered through an earlier skill, and not one that needs image input for
 * a model that cannot see images. Marks what it returns in `seen`.
 *
 * @param {{ isSystem?: boolean, providedTools?: string[] }} skill
 * @param {Set<string>} seen - tool ids already offered (mutated)
 * @param {boolean} acceptsImages
 * @returns {Array<{ definition: Object }>}
 */
function providedEntries(skill, seen, acceptsImages) {
  if (!skill?.isSystem || !Array.isArray(skill.providedTools)) return [];
  const entries = [];
  for (const toolId of skill.providedTools) {
    const entry = REGISTRY.get(toolId);
    if (!entry || seen.has(toolId)) continue;
    if (entry.definition.requiresImageInput && !acceptsImages) continue;
    seen.add(toolId);
    entries.push(entry);
  }
  return entries;
}

/** A tool definition as the model is offered it: localized, adjusted to the templates, marked as a system-skill tool. */
function toolOfDefinition(definition, skillName, { templates, language }) {
  const { description, parameters } = withTemplates(definition, templates, language);
  return {
    id: definition.id,
    name: getLocalizedString(definition.name, language),
    description,
    parameters,
    isSystemSkillTool: true,
    // What the tool produces (`utils/toolDisplay.js` `outputKindOf`), for the
    // creators of a file or a document; the other tools bring none.
    ...(definition.outputKind ? { outputKind: definition.outputKind } : {}),
    skillName
  };
}

/**
 * Run a system skill tool.
 *
 * @param {string} toolId
 * @param {Object} params - Model arguments plus the trusted context (`user`,
 *   `chatId`, `appConfig`).
 * @returns {Promise<Object>}
 */
export async function runSystemSkillTool(toolId, params) {
  const entry = REGISTRY.get(toolId);
  if (!entry) throw new Error(`Unknown system skill tool: ${toolId}`);
  return entry.run(params);
}
