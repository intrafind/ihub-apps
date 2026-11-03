# Competitive research: Open WebUI vs iHub (as of 2026-11-03)

Source: `CHANGELOG.md` of https://github.com/open-webui/open-webui, and a shallow clone at commit `c38885a` (2026-11-03). I read the code but did not run it.

## Versions covered

From **0.9.3 (2026-05-09)** to **0.13.0 (2026-11-02)**, 21 releases:
0.9.3, 0.9.4, 0.9.5 (05-09), 0.9.6 (06-01), 0.10.0 / 0.10.1 (06-29), 0.10.2 (07-01), 0.11.0 (07-27),
0.11.1 (08-25), 0.11.2 / 0.11.3 (08-31), 0.11.4 (09-21), 0.12.0 (10-10), 0.12.1 / 0.12.2 (10-14),
0.12.3 (10-16), 0.12.4 (10-25), 0.12.5 (10-29), 0.13.0 (11-02).

The "Added" sections hold about 620 entries in total. Many are performance work: 0.11.1 alone is mostly "faster X".
Open WebUI is moving in three directions:
- **an agent harness**: sub-agents, tool search, compaction, HITL approval, ask-user, timers, terminals, computer use and browser use;
- **team collaboration**: shared folders, live presence, replies in shared chats, comments, an inbox and E2E-encrypted channels;
- **enterprise admin**: MFA, nested groups, LDAP sync, an event/webhook bus, version history, hiding UI controls and analytics.

## Feature table

Key: HAVE = iHub has an equivalent; PARTIAL = iHub has part of it (the gap is described); MISSING = not found in docs or code after grepping.

| # | Feature | Release | Description (Open WebUI) | iHub status | iHub evidence / gap |
|---|---|---|---|---|---|
| 1 | **Tool Search** (deferred tool schemas, `search_tools` + `call_tool`) | 0.12.0, 0.12.2 | When a tool's JSON schema is longer than a threshold, it is left out of `tools[]`. The model sees only an `<available_tools>` name/description manifest, finds tools with BM25 search and calls them through a `call_tool` proxy. This keeps prompts small and the prompt cache stable when many MCP servers are attached. | **MISSING** | No deferral or tool-search code in `server/` (grepped `search_tools`, `defer`, `toolSearch`). Skills are already lazy (`activate_skill`, docs/skills.md:49-71), but tools are not. This matters for iHub because integrations can bind many actions per app. |
| 2 | **LLM context compaction** (automatic at a token threshold, on demand with `/compact`, also inside long tool loops, summary kept as a checkpoint) | 0.10.0, 0.11.0, 0.12.0, 0.12.4 | Earlier turns are summarized with an LLM prompt (previous summary + compacted messages + kept messages). Settings: threshold, cap, retention %, prompt and a per-model threshold. The chat shows a notification, and `chat.compacted` events fire. | **PARTIAL** | `server/services/loop/contextCompaction.js` does *micro*compaction only: old tool/assistant bodies collapse to placeholders (`context.compactThresholdTokens`, docs/agent-loop.md:77-79), plus a retry when the provider reports overflow. Missing: an LLM summary, a stored summary checkpoint for long *chat histories*, a user `/compact` command and a visible compaction marker. |
| 3 | **Sub-agents / multi-model sub-agents** (`delegate_task`) | 0.11.0, 0.13.0 | The model hands tasks to helper agents. They run in the foreground (with a semaphore) or in the background (async; a completion message is injected later) and report a summary. The model editor names which other models it may delegate to. | **PARTIAL** | Apps as tools ("Concierge pattern", docs/apps.md:1163; `invokeAppInternal` runs `kind:'subagent'` in `server/services/chat/ChatService.js:1531`), A2A agents (docs/a2a-agents.md) and workflows. Missing: dynamic delegation of an ad-hoc task with parallel or background workers. docs/agents.md:330 lists "Sub-agent delegation" as out of scope. |
| 4 | **Per-user long-term memory** (types `user`/`context`, paths, vector recall, background review every N turns) | 0.10.0, 0.10.2, 0.11.0 | Memory rows are injected into the system prompt (user facts + path neighborhood + vector top-k). A background LLM review emits add/replace/move/remove operations. Users manage memories in Settings, and memory can be turned on per model. | **PARTIAL** | `server/services/memory/memoryService.js` covers memory for **agents** and **scheduled tasks** only (scopes `agent`, `scheduled-task`). Chat users have no personal memory. |
| 5 | Human-in-the-loop tool approval | 0.11.1 | Chats can switch to "ask first": each tool call waits for allow or deny, and the choice is remembered. | **HAVE** | docs/tool-approval.md; docs/releases/next/features.md:249-276 (three modes, per-action side effect, approval card). |
| 6 | Models that ask the user a question | 0.11.1 | Built-in tool with up to 3 multiple-choice questions. The question survives a reload. | **HAVE** | docs/ask-user-tool.md; `ask_user` in docs/agent-loop.md. |
| 7 | MCP Apps in chat | 0.13.0 | Interactive `ui://` views in a sandboxed frame. Tool calls made from the app need confirmation. | **HAVE** | docs/mcp-integration.md:475 ("MCP Apps — interactive views"); `server/services/mcp/mcpApps.js`, `mcpAppSandboxPage.js`. |
| 8 | Skills: multi-file, versions, on-demand loading, URL/ZIP import, `/skills:create` from a chat | 0.11.4, 0.12.0, 0.12.3, 0.12.4 | | **HAVE** | docs/skills.md (on-demand loading :49, versions :213, marketplace import); "Save as skill" in `client/src/features/chat/components/ChatMessage.jsx:200`. |
| 9 | **Realtime voice calls** (OpenAI/Azure Realtime speech-to-speech, hand-off to the chat model, animated avatars) | 0.12.0, 0.12.1 | The realtime model handles small talk itself and hands real tasks to the chat model and its tools. Calls are capped at 1 hour. | **PARTIAL** | Voice mode is a pipeline: STT session → chat → TTS (docs/voice-transcription.md:113, docs/text-to-speech.md; `server/services/chat/voiceMode.js`). There is no native speech-to-speech model path and no avatar. |
| 10 | **Two-factor sign-in (TOTP)** for local accounts | 0.12.0 | Enforced by an admin. Users enrol with a QR code and get 10 recovery codes. Bypass for OAuth or trusted-header sign-ins. CLI reset. Throttling. Events for every step. | **MISSING** | `server/middleware/localAuth.js` has no TOTP. iHub relies on the IdP's MFA (docs/ADFS-AUTHENTICATION-GUIDE.md:548). The default local admin `admin`/`password123` makes this matter more. |
| 11 | **System event bus + outbound webhooks** (~196 event types, per-webhook event filters, user/group targets) and the "Event function" plugin | 0.10.0, 0.12.5 | Sign-ins, config changes, chat/file/knowledge actions, automation failures and MFA events go to Slack, Discord, Google Chat or generic JSON webhooks through an SSRF-safe sender. | **PARTIAL** | iHub has inbound webhook *triggers* (docs/workflows.md, docs/agents.md), an Audit Log page (`AdminAuditLogPage.jsx`) and OTel telemetry (docs/telemetry.md). It has no admin-configurable *outbound* event webhooks or SIEM forwarding. |
| 12 | Version history for models, tools, functions and prompts (compare, restore) | 0.12.0 | | **HAVE** | App editor History (docs/admin-ui.md:150), prompt versions (docs/prompts.md:216), skill versions, integration backups/revert (docs/releases/next/features.md:96-130). |
| 13 | Nested groups | 0.12.0 | | **HAVE** | `inherits` in groups.json (CLAUDE.md, docs/authentication-architecture.md). |
| 14 | LDAP group synchronization | 0.11.0 | | **HAVE** | External group mappings (docs/external-authentication.md:199-201, docs/LDAP-GROUP-LOOKUP-QUICKSTART.md). |
| 15 | **Shared chat folders for teams** (read/write, per user or group, a "Folders Sharing" permission) | 0.10.0, 0.11.0, 0.12.3, 0.12.4 | Folders have default models, descriptions and pages. Other people's chats open read-only. | **MISSING** | Chat history is grouped by date or app only (docs/chat-persistence.md:155). Projects (docs/projects.md) share *documents*, not chats. |
| 16 | **Collaborative shared chats**: live presence avatars, replying / editing / regenerating inside a shared chat, forking a shared chat | 0.12.0, 0.12.3 | | **PARTIAL** | Share links are read-only snapshots: the recipient "cannot type into it, edit it, rate it or continue it" (docs/chat-sharing.md:7). There is no presence. |
| 17 | **Fork a chat** from any response | 0.11.0 | Copies the conversation up to that response into a new chat linked to its origin. | **MISSING** | Only edit/resend truncation exists (`useAppChat.js:145-283` "fork" means a history cut inside the same chat). There is no "branch into new chat". |
| 18 | **Comment threads + notification inbox** | 0.13.0 | Comments with replies, reactions and @mentions on chats, notes, models, KBs, prompts, skills and tools, including comments anchored to a selected passage. The inbox collects mentions, replies, failed automations and calendar alerts. | **MISSING** | The only inbox is for scheduled tasks: unseen-run notifications (`GET /_notifications`, docs/scheduled-tasks.md:501). |
| 19 | Side chats (`/side`, `/btw`) | 0.13.0 | A temporary side conversation that uses the main chat as context and is not saved into it. | **MISSING** | Not found. |
| 20 | **Chat timers + notifications sent by the assistant** | 0.11.0 | The model sets a one-shot timer that re-prompts *the same chat* later, with `cancel_on: chat.read / chat.user_message`. A `notify` tool lets the assistant ping the user. | **PARTIAL** | Scheduled tasks can be proposed from a chat (docs/scheduled-tasks.md:86,122) and can run `once`, but they run as separate task chats. There is no cancel-if-the-user-returns rule and no general "notify me" tool. |
| 21 | Chat variables + **user variables** | 0.11.0 | System prompt fields (`{{chat.variables.x \| select ...}}`) and values that each user stores (`{{user.variables.role}}`). | **PARTIAL** | App `variables` and admin global variables (`{{user_name}}`, docs/apps.md:1275) exist. Users cannot store their own values. |
| 22 | **Model controls** (admin-defined named presets such as Thinking Low/Med/High, each mapping to custom params, shown as a menu or slider) | 0.12.0 | | **PARTIAL** | The user can turn thinking on and pick a level in `SharedAppHeader.jsx` (`thinkingLevel`). There are no generic admin-defined named parameter presets. |
| 23 | **Workspace search** (full text across chats, shared chats, channels and notes, with filters and preview) | 0.11.1, 0.12.3 | | **PARTIAL** | The sidebar searches chats by **title and app name** only (docs/chat-persistence.md:285; `AppSidebar.jsx`). |
| 24 | Admin analytics session explorer + **personal usage dashboard** | 0.10.0, 0.11.0, 0.12.4, 0.12.5 | Per-chat tokens, errors, tool-call timing, ranking by tokens. Users see a heatmap, streaks and top models in Settings → Usage. | **PARTIAL** | Admin Usage Reports (docs/admin-ui.md:335), run ledger and run detail (docs/run-ledger.md), Admin Chat History. Users have no self-service usage page. |
| 25 | KB **filesystem tool** (`ls/cat/grep/find/sed` over a knowledge base) + **smart directory sync** + KB folders | 0.9.6 | | **PARTIAL** | Projects offer `knowledge_search/read/list` (docs/projects.md:332). There is no grep or regex over a corpus and no checksum-based directory sync. |
| 26 | External knowledge bases | 0.10.0 | | **HAVE** | Sources and iFinder (docs/sources.md, docs/iFinder-Integration.md). |
| 27 | Tool creation from a chat (the model writes a private Python tool) | 0.13.0 | | **PARTIAL** | Custom integrations are built from OpenAPI in the admin UI (docs/releases/next/features.md:57-95), not from a chat. |
| 28 | Word/PowerPoint generated by the code interpreter (offline libraries) | 0.12.0 | | **HAVE / PARTIAL** | Dedicated PDF/Word/PPT/Excel and web-artifact tools (docs/artifacts.md, docs/releases/next/features.md:347-366). There is no general Python code interpreter. |
| 29 | Terminals, Git panel, browser-use tab, computer-use desktop tab | 0.11.x, 0.13.0 | | **MISSING** | Not found. These are developer-centric and less relevant to iHub's audience. |
| 30 | End-to-end encrypted channel chats (MLS) | 0.12.3 | | **MISSING** | Not found. iHub has no channels, so relevance is low. |
| 31 | Interface text an admin can reword | 0.11.4 | | **HAVE (file-based)** | `contents/locales/{lang}.json` overrides (docs/localization.md:14). There is no admin UI panel for it. |
| 32 | Restricting sharing with groups; encrypting plugin secrets | 0.10.0, 0.11.0 | | **HAVE** | Group-based permissions; AES-GCM secret encryption (CLAUDE.md "Secret Encryption at Rest"). |

## Implementation deep-dives

All paths are relative to the clone, under `backend/open_webui/`.

### 1. Tool Search: `utils/tool_search.py` (220 LOC)
- Config keys: `chat.tool_search.enable`, `defer_threshold` (a character length of the JSON spec), `always_loaded` (fnmatch patterns such as `github_*`) and `defer_builtin_tools`.
- `select_deferred_tools()` defers every tool whose `len(json(spec)) > threshold`, unless a pattern pins it. `build_deferred_tools_manifest()` writes `<available_tools><tool><name/><description (≤100 chars)/></tool>…</available_tools>` into the system prompt. The text tells the model "never say a capability is unavailable without searching first".
- `search_deferred_tools()` ranks with `rank_bm25.BM25Okapi` plus a raw token-overlap bonus. The Unicode tokenizer splits CJK text separately. The tool returns at most 20 results (5 by default).
- Design choice: **the provider `tools[]` array never changes during a run.** Discovered tools are invoked through a single `call_tool(tool_name, params:JSON-string)` proxy, so the prompt cache prefix stays byte-identical. `resolve_tool_call()` maps the proxy call back to the real tool. Sub-agents and timers strip the manifest (`strip_deferred_tools_manifest`).

### 2. Context compaction: `utils/context_compaction.py` (609 LOC)
- Config keys: `chat.context_compaction.{enable, token_threshold (default 80000), token_cap, retention_percentage (clamped 10–50, default 40), prompt_template}`, and a per-model `params.compact_token_threshold` that can only *lower* the threshold (`min(model, cap)`).
- The threshold check prefers the **provider-reported usage** of the most recent message and adds an estimate only for the messages after it. It falls back to a char-based estimate (`_exceeds_token_threshold`).
- The cut (`_find_compaction_boundary`) keeps roughly the last 40% of messages and cuts only at a user-turn boundary or, inside tool loops, at an assistant `tool_calls` boundary, so call and result pairs and their image messages stay together.
- The summary prompt has three slots: `{{PREVIOUS_SUMMARY}}`, `{{COMPACTED_MESSAGES}}` and `{{RECENT_MESSAGES}}`. Base64 data URIs are stripped first.
- The summary is stored as a **checkpoint** on the message (`contextSummary`, or as an `open_webui:context_compaction` output item tied to a `call_id` during a tool loop). Later requests start from the newest checkpoint (`_apply_latest_summary_checkpoint`). `compact_chat_branch()` backs the on-demand command, and `get_chat_context_usage()` feeds a context-usage indicator.

### 3. Sub-agents: `utils/subagents.py` (758 LOC), `tools/builtin.py:1774 delegate_task`
- `delegate(task, context, background, file_ids, model_id, …)`. Limits come from `subagents.max_concurrent` (a global foreground `asyncio.Semaphore`), `max_async` (a set of background tasks, refused when full), `max_iterations` (per-child `max_tool_call_iterations`), `max_output` (the summary is truncated) and `system_prompt`. `-1` means unlimited.
- A child run is a full internal chat (`_build_request(..., internal=True)`) with a minted token. It gets the parent's personal tool servers (0.13.0 fix) but **not the memory-mutating tools** (`MUTATING_MEMORY_TOOLS` are removed).
- When a background child finishes, `[ASYNC SUBAGENT COMPLETE - <id>]` is injected into the parent chat through `process_pending_internal_messages`.
- Multi-model (0.13.0): `get_subagent_models()` returns the models configured on the parent model, filtered by what the user can access. The parent picks `model_id`.

### 4. Memory: `models/memories.py`, `utils/memory.py` (609 LOC)
- Table `memory(id, user_id, type ∈ {user, context}, path, content, meta, created_at, updated_at)`. Each row is also embedded in a per-user vector collection.
- Injection (`add_memory_context`): every `user`-type memory (sorted by path), then "neighborhood" `context` memories under paths suggested by the query (`memory_path_hints`), then the vector top-8 for the last 7 user messages (≤4000 chars).
- Background review (`review_memory_after_turn`) runs every `memories.review_interval_turns` (default 10) user turns when `memories.background_review.enable` is on. The permission is checked again on the server because the `features` flag comes from the client. An LLM returns JSON `{"operations":[add|replace|move|remove]}` under explicit rules: no secrets, no one-off events, prefer replacing over duplicate adds. `validate_memory_operations()` checks the result.
- `model_allows_memory(model)` makes memory a capability that can be set per model.

### 5. Event bus + webhooks: `events.py` (1344 LOC), `utils/webhook.py`
- A frozen Pydantic catalogue of about 196 `EventDefinition(name, description, message)` entries (`auth.login`, `auth.mfa.*`, `chat.compacted`, `automation.run_failed`, `config.*`, `comment.created`, …). `get_event_catalog()` feeds the admin UI.
- Webhooks are stored under config key `events.webhooks`. Each has event filters (wildcards via `event_filter_matches`) and optional `targets` (users or groups, with group inheritance resolved in `event_target_matches`), so one event can go to one team's Slack. A migration handles the legacy single `webhook_url`.
- `post_webhook()` calls `validate_url` (blocks private IPs and cloud metadata) and detects Slack, Google Chat and Discord URLs to reshape the payload. Other URLs get generic JSON.
- The same bus feeds the notification inbox (`utils/inbox.py consume_event`) and the "Event function" plugin type.

### 6. Chat timers: `utils/timers.py` (453 LOC)
- "Durable one-shot timers backed by internal child chats." `create_timer(at, prompt, cancel_on ⊆ {chat.read, chat.user_message})`. `at` accepts `+10m`, `in 2 hours` or RFC3339.
- `claim_due_timers()` claims due rows with a claim id so that only one instance fires each timer (multi-instance safe). `cancel_timers_for_chat()` drops timers when the user reads or replies. `execute_due_timer()` re-runs the prompt with the chat's context.

### 7. MFA: `utils/mfa.py` (454 LOC), `routers/mfa.py`
- `pyotp` TOTP. The secret is encrypted with Fernet under an HKDF-derived key (`info=b'open-webui/mfa-encryption/v1'`). `matching_step(secret, code, last_step)` stops a code from being replayed within the same 30-second step. There are 10 recovery codes, stored only as SHA-256 hashes.
- Login is a challenge token flow (`start_mfa_login` → `load_challenge(token, kinds, attempt=True)`) with per-account throttling (`limit_account`, event `auth.mfa.throttled`).
- `is_mfa_required(auth_method)` honours `MFA_ALLOW_OAUTH_BYPASS` and `MFA_ALLOW_TRUSTED_HEADER_BYPASS`. The CLI `open-webui mfa reset` issues a one-time recovery token.

### 8. Comments + inbox: `models/comments.py`, `models/notifications.py`, `utils/inbox.py`
- `comment(resource_type, resource_id, parent_id, reply_to_id, content, target_type, target_id, meta, deleted_at)`. `target_*` anchors a comment to a passage, such as a message selection or a note page. Reactions live in a separate `comment_reaction` table.
- `notification(user_id, event_type, event_key, actor_*, resource_*, object_*, data, seen_at, read_at)`. Inbox rows are derived from events (`consume_event`). Mentions are parsed from content (`mentioned_users`). `eligible_recipients()` and `visible_clause()` show a notification only to users who can still open the resource.

### 9. HITL approval and ask-user resume: `utils/tool_approval.py`, `utils/ask_user.py`
- Tool calls are stored as Responses-style `output[]` items with status `pending | queued | requires_approval | in_progress`. `ResolveToolCallForm{call_id, action: approve|reject|answer, answers, timed_out}` resolves one call, and `build_tool_approval_resume_payload()` resumes the run from the saved chat, so approvals survive a reload. iHub's design (docs/tool-approval.md) is at least as rich: it classifies side effects and distrusts an MCP server's claim that a tool only reads.

### 10. Chat variables: `utils/chat_variables.py`
- Inline syntax in the system prompt: `{{chat.variables.key | select options=[...] default=...}}` and `{{user.variables.key}}`. Keys must match `^[a-z][a-z0-9_]*$`. Limits: 20 KB per value, 100 KB in total, JSON depth 32. Values are saved on the chat and copied on fork or clone.

## Ideas worth adopting for iHub (ranked)

1. **Tool search / deferred tool schemas.** Cheapest to build and high leverage now that integrations bind many actions per app and MCP servers add more. Reuse the skills pattern (`activate_skill`): put a name + description manifest in the system prompt, add a `search_tools` tool (BM25 or the existing tokenizer) and a `call_tool` proxy, and keep `tools[]` fixed so the prompt cache prefix stays stable. Settings: `toolSearch.enabled`, `deferThresholdChars`, `alwaysLoaded` patterns. Fits `server/services/chat/RequestBuilder.js` and the agent loop's tool matching. The server should still send `tool/started` with the real tool's title, following the "server decides" rule.
2. **LLM-summary compaction with stored checkpoints.** Add a summarizing pass on top of the current microcompaction in `contextCompaction.js`. It triggers on the provider-reported prompt usage against the model's `contextWindow`, cuts at a user-turn or tool-batch boundary, and saves the summary as a run-ledger event or message checkpoint that later turns start from. Add a user `/compact` command and a visible "earlier turns summarized" marker. This keeps long chats and scheduled-task chats working on small-context local models.
3. **Personal memory for chat users.** Extend `memoryService` with a `{kind:'user', userId}` scope. Allow it per app, keep it off by default and gate it by group permission. Add a Settings → Memory editor (reuse `MemoryEditor.jsx`) and an optional background review every N turns that emits add/replace/remove operations. Respect PII rules (docs/pii-data-handling.md): never store secrets, and give users a full view and delete.
4. **TOTP two-factor for local accounts.** Enterprise tenders ask for it, and the default local admin makes it urgent. Encrypt secrets with the existing `TokenStorageService` key, store recovery codes as hashes, add a replay guard (last step), throttling, a bypass for OIDC/proxy/LDAP sign-ins and an admin-side reset. Every step should be written to the audit log.
5. **Outbound event webhooks / SIEM forwarding.** iHub already writes an audit log. Publish those events to admin-configured webhooks with event filters and group targets: Teams/Slack payload shapes plus generic JSON or CloudEvents. Use `httpFetch()` for the SSL whitelist and proxy (CLAUDE.md) and add SSRF protection. Typical targets are scheduled-task failures, sign-ins and config changes.
6. **Dynamic sub-agent delegation.** Add a `delegate_task` built-in on top of `invokeAppInternal` (it already runs `kind:'subagent'`). The parent passes an ad-hoc task and context. It can run in parallel under `maxConcurrent` and `maxIterations` limits, with an optional background mode whose summary is injected later. Admins choose which apps or models a parent may delegate to.
7. **Fork a chat from a response + side chat ("/btw").** Both are cheap once chat persistence exists. A fork copies the history up to a message ID into a new chat with `forkedFrom`. A side chat is a temporary chat seeded with the current transcript and never saved back.
8. **Interactive shared chats.** Let recipients of a signed-in share link continue the chat as their own fork ("Continue in my chats"). Full multi-user co-editing with live presence comes later.
9. **Full-text chat search.** Search the stored message text (not only titles), with snippets and jump-to-message.
10. **Chat timers that follow up in the same chat**, with `cancel_on` read or reply, plus a `notify_user` built-in. Reuse the scheduled-task scheduler and its `_notifications` channel.
11. **Admin-defined "model controls"** (named presets such as Fast/Balanced/Deep that map to `thinking.level`, temperature and so on, shown in the composer). **User variables** (`{{user.variables.role}}`, set in Settings).
12. Lower priority: comment threads and a general inbox on chats, prompts and skills; a personal usage page; KB directory sync; an admin UI for locale overrides.
