# How ChatGPT and Gemini keep a model working until a task is done, and what a third-party platform must copy

Research date: 2026-11-07. Pages were read live: developers.openai.com and aistudio.google.com through their `.md` endpoints, plus a shallow clone of `github.com/openai/codex` at commit `8044c68` (2026-11-07). The cloned code was read, never run.

**Legend**
- **[DOC]**: stated in official vendor documentation, or in vendor source code I read. A URL is given.
- **[SEC]**: comes from a secondary source (press, newsletters, third-party docs). It could not be checked against a primary page because openai.com and help.openai.com return 403 to the fetch tools.
- **[INF]**: my own inference or recommendation.
- **[UNVERIFIED]**: from my prior knowledge; I could not re-check it this session.

**Model names.** The current OpenAI docs name GPT-6 Astra, GPT-6.1 Sol/Terra, GPT-6 Sol/Luna, the GPT-5.6 family (Sol/Terra/Luna), GPT-5.5, GPT-5.4, GPT-5.2, GPT-5.1, GPT-5, GPT-4.1, o3/o4-mini and gpt-oss. The current Gemini docs name Gemini 4 Argon, the Gemini 3.x family, Gemini 2.5, and the Deep Research agents. This file uses only names the docs themselves use.

---

## 0. Executive summary: the ten things that matter most

1. **ChatGPT-style persistence is mostly a property of the model, not of a secret prompt.** o3/o4-mini were "trained to use tools natively within their chain of thought" ([DOC] o3/o4-mini guide). OpenAI says it trained them "through reinforcement learning—teaching them not just how to use tools, but to reason about when to use them" ([SEC], o3 launch post, via search snippet). Deep Research is "an early version of OpenAI o3 that is optimized for web browsing", trained "through reinforcement learning training on these browsing tasks" ([DOC] Deep Research system card). A third party gets the same behaviour only by meeting the conditions the model was trained under. The most important of these is that **its reasoning survives across tool calls**.
2. **The biggest technical gap between "Chat Completions + tool loop" and ChatGPT is the reasoning state.** "Passing CoT exists only in the Responses API" ([DOC] GPT-5.4 guide). OpenAI's measured gains:
   - Tau-Bench Retail rose from 73.9% to 78.2% "just by switching to the Responses API and including `previous_response_id`" (GPT-5 guide).
   - SWE-bench improved about 3% (reasoning-items cookbook; migration guide).
   - Cache utilisation rose from 40% to 80%.
3. **On the newest OpenAI models, tool calling through Chat Completions no longer works at all.** "Chat Completions does not support function calling with GPT-6 Astra or GPT-6.1 Sol" ([DOC] reasoning guide). "GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra support Chat Completions, but tool calling requires Responses. GPT-6 Sol and GPT-6 Luna support function calling in Chat Completions only with `reasoning_effort: "none"`" ([DOC] GPT-6 guide). OpenAI's own Codex CLI removed its Chat Completions wire API entirely, even for Ollama and LM Studio ([DOC] Codex source).
4. **Replaying history wrongly silently destroys the reasoning.**
   - Send back every output item in its original order, append-only. "If you edit, shorten, or insert a message in that prefix, the API drops the affected reasoning" ([DOC] Preserved reasoning).
   - Keep the assistant `phase` (`commentary` / `final_answer`). "Missing or dropped `phase` can cause preambles to be treated as final answers", which shows up as **early stopping** ([DOC] reasoning guide, GPT-5.4/5.5 guides).
5. **Reasoning effort defaults are traps.** GPT-5.2 and GPT-5.4 default to `none`: "It is the default setting for both models" ([DOC] GPT-5.4 guide). GPT-5.5 and later default to `medium`. A platform that does not set the effort gets a non-reasoning agent on 5.2/5.4.
6. **The loop itself is simple and essentially uncapped.**
   - Codex re-samples while the model emits tool calls and stops when a response has no tool call and no queued input. I found no fixed turn cap ([DOC]/[INF] from source).
   - The Agents SDK default is `max_turns = 10`, which raises `MaxTurnsExceeded` ([DOC]). That is far too low for research tasks: Manus averages "around 50 tool calls" per task ([SEC] Manus blog), and Gemini Deep Research uses about 80–160 searches ([DOC]).
7. **Prompt contracts that OpenAI documents, verbatim:**
   - persistence ("keep going until the user's query is completely resolved"; GPT-4.1, GPT-5);
   - tool use ("do NOT guess or make up an answer");
   - planning (GPT-4.1, +4%), but **not** for reasoning models ("Asking a reasoning model to reason more may actually hurt");
   - tool preambles / user updates;
   - `<tool_persistence_rules>`, `<completeness_contract>`, `<empty_result_recovery>`, `<verification_loop>`, `<research_mode>` (GPT-5.4);
   - outcome-first goals with explicit **stop rules** and **retrieval budgets** (GPT-5.5/5.6).
   The three GPT-4.1 reminders alone gave "close to 20%" on SWE-bench Verified.
8. **Planning state lives in a tool.** Codex has an `update_plan` todo tool, and OpenAI's GPT-5.1 guide gives a `<plan_tool_usage>` spec with an end-of-turn invariant: "zero in_progress and zero pending". Manus keeps rewriting `todo.md` so the goal stays "recited" at the end of the context ([SEC]). Codex "Goals" add an outer continuation loop with a requirement-by-requirement **completion audit** and a "blocked after 3 consecutive turns" rule ([DOC] Codex source).
9. **Gemini has the same requirement under a different name.** It uses **thought signatures**. "When using Gemini 4 and Gemini 3 models, you must pass back thought signatures during function calling, otherwise you will get a validation error (4xx)". Gemini now also calls `generateContent` "legacy" and makes the stateful **Interactions API** the default ([DOC]). Gemini Deep Research is reachable only through the Interactions API with `background=true` and `store=true`.
10. **Open-weight models on vLLM need the reasoning passed back as well.** gpt-oss: "If the last message by the assistant was a tool call of any type, the analysis messages until the previous `final` message should be preserved" ([DOC] OpenAI gpt-oss cookbook). vLLM "interleaved thinking" needs the client to append `reasoning` to the assistant tool-call message ([DOC] vLLM docs).

---

## 1. OpenAI reasoning models with tools: Responses API vs Chat Completions

### 1.1 Agentic tool use inside the chain of thought
- [DOC] "These models are trained to use tools natively within their chain of thought (CoT) which unlocks improved reasoning capabilities around when and how to use tools." Source: o3/o4-mini Function Calling Guide, https://developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide.md
- [DOC] "o3/o4-mini are both trained with its internal reasoning persisted between tool calls within a single turn. Persisting these reasoning items between tool calls during inference will therefore lead to higher intelligence and performance in the form of better decision in when and how a tool gets called." (same guide)
- [SEC] o3 launch post (snippet via search; the page returns 403 to the fetcher): "For the first time, our reasoning models can agentically use and combine every tool within ChatGPT." OpenAI "trained both models to use tools through reinforcement learning—teaching them not just how to use tools, but to reason about when to use them." https://openai.com/index/introducing-o3-and-o4-mini/ (the page now notes o3/o4-mini are deprecated in the API).
- [DOC] Interleaved thinking: "Our reasoning models like `gpt-5.5` and `gpt-5.4` support interleaved thinking, where the model is able to generate visible output tokens before and in between thinking, and is able to think in between tool calls." https://developers.openai.com/api/docs/guides/reasoning.md

### 1.2 Why reasoning items must be passed back, with OpenAI's numbers
Source: "Better performance from reasoning models using the Responses API" (archived cookbook), https://developers.openai.com/cookbook/examples/responses_api/reasoning_items.md
- [DOC] "In typical multi-turn conversations, you don't need to include reasoning items or tokens... However, things change when tool use is involved. If a turn includes a function call (which may require an extra round trip outside the API), you do need to include the reasoning items—either via `previous_response_id` or by explicitly adding the reasoning item to `input`."
- [DOC] "On a more rigorous benchmark like SWE-bench, including reasoning items led to about a **3% improvement** for the same prompt and setup."
- [DOC] "switching from the Completions API to the Responses API boosted cache utilization from 40% to 80%." Cached o4-mini input was "75% cheaper".
- [DOC] GPT-5 guide: "we observed Tau-Bench Retail score increases from 73.9% to 78.2% just by switching to the Responses API and including `previous_response_id` to pass back previous reasoning items into subsequent requests. This allows the model to refer to its previous reasoning traces, conserving CoT tokens and eliminating the need to reconstruct a plan from scratch after each tool call". https://developers.openai.com/api/docs/guides/latest-model/gpt-5.md
- [DOC] GPT-5.4 guide: "The biggest difference, and main reason to migrate from Chat Completions to the Responses API for GPT-5.4, is support for passing chain of thought (CoT) between turns... Passing CoT exists only in the Responses API, and we've seen improved intelligence, fewer generated reasoning tokens, higher cache hit rates, and lower latency". https://developers.openai.com/api/docs/guides/latest-model/gpt-5.4.md
- [DOC] Migration guide, "Responses benefits": "Our internal evals reveal a 3% improvement in SWE-bench"; "An agentic loop by default: The model can call multiple tools, like `web_search`, `image_generation`, `file_search`, `code_interpreter`, remote MCP servers, as well as your own custom functions, within the span of one API request"; "40% to 80% improvement" in cache utilisation. https://developers.openai.com/api/docs/guides/migrate-to-responses.md
- [DOC] Function-calling guide: "for reasoning models like GPT-5 or o4-mini, any reasoning items returned in model responses with tool calls must also be passed back with tool call outputs." https://developers.openai.com/api/docs/guides/function-calling.md

### 1.3 Chat Completions restrictions on current models (critical for any platform still on `/chat/completions`)
- [DOC] "Use the Responses API for function calling. Chat Completions does not support function calling with GPT-6 Astra or GPT-6.1 Sol." (reasoning guide)
- [DOC] GPT-6 migration: "**Tool calling:** Use the Responses API. GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra support Chat Completions, but tool calling requires Responses. GPT-6 Sol and GPT-6 Luna support function calling in Chat Completions only with `reasoning_effort: "none"`. Use Responses for reasoning with tools." https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md
- [DOC] GPT-5.5: "Use the Responses API for any reasoning, tool-calling, or multi-turn use case." https://developers.openai.com/api/docs/guides/latest-model/gpt-5.5.md
- [DOC] Reasoning guide header: "Reasoning models work better with the Responses API. While the Chat Completions API is still supported, you'll get improved model intelligence and performance by using Responses."
- [DOC] Strict mode default differs: "Responses requests will attempt to normalize your schema into strict mode when possible... Chat Completions requests remain non-strict by default." (function-calling guide)
- [DOC] Web search in Chat Completions is limited to a special search model (`gpt-5-search-api`), which does not support "domain filters, complete source lists, live-access control, and returned-token budget control". https://developers.openai.com/api/docs/guides/tools-web-search.md

### 1.4 State mechanisms: stateful vs stateless
- **Stateful.** `store: true` plus `previous_response_id`, or the Conversations API (`conversation`) [DOC]. "If you use `previous_response_id` for multi-turn conversations, the model will automatically have access to all previously produced reasoning items." (cookbook)
- **Stateless / ZDR.** [DOC] Current reasoning guide: "When you create a response in stateless mode, reasoning items in the response's `output` array include an `encrypted_content` property by default. Stateless mode applies when `store` is `false` or when your organization uses Zero Data Retention (ZDR). The API still accepts the legacy `reasoning.encrypted_content` value in `include` for compatibility, but doesn't require it."
  - The older cookbook required `include=["reasoning.encrypted_content"]`.
  - [DOC] "When a request includes `encrypted_content`, it is decrypted in memory, used for generating the next response, and then securely discarded. Any new reasoning tokens are immediately encrypted and returned to you". (migration guide)
- **Manual replay.** [DOC] "If you manage conversation history yourself, include the original input and all output items from each response in the input of the next request. Keep those items in their original order and append new items." (reasoning guide, "Keeping reasoning items in context")
- **One strategy per conversation.** [DOC] Agents SDK docs: "pick one strategy per conversation. Mixing local replay with server-managed state can duplicate context". https://developers.openai.com/api/docs/guides/agents/running-agents.md

### 1.5 Preserved reasoning: editing history destroys it
Source: https://developers.openai.com/api/docs/guides/preserved-reasoning.md
- [DOC] "For newer frontier models, the API checks the conversation history before each reasoning item you send back. This history is the item's _prefix_. If you edit, shorten, or insert a message in that prefix, the API drops the affected reasoning."
- [DOC] Example: an app replaces earlier tool rows with a subtotal, and "the API drops reasoning that depended on the original rows, even if you send the reasoning item back unchanged."
- [DOC] Migration table (verbatim cells, abridged):
  - Older turns during compaction: "Use OpenAI compaction and continue from the returned context."
  - Developer instructions: "Append a developer message when the instruction takes effect."
  - The tool list when switching modes: "Keep known tool definitions stable. Restrict the next request with `tool_choice` of type `allowed_tools`. To introduce new tools, append an `additional_tools` input item with role `developer`..."
  - A tool result the model has already seen: "Filter the result before sending `function_call_output` the first time. If the data changes, append a correction or return it from a new tool call."
- [DOC] Model families: "Persisted reasoning can be reused only within the same model family... reasoning does not carry between the GPT-5.6 and GPT-5.5 families." (reasoning guide)

### 1.6 `reasoning.context` (persisted reasoning across user turns)
- [DOC] Values are `auto`, `current_turn` and `all_turns`. "The GPT-5.6 model family supports `all_turns` and uses it by default. Earlier models default to `current_turn`. GPT-6.1 Sol also supports `all_turns`." "For models released before GPT-5.6, the default behavior in a multi-step conversation is to carry over input and output tokens from each step without rendering reasoning from earlier turns into the next sample."
- [DOC] Caveat from the GPT-5.6 prompting guide: "Do not treat persisted reasoning as an always-on optimization: stale reasoning can add tokens, increase latency, and anchor the model to an outdated approach." https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md

### 1.7 The `phase` parameter, an early-stopping fix
- [DOC] "For long-running or tool-heavy flows with GPT-5.5 and GPT-5.4 in the Responses API, use the assistant message `phase` field to avoid early stopping and other misbehavior... Use `phase: "commentary"` for intermediate assistant updates, such as preambles before tool calls, and `phase: "final_answer"` for the completed answer. Don't add `phase` to user messages." "Missing or dropped `phase` can cause preambles to be treated as final answers in those workflows." (reasoning guide; GPT-5.4 guide says "we highly recommend using it")
- [DOC] Conversation-state guide: "When troubleshooting cases where GPT-5.5 treats an intermediate update as the final answer, verify your integration preserves the assistant message `phase` field correctly."
- [INF] A platform that renders "preamble then tool call" and replays only text plus tool calls will see the model stop after its first preamble on later steps.

### 1.8 Reasoning controls
- [DOC] `reasoning.effort` values are model-dependent: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. OpenAI's effort table (reasoning guide):
  - `low`: "Ideal for use cases requiring tool-use, planning, search, or multi-step decision making, while optimizing for speed and cost."
  - `medium`: "Default configuration for most workloads... agentic coding, research, ... delegating long-horizon work."
  - `high`: "Recommended for complex workflows and agentic tasks."
  - `xhigh`: "Deep research, asynchronous workflows and agentic tasks that require long runs."
- [DOC] Defaults:
  - GPT-5: `medium`.
  - GPT-5.2 and GPT-5.4: "support `none` as their lowest reasoning effort... It is the default setting for both models."
  - GPT-5.5, GPT-5.6, GPT-6.1 Sol, GPT-6 Sol/Luna: `medium`.
  - GPT-6 Astra and GPT-6.1 Sol reject `none` with HTTP 400. GPT-6.1 Sol "does not support `none` or `minimal`."
  - On migration: "If your existing request uses `minimal`, start with `low`."
- [DOC] Too much effort can hurt: "Higher reasoning effort isn't automatically better. If the task has conflicting instructions, weak stopping criteria, or open-ended tool access, higher effort can lead to overthinking, unnecessary searching, or output quality regressions." (GPT-5.5 guide). GPT-5.6: "Before increasing reasoning effort, check whether the prompt is missing a success criterion, dependency rule, tool-routing rule, or verification loop."
- [DOC] `reasoning.mode: "pro"` (GPT-5.6 / GPT-6) does more model work for one final answer.
- [DOC] A `configuration_update` input item changes effort mid-conversation "while leaving the request-level `reasoning.effort` unchanged. This preserves the original prompt prefix for prompt caching." (GPT-6 and later)
- [DOC] Verbosity: `text.verbosity` is `low`, `medium` (default) or `high`. "Treat final answer length as separate from reasoning quality" (GPT-5.5).
- [DOC] Token room: "OpenAI recommends reserving at least 25,000 tokens for reasoning and outputs when you start experimenting with these models." Hitting `max_output_tokens` returns `status: incomplete`, possibly "before any visible output tokens are produced".
- [DOC] Sampling parameters: "When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`." (GPT-6 guide)

### 1.9 Tool-call controls
Source: function-calling guide unless noted.
- [DOC] `tool_choice`: `auto` (default; "Call zero, one, or multiple functions"), `required`, a forced specific function, `allowed_tools` (restricts the callable subset, cache-friendly) and `none`.
- [DOC] `parallel_tool_calls`: "The model may choose to call multiple functions in a single turn. You can prevent this by setting `parallel_tool_calls` to `false`".
- [DOC] Strict mode: "We recommend always enabling strict mode."
- [DOC] `max_tool_calls` (Responses create reference): "The maximum number of total calls to built-in tools that can be processed in a response... Any further attempts to call a tool by the model will be ignored." It applies to **built-in** tools only, and is not supported with Multi-agent. https://developers.openai.com/api/reference/resources/responses/methods/create.md
- [DOC] How many functions: "Aim for fewer than 20 functions available at the start of a turn at any one time, though this is just a soft suggestion." "Use tool search to defer large or infrequently used parts of your tool surface". o3/o4-mini FAQ: "fewer than ~100 tools and fewer than ~20 arguments per tool is considered in-distribution".
- [DOC] "Under the hood, functions are injected into the system message in a syntax the model has been trained on." GPT-4.1: "exclusively use the tools field... we observed a 2% increase in SWE-bench Verified pass rate when using API-parsed tool descriptions versus manually injecting the schemas into the system prompt."
- [DOC] Prefer flat schemas: "When in doubt we recommend you err on the side of making the arguments flat." (o3/o4 FAQ)
- [DOC] "Don't make the model fill arguments you already know." "Combine functions that are always called in sequence."

### 1.10 Tool search / deferred tools (current)
Source: https://developers.openai.com/api/docs/guides/tools-tool-search.md
- [DOC] "Tool search allows the model to dynamically search for and load tools into the model's context as needed... tool search is designed to **preserve the model's cache**. When new tools are discovered by the model, they are injected at the end of the context window." "only `gpt-5.4` and later models support `tool_search`."
- [DOC] Activation: add `{"type":"tool_search"}` and mark functions or MCP servers with `defer_loading: true`. Two modes: **hosted** tool search, and **client-executed** (`tool_search_call` → your lookup → `tool_search_output`).
- [DOC] "we recommend using namespaces or MCP servers when possible. Our models have primarily been trained to search those surfaces"; "aim to keep each namespace to fewer than 10 functions".

### 1.11 Built-in tools and other agentic features of the Responses API
Tools listed in https://developers.openai.com/api/docs/guides/tools.md: function calling, web search, remote MCP servers, skills, shell, computer use, image generation, file search, tool search, programmatic tool calling. Code interpreter has its own guide.

- **Web search.** [DOC] "For a question that needs several sources, use a reasoning model such as `gpt-6-astra`. It can refine its searches as it reads results. Use background mode for a request that might take several minutes."
  - Multi-step research → "`gpt-6-astra` with `high` or `xhigh` reasoning"; use background mode.
  - `return_token_budget: "unlimited"` for high-effort research runs that "might otherwise stop at the standard returned-token cap".
  - "The web search context window is limited to 128k".
  - "With `tool_choice: "auto"`, search is optional. Use `tool_choice: "required"`... when search must run."
- **Remote MCP.** [DOC] "the MCP tool in the Responses API defaults to requiring approvals of each MCP tool call". Prompt-injection advice: "collect the public facts in a request with only web search enabled. Pass the relevant facts into a second request with access limited to your internal CRM search tool." https://developers.openai.com/api/docs/guides/tools-connectors-mcp.md
- **Programmatic Tool Calling** (GPT-5.6+). [DOC] "lets a model write and run JavaScript that coordinates its tools... in a fresh, isolated V8 runtime". Use it "for bounded workflows where code can process several tool results or large intermediate outputs and return a much smaller structured result"; "Multiple, parallel, or dependent calls alone do not justify Programmatic Tool Calling."
- **Async tool calling** (GPT-6). [DOC] "Set `async: true`... to let the model continue working after issuing that call".
- **Multi-agent** (beta; GPT-6.1 Sol, GPT-5.6). [DOC] "lets a model spin up and coordinate subagents in parallel". Benefits named: "Parallel execution", "Focused context", "Model-directed coordination".
- **Mid-turn steering** (GPT-6, WebSocket only). [DOC] Lets users send corrections while the model works.
- **WebSocket mode.** [DOC] "For rollouts with 20+ tool calls, we have seen up to roughly 40% faster end-to-end execution." It is compatible with ZDR and `store=false`.
- **Compaction.** [DOC] Server-side: `context_management` with `compact_threshold`. "The returned compaction item carries forward key prior state and reasoning into the next run using fewer tokens. It is opaque". A standalone `/responses/compact` endpoint also exists. https://developers.openai.com/api/docs/guides/compaction.md
- **Background mode.** [DOC] "Agents like Codex and Deep Research show that reasoning models can take several minutes to solve complex problems. Background mode enables you to execute long-running tasks... reliably, without having to worry about timeouts". For ZDR, data is kept "for roughly 10 minutes" to allow polling. https://developers.openai.com/api/docs/guides/background.md
- **Agents API.** [DOC] "gives your application access to the Codex harness through an OpenAI-managed API. OpenAI manages sessions, orchestration, context compaction, and recovery while your application provides tools". https://developers.openai.com/api/docs/guides/agents-api/overview.md

---

## 2. OpenAI prompting guides for agentic use (verbatim key passages)

### 2.1 GPT-4.1: the three agentic reminders
Source: https://developers.openai.com/api/docs/guides/latest-model/gpt-4.1.md

[DOC] "In order to fully utilize the agentic capabilities of GPT-4.1, we recommend including three key types of reminders in all agent prompts."

1. **Persistence**: "this ensures the model understands it is entering a multi-message turn, and prevents it from prematurely yielding control back to the user":
   > You are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. Only terminate your turn when you are sure that the problem is solved.
2. **Tool-calling**: "reduces its likelihood of hallucinating or guessing an answer":
   > If you are not sure about file content or codebase structure pertaining to the user's request, use your tools to read files and gather the relevant information: do NOT guess or make up an answer.
3. **Planning [optional]**:
   > You MUST plan extensively before each function call, and reflect extensively on the outcomes of the previous function calls. DO NOT do this entire process by making function calls only, as this can impair your ability to solve the problem and think insightfully.

Numbers [DOC]:
- The three reminders "increased our internal SWE-bench Verified score by close to 20%". They "transform the model from a chatbot-like state into a much more 'eager' agent."
- Explicit planning: "increased the pass rate by 4%."
- API-parsed tools: +2% versus tool schemas injected into the prompt.

The SWE-bench sample prompt also contains: "when you say you are going to make a tool call, make sure you ACTUALLY make the tool call, instead of ending your turn."

### 2.2 o3/o4-mini Function Calling Guide (reasoning models)
Source: https://developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide.md
- [DOC] **Do not ask a reasoning model to plan in text:** "they do not have to be explicitly prompted to plan and reason between tool calls... Asking a reasoning model to reason more may actually hurt the performance."
- [DOC] Against hallucinated "I'll do it later" behaviour: `Do NOT promise to call a function later. If a function call is required, emit it now; otherwise respond normally.`
- [DOC] Laziness mitigations:
  - "Start a new conversation for unrelated topics".
  - "Discard irrelevant past tool calls/outputs when the list gets too long, and summarize them as context in the user message".
- [DOC] Tool-routing clarity: "Explicitly define tool usage boundaries in the developer prompt" and "Clarify when internal knowledge is not sufficient".

### 2.3 GPT-5: eagerness, persistence, tool preambles
Sources: https://developers.openai.com/api/docs/guides/latest-model/gpt-5.md and https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide.md
- [DOC] Baseline: "GPT-5 is, by default, thorough and comprehensive when trying to gather context in an agentic environment".
- **Less eagerness** (context-gathering budget):
  ```
  <context_gathering>
  Goal: Get enough context fast. Parallelize discovery and stop as soon as you can act.
  ...
  Early stop criteria:
  - You can name exact content to change.
  - Top hits converge (~70%) on one area/path.
  Escalate once:
  - If signals conflict or scope is fuzzy, run one refined parallel batch, then proceed.
  ...
  Loop:
  - Batch search → minimal plan → complete task.
  - Search again only if validation fails or new unknowns appear. Prefer acting over more searching.
  </context_gathering>
  ```
  Fixed budget variant: "Search depth: very low ... Usually, this means an absolute maximum of 2 tool calls." The guide also says to give the model "an escape hatch... like 'even if it might not be fully correct'".
- **More eagerness** (recommended together with higher `reasoning_effort`):
  ```
  <persistence>
  - You are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user.
  - Only terminate your turn when you are sure that the problem is solved.
  - Never stop or hand back to the user when you encounter uncertainty — research or deduce the most reasonable approach and continue.
  - Do not ask the human to confirm or clarify assumptions, as you can always adjust later — decide what the most reasonable assumption is, proceed with it, and document it for the user's reference after you finish acting
  </persistence>
  ```
  Also: "clearly state the stop conditions of the agentic tasks, outline safe versus unsafe actions, and define when, if ever, it's acceptable for the model to hand back to the user", with uncertainty thresholds per tool (for example, checkout low, search high).
- **Tool preambles**: "GPT-5 is trained to provide clear upfront plans and consistent progress updates via 'tool preamble' messages."
  ```
  <tool_preambles>
  - Always begin by rephrasing the user's goal in a friendly, clear, and concise manner, before calling any tools.
  - Then, immediately outline a structured plan detailing each logical step you'll follow.
  - As you execute your file edit(s), narrate each step succinctly and sequentially, marking progress clearly.
  - Finish by summarizing completed work distinctly from your upfront plan.
  </tool_preambles>
  ```
- [DOC] "we observe peak performance when distinct, separable tasks are broken up across multiple agent turns, with one turn for each task."
- [DOC] Contradictions are costly: "poorly-constructed prompts containing contradictory or vague instructions can be more damaging to GPT-5 than to other models, as it expends reasoning tokens searching for a way to reconcile the contradictions" (cookbook).

### 2.4 GPT-5.1: user updates, solution persistence, plan tool
Source: https://developers.openai.com/api/docs/guides/latest-model/gpt-5.1.md
- [DOC] `<user_updates_spec>` (excerpt): "Send short updates (1–2 sentences) every few tool calls when there are meaningful changes. Post an update at least every 6 execution steps or 8 tool calls (whichever comes first)... Before the first tool call, give a quick plan with goal, constraints, next steps... Always state at least one concrete outcome since the prior update... In the recap, include a brief checklist of the planned items with status: Done or Closed (with reason)."
- [DOC] "On long agentic tasks, we've noticed that GPT-5.1 may end prematurely without reaching a complete solution, but we have found this behavior is promptable":
  ```
  <solution_persistence>
  - ... proactively gather context, plan, implement, test, and refine without waiting for additional prompts at each step.
  - Persist until the task is fully handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial fixes...
  - Be extremely biased for action. ... If the user asks a question like "should we do x?" and your answer is "yes", you should also go ahead and perform the action.
  </solution_persistence>
  ```
- [DOC] With `none` reasoning, the GPT-4.1-style planning prompt helps: "You MUST plan extensively before each function call, and reflect extensively on the outcomes..."
- [DOC] **Planning tool**: "One tool we recommend implementing for long-running tasks is a planning tool." The `<plan_tool_usage>` spec includes:
  - "create and maintain a lightweight plan in the TODO/plan tool before your first code/tool action";
  - "Create 2–5 milestone/outcome items";
  - "exactly one item in_progress at a time";
  - "End-of-turn invariant: zero in_progress and zero pending; complete or explicitly cancel/defer anything remaining with a brief reason."
  - Example call: `update_plan({merge:true, todos:[{content, status, id}]})`.

### 2.5 GPT-5.2: clamp updates, tool usage rules, research-agent prompt
Source: https://developers.openai.com/api/docs/guides/latest-model/gpt-5.2.md
- [DOC] `<tool_usage_rules>`: "Prefer tools over internal knowledge whenever: You need fresh or user-specific data... Parallelize independent reads... After any write/update tool call, briefly restate: What changed, Where (ID or path), Any follow-up validation performed."
- [DOC] `<web_search_rules>`: "Research all parts of the query, resolve contradictions, and follow important second-order implications until further research is unlikely to change the answer. Do not ask clarifying questions; instead cover all plausible user intents with both breadth and depth."
- [DOC] Appendix "Example prompt for a web research agent" (excerpts):
  - "Start with multiple targeted searches. Use parallel searches when helpful. Do not ever rely on a single query."
  - "Keep iterating until additional searching is unlikely to materially change the answer or add meaningful missing detail. If evidence is thin, keep searching rather than guessing."
  - "Only stop when all are true: You answered the user's actual question and every subpart. You found concrete examples and high-value adjacent material. You found sufficient sources for core claims".
  - "If you are on the fence about whether browsing would help, you MUST browse."
- [DOC] Compaction via `/responses/compact` for "Multi-step agent flows with many tool calls".

### 2.6 GPT-5.4: the most complete set of agentic contracts
Source: https://developers.openai.com/api/docs/guides/latest-model/gpt-5.4.md
- [DOC] `<default_follow_through_policy>`: "If the user's intent is clear and the next step is reversible and low-risk, proceed without asking. Ask permission only if the next step is: (a) irreversible, (b) has external side effects..., or (c) requires missing sensitive information or a choice that would materially change the outcome."
- [DOC] "GPT-5.4 can be less reliable at tool routing early in a session, when context is still thin."
  ```
  <tool_persistence_rules>
  - Use tools whenever they materially improve correctness, completeness, or grounding.
  - Do not stop early when another tool call is likely to materially improve correctness or completeness.
  - Keep calling tools until:
    (1) the task is complete, and
    (2) verification passes (see <verification_loop>).
  - If a tool returns empty or partial results, retry with a different strategy.
  </tool_persistence_rules>
  ```
- [DOC] `<dependency_checks>`: "Do not skip prerequisite steps just because the intended final action seems obvious."
- [DOC] `<parallel_tool_calling>`: "After parallel retrieval, pause to synthesize the results before making more calls. Prefer selective parallelism".
- [DOC] "For multi-step workflows, a common failure mode is incomplete execution: the model finishes after partial coverage, misses items in a batch, or treats empty or narrow retrieval as final."
  ```
  <completeness_contract>
  - Treat the task as incomplete until all requested items are covered or explicitly marked [blocked].
  - Keep an internal checklist of required deliverables.
  - For lists, batches, or paginated results: determine expected scope when possible, track processed items or pages, confirm coverage before finalizing.
  - If any item is blocked by missing data, mark it [blocked] and state exactly what is missing.
  </completeness_contract>
  <empty_result_recovery>
  If a lookup returns empty, partial, or suspiciously narrow results:
  - do not immediately conclude that no results exist,
  - try at least one or two fallback strategies, such as: alternate query wording, broader filters, a prerequisite lookup, or an alternate source or tool,
  - Only then report that no results were found, along with what you tried.
  </empty_result_recovery>
  <verification_loop>
  Before finalizing:
  - Check correctness: does the output satisfy every requirement?
  - Check grounding: are factual claims backed by the provided context or tool outputs?
  - Check formatting: does the output match the requested schema or style?
  - Check safety and irreversibility: if the next step has external side effects, ask permission first.
  </verification_loop>
  ```
- [DOC] `<research_mode>`: "Do research in 3 passes: 1) Plan: list 3-6 sub-questions to answer. 2) Retrieve: search each sub-question and follow 1-2 second-order leads. 3) Synthesize: resolve contradictions and write the final answer with citations. Stop only when more searching is unlikely to change the conclusion."
- [DOC] `<citation_rules>` / `<grounding_rules>`: "Only cite sources retrieved in the current workflow. Never fabricate citations, URLs, IDs, or quote spans." "If a statement is an inference rather than a directly supported fact, label it as an inference."
- [DOC] Migrating research agents: "Add `<research_mode>`, Add `<citation_rules>`, Add `<empty_result_recovery>`, Increase `reasoning_effort` one notch only after prompt fixes."
- [DOC] Preambles "boost tool-calling accuracy (and overall task success) without bloating reasoning overhead. To enable preambles, add... 'Before you call a tool, explain why you are calling it.'"
- [DOC] `<user_updates_spec>`: "Only update the user when starting a new major phase or when something changes the plan... Do not narrate routine tool calls. Keep the user-facing status short; keep the work exhaustive."

### 2.7 GPT-5.5: outcome-first, stop rules, retrieval budgets
Source: https://developers.openai.com/api/docs/guides/latest-model/gpt-5.5.md
- [DOC] "Describe the expected outcome, success criteria, allowed side effects, evidence rules, and output shape. Avoid step-by-step process guidance unless the exact path matters."
- [DOC] Stop rule: "Resolve the user query in the fewest useful tool loops, but do not let loop minimization outrank correctness, accessible fallback evidence, calculations, or required citation tags for factual claims. After each result, ask: 'Can I answer the user's core request now with useful evidence and citations for the factual claims?' If yes, answer."
- [DOC] Retrieval budget: "For ordinary Q&A, start with one broad search using short, discriminative keywords. If the top results contain enough citable support for the core request, answer from those results instead of searching again. Make another retrieval call only when: [core question unanswered / required fact missing / exhaustive coverage requested / a specific artifact must be read / an important unsupported claim]... Do not search again to improve phrasing, add examples, cite nonessential details".
- [DOC] Time to first visible token: "Before any tool calls for a multi-step task, send a short user-visible update that acknowledges the request and states the first step. Keep it to one or two sentences."
- [DOC] "Put most tool-specific guidance in the tool descriptions themselves: what the tool does, when to use it, required inputs, side effects, retry safety, and common error modes."
- [DOC] "Drop the current date. The model is already aware of the current UTC date."
- [DOC] Suggested structure: Role / # Personality / # Goal / # Success criteria / # Constraints / # Output / # Stop rules.

### 2.8 GPT-5.6: leaner prompts, autonomy boundaries
Source: https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md
- [DOC] "In a sample of internal coding-agent eval runs, configurations with leaner system prompts improved evaluation scores by roughly 10–15% while reducing total tokens by 41–66% and cost by 33–67%."
- [DOC] Autonomy policy: "For requests to answer, explain, review, diagnose, or plan, inspect the relevant materials and report the result... For requests to change, build, or fix, make the requested in-scope local changes and run relevant non-destructive validation without asking first. Require confirmation for external writes, destructive actions, purchases, or a material expansion of scope." Also: "Repeating instructions such as 'ask first,' ... can cause unnecessary approval requests".
- [DOC] Tool routing: "Expose only task-relevant tools." "If a tool returns empty, partial, or suspiciously narrow results, try one or two meaningful fallbacks before concluding that no result exists."
- [DOC] Long-running: "prompt for a short visible preamble before the first tool call, then sparse outcome-based updates at major phase changes... Compact after major milestones rather than every turn."
- [DOC] Structure: Role / Personality / Goal / Success criteria / Constraints / **Tools** / Output / Stop rules.

### 2.9 GPT-6: the newest model asks more and may stop
Source: https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md
- [DOC] "GPT-6 Astra is generally better than GPT-5.6 Sol and earlier models at staying coherent during long tasks. It is also more likely to ask for clarification where earlier models would make assumptions." "This can cause it to stop when the user may expect it to make reasonable assumptions and persist."
- [DOC] Recommended prompts (excerpts):
  - "Your job is to bias towards action and carry the user's intended task to completion."
  - "When the user's prompt indicates a request for action, such as 'can you...', 'I want to...', 'help me...'... treat these as instructions to do the work and take action. Do not stop at acknowledging capability..., proposing a plan, or offering to continue. Do not settle for a partial or 'helpful enough' solution".
  - "Before asking the user clarifying questions, you should complete the work that is already authorized from context and necessary to make the proposed action concrete and reviewable."
- [DOC] Sensitivity to instructions: "It can be more sensitive to instructions contained in skills and other files... We **strongly recommend** auditing skills and other files accessible to your model".
- [DOC] Delegation: "The model may delegate less often than desired for your workflow." Prompt: "If at any point you can parallelize work by delegating tasks to another agent..., you should do so".

---

## 3. ChatGPT products

### 3.1 Deep Research (ChatGPT) and the Deep Research API
- [DOC] System card (Feb 25, 2025), https://cdn.openai.com/deep-research-system-card.pdf:
  - "The deep research model is powered by an early version of OpenAI o3 that is optimized for web browsing. Deep research leverages reasoning to search, interpret, and analyze massive amounts of text, images, and PDFs on the internet, pivoting as needed in reaction to information it encounters. It can also read files provided by the user and analyze data by writing and executing python code."
  - "The model learned the core browsing capabilities (searching, clicking, scrolling, interpreting files), how to use a python tool in a sandboxed setting..., and how to reason through and synthesize a large number of websites... through reinforcement learning training on these browsing tasks."
  - Grading: "model responses are graded against the ground truth answers or rubrics using a chain-of-thought model as a grader."
  - "Deep research in ChatGPT also uses a second, custom-prompted OpenAI o3-mini model to summarize chains of thought."
- [SEC] Runtime of 5–30 minutes; Humanity's Last Exam 26.6%; state of the art on GAIA at launch (Sequoia / IT Brief / Reddit quoting the launch post; https://inferencebysequoia.substack.com/p/how-openai-built-its-groundbreaking, https://itbrief.com.au/story/openai-reveals-how-deep-research-transforms-inquiry). Not primary-verified.
- [DOC] Clarifying questions come from a separate front model: "ChatGPT uses an intermediate model (like gpt-4.1) to help clarify your intent and gather more context... In contrast, the Deep Research API skips this clarification step." The cookbook recommends a **prompt rewriter**: "Use a prompt rewriter using another lightweight model... to expand or specify user queries before passing them to the research model." Its rewriting prompt includes "Fill in Unstated But Necessary Dimensions as Open-Ended" and "Avoid Unwarranted Assumptions". https://developers.openai.com/cookbook/examples/deep_research_api/introduction_to_deep_research_api.md (archived)
- [DOC] Deep Research API requirements (archived cookbook): models `o3-deep-research-2025-06-26` and `o4-mini-deep-research-2025-06-26` on `/responses`. "Include the required `web_search_preview` tool and optionally add `code_interpreter`." "Set the `background` parameter to `True`." MCP was supported for private data, and outputs expose `reasoning`, `web_search_call`, `code_interpreter_call` and `mcp_call` items plus URL-citation annotations.
  - [UNVERIFIED] The former Deep Research guide stated that at least one data source (web search, file search with vector stores, or an MCP server) was required. That guide now returns 404.
- [DOC] **The Deep Research API models were retired on July 23, 2026**, and both were replaced by `gpt-5.6-sol` (deprecations page). "o3-deep-research... shut down on July 23, 2026. For current research workflows, see Run longer web research." https://developers.openai.com/api/docs/models/o3-deep-research.md, https://developers.openai.com/api/docs/deprecations.md. The current recipe is a reasoning model with `web_search` at `high`/`xhigh` effort, `return_token_budget: "unlimited"` and background mode (§1.11).
- [DOC] To act as a data source for ChatGPT deep research and company knowledge, an MCP server "should implement two read-only tools: `search` and `fetch`". https://developers.openai.com/api/docs/mcp.md

### 3.2 ChatGPT agent / agent mode
All [SEC]; the primary page and system card could not be fetched.
- Launched July 17, 2025. It merges Operator's visual browsing with Deep Research's text research.
- Tools are a visual (GUI) browser, a text browser, a terminal and API access, all inside a virtual computer; the agent can switch between them within one task.
- Per the 36kr article, OpenAI says the model learned tool strategies through RL across many VMs rather than hand-coded patterns.
- It hands control back at login walls, uses a "watch mode" for sensitive sites, and refuses high-risk actions such as financial transfers.
- Sources: https://venturebeat.com/ai/openai-unveils-chatgpt-agent-that-gives-chatgpt-its-own-computer-to-autonomously-use-your-email-and-web-apps-download-and-create-files-for-you, https://www.neowin.net/news/openai-introduces-chatgpt-agent-that-can-complete-tasks-using-its-own-computer/, https://eu.36kr.com/en/p/3392437775731078
- [DOC] The API-side counterparts are the computer use tool, the shell tool and the Agents API (§1.11).

### 3.3 Codex and the open-source Codex CLI loop (source read at commit 8044c68)
Repo: https://github.com/openai/codex (`codex-rs/`)

**Transport and request** [DOC, from `codex-rs/core/src/client.rs`, around lines 1258–1310]:
```rust
let mut include = vec!["reasoning.encrypted_content".to_string()];
...
ResponsesApiRequest {
    model, input, tools,
    tool_choice: "auto".to_string(),
    parallel_tool_calls: prompt.parallel_tool_calls && !model_info.use_responses_lite,
    reasoning: Some(reasoning),
    store: false,
    stream: true,
    include,
    prompt_cache_key: self.prompt_cache_key(responses_metadata),
    ...
}
```
In other words, Codex is stateless (`store:false`), replays encrypted reasoning, streams, enables parallel tool calls and uses a prompt cache key.

**Responses only** [DOC, `codex-rs/model-provider-info/src/lib.rs`]:
- "`wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"`".
- The OSS providers (Ollama on 11434, LM Studio on 1234) are created with `WireApi::Responses`, and the LM Studio client posts to `{base_url}/responses`.

**The loop** [DOC/INF, `codex-rs/core/src/session/turn.rs` and `stream_events_utils.rs`]:
- Each sampling request streams model output. Any function or tool call is dispatched (possibly in parallel), and `needs_follow_up = true` is set.
- After sampling: `needs_follow_up = model_needs_follow_up || has_pending_input`.
  - If it is true, the loop samples again with the tool outputs appended.
  - If the context limit is reached mid-turn, it runs auto-compaction and continues.
- When `!needs_follow_up` (the model produced a message without tool calls), **stop hooks** run. If a hook blocks, a hook prompt message is injected and the loop continues; otherwise the turn ends.
- I found no `max_turns`/turn-limit constant in `core/src` outside tests [INF]. The turn ends when the model chooses to, on user interrupt, or on budget.
- Mid-turn injections: a current-time reminder, a "rollout budget" reminder (remaining tokens), and steered user input queued mid-turn.

**System prompt** [DOC, `codex-rs/models-manager/prompt.md` / `protocol/src/prompts/base_instructions/default.md`]:
- "You are a coding agent. Please keep going until the query is completely resolved, before ending your turn and yielding back to the user. Only terminate your turn when you are sure that the problem is solved. Autonomously resolve the query to the best of your ability, using the tools available to you, before coming back to the user. Do NOT guess or make up an answer."
- Preambles: "Before making tool calls, send a brief preamble to the user explaining what you're about to do... Logically group related actions... Build on prior context... Avoid adding a preamble for every trivial read".
- Planning: "You have access to an `update_plan` tool which tracks steps and progress and renders them to the user... Do not use plans for simple or single-step queries"; "There should always be exactly one `in_progress` step until everything is done."
- Progress updates: "provide progress updates back to the user at reasonable intervals... (no more than 8-10 words long)".
- `core/gpt_5_2_prompt.md`, "Autonomy and Persistence": "Persist until the task is fully handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial fixes".

**Compaction prompt** [DOC, `codex-rs/prompts/templates/compact/prompt.md`]:
> You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task. Include: Current progress and key decisions made; Important context, constraints, or user preferences; What remains to be done (clear next steps); Any critical data, examples, or references needed to continue.

**Goals** (outer persistence loop) [DOC, cookbook https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex.md, and `codex-rs/ext/goal/templates/goals/continuation.md`]:
- "A normal prompt says: do this next thing. A Goal says: keep working until this outcome is true." "Prompt: ask -> work -> result -> wait. Goal: work -> check -> continue or complete." Continuation happens "only when the thread is idle and the Goal is active and within budget."
- The continuation prompt injected each automatic turn (excerpts):
  - "Keep the full objective intact. If it cannot be finished now, make concrete progress toward the real requested end state, leave the goal active, and do not redefine success around a smaller or easier task."
  - Token budget: used / remaining.
  - "No-progress check: Classify the previous goal turn as progress, a verified wait, or no progress... status restatements and unexecuted plans are no progress."
  - "Completion audit: Before deciding that the goal is achieved, treat completion as unproven... For every explicit requirement... identify the authoritative evidence that would prove it... Treat uncertain or indirect evidence as not achieved... The audit must prove completion, not merely fail to find obvious remaining work."
  - "Only use status 'blocked' when the same blocking condition has repeated for at least three consecutive goal turns".
  - Completion is signalled through a tool: `update_goal` with status `complete`, `blocked` or `paused`.
- At budget exhaustion (`budget_limit.md`): "do not start new substantive work... summarize useful progress, identify remaining work or blockers, and leave the user with a clear next step."

**Plan mode** (`collaboration-mode-templates/templates/plan.md`): "explore first, ask second"; "Before asking the user any question, perform at least one targeted non-mutating exploration pass".

### 3.4 Memory, projects, tasks (brief, [SEC])
- Saved memories are an editable list of facts.
- "Reference chat history" retrieves from past chats without a stored list.
- Projects can have project-only memory, set at creation (rolled out Aug 2025).
- Sources: https://memx.app/blog/chatgpt-reference-chat-history-vs-saved-memories/, https://www.unite.ai/how-to-use-chatgpts-project-memory/. Primary help pages returned 403.
- [INF] These are context-assembly features around the loop, not part of the loop. Their API analogue is the Codex/Agents SDK "memory" plus compaction cookbooks.

---

## 4. OpenAI Agents SDK runner loop
Sources: https://openai.github.io/openai-agents-python/running_agents/, https://openai.github.io/openai-agents-python/agents/, https://developers.openai.com/api/docs/guides/agents/running-agents.md, `src/agents/run.py` on GitHub.

- [DOC] The loop: "We call the LLM for the current agent, with the current input. The LLM produces its output. If the runner classifies the LLM's output as final output, the loop ends and we return the result. If the LLM requests a handoff, we update the current agent and input, and re-run the loop. If the LLM produces tool calls, we run those tool calls, append the results, and re-run the loop. If we exceed the max_turns passed, we raise a MaxTurnsExceeded exception. Pass max_turns=None to disable this turn limit."
- [DOC] Final output rule: "it produces text output with the desired type, and there are no tool calls."
- [DOC] `DEFAULT_MAX_TURNS = 10` (in `run.py`). `error_handlers` accepts the keys `"max_turns"`, `"model_refusal"` and `"invalid_final_output"`, which return a controlled final output instead of raising.
- [DOC] `tool_use_behavior`:
  - `"run_llm_again"` (default);
  - `"stop_on_first_tool"`;
  - `StopAtTools(stop_at_tool_names=[...])`;
  - a custom `ToolsToFinalOutputFunction`.
- [DOC] `reset_tool_choice`: "To prevent infinite loops, the framework automatically resets tool_choice to 'auto' after a tool call."
- [DOC] Handoffs vs agents-as-tools: "Handoffs: Control moves to the specialist agent"; "Agents as tools: The manager keeps ownership of the reply". https://developers.openai.com/api/docs/guides/agents/orchestration.md
- [DOC] Guardrails: input guardrails ("Block disallowed user requests before the main model runs"), output guardrails ("run only for the agent that produces the final output"), tool guardrails, and human-in-the-loop approvals ("Pause before side effects"). https://developers.openai.com/api/docs/guides/agents/guardrails-approvals.md
- [DOC] State strategies: `result.to_input_list()` (local replay), `session`, `conversationId`, `previous_response_id`; "pick one strategy per conversation."

---

## 5. Gemini

### 5.1 Thinking
Source: https://aistudio.google.com/docs/thinking.md?generate-content=true
- [DOC] "Gemini models engage in dynamic thinking by default". The `thinkingLevel` parameter is "required for Gemini 4 and recommended for Gemini 3". Gemini 4 Argon supports `low`, `medium` (default) and `high`. Gemini 2.5 uses `thinkingBudget`. `minimal` "does not guarantee that thinking is off".
- [DOC] "Thinking models work with all of Gemini's tools and capabilities".
- [DOC] Prompting: "it's generally not necessary to have the model outline, plan, or detail reasoning steps in the returned response itself. For problems that require heavy reasoning, simple requests like 'Think very hard before answering' can improve performance". https://aistudio.google.com/docs/prompting-strategies.md
- [DOC] Sampling: "Gemini 4 and Gemini 3.6+ models ignore custom values for `temperature`, `top_p`, and `top_k` and return deprecation warning headers (and will return `400` errors in a future release)... For earlier Gemini 3 models, keep these parameters at their default values to avoid degraded reasoning performance."
  - Note: the older function-calling best-practice line "Use a low temperature (e.g., 0)" contradicts this for Gemini 3+ [INF].

### 5.2 Thought signatures (must be returned during multi-step function calling)
Sources: https://aistudio.google.com/docs/thought-signatures.md?generate-content=true and the thinking page.
- [DOC] "Thought signatures are encrypted representations of the model's internal thought process and are used to preserve reasoning context across multi-step interactions." "The Gemini API is stateless, so the model treats every API request independently".
- [DOC] "**When using Gemini 4 and Gemini 3 models, you must pass back thought signatures during function calling, otherwise you will get a validation error** (4xx status code)."
- [DOC] Placement rules:
  - "Parallel Function Calls: ...the `thought_signature` is attached **only to the first** `functionCall` part."
  - "When there are sequential function calls (multi-step), each function call will have a signature and you must pass all signatures back."
  - Validation covers "all function calls within the current turn". The current turn starts at the most recent user message with standard content (not a `functionResponse`).
  - "If you omit a `thought_signature` for the first `functionCall` part in any step of the current turn, the request will fail with a 400 error."
- [DOC] Non-function-call parts: "Returning these signatures is **recommended**... The API does **not** strictly enforce validation... though performance may degrade."
- [DOC] Pitfalls:
  - "Don't concatenate parts with signatures together. Don't merge one part with a signature with another part without a signature."
  - Parallel order must be "FC1+ signature, FC2, FR1, FR2", not interleaved.
  - When streaming, "the model may return the thought signature in a part with an empty text content part. It is advisable to parse the entire request until the `finish_reason`".
- [DOC] Injected or foreign history: "you can set the following dummy signatures of either `"context_engineering_is_the_way_to_go"` or `"skip_thought_signature_validator"`... to skip validation" ("strongly discouraged").
- [DOC] Model differences: "Gemini 2.5 will have the signature in the first part (regardless of type). It is **optional** to return that part." For Gemini 3/4 it is mandatory.
- [DOC] SDK note: "Thought signatures are handled automatically when you use the official Google Gen AI SDKs and append the full model response object directly to history."
- [DOC] Gemini 3 also supports thought signatures through its OpenAI-compatible Chat Completions endpoint (https://aistudio.google.com/docs/openai.md).

### 5.3 Interactions API (now the default) and server-side state
Source: https://aistudio.google.com/docs/interactions-overview.md
- [DOC] "As of June 2026, it is Generally Available and the recommended interface for all new projects." The index says `generateContent` "is considered a legacy API".
- [DOC] Benefits: "Optional server-side conversation state using `previous_interaction_id`, observable execution steps..., and background execution for long-running tasks using `background=true`"; "Lower cost with higher cache hit rates"; "Going forward, new models and capabilities... will launch on the Interactions API." "By default, the Interactions API stores requests... You can opt into stateless behavior by setting `store=false`."
- [DOC] Signatures in Interactions: "In stateful mode (`store: true`), the server manages conversation context automatically... In stateless mode, internal reasoning is isolated into dedicated `thought` steps in the `steps` array." https://aistudio.google.com/docs/thought-signatures.md

### 5.4 Function calling
Source: https://aistudio.google.com/docs/function-calling.md?generate-content=true
- [DOC] Modes:
  - `AUTO` (default with functions only);
  - `ANY` ("always predict a function call");
  - `NONE`;
  - `VALIDATED` ("Default mode for tool combination... ensures function schema adherence... reduces malformed function calls").
- [DOC] Compositional (sequential) calling is supported: "allows Gemini to chain multiple function calls together to fulfill a complex request".
- [DOC] Automatic function calling is a **Python SDK feature only**. The SDK will "Detect function call responses... Call the corresponding Python function... Send the function's response back... Return the model's final text response."
- [DOC] Tool count: "ideally keeping the active set to a maximum of 10-20. Consider dynamic tool selection based on conversation context".
- [DOC] Error handling: "Return informative error messages that the model can use". "Check Finish Reason... to handle cases where the model failed to generate a valid function call."
- [DOC] Pre-tool text workaround. Requiring structured text (XML/JSON) right before a tool call can cause `Malformed_Function_Call`. "PREFERRED: Instruct the model to put its pre-tool notes inside a dedicated `update()` function call instead of raw text", for example `update(previous_step, plan, next_step, external)`.
- [DOC] "don't assume the `functionCall` will always be the last item in the parts array... always iterate through the parts array".

### 5.5 Built-in tools and combining them with functions
- [DOC] Built-in tools:
  - Grounding with Google Search (`google_search`; citations, grounding metadata), https://aistudio.google.com/docs/google-search.md
  - URL context (`url_context`: reads given URLs to "Extract Data", "Compare Documents"), https://aistudio.google.com/docs/url-context.md
  - Code execution (Python; "The model can then learn iteratively from the code execution results until it arrives at a final output"), https://aistudio.google.com/docs/code-execution.md
  - File search
- [DOC] Combining built-in tools with custom functions (preview, Gemini 3/4) relies on "tool context circulation". In `generateContent`, set `include_server_side_tool_invocations=True` and return `function_response` with the matching `id`. In the Interactions API, "The Interactions API manages context automatically across tool calls." https://aistudio.google.com/docs/tool-combination.md

### 5.6 Gemini agentic system-instruction template
Source: https://aistudio.google.com/docs/prompting-strategies.md#agentic-workflows
- [DOC] Steerable dimensions:
  - Logical decomposition, problem diagnosis, information exhaustiveness;
  - adaptability, persistence and recovery, risk assessment;
  - ambiguity and permission handling, verbosity, precision and completeness.
- [DOC] Template "evaluated by researchers to improve performance on agentic benchmarks" (excerpts):
  > You are a very strong reasoner and planner... Before taking any action (either tool calls *or* responses to the user), you must proactively, methodically, and independently plan and reason about: 1) Logical dependencies and constraints... 2) Risk assessment... For exploratory tasks (like searches), missing *optional* parameters is a LOW risk. **Prefer calling the tool with the available information over asking the user**... 3) Abductive reasoning and hypothesis exploration... 4) Outcome evaluation and adaptability... 5) Information availability... 6) Precision and Grounding... 7) Completeness... 8) Persistence and patience: Do not give up unless all the reasoning above is exhausted... On *transient* errors..., you *must* retry **unless an explicit retry limit... has been reached**... On *other* errors, you must change your strategy or arguments, not repeat the same failed call. 9) Inhibit your response: only take an action after all the above reasoning is completed.

### 5.7 Gemini Deep Research agent (API)
Source: https://aistudio.google.com/docs/deep-research.md
- [DOC] "The Deep Research agent is exclusively available using the Interactions API... You cannot access it through `generate_content`." "You must use background execution (set `background=true`)". "Agent execution using `background=True` requires `store=True`."
- [DOC] Versions:
  - `deep-research-preview-04-2026`: "Designed for speed and efficiency, ideal to be streamed back to a client UI".
  - `deep-research-max-preview-04-2026`: "Maximum comprehensiveness".
- [DOC] Process: "Plan -> Search -> Read -> Iterate -> Output". Default tools are Google Search, URL Context and Code Execution; MCP servers and File Search are optional. "You cannot currently provide custom Function Calling tools but you can use remote MCP".
- [DOC] Collaborative planning (`agent_config.collaborative_planning: true`): "the agent returns a proposed research plan instead of executing immediately. You can then review, modify, or approve the plan".
- [DOC] Scale and cost:
  - Standard: "~80 search queries, ~250k input tokens (~50-70% cached), and ~60k output tokens... ~$1.00 - $3.00 per task".
  - Max: "up to ~160 search queries, ~900k input tokens..., ~80k output tokens... ~$3.00 - $7.00".
  - "maximum research time of 60 minutes. Most tasks should complete within 20 minutes."
- [DOC] Best practice: "Prompt for unknowns: Instruct the agent on how to handle missing data". Safety: "Exfiltration: Be cautious when asking the agent to summarize sensitive internal data if you are also allowing it to browse the web."
- [DOC] Managed agents ("Antigravity", built with Gemini 3.8 Flash) run in a Google-hosted Linux sandbox and are reachable through one API call. https://aistudio.google.com/docs/agents.md

---

## 6. Perplexity and Manus (only where solid sources exist)
- **Perplexity Deep Research** (Feb 14, 2025), https://perplexity.ai/hub/blog/introducing-perplexity-deep-research ([DOC], vendor blog, quoted through the fetch tool):
  - "Perplexity performs dozens of searches, reads hundreds of sources, and reasons through the material".
  - It "iteratively searches, reads documents, and reasons about what to do next, refining its research plan".
  - "completing in 2-4 minutes"; "most research tasks in under 3 minutes".
  - "the agent then synthesizes all the research into a clear and comprehensive report."
- **Manus, "Context Engineering for AI Agents"**, https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus ([SEC], vendor engineering blog):
  - "the KV-cache hit rate is the single most important metric for a production-stage AI agent". The input-to-output ratio is "around 100:1"; cached input costs $0.30/MTok versus $3 uncached.
  - "Mask, Don't Remove": "avoid dynamically adding or removing tools mid-iteration"; they mask logits instead.
  - "Use the File System as Context": compression should be reversible, e.g. "the content of a web page can be dropped from the context as long as the URL is preserved."
  - "Manipulate Attention Through Recitation": "A typical task in Manus requires around 50 tool calls on average." "By constantly rewriting the todo list, Manus is reciting its objectives into the end of the context".
  - "Keep the Wrong Stuff In": "Erasing failure removes evidence. And without evidence, the model can't adapt."
  - "Don't Get Few-Shotted": "The more uniform your context, the more brittle your agent becomes."
- [INF] Both are plan-then-execute loops with a long tool budget and a final synthesis step. Manus's todo.md is the same idea as Codex's `update_plan` and OpenAI's `<plan_tool_usage>`.

---

## 7. Open-weight models on vLLM: the same rule applies
- [DOC] gpt-oss, https://developers.openai.com/cookbook/articles/gpt-oss/handle-raw-cot.md:
  - The raw CoT is "crucial for the performance of tool calling, as tool calls can be performed as part of the CoT."
  - Rules:
    1. "After a message to the `final` channel in a subsequent sampling turn all `analysis` messages should be dropped."
    2. "If the last message by the assistant was a tool call of any type, the analysis messages until the previous `final` message should be preserved on subsequent sampling until a `final` message gets issued."
  - For Chat Completions, follow OpenRouter: "The raw CoT is exposed as a `reasoning` property on the message... On subsequent turns you should be able to receive the previous reasoning (as `reasoning`)". Do "not show raw CoT to end users."
- [DOC] vLLM interleaved thinking, https://docs.vllm.ai/en/latest/features/interleaved_thinking/: "Interleaved thinking allows models to reason between tool calls". The client appends `{"role":"assistant","tool_calls":..., "reasoning": response.choices[0].message.reasoning}`. The listed parsers are Kimi-K2-Thinking (`kimi_k2`) and MiniMax-M2 (`minimax_m2`). "Interleaved thinking increases token usage and response latency."
- [DOC/SEC] vLLM also serves `/v1/responses` (vLLM online-serving docs; OpenAI's gpt-oss-on-vLLM cookbook: function calling works on both endpoints, and "it's important for you to return the reasoning returned by the API back into a subsequent call when making follow-up tool calls"). https://developers.openai.com/cookbook/articles/gpt-oss/run-vllm
- [SEC] Z.ai GLM docs: return the historical `reasoning_content` to keep reasoning coherent (https://docs.z.ai/guides/capabilities/thinking-mode). LocalAI accepts either `reasoning` or `reasoning_content`.

---

## 8. Quick observations on iHub's current adapters ([INF], from a brief read of `server/adapters`, not a review)
- `openai-responses.js` sends `store: true`, but it rebuilds `input` from generic chat messages on every call and never sets `previous_response_id`. Its `formatMessages` emits only `function_call` / `function_call_output` / role messages, so **reasoning items (and their `encrypted_content`) and the assistant `phase` are never replayed**. By OpenAI's docs, the model then loses its reasoning between tool steps, and preambles risk being read as final answers.
- When thinking is disabled, the same adapter falls back to `reasoning.effort: 'minimal'`. GPT-6.1 Sol rejects `minimal`, GPT-6 Astra rejects `none`, and later 5.x models use `none` instead of `minimal`.
- `openai.js` (Chat Completions, `reasoning_effort`) cannot tool-call GPT-6 Astra or GPT-6.1 Sol at all (§1.3).
- The vLLM converter reads `reasoning` / `reasoning_content` from responses. I did not see it written back onto assistant tool-call messages; this needs a check against §7.
- The Google converter already carries `thoughtSignature` on function-call parts, which is good. The other §5.2 rules (no merging, first-part-only for parallel calls, streaming empty-text part) still need to be checked.

---

## 9. Checklist: what a third-party platform must do to get ChatGPT-level multi-step behaviour from the OpenAI/Gemini APIs and from open-weight models on vLLM

### A. Transport and reasoning state (most important)
1. **OpenAI: use the Responses API for every tool-using or reasoning request.** [DOC] It is required for tool calling on GPT-6 Astra, GPT-6.1 Sol and GPT-6.1 Terra, and for reasoning plus tools on GPT-6 Sol/Luna.
2. **Replay every output item, unchanged, in order, append-only.** That means reasoning items, messages with their `phase`, function calls and tool-search items.
   - Either chain with `previous_response_id`, or go stateless with `store:false` and replay the items including `encrypted_content` (the Codex pattern; ZDR-compatible).
   - Do not mix both strategies. [DOC]
3. **Never rewrite the prefix.** [DOC]
   - Don't truncate or summarise earlier tool outputs in place.
   - Don't insert system or developer messages mid-history (append them where they take effect).
   - Don't change the tool list between steps (use `allowed_tools` / `additional_tools`).
   - Filter tool output *before* the first send.
4. **Preserve `phase`** (`commentary` / `final_answer`) on replayed assistant messages, and render commentary as progress, not as the answer. [DOC]
5. **Reasoning stays within a model family.** If the user switches model mid-conversation, expect the reasoning to be dropped. [DOC]
6. **Gemini: return every part exactly as received**, keeping `thoughtSignature` on the first `functionCall` of each step in the current turn. [DOC]
   - Never merge or concatenate parts.
   - Keep the parallel order FC1, FC2, FR1, FR2.
   - Parse the stream to `finish_reason` for signatures in empty text parts.
   - Use the dummy signature only for injected or foreign calls.
   - Consider moving to the Interactions API (stateful by default; new features land there). [DOC]
7. **vLLM / open-weight:** start vLLM with `--reasoning-parser` and the tool parser.
   - Write `reasoning` (or `reasoning_content` for servers that use it) back onto the assistant tool-call message until a final answer is produced. Drop it after the final answer (gpt-oss rule).
   - Or use vLLM's `/v1/responses` with reasoning items. [DOC]

### B. Reasoning configuration
8. **Always set reasoning effort explicitly.** [DOC]
   - GPT-5.2/5.4 default to `none`.
   - Use ≥ `low` for any tool use, `medium` by default, and `high`/`xhigh` for research or long runs.
   - Respect per-model supported values: no `minimal` on GPT-6.1 Sol, no `none` on GPT-6 Astra/6.1 Sol.
   - Gemini: set `thinkingLevel` (required on Gemini 4).
9. **Remove `temperature`/`top_p`** for reasoning OpenAI models when effort is not `none`, and for Gemini 4/3.6+. [DOC]
10. **Leave output room:** reserve ≥ 25k tokens and handle `status: incomplete` / `max_output_tokens`. Use `text.verbosity` for answer length instead of starving reasoning. [DOC]
11. On GPT-6, change effort mid-conversation with `configuration_update` items so the cache prefix stays intact. [DOC]

### C. Loop control (the "keep going until done" mechanics)
12. **Loop until the model returns a response with no tool calls** (the Codex and Agents SDK rule). [DOC]
    - Don't stop after a fixed small number of rounds. The SDK default of 10 is too low for research; ChatGPT-class tasks run about 50 tool calls (Manus) or 80–160 searches (Gemini DR). [DOC/SEC]
    - Bound the loop by a **token/cost budget and wall-clock time** rather than a low turn count.
    - At the budget, inject a wrap-up instruction like Codex's `budget_limit.md`. [INF]
13. **Detect premature stops** with a final-answer check, comparable to Codex stop hooks and Goal continuation. [INF, modelled on DOC]
    - If the answer promises future action ("I'll now search…") without a tool call, re-prompt.
    - If plan items are still pending, re-prompt with a continuation message.
    - Use OpenAI's line "Do NOT promise to call a function later. If a function call is required, emit it now".
14. **Offer an optional "goal / deep task" mode** with a completion contract: outcome, verification evidence, constraints, and a blocked-stop rule (for example, blocked only after the same blocker recurs for three turns). Run continuation turns with a requirement-by-requirement completion audit (Codex Goals). [DOC]
15. **Parallel tool calls on** (`parallel_tool_calls: true`); return all outputs before re-sampling. [DOC] Execute concurrently only calls that are independent and safe (reads, searches); run calls with side effects, or that depend on shared state or order, one after another in the order the model gave them. [INF, in line with Anthropic's parallel tool use guidance]
16. **Long tasks:** use background mode (OpenAI) or `background=true` (Gemini Interactions), stream progress events, consider WebSocket mode for 20+ tool calls (about 40% faster), and avoid HTTP timeouts and automatic retries on long streams. [DOC]

### D. Prompt layer (system prompt contracts)
17. **Persistence block** (GPT-4.1/GPT-5 wording) plus **tool-use block** ("do NOT guess or make up an answer"). For GPT-6, add the "treat 'can you…' as an instruction to act" and "complete authorized work before asking" prompts, because GPT-6 asks more. [DOC]
18. **Non-reasoning models** (GPT-4.1, `none` effort, small open models): add the explicit planning-before-each-call prompt (+4%). **Reasoning models:** don't ("may actually hurt"). [DOC]
19. **Preambles and user updates:** a short visible update before the first tool call, then sparse outcome-based updates at phase changes. Don't narrate routine calls. [DOC]
20. **Outcome-first goal, success criteria and stop rules** (GPT-5.5/5.6 structure: Role / Goal / Success criteria / Constraints / Tools / Output / Stop rules). [DOC]
21. **Agentic contracts for research and knowledge tasks** (GPT-5.4): `<tool_persistence_rules>`, `<dependency_checks>`, `<parallel_tool_calling>`, `<completeness_contract>`, `<empty_result_recovery>`, `<verification_loop>`, `<research_mode>` (plan 3–6 sub-questions, retrieve with second-order leads, synthesize), `<citation_rules>`, `<grounding_rules>`. Also add a **retrieval budget** so simple questions stay cheap. [DOC]
22. **Autonomy and approval policy stated once:** answer/explain requests are read-only; change requests act locally; external writes, destructive actions or scope expansion need confirmation. Per-tool uncertainty thresholds. [DOC]
23. **Keep prompts lean and contradiction-free.** Leaner prompts gave +10–15% score at −41–66% tokens on GPT-5.6, and contradictions waste reasoning. Drop the current-date line for GPT-5.5+. Audit skill and instruction files for GPT-6. [DOC]
24. **Gemini:** use the agentic system-instruction template (§5.6). Put pre-tool notes in an `update()` function rather than raw XML. [DOC]

### E. Tools layer
25. **Few, well-described tools** (< 20 up front on OpenAI, 10–20 on Gemini). Descriptions should say what the tool does, when to use it, its inputs, side effects, retry safety and error modes. Prefer flat schemas, `strict: true` and enums. Don't ask the model for arguments you already know. [DOC]
26. **Large catalogs:** OpenAI `tool_search` with `defer_loading` and namespaces (< 10 functions each; gpt-5.4+). Otherwise do server-side dynamic tool selection that only appends tools (keep the prefix stable; "mask, don't remove"). [DOC/SEC]
27. **A planning/todo tool** (`update_plan`-style, with merge and statuses, one item in progress). Render it in the UI; enforce "zero pending at end of turn" in the prompt and optionally in the loop. [DOC]
28. **Research primitives:** a search tool *and* a separate fetch/read-page tool (the ChatGPT DR / MCP `search` + `fetch` pattern), plus code execution for analysis. Where allowed, use the hosted ones: OpenAI `web_search` (with `return_token_budget: "unlimited"` for deep runs and `tool_choice: "required"` when search must happen) and Gemini `google_search` + `url_context` + `code_execution`. [DOC]
29. **Tool results:** return informative error strings (never silently drop errors; "keep the wrong stuff in"). Truncate or filter *before* first delivery, and keep reversible pointers (URL or document id) instead of bulk text. [DOC/SEC]
30. **Prompt-injection hygiene:** split public-web and private-data steps into separate requests, require approval for side-effecting MCP or tool calls, and don't auto-fetch URLs that came from tool output. [DOC]

### F. Context management
31. **Compaction at milestones**, not every turn: OpenAI server-side `context_management.compact_threshold` or `/responses/compact`; otherwise a Codex-style handoff summary (progress, decisions, constraints, remaining steps, critical data). After compaction, keep the prompt functionally the same. [DOC]
32. **Cache-friendly layout:** static instructions and tools first, dynamic content last, a stable `prompt_cache_key`, append-only history. Manus calls the KV-cache hit rate "the single most important metric". [DOC/SEC]
33. **Recitation:** keep the current plan or todo near the end of context (plan-tool output, or a short "objective + remaining items" reminder at each continuation). [SEC/INF]

### G. Front-of-loop and UX
34. **Clarify or rewrite before deep runs**, as ChatGPT Deep Research does with a lightweight model: either ask at most a few clarifying questions, or expand the request into a full research brief, then launch. Gemini DR offers collaborative plan approval. [DOC]
35. **Show progress** (preambles / commentary, plan updates, tool activity) and support stop/steer (GPT-6 mid-turn steering over WebSocket where available). [DOC]

### H. Evaluation
36. Build traces and evals for completion rate, premature-stop rate, tool-call count, tokens and latency per task. Change one variable at a time (model, effort, prompt, tools), as all OpenAI migration guides insist. [DOC]
