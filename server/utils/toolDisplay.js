// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How a tool call reads to the user in the chat's activity list: the action
 * it ran ("Search people") and the system it ran against ("Munich AD"),
 * instead of the id the model called it by (`muc-ad__search_people`).
 *
 * @module utils/toolDisplay
 */

const MAX_LENGTH = 120;

function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_LENGTH) : null;
}

/**
 * @param {Object|null|undefined} toolDef - the resolved (localized) tool definition
 * @returns {{title?: string, integration?: string}} the fields that are known
 */
export function toolDisplayOf(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') return {};
  let title = null;
  let integration = null;

  if (toolDef._integration) {
    title = text(toolDef._integration.actionTitle);
    integration = text(toolDef._integration.instanceLabel);
  } else if (toolDef._mcp) {
    title = text(toolDef._mcp.title) || text(toolDef._mcp.originalName);
    integration = text(toolDef._mcp.serverName) || text(toolDef._mcp.serverId);
  } else if (toolDef._a2a) {
    title = text(toolDef._a2a.skillName);
    integration = text(toolDef._a2a.agentName) || text(toolDef._a2a.agentId);
  }

  // Any other tool: its configured (localized) name, when it says more than its id.
  if (!title && !integration) {
    const name = text(toolDef.name);
    if (name && name !== toolDef.id) title = name;
  }

  return {
    ...(title ? { title } : {}),
    ...(integration ? { integration } : {})
  };
}
