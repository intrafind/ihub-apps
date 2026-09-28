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
 * The remote source a tool belongs to — an MCP server (`_mcp`) or a remote
 * A2A agent (`_a2a`) — as `{ key, id, name, kind }`, or null for a tool of
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
  return null;
}

/**
 * A tool of the MCP server or A2A agent a whole-source reference (`"drawio"`,
 * `"langdock"`, `"a2a__langdock"`) enables, the way the server's
 * `isToolSelected` reads it: an MCP server wins, `a2a__<agentId>` always
 * names the agent, and an A2A agent marked `_a2a.idConflict` (its id is also
 * a tool's or MCP server's id) is never enabled by the bare id.
 *
 * @param {Array<Object>} tools
 * @param {string} reference
 * @returns {Object|undefined}
 */
function ownerByReference(tools, reference) {
  return (
    tools.find(candidate => candidate._mcp?.serverId === reference) ||
    tools.find(
      candidate =>
        candidate._a2a?.agentId &&
        (a2aAgentReference(candidate._a2a.agentId) === reference ||
          (candidate._a2a.agentId === reference && !candidate._a2a.idConflict))
    )
  );
}

/**
 * Groups an app's tool references by their originating MCP server or remote
 * A2A agent, so the end-user tools menu shows one toggle per server or agent
 * (e.g. "draw.io", "Langdock agent") and never the granular tools behind it
 * (create_diagram, search_shapes; one tool per agent skill).
 *
 * An app enables an MCP server (or A2A agent) by listing its id in `app.tools`
 * (`"drawio"`); apps configured before that list the server's tool ids
 * instead. Both kinds of reference fold into the source's single group, whose
 * `matchedTools` are the app's references that belong to it — the ids the
 * toggle adds to or removes from `enabledTools`. A tool with no `_mcp` or
 * `_a2a` metadata stays individual, and so does a function-style reference
 * (`jira` for `jira_searchTickets`).
 *
 * A reference no loaded tool resolves is left out: it is a server that is
 * down or disabled, or a tool name an MCP server no longer offers, and a
 * toggle for it would do nothing. Nothing is left out while no tools are
 * loaded, so a failed request still shows the app's references.
 *
 * @param {string[]} appToolIds - app.tools
 * @param {Array<{id:string,_mcp?:{serverId:string,serverName?:object|string},_a2a?:{agentId:string,agentName?:object|string}}>} availableTools
 * @param {(content:any)=>string} localize - resolves a possibly-localized name to a display string
 * @returns {{grouped: Array<{id:string,name:string,matchedTools:string[]}>, individual: string[]}}
 */
export function groupToolsByMcpServer(appToolIds, availableTools, localize) {
  if (!appToolIds || appToolIds.length === 0) return { grouped: [], individual: [] };

  const tools = availableTools || [];
  const groups = new Map();
  const individual = [];

  appToolIds.forEach(toolId => {
    const tool = tools.find(candidate => candidate.id === toolId);
    const owner = tool ? ownerOf(tool) : ownerOf(ownerByReference(tools, toolId));
    if (!owner) {
      // A2A tool ids all start with `a2a_`; the reference `a2a` is not a
      // function-style base id for them.
      const resolved =
        tools.length === 0 || tool || tools.some(c => !c._a2a && c.id.startsWith(`${toolId}_`));
      if (resolved) individual.push(toolId);
      return;
    }
    if (!groups.has(owner.key)) {
      groups.set(owner.key, {
        id: owner.key,
        name: localize(owner.name) || owner.id,
        matchedTools: []
      });
    }
    groups.get(owner.key).matchedTools.push(toolId);
  });

  return { grouped: Array.from(groups.values()), individual };
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
