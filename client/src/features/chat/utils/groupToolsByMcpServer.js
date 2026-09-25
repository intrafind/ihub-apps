/**
 * Groups an app's tool references by their originating MCP server so the
 * end-user tools menu shows one toggle per server (e.g. "draw.io") and never
 * the granular tools it exposes (create_diagram, search_shapes).
 *
 * An app enables an MCP server by listing the server's id in `app.tools`
 * (`"drawio"`); apps configured before that list the server's tool ids
 * instead. Both kinds of reference fold into the server's single group, whose
 * `matchedTools` are the app's references that belong to it — the ids the
 * toggle adds to or removes from `enabledTools`. A tool with no `_mcp`
 * metadata stays individual, and so does a function-style reference (`jira`
 * for `jira_searchTickets`).
 *
 * A reference no loaded tool resolves is left out: it is a server that is
 * down or disabled, or a tool name an MCP server no longer offers, and a
 * toggle for it would do nothing. Nothing is left out while no tools are
 * loaded, so a failed request still shows the app's references.
 *
 * @param {string[]} appToolIds - app.tools
 * @param {Array<{id:string,_mcp?:{serverId:string,serverName?:object|string}}>} availableTools
 * @param {(content:any)=>string} localize - resolves a possibly-localized name to a display string
 * @returns {{grouped: Array<{id:string,name:string,matchedTools:string[]}>, individual: string[]}}
 */
export function groupToolsByMcpServer(appToolIds, availableTools, localize) {
  if (!appToolIds || appToolIds.length === 0) return { grouped: [], individual: [] };

  const tools = availableTools || [];
  const mcpGroups = new Map();
  const individual = [];

  appToolIds.forEach(toolId => {
    const tool = tools.find(candidate => candidate.id === toolId);
    const mcp = tool
      ? tool._mcp
      : tools.find(candidate => candidate._mcp?.serverId === toolId)?._mcp;
    if (!mcp?.serverId) {
      const resolved = tools.length === 0 || tool || tools.some(c => c.id.startsWith(`${toolId}_`));
      if (resolved) individual.push(toolId);
      return;
    }
    if (!mcpGroups.has(mcp.serverId)) {
      mcpGroups.set(mcp.serverId, {
        id: `mcp-${mcp.serverId}`,
        name: localize(mcp.serverName) || mcp.serverId,
        matchedTools: []
      });
    }
    mcpGroups.get(mcp.serverId).matchedTools.push(toolId);
  });

  return { grouped: Array.from(mcpGroups.values()), individual };
}

/**
 * The tools a picker offers, with every MCP server collapsed into one entry
 * whose id is the server's id — the reference an app stores to enable the
 * server as a whole. Other tools are returned as they are.
 *
 * @param {Array<{id:string,name?:any,description?:any,_mcp?:{serverId:string,serverName?:any}}>} tools
 * @param {(content:any)=>string} localize
 * @returns {Array<{id:string,name:any,description?:any,mcpServer?:boolean}>}
 */
export function collapseMcpTools(tools, localize) {
  const out = [];
  const seen = new Set();
  (tools || []).forEach(tool => {
    const serverId = tool._mcp?.serverId;
    if (!serverId) {
      out.push(tool);
      return;
    }
    if (seen.has(serverId)) return;
    seen.add(serverId);
    out.push({
      id: serverId,
      name: localize(tool._mcp.serverName) || serverId,
      description: '',
      mcpServer: true
    });
  });
  return out;
}
