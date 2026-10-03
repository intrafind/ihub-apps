/**
 * Skill access: which skills a request may load.
 *
 * Two kinds of skill reach a request:
 *
 * - A **global skill** (a folder under `contents/skills/`) is usable when it
 *   is installed, listed on the app (or the agent node) the request runs in,
 *   and granted to the user's groups.
 * - A **user skill** (`usk_…`, written by a user, see
 *   `services/skills/UserSkillRepository.js`) is usable when user skills are
 *   switched on, the app does not opt out (`skillSettings.allowPersonal:
 *   false`), and the caller owns it or it is shared with them. Agents, OAuth
 *   clients and anonymous callers never get one.
 *
 * Every path that loads a skill body or file asks this module: the
 * `activate_skill` and `read_skill_resource` tools, `requestedSkills`
 * pre-activation, the skills listed for the model, and the agent planner.
 * Keeping the check in one place means a new way of loading a skill cannot
 * forget part of it.
 *
 * @module services/skillAccess
 */

import configCache from '../configCache.js';
import { isFeatureEnabled } from '../featureRegistry.js';
import { getSkillContent, getSkillResource } from './skillLoader.js';
import { getUserSkillRepository, isUserSkillId } from './skills/UserSkillRepository.js';
import { isUserSkillsConfigured } from './skills/userSkillSettings.js';
import {
  canHoldUserPrompts,
  effectiveGroups,
  principalShareKeys,
  sharePermissionFor
} from './prompts/userPromptAccess.js';

/** How many user skills are listed for the model at most, newest first. */
export const MAX_LISTED_USER_SKILLS = 20;

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
 * The global skills among `skillIds` that are installed and granted to
 * `user`. Empty when the skills feature is off.
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

/** Whether user skills may be used in `app` at all, for anyone. */
function userSkillsAllowedIn(app) {
  if (app?._skillIds) return false; // an agent node: global skills only
  if (app?.skillSettings?.allowPersonal === false) return false;
  if (!isUserSkillsConfigured(configCache.getFeatures(), configCache.getPlatform() || {})) {
    return false;
  }
  return getUserSkillRepository().isAvailable();
}

/**
 * The user skills `user` may use in `app`: the ones they own and the ones
 * shared with them, newest first. Being an admin does not add other people's
 * skills here — admins manage those on the admin page, they do not run them.
 *
 * @param {Object} options
 * @param {Object} [options.app] - App config
 * @param {Object} options.user - Expanded user
 * @returns {Promise<Array<Object>>} Stored user skills
 */
export async function getUsablePersonalSkills({ app, user }) {
  if (!canHoldUserPrompts(user) || !userSkillsAllowedIn(app)) return [];
  const repo = getUserSkillRepository();
  const groups = effectiveGroups(user);
  const owned = await repo.listOwned(String(user.id));
  const ownedIds = new Set(owned.map(skill => skill.id));
  const shared = (await repo.listSharedWith(principalShareKeys(user, groups))).filter(
    skill => !ownedIds.has(skill.id) && sharePermissionFor(skill, user, groups)
  );
  return [...owned, ...shared].sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  );
}

/**
 * One user skill, if `user` may use it in `app`.
 *
 * @param {string} skillId - `usk_…` id
 * @param {Object} options
 * @param {Object} [options.app] - App config
 * @param {Object} options.user - Expanded user
 * @returns {Promise<Object|null>} The stored skill, or null
 */
export async function getUsablePersonalSkill(skillId, { app, user }) {
  if (!isUserSkillId(skillId) || !canHoldUserPrompts(user) || !userSkillsAllowedIn(app)) {
    return null;
  }
  const skill = await getUserSkillRepository().get(skillId);
  if (!skill) return null;
  if (String(skill.ownerId) === String(user.id)) return skill;
  return sharePermissionFor(skill, user, effectiveGroups(user)) ? skill : null;
}

/**
 * Whether `skillName` may be loaded: a global skill among the usable ones for
 * `skillIds` and `user`, or a user skill `user` may use in `app`.
 *
 * @param {string} skillName - Global skill name or `usk_…` id
 * @param {Object} options
 * @param {string[]} options.skillIds - Skills assigned to the app or agent node
 * @param {Object} options.user - Expanded user, or a bare principal with groups
 * @param {Object} [options.app] - App config (needed for user skills)
 * @returns {Promise<boolean>}
 */
export async function isSkillUsable(skillName, { skillIds, user, app }) {
  if (typeof skillName !== 'string' || !skillName) return false;
  if (isUserSkillId(skillName)) {
    return Boolean(await getUsablePersonalSkill(skillName, { app, user }));
  }
  const usable = await getUsableSkills({ skillIds, user });
  return usable.some(skill => skill.name === skillName);
}

/** The resource paths of a user skill, grouped like a global skill's. */
function userSkillResources(skill) {
  return (Array.isArray(skill.files) ? skill.files : []).map(file => file.path);
}

/**
 * Load a usable skill's instructions and the reader for its files, or null
 * when it may not be loaded.
 *
 * @param {string} skillName - Global skill name or `usk_…` id
 * @param {Object} options - See {@link isSkillUsable}
 * @returns {Promise<{name: string, displayName: string, description: string, body: string,
 *   resources: string[], readFile: (path: string) => Promise<string|null>}|null>}
 */
export async function loadUsableSkill(skillName, { skillIds, user, app }) {
  if (typeof skillName !== 'string' || !skillName) return null;
  if (isUserSkillId(skillName)) {
    const skill = await getUsablePersonalSkill(skillName, { app, user });
    if (!skill) return null;
    const files = Array.isArray(skill.files) ? skill.files : [];
    return {
      name: skill.id,
      displayName: skill.name,
      description: skill.description || '',
      body: skill.body || '',
      resources: userSkillResources(skill),
      readFile: async path => {
        const file = files.find(entry => entry.path === path);
        return file ? String(file.content) : null;
      }
    };
  }
  if (!(await isSkillUsable(skillName, { skillIds, user }))) return null;
  const content = await getSkillContent(skillName);
  if (!content) return null;
  return {
    name: skillName,
    displayName: skillName,
    description: content.description || '',
    body: content.body,
    resources: [...content.references, ...content.scripts, ...content.assets],
    readFile: path => getSkillResource(skillName, path)
  };
}

/**
 * The skills listed for the model in `<available_skills>`: the app's usable
 * global skills, then up to {@link MAX_LISTED_USER_SKILLS} user skills. A user
 * skill is listed under its id, which is what `activate_skill` takes, with its
 * name in front of the description.
 *
 * @param {Object} options
 * @param {Object} options.app - App config
 * @param {Object} options.user - Expanded user
 * @returns {Promise<Array<{name: string, description: string}>>}
 */
export async function listSkillsForPrompt({ app, user }) {
  const global = await getUsableSkills({ skillIds: app?.skills, user });
  const personal = (await getUsablePersonalSkills({ app, user })).slice(0, MAX_LISTED_USER_SKILLS);
  return [
    ...global.map(skill => ({ name: skill.name, description: skill.description || '' })),
    ...personal.map(skill => ({
      name: skill.id,
      description: `${skill.name}: ${skill.description || ''}`
    }))
  ];
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
 * `/name` at the start of the text or after whitespace, ended by whitespace,
 * punctuation or the end of the text — how a skill is invoked in a prompt,
 * the same in chat, in a scheduled task's instructions and through the API.
 */
const SKILL_TOKEN = /(?:^|\s)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?=$|[\s.,;:!?)\]])/g;

/**
 * The skill names a text invokes with `/name`, unique, in order.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function skillTokensIn(text) {
  if (typeof text !== 'string' || !text.includes('/')) return [];
  const names = [];
  for (const match of text.matchAll(SKILL_TOKEN)) {
    if (!match[1].includes('--') && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * The text of the last user message — the turn whose `/name` tokens count.
 *
 * @param {Array<Object>} messages - Chat messages, oldest first
 * @returns {string}
 */
export function lastUserText(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find(message => message?.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}

/**
 * The skills to pre-activate for a turn, reduced to those usable in `app` for
 * `user`: first the ones the request names explicitly (`requestedSkills`:
 * global names or `usk_…` ids), then the ones the user's message invokes with
 * `/name`. Duplicates are dropped, order is kept, and the list is capped at
 * the app's `skillSettings.maxActiveSkills`. Anything not usable is left out.
 *
 * A `/name` token matches a skill by name. When the user's own skill, a skill
 * shared with them and a global skill have the same name, their own wins, then
 * the shared one — the more personal choice — and the global skill last.
 *
 * @param {Object} options
 * @param {string[]} [options.requested] - `requestedSkills` from the request
 * @param {string} [options.text] - The user's message
 * @param {Object} options.app - App config
 * @param {Object} options.user - Expanded user
 * @returns {Promise<Array<{name: string, displayName: string, description: string}>>}
 *   `name` is what `loadUsableSkill` takes: the global name or the `usk_…` id
 */
export async function resolveSkillsForTurn({ requested = [], text = '', app, user }) {
  const explicit = Array.isArray(requested) ? requested.filter(n => typeof n === 'string') : [];
  const tokens = skillTokensIn(text);
  if (!app || (explicit.length === 0 && tokens.length === 0)) return [];

  const global = await getUsableSkills({ skillIds: app.skills, user });
  const globalByName = new Map(global.map(skill => [skill.name, skill]));
  const personal = await getUsablePersonalSkills({ app, user });
  const personalById = new Map(personal.map(skill => [skill.id, skill]));
  // Own skills before shared ones; within each, the list is newest first.
  const personalByName = new Map();
  for (const skill of [...personal].sort(
    (a, b) =>
      Number(String(b.ownerId) === String(user?.id)) -
      Number(String(a.ownerId) === String(user?.id))
  )) {
    if (!personalByName.has(skill.name)) personalByName.set(skill.name, skill);
  }

  const asEntry = skill =>
    isUserSkillId(skill.id)
      ? { name: skill.id, displayName: skill.name, description: skill.description || '' }
      : { name: skill.name, displayName: skill.name, description: skill.description || '' };

  const limit = app.skillSettings?.maxActiveSkills ?? DEFAULT_MAX_ACTIVE_SKILLS;
  const resolved = [];
  const seen = new Set();
  const add = skill => {
    if (!skill || resolved.length >= limit) return;
    const entry = asEntry(skill);
    if (seen.has(entry.name)) return;
    seen.add(entry.name);
    resolved.push(entry);
  };
  for (const name of explicit) {
    add(isUserSkillId(name) ? personalById.get(name) : globalByName.get(name));
  }
  for (const name of tokens) {
    add(personalByName.get(name) || globalByName.get(name));
  }
  return resolved;
}

/**
 * The skills a request names explicitly (`requestedSkills`), reduced to those
 * usable in `app` for `user` — {@link resolveSkillsForTurn} without a message.
 *
 * @param {string[]} requested - Skill names or `usk_…` ids from the request
 * @param {Object} options
 * @param {Object} options.app - App config
 * @param {Object} options.user - Expanded user
 * @returns {Promise<Array<{name: string, displayName: string, description: string}>>}
 */
export async function resolveRequestedSkills(requested, { app, user }) {
  return resolveSkillsForTurn({ requested, app, user });
}
