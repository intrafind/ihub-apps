// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The ids of the chat context tools (`chatContextTools.js`), in a module of
 * their own: the tool loader dispatches on them while the config cache is
 * still loading, and the tools' module reaches the chat repository, which
 * must not join that import graph.
 *
 * The ids carry no "search": an id with it is classified as a web search
 * (`services/loop/seams/knowledgeSourceSeam.js`).
 *
 * @module services/chat/chatContextToolIds
 */

/** The tool ids per kind, list first. */
export const CHAT_CONTEXT_TOOL_IDS_BY_KIND = Object.freeze({
  sources: Object.freeze(['chat_sources_list', 'chat_sources_read']),
  files: Object.freeze(['chat_files_list', 'chat_files_read']),
  artifacts: Object.freeze(['chat_artifacts_list', 'chat_artifacts_read'])
});

/** Every chat context tool id. */
export const CHAT_CONTEXT_TOOL_IDS = Object.freeze(
  Object.values(CHAT_CONTEXT_TOOL_IDS_BY_KIND).flat()
);

/** The tool that reads a file of an earlier turn (named in the omitted-file rule). */
export const CHAT_FILES_READ_TOOL_ID = 'chat_files_read';

/**
 * Whether a tool id is one of the chat context tools.
 *
 * @param {string} toolId
 * @returns {boolean}
 */
export function isChatContextTool(toolId) {
  return CHAT_CONTEXT_TOOL_IDS.includes(toolId);
}
