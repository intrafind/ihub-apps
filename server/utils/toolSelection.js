// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** Prefix of every tool id that maps to a remote A2A agent's skill. */
const A2A_TOOL_PREFIX = 'a2a__';

/** Reference that selects the tools of every people directory. */
export const PEOPLE_DIRECTORIES_REFERENCE = 'peopleDirectories';

/**
 * Reference that selects the admin LDAP browser tools of every directory
 * (`<directoryId>__browse_search`, …). Nothing else selects them: not the
 * directory id and not `peopleDirectories`.
 */
export const LDAP_BROWSE_REFERENCE = 'ldapBrowse';

/**
 * Whether a tool is an interactive clarification channel — `ask_user`, or any
 * tool flagged `requiresUserInput`. The agent loop drives these to pause a turn
 * and ask the user a question (see `services/loop/seams/questionSeam.js`); they
 * are a system capability, not a user-selectable app capability. So they stay
 * available whatever a chat's `enabledTools` narrowing says (an app that lists
 * one in `app.tools` always keeps it) and are hidden from the end-user tools
 * menu, where a toggle for them would only let a user disable the model's
 * ability to ask — the exact failure that makes an interview loop.
 *
 * @param {{id?: string, requiresUserInput?: boolean}} [tool] - Tool definition
 * @returns {boolean}
 */
export function isInteractiveTool(tool) {
  return Boolean(tool) && (tool.id === 'ask_user' || tool.requiresUserInput === true);
}

/**
 * The reference that selects every skill of a remote A2A agent whatever else
 * uses its id: `a2a__<agentId>`.
 *
 * @param {string} agentId
 * @returns {string}
 */
export function a2aAgentReference(agentId) {
  return `${A2A_TOOL_PREFIX}${agentId}`;
}

/**
 * Whether a list of tool references — an app's `tools`, a chat's `enabledTools`
 * — selects a tool. A reference selects a tool by:
 *
 * - its exact id (`braveSearch`, `drawio__create_diagram`);
 * - its base id, for function-style tools (`jira` selects `jira_searchTickets`);
 * - for a tool discovered from an MCP server, the server's id (`drawio` selects
 *   every tool the draw.io server offers). This is how an app enables an MCP
 *   server as a whole; which of its tools exist is decided by the server's own
 *   `allowedTools`, and it holds whatever tool prefix the server uses;
 * - for a skill of a remote A2A agent, the agent's reference `a2a__<agentId>`
 *   (`a2a__langdock` selects every `a2a__langdock__*` tool), or its bare id
 *   (`langdock`). A2A tools are never selected by base id: every one of them
 *   starts with `a2a_`, so a reference `a2a` would otherwise enable every
 *   agent. An agent whose id is also a local tool's (base) id or an MCP
 *   server's id is marked `_a2a.idConflict` by the tool loader; the ambiguous
 *   bare id then keeps selecting only the local tool or MCP server, and the
 *   agent is selected by `a2a__<agentId>` (or its skills' exact tool ids).
 *   That reference lives in the prefix of the agent's own tool ids
 *   (`a2a__<agentId>__<skill>`; agent ids hold no `__`), so it names one
 *   agent and none of the others;
 * - for a tool of a people directory (`<directoryId>__search_people`, …), the
 *   directory's id, or `peopleDirectories` for every directory — including
 *   ones added later. `peopleDirectories` selects no other tool;
 * - for a directory's LDAP browser tool (`<directoryId>__browse_search`, …),
 *   only `ldapBrowse` (or its exact id): raw LDAP access is never part of
 *   what selects a directory's people search.
 *
 * @param {{id: string, _mcp?: {serverId?: string}, _a2a?: {agentId?: string, idConflict?: boolean}, _peopleDirectory?: {id?: string, browse?: boolean}}} tool - Tool definition
 * @param {string[]|Set<string>} refs - Tool references
 * @returns {boolean}
 */
export function isToolSelected(tool, refs) {
  if (!tool?.id || !refs) return false;
  const has = refs instanceof Set ? id => refs.has(id) : id => refs.includes(id);
  if (has(tool.id)) return true;
  if (tool._peopleDirectory?.id) {
    if (tool._peopleDirectory.browse) return has(LDAP_BROWSE_REFERENCE);
    return has(tool._peopleDirectory.id) || has(PEOPLE_DIRECTORIES_REFERENCE);
  }
  if (tool._mcp?.serverId && has(tool._mcp.serverId)) return true;
  // Tools of an installed integration (`<instanceId>__<action>`) are selected
  // by the installation id, never by the `_`-split base id below. A built-in
  // that kept its old tool id (`iFinder_search`) also keeps answering to the
  // old base id (`iFinder`), which group grants and apps may still use.
  if (tool._integration?.instanceId) {
    // An A2A installation whose id is also a local tool's, an MCP server's or
    // a people directory's id (`_a2a.idConflict`) is not selected by that id:
    // the reference means the other one.
    if (has(tool._integration.instanceId) && !tool._a2a?.idConflict) return true;
    // A remote agent's skill (an A2A installation) also answers to the
    // agent references below, which group grants may use.
    if (!tool._integration.fixedToolId && !tool._a2a) return false;
  }
  if (tool._a2a?.agentId) {
    if (has(a2aAgentReference(tool._a2a.agentId))) return true;
    if (!tool._a2a.idConflict && has(tool._a2a.agentId)) return true;
  }
  if (tool._a2a || tool.id.startsWith(A2A_TOOL_PREFIX)) return false;
  const baseId = tool.id.includes('_') ? tool.id.split('_')[0] : tool.id;
  return baseId !== PEOPLE_DIRECTORIES_REFERENCE && baseId !== LDAP_BROWSE_REFERENCE && has(baseId);
}
