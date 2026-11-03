// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The reference that enables every skill of a remote A2A agent whatever else
 * uses its id (server/utils/toolSelection.js `a2aAgentReference`).
 *
 * @param {string} agentId
 * @returns {string}
 */
export function a2aAgentReference(agentId) {
  return `a2a__${agentId}`;
}

/**
 * The remote source a tool belongs to — an MCP server (`_mcp`), a remote
 * A2A agent (`_a2a`) or an installed integration (`_integration`) — as `{ key, id, name, kind }`, or null for a tool of
 * iHub itself. `key` is unique across both kinds; `id` is the reference an app
 * stores in `app.tools` to enable the whole source — for an A2A agent marked
 * `_a2a.idConflict` (its id is also a tool's or MCP server's) that is
 * `a2a__<agentId>`, since the bare id selects the tool or server.
 *
 * @param {Object} [tool]
 * @returns {{key:string,id:string,name:any,kind:'mcp'|'a2a'}|null}
 */
function ownerOf(tool) {
  if (tool?._mcp?.serverId) {
    return {
      key: `mcp-${tool._mcp.serverId}`,
      id: tool._mcp.serverId,
      name: tool._mcp.serverName,
      kind: 'mcp'
    };
  }
  if (tool?._a2a?.agentId) {
    return {
      key: `a2a-${tool._a2a.agentId}`,
      id: tool._a2a.idConflict ? a2aAgentReference(tool._a2a.agentId) : tool._a2a.agentId,
      name: tool._a2a.agentName,
      kind: 'a2a'
    };
  }
  if (tool?._integration?.instanceId) {
    return {
      key: `integration-${tool._integration.instanceId}`,
      id: tool._integration.instanceId,
      name: tool._integration.instanceLabel || tool._integration.instanceId,
      kind: 'integration'
    };
  }
  return null;
}

/**
 * The tools a picker offers, with every MCP server and every remote A2A agent
 * collapsed into one entry whose id is the server's (agent's) id — the
 * reference an app stores to enable it as a whole (`a2a__<agentId>` for an A2A
 * agent marked `_a2a.idConflict`, whose bare id would select a local tool or
 * MCP server instead). Other tools are returned as they are.
 *
 * @param {Array<{id:string,name?:any,description?:any,_mcp?:{serverId:string,serverName?:any},_a2a?:{agentId:string,agentName?:any,idConflict?:boolean}}>} tools
 * @param {(content:any)=>string} localize
 * @returns {Array<{id:string,name:any,description?:any,mcpServer?:boolean,a2aAgent?:boolean}>}
 */
export function collapseMcpTools(tools, localize) {
  const out = [];
  const seen = new Set();
  (tools || []).forEach(tool => {
    const owner = ownerOf(tool);
    if (!owner) {
      out.push(tool);
      return;
    }
    if (seen.has(owner.key)) return;
    seen.add(owner.key);
    out.push({
      id: owner.id,
      name: localize(owner.name) || owner.id,
      description: '',
      ...(owner.kind === 'mcp' ? { mcpServer: true } : { a2aAgent: true })
    });
  });
  return out;
}
