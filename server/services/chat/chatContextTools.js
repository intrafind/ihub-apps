// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat context tools: what earlier turns of a stored chat found, were
 * given and produced, for the model to look up when it needs it instead of
 * having all of it in every prompt.
 *
 * - `chat_sources_list` / `chat_sources_read`: the sources earlier answers
 *   found (web results, pages read, documents), stored on each answer
 *   (`sources`, see `chatSources.js`). Only the next turn's prose reached the
 *   model before; a recalled source is reported again (`sources` envelope),
 *   so the new answer can cite it.
 * - `chat_files_list` / `chat_files_read`: the files uploaded to the chat.
 *   The files of earlier turns stay inline only within a budget
 *   (`shared/historyFileBudget.js`); an older one is a stub the model reads
 *   with `chat_files_read`.
 * - `chat_artifacts_list` / `chat_artifacts_read`: the files the turns
 *   produced (documents, code, web artifacts, images), kept in the artifact
 *   store and never sent back to the model.
 *
 * Each pair is offered only when the chat has something of its kind
 * ({@link chatContextInventory}), so a new chat pays nothing for them. Like
 * the knowledge tools they are read from the shipped definitions
 * (`server/defaults/tools/chat_*.json`), belong to no tool list, and every
 * call authorizes the chat again with the trusted `chatId` and `user` of the
 * call, never with the model's arguments.
 *
 * @module services/chat/chatContextTools
 */
import logger from '../../utils/logger.js';
import { readShippedToolDefinitions, runShippedTool } from '../tools/shippedToolDefinitions.js';
import { localizeTools, platformDefaultLanguage } from '../../utils/toolLocalization.js';
import { getArtifactRepository } from '../artifacts/ArtifactRepository.js';
import { heldGeneratedFilesFor } from '../documents/generatedFiles.js';
import { authorizeChat } from './chatAccess.js';
import { getChatRepository, isPersistableChatId } from './ChatRepository.js';
import { CHAT_CONTEXT_TOOL_IDS_BY_KIND } from './chatContextToolIds.js';

export {
  CHAT_CONTEXT_TOOL_IDS,
  CHAT_CONTEXT_TOOL_IDS_BY_KIND,
  CHAT_FILES_READ_TOOL_ID,
  isChatContextTool
} from './chatContextToolIds.js';

/** The shipped tool files, one per kind. */
export const CHAT_CONTEXT_TOOL_FILES = Object.freeze({
  sources: 'chat_sources',
  files: 'chat_files',
  artifacts: 'chat_artifacts'
});

const DEFINITIONS = readShippedToolDefinitions(Object.values(CHAT_CONTEXT_TOOL_FILES));

/**
 * The stored chat a call or a turn may read: authorized for `user`, and
 * stored. Null for a chat that is not stored (a new chat, a headless
 * `agent:` id) or that the user may not read.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {Object} params.user
 * @param {Object} [params.repository] - The chat repository (tests).
 * @returns {Promise<{repository: Object, chat: Object}|null>}
 */
export async function readableChat({ chatId, user, repository = getChatRepository() }) {
  if (!user || !isPersistableChatId(chatId)) return null;
  const access = await authorizeChat(chatId, user, { repository, intent: 'read' });
  if (!access.ok || !access.chat) return null;
  return { repository, chat: access.chat };
}

/**
 * The 1-based turn of every message: a user message starts a turn, the
 * answer belongs to it.
 *
 * @param {Array<Object>} messages - Stored messages, oldest first.
 * @returns {number[]} The turn of each message, by index.
 */
export function turnsOf(messages) {
  let turn = 0;
  return (messages || []).map(message => {
    if (message?.role === 'user') turn += 1;
    return Math.max(turn, 1);
  });
}

/**
 * What a stored chat has for the context tools: whether earlier answers
 * found sources, whether files were uploaded, whether the turns produced
 * files.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {Object} params.user
 * @param {Object} [params.repository] - The chat repository (tests).
 * @param {Object} [params.artifacts] - The artifact repository (tests).
 * @returns {Promise<{sources: boolean, files: boolean, artifacts: boolean}|null>}
 *   null when the chat is not stored or not readable
 */
export async function chatContextInventory({
  chatId,
  user,
  repository = getChatRepository(),
  artifacts = getArtifactRepository()
}) {
  try {
    const readable = await readableChat({ chatId, user, repository });
    if (!readable) return null;
    const { messages } = await repository.getMessages(chatId);
    const sources = (messages || []).some(
      message => message?.role === 'assistant' && message.sources?.items?.length > 0
    );
    const fileStore = repository.fileStore();
    const files =
      Boolean(fileStore?.isAvailable?.()) &&
      (await fileStore.list(repository.fileScope(chatId))).length > 0;
    const hasArtifacts =
      heldGeneratedFilesFor(user, { chatId }).length > 0 ||
      (await artifacts.list(repository.artifactScope(chatId))).length > 0;
    return { sources, files, artifacts: hasArtifacts };
  } catch (error) {
    logger.warn('Could not read the chat context inventory', {
      component: 'ChatContextTools',
      chatId,
      error: error.message
    });
    return null;
  }
}

/**
 * The chat context tools for one turn: the pairs whose kind the chat has.
 *
 * @param {Object} params
 * @param {{sources?: boolean, files?: boolean, artifacts?: boolean}|null} params.inventory -
 *   From {@link chatContextInventory}; null offers nothing.
 * @param {string|null} [params.language] - Language of the descriptions.
 * @returns {Object[]} Localized tool definitions.
 */
export function chatContextToolsFor({ inventory, language = null }) {
  if (!inventory) return [];
  const ids = Object.entries(CHAT_CONTEXT_TOOL_IDS_BY_KIND)
    .filter(([kind]) => inventory[kind] === true)
    .flatMap(([, kindIds]) => kindIds);
  if (!ids.length) return [];
  return localizeTools(
    ids.map(id => DEFINITIONS.get(id)),
    language || platformDefaultLanguage()
  );
}

/**
 * Run a chat context tool call (`runTool` dispatches every `chat_*` id here).
 *
 * @param {string} toolId
 * @param {Object} [params] - The model's arguments plus iHub's context (`user`, `chatId`).
 * @returns {Promise<Object>}
 * @throws {Error} When the id is not a chat context tool.
 */
export async function runChatContextTool(toolId, params = {}) {
  const tool = DEFINITIONS.get(toolId);
  if (!tool) throw new Error(`Tool ${toolId} is not available`);
  return runShippedTool(tool, params);
}

/** Characters one read returns at most. */
export const READ_PAGE_CHARS = 20000;

/**
 * Bytes one read's text takes at most: below the loop's 64 KiB spill
 * threshold with room for the rest of the result, for text whose characters
 * take several bytes.
 */
const READ_PAGE_BYTES = 30000;

/**
 * One page of a long text.
 *
 * @param {string} text
 * @param {number} [offset=0] - Character to start at.
 * @returns {{text: string, offset: number, totalChars: number, nextOffset?: number}}
 */
export function pageOfText(text, offset = 0) {
  const all = typeof text === 'string' ? text : '';
  const start = Math.min(Math.max(0, Number.isInteger(offset) ? offset : 0), all.length);
  let page = all.slice(start, start + READ_PAGE_CHARS);
  while (page.length > 0 && Buffer.byteLength(page, 'utf8') > READ_PAGE_BYTES) {
    page = page.slice(0, Math.floor(page.length * 0.8));
  }
  const end = start + page.length;
  return {
    text: page,
    offset: start,
    totalChars: all.length,
    ...(end < all.length ? { nextOffset: end } : {})
  };
}

/** The error result a chat context tool answers a call with. */
export function chatContextError(error, code) {
  return { error, code };
}

/** What a call answers when its chat is not stored or not the caller's. */
export const NO_STORED_CHAT = chatContextError(
  'This chat has no stored history to look in.',
  'CHAT_NOT_FOUND'
);
