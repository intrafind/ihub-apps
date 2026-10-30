// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedString } from '../utils/localize.js';
import { CREATE_DOCX_TOOL } from './documents/docx/docxToolDefinitions.js';
import { CREATE_PDF_TOOL, PREVIEW_PDF_TOOL } from './documents/pdf/pdfToolDefinitions.js';
import { CREATE_PPTX_TOOL } from './documents/pptx/pptxToolDefinitions.js';

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
    CREATE_PPTX_TOOL.id,
    { definition: CREATE_PPTX_TOOL, run: async params => (await pptxTools()).runCreatePptx(params) }
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
  }
};

/**
 * A tool definition adjusted to the app's document templates: with a pinned
 * template the brand parameters go (the template decides), otherwise a
 * `template` choice is offered when templates exist.
 */
function withTemplates(definition, templates, language) {
  if (!definition.usesDocumentTemplate || !templates) {
    return {
      description: getLocalizedString(definition.description, language),
      parameters: definition.parameters
    };
  }
  const description = getLocalizedString(definition.description, language);
  const note = key => getLocalizedString(TEMPLATE_NOTES[key], language);
  if (templates.pinned) {
    const properties = { ...definition.parameters.properties };
    for (const name of definition.brandParameters || []) delete properties[name];
    return {
      description: `${description} ${note('pinned').replace('{name}', templates.pinned.name)}`,
      parameters: { ...definition.parameters, properties }
    };
  }
  if (!templates.choices?.length) return { description, parameters: definition.parameters };
  const list = templates.choices
    .map(t => `"${t.id}": ${t.name}${t.description ? ` (${t.description})` : ''}`)
    .join('; ');
  return {
    description: `${description} ${note('choice')}`,
    parameters: {
      ...definition.parameters,
      properties: {
        ...definition.parameters.properties,
        template: {
          type: 'string',
          enum: ['default', ...templates.choices.map(t => t.id)],
          description: `Document template. "default" uses ${templates.defaultName ? `the default template "${templates.defaultName}"` : 'the built-in design'}. Others: ${list}. Pick another one only when the user asks for it.`
        }
      }
    }
  };
}

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
 *   defaultName }` (see `documents/templates/DocumentTemplateService.js`).
 * @returns {Array<Object>}
 */
export function systemSkillToolsFor(
  skills,
  { language = 'en', model = null, templates = null } = {}
) {
  const tools = [];
  const seen = new Set();
  const acceptsImages = model
    ? model.supportsImages === true || model.supportsVision === true
    : true;
  for (const skill of skills || []) {
    if (!skill?.isSystem || !Array.isArray(skill.providedTools)) continue;
    for (const toolId of skill.providedTools) {
      const entry = REGISTRY.get(toolId);
      if (!entry || seen.has(toolId)) continue;
      if (entry.definition.requiresImageInput && !acceptsImages) continue;
      seen.add(toolId);
      const { definition } = entry;
      const { description, parameters } = withTemplates(definition, templates, language);
      tools.push({
        id: definition.id,
        name: getLocalizedString(definition.name, language),
        description,
        parameters,
        isSystemSkillTool: true,
        skillName: skill.name
      });
    }
  }
  return tools;
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
