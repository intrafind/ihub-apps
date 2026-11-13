# Agent memory: product plan

**Date:** 2026-11-07
**Status:** Product plan derived from the approved design in [`README.md`](README.md). Every decision in README §5, the architecture in §6, the phases in §7 and the answers in §8 are binding here; this document adds personas, user stories, packaging, metrics and a definition of done so the teams can plan sprints. Where the README leaves something unspecified, this document says "to be decided in engineering" rather than inventing a name.
**Issues:** #2522 (personal memory v1), #1039 (memory store; to be closed as a duplicate after Phase 1), #1465 (extraction), #3192 (compaction)
**Related:** `concepts/2026-10-08 Scheduled Task Memory and Run History.md` (the precedent whose decisions D1–D10 and E1–E8 carry over), `research/user_memory_in_chat_apps.md`, `research/current_ihub_memory_audit.md`

This document is written so that someone who has not read the research can pick it up. Section 1 says what we are building and what we are not. Section 2 says for whom. Section 3 says what each phase contains. Section 4 is the backlog: numbered user stories with acceptance criteria. Sections 5–8 cover release packaging, measurement, risks and the definition of done.

---

## 1. Vision and positioning

### 1.1 In one paragraph

iHub Apps gives every signed-in person a **personal memory**: a short, private list of facts and preferences about them ("prefers formal German", "leads the Q4 DMS migration") that the assistant reads at the start of every chat in apps that opt in, that the model can save to when asked, that the platform can fill in the background from what people say, and that the person can see, edit, pause, export and delete on one settings page. Scheduled tasks and agents keep the working notes they already have and gain a reviewed consolidation pass and a list of "lessons". Memory is built on the `memoryService` iHub already runs for scheduled tasks and agents, stays on the customer's own storage provider, is encrypted at rest, is never readable by administrators, and costs the person who benefits from it. It makes the assistant continuous without making it opaque: every entry has a source, a date and a delete button.

### 1.2 Why this matters for an enterprise assistant

Today every chat starts from zero. A person who writes customer emails in formal German tells the assistant so in every chat; a scheduled task that reports "what is new" has notes, but an agent that learned a tool quirk last week has to learn it again. The 2026 products people compare iHub with (ChatGPT, Claude, Copilot, Gemini) all remember across chats, and a Langdock-style memory store has been requested since February (#1039). At the same time, enterprise buyers in German-speaking markets ask the opposite question first: who can read this, where is it stored, can it be switched off, and does it leave with the employee. The positioning is therefore **memory with the governance built in first**: opt-in at platform, app and user level; metadata-only for admins; sensitive categories off by default; a budget the model and the person can both see; and deletion that cascades.

### 1.3 What memory is and is not

Memory is a fourth thing next to three that already exist. The distinction matters because every support question ("I deleted the chat, why does it still know?") comes from mixing them up.

| | Personal memory (Phases 1–2) | Chat history | Projects / knowledge | Task and agent notes (exist; Phase 4 adds lessons) | Compaction summary (Phase 3) |
|---|---|---|---|---|---|
| What it holds | Selected, reusable facts and preferences about the person, as discrete entries | Full transcripts of each chat | Documents and instructions curated for retrieval and cited answers | The task's or agent's own working notes between runs, as free text | A rolling summary of the older part of one chat |
| Who writes it | The model through `memory_save` when asked; background extraction (Phase 2); the person on Settings → Memory | The chat itself | Admins, or the project owner for user projects | The model during a run (`memory_write`) and the composer after it | The platform, automatically or on `/compact` |
| Who reads it | The person's own chats in apps with `memory.mode` ≠ `off`; scheduled runs only when the task opts in, read-only | The chat it belongs to | Every user of the app or project | The task's runs; the agent's runs | The chat it belongs to |
| Who can see it | The person only; admins see counts, sizes and dates | The person; admins through the run ledger | Everyone with access | The owner (task) or admins (agent); task notes are owner-only | The person, through the "Earlier messages summarised" marker |
| Lifetime | Until the person deletes it or `retentionDays` expires it | Chat retention policy | Until removed | Until cleared or the task/agent is deleted | Volatile; regenerated; never becomes a memory record |
| Where | `user-memory` namespace, one document per person (plus app or project partitions) | `chats/<id>`, `chat-messages/<id>` | Project namespaces | `scheduled-task-memory`; `agent-memory` after Phase 0 | Run ledger checkpoint |

Three rules follow and go into `docs/memory.md` verbatim:

1. **Deleting a chat does not delete memories learned from it, and clearing memory does not delete chats.**
2. **Memory is data about the person, not instructions.** The prompt says so; the tool-approval policy, not memory, is the enforcement layer.
3. **A summary is never a memory.** Compaction summaries live in the run ledger and only reach memory through the extractor's operations.

---

## 2. Personas and jobs-to-be-done

| Persona | Who they are in iHub terms | Jobs to be done | What would make them stop using it |
|---|---|---|---|
| **Knowledge worker** (Anna, legal team) | Authenticated user of the default `chat` app and a few specialised apps; never opens admin pages | Stop repeating herself about language, tone, role and current project. Correct the assistant once and have it stick. See and remove what it remembers. Keep a one-off sensitive chat out of memory. | It remembers trivia or wrong facts; she cannot find or delete an entry; it brings up something she said in a chat she thought was private. |
| **Power user with scheduled tasks and agents** (Jonas, market intelligence) | Owns scheduled tasks with "Remember between runs" on, builds agent profiles, uses projects | Have his weekly reports only say what is new. Have the task know his reporting preferences without re-stating them. Review what the platform changed in his task's notes before it takes effect. Have an agent remember a tool workaround. | Notes drift or lose a watermark; a run writes something into his personal profile; a consolidation silently rewrote his notes. |
| **Admin / compliance officer** (Mehmet, IT security and data protection) | Platform admin; answers the works council and the DPO; runs upgrades | Turn memory on only for the groups and apps it is wanted for. Prove that admins cannot read personal memory. Bound the cost. Answer an access or erasure request. Know what an upgrade changes. | A hidden switch; memory text in a log or ledger he can open; unbounded LLM calls; a breaking change he found out about from a user. |
| **Tenant owner / customer sponsor** (Claudia, head of digital workplace) | Decides whether the feature is rolled out; reads adoption and cost reports | Show adoption and value to the business. Keep cost per user predictable. Roll out in stages (pilot group → everyone). | No numbers; surprise cost; users complain about creepy behaviour. |

Agents and scheduled runs are **not** personas with memory of their own person: a scheduled run acts as its owner but may only read, never write, personal memory (README Decision 9); agents, sub-agents, anonymous users, OAuth clients and delegated tokens get no personal memory at all.

---

## 3. Scope per phase

Phase sizes and order are the README's: Phase 0 (M) and Phase 1 (M) ship together; Phase 2 (M) and Phase 3 (M) follow and are independent of each other; Phase 4 (L) is last. Each phase closes one issue.

### Phase 0 — Prerequisites (no new user capability)

**Goal.** Make the existing memory plumbing ready for entries, a third scope, review and consolidation without changing what scheduled tasks and agents do today.

| | |
|---|---|
| **What the user sees** | Nothing new in chat. Agent and scheduled-task run views show memory reads and writes as a "memory" activity row instead of a generic tool row. |
| **What admins see** | Agent memory files move from `contents/agents/memory/<id>.md` onto the storage provider (`agent-memory` namespace); the agent/task tools `read_memory`/`write_memory` are renamed `memory_read`/`memory_write` by migration; the admin agent memory editor keeps working. Both are breaking changes called out in `docs/releases/next/breaking-changes.md`. |
| **Non-goals** | No personal memory, no `<user_memory>` block, no Settings page. |
| **Hidden but binding** | The run-ledger placeholder rule for memory blocks (README §6.7): the ledger stores `<user_memory ref= sha256= chars=/>`, never the text. Phase 1 depends on it. |

### Phase 1 — Personal memory v1 (#2522)

**Goal.** Explicit memory: the model saves when asked, the person manages a list, the block is injected within a budget, admins gate it. No background extraction.

| | |
|---|---|
| **What the user sees** | "Remember that …" works in apps with memory on; a "Memory updated · *text*" chip with **Undo** under the message; a subtle "Recalled N memories" header chip; a per-chat "Memory off" toggle; **Settings → Memory** with list, filter, edit, delete, add, delete all, counter `12 / 100`, pause, export, "Include sensitive topics" opt-in, and tabs for the account store and any app or project partitions. |
| **What admins see** | **Admin → Memory** (`AdminMemoryPage.jsx`): platform settings (`platform.memory.*`), a per-user metadata view (entries, chars, updated, paused) with **Clear**; a **Memory** section in the app editor (`enabled`, `mode`, `partition`); the `memory` permission in the group editor; the feature flag `userMemory`. |
| **Scheduled tasks** | A per-task option `task.memory.usePersonal` (default off) that gives runs the owner's memory block read-only. |
| **Non-goals** | No extraction, no review queue, no import, no retrieval or ranking, no shared memory, no admin content viewer. |

### Phase 2 — Automatic extraction and review (#1465)

**Goal.** The platform notices durable facts the person states and proposes or saves them in the background, within a daily budget, with review optional or required.

| | |
|---|---|
| **What the user sees** | After a chat turn, a "Memory updated" chip appears on the assistant message (when the message is next rendered, or live via polling) listing what was added, updated or invalidated, each with Undo; a **Review before saving** switch and a **Pending** tab on Settings → Memory with Accept/Reject; **Import** of a pasted memory summary from another assistant; a "memory" line on the Usage page. |
| **What admins see** | `platform.memory.extraction.*` settings (enabled, model, daily cap per user, input cap, debounce, `reviewMode: off \| optional \| required`); the usage report shows `surface: 'memory'` cost per user. |
| **Non-goals** | No embeddings, no per-message retrieval, no extraction inside scheduled runs or agents, no admin review of other people's pending entries. |

### Phase 3 — LLM compaction (#3192)

**Goal.** Long chats and long runs keep working past the context window by summarising the older part, and memory is flushed before turns are dropped.

| | |
|---|---|
| **What the user sees** | An "Earlier messages summarised" marker that expands to the summary; a `/compact` command; the context indicator drops after compaction; nothing from the dropped turns is lost from the stored transcript. |
| **What admins see** | `policies.context.summaryThresholdRatio` (default 0.8) and the summary model setting; the run ledger records each compaction (which turns, model, tokens before and after). |
| **Non-goals** | Summaries are not memories, not searchable, not exported with memory. |

### Phase 4 — Consolidation ("dreaming") and lessons for tasks and agents

**Goal.** A nightly, reviewable pass that merges and tidies the free-text notes of busy scheduled tasks and agent profiles and proposes procedural "lessons", never applied without a human unless the admin allows notes-only auto-apply.

| | |
|---|---|
| **What the user sees** | Task owners: a "Consolidated notes ready" card on the task page with a diff and **Apply** / **Discard**; a `<lessons>` list the run reads after its notes; lessons proposed from the owner's own corrections. |
| **What admins see** | The same proposal card on the admin agent memory page; `platform.memory.consolidation.*` (enabled, model, `minRunsSinceLast`, `maxRunsRead`, `autoApply: never \| notes-only`); per-profile `memory.writeApproval` to stage agent writes for review. |
| **Non-goals** | No consolidation of personal entries (write-time ADD/UPDATE/INVALIDATE/NOOP keeps them clean until data says otherwise); no cross-task or cross-agent lessons. |

### Explicitly out of scope for all four phases

- **Ranked retrieval and embeddings.** The always-on budgeted block is the only read path. A retrieval layer needs a database storage provider first (#2389, #2906) and its own concept.
- **Organisation, team or shared memory**, including admin-curated "facts about the company". Needs a tenant id; separate concept.
- **An admin viewer for memory content**, even for support. Admins get metadata only (README Decision 12).
- **Memory for agents acting on behalf of a user, sub-agents, anonymous users, OAuth clients and delegated tokens.**
- **Per-topic memory spaces** beyond the app and project partitions.
- **Consented impersonation** for support (SaaS plan, future).
- **A generic job queue** (#1495). Extraction uses a detached post-turn handler; consolidation uses the nightly sweep pattern.

---

## 4. User stories and acceptance criteria

Numbering: `P<phase>-US-<nn>`. Each story carries the surface it belongs to. "Given/When/Then" is what the acceptance test asserts; the test layer (unit, route, e2e) is noted where the README names one. Names of files, keys, tools and error codes are the README's.

### 4.1 Phase 0 — prerequisites

| # | Surface | Story |
|---|---|---|
| **P0-US-01** | Admin, agents, scheduled tasks (breaking change) | As an admin who maintains agent profiles, apps and scheduled tasks, I want the tool rename `read_memory` → `memory_read` and `write_memory` → `memory_write` applied to my configuration by the upgrade, so that nothing I configured stops working and I learn about the change from the release notes, not from a failed run. |
| **P0-US-02** | Admin (breaking change) | As an admin who has edited `contents/agents/memory/<profileId>.md` on disk, I want the upgrade to import those files into the `agent-memory` namespace once and tell me the file is no longer read, so that I do not keep editing a dead file. |
| **P0-US-03** | Agents / workflows | As an agent author, I want two concurrent end-of-run memory writes to both land (or one to retry with a fresh read) instead of the last one silently winning, so that an agent that ran twice at once does not lose a run's notes. |
| **P0-US-04** | Chat, scheduled tasks (run view) | As a user viewing a run, I want memory reads and writes to appear as a "memory" activity row with the server-provided label, so that I can tell a memory write from a web search. |
| **P0-US-05** | Admin / compliance | As a compliance officer, I want the run ledger to store a placeholder for any injected memory block instead of its text, so that the "admins see metadata only" promise holds from the first day personal memory ships. |
| **P0-US-06** | Admin (API) | As an API consumer of the scheduled-task memory routes, I want version conflicts returned as `409` `VERSION_CONFLICT` in problem+json like every other error, so that my client handles one error shape. |

**Acceptance criteria**

- **P0-US-01.** Given an agent profile, an app `tools` array or a scheduled-task tool allowlist naming `read_memory` or `write_memory`, when the migration `V{NNN}__rename_memory_tools.js` runs, then the ids read `memory_read` / `memory_write`, `contents/tools/{read,write}_memory.json` are renamed, no alias for the old ids exists, and a fixture with the old ids migrates cleanly in the migration test. Given the release, when an admin opens the changelog, then `docs/releases/next/breaking-changes.md` names both old and new ids and says that profiles, apps and tasks are migrated automatically and that external callers (MCP clients, scripts) that name the old ids must change.
- **P0-US-02.** Given one or more files in `contents/agents/memory/`, when the server starts after the upgrade, then each is imported into `agent-memory` once, a later edit of the file has no effect on any run, and the breaking-change note states this. Given an agent memory write larger than `maxChars`, when it is attempted, then it is rejected with `MEMORY_TOO_LONG` (the missing write cap).
- **P0-US-03.** Given two `memory-finalize` nodes writing the same profile's memory with the same `expectedVersion`, when both complete, then one succeeds, the other re-reads once and retries, and the test asserts no write is lost.
- **P0-US-04.** Given a run that calls `memory_read` or `memory_write`, when `tool/started` is emitted, then it carries `activityKind: 'memory'` declared in `sseV2.js`, the shared reducer folds it, and a reopened chat shows the same row (CLAUDE.md "the server decides, the client renders").
- **P0-US-05.** Given a chat turn whose prompt contained a memory block, when the ledger records `request/header`, then the block appears as `<user_memory ref="v12" sha256="…" chars="…"/>` while `messagesHash` covers the real text. Given the owner replays the run with an unchanged store, then the block is rebuilt and the hash verified; given any later edit, clear, retention or account deletion, then the viewer shows `[personal memory v12, 3,812 chars, changed since]` and a grep of stored events and spill blobs finds no entry text.
- **P0-US-06.** Given a stale `expectedVersion` on `PUT /api/scheduled-tasks/:taskId/memory`, when the write is rejected, then the response is `409` with `code: VERSION_CONFLICT` and `application/problem+json`; `MemoryEditor.jsx` handles it. Whether a transition shim for the old `{ error: 'VERSION_CONFLICT' }` body is kept is **asked, not assumed** (CLAUDE.md "Breaking Changes").
- **Phase 0 cross-cutting.** Given the `postTurn` hook, when a registered handler is slow or throws, then `run/ended` is not delayed and the turn's result is unaffected.

### 4.2 Phase 1 — personal memory v1

#### Chat

| # | Story |
|---|---|
| **P1-US-01** | As a knowledge worker, I want to say "remember that I write customer emails in formal German" and have it saved, so that I never say it again. |
| **P1-US-02** | As a knowledge worker, I want a new chat in another memory-enabled app to already know my saved preferences, so that the assistant is continuous across apps. |
| **P1-US-03** | As a knowledge worker, I want to say "actually I moved to the sales team" or "forget my old job title" and have the entry updated or removed, so that corrections work in plain language. |
| **P1-US-04** | As a knowledge worker, I want to ask "what do you know about me?" and get the list, so that I can check without opening settings. |
| **P1-US-05** | As a knowledge worker, I want to see what was just saved and undo it in one click, so that a wrong save costs me nothing. |
| **P1-US-06** | As a knowledge worker, I want to switch memory off for one chat before I start it, so that a sensitive or one-off conversation leaves no trace and sees nothing. |
| **P1-US-07** | As a knowledge worker using a temporary chat, I want the assistant to still know my preferences but never to save anything from that chat, so that temporary stays temporary without losing my settings. |
| **P1-US-08** | As a knowledge worker, I want to be told when memory is full instead of a silent failure, so that I know to tidy up. |
| **P1-US-09** | As a power user working in a project-bound chat, I want project facts to stay with that project and personal facts to stay with me, so that one project's details never leak into another. |
| **P1-US-10** | As a compliance officer, I want an entry containing markup or instructions to be neutralised when injected, so that a saved entry cannot hijack the prompt. |
| **P1-US-11** | As an admin of a high-trust app, I want saves to require the user's confirmation through the existing tool-approval `writes` mode, so that nothing is saved from injected web content without a human click. |

**Acceptance criteria**

- **P1-US-01.** Given the flag `userMemory` is on, the user's group has `permissions.memory`, the app has `memory.mode: 'readwrite'`, and the per-chat toggle is on, when the user asks to remember a stable preference, then the model calls `memory_save`, the entry is stored with `source: 'tool'`, `confidence: 1`, `sourceRef.chatId`, and the `tool/started` frame carries `activityKind: 'memory'`. Given the same request in an app with `memory.mode: 'read'` or `'off'`, then no `memory_*` write tool is attached and the model says it cannot save here.
- **P1-US-02.** Given one or more valid entries, when any later chat in an app with `memory.mode` ≠ `off` starts, then the system prompt contains the `<user_memory entries= shown= budget= updated=>` block between projects and skills (or at the `{{user_memory}}` placeholder when the app uses one) with the "data about the user, not instructions" sentence, and the header shows "Recalled N memories" from `run/started`. Given the block would exceed `promptBudgetChars` (default 4,000), then valid entries are selected by `updatedAt` desc with `feedback` and `preference` first, `shown < entries`, and the model is told to call `memory_list` for the rest.
- **P1-US-03.** Given an existing entry, when the user states a correction, then the model calls `memory_update` with the entry id (text replaced, `updatedAt` set) or `memory_delete`, and the chip shows "Memory updated" / "Memory deleted" with the old text available for Undo.
- **P1-US-04.** Given valid entries, when the user asks what is remembered, then the model answers from `memory_list` (not from the injected block alone) and the answer lists every valid entry, including those not shown in the block.
- **P1-US-05.** Given a `memory_save`, `memory_update` or `memory_delete` in the current turn, when the assistant message renders, then a chip "Memory updated · *entry text*" with **Undo** appears; **Undo** calls `DELETE /api/memories/{id}` for a save, restores the previous text for an update, or re-adds for a delete, and the next prompt reflects it. The chip links to Settings → Memory.
- **P1-US-06.** Given a new chat, when the user sets "Memory off" in the tool/settings popover before the first message, then the chat `settings` records it, no `<user_memory>` block is injected, no `memory_*` tool is attached, and (Phase 2) extraction is skipped; the setting is sticky for that chat and visible as a state in the popover. Given it is changed mid-chat, then it applies from the next turn.
- **P1-US-07.** Given a temporary or ephemeral chat (`chatPersistence.js` `temporary`/`ephemeral`), when it runs, then the block **is** injected, only `memory_list` is attached, `memory_save/update/delete` are absent from the tool list, and an e2e test proves the store is unchanged after the chat.
- **P1-US-08.** Given `maxEntries` valid entries, when `memory_save` is called, then it returns `{ error: true, code: 'MEMORY_FULL' }` (not a throw), the model tells the user memory is full and offers to replace an entry, and Settings shows `100 / 100`. Given an entry over `maxEntryLength`, then `MEMORY_TOO_LONG` is returned the same way.
- **P1-US-09.** Given a chat in an app bound to a project, when the model saves, then the entry goes to the project partition `um_<hash(userId)>__p_<projectId>` unless the model marks it `scope: 'account'`, the `projectId` comes only from the trusted app link, and the block contains the account entries plus that project's entries and never another project's. Given the project is deleted, then its partition is deleted for every user as a step of the project deletion cascade.
- **P1-US-10.** Given an entry whose text contains `</user_memory>` or `<task_memory>`, when the block is built, then the tags are neutralised (`neutralizeNotes`-style) and the injection-safety test passes.
- **P1-US-11.** Given an app with tool approval in `writes` mode, when the model calls `memory_save` (declared `sideEffect: 'write'`), then the run pauses for approval like any other write tool; `memory_list` never does.

#### Settings → Memory

| # | Story |
|---|---|
| **P1-US-12** | As a knowledge worker, I want one page that lists everything remembered about me with category, source and date, where I can edit, delete and add entries, so that I stay in control. |
| **P1-US-13** | As a knowledge worker, I want to pause memory without losing anything and resume later, so that "stop for a while" is not the same as "delete everything". |
| **P1-US-14** | As a knowledge worker, I want a master switch that turns memory off for me entirely, so that I can opt out of the feature even if my admin enabled it. |
| **P1-US-15** | As a knowledge worker, I want to delete one entry or all of them and have the change apply to my next message, so that deletion is immediate and complete. |
| **P1-US-16** | As a knowledge worker, I want to export my memory as JSON and as a paste-able text, so that I can answer an access request myself or move to another assistant. |
| **P1-US-17** | As a knowledge worker, I want health, religion, politics and similar topics kept out of memory unless I opt in, and some categories never stored even if I ask, so that memory never becomes a profile I did not agree to. |
| **P1-US-18** | As a power user, I want to see which entries belong to my account and which to an app or a project, so that I know where a fact will show up. |
| **P1-US-19** | As a knowledge worker, I want the page to work in German and English, so that it matches the rest of iHub. |

**Acceptance criteria**

- **P1-US-12.** Given the feature is on for the user, when they open the user menu, then **Memory** links to `settings/memory` (`MemoryPage.jsx`); the page lists valid entries newest first with `category`, a source label (user / chat / extraction / import) and the chat it came from where available, filters by category, edits inline (`PATCH /api/memories/{id}`), deletes (`DELETE /api/memories/{id}`), adds (`POST /api/memories`, `source: 'user'`) and shows the counter `n / maxEntries`. Given the flag is off or the user lacks `permissions.memory`, then the link is absent and the route answers `403` `MEMORY_DISABLED`.
- **P1-US-13.** Given entries exist, when the user sets **Pause** (`PATCH /api/memory-preferences { paused: true }`), then no block is injected, no `memory_*` tool is attached, extraction (Phase 2) does not run, every entry is kept, the page shows the paused state, and **Resume** restores reading and writing with nothing lost. Pause increments `controlsVersion`.
- **P1-US-14.** Given entries exist, when the user turns the master switch off (`enabled: false`), then the effect is that of Pause plus: the per-chat toggle and the "Recalled" chip are no longer shown in chat, and the page offers "Delete all" next to the switch. Nothing is deleted by the switch itself. (Product decision: Pause is the short-term stop; the master switch is the opt-out; neither is reset.)
- **P1-US-15.** Given an entry, when the user deletes it, then it is gone from the next prompt of any open chat and from `GET /api/memories`. Given the user chooses "Delete all" and confirms the dialog, then `DELETE /api/memories` returns `204`, the document is emptied, `controlsVersion` increments, and pending extraction results for that user are dropped (Phase 2).
- **P1-US-16.** Given entries, when the user chooses Export, then `POST /api/memories/_export` returns JSON (all valid entries with id, text, category, source, dates) or a plain-text summary suitable for pasting into another assistant (`format`), and the text format excludes sensitive-category entries unless the user confirms their inclusion.
- **P1-US-17.** Given `platform.memory.sensitiveCategories: 'allowOptIn'` and `sensitiveOptIn: false`, when the model or the user tries to save text matching a sensitive category, then the save is refused with `MEMORY_SENSITIVE_BLOCKED` (400), the chip or page explains why and links to the opt-in. Given the user opts in on Settings (with the notice shown), then those saves succeed and each is labelled on the page. Given text matching the never-stored categories (government ID numbers, criminal history, financial account numbers, immigration status, credentials), when any write path is used, then it is refused regardless of opt-in. Given `sensitiveCategories: 'exclude'`, then the opt-in switch is not offered.
- **P1-US-18.** Given entries in the account store and in one or more app or project partitions, when the page loads, then `GET /api/memories/_partitions` populates tabs for the account store and every partition the user has entries in and may still access; a partition for an app the user can no longer access is not shown and its direct URL answers `403` `PERMISSION_DENIED`; an unknown `appId`/`projectId` answers `404` `MEMORY_PARTITION_NOT_FOUND`, never a fallback to the account store.
- **P1-US-19.** Given the UI language, when any memory surface renders, then all strings come from `memory.*` keys in `en.json` and `de.json`, German uses "Sie", and every `apiErrors.<CODE>` for the new codes exists in both files.

Reference copy (the strings that carry the product rules; final wording in the i18n review):

| Key (illustrative) | English | German |
|---|---|---|
| memory.chip.updated | Memory updated | Gedächtnis aktualisiert |
| memory.chip.undo | Undo | Rückgängig |
| memory.header.recalled | Recalled {n} memories | {n} Einträge aus dem Gedächtnis geladen |
| memory.settings.pause.help | Pause keeps your entries but stops reading and saving. Resume at any time. | Pausieren behält Ihre Einträge, liest und speichert aber nichts mehr. Sie können jederzeit fortsetzen. |
| memory.settings.deleteAll.confirm | Delete all {n} entries? This cannot be undone. Your chats are not affected. | Alle {n} Einträge löschen? Dies kann nicht rückgängig gemacht werden. Ihre Chats sind nicht betroffen. |
| memory.settings.sensitive.notice | Health, religion, politics and similar topics are not saved unless you switch this on. | Gesundheit, Religion, Politik und ähnliche Themen werden nur gespeichert, wenn Sie dies einschalten. |
| memory.chat.off | Memory off for this chat | Gedächtnis für diesen Chat aus |

#### Admin

| # | Story |
|---|---|
| **P1-US-20** | As an admin, I want memory off until I switch it on, and one place to set its limits, so that an upgrade changes nothing for my users. |
| **P1-US-21** | As an admin, I want to grant memory per group, so that a pilot group can use it before everyone. |
| **P1-US-22** | As an admin, I want to decide per app whether it reads, reads and writes, or ignores memory, and whether it keeps its own partition, so that a translator app stays stateless and the chat app gains continuity. |
| **P1-US-23** | As a compliance officer, I want to see how much memory each user has and clear it on request, and never see its content, so that I can answer an erasure request without reading personal data. |
| **P1-US-24** | As a compliance officer, I want the documentation to state exactly who can read memory and through which path, including the run ledger, so that my DPIA is accurate. |

**Acceptance criteria**

- **P1-US-20.** Given a fresh or upgraded installation, when the server starts, then `userMemory` in `featureRegistry.js` is `false`, `platform.memory.enabled` is `false` (seeded by `V{NNN}__user_memory.js`), and no memory surface is visible to any user. Given the admin turns both on in **Admin → Memory**, then `maxEntries`, `maxEntryLength`, `promptBudgetChars`, `retentionDays`, `sensitiveCategories` are editable with the README defaults and bounds, saved through `PUT /api/admin/memory/settings`, and the change is audited with `logAudit`.
- **P1-US-21.** Given `V{NNN}__memory_permission.js`, when groups load, then `permissions.memory` is `true` for `admins`, `users`, `authenticated` and `false` for `anonymous`, inheritance resolves it, the group editor shows the checkbox, and the resolution matrix test covers all four `authorization.js` call sites.
- **P1-US-22.** Given the app editor, when the admin opens an app, then a **Memory** section offers `enabled`, `mode: off | read | readwrite` and `partition: account | app`; the default `chat` app is migrated to `memory: { enabled: true, mode: 'readwrite' }` so the platform flag is the single switch; `requiredFeatures` lists `userMemory` where applicable. Given an app with `partition: 'app'`, then its entries live in `um_<hash(userId)>__<appId>` and the `appId` comes only from trusted context.
- **P1-US-23.** Given **Admin → Memory → Users**, when the admin opens a user, then `GET /api/admin/users/{id}/memory` shows `entries`, `chars`, `updatedAt`, `paused` and nothing else; **Clear** calls `DELETE` (`204`), is audited with actor, user id and counts (never text), and the user's page afterwards shows `0 / maxEntries`. There is no endpoint that returns entry text to a principal other than its owner, and a route test asserts this for an admin principal.
- **P1-US-24.** Given `docs/memory.md`, when published with Phase 1, then it contains the three rules from §1.3, the ledger placeholder behaviour, the statement that admin reads of metadata and clears are audited, and the `docs/pii-data-handling.md` row ("Personal memory", default off, kept until deleted, disable switches).

#### Scheduled tasks and agents

| # | Story |
|---|---|
| **P1-US-25** | As a power user, I want a scheduled task to read my personal memory only when I opt that task in, so that my reports follow my preferences without every run reading my profile. |
| **P1-US-26** | As a compliance officer, I want scheduled runs, agents, sub-agents, anonymous users and API clients to have no way to write personal memory, so that a poisoned web page fetched by a run cannot write into someone's profile. |

**Acceptance criteria**

- **P1-US-25.** Given a task with `memory.usePersonal: true` (default `false`, shown as an option next to "Remember between runs"), when a run starts and the owner's memory is enabled and not paused, then the owner's block is appended read-only via `appendSystemNote` after the task block; no `memory_save/update/delete` is offered to the run; a test asserts the run's tool list and that the owner's store is unchanged after the run. Given `usePersonal` is off, then nothing is injected.
- **P1-US-26.** Given the handler resolution matrix (user / agent / scheduled-task run / sub-agent / anonymous / OAuth client / delegated token), when `resolveMemoryScope` runs, then only an ordinary authenticated user resolves to `{ kind: 'user' }`; `isMemoryPrincipal` follows the `checkTaskPrincipal` exclusions; scopes register agent → scheduled-task → user so a run resolves to task memory; the `memory` tool is absent from every non-user principal's tool list.

#### Privacy and compliance (cross-surface)

| # | Story |
|---|---|
| **P1-US-27** | As a compliance officer, I want account deletion to remove the person's memory everywhere, so that erasure is complete. |
| **P1-US-28** | As a compliance officer, I want entries not updated within a retention period to expire, so that memory does not outlive its relevance. |
| **P1-US-29** | As a compliance officer, I want memory encrypted at rest and never written to logs, so that storage access does not equal memory access. |

**Acceptance criteria**

- **P1-US-27.** Given a user with an account store and app or project partitions, when the `userMemory` step in `USER_CLEANUP_STEPS` runs, then every document under both owner ids (`ownerIdsOf`) is deleted, pending debounce timers are cancelled, utility-run ledgers for that user's extraction are erased, and the test finds no `user-memory` document afterwards.
- **P1-US-28.** Given `retentionDays > 0`, when the retention sweep runs under `ownsClusterSingletons`, then entries with `updatedAt` older than the period are removed and documents of users absent that long are deleted; given `retentionDays: 0`, nothing expires. The sweep is audited at summary level (counts).
- **P1-US-29.** Given any write, then the document goes through the projects `KeyProvider` envelope encryption with no switch to disable it; given `info`-level logging, then no entry text appears; given telemetry without `telemetry.events.includePrompts`, then memory blocks and (Phase 2) extraction prompts are hashed, not stored (`telemetry.redact: ['memory']`).

### 4.3 Phase 2 — automatic extraction and review

#### Chat

| # | Story |
|---|---|
| **P2-US-01** | As a knowledge worker, I want the assistant to notice durable facts I state without being told "remember this", and to show me what it noted, so that memory fills itself but never secretly. |
| **P2-US-02** | As a knowledge worker, I want a changed fact to replace the old one rather than sit next to it, so that the assistant does not hold two versions of my job title. |
| **P2-US-03** | As a knowledge worker, I want nothing extracted from a chat I marked memory-off or temporary, from a short exchange, or while memory is paused, so that the rules I set in Phase 1 hold for extraction too. |
| **P2-US-04** | As a knowledge worker, I want an extraction that finishes after I paused or cleared memory to be discarded, so that a cleared store cannot come back. |

**Acceptance criteria**

- **P2-US-01.** Given `platform.memory.extraction.enabled: true`, an app with `memory.mode: 'readwrite'`, a persistent chat with ≥ 2 user turns and memory on for the user and chat, when a turn completes, then `scheduleMemoryExtraction` debounces `debounceSeconds` (default 30) after the last turn, runs one `llmClient.complete` with JSON schema output over the last `messageWindowSize` turns and the current valid entries, applies operations with `confidence ≥ 0.7` under lock with CAS, writes `{ added, updated, invalidated }` onto the assistant message's stored `activity`, and the chip renders when the message is next shown (live when the open chat polls `GET /api/memories/_activity?chatId=&since=`); each added entry has `source: 'extraction'`, `confidence`, `sourceRef.messageId`, and Undo works as in P1-US-05.
- **P2-US-02.** Given an entry "works in the legal team" and a turn stating a move to sales, when extraction runs, then the result is `invalidate` on the old entry (`invalidatedBy` = new id, kept for history, no longer injected) plus `add` of the new one; given a turn repeating a known fact, then the operation is `noop` and nothing changes. Unit tests with `LLMClient` fakes cover duplicate → NOOP, contradiction → INVALIDATE + ADD, sensitive → dropped, malformed JSON → no write.
- **P2-US-03.** Given a temporary or ephemeral chat, a chat with "Memory off", an app in `mode: 'read'`, a paused or disabled user, or fewer than two user turns, when the turn completes, then no extraction is scheduled and no LLM call is made (asserted on the fake).
- **P2-US-04.** Given extraction was scheduled with `controlsVersion` N, when the user pauses, clears, switches the chat off or is deleted before the result applies (each increments `controlsVersion`), then `applyOperations` re-reads under the lock, drops the whole result, and never creates a document; given a replayed or duplicated operation set for the same turn (two workers), then the `extraction.appliedTurns[chatId]` watermark and normalised-text dedupe make the second application a no-op (multi-worker idempotency test).

#### Settings → Memory

| # | Story |
|---|---|
| **P2-US-05** | As a knowledge worker who does not trust automatic saves, I want to review each proposed entry before it is saved, so that nothing enters memory without my click. |
| **P2-US-06** | As a knowledge worker switching from another assistant, I want to paste its exported memory and have it turned into entries I can review, so that I do not start from zero. |
| **P2-US-07** | As a knowledge worker, I want extraction to respect the same sensitive-topic rules as explicit saves, so that the background path is not a loophole. |

**Acceptance criteria**

- **P2-US-05.** Given `platform.memory.extraction.reviewMode: 'optional'`, when the user turns on **Review before saving** (`PATCH /api/memory-preferences { reviewMode }`), then extraction results go to `pending[]`, the **Pending** tab lists them with evidence text, **Accept** (`POST /api/memories/_pending/{id}/_accept`) creates the entry and **Reject** (`_reject`, `204`) discards it; given `reviewMode: 'required'`, then every user is in review mode and cannot switch it off; given `'off'`, then the switch and tab are hidden. Pending items count against `maxEntries` only when accepted; a pending list older than 30 days is pruned (figure to be decided in engineering).
- **P2-US-06.** Given pasted text, when the user submits Import, then `POST /api/memories/_import` runs the same operations contract, returns `200 { items }`, entries carry `source: 'import'`, duplicates of existing entries become `noop`, sensitive filtering applies, and the import counts against the daily extraction budget (a cap hit returns `429` `MEMORY_BUDGET_EXCEEDED`).
- **P2-US-07.** Given `sensitiveOptIn: false`, when extraction proposes a sensitive-category entry, then the extraction prompt is instructed not to, the server-side pattern filter drops it anyway, and the hand-labelled sample shows zero sensitive saves without opt-in (Phase 2 acceptance in README §7).

#### Admin and cost

| # | Story |
|---|---|
| **P2-US-08** | As an admin, I want extraction off by default, a cheap model for it, and a per-user daily cap, so that enabling it cannot run away. |
| **P2-US-09** | As a tenant owner, I want extraction cost attributed to the user who benefits and visible on the usage page as its own line, so that cost is predictable and fair. |
| **P2-US-10** | As an admin, I want to require review for everyone or leave it to each user, so that a regulated department can mandate it. |
| **P2-US-11** | As an admin, I want #1039 closed with a pointer to what shipped, so that the issue tracker reflects reality. |

**Acceptance criteria**

- **P2-US-08.** Given `platform.memory.extraction` (`enabled: false`, `modelId?`, `maxCallsPerUserPerDay: 50`, `maxInputTokens: 12000`, `debounceSeconds: 30`, `reviewMode: 'off'`), when the admin edits them on **Admin → Memory**, then they are validated and saved; given no `modelId`, then the turn's permission-checked model is used (architecture C12); given `maxCallsPerUserPerDay > 0` and the user has used that many slots in the budget document `user-memory-budget/<userId>` (one per user across all partitions), then the next extraction is skipped without rescheduling; given `maxCallsPerUserPerDay: 0`, then the cap is unlimited and the counter only feeds the usage line; every provider call reserves its own slot, including the malformed-output retry (no slot left → the batch fails without a write); the call is made with `retries: 0` so each reservation is one transport attempt, and a reserved slot is released only when that attempt's failure proves no request reached the provider (a read failure before the call, the local quota pre-check, a connection-level error) and is kept for timeouts, 5xx and unclassified outcomes (architecture §2.2).
- **P2-US-09.** Given an extraction call, when it runs, then it carries `telemetry: { kind: 'utility', purpose: 'user-memory', user, parentRunId, surface: 'memory' }`, quota applies to the user, the Usage page shows a "memory" line per user and in total, and a user over quota gets no extraction (never a failed chat).
- **P2-US-10.** Given `reviewMode: 'required'`, when any user's extraction runs, then results always go to `pending[]` and the Settings switch is shown locked with an explanation.
- **P2-US-11.** Given Phase 1 and 2 have shipped, when #1039 is closed, then the closing comment maps its two asks (≤ 50 entries → `maxEntries`; off inside agents → Decision 9) to the shipped behaviour.

### 4.4 Phase 3 — LLM compaction

| # | Surface | Story |
|---|---|---|
| **P3-US-01** | Chat | As a knowledge worker on a 32k local model, I want a long chat to keep working instead of failing with a context error, so that I do not have to start over. |
| **P3-US-02** | Chat | As a power user, I want `/compact` to summarise now and show me the summary, so that I control when context is trimmed. |
| **P3-US-03** | Chat | As a knowledge worker, I want a fact I stated early in a long chat to be in memory (if durable) or in the summary (if episodic) after compaction, so that compaction loses nothing that matters. |
| **P3-US-04** | Chat, compliance | As a compliance officer, I want summaries never to become memory records, so that an unverified summary cannot masquerade as a fact about a person. |
| **P3-US-05** | Scheduled tasks, agents | As a power user, I want long scheduled runs and agent loops to compact the same way, so that a long research run does not die at the context limit. |
| **P3-US-06** | Admin | As an admin, I want the threshold and the summary model configurable and each compaction recorded in the ledger, so that I can tune and audit it. |

**Acceptance criteria**

- **P3-US-01.** Given reported `promptTokens` above `policies.context.summaryThresholdRatio` (default 0.8) × `model.contextWindow`, when the next turn is prepared, then the older part is summarised with the previous summary as input, the most recent ~40 % stays verbatim, the cut lands only at a user turn or after a complete tool batch, base64 and large tool outputs are stripped first, `ask_user` answers and approvals are kept verbatim, and the summary is stored as a run-ledger checkpoint from which later turns start. A 200-turn chat on a 32k model completes in the e2e test.
- **P3-US-02.** Given a chat, when the user types `/compact`, then compaction runs regardless of threshold, the "Earlier messages summarised" marker appears at the cut, expands to the summary text, and the context indicator in the input drops; the full transcript remains stored and visible.
- **P3-US-03.** Given Phase 2 extraction enabled, when turns are about to be dropped, then the extractor runs once synchronously over exactly those turns (bounded to one call; failure never blocks compaction), and the test asserts that a durable fact from turn 3 dropped at turn 150 is a memory entry or in the summary.
- **P3-US-04.** Given any compaction, then a test asserts that no summary text lands in `user-memory` except through the extractor's operations; the summary is passed to the extractor and to the scheduled-task composer as context only.
- **P3-US-05.** Given a scheduled run or an agent `PromptNodeExecutor` loop over the threshold, then the same mechanism applies (replacing `ContextSummarizer` only where it duplicates), and the run's ledger records it.
- **P3-US-06.** Given `docs/agent-loop.md` and `docs/chat-persistence.md`, then the threshold, model and marker are documented; given a compaction, then the ledger event records which turns, which model and tokens before/after; `/compact` works on one cloud and one local model in the nightly run.

### 4.5 Phase 4 — consolidation and lessons

| # | Surface | Story |
|---|---|---|
| **P4-US-01** | Scheduled tasks | As a power user with a busy weekly task, I want the platform to propose tidied notes after several runs and let me compare and apply or discard, so that notes stay short without me rewriting them and nothing changes behind my back. |
| **P4-US-02** | Scheduled tasks | As a power user, I want a proposal to be refused if my notes changed since it was made, so that an old proposal never overwrites a fresh edit. |
| **P4-US-03** | Scheduled tasks | As a power user, I want the task to learn from my corrections ("not that format, the table one") as a lesson it reads next run, so that I correct once. |
| **P4-US-04** | Agents (admin) | As an admin maintaining agent profiles, I want the same proposal and review for agent notes, and the option to stage every agent memory write for approval, so that a wrong generalisation never sticks unreviewed. |
| **P4-US-05** | Admin / cost | As an admin, I want consolidation off by default, limited to tasks and agents that actually ran, bounded in what it reads, attributed to the owner, and optionally auto-applied for notes only, so that it earns its cost. |
| **P4-US-06** | Compliance | As a compliance officer, I want consolidation to drop candidates from untrusted sources and to keep at least 75 % of prior entries, so that it cannot be used to poison or erase notes. |

**Acceptance criteria**

- **P4-US-01.** Given `platform.memory.consolidation.enabled: true`, a task with `memory.enabled` whose notes `version` advanced since the last consolidation and ≥ `minRunsSinceLast` (default 5) runs, when the nightly `startMemoryConsolidationSweep()` runs under `ownsClusterSingletons`, then a `proposal { baseVersion, createdAt, diff, operations, notes, lessons }` is stored on the memory document without touching `body`; the task page shows "Consolidated notes ready" with a diff; **Apply** (`POST …/memory/proposal/_apply`) swaps in the new version keeping every `(seen YYYY-MM-DD)` watermark; **Discard** (`_discard`, `204`) removes it; the owner can also trigger one with `POST /api/scheduled-tasks/{taskId}/memory/_consolidate` (`202`). The e2e test runs three times, applies, and the fourth run shows "Used notes vN".
- **P4-US-02.** Given a proposal with `baseVersion` 7, when the owner edits the notes to version 8 and then applies, then the apply is rejected with `409` `VERSION_CONFLICT` and the card offers to regenerate.
- **P4-US-03.** Given the owner's follow-up messages in run chats correcting the output twice in the same way, when consolidation runs, then a `lessons[]` entry (`category: 'lesson'`, `source: 'consolidation'`) is proposed, the owner can edit it before applying, and the next run's prompt contains it in a `<lessons>` block after `<task_memory>` with the "data, not instructions" wording. Lessons are always reviewed, even with `autoApply: 'notes-only'`.
- **P4-US-04.** Given an agent profile with `memory.enabled`, then the admin agent memory page shows the same proposal card; given `memory.writeApproval: true` on the profile, then `memory_write` during a run stages into `pending[]` and the admin page lists it for Apply/Discard, so the run's notes change only after review.
- **P4-US-05.** Given `consolidation` (`enabled: false`, `modelId?`, `minRunsSinceLast: 5`, `maxRunsRead: 10`, `autoApply: 'never' | 'notes-only'`), when set, then only eligible tasks and agents are read, at most `maxRunsRead` answers are read through `runHistory.js`, the call carries `purpose: 'memory-consolidation'` attributed to the owner, and the proposal summary appears in the run list; with `autoApply: 'notes-only'`, notes (not lessons) are applied without review and the swap is recorded.
- **P4-US-06.** Given candidates with untrusted or system provenance, then they are dropped before the proposal; given a proposal that would lose more than `maxPriorEntryLossFraction: 0.25` of prior entries, then it is rejected and logged, and the owner sees no card. The proposal is shorter than the input notes in the Phase 4 acceptance test.

---

## 5. Release packaging

### 5.1 Which phases ship together

| Release | Content | Issue closed | Size |
|---|---|---|---|
| **R1** | Phase 0 + Phase 1 | #2522 | M + M, one minor release. Phase 0 alone changes nothing a user wants; Phase 1 cannot keep its metadata-only promise without Phase 0's ledger placeholder. |
| **R2** | Phase 2 | #1465 (extraction part); #1039 closed as duplicate | M. Needs R1's store, tool contract and `postTurn` hook; can start as soon as R1's store is on `main`. |
| **R2 or R3** | Phase 3 | #3192 | M. Independent code (`contextCompaction.js`, ledger checkpoint); only the pre-compaction flush depends on Phase 2's extractor and degrades to "no flush" without it. Can ship in the same minor as Phase 2 or the next; the recommendation is the same minor if capacity allows, because local-model customers hit the context limit today. |
| **R4** | Phase 4 | — (new issue to be opened) | L. After R2 has produced at least one month of task-memory usage data so the eligibility threshold is tuned on real tasks. |

Phase 2 ships only after the Phase 2 acceptance in README §7 is met on the internal evaluation set (precision ≥ 0.8 on the 200-turn sample, zero sensitive saves without opt-in).

### 5.2 Feature flags, defaults and who switches what

| Switch | Level | Default | Who | Effect |
|---|---|---|---|---|
| `userMemory` (`featureRegistry.js`) | Platform feature flag | off | Admin | Hides every memory surface; `requiredFeatures` on apps |
| `platform.memory.enabled` | Platform setting | `false` | Admin | Master switch for the store, tools, injection, Settings page |
| `permissions.memory` | Group | `true` for `admins`, `users`, `authenticated`; `false` for `anonymous` (migration `V{NNN}__memory_permission.js`) | Admin | Who may have memory at all |
| `app.memory { enabled, mode, partition }` | App | absent = off; default `chat` app migrated to `{ enabled: true, mode: 'readwrite' }` | Admin | Per-app opt-in; `read` injects without tools |
| `platform.memory.sensitiveCategories` | Platform | `'allowOptIn'` recommended for general deployments, `'exclude'` for regulated ones (to be confirmed in engineering; README lists the three values without a default) | Admin | Whether users may opt in to sensitive topics |
| `enabled` / `paused` / `sensitiveOptIn` / `reviewMode` | User (memory document) | `true` / `false` / `false` / platform default | User | Settings → Memory |
| Per-chat "Memory off" | Chat `settings` | on | User | Read and write off for that chat |
| `task.memory.usePersonal` | Scheduled task | `false` | Task owner | Read-only personal block in runs |
| `platform.memory.extraction.enabled` | Platform | `false` | Admin | Phase 2 |
| `platform.memory.extraction.reviewMode` | Platform | `'off'` | Admin | Phase 2; `'required'` forces review for all |
| `policies.context.summaryThresholdRatio` | Platform | `0.8` | Admin | Phase 3 |
| `platform.memory.consolidation.enabled` | Platform | `false` | Admin | Phase 4 |
| `memory.writeApproval` (agent profile) | Agent profile | `false` | Admin | Phase 4 |

The result for an upgrading customer: **nothing changes until an admin turns the flag and the platform setting on**; the group permission and the `chat` app default are prepared by migration so that turning the flag on is a single step.

### 5.3 Migrations and upgrade notes

| Migration | Phase | What it does | Visible to |
|---|---|---|---|
| `V{NNN}__rename_memory_tools.js` | 0 | Renames `contents/tools/{read,write}_memory.json`, rewrites tool ids in agent profiles, app `tools` arrays and scheduled-task allowlists | Admins (breaking) |
| Agent memory import (name to be decided in engineering, #2389 item) | 0 | Imports `contents/agents/memory/*.md` into `agent-memory` once | Admins who edit the files on disk (breaking) |
| `V{NNN}__user_memory.js` | 1 | Seeds `platform.memory` defaults with `enabled: false` | Nobody until enabled |
| `V{NNN}__memory_permission.js` | 1 | Grants `permissions.memory` to `admins`, `users`, `authenticated` | Admins (group editor) |
| Chat app memory default (name to be decided in engineering) | 1 | Sets `memory: { enabled: true, mode: 'readwrite' }` on the default `chat` app | Nobody until the flag is on |

All migrations follow `server/migrations/README.md` (forward-only, `ctx.setDefault`, never modify an applied migration).

### 5.4 What goes into `docs/releases/next/`

- **`breaking-changes.md`** (R1): the tool rename with old and new ids, what is migrated automatically and what external callers must change; the agent memory storage move (D4 reversal) and that disk edits no longer apply; task-memory routes now answer `409` `VERSION_CONFLICT` in problem+json.
- **`features.md`** (R1): "Personal memory" written for admins and users in the style of the existing entries: what it is, where to switch it on (flag, platform setting, group, app), what users see (chip, Undo, Settings → Memory, pause, export), the privacy statement (admins see metadata only; what the ledger stores; the three rules of §1.3), and the scheduled-task `usePersonal` option.
- **`features.md`** (R2): "Memory learns from chats" (extraction, review, import, usage line, daily cap). (R2/R3): "Long chats are summarised" (`/compact`, marker, threshold, ledger). (R4): "Consolidated notes and lessons for scheduled tasks and agents".
- **`fixes.md`** (R1): agent memory write cap; version-safe `memory-finalize`.
- **Not written:** anything for Phase 0 that has no visible effect (the `postTurn` hook, `isMemoryPrincipal`, the handler `shape` contract).

### 5.5 Rollout recommendation

1. **Internal dogfood (R1 pre-release, ≥ 4 weeks).** Flag on for IntraFind's own instance, `permissions.memory` limited to a volunteer group, `chat` app only, `sensitiveCategories: 'allowOptIn'`. Collect the §6 numbers weekly. Exit criterion: undo rate below target for two consecutive weeks and no P1 privacy finding.
2. **Opt-in customers (R1 GA, R2).** Flag off by default in the release; two to three customers enable it for a pilot group with the admin runbook in `docs/memory.md`. Extraction (R2) is enabled only for customers whose pilot has run R1 for a month and only with `reviewMode: 'optional'` first.
3. **Default on for the chat app?** Not by migration for existing installations: an upgrade must never start storing personal data on its own. The question for **new installations** (fresh `contents/`) is deferred to after R2 metrics (see §7, item 8). The migration that sets the `chat` app to `readwrite` is harmless either way because the platform flag gates everything.
4. **Languages.** German and English ship together in every release; no memory surface ships English-only.

---

## 6. Success metrics and instrumentation

Measured from the first dogfood week; reported per release. "Active user" means a user with at least one chat turn in the period; "memory user" means an active user with memory enabled and ≥ 1 valid entry.

| Metric | How it is measured | Source | Target (R1 dogfood → R2 GA) |
|---|---|---|---|
| **Adoption** | memory users ÷ active users in groups with the permission | Admin metadata view aggregated (counts only) | ≥ 30 % after 4 weeks of dogfood; ≥ 40 % at a pilot customer after 8 weeks |
| **Entries per memory user** | median and p90 of `entries` | Admin metadata | Median 5–20 after 4 weeks; p90 < `maxEntries`; fewer than 5 % of users at `MEMORY_FULL` |
| **Undo rate** | undos ÷ tool saves (Phase 1); undos + rejects ÷ extraction proposals (Phase 2) | Count of `DELETE /api/memories/{id}` within a short window after a tool save, and Pending accept/reject counts; how an Undo is told apart from an ordinary delete in telemetry is to be decided in engineering | Tool saves: < 10 %; extraction: < 20 % (ChatGPT's complaint threshold was unwanted saves people had to clean up) |
| **Extraction precision / recall** | Hand-labelled 200-turn sample from anonymised dogfood chats, judged against "would a reasonable person want this remembered" | Evaluation set in `tests/integration` (README §9) | Precision ≥ 0.8 before R2 ships; recall reported, no target in R2 |
| **Sensitive-category saves without opt-in** | Count in the labelled sample and in the pattern-filter rejection log | Filter rejections (counts only), sample | 0 |
| **Tokens per turn added by memory** | Average size of the `<user_memory>` block in tokens; extraction input tokens per call | `run/started` block size; `surface: 'memory'` telemetry | Block ≤ 1,200 tokens average (4,000 chars); extraction ≤ 12,000 input tokens per call by cap |
| **Cost per memory user per day** | Sum of `surface: 'memory'` usage ÷ memory users | Usage page "memory" line | Less than the cost of one average chat turn per user per day; an alert when a user hits `maxCallsPerUserPerDay` on more than 3 days a week |
| **Internal evaluation set** | Accuracy and Δ (with memory − full context) on ~100 DE/EN question/history pairs (knowledge update, abstention, temporal, multi-session, preference following) | Nightly job, one cloud + one local model (README §9) | Δ reported per release; knowledge-update and abstention pairs must not regress between releases |
| **Staleness** | Share of injected entries older than 90 days that the judge marks outdated | Evaluation job | Reported; feeds the `retentionDays` recommendation |
| **Support tickets** | Tickets tagged "memory" per 100 memory users, split into "wrong/creepy memory", "cannot find/delete", "privacy question", "cost" | Support tracker tag | < 2 per 100 memory users per month after the first month; zero "admin could read my memory" |
| **Scheduled-task value (Phase 4)** | Share of eligible tasks with an applied proposal; notes length after vs before; owner discard rate | Proposal summary in the run list | ≥ 50 % of proposals applied; discard rate < 30 %; applied notes shorter than input |
| **Performance** | p95 added latency of the turn from memory read; extraction never on the turn path | Existing turn timing; `postTurn` must not delay `run/ended` | Read adds < 20 ms p95; extraction latency invisible by construction |

Instrumentation that must exist for these numbers: the `surface: 'memory'` usage line (Phase 2), the admin metadata endpoint (Phase 1), counts-only audit entries for filter rejections and admin clears (Phase 1), the stored extraction `activity` summary (Phase 2), the proposal summary in the run list (Phase 4), and the evaluation set and nightly job (built during Phase 1, used as a gate for Phase 2). No metric may require reading entry text; the labelled sample is built from anonymised dogfood chats with the participants' consent.

---

## 7. Risks and open product questions

Eight items, each with a recommendation. Engineering risks (CAS, multi-worker, prompt-cache churn) are in the README and not repeated.

| # | Risk or question | Why it matters | Recommendation |
|---|---|---|---|
| 1 | **Over-saving and junk** (the mem0 audit found 97.8 % of entries junk; ChatGPT users hit "96 % full" with trivia) | Junk makes the block useless and the Settings page embarrassing; it is the documented failure of every extraction-first product | Phase 1 ships tool-only with a conservative tool description; Phase 2 is gated on precision ≥ 0.8; `reviewMode: 'optional'` is the recommended first setting at customers; the counter and categories make junk visible; the undo rate is a release gate |
| 2 | **Memory poisoning through fetched content** (MINJA; OWASP ASI06) | A web page or document read by a tool could make the model "remember" something about the user | Provenance on every entry; no writes from scheduled runs, agents or sub-agents; `sideEffect: 'write'` so `writes` approval mode can require a click; the tool description forbids saving from tool output; Phase 4 drops untrusted provenance. Recommend `writes` approval mode for apps with web search in regulated deployments and say so in `docs/memory.md` |
| 3 | **Admins could read memory through the run ledger** until the placeholder lands | Breaks the central privacy promise; a works council will ask exactly this | The placeholder is a Phase 0 item and a Phase 1 ship gate (DoD §8.2). Until then, no customer pilot; dogfood participants are told. `docs/memory.md` states the ledger behaviour plainly rather than claiming more |
| 4 | **The tool rename breaks customers' agent profiles, apps, tasks and external callers** | Decision 6 is a clean break with no alias | Migration covers everything stored in `contents/`; the breaking-change note lists what external callers must change; the release notes are published before the release, and support is briefed. If a customer runs the old ids from an MCP client or script, that is a known, documented break — do not add an alias (CLAUDE.md) |
| 5 | **Acceptance under GDPR and co-determination** (Art. 9 categories, "profiling" perception, employee data) | A German enterprise may need a DPIA and works-council agreement before switching memory on; a bad first impression blocks the whole feature | Ship the compliance package with R1: `docs/pii-data-handling.md` row, `docs/memory.md` with who-can-read-what, export, deletion cascade, retention, `sensitiveCategories: 'exclude'` as a one-setting answer, audit of admin actions. Offer a one-page DPIA input document (to be written with R1). Open question: should `sensitiveCategories` default to `'exclude'` rather than `'allowOptIn'`? Recommendation: `'allowOptIn'` for the default, `'exclude'` documented as the regulated-deployment setting, to be confirmed in engineering with the first pilot customer |
| 6 | **Cost and quota surprises** (users pay for extraction, Decision 15) | A user who never asked for memory sees "memory" on their usage page and may hit quota sooner | Extraction off by default; daily cap; the usage line names it; the Settings page says "Memory learns from your chats and counts against your usage" when extraction is on. Recommendation: extraction is enabled per customer only after R1 has run a month |
| 7 | **Small local models** produce malformed JSON or poor summaries (Phase 2 extraction, Phase 3 summaries) | Many on-prem customers run 7–30B models | Schema validation drops malformed output (no write is better than a wrong write); tag-parsing fallback as the task composer does; admins can set a separate `extraction.modelId`; Phase 3 acceptance runs on one local model. Open question: should extraction be refused for models below a capability threshold? Recommendation: no hard refusal; document the recommended model class and measure precision per model in the evaluation job |
| 8 | **Default on for new installations?** | Every competitor is on by default; iHub's buyers are the most privacy-sensitive segment | Decide after R2 metrics from two pilots. Recommendation now: keep the platform default off for existing and new installations through R2, revisit for R3 with the numbers from §6 (adoption, undo rate, support tickets). Never flip existing installations by migration |

---

## 8. Definition of done per phase

A phase is done when every line below is true, in addition to the README's acceptance paragraph for that phase and the repository's general rules (lint and format clean, REUSE headers on new files, `npm run prod:build` passes, changelog entry where visible).

### 8.1 Phase 0

- [ ] `memoryService` handlers declare `shape: 'body' | 'entries'`; `listEntries` / `applyOperations(scope, ops, { expectedVersion })` exist on the contract; existing body scopes unchanged; contract tests pass.
- [ ] Agent memory lives in the `agent-memory` namespace; the import from `contents/agents/memory/*.md` runs once and is tested; the write cap `maxChars` is enforced; `MemoryFinalizeNodeExecutor` passes `expectedVersion` with a one-shot re-read; the two-concurrent-writes test passes.
- [ ] `read_memory`/`write_memory` renamed to `memory_read`/`memory_write` everywhere the README lists; migration `V{NNN}__rename_memory_tools.js` and its fixture test pass; no alias exists; `server/tests/fixtures/builtin-app-tool-ids.json` updated.
- [ ] Task-memory routes throw `ServiceError` with `VERSION_CONFLICT` (409) in problem+json; the question of a transition shim was asked and answered.
- [ ] `activityKind: 'memory'` in `sseV2.js`, `runReducer.js`, `toolActivity.js`, `runActivity.js`, `toolDisplay.js`; SSE contract snapshot and client unit test pass.
- [ ] `postTurn` hook in `ChatService.runTurn` after `materializeAssistantTurn`; title generation moved onto it; a test proves a slow handler does not delay `run/ended`.
- [ ] `isMemoryPrincipal(user)` in `server/services/memory/memoryPrincipal.js` with the `checkTaskPrincipal` exclusions and a matrix test.
- [ ] Ledger placeholder rule implemented and tested: placeholder in `request/header.messages`, hash verification on replay with an unchanged store, placeholder-only after edit, `_clear` and account deletion, no entry text in events or spill blobs.
- [ ] `docs/agents.md` storage note; `docs/releases/next/breaking-changes.md` (rename, storage move, 409) and `fixes.md` (write cap, version-safe finalize).
- [ ] All existing scheduled-task and agent memory tests pass under the new ids.

### 8.2 Phase 1

- [ ] Namespace `userMemory: 'user-memory'` in `server/storage/namespaces.js` and the `docs/storage.md` table.
- [ ] `UserMemoryRepository.js`, `userMemoryHandler.js` (registered last), `userMemoryBlock.js`; repository tests for CAS, caps, sensitive filter, `applyOperations`; handler resolution matrix test for user / agent / task / sub-agent / anonymous / OAuth client / delegated token.
- [ ] Tool `server/defaults/tools/memory.json` → `memory_save/update/delete/list` in `server/tools/userMemoryTools.js`, listed in `PLATFORM_TOOL_FILE_IDS`; `tool-ownership.test.js` passes; attached only when `app.memory.mode !== 'off'`, the per-chat toggle is on and the principal is a memory principal; only `memory_list` in temporary/ephemeral chats; `sideEffect: 'write'` on the three write functions.
- [ ] Injection between projects and skills or at `{{user_memory}}`; prompt-assembly tests with and without placeholder; injection-safety test; over-budget selection test (`shown < entries`).
- [ ] Project and app partitions: keys, trusted `appId`/`projectId` only, `_partitions` endpoint, fail-closed tests for unknown and unauthorised partitions, project deletion cascade step.
- [ ] `platform.memory` Zod section and `V{NNN}__user_memory.js`; `userMemory` flag (default off); `permissions.memory` in schema, `resolveGroupInheritance`, `loadGroupPermissions`, `getPermissionsForUser`, `AdminGroupEditPage.jsx`, `V{NNN}__memory_permission.js`; `memorySchema` in `appConfigSchema.js`; `chat` app migrated to `readwrite`.
- [ ] Routes `server/routes/memories.js` and `server/routes/admin/memory.js` per README §6.9 with OpenAPI comments and `memoryLimiter`; route tests assert status codes, problem+json and codes; `shared/apiErrors.js` has `MEMORY_DISABLED`, `MEMORY_FULL`, `VERSION_CONFLICT`, `MEMORY_SENSITIVE_BLOCKED`, `MEMORY_BUDGET_EXCEEDED`, `MEMORY_PARTITION_NOT_FOUND`; `apiErrors.<CODE>` in `en.json` and `de.json`.
- [ ] Client: `MemoryPage.jsx` (list editor), `client/src/api/endpoints/memories.js`, link in `UserAuthMenu.jsx`, per-chat toggle, "Memory updated" chip with Undo, "Recalled N memories" header chip, `AdminMemoryPage.jsx`, app editor Memory section; `memory.*` i18n in both languages with "Sie"; no new top-level route (`settings/*` is already in `KNOWN_ROUTES`).
- [ ] Scheduled tasks: `task.memory.usePersonal` (default off) in `taskModel.js`, `validateTaskFields`, `duplicateTask`, the task editor; read-only `appendSystemNote` in `taskExecution.js`; test that the run's tool list has no write tool and the store is unchanged.
- [ ] Compliance: `userMemory` step in `USER_CLEANUP_STEPS` with test; retention sweep with test; `KeyProvider` encryption on every write; no entry text at `info` log level; `logAudit` on admin settings change and clear; `docs/pii-data-handling.md` row.
- [ ] E2e: save via chat → appears on Settings → used in another app's chat → delete → gone from the next prompt; temporary chat never writes; pause keeps entries; "Memory off" chat sees nothing; admin sees counts only (route test with an admin principal gets no text).
- [ ] `docs/memory.md` (new, in `docs/SUMMARY.md`) with the three rules of §1.3 and the admin runbook; `docs/releases/next/features.md` entry.
- [ ] Evaluation set (README §9) created with the first ~50 DE/EN pairs and wired into `tests/integration`; nightly job configured for one cloud and one local model.
- [ ] Dogfood exit criteria of §5.5 step 1 met before R1 GA.

### 8.3 Phase 2

- [ ] `server/services/memory/memoryExtractor.js` with per-chat debounce (cancel and reschedule, immediate on chat close), JSON schema output validated by `createOutputValidator`, confidence ≥ 0.7 and sensitive filtering, `applyOperations` under `locks.withLock('user-memory:<key>')` with CAS, `controlsVersion` check, `appliedTurns` watermark, normalised-text dedupe, never creates a document.
- [ ] Budget document `user-memory-budget/<userId>` with `reserveExtractionSlot(userId)` before every provider call (the JSON retry included), `retries: 0` on the call, release only when the failure proves no request reached the provider (architecture §2.2); cap skip without reschedule; cap 0 = unlimited.
- [ ] Hooked on `postTurn`; skips temporary chats, `mode: 'read'` apps, paused or disabled users, "Memory off" chats, chats with fewer than two user turns.
- [ ] Telemetry `{ kind: 'utility', purpose: 'user-memory', user, parentRunId, surface: 'memory' }` with `telemetry.redact: ['memory']`; quota applied; Usage page "memory" line.
- [ ] Stored `activity` summary on the assistant message; `GET /api/memories/_activity?chatId=&since=` polled by the open chat; `run/started` of the next turn carries the summary; chip with Undo.
- [ ] `reviewMode` (`off | optional | required`) on platform and `PATCH /api/memory-preferences`; `pending[]`; `GET /api/memories/_pending`, `_accept`, `_reject`; Pending tab; the pending pruning period decided and documented.
- [ ] `POST /api/memories/_import` over the same operations contract, `source: 'import'`, budget counted, `429` `MEMORY_BUDGET_EXCEEDED` on cap.
- [ ] Admin `extraction.*` settings on `AdminMemoryPage.jsx`.
- [ ] Tests: duplicate → NOOP, contradiction → INVALIDATE + ADD, sensitive → dropped, malformed JSON → no write, daily cap → skipped, debounce, controls change → result dropped, two workers → one application.
- [ ] Precision ≥ 0.8 and zero sensitive saves without opt-in on the 200-turn labelled sample; results recorded in the concept folder.
- [ ] `docs/memory.md` extraction section; `docs/releases/next/features.md` entry; #1039 closed with the mapping comment after release.

### 8.4 Phase 3

- [ ] `summarizeIfOverBudget({ messages, model, previousSummary })` in `contextCompaction.js`; trigger on reported `promptTokens` ≥ `summaryThresholdRatio` × `contextWindow`; cut at a user turn or after a complete tool batch; recent ~40 % verbatim; base64 and large tool outputs stripped; `ask_user` answers and approvals verbatim.
- [ ] Summary stored as a run-ledger checkpoint event; later turns start from the newest checkpoint; ledger records turns, model, tokens before/after.
- [ ] `/compact` command; "Earlier messages summarised" marker with expand; context indicator drops.
- [ ] Pre-compaction memory flush: one bounded extractor call over the turns to be dropped; failure never blocks; degrades to no flush when extraction is off.
- [ ] Summary passed to the extractor and the scheduled-task composer as context; test that no summary text lands in `user-memory` except through operations.
- [ ] Same mechanism in `taskExecution.js` runs and agent `PromptNodeExecutor`; `ContextSummarizer` replaced only where it duplicates.
- [ ] Tests: threshold and cut-point with fakes; checkpoint replay; flush-before-drop; overflow-error path still compacts once; 200-turn chat on a 32k model e2e; `/compact` on one cloud and one local model.
- [ ] `docs/chat-persistence.md`, `docs/agent-loop.md`; `docs/releases/next/features.md` entry.

### 8.5 Phase 4

- [ ] `lessons[]` on task and agent memory documents (entry shape, `category: 'lesson'`, `source: 'consolidation' | 'user'`); `<lessons>` block after the notes with the "data, not instructions" wording; the composer may propose lessons from owner follow-ups.
- [ ] `server/services/memory/memoryConsolidator.js` and `startMemoryConsolidationSweep()` under `ownsClusterSingletons`; eligibility (version advanced, ≥ `minRunsSinceLast`); inputs bounded by `maxRunsRead` through `runHistory.js`; optional `consolidation.modelId`; output stored as `proposal { baseVersion, createdAt, diff, operations, notes, lessons }`; `maxPriorEntryLossFraction: 0.25`; untrusted provenance dropped; the document body never changes without apply.
- [ ] Routes `POST /api/scheduled-tasks/{taskId}/memory/_consolidate` (`202`), `GET …/memory/proposal`, `POST …/proposal/_apply` (stale base → `409` `VERSION_CONFLICT`), `_discard` (`204`).
- [ ] Task page card with diff and Apply/Discard; admin agent memory page likewise; `consolidation.autoApply: 'never' | 'notes-only'` (lessons always reviewed); `memory.writeApproval` on agent profiles staging `memory_write` into `pending[]`.
- [ ] Telemetry `purpose: 'memory-consolidation'` attributed to the owner; proposal summary in the run list.
- [ ] Tests: eligibility; proposal never mutates the document; loss-fraction guard; stale-base apply rejected; e2e three runs → proposal → apply → fourth run "Used notes vN"; a lesson from an owner correction appears in the next run's prompt; the three-run "report only what is new" test from README §9 passes.
- [ ] `docs/scheduled-tasks.md`, `docs/agents.md`; README §4.2 decision list extended with the Phase 4 additions; `docs/releases/next/features.md` entry; a GitHub issue opened for Phase 4 before work starts.

---

## 9. Glossary for newcomers

| Term | Meaning here |
|---|---|
| **Entry** | One remembered fact or preference: `{ id, text, category, source, sourceRef, confidence, createdAt, updatedAt, validFrom, invalidatedBy? }`. |
| **Partition** | A separate entry list for one app (`partition: 'app'`) or one project (`partition: 'project'`) next to the account store. |
| **Block** | The `<user_memory …>` text injected into the system prompt, capped at `promptBudgetChars`. |
| **Pause** | Stop reading and writing, keep everything. Not a reset. |
| **Invalidate** | Mark an entry as superseded by a newer one; it stays for history, is never injected again, and is hard-deleted only by the user or by retention. |
| **Extraction** | The Phase 2 background LLM call that proposes add / update / invalidate / noop operations after a chat turn. |
| **Review mode** | Extraction results wait in `pending[]` for the person's Accept or Reject. |
| **Compaction** | Phase 3: summarising the older part of one chat so it fits the model's context window. The summary is not memory. |
| **Consolidation ("dreaming")** | Phase 4: a nightly pass that proposes tidied notes and lessons for a task or agent as a new version with a diff; never applied without review unless the admin allows notes-only auto-apply. |
| **Lesson** | A procedural entry ("the owner wants the table format") in `lessons[]`, read by the next run. |
| **Memory principal** | A principal that may have personal memory: an ordinary authenticated user. Not agents, sub-agents, scheduled runs, anonymous users, OAuth clients or delegated tokens. |
| **Metadata only** | What admins see: counts, sizes, dates, paused state. Never text. |
