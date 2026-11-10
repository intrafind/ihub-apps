// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How a project reaches the model: the knowledge modes, read the same way on
 * the server and in the browser (#3538).
 *
 * | Mode       | In the prompt                                             | Knowledge tools |
 * |------------|-----------------------------------------------------------|-----------------|
 * | `auto`     | everything when it fits the budget, else pinned + the best sections | yes |
 * | `context`  | everything, up to the hard limit of the context window    | yes             |
 * | `relevant` | pinned documents + the best sections for the question     | yes             |
 * | `tools`    | pinned documents only; the rest through `knowledge_search`| yes             |
 * | `pinned`   | pinned documents only                                     | no              |
 *
 * The stored values `auto`, `context` and `tools` are the ones links carried
 * before; `relevant` and `pinned` are new.
 *
 * A mode is chosen at four levels; the first that is set wins:
 *
 *  1. the chat (the project chip in the chat input), for the chat's own
 *     project and the projects attached to it;
 *  2. the link of an app or workflow, set by an admin;
 *  3. the project's own default (`knowledgeMode`);
 *  4. {@link DEFAULT_KNOWLEDGE_MODE}.
 *
 * A mode the platform no longer offers (`platform.projects.knowledgeModes`)
 * is passed over at level 1 and, for a user's own project, at level 3, never at
 * level 2 or for an admin project: what an administrator chose is the
 * administrator's decision. A link that sets no mode passes to level 3.
 *
 * @module shared/knowledgeModes
 */

/** Every knowledge mode, in the order a picker lists them. */
export const KNOWLEDGE_MODES = Object.freeze(['auto', 'context', 'relevant', 'tools', 'pinned']);

/** The mode a project has when nothing else says. */
export const DEFAULT_KNOWLEDGE_MODE = 'auto';

/**
 * Modes that offer the knowledge tools (`knowledge_search`, `knowledge_read`,
 * `knowledge_list`) for the project. `pinned` is the one that does not: the
 * documents beside the pinned ones are not reachable.
 */
export const KNOWLEDGE_TOOL_MODES = Object.freeze(['auto', 'context', 'relevant', 'tools']);

/**
 * Whether a value is a knowledge mode.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isKnowledgeMode(value) {
  return typeof value === 'string' && KNOWLEDGE_MODES.includes(value);
}

/**
 * The modes a platform offers: the configured list, or every mode when it is
 * absent or holds none that exists. `auto` is always kept: it is what a project
 * falls back to, and the default needs somewhere to land.
 *
 * @param {unknown} configured - `platform.projects.knowledgeModes`
 * @returns {string[]}
 */
export function allowedKnowledgeModes(configured) {
  if (!Array.isArray(configured)) return [...KNOWLEDGE_MODES];
  const listed = KNOWLEDGE_MODES.filter(mode => configured.includes(mode));
  if (!listed.length) return [...KNOWLEDGE_MODES];
  return listed.includes(DEFAULT_KNOWLEDGE_MODE) ? listed : [DEFAULT_KNOWLEDGE_MODE, ...listed];
}

/**
 * The mode one project is used in.
 *
 * @param {Object} levels
 * @param {string|null} [levels.link] - The mode on the app or workflow link, when it set one.
 * @param {string|null} [levels.chat] - The mode chosen for this chat.
 * @param {string|null} [levels.project] - The project's own default.
 * @param {string[]} [levels.allowed] - {@link allowedKnowledgeModes}; a chat's choice,
 *   and the project's when `allowedForProject`, outside it is passed over.
 * @param {boolean} [levels.allowedForProject=true] - Whether `allowed` narrows the
 *   project's own default; false for an admin project, whose mode an administrator set.
 * @returns {{mode: string, source: 'link'|'chat'|'project'|'default'}}
 * @example
 * resolveKnowledgeMode({ chat: 'pinned', link: 'tools' }); // → { mode: 'pinned', source: 'chat' }
 * resolveKnowledgeMode({ link: 'tools', project: 'context' }); // → { mode: 'tools', source: 'link' }
 * resolveKnowledgeMode({ project: 'context' });               // → { mode: 'context', source: 'project' }
 */
export function resolveKnowledgeMode({
  link = null,
  chat = null,
  project = null,
  allowed,
  allowedForProject = true
} = {}) {
  const offered = Array.isArray(allowed) && allowed.length ? allowed : KNOWLEDGE_MODES;
  if (isKnowledgeMode(chat) && offered.includes(chat)) return { mode: chat, source: 'chat' };
  if (isKnowledgeMode(link)) return { mode: link, source: 'link' };
  if (isKnowledgeMode(project) && (!allowedForProject || offered.includes(project))) {
    return { mode: project, source: 'project' };
  }
  return { mode: DEFAULT_KNOWLEDGE_MODE, source: 'default' };
}
