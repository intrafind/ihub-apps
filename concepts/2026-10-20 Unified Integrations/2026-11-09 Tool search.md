# Tool search: leave the biggest integrations out of the request, find them with `search_tools` (implementation notes)

**Date:** 2026-11-09
**Status:** Implemented on `claude/epic-meitner-7s02ny`
**Issue:** [intrafind/ihub-apps#2889](https://github.com/intrafind/ihub-apps/issues/2889)
**User docs:** [docs/tool-calling.md → Tool search](../../docs/tool-calling.md#tool-search-many-integrations-few-tool-definitions)

The issue was written before every tool became an action of an integration (#3358, #3275). Its
proposal talks about `toolLoader.js`, configured tools, tool-name patterns (`jira_*`) and a
`toolSettings` block on the app. None of that exists any more, so this is the proposal rebuilt on
integrations. What changed against the issue, and why:

| Issue                                                         | Here                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Defer a tool over a size threshold, per tool                  | Leave out **whole integrations**, biggest first, until the rest fits a token budget               |
| Always-loaded list of tool names or patterns                  | `alwaysLoaded: true` on the app's **binding** of the integration (id, definition id or `type:`)  |
| `toolSettings.deferral` on the app                            | `toolSearch: { mode: 'auto' \| 'off', maxToolTokens }` beside `toolChoice`; no tool list to hang it on |
| Platform flag, off by default                                 | Feature `toolSearch` in the registry (preview, default off); no `platform.json` setting, no migration |
| `call_tool(name, arguments)` with an object                   | `arguments` is **JSON text**: a free-form object cannot be expressed on every provider: the Responses converter forces `additionalProperties: false` on every object (so it could only be empty) and the Google converter strips the keyword (so it is unchecked). An object is still accepted |
| Defer configured tools, MCP, A2A, apps, skills, system skills | Only **integration actions** (MCP and A2A are installations). Skills, knowledge, chat context, workflows and apps stay loaded |
| Workflow and agent nodes: decide                              | Stay loaded (`PromptNodeExecutor` is untouched); only the chat pipeline (`prepareChatRequest`) splits |

## How it fits together

- `server/services/tools/toolSearch.js`: the decision (`splitTools`, `isDeferrable`,
  `maxToolTokensFor`), the `<available_tools>` list (`buildToolIndex`, three levels like the skills
  catalog), `search_tools`' answer, and `createToolSearch()`, the loop's view of one request.
- `getToolsForApp` is unchanged and still returns every tool: the integrations picker, scheduled
  tasks' tool pickers and the tool approval stamp read the full set. The split happens afterwards,
  in `RequestBuilder.prepareChatRequest`, which returns `data.tools` (what is sent) and
  `data.toolSearch`.
- **Unwrapping happens in the agent loop, before any seam** (`resolveToolCall` in
  `services/loop/toolArgs.js`). The loop's item carries the real tool and its arguments, so the
  approval gate, `tool/started`, the run ledger, usage and the circuit breaker act on the real tool.
  Dispatching inside `runTool` would have shown `call_tool` to all of them and, worse, resolved the
  approval policy of `call_tool` (an internal tool: none), which is a write bypass.
- The transcript stays what the model wrote. Tool messages keep the **wire name** (`call_tool`):
  Gemini matches a function response by name. Seams that build a tool message read `info.wireName`;
  frames and logs read `info.name`, which is the real tool.
- A call paused for approval is stored as `{ name: 'call_tool', toolId: <real> }` and resumes as the
  real tool with the approved arguments (`request.resume.toolId`).
- `search_tools` is answered by the loop from the request's left-out tools; `call_tool` has no
  `runTool` branch, so a wiring mistake fails closed (“Tool call_tool not found”).
- Search ranking is the skills' ranking, extracted to `utils/catalogSearch.js`. `searchSkillCatalog`
  is gone; `find_skill` and `search_tools` call `searchCatalog`.
- Arguments are checked with the structured-output validator (Ajv with a timed regular-expression
  engine): a deferred tool's schema comes from an admin or a remote MCP server, and the model chooses
  the text the schema's `pattern`s are tested against.

## Decisions to review

- **Budget.** 6000 tokens of tool definitions, at most a tenth of the model's context window,
  at least 500. Estimated with the shared tokenizer on `{ name, description, parameters }`.
- **Pinned integrations over budget stay**; everything else is then searched. Tool search is skipped
  when the list plus the two search tools would cost as much as the tools left out.
- **A tool the circuit breaker withheld** is refused through `call_tool` too (it is not in `tools`,
  so the loop's usual filter cannot withhold it).
- **Not done:** Anthropic's native `defer_loading` and OpenRouter's `openrouter:tool_search`. The
  generic path has to work everywhere anyway; the native one is an optimisation for later.

## Cleaned up on the way

- `runTool`: the `_mcp`, `_a2a` and `isSpecialTool` dispatch branches were unreachable (every MCP
  and A2A tool carries `_integration` and takes that branch first; nothing sets `isSpecialTool` any
  more). Removed with their client-manager imports. The approval-bypass guard
  (`tests/loop/approvalSeam.test.js`) listed `runTool.js` as a direct remote-tool caller; it is not
  one any more and the entry is gone.
- `utils/toolScripts.js` (`describeToolScript`) had no caller in code, tests or docs. Deleted.
- `appendIntegrationGuidance` and the new list share `appendSystemBlock`.

## Seen, not removed (needs a decision)

- `isSpecialTool` is still filtered in seven provider converters, with tests; nothing creates such a
  tool any more.
- `isToolSelected` still answers to the `_`-split base id (`jira` selects `jira_searchTickets`) for
  built-ins that kept their old tool ids. Group grants and chats' `enabledTools` may still use it,
  so dropping it is a breaking change.
