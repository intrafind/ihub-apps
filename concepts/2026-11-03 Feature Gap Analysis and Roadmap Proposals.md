# Feature Gap Analysis and Roadmap Proposals

**Date:** 2026-11-03
**Status:** Research + proposal
**iHub baseline:** `main` at `4071b02` (v5.6.4)

## Goal

AI chat and agent platforms are evolving quickly. This document looks at the capabilities that
have become common in the market over the last six months, checks each one against iHub's code,
and turns the gaps into a ranked list of features for iHub. Each feature has a GitHub issue.

## Where the market is going

1. **From chat to agent runtime.** Sub-agents, background tasks, tool search, LLM-summary
   compaction, steering a running turn, human-in-the-loop approval, ask-user questions.
2. **Personalisation.** Long-term memory about the user is becoming a standard feature.
3. **Governance for enterprises.** Second factor for local accounts, input filters for secrets
   and personal data, outbound event webhooks, cost tracking, pattern rules for tool approval,
   version history.
4. **Collaboration.** Shared chat folders, forking and continuing shared chats, comments,
   notification inboxes.

## Where iHub is strong

| Area | iHub |
| --- | --- |
| Tool approval | Side-effect and data-flow classification, MCP annotations treated as untrusted, per-chat "allow", 24 h expiry, no silent auto-approval in unattended runs (`docs/tool-approval.md`). |
| Ask-user, resumable runs | `docs/ask-user-tool.md`, `docs/chat-persistence.md`, run ledger |
| Scheduled tasks | Cron, memory between runs, unseen badge, creating tasks from a chat (`docs/scheduled-tasks.md`). |
| MCP | Client with per-user OAuth, MCP Apps host, **and** iHub as an MCP server/gateway with DCR and per-client governance. |
| A2A, workflows, skills | Inbound and outbound A2A, visual workflows, skills with versions and marketplace import |
| Office output | PDF/Word/PowerPoint/Excel with corporate templates (`docs/document-templates.md`) |
| Channels | M365 Copilot agent, Outlook add-in, Nextcloud, browser extension, OpenAI-compatible API |
| Sovereignty | iFinder, LDAP/NTLM/OIDC/proxy auth, encrypted secrets, EU AI Act content marking |

## Gaps

Status was checked in the iHub code.

| # | Capability | iHub today | Verified at | Issue |
| --- | --- | --- | --- | --- |
| G1 | **Personal memory for chat users** | Memory exists only for agents and scheduled tasks | `server/services/memory/memoryService.js` (scopes `agent`, `scheduled-task`) | #2522 |
| G2 | **Tool search** (send only the relevant tools) | All bound tools go into every request | `server/services/chat/RequestBuilder.js` | #2889 |
| G3 | **LLM-summary compaction** | Old tool bodies are collapsed only; no summary, no `/compact` | `server/services/loop/contextCompaction.js` | #3192 |
| G4 | **Steer / queue while a turn runs** | Server API and client endpoint exist; no UI calls them | `server/services/loop/steering.js`, `sendHumanEvent` in `client/src/api/endpoints/runs.js` has no caller | #3191 |
| G5 | **Sub-agent delegation and background tasks** | Apps as tools only; delegation listed as out of scope | `docs/agents.md`, `invokeAppInternal` | #3196 |
| G6 | **Model router** | Concept only | `concepts/2026-10-20 Automatic Model Selection.md` | #2900 |
| G7 | **Input filter for secrets and personal data** | Retention and anonymisation of *stored* PII only | `docs/pii-data-handling.md` | #1500, #2411 |
| G8 | **Second factor for local accounts** | None | `server/middleware/localAuth.js` | #3193 |
| G9 | **Outbound event webhooks** | Inbound webhook triggers, audit log, OTel only | `docs/workflows.md`, `docs/telemetry.md` | #3200 (SIEM: #2408) |
| G10 | **MCP single sign-on (token exchange)** | Token exchange exists for iFinder only | `server/services/integrations/iFinderTokenProvider.js` | #3194 |
| G11 | **Model pricing and cost display** | Token counts only, no prices | `server/validators/modelConfigSchema.js` | #2401 |
| G12 | **Chat UX**: fork, side chat, pinned chats, full-text search, continue a shared chat | Search covers titles and app names only; no fork or pin; shared chats are read-only | `docs/chat-persistence.md`, `docs/chat-sharing.md` | #3201, #3205, #3202, #2315 |
| G13 | **Office previews in Artifacts** | "Word, PowerPoint, Excel … have no preview" although `mammoth`/`xlsx` ship in the client | `docs/artifacts.md` | #3203 |
| G14 | **Website chat widget** | Iframe embed of shared chats/files only | `docs/chat-sharing.md` | #1510 |
| G15 | **Browser push notifications** | Service worker without Push API | `client/src/services/swRegistration.js` | #3198 |
| G16 | **Same-chat follow-ups** ("check again in 2 h") | Scheduled tasks run as separate task chats | `docs/scheduled-tasks.md` | #3197 |
| G17 | **M365 mail and calendar actions** | Outlook add-in gives context; Office 365 covers files only | `docs/office365-integration.md` | #3199 |
| G18 | **Pattern rules for tool approval, admin tool hooks** | Internal `preTool`/`postTool` seams, not configurable | `server/services/loop/AgentLoop.js` | #3195 |
| G19 | **Long paste as attachment** | Pasted text always goes into the composer | `client/src/features/chat/components/ChatInput.jsx` | #3204 |

Not proposed for now: a code interpreter, terminals and computer use (large security surface and
not what iHub's users ask for today; revisit with a sandbox concept), a bundled local LLM in the
Docker image, messenger bots, end-to-end-encrypted channels, and vector search for projects
(BM25 plus iFinder is a deliberate choice).

## Proposals

Effort: **S** ≈ days, **M** ≈ 1–3 weeks, **L** ≈ a month or more.

### Tier 1 — build next

#### P1. Personal memory ("iHub remembers") — M · #2522

iHub already has the hard part: `memoryService` with scoped stores, a memory editor for agents
and the compose/finalize pattern for scheduled tasks.

- New scope `{ kind: 'user', userId }`, resolved from the trusted principal only, like the
  existing scopes. Optional partition per app.
- Off by default; enabled per app and allowed per group.
- **Settings → Memory**: users see, edit and delete every entry (reuse `MemoryEditor.jsx`).
- Injection into the system prompt within a character budget.
- Two ways to write: a `remember` tool the model calls when the user asks, and an optional
  extraction pass when a chat has gone idle. The extraction returns JSON operations
  (add/replace/remove) under fixed rules: never store secrets or one-off events, prefer replacing
  over adding duplicates.
- A new row in `docs/pii-data-handling.md`; deleted with the account; excluded from telemetry.

#### P2. Tool search — M · #2889

Integrations and MCP servers put dozens of actions into an app. Every request carries every
schema, which costs tokens and makes small local models pick the wrong tool.

- Tools whose schema is above a threshold go into a name + one-line manifest in the system
  prompt; the model calls `search_tools` (BM25) and then `call_tool(name, args)`.
- **The `tools[]` array stays the same during a run**, so the prompt-cache prefix stays stable.
  Same principle as `activate_skill`.
- Config: `toolSearch.enabled`, `deferThresholdChars`, `alwaysLoaded` patterns, per app.
- The server still emits `tool/started` with the real tool's title and `activityKind`.
- Deferred sign-in: an MCP server that needs a per-user login asks for it only when one of its
  tools is actually found and called.

#### P3. Steer and queue a running turn — S · #3191

The server work is done (`steering.js`, `POST /runs/:id/human-events`). Only the UI is missing.

- While a turn streams, the composer stays active. Enter queues the message as a "pending" chip;
  the server applies it at the next step boundary.
- After a reconnect, show which queued messages were applied while the browser was away.
- Persist the queue in the run ledger so it survives a server restart (it is in memory today).

#### P4. Compaction with an LLM summary — M · #3192

- Trigger on the token usage the provider reports for the last call, measured against the
  model's `contextWindow`, with an optional lower threshold per model.
- Cut only at a user turn or after a complete tool batch, keep the most recent ~40 % verbatim,
  and summarise the rest with "previous summary + dropped turns + recent turns" as input.
- Store the summary as a run-ledger checkpoint that later turns start from.
- `/compact` command and a visible "Earlier messages summarised" marker in the chat.
- Main gain: long chats and long scheduled-task runs keep working on 32k local models.

#### P5. Sensitivity pipeline: input filter + model router — M/L · #2900, #1500, #2411

The input filter and the model router answer the same customer question that the
[Automatic Model Selection](2026-10-20%20Automatic%20Model%20Selection.md) concept captured:
"sensitive data must not leave the house". Build them as **one pipeline**:

1. **Detect**: cheap detectors on the user input and attachments (API keys, bearer tokens, IBAN,
   e-mail, admin regex lists), optionally a small local classifier model.
2. **Decide**, per app/group rule: `audit` (log only, the safe rollout default), `route` (switch to
   an on-prem model), `block` (with a message), later `redact`.
3. **Show**: a badge on the answer saying which model was used and why; an audit-log entry.

Rules can match on content (contains/regex), token count, attached images and time of day; a
semantic rule is decided by a classifier making one forced tool call over an enum of rule names.
Routing is sticky per chat so a conversation does not hop between models.

### Tier 2 — governance for tenders

| # | Proposal | Effort | Issue | Notes |
| --- | --- | --- | --- | --- |
| P6 | **TOTP for local accounts** | S/M | #3193 | Secret encrypted with the existing key, 10 hashed recovery codes, replay guard, throttling, bypass for OIDC/proxy/LDAP, admin reset, audit entries. The shipped default admin makes this urgent. Passkeys later. |
| P7 | **Outbound event webhooks** | M | #3200 | Audit-log and run events (sign-ins, config changes, failed scheduled tasks, approvals waiting) to admin-defined targets with event filters; Teams/Slack/generic JSON. `httpFetch()` plus SSRF guards. |
| P8 | **MCP SSO auth mode** | M | #3194 | Generalise `iFinderTokenProvider` (RFC 8693) to an MCP `auth.type: 'sso'`. Scheduled runs fail closed without a renewable token. |
| P9 | **Model pricing and cost** | S/M | #2401 | Optional `pricing` on models. Cost next to the context indicator and in Usage Reports for chargeback. |
| P10 | **Approval rules and hooks** | M | #3195 | Glob rules `allow/deny/ask` on `mcp:<server>:<tool>` above the side-effect classes (deny wins); admin `preTool`/`postTool` HTTP hooks for a central policy service. |

### Tier 3 — quick UX wins (S each)

| Proposal | Issue |
| --- | --- |
| **Fork a chat** from any answer; **continue a shared chat** as your own copy | #3201 |
| **Pinned chats** | #3202 |
| **Full-text chat search** over message text | #2315 |
| **Office previews** in the Artifacts panel (DOCX via `mammoth`, XLSX via `xlsx`, PPTX as slide text) | #3203 |
| **Long paste becomes an attachment** above a size limit | #3204 |
| **Side chat** (`/btw`): a temporary chat that sees the conversation and is never saved into it | #3205 |

### Tier 4 — larger bets to evaluate

| # | Proposal | Effort | Issue | Why |
| --- | --- | --- | --- | --- |
| P11 | **Delegation and background tasks** | L | #3196 | `delegate_task` on `invokeAppInternal` with concurrency/iteration caps and a background mode that posts the result into the same chat. |
| P12 | **Same-chat follow-ups and notify tool** | M | #3197 | "Check again in 2 h" in the same chat, cancelled when the user replies. Shares delivery with P11. |
| P13 | **Website chat widget** | M | #1510 | `<script>` embed, deny-by-default origins, quotas, anonymous sessions, locked model and prompt. Citizen-service portals in the public sector. |
| P14 | **Browser push** | S/M | #3198 | Finished scheduled tasks, waiting approvals, P11/P12 results. No content in the payload. |
| P15 | **M365 mail and calendar actions** | M | #3199 | Search, read, draft and — behind tool approval with full preview — send; free/busy lookup. Meeting transcripts → tasks with due dates on top. |

## Suggested order

1. **Now (one sprint):** P3 steer UI, Office previews, pinned chats, fork chat — visible and small.
2. **Next:** P1 memory and P2 tool search in parallel; P6 TOTP.
3. **Then:** P4 compaction, P5 sensitivity pipeline (refresh the model router concept first),
   P9 pricing.
4. **Evaluate:** P7, P8, P10–P15 against customer demand.
