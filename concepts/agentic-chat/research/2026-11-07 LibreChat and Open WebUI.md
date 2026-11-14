# Multi-step agent behaviour in LibreChat and Open WebUI: code-level findings

Research date: 2026-11-07. All three repos were shallow-cloned (`--depth 1`) for reading; the code was not run.

| Repo | Commit | Date | Version |
|---|---|---|---|
| danny-avila/LibreChat | `f4154b649efa37e1345ccc517a4d8d1ed2178c82` | 2026-10-31 | bumps Agents SDK to 4.2.1 (v0.8.8 line) |
| danny-avila/agents (`@librechat/agents`) | `708c9118f478a84f28e8e253148a373b49fec191` | 2026-10-31 | 4.2.1 |
| open-webui/open-webui | `c38885a1a737da4968f157092f304f3b5481d0bf` | 2026-11-03 | 0.13.0 |

Paths below are relative to each repo root. **[inferred]** marks anything I concluded without seeing it directly in code.

---

## 1. LibreChat (+ `@librechat/agents`)

### 1.1 Loop architecture
- **This is a classic LangGraph ReAct graph.** Each agent compiles to
  `START → agent= → (conditional) → tools= | summarize= | END`, with edges `tools= → agent=` and `summarize= → agent=`.
  - Code: `agents/src/graphs/Graph.ts:5744-5918` (`new StateGraph(StateAnnotation).addNode(agentNode…).addNode(toolNode…).addNode(summarizeNode…)`, then `.addEdge(START, agentNode).addConditionalEdges(agentNode, routeMessage).addEdge(summarizeNode, agentNode).addEdge(toolNode, agentContext.toolEnd ? END : agentNode)`).
  - `toolEnd` is a per-agent option. When set, the graph ends right after the tools run and makes no follow-up model call.
- **The stop decision lives in `routeMessage`** (`Graph.ts:5637-5702`). In order:
  1. A pending preempt/steer seal sends the run back to the agent node.
  2. A pending `summarizationRequest` routes to the summarize node.
  3. Client-delegated tools (tools executed by the client) route to END.
  4. Otherwise `toolsCondition` (`agents/src/tools/ToolNode.ts:6451`) applies. If the last AIMessage has `tool_calls` that have not been invoked yet, the run goes to the tools node. Otherwise it ends.
  - So **"done" simply means the model returned no tool calls.** Nothing judges whether the work is finished.
  - If the final text was cut off by the max-output-token ceiling, the run still ends, but the turn is flagged `outputTruncatedIncomplete`. Hosts can then tell a truncated answer from a finished one.
- **Multi-agent:** `MultiAgentGraph.ts` supports two edge types (`agents/docs/multi-agent-patterns.md`):
  - *Handoff* edges are dynamic routing. They are realised as `lc_transfer_to_<agent>` tools.
  - *Direct* edges are parallel fan-out/fan-in.
  - Supported patterns: sequential, supervisor, map-reduce, hybrid.
  - LibreChat also has "agent chains" (`packages/api/src/agents/chain.ts`) and "added" parallel agents (`added.ts`).
  - Regular non-agent chat also runs through this runtime as an "ephemeral agent" (`packages/api/src/agents/added.ts:121-233`). Its toggles enable web search, code execution, file search and MCP.
- **Subagents:** `agents/src/tools/SubagentTool.ts` provides a `subagent` tool. Each subagent gets an isolated context and returns only its final text. Background mode returns a `background_task_id` for later polling. Configured per agent; `maxSubagents` defaults to 10 (hard cap 50).
  - Tool description (verbatim excerpt): *"Delegate a task to a specialized subagent or bounded agent team that runs in an isolated context window. The delegated execution returns only its designated final text result — all intermediate tool calls, reasoning, and context stay isolated. … The subagent cannot see your conversation history."*
  - The `description` parameter says: *"This is the ONLY information it receives — include all necessary context…"*
- **Hooks system:** `agents/src/hooks/` provides `PreToolUse`, `PostToolUse`, `PostToolBatch`, `Stop`/`StopFinalize`, `PreemptBoundary` and others. The design is modelled on Claude Code hooks. LibreChat even maps Claude tool names, and lists `TodoWrite`, `Task`, `WebFetch`, `ExitPlanMode` etc. as *unsupported* (`packages/api/src/agents/hooks/executor.ts:163-176`).

### 1.2 Iteration limits and their defaults
- **The budget is LangGraph's `recursionLimit`, which counts supersteps.** One tool round costs 2 supersteps (tools node + agent node), and the first model call costs 1.
  - SDK default: `DEFAULT_RECURSION_LIMIT = 50` (`agents/src/common/constants.ts:64`).
  - LibreChat default: also 50 (`packages/api/src/agents/config.ts:9`).
  - Resolution cascade in `resolveRecursionLimit` (`config.ts:75-91`): YAML `endpoints.agents.recursionLimit`, then the per-agent DB `recursion_limit` (UI "Max Agent Steps"), then a cap at YAML `maxRecursionLimit`.
  - **In practice that is about 24 tool rounds per turn.** Parallel calls in one batch count as one round.
  - **The docs and UI copy are stale.** `librechat.example.yaml:819-824` says "defaults to 25", and the UI string `com_ui_agent_recursion_limit_info` (`client/src/locales/en/translation.json:1194`) says "Default is 25 steps". The code says 50.
- **Subagents:** `DEFAULT_SUBAGENT_MAX_TURNS = 25` and `SUBAGENT_RECURSION_MULTIPLIER = 3`, giving a recursionLimit of 75 (`agents/src/tools/subagent/runtimeLimits.ts`). LibreChat derives `maxTurns` from the parent's resolved limit (`config.ts:93-110`).
- **Step-budget countdown (new and notable):** `packages/api/src/agents/stepBudget.ts` is registered unconditionally as a `PostToolBatch` hook (`packages/api/src/agents/run.ts:2994`).
  - It counts tool rounds rather than individual calls. When 3 or fewer rounds remain (`WARN_AT_REMAINING_ROUNDS = 3`), it injects `additionalContext`. That context becomes one system-flavoured message right before the next model call, and it is never persisted.
  - Verbatim, when rounds remain: *"System notice: this turn has about N more tool-calling rounds left before it is cut off. Stop broadening the search and start converging: use what you already have, make only calls you cannot finish without, and leave room to write the final answer."*
  - Verbatim, at 0: *"…no tool-calling budget left. Do not call any more tools; another tool call will be cut off before you can use its result. Write your final answer now from what you already have, and state briefly what remains unresolved."*
  - The design rationale is written into the file: *"Models are poor at tracking how many calls they have made, so the fix is to tell them, counting down over the last few rounds rather than announcing a budget they will ignore while it is ample."*
- **What happens when the limit is hit:** LangGraph throws `GraphRecursionError`, which `isStepLimitError` detects (`packages/api/src/agents/errors.ts:243`).
  - `client.js:5298-5316` treats this as **incomplete, not failed**. Everything streamed so far is saved, and the row is marked `unfinished` with `TOOL_CALL_LIMIT_FINISH_REASON`.
  - The UI then shows `ToolCallLimitNotice.tsx` with two buttons. Each posts an ordinary user turn, which gets a fresh step budget:
    - "Keep going" sends *"Keep going from where you stopped."*
    - "Answer now" sends *"Stop using tools and answer now with what you already have. Say briefly what you could not finish checking."*
  - **Note: the SDK never makes a forced tool-less "final answer" call.** It relies on the countdown nudge plus the user button.
- **Other limits:**
  - `DEFAULT_MAX_STOP_CONTINUATIONS = 8`: a Stop hook can re-arm a run that ended naturally, at most 8 times.
  - `DEFAULT_MAX_SEALS = 8`: preempt/steer seals.
  - `maxToolCallArgBytes`: 64 KiB per streamed tool call; `create_file` gets 128 KiB.
  - `maxDeltaEventsPerTurn`: opt-in.
  - Model body idle timeout: 15 min.
  - Per-tool-result cap: 30% of the context window × 4 chars, hard max 400,000 chars (`agents/src/utils/truncation.ts:29-58`).

### 1.3 Parallel tool calls
- **All calls in one AI message run concurrently** via `Promise.all` (`agents/src/tools/ToolNode.ts:5460`). The exception is "interrupting" (HITL approval) tools, which are sequenced first.
- **Eager tool execution:** for some providers, a tool call starts *while the model is still streaming* once its arguments are "sealed" (`agents/src/tools/streamedToolCallSeals.ts`, `eagerEventExecution.ts`). Supported adapters: OpenAI Responses, Bedrock Converse, Google GenAI, sequential OpenAI chat, and Anthropic.
- **Programmatic tool calling:** `run_tools_with_code` / `run_tools_with_bash` (`agents/src/tools/ProgrammaticToolCalling.ts:147`) let the model write Python that calls tools in loops or `asyncio.gather`, Anthropic-PTC style.
- **Tool-output references:** `{{tool<i>turn<n>}}` lets the model pipe raw earlier tool output into bash. Up to 5 MB of raw output is retained (`truncation.ts:39`).

### 1.4 Carrying reasoning across tool calls, per provider
- **Within a run, messages stay as LangChain `AIMessage`s with the provider-native content blocks**, so reasoning round-trips intact:
  - **Anthropic:** `thinking` blocks with `signature`, and `redacted_thinking`.
  - **Bedrock:** `reasoning_content`.
  - **Google/Vertex:** `reasoning` blocks. Function-call `thoughtSignature`s are kept in `additional_kwargs['__gemini_function_call_thought_signatures__']` (`agents/src/llm/providerTextControls.ts:5`).
  - **OpenAI Responses:** always requests `include: ['reasoning.encrypted_content']` when eligible (`agents/src/llm/openai/index.ts:2377-2384`). It also carefully re-seals one reasoning item per id/ciphertext (`resealReasoningItemBoundary`, `index.ts:780-800`). The documented failure this prevents: *"Encrypted content could not be decrypted or parsed"*.
  - The shapes it recognises are listed in `agents/src/messages/reasoningTypes.ts`.
- **Switching an agent into thinking mode:** `ensureThinkingBlockInMessages` (`agents/src/messages/format.ts:4271`) folds earlier tool sequences that have no thinking block into a `[Previous agent context]` text buffer, so Anthropic does not reject a missing signature. The run's own iterations are never folded.
- **"Commentary" vs "final_answer" phases** from Open Responses-compatible providers are kept as separate steps (`agents/src/messages/assistantPhase.ts`).

### 1.5 Context management
Source: `agents/docs/summarization-behavior.md`, which describes itself as *"inspired by Claude Code's compaction approach"*. The code is in `src/messages/contextPruning.ts`, `fading.ts` and `src/summarization/`.
- **Observation masking at 80% context pressure:** tool results the model has already consumed are cut to a head+tail of about 300 chars. AI messages are never masked.
- **"Fading tier" ladder:** the latched cap halves per rung. It keeps historical tool results byte-identical within a tier, so the provider prompt cache stays valid.
- **Calibration:** a cumulative ratio of provider-reported tokens to local tiktoken counts, persisted across runs.
- **Summarization** (opt-in YAML `summarization:`, retaining the 2 newest turns and 2000 tokens by default): full compaction of the conversation. Graph state is wiped, and `[System, Human(summary)]` is re-injected mid-run so the model continues.
  - The default prompt (`agents/src/summarization/shared.ts:36`) is written as the *user* speaking: *"Hold on, before you continue I need you to write me a checkpoint of everything so far. … Do not call tools … Don't second-guess or fact-check anything you did, your tool results reflect exactly what happened…"*
  - Sections: Goal / Constraints & Preferences / Progress (Done, In Progress) / Key Decisions / Next Steps / Critical Context.
  - A separate "update checkpoint" prompt handles re-compaction.
- **Without summarization**, more aggressive mechanical truncation kicks in at 85/90/99% pressure.

### 1.6 Built-in tools
- **Web search** (`agents/src/tools/search/*`, ~13k LOC) is a full pipeline:
  - **Search provider:** Serper, SearXNG, Tavily, Keenable or CRW. `numResults = 8`, capped at 10 for Serper.
  - **Scraper:** Firecrawl by default, or Serper, Tavily, CRW or Keenable. `maxContentLength = 50,000`.
  - **Chunking:** `RecursiveCharacterTextSplitter`, 150 chars with 50 overlap (`search.ts:45-46`).
  - **Reranking:** Cohere by default, or Jina, rag_api, Infinity, none, or an injected reranker. A new `src/rerank` module adds BM25, a cross-encoder and an LLM-rubric "System One" reranker with fallbacks.
  - **Output:** `topResults = 5` highlights with citation anchors (`tool.ts:502-511`).
  - **The tool description actively discourages iteration:** `schema.ts:91` says *"Note: Use ONCE per reply unless instructed otherwise."* LibreChat does not override this (grep). That works against deep-research-style multi-search.
  - The query parameter description teaches search operators ("Start broad, then narrow…", quotes, `site:`, `filetype:` …).
  - Citations use private-use-area anchors (`turn0search0`). The description says *"NEVER use markdown links, [1], or footnotes."*
- **Code interpreter:** the `execute_code` tool talks to a remote sandbox API (`api.librechat.ai` or self-hosted).
  - Each execution is a new interpreter process, but `/mnt/data` persists across calls in a session (`CodeExecutor.ts:452-470`).
  - Also: `bash_tool`, `read_file`, experimental stateful sessions, and "attached code environments" (user-owned workers).
  - A local coding bundle (`write_file`, `edit_file`, `grep_search` …) exists in the SDK.
- **File search:** `file_search` (`api/app/clients/tools/util/fileSearch.js`) does semantic search through the separate RAG API (pgvector). There is no agentic browse/grep over documents. Citation instructions use the same anchors. Config: `maxCitations: 30`, `maxCitationsPerFile: 7`, `minRelevanceScore: 0.45`.
- **Artifacts:** an artifacts system prompt is appended per agent (`packages/api/src/prompts/artifacts/`, `initialize.ts:2636-2641`).
- **MCP:** full support in `packages/api/src/mcp/`: per-user connections, OAuth, deferred tools (`defer.ts`), and MCP Apps. Large tool sets go through `tool_search`, described as *"Searches deferred tools using BM25 ranking…"*, default 5 results (`agents/src/tools/ToolSearch.ts:38-48`).
- **Skills** (`skill` tool), **memory**, and **HITL** (`ask_user_question`, up to 4 related questions in one form; tool approvals with durable pause/resume).
- **There is no planning/todo tool and no "deep research" mode in code** (grep for todo/plan/deep research: none). `agents/src/prompts/taskmanager.ts` and `collab.ts` (a supervisor prompt, "aim to complete the entire task in NO MORE THAN 2-3 TURNS") are not referenced anywhere outside `prompts/`, so they look like dead legacy code.

### 1.7 System prompts
- **No default agentic system prompt.** Agent instructions are entirely user-authored.
- The host appends `additional_instructions`:
  - `{{current_date}}`-style variables (`initialize.ts:216`).
  - Artifacts prompt, memory guard, file context notes, e.g. *"Note: Use the file_search tool to find relevant information within: …"* (`fileSearch.js:68-77`).
  - MCP server instructions.
- Guidance otherwise lives in the tool descriptions.

### 1.8 Progress streaming and UI
- **The SDK emits run-step events** (`agents/src/common/enum.ts:11-49`): `on_run_step`, `on_run_step_delta`, `on_run_step_completed`, `on_message_delta`, `on_reasoning_delta`, `on_tool_calls_dispatched`, `on_summarize_*`, `on_subagent_update`, `on_context_usage`, `on_agent_update`. These are streamed over SSE.
- **Tool intent labels** (`agents/src/tools/intentArg.ts`): an optional `intent` property is injected as the **first** schema property of opted-in tools. Because providers stream arguments in order, the UI can show a live status label before the rest of the arguments arrive.
  - Verbatim description: *"ALWAYS write this field FIRST, before any other argument. One present-progressive sentence saying what THIS call is about to do: 'Searching for OAuth handling in the callback router'. Shown to the user as this call's live status. Never name the tool. Sibling calls to one tool must differ."*
- **Activity labels:** a fast side model (e.g. `gpt-4.1-nano`) writes a header for each collapsed group of tool calls plus reasoning (`agents/src/prompts/activityLabel.ts:16`).
  - The style is explicitly *"synthesized from Claude Code's tool-use summary prompt … and claude.ai's observed group headers"*: 5-9 words, past tense, e.g. "Searched Node.js release notes and changelogs".
  - "Activity phase" labels (8-18 words) summarise a multi-activity phase.
  - Reasoning labels retitle a long "Thinking…" block live (`reasoningLabel.ts`).
  - All are config-gated: `activityLabel`, `reasoningLabel`, `activityMaxPerRun: 20` …
- **UI components** in `client/src/components/Chat/Messages/Content/`: `ActivityPhaseGroup`, `ToolCallGroup`, `ToolCall`, `Parts/Thinking`, `Parts/Reasoning`, `WebSearch`, `SubagentProgress`, `AgentHandoff`, `ToolApproval`, `AskUserQuestion`, `ParallelContent`, `Parts/SteerPart`, `Parts/PendingSteers`, `ToolCallLimitNotice`.
- **Steering:** users can interrupt, steer or queue messages mid-run (v0.8.8). Steer messages drain after a tool batch (`PostToolBatch`), at preempt boundaries, or at terminal `StopFinalize`.

### 1.9 Assessment
**Does well**
- The engineering on long runs is very mature: step-budget countdown, a graceful incomplete-turn path with "Keep going / Answer now", cache-stable context fading, Claude-Code-style compaction, and faithful provider-native reasoning replay (Anthropic signatures, OpenAI encrypted reasoning, Gemini thought signatures).
- Parallel and eager tool execution.
- A rich UI vocabulary: intent labels, LLM-written activity headers, reasoning titles.
- Subagents with isolated context, steering mid-run, HITL.

**Does badly / limitations**
- **The default budget is small:** 50 supersteps, about 24 tool rounds, and the docs still say 25 steps (about 12 rounds).
- **The default `web_search` tells the model "Use ONCE per reply"**, so out-of-the-box research is one-shot unless the agent's instructions say otherwise.
- No planning/todo tool, no deep-research mode, and no default agentic system prompt. Behaviour quality depends heavily on what the admin writes into the agent instructions.
- The stop criterion is purely "no tool calls". There is no completeness self-check and no forced final synthesis call.
- Very high complexity: Graph.ts is 6.3k LOC and ToolNode.ts 6.5k LOC. **[inferred]** That makes behaviour hard to reason about.
- Web search: no dedicated sources found that confirm public user complaints about multi-step behaviour (searches returned only docs/release notes).

---

## 2. Open WebUI (0.13.0)

### 2.1 Two function-calling modes
`params.function_calling` takes one of three values: `null` ("Default"), `'native'` or `'legacy'`. The backend checks only `!= 'legacy'`, so **Default means Native** (`backend/open_webui/utils/middleware.py:2897`). Native became the default in **0.10.0 (2026-06-29)**, and the old prompt mode was renamed "Legacy" (CHANGELOG line 1978). The docs now call Legacy "deprecated".

- **Legacy (prompt-based) is a single pre-step and does not loop.** `chat_completion_tools_handler` (`middleware.py:1015-1236`):
  - A *task model* gets `DEFAULT_TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE` (`config.py:2498`) plus the last 4 messages, and must return `{"tool_calls":[{"name":…,"parameters":…}]}`.
  - The prompt says, verbatim: *"Your task is to choose and return the correct tool(s) from the list of available tools based on the query. … Return only the JSON object…"*
  - The tools run once, sequentially. Their results become "sources" injected into the RAG template, and then the main model answers.
  - Web search, image generation and the code interpreter are also forced pre-steps in Legacy mode (`middleware.py:2419-2445`).
  - **Code-interpreter exception:** in Legacy mode with the XML-tag interpreter, the model can emit `<code_interpreter>` up to `MAX_RETRIES = 5` times. Each time the stream is cut, the code runs, and the model is re-invoked (`middleware.py:6147-6150`).
- **Native is a real multi-round loop** (`middleware.py:5608-6145`):
  - `while tool_calls and (max is None or tool_call_iterations < max)`, at line 5667. Each iteration:
    1. Resolve calls.
    2. Handle `ask_user` and the approval pause (`tool_approval_mode == 'ask'` persists state and returns; it resumes later).
    3. **Execute the calls sequentially** (`for tool_call … await execute_tool_call(...)`). **Only `delegate_task` calls run in parallel** via `asyncio.gather` (lines 5762-5779).
    4. Append `function_call_output` items, extract citations, and rebuild the RAG source context from scratch so it does not accumulate.
    5. Optionally compact context.
    6. Re-call the model (streaming).
  - The loop ends when the model returns no tool calls.
  - **Native only works on the streaming path and needs `chat_id` + message `id`.** The API docs state: *"Without both, no tools are executed server-side at all."*
- **Iteration cap:** `CHAT_RESPONSE_MAX_TOOL_CALL_ITERATIONS`, **default 1024**; `-1` means unlimited (`backend/open_webui/env.py:1084-1100`). It can be overridden per request via `request.state.max_tool_call_iterations`, which subagents use.
  - When the cap is reached, the UI gets an error message: `Tool-call limit reached (N iterations).` (`middleware.py:6137-6145`). There is no wrap-up nudge and no forced final answer.
  - **History of the cap:**
    - Hardcoded 10.
    - Env `CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES`, default 30 (0.6.26, 2025-08-28).
    - Renamed and raised to 256, and an in-chat error shown (0.9.6, 2026-06-01).
    - 1024 (0.13.0, 2026-11-02).
  - **Known complaint:** before 0.9.6 the loop **silently stopped** after 30 tool calls. Discussion #24915 (v0.9.5, vLLM/llama.cpp, Qwen/Gemma/MiniMax) reported "conversation abruptly stops … with many tool calls", with the workaround `CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES=9999`. That is what led to the rename, the 256 default and the visible error. Discussion #23645 (v0.8.12) reported "response sometimes ends after a random tool call". The older #9435 reported native mode "only calls the LLM once".
- **Tool errors** (bad JSON, unknown tool, exceptions, not approved) go back to the model as tool output, so it can retry (`middleware.py:3092-3200`). There is no generic tool-result truncation, only `WEB_FETCH_MAX_CONTENT_LENGTH`, which is unset by default.

### 2.2 Web search and RAG wiring
- **Legacy: query generation as a pre-step, then RAG.** `chat_web_search_handler` (`middleware.py:1239+`):
  1. `generate_queries` uses `DEFAULT_QUERY_GENERATION_PROMPT_TEMPLATE` (`config.py:2374`). Verbatim excerpt: *"Analyze the chat history to determine the necessity of generating search queries… By default, prioritize generating 1-3 broad and relevant search queries unless it is absolutely certain that no additional information is required. … Err on the side of suggesting search queries if there is any chance… Today's date is: {{CURRENT_DATE}}."* It is given the last 6 messages.
  2. `process_web_search`: search, load pages, then embed and retrieve, unless `BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL`.
  3. The result is injected through `DEFAULT_RAG_TEMPLATE` (`config.py:1070`): *"Respond to the user query using the provided context, incorporating inline citations in the format [id] only when the <source> tag includes an explicit id attribute…"*
  - Defaults: `WEB_SEARCH_RESULT_COUNT = 3`, `RAG_TOP_K = 3`, hybrid search off, no reranker (`config.py:957-1177`).
- **Native ("Agentic Search"):** the builtin tools `search_web` and `fetch_url` (`backend/open_webui/tools/builtin.py:291-362`).
  - Gating requires all of: global enable, model `web_search` capability, chat feature toggle, and user permission (`utils/tools.py:820-829`).
  - `search_web` returns **snippets only** (title, link, snippet). The count is capped at the admin `result_count`, which is 3 by default; the code falls back to 5 if unset.
  - `fetch_url` returns extracted page text. The docs give about 50k characters.
  - The docs say only fetched pages become citations, and the model can follow links. This is the ChatGPT-style search, read, search-again loop, but it depends entirely on the model deciding to iterate.
- **Agentic RAG over knowledge** (native mode): the model gets builtin tools:
  - `list_knowledge_bases`, `search_knowledge_bases`, `query_knowledge_bases`, `search_knowledge_files`, `grep_knowledge_files`, `query_knowledge_files` (vector search, `count=5`), `view_knowledge_file`, `view_file`, plus chat-file tools (`list/query/grep_chat_files`).
  - Which ones are offered depends on whether the model has attached knowledge (`utils/tools.py:744-786`).
  - Opt-in `ENABLE_KB_EXEC` adds `kb_exec`, a shell-like virtual filesystem over the KB: `ls`, `tree`, `cat -n`, `sed -n`, `grep -i/-l/-c`… (`tools/knowledge_fs.py:1171`). This is Claude-Code-style document exploration.

### 2.3 Other agentic features
- **Planning/todo tool:** `create_tasks` and `update_task` (`tools/builtin.py:4095-4190`). They are injected by default on saved chats (`utils/tools.py:897-900`), and the list renders as a task list under the reply (`ResponseMessage/TaskList.svelte`, event `chat:message:tasks`).
  - Docstring: *"Create a visible task checklist for multi-step work so progress can be shown in chat."*
- **Subagents:** `delegate_task(task, context, file_ids, background, model_id)` (`tools/builtin.py:1774`, `utils/subagents.py`). Recursion is blocked: *"sub-agents cannot delegate recursively"*. Since 0.13.0 a delegation can target a different model.
  - Gated by `ENABLE_SUBAGENTS`, default False (`config.py:2082`).
  - Since 0.13.0 the limits default to **unlimited**. Before, they were 20 concurrent, 20 background, 30 tool loops each, and 30,000 output chars.
  - Verbatim subagent prompt (`subagents.py:25`): *"You are a sub-agent working on a specific task assigned by the lead agent. … Focus exclusively on your assigned task… When done, end with a clear summary: What you did / What files you changed / Any issues or open questions."*
- **Code interpreter:**
  - Native: an `execute_code` builtin. The engine is Pyodide in the browser or Jupyter.
  - Legacy: the XML-tag prompt `DEFAULT_CODE_INTERPRETER_PROMPT` (`config.py:448`): *"…If results are unclear or unexpected, refine the code and re-execute. Iterate until you deliver meaningful insights."*
- **Open Terminal:** a terminal/computer-use/browser-use integration (0.13.0 tabbed workspace).
- **Other builtins:** memory, notes, chats search, channels, calendar, automations, a `timer` (wake-up), `ask_user`, `create_tool` and `create_skill`.
- **Tool search:** schemas over a threshold are deferred. They are listed as `<available_tools>` in the system prompt and used through `search_tools` + `call_tool` (`utils/tool_search.py`, default 5 results, max 20).
- **No "deep research" mode in code.** Agentic search is the closest equivalent.

### 2.4 Reasoning across rounds
- **Inbound:** `<think>`-style tags are parsed from streamed content. `DEFAULT_REASONING_TAGS` covers `<think>`, `<thinking>`, `<reason>`, `<reasoning>`, `<thought>`, `<|begin_of_thought|>`, `◁think▷` (`middleware.py:280-289`). `reasoning_content` and `reasoning_details` deltas are captured as `reasoning` output items.
- **Replay inside the tool loop:** `convert_output_to_messages(..., reasoning_format=get_reasoning_format(model))` (`utils/misc.py:351-570`, `middleware.py:1923-1937`):
  - Ollama gets a `thinking` field.
  - llama.cpp gets `reasoning_content`.
  - **Every other provider gets `None`, so reasoning text is dropped** ("safe default for strict providers").
  - The exception is opaque `reasoning_details` (OpenRouter-style, including `anthropic-claude-v1` blocks with a signature), which are replayed. They are stripped when the model changes (`middleware.py:2229-2233`).
- **OpenAI Responses-API connections:** stored output items, including `reasoning` items with `encrypted_content` if present, are replayed (`routers/openai.py:1166-1171`).
  - **[inferred]** I found no `include: ['reasoning.encrypted_content']` request. Unless the upstream returns it, reasoning continuity relies on opt-in `ENABLE_RESPONSES_API_STATEFUL` (`previous_response_id`).
- **[inferred] Consequence:** for Anthropic, Gemini or OpenAI-compatible connections that are not OpenRouter, interleaved thinking is **not** carried across tool rounds the way LibreChat carries it. Anthropic thinking signatures survive only via `reasoning_details`.
- `utils/anthropic.py` is mainly the *inbound* Anthropic-compatible API (Messages ↔ Chat Completions). It does keep signed thinking blocks.

### 2.5 Context management
- **Context compaction is off by default** (`ENABLE_CONTEXT_COMPACTION=False`). Threshold 80,000 tokens, retention 40% (bounded 10-50%) (`config.py:2244-2259`).
- Since 0.12.x it also runs **between tool rounds** in native mode, based on provider-reported usage. It keeps each tool call with its result, and emits an `open_webui:context_compaction` output item that renders as "Context compacted".
- Prompt (`utils/context_compaction.py:26`), excerpt: *"Summarize the conversation history that will be compacted out of the active chat context. Preserve key decisions, user preferences, and constraints. Preserve files, artifacts, tool results, and code changes that matter going forward. Preserve the current task state, unresolved questions, and next steps…"* The summary is inserted as a `[CONVERSATION SUMMARY]` system message.

### 2.6 UI streaming
- The server pushes Socket.IO events. From `Chat.svelte`:
  - `status` (`{action, description, done}`, e.g. "Searching the web", "Searched {{count}} sites", `web_search_queries_generated` with the queries).
  - `chat:completion` / `response:completion` (Responses-format output items: `function_call`, `function_call_output`, `reasoning`, `message`).
  - `source` / `citation`.
  - `chat:message:tasks`, `context_compaction`, `confirmation` (approval), `request:user_input`, `files`, `embeds` (MCP Apps), `code_execution`.
- Components:
  - `Messages/Markdown/ConsecutiveDetailsGroup.svelte` groups consecutive reasoning and tool-call `<details>` into one collapsible block, with a spinner, success/fail icons, duration and arguments.
  - `ResponseMessage/StatusHistory.svelte`, `TaskList.svelte`, `WebSearchResults.svelte`, `SubagentResultRow.svelte`, `ContextCompactionLabel.svelte`, `MCPApp.svelte`.
- **No LLM-generated activity labels.** Labels are static or come from tool names. **[inferred]**

### 2.7 System prompts
- **Native mode injects no agentic guidance.** Tool descriptions come from Python docstrings. Only knowledge attachments (`<attached_knowledge>`), memories, the tool-search manifest and an optional terminal `AGENTS.md` are added.
- The official docs recommend "frontier models with strong reasoning (GPT-5, Claude 4.5+)" for agentic search.

### 2.8 Assessment
**Does well**
- Native-by-default since 0.10.0, with an effectively unbounded loop (1024).
- Rich builtin toolset: search/fetch split like ChatGPT, agentic KB tools including a grep/cat filesystem, task list, subagents with model choice, tool search, terminal/computer use.
- Compaction between tool rounds; approvals and `ask_user` with persisted pause/resume.

**Does badly / limitations**
- **Sequential tool execution** within a round; only `delegate_task` runs in parallel.
- **Reasoning dropped between rounds** for most providers, so interleaved-thinking models lose their chain of thought after every tool call. **[partly inferred]**
- No budget awareness, no wrap-up nudge, and no forced final answer. At the cap the user just gets "Tool-call limit reached".
- Its history includes silent stops at 30 calls, which was the main user complaint (#24915).
- **Native mode needs streaming + `chat_id` + message id**, and builtins also need a `session_id`. API callers easily fall back to no-loop behaviour.
- Legacy mode is one round with a JSON-emitting task model and is weak by design.
- Many features are opt-in or default-off: compaction, subagents, `KB_EXEC`, hybrid search, reranker.
- Web defaults are thin: 3 results, snippet-only search.

---

## 3. Side-by-side numbers

| | LibreChat 4.2.1 SDK | Open WebUI 0.13.0 | iHub chat (for reference) |
|---|---|---|---|
| Loop | LangGraph agent↔tools graph | `while tool_calls` in `middleware.py` | `AgentLoop.js` |
| Default cap | recursionLimit 50 supersteps ≈ 24 tool rounds (docs say 25) | 1024 rounds (was 10 → 30 → 256) | `CHAT_MAX_TOOL_ROUNDS = 25` (`server/services/chat/ChatService.js:90`) |
| Stop | no tool_calls → END | no tool_calls → exit | — |
| Near-limit behaviour | countdown nudge at ≤3 rounds left; turn saved as "unfinished" + Keep going / Answer now buttons | error "Tool-call limit reached" | (iHub has a forced final call per `AgentLoop.js:309,436`) |
| Parallel tools | yes, `Promise.all` + eager start while streaming | no (sequential), except `delegate_task` | segment planner exists, but chat sets `parallel: false` (`ChatService.js:874`) |
| Reasoning replay | native blocks: Anthropic signatures, OpenAI encrypted reasoning, Gemini thought signatures | dropped except Ollama/llama.cpp/`reasoning_details`/Responses items | — |
| Planning tool | none | `create_tasks` / `update_task` (default on) | — |
| Subagents | `subagent` tool, 25 turns ×3 | `delegate_task` (opt-in, now unlimited) | — |
| Web search | search → scrape → chunk 150/50 → rerank → top 5; **"Use ONCE per reply"** | Legacy: query generation (1-3 queries) → RAG; Native: `search_web` (snippets, 3) + `fetch_url` | — |
| Compaction | masking at 80%, fading tiers, opt-in LLM checkpoint | opt-in, 80k threshold, also between tool rounds | — |
| UI | intent labels streamed first, LLM activity headers, reasoning titles | status events, grouped details, task list | — |

---

## 4. Lessons for a platform that wants Claude/ChatGPT-level multi-step behaviour

1. **The loop itself is trivial; behaviour comes from the edges.** Both projects stop on "no tool calls". What separates them is budget handling, prompt/tool-description guidance, reasoning continuity and the UI. iHub already has a single loop, so effort should go into those edges.
2. **Make the budget generous, visible to the model and recoverable.**
   - LibreChat's countdown (`stepBudget.ts`) is cheap and good. It nudges only in the last ~3 rounds, counts rounds rather than calls, and injects the nudge ephemerally right before the model call without persisting it.
   - Pair it with a graceful end-of-budget path: either a forced tool-less final call (iHub already does this) or LibreChat's "unfinished" turn with *Keep going / Answer now*. Never show a bare error (Open WebUI) and never stop silently (Open WebUI before 0.9.6).
   - For research tasks, 25 rounds is on the low side. Open WebUI moved to 1024, and Claude/ChatGPT research runs commonly use 30-100+ tool calls **[inferred]**. Prefer a token/wall-clock budget plus a round cap of about 50-100.
3. **Remove anti-iteration wording from tool descriptions.** LibreChat's "Use ONCE per reply" is a cautionary example. Tool descriptions should instead encourage search → read → refine, in the spirit of Open WebUI's `search_web` (snippets) + `fetch_url` (full page) split.
4. **Carry reasoning across tool calls in native provider form.** That means Anthropic `thinking` + `signature`, OpenAI Responses `reasoning` items with `include: ['reasoning.encrypted_content']` (one id per ciphertext), and Gemini `thoughtSignature` per function call. Dropping reasoning between rounds, as Open WebUI does for most providers, measurably hurts multi-step quality on interleaved-thinking models **[inferred from provider docs and the Open WebUI 0.7.0 note "models that support interleaved thinking now get more refined results from multi-step workflows"]**.
5. **Run independent tool calls in parallel**, and consider starting a tool as soon as its arguments are complete during streaming (LibreChat eager execution). Sequential execution (Open WebUI) makes long runs slow and pushes models toward fewer, broader calls.
6. **Ship an explicit planning tool and show it.** Open WebUI's `create_tasks`/`update_task` with a task-list UI mirrors Claude's TodoWrite and ChatGPT's plan display. LibreChat has none. Plus a short default system prompt for multi-step tasks: when to plan, when to keep going, how to converge, and to state what remains unresolved. Neither project ships one, which leaves quality up to the admin.
7. **Treat context as a budget, not a cliff.**
   - Mask consumed tool outputs first (LibreChat at 80%).
   - Keep historical truncations byte-stable so the prompt cache survives.
   - Compact *between tool rounds*, not only between turns (both projects now do).
   - Write the checkpoint prompt in the user's voice ("Hold on, before you continue…") so the model produces a summary instead of carrying on with the task.
8. **Progress UX matters for perceived capability.**
   - Stream a model-authored `intent` as the first tool argument, so a live label appears before the call finishes.
   - Have a cheap side model write past-tense group headers for collapsed activity blocks (LibreChat's prompt is modelled on claude.ai).
   - Show the task list, citations of pages actually read, and a "context compacted" marker.
   - Per iHub's architecture rule, those labels should be decided on the server and sent as event fields.
9. **Subagents** with isolated context and a "the description is the ONLY information it receives" contract (LibreChat), returning only a final summary (Open WebUI's prompt), keep the lead agent's context clean for long research. Bound them by default; Open WebUI's switch to "unlimited" is risky for enterprise **[opinion]**.
10. **Agentic document access beats one-shot RAG for enterprise.** Open WebUI's knowledge tools (list/search/grep/view, `kb_exec` with `ls/cat/sed/grep`) let the model explore a corpus the way Claude Code explores a repo. LibreChat's single semantic `file_search` cannot do that. For an enterprise search vendor (iFinder) this is the most relevant capability to match.
11. **Steering and HITL.** Mid-run steer/queue (LibreChat), `ask_user` with durable pause/resume, and approvals (both) are now table stakes for long autonomous runs.

### Sources (web)
- Open WebUI server-side tool calling reference: https://docs.openwebui.com/reference/server-side-tool-calling
- Open WebUI agentic search docs: https://docs.openwebui.com/features/chat-conversations/web-search/agentic-search
- Open WebUI discussion #24915 (abrupt stops with many tool calls): https://github.com/open-webui/open-webui/discussions/24915
- Open WebUI discussion #23645 (stops after a random tool call): https://github.com/open-webui/open-webui/discussions/23645
- Open WebUI discussion #9435 (native mode calls LLM once): https://github.com/open-webui/open-webui/discussions/9435
- LibreChat agents YAML docs (recursionLimit; states default 25): https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/agents
- LibreChat v0.8.8-rc1 changelog (steering, activity labels, intent labels, ask_user_question, subagent recursion limit): https://www.librechat.ai/changelog/v0.8.8-rc1
- LibreChat releases: https://github.com/danny-avila/LibreChat/releases
