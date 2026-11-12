// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The name of the connected system a tool call ran against ("Munich AD",
 * "Jira"): the instance label of an installed integration, the name of an MCP
 * server or of a remote agent. It is what `tool/started` carries as
 * `integration` and what the answer's basis names for an integration, so both
 * say the same word.
 *
 * Kept apart from `toolDisplay.js` because the knowledge-source seam needs it
 * and `toolDisplay.js` imports the seam.
 *
 * @module utils/toolIntegrationLabel
 */

export const MAX_LABEL_LENGTH = 120;

/**
 * @param {unknown} value
 * @returns {string|null} the trimmed text, bounded; null when there is none
 */
export function boundedText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_LENGTH) : null;
}

/**
 * @param {Object|null|undefined} toolDef - the resolved (localized) tool definition
 * @returns {string|null} the system's name; null for a tool that is not a connected system
 */
export function integrationLabelOf(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') return null;
  if (toolDef._integration) return boundedText(toolDef._integration.instanceLabel);
  if (toolDef._mcp)
    return boundedText(toolDef._mcp.serverName) || boundedText(toolDef._mcp.serverId);
  if (toolDef._a2a) return boundedText(toolDef._a2a.agentName) || boundedText(toolDef._a2a.agentId);
  return null;
}
