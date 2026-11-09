# Tool search: leave the biggest integrations out of the request, find them with `search_tools` (implementation notes)

**Date:** 2026-11-09
**Status:** Implemented on `claude/epic-meitner-7s02ny`
**Issue:** [intrafind/ihub-apps#2889](https://github.com/intrafind/ihub-apps/issues/2889)
**User docs:** [docs/tool-calling.md → Tool search](../../docs/tool-calling.md#tool-search-many-integrations-few-tool-definitions)

The issue was written before every tool became an action of an integration (#3358, #3275). Its
proposal talks about `toolLoader.js`, configured tools, tool-name patterns (`jira_*`) and a
`toolSettings` block on the app. None of that exists any more, so this is the proposal rebuilt on
integrations. What changed against the issue, and why:

| Issue                                                         | Here                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Defer a tool over a size threshold, per tool                  | Leave out **whole integrations**, biggest first, until the rest fits a token budget                              |
| Always-loaded list of tool names or patterns                  | `alwaysLoaded: true` on the app's **binding** of the integration (id, definition id or `type:`)                  |
| `toolSettings.deferral` on the app                            | `toolSearch: { mode: 'auto' \| 'off', maxToolTokens }` beside `toolChoice`; no tool list to hang it on           |
| Platform flag, off by default                                 | Feature `toolSearch` in the registry (preview, default off); no `platform.json` setting, no migration            |
| `search_tools`, then `call_tool(name, arguments)`             | `search_tools` only: **what it finds is added to the request's tools**, and the model calls it directly (below) |
| Defer configured tools, MCP, A2A, apps, skills, system skills | Only **integration actions** (MCP and A2A are installations). Skills, knowledge, chat context, workflows and apps stay loaded |
| Workflow and agent nodes: decide                              | Stay loaded (`PromptNodeExecutor` is untouched); only the chat pipeline (`prepareChatRequest`) splits            |

## Why found tools join the request, and not `call_tool`

The issue asked for `call_tool` because a model cannot call a tool that is not in the request's
`tools`: strict providers refuse it (Open WebUI 0.12.0). That holds for a tool that is **never**
added. A tool the search adds to `tools` for the next step is an ordinary tool of that step, and a
strict provider accepts it. The first implementation used a `call_tool` wrapper; a review question
(why not add the found tools?) replaced it.

- **The model calls a real tool with its real schema.** A wrapper makes the model write the
  arguments as JSON inside a string (a free-form object cannot be expressed on every provider: the
  Responses converter forces `additionalProperties: false` on every object, the Google converter
  strips it). Smaller and local models, whose tool choice was a motivation for the issue, are the
  likeliest to slip there.
- **Nothing sits between the model and the approval gate.** The wrapper had to be unwrapped in the
  agent loop before any seam (otherwise the approval policy of `call_tool`, an internal tool, is
  none: a write bypass), keep the wire name apart from the real name (Gemini matches a response by
  name), store both on a paused approval and validate the arguments itself. All of that is gone;
  `toolArgs.js`, `approvalSeam.js` and `questionSeam.js` are as they were before this work.
- **The model's side matches Anthropic's native tool search.** There too the model calls a found
  tool directly, with its own schema. The difference is where the definition goes: Anthropic
  expands it **inline in the conversation** (a `tool_reference` block), not in the `tools` prefix,
  so its prompt cache is untouched. No other provider we send to has an inline equivalent, so the
  generic path adds the found tools to `tools` and pays the cache cost below.

**The price: the request changes in a turn whose model searched.** The roadmap proposal
(`2026-11-03 Feature Gap Analysis and Roadmap Proposals.md`) said the opposite on purpose: “the
`tools[]` array stays the same during a run, so the prompt-cache prefix stays stable”. With found
tools, a provider's prompt cache (iHub sends cache breakpoints on the tools, the system prompt and
the last user message for Anthropic and Bedrock, and a cache key for OpenAI) stops applying to the
steps after the search. A turn that does not search is unaffected, and the list in the system prompt
stays the same from turn to turn.

What does **not** have to be carried: the history that goes to the model holds the prose of earlier
turns, never their tool calls (`chatContextTools.js`: “only the next turn's prose reached the
model”). So a tool found in turn 1 is not in turn 2's request and does not need to be: the model
searches again. Nothing is stored per chat.

## How it fits together

- `server/services/tools/toolSearch.js`: the decision (`splitTools`, `isDeferrable`,
  `maxToolTokensFor`), the `<available_tools>` list (`buildToolIndex`, three levels like the skills
  catalog), `search_tools`' answer, and `createToolSearch()`, the loop's view of one request.
- `getToolsForApp` is unchanged and still returns every tool: the integrations picker, scheduled
  tasks' tool pickers and the tool approval stamp read the full set. The split happens afterwards,
  in `RequestBuilder.prepareChatRequest`, which returns `data.tools` (what is sent) and
  `data.toolSearch`.
- **The loop owns the loading.** When `search_tools` runs, `AgentLoop` pushes what the search found
  onto its tool list (`ctx.tools`; the native web search fallback adds a tool the same way), and
  the next round offers it. The tools come from the request's left-out set, already narrowed by the
  app, the user's groups, the chat's selection and the scheduled-run gate, so only a tool that was
  offered can be found. A call to a tool that was not found is an unknown tool.
- **A paused approval resumes as the found tool.** The stored call names the real tool (it was
  called by name); the continuing request starts with the tool left out again, so the resume
  loads it with `toolSearch.take(name)` and runs it with the arguments that were approved. A tool
  that is no longer offered is an unknown tool.
- **Caps:** five tools per search, 15 per run (`MAX_LOADED_BY_SEARCH`). A tool is found once.
- Search ranking is the skills' ranking, extracted to `utils/catalogSearch.js`. `searchSkillCatalog`
  is gone; `find_skill` and `search_tools` call `searchCatalog`.
- `search_tools` is not drawn or counted as a web search: it is `isInternalTool`, and the
  classifiers that guessed from the id (`search…`) now skip internal tools.

## Decisions to review

- **Budget.** 6000 tokens of tool definitions, at most a tenth of the model's context window,
  at least 500. Estimated with the shared tokenizer on `{ name, description, parameters }`.
- **Pinned integrations over budget stay**; everything else is then searched. Tool search is skipped
  when the list plus the search tool would cost as much as the tools left out.
- **Not done:** Anthropic's native `defer_loading` and OpenRouter's `openrouter:tool_search`. The
  generic path has to work everywhere anyway. For Anthropic the native path is the better one: it
  keeps the prompt cache (see above), at the price of sending every tool definition in `tools` on
  every request, which saves context-window tokens but not request size.

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
- **Older planning notes still describe `search_tools` + `call_tool`** and the stable `tools[]`:
  `05-roadmap.md` (auto vs on-demand tool mode), `03-product-concept.md` (on-demand mode) and
  `../2026-11-03 Feature Gap Analysis and Roadmap Proposals.md`. They are left as written; update
  them if the decision above stands.
