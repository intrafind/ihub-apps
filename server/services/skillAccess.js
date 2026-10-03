/**
 * Skill access: which skills a request may load.
 *
 * A skill is usable when it is installed, listed on the app (or the agent
 * node) the request runs in, and granted to the user's groups. Every path
 * that loads a skill body or file asks this module: the `activate_skill` and
 * `read_skill_resource` tools, `requestedSkills` pre-activation and the agent
 * planner. Keeping the check in one place means a new way of loading a skill
 * cannot forget part of it.
 *
 * @module services/skillAccess
 */

import configCache from '../configCache.js';
import { isFeatureEnabled } from '../featureRegistry.js';

/**
 * The skill ids assigned to the context a tool call runs in: an agent node's
 * own list (`_skillIds`, set by the prompt node executor) or the app's
 * `skills`.
 *
 * @param {Object} [appConfig] - App config handed to the tool call
 * @returns {string[]}
 */
export function getAssignedSkillIds(appConfig) {
  if (Array.isArray(appConfig?._skillIds)) return appConfig._skillIds;
  if (Array.isArray(appConfig?.skills)) return appConfig.skills;
  return [];
}

/**
 * The skills among `skillIds` that are installed and granted to `user`.
 * Empty when the skills feature is off.
 *
 * @param {Object} options
 * @param {string[]} options.skillIds - Skills assigned to the app or agent node
 * @param {Object} options.user - Expanded user, or a bare principal with groups
 * @returns {Promise<Array<Object>>} Skill metadata entries
 */
export async function getUsableSkills({ skillIds, user }) {
  if (!isFeatureEnabled('skills', configCache.getFeatures())) return [];
  if (!Array.isArray(skillIds) || skillIds.length === 0) return [];
  return configCache.getSkillsForApp({ skills: skillIds }, user, configCache.getPlatform() || {});
}

/**
 * Whether `skillName` is one of the usable skills for `skillIds` and `user`.
 *
 * @param {string} skillName
 * @param {Object} options - See {@link getUsableSkills}
 * @returns {Promise<boolean>}
 */
export async function isSkillUsable(skillName, { skillIds, user }) {
  if (typeof skillName !== 'string' || !skillName) return false;
  const usable = await getUsableSkills({ skillIds, user });
  return usable.some(skill => skill.name === skillName);
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * Escape text for an XML-style prompt block, so a description cannot close
 * the block or open a tag of its own.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"]/g, char => XML_ESCAPES[char]);
}

/**
 * The `<available_skills>` block listing name and description of each skill.
 *
 * @param {Array<{name: string, description?: string}>} skills
 * @returns {string}
 */
export function buildAvailableSkillsBlock(skills) {
  const entries = skills
    .map(
      skill =>
        `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description || '')}</description>\n  </skill>`
    )
    .join('\n');
  return `<available_skills>\n${entries}\n</available_skills>`;
}

/** How many skills may be active at once when the app does not set `skillSettings.maxActiveSkills`. */
export const DEFAULT_MAX_ACTIVE_SKILLS = 3;

/**
 * The skills a request asks to pre-activate (`requestedSkills`), reduced to
 * those usable in `app` for `user`: duplicates dropped, request order kept,
 * capped at the app's `skillSettings.maxActiveSkills`. Names that are not
 * usable are left out.
 *
 * @param {string[]} requested - Skill names from the request
 * @param {Object} options
 * @param {Object} options.app - App config
 * @param {Object} options.user - Expanded user
 * @returns {Promise<Array<Object>>} Skill metadata entries, in request order
 */
export async function resolveRequestedSkills(requested, { app, user }) {
  if (!Array.isArray(requested) || requested.length === 0 || !app) return [];
  const usable = await getUsableSkills({ skillIds: app.skills, user });
  const byName = new Map(usable.map(skill => [skill.name, skill]));
  const limit = app.skillSettings?.maxActiveSkills ?? DEFAULT_MAX_ACTIVE_SKILLS;
  const resolved = [];
  for (const name of new Set(requested)) {
    if (resolved.length >= limit) break;
    const skill = byName.get(name);
    if (skill) resolved.push(skill);
  }
  return resolved;
}
