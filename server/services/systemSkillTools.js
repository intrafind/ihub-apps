import { getLocalizedString } from '../utils/localize.js';
import { CREATE_PDF_TOOL, PREVIEW_PDF_TOOL } from './documents/pdf/pdfToolDefinitions.js';

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

const REGISTRY = new Map([
  [
    CREATE_PDF_TOOL.id,
    { definition: CREATE_PDF_TOOL, run: async params => (await pdfTools()).runCreatePdf(params) }
  ],
  [
    PREVIEW_PDF_TOOL.id,
    { definition: PREVIEW_PDF_TOOL, run: async params => (await pdfTools()).runPreviewPdf(params) }
  ]
]);

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
 * @returns {Array<Object>}
 */
export function systemSkillToolsFor(skills, { language = 'en', model = null } = {}) {
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
      tools.push({
        id: definition.id,
        name: getLocalizedString(definition.name, language),
        description: getLocalizedString(definition.description, language),
        parameters: definition.parameters,
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
