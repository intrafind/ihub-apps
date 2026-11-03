# Competitor Feature Research — Open WebUI, LibreChat, AnythingLLM

**Date:** 2026-11-03
**Status:** Research + proposal
**iHub baseline:** `main` at `4071b02` (v5.6.4)

## Goal

Three open-source chat platforms ship new features every few weeks. This research reads their
changelogs for the last six months, picks the notable features, checks each one against iHub and
reads the upstream code for the most interesting ones. The result is a ranked list of what iHub
should build next.

| Document | Contents |
| --- | --- |
| [01-open-webui.md](01-open-webui.md) | Open WebUI 0.9.3 → 0.13.0 (2026-05-09 → 2026-11-02), 32 features, 10 code deep-dives |
| [02-librechat.md](02-librechat.md) | LibreChat v0.8.6 → v0.8.9-rc1 (2026-05-13 → 2026-10-26), 33 features, 10 code deep-dives |
| [03-anythingllm.md](03-anythingllm.md) | AnythingLLM v1.13.0 → v1.19.0 (2026-05-26 → 2026-10-26), 27 features, 9 code deep-dives |

Each detail document has a feature table with an iHub status (HAVE / PARTIAL / MISSING) and the
file or doc that backs it, the code deep-dives with upstream file paths, and that competitor's
own ranked ideas. The upstream code was read from shallow clones and never run.

## Where the market is going

All three are moving the same way, and fast:

1. **From chat to agent harness.** Sub-agents, background tasks, tool search, LLM-summary
   compaction, steering a running turn, human-in-the-loop approval, ask-user questions.
2. **Personalisation.** Every one of them shipped long-term memory about the user in this period.
3. **Governance for enterprises.** MFA/passkeys, DLP filters, outbound event webhooks, cost
   tracking, pattern rules for tool approval, version history.
4. **Collaboration (Open WebUI mainly).** Shared chat folders, comments, an inbox, live presence.

## Where iHub is on par or ahead

Verified against the iHub code, not just the docs:

| Area | iHub |
| --- | --- |
| Tool approval | Side-effect and data-flow classification, MCP annotations treated as untrusted, per-chat "allow", 24 h expiry (`docs/tool-approval.md`). Stronger than all three; AnythingLLM auto-approves every tool in scheduled jobs. |
| Ask-user, resumable runs | `docs/ask-user-tool.md`, `docs/chat-persistence.md`, run ledger |
| Scheduled tasks | Cron, run memory, unseen badge, creating tasks from a chat (`docs/scheduled-tasks.md`). More mature than LibreChat's beta "Scheduled Chats". |
| MCP | Client with per-user OAuth, MCP Apps host, **and** iHub as an MCP server/gateway with DCR. None of the three is a gateway. |
| A2A, workflows, skills | Inbound and outbound A2A, visual workflows, skills with versions and marketplace import |
| Office output | PDF/Word/PowerPoint/Excel with corporate templates (`docs/document-templates.md`) |
| Channels | M365 Copilot agent, Outlook add-in, Nextcloud, browser extension, OpenAI-compatible API |
| Sovereignty | iFinder, LDAP/NTLM/OIDC/proxy auth, encrypted secrets, EU AI Act content marking |

## The gaps, merged across the three

"Seen in" counts how many of the three ship the feature. Status was checked in the iHub code.

| # | Capability | Seen in | iHub today | Verified at |
| --- | --- | --- | --- | --- |
| G1 | **Personal memory for chat users** | OWUI, LC, ALLM | Memory exists only for agents and scheduled tasks | `server/services/memory/memoryService.js:10-14` (scopes `agent`, `scheduled-task`) |
| G2 | **Tool search / sending only the relevant tools** | OWUI, LC, ALLM | All bound tools go into every request | no `search_tools` / deferral code in `server/` |
| G3 | **LLM-summary compaction** | OWUI, LC | Old tool bodies are collapsed only; no summary, no `/compact` | `server/services/loop/contextCompaction.js` |
| G4 | **Steer / queue while a turn runs** | LC (OWUI queues) | Server API and client endpoint exist; no UI calls them | `server/services/loop/steering.js`, `sendHumanEvent` in `client/src/api/endpoints/runs.js` has no caller |
| G5 | **Sub-agent delegation + background tasks** | OWUI, LC | Apps as tools only; delegation listed as out of scope | `docs/agents.md`, `invokeAppInternal` |
| G6 | **Model router** | ALLM | Concept only | `concepts/2026-10-20 Automatic Model Selection.md` (Proposal) |
| G7 | **Input DLP / secret filter** | LC | Retention and anonymisation of *stored* PII only | `docs/pii-data-handling.md` |
| G8 | **TOTP / passkeys for local accounts** | OWUI, LC | None | `server/middleware/localAuth.js` |
| G9 | **Outbound event webhooks / SIEM** | OWUI | Inbound webhook triggers, audit log, OTel only | `docs/workflows.md`, `docs/telemetry.md` |
| G10 | **MCP single sign-on (token exchange)** | LC | Token exchange exists for iFinder only | `server/services/integrations/iFinderTokenProvider.js` |
| G11 | **Model pricing and cost display** | LC | Token counts only, no prices | `server/validators/modelConfigSchema.js` |
| G12 | **Chat UX**: fork, side chat, pinned chats, full-text search, continue a shared chat | OWUI, LC | Search covers titles and app names only; no fork or pin | `docs/chat-persistence.md:285`, `docs/chat-sharing.md:7` |
| G13 | **Office previews in Artifacts** | LC | "Word, PowerPoint, Excel … have no preview" although `mammoth`/`xlsx` ship in the client | `docs/artifacts.md:251` |
| G14 | **Website chat widget** | ALLM | Iframe embed of shared chats/files only | `docs/chat-sharing.md` |
| G15 | **Web push notifications** | ALLM | Service worker without Push API | `client/src/services/swRegistration.js` |
| G16 | **Same-chat follow-ups ("remind me in 2 h")** | OWUI | Scheduled tasks run as separate task chats | `docs/scheduled-tasks.md` |
| G17 | **M365 mail and calendar actions** | ALLM | Outlook add-in gives context; O365 covers files only | `docs/office365-integration.md` |
| G18 | **Admin tool hooks and glob approval rules** | LC | Internal `preTool`/`postTool` seams, not configurable | `server/services/loop/AgentLoop.js` |

Deliberately left out: code interpreter, terminals and computer use (large security surface, and
not what iHub's users ask for today; revisit with a sandbox concept), a built-in local LLM in the
Docker image, Telegram, E2E-encrypted channels, vector RAG for projects (BM25 + iFinder is a
deliberate choice).

## Proposals

Effort: **S** ≈ days, **M** ≈ 1–3 weeks, **L** ≈ a month or more.

### Tier 1 — build next

#### P1. Personal memory ("iHub remembers") — M
All three competitors shipped it. iHub already has the hard part: `memoryService` with scoped
stores, a memory editor for agents and the compose/finalize pattern for scheduled tasks.

- New scope `{ kind: 'user', userId }`, resolved from the trusted principal only, like the
  existing scopes. Optional partition per app.
- Off by default; enabled per app (`memory: { enabled }`) and allowed per group.
- **Settings → Memory**: users see, edit and delete every entry (reuse `MemoryEditor.jsx`).
- Injection into the system prompt within a character budget.
- Two ways to write: a `remember` tool the model calls when the user asks, and an optional
  extraction pass when a chat has gone idle. Take the extraction rules from Open WebUI
  (`utils/memory.py`): JSON operations add/replace/remove, never store secrets or one-off events,
  prefer replacing over adding duplicates.
- PII fit: a new row in `docs/pii-data-handling.md`, deleted with the account, excluded from
  telemetry.

#### P2. Tool search — M
Integrations and MCP servers now put dozens of actions into an app. Every request carries every
schema, which costs tokens and makes small local models pick the wrong tool.

- Follow Open WebUI's design (`utils/tool_search.py`): tools whose schema is above a threshold go
  into a name + one-line manifest in the system prompt; the model calls `search_tools` (BM25)
  and then `call_tool(name, args)`.
- **The `tools[]` array stays the same during a run**, so the prompt-cache prefix stays stable.
  This is the same principle as `activate_skill`.
- Config: `toolSearch.enabled`, `deferThresholdChars`, `alwaysLoaded` patterns, per app.
- The server still emits `tool/started` with the real tool's title and `activityKind`
  (CLAUDE.md "the server decides").
- Combine with LibreChat's **deferred sign-in**: an MCP server that needs a per-user login asks
  for it only when one of its tools is actually found and called.

#### P3. Steer and queue a running turn — S
The server work is done (`steering.js`, `POST /runs/:id/human-events`). Only the UI is missing.

- While a turn streams, the composer stays active. Enter queues the message as a "pending" chip;
  the server applies it at the next step boundary.
- After a reconnect, show which queued messages were applied (LibreChat's reconnect diff).
- Persist the queue in the run ledger so it survives a server restart (it is in memory today).

#### P4. Compaction with an LLM summary — M
- Trigger on the token usage the provider reports for the last call, measured against the
  model's `contextWindow`, with an optional lower threshold per model.
- Cut only at a user turn or after a complete tool batch, keep the most recent ~40 % verbatim,
  and summarise the rest with "previous summary + dropped turns + recent turns" as input.
- Store the summary as a run-ledger checkpoint that later turns start from.
- `/compact` command and a visible "Earlier messages summarised" marker in the chat.
- Main gain: long chats and long scheduled-task runs keep working on 32k local models.

#### P5. Sensitivity pipeline: DLP filter + model router — M/L
Two separate competitor features (LibreChat's PII filter, AnythingLLM's model router) answer the
same customer question that the [Automatic Model Selection](../2026-10-20%20Automatic%20Model%20Selection.md)
concept already captured: "sensitive data must not leave the house". Build them as **one
pipeline** rather than two:

1. **Detect**: cheap detectors on the user input and attachments (API keys, bearer tokens, IBAN,
   e-mail, admin regex lists), optionally a small local classifier model.
2. **Decide**, per app/group rule: `audit` (log only, the safe rollout default), `route` (switch to
   an on-prem model, using the router concept), `block` (with a message), later `redact`.
3. **Show**: a badge on the answer saying which model was used and why; an audit-log entry.

Borrow AnythingLLM's rule format (contains/regex, token count, attached image, hour) and its
classifier pattern (one forced tool call over an enum of rule names), and keep stickiness per
chat so a conversation does not hop between models.

### Tier 2 — governance for tenders

| # | Proposal | Effort | Notes |
| --- | --- | --- | --- |
| P6 | **TOTP for local accounts** | S/M | Secret encrypted with the existing key, 10 hashed recovery codes, replay guard on the last step, throttling, bypass for OIDC/proxy/LDAP, admin reset, audit entries. The shipped default admin makes this urgent. Passkeys later. |
| P7 | **Outbound event webhooks** | M | Publish audit-log and run events (sign-ins, config changes, failed scheduled tasks, approvals waiting) to admin-defined targets with event filters; Teams/Slack/generic JSON (CloudEvents). Use `httpFetch()` plus SSRF guards. Also the hook for SIEM forwarding. |
| P8 | **MCP SSO auth mode** | M | Generalise `iFinderTokenProvider` (RFC 8693) to an MCP `auth.type: 'sso'`, so servers behind the same IdP need no extra click. Scheduled runs fail closed when no renewable token exists. |
| P9 | **Model pricing and cost** | S/M | Optional `pricing` on models (input/output/cache per million tokens). Cost next to the context indicator and per app/user/group in Usage Reports for chargeback. |
| P10 | **Approval rules and hooks** | M | Glob rules `allow/deny/ask` on `mcp:<server>:<tool>` above the side-effect classes (deny wins); later admin `preTool`/`postTool` HTTP hooks for a central DLP or approval service. |

### Tier 3 — quick UX wins (S each)

- **Fork a chat** from any answer into a new chat linked to its origin; **continue a shared chat**
  as your own fork.
- **Pinned chats** and **full-text chat search** over message text with snippets.
- **Office previews** in the Artifacts panel: DOCX via `mammoth`, XLSX via `xlsx` (both already in
  the client bundle), PPTX as slide text.
- **Long paste becomes an attachment** above a size limit.
- **Side chat** (`/btw`): a temporary chat that sees the current conversation and is never saved
  into it.

### Tier 4 — larger bets to evaluate

| # | Proposal | Effort | Why |
| --- | --- | --- | --- |
| P11 | **Delegation and background tasks** | L | A `delegate_task` built-in on `invokeAppInternal` with concurrency/iteration caps and a background mode that posts the result back into the same chat. The same mechanism gives **same-chat follow-ups** (G16: "check again in 2 h", cancelled when the user replies). |
| P12 | **Website chat widget** | M | `<script>` embed for public sites, deny-by-default origins, quotas per day and session, anonymous sessions, locked model and prompt. Opens iHub for citizen-service portals (public sector). |
| P13 | **Web push** | S/M | For finished scheduled tasks, waiting approvals and P11 results. |
| P14 | **M365 mail and calendar actions** | M | Search, read, draft and — behind tool approval showing recipients and body — send; calendar lookup. Meeting transcripts → tasks with due dates (AnythingLLM's Meeting Assistant) builds on top. |

## Suggested order

1. **Now (one sprint):** P3 steer UI, Office previews, pinned chats, fork chat — visible, small.
2. **Next:** P1 memory and P2 tool search in parallel; P6 TOTP.
3. **Then:** P4 compaction, P5 sensitivity pipeline (refresh the model router concept first),
   P9 pricing.
4. **Evaluate:** P7, P8, P10–P14 against customer demand.

Each item that goes ahead gets its own concept document and GitHub issue.
