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
 * `activate_skill`, `read_skill_resource` and `find_skill` tools,
 * `requestedSkills` pre-activation, the skills kept active across a chat, the
 * skills listed for the model, and the agent planner. Keeping the check in one
 * place means a new way of loading a skill cannot forget part of it.
 *
 * Skills reach the model in three steps, as in the Agent Skills spec: a list
 * of names and descriptions (`<available_skills>`, kept within a token
 * budget), a skill's instructions once it is activated, and its files when the
 * instructions point to them. An activated skill stays active for the rest of
 * the chat ({@link prepareActiveSkills}).
 *
 * @module services/skillAccess
 */

import configCache from '../configCache.js';
import { isFeatureEnabled } from '../featureRegistry.js';
import { estimateTokens } from '../../shared/tokenEstimator.js';
import { disablesModelInvocation, getSkillContent, getSkillResource } from './skillLoader.js';
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

/**
 * Whether the model may be offered a skill and load it on its own. A skill
 * whose SKILL.md sets `disable-model-invocation: true` is started by users
 * with `/name` only.
 *
 * @param {Object} [skill] - Skill metadata or a loaded skill
 * @returns {boolean}
 */
export function isModelInvocable(skill) {
  return skill?.modelInvocable !== false;
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
 *   resources: string[], modelInvocable: boolean,
 *   readFile: (path: string) => Promise<string|null>}|null>}
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
      modelInvocable: true,
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
    modelInvocable: !disablesModelInvocation(content.frontmatter),
    readFile: path => getSkillResource(skillName, path)
  };
}

/**
 * The skills listed for the model in `<available_skills>`: the usable global
 * skills assigned to the app (or agent node) that the model may start on its
 * own, then up to {@link MAX_LISTED_USER_SKILLS} user skills. A user skill is
 * listed under its id, which is what `activate_skill` takes, with its name in
 * front of the description.
 *
 * @param {Object} options
 * @param {Object} options.app - App config
 * @param {Object} options.user - Expanded user
 * @returns {Promise<Array<{name: string, displayName: string, description: string}>>}
 */
export async function listSkillsForPrompt({ app, user }) {
  const global = (await getUsableSkills({ skillIds: getAssignedSkillIds(app), user })).filter(
    isModelInvocable
  );
  const personal = (await getUsablePersonalSkills({ app, user })).slice(0, MAX_LISTED_USER_SKILLS);
  return [
    ...global.map(skill => ({
      name: skill.name,
      displayName: skill.name,
      description: skill.description || ''
    })),
    ...personal.map(skill => ({
      name: skill.id,
      displayName: skill.name,
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
 * An entry without a `description` key is listed by name only.
 *
 * @param {Array<{name: string, description?: string}>} skills
 * @returns {string}
 */
export function buildAvailableSkillsBlock(skills) {
  return `<available_skills>\n${skills.map(skillEntry).join('\n')}\n</available_skills>`;
}

/** One `<skill>` entry of {@link buildAvailableSkillsBlock}. */
function skillEntry(skill) {
  return skill.description === undefined
    ? `  <skill><name>${escapeXml(skill.name)}</name></skill>`
    : `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description || '')}</description>\n  </skill>`;
}

/** Token budget of the skills list when `platform.skills.maxCatalogTokens` is not set. */
export const DEFAULT_MAX_CATALOG_TOKENS = 3000;

/** Length a description is shortened to when the full list exceeds its budget. */
export const SHORT_DESCRIPTION_CHARS = 120;

/** Most skills one `find_skill` call returns. */
export const MAX_FOUND_SKILLS = 10;

const CATALOG_INTRO =
  "The following skills hold instructions for specific tasks. When a task matches a skill's description, call activate_skill with the skill's name to load its instructions before you start on the task.";
const CATALOG_SHORTENED_NOTE =
  'The descriptions are shortened: call find_skill with a few keywords to search the skills and read their full descriptions.';
const CATALOG_NAMES_NOTE =
  'Only the names are listed: call find_skill with a few keywords to search the skills and read their descriptions.';

/**
 * The token budget of the skills list: `platform.skills.maxCatalogTokens`, or
 * {@link DEFAULT_MAX_CATALOG_TOKENS} when it is missing or not a positive number.
 *
 * @param {Object} [platform] - Platform config
 * @returns {number}
 */
export function maxCatalogTokensFor(platform) {
  const value = platform?.skills?.maxCatalogTokens;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_CATALOG_TOKENS;
}

/** `text` cut to about `max` characters at a word boundary. */
function shortenDescription(text, max = SHORT_DESCRIPTION_CHARS) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/**
 * The skills list for the system prompt: a line on how to use skills and the
 * `<available_skills>` block, within `maxTokens`. The list depends only on the
 * skills, never on the message, so the system prompt stays the same from turn
 * to turn (and cacheable). Over the budget it gets shorter step by step, and
 * the model is told to use `find_skill` for the rest:
 *
 * 1. every skill with its full description;
 * 2. every skill with its description shortened to {@link SHORT_DESCRIPTION_CHARS};
 * 3. the names only, as many as fit.
 *
 * @param {Array<{name: string, description?: string}>} entries
 * @param {Object} [options]
 * @param {number} [options.maxTokens]
 * @returns {{text: string, compact: boolean, listed: number}} `compact` is true
 *   when descriptions were shortened or left out, so `find_skill` is needed
 */
export function buildSkillCatalog(entries, { maxTokens = DEFAULT_MAX_CATALOG_TOKENS } = {}) {
  const skills = Array.isArray(entries) ? entries : [];
  if (skills.length === 0) return { text: '', compact: false, listed: 0 };

  const full = `${CATALOG_INTRO}\n${buildAvailableSkillsBlock(
    skills.map(skill => ({ name: skill.name, description: skill.description || '' }))
  )}`;
  if (estimateTokens(full) <= maxTokens) {
    return { text: full, compact: false, listed: skills.length };
  }

  const shortened = `${CATALOG_INTRO} ${CATALOG_SHORTENED_NOTE}\n${buildAvailableSkillsBlock(
    skills.map(skill => ({ name: skill.name, description: shortenDescription(skill.description) }))
  )}`;
  if (estimateTokens(shortened) <= maxTokens) {
    return { text: shortened, compact: true, listed: skills.length };
  }

  // Names only, as many as fit; at least one, so the list is never empty.
  const intro = omitted =>
    `${CATALOG_INTRO} ${CATALOG_NAMES_NOTE}${
      omitted > 0
        ? ` ${omitted} more skills are not listed here; find_skill searches them too.`
        : ''
    }`;
  let used = estimateTokens(`${intro(skills.length)}\n${buildAvailableSkillsBlock([])}`);
  const listed = [];
  for (const skill of skills) {
    const cost = estimateTokens(skillEntry({ name: skill.name })) + 1;
    if (listed.length > 0 && used + cost > maxTokens) break;
    listed.push({ name: skill.name });
    used += cost;
  }
  return {
    text: `${intro(skills.length - listed.length)}\n${buildAvailableSkillsBlock(listed)}`,
    compact: true,
    listed: listed.length
  };
}

/**
 * The skills the model is offered in `app` for `user`, and how they are
 * listed: {@link listSkillsForPrompt} within the platform's token budget
 * ({@link buildSkillCatalog}). The system prompt, the names the skill tools
 * accept and `find_skill` all read it, so they agree on one set.
 *
 * @param {Object} options
 * @param {Object} options.app - App config (or an agent node's tool config)
 * @param {Object} options.user - Expanded user
 * @returns {Promise<{entries: Array<{name: string, displayName: string, description: string}>,
 *   text: string, compact: boolean, listed: number}>}
 */
export async function describeSkillCatalog({ app, user }) {
  const entries = await listSkillsForPrompt({ app, user });
  const catalog = buildSkillCatalog(entries, {
    maxTokens: maxCatalogTokensFor(configCache.getPlatform())
  });
  return { entries, ...catalog };
}

/**
 * The catalog entries that match `query` best, for `find_skill`: each word of
 * at least two characters counts three times in the name and once in the
 * description. Ties keep the catalog order. A query without such a word
 * matches nothing.
 *
 * @param {Array<{name: string, displayName?: string, description?: string}>} entries
 * @param {string} query
 * @param {number} [limit]
 * @returns {Array<Object>} The matching entries
 */
export function searchSkillCatalog(entries, query, limit = MAX_FOUND_SKILLS) {
  const words = [
    ...new Set(
      String(query || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(word => word.length >= 2)
    )
  ];
  if (words.length === 0 || !Array.isArray(entries)) return [];
  return entries
    .map((entry, index) => {
      const name = `${entry.name} ${entry.displayName || ''}`.toLowerCase();
      const description = String(entry.description || '').toLowerCase();
      const score = words.reduce(
        (sum, word) => sum + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0),
        0
      );
      return { entry, score, index };
    })
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(match => match.entry);
}

/** How many skills may be active at once when the app does not set `skillSettings.maxActiveSkills`. */
export const DEFAULT_MAX_ACTIVE_SKILLS = 3;

/** Upper bound for `skillSettings.maxActiveSkills`, as in the app schema. */
const MAX_ACTIVE_SKILLS_LIMIT = 10;

/**
 * The app's cap on active skills. App files load even when they fail schema
 * validation, so a value outside 1–10 or not a whole number falls back to the
 * default, and a larger one is capped at 10.
 *
 * @param {Object} [app] - App config
 * @returns {number}
 */
export function maxActiveSkillsFor(app) {
  const value = app?.skillSettings?.maxActiveSkills;
  if (!Number.isInteger(value) || value < 1) return DEFAULT_MAX_ACTIVE_SKILLS;
  return Math.min(value, MAX_ACTIVE_SKILLS_LIMIT);
}

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

/** The text of a chat message: its string content, or its text parts joined. */
function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  return '';
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
  return last ? messageText(last) : '';
}

/**
 * The skills earlier turns of a chat activated, newest first: the skills an
 * answer records as active (`activeSkills`, by `id` where the record has one,
 * else by name), and the skills a user message invoked with `/name`. The last
 * user message is the current turn and is not part of it.
 *
 * Each reference says who activated the skill (`by`): a user message's
 * `/name` and an answer's record of a user activation (`activatedBy: 'user'`)
 * are the user's, every other record the model's.
 *
 * Only references: {@link resolveSkillsForTurn} keeps the ones the app and
 * the user may still use. The history may come from the client, so nothing in
 * it grants anything a `/name` in the message could not.
 *
 * @param {Array<Object>} messages - Chat messages, oldest first
 * @returns {Array<{id?: string, name?: string, by: 'user'|'model'}>}
 */
export function earlierSkillRefs(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let current = list.length - 1;
  while (current >= 0 && list[current]?.role !== 'user') current -= 1;
  const refs = [];
  for (let index = current - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role === 'assistant' && Array.isArray(message.activeSkills)) {
      // Recorded in the order they were activated: the last is the newest.
      for (const skill of [...message.activeSkills].reverse()) {
        const by = skill?.activatedBy === 'user' ? 'user' : 'model';
        if (typeof skill?.id === 'string' && skill.id) refs.push({ id: skill.id, by });
        else if (typeof skill?.name === 'string' && skill.name) {
          refs.push({ name: skill.name, by });
        }
      }
    } else if (message?.role === 'user') {
      for (const name of skillTokensIn(messageText(message))) refs.push({ name, by: 'user' });
    }
  }
  return refs;
}

/**
 * The global skills an app activates on every turn: its `skills`, when it
 * sets `skillSettings.autoActivate`. Agent nodes (`_skillIds`) never do.
 *
 * @param {Object} [app] - App config
 * @returns {string[]}
 */
function autoActivatedSkillIds(app) {
  if (app?._skillIds || app?.skillSettings?.autoActivate !== true) return [];
  return Array.isArray(app.skills) ? app.skills.filter(name => typeof name === 'string') : [];
}

/**
 * The skills a turn runs with, reduced to those usable in `app` for `user`,
 * in order:
 *
 * 1. the ones the request names explicitly (`requestedSkills`: global names
 *    or `usk_…` ids) — origin `requested`;
 * 2. the ones the user's message invokes with `/name` — origin `message`;
 * 3. the app's own `skills`, when it sets `skillSettings.autoActivate` — an
 *    app built around a skill (such as Skill Builder) runs it from the first
 *    message on — origin `app`, or `chat` once an earlier turn activated it;
 * 4. the ones earlier turns of the chat activated, newest first
 *    ({@link earlierSkillRefs}) — origin `chat`. A skill stays active for the
 *    rest of a chat, whether a user named it or the model activated it. One
 *    the model activated is dropped once only users may start it.
 *
 * Duplicates are dropped, order is kept, and the list is capped at the app's
 * `skillSettings.maxActiveSkills`, so the skills named last win. Anything not
 * usable — any more — is left out.
 *
 * A `/name` token matches a skill by name. When the user's own skill, a skill
 * shared with them and a global skill have the same name, their own wins, then
 * the shared one — the more personal choice — and the global skill last.
 *
 * @param {Object} options
 * @param {string[]} [options.requested] - `requestedSkills` from the request
 * @param {string} [options.text] - The user's message
 * @param {Array<{id?: string, name?: string, by?: string}>} [options.earlier] - From
 *   {@link earlierSkillRefs}
 * @param {Object} options.app - App config
 * @param {Object} options.user - Expanded user
 * @returns {Promise<Array<{name: string, displayName: string, description: string,
 *   origin: 'requested'|'message'|'app'|'chat'}>>}
 *   `name` is what `loadUsableSkill` takes: the global name or the `usk_…` id
 */
export async function resolveSkillsForTurn({ requested = [], text = '', earlier = [], app, user }) {
  const explicit = Array.isArray(requested) ? requested.filter(n => typeof n === 'string') : [];
  const tokens = skillTokensIn(text);
  const refs = Array.isArray(earlier) ? earlier : [];
  const automatic = autoActivatedSkillIds(app);
  if (
    !app ||
    (explicit.length === 0 && tokens.length === 0 && automatic.length === 0 && refs.length === 0)
  ) {
    return [];
  }

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
  const byId = id => (isUserSkillId(id) ? personalById.get(id) : globalByName.get(id));
  const byName = name => personalByName.get(name) || globalByName.get(name);

  const asEntry = (skill, origin) =>
    isUserSkillId(skill.id)
      ? { name: skill.id, displayName: skill.name, description: skill.description || '', origin }
      : { name: skill.name, displayName: skill.name, description: skill.description || '', origin };

  const limit = maxActiveSkillsFor(app);
  const resolved = [];
  const seen = new Set();
  const add = (skill, origin) => {
    if (!skill || resolved.length >= limit) return;
    const entry = asEntry(skill, origin);
    if (seen.has(entry.name)) return;
    seen.add(entry.name);
    resolved.push(entry);
  };
  // The skills earlier turns keep active, newest first. The model cannot start
  // a skill only users may start; a record saying it did (made before the
  // skill changed, or sent by a client) keeps none active.
  const carried = [];
  for (const ref of refs) {
    const skill = ref.id ? byId(ref.id) : byName(ref.name);
    if (!skill || (ref.by !== 'user' && !isModelInvocable(skill))) continue;
    carried.push(skill);
  }
  for (const name of explicit) add(byId(name), 'requested');
  for (const name of tokens) add(byName(name), 'message');
  // A skill of the user's own by the same name, picked with `/name` now or in
  // an earlier turn, stands in for the app's; one already active in the chat
  // is not announced again.
  for (const name of automatic) {
    if (resolved.some(entry => entry.displayName === name)) continue;
    const earlier = carried.find(skill => skill.name === name);
    if (earlier && isUserSkillId(earlier.id)) continue;
    add(globalByName.get(name), earlier ? 'chat' : 'app');
  }
  for (const skill of carried) add(skill, 'chat');
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

/** Instructions of one skill when `platform.skills.maxSkillBodyTokens` is not set. */
export const DEFAULT_MAX_SKILL_BODY_TOKENS = 5000;

/** Share of the model's context window the active skills may take together. */
export const ACTIVE_SKILLS_CONTEXT_SHARE = 0.25;

/**
 * The most tokens one active skill's instructions may take in the system
 * prompt: `platform.skills.maxSkillBodyTokens`, or
 * {@link DEFAULT_MAX_SKILL_BODY_TOKENS} when it is missing or not a positive number.
 *
 * @param {Object} [platform] - Platform config
 * @returns {number}
 */
export function maxSkillBodyTokensFor(platform) {
  const value = platform?.skills?.maxSkillBodyTokens;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_SKILL_BODY_TOKENS;
}

/** The `<active_skill>` block with a skill's full instructions. */
function activeSkillBlock(skill) {
  let block = `<active_skill name="${escapeXml(skill.name)}">\n${skill.body}\n</active_skill>`;
  if (skill.resources.length > 0) {
    block += `\nAvailable skill resources: ${skill.resources.join(', ')}`;
  }
  return block;
}

/** The `<active_skill>` block of a skill whose instructions did not fit. */
function deferredSkillBlock(skill) {
  const name = escapeXml(skill.name);
  return `<active_skill name="${name}">\n${escapeXml(skill.description)}\n\nThe instructions of this skill are too long to include here. Call activate_skill with the name "${name}" to read them before you continue.\n</active_skill>`;
}

/**
 * The skills a chat turn runs with ({@link resolveSkillsForTurn} over the
 * request, the message and the chat so far) and the part of the system prompt
 * that carries them.
 *
 * Each skill's instructions go in as an `<active_skill>` block when they fit:
 * at most `platform.skills.maxSkillBodyTokens` per skill and, when the model's
 * context window is known, {@link ACTIVE_SKILLS_CONTEXT_SHARE} of it for all of
 * them together, the skills named last first. A skill that does not fit is
 * still active, with its description and a note to read the instructions with
 * `activate_skill` (`full: false`).
 *
 * @param {Object} options
 * @param {Array<Object>} options.messages - The chat, oldest first; the last
 *   user message is the current turn. Answers may carry `activeSkills`.
 * @param {string[]} [options.requested] - `requestedSkills` from the request
 * @param {Object} options.app - App config
 * @param {Object} options.user - Expanded user
 * @param {number} [options.contextWindow] - The model's context window, in tokens
 * @returns {Promise<{skills: Array<{name: string, displayName: string, description: string,
 *   origin: string, full: boolean}>, text: string}>}
 */
export async function prepareActiveSkills({
  messages,
  requested = [],
  app,
  user,
  contextWindow = null
}) {
  const none = { skills: [], text: '' };
  if (!app || !isFeatureEnabled('skills', configCache.getFeatures())) return none;
  const entries = await resolveSkillsForTurn({
    requested,
    text: lastUserText(messages),
    earlier: earlierSkillRefs(messages),
    app,
    user
  });
  if (entries.length === 0) return none;

  const perSkill = maxSkillBodyTokensFor(configCache.getPlatform());
  const total =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow * ACTIVE_SKILLS_CONTEXT_SHARE)
      : Infinity;
  let used = 0;
  const skills = [];
  const blocks = [];
  for (const entry of entries) {
    const skill = await loadUsableSkill(entry.name, { skillIds: app.skills, app, user });
    if (!skill) continue;
    const tokens = estimateTokens(skill.body);
    const full = tokens <= perSkill && used + tokens <= total;
    if (full) used += tokens;
    skills.push({ ...entry, full });
    blocks.push(full ? activeSkillBlock(skill) : deferredSkillBlock(skill));
  }
  if (blocks.length === 0) return none;
  const precedence =
    blocks.length > 1
      ? 'Several skills are active. Follow all of them; where they conflict, the skill listed first decides, unless a skill states its own precedence.\n\n'
      : '';
  return { skills, text: `${precedence}${blocks.join('\n\n')}` };
}

/**
 * The skills `prepareActiveSkills` made active for the turn a tool runs in,
 * as carried on its app config (`_activeSkills`).
 *
 * @param {Object} [appConfig]
 * @returns {Array<{name: string, full: boolean}>}
 */
export function activeSkillsOf(appConfig) {
  return Array.isArray(appConfig?._activeSkills) ? appConfig._activeSkills : [];
}
