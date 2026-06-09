# Features — 5.4.0

## Completeness Analysis Workflows — Audit-grade Stellungnahmen Review

iHub now ships a reusable set of workflow primitives for **audit-grade corpus-completeness analysis**, plus a working reference workflow and agent profile for the German government law-consultation use case (Stellungnahmen review).

Three new workflow node types — `evidence-collect`, `quote-validator`, `report-compose` — and a matching `evidence` tool family (three functions) let workflow authors and agents build pipelines that extract structured findings from documents, verify every cited quote against the source, and produce a Markdown report with a transparent coverage block.

Highlights:

- **Verbatim quote validation** with a hybrid strategy: normalized substring match (fast path) falls back to an LLM verdict for misses caused by PDF artifacts (line wraps, hyphenation, whitespace). Unvalidated quotes are flagged inline in the report rather than silently dropped.
- **Structured evidence schema** with a versioned registry. Two named schemas ship: `stellungnahmenReview/v1` for law-consultation notes and `corpusAnalysis/v1` for generic completeness analysis.
- **Reference workflow `stellungnahmen-review`** processes an uploaded PDF/DOCX/TXT and produces a Markdown audit report with per-document table (Nr | Paragraph | Forderung | Quelle) and validation status per quote. Generalises across laws via `lawReference` and `topicSeeds` runtime input.
- **Reference agent profile `completeness-analyst-stellungnahmen`** does the same job dynamically via the `evidence` tools, enabling A/B comparison between deterministic workflow and dynamic agent on the same input.
- **Loop hard cap raised** from 200 to 500 iterations to accommodate per-document analysis over larger corpora.

See `concepts/2026-06-02 Completeness Analysis Workflows.md` for the full design.

## Redesigned Admin Navigation — Collapsible Left-Rail Sidebar

The flat horizontal tab bar with a 20-item "More" dropdown has been replaced with a
collapsible left-rail sidebar organized into seven logical sections:
**Overview, AI Workspace, Access & Identity, Integrations, Customization, Observability, Platform**.

- Sidebar collapses to icon-only mode; state persists across page reloads
- Active section auto-expands on page load
- Mobile: off-canvas drawer with hamburger toggle
- Dark mode supported throughout

## Admin Overview Dashboard

The 12-tile app launcher has been replaced with an operations dashboard:

- **Stat cards**: total apps, active users (last 30 days), total conversations, platform version
- **Needs your attention**: surface for update alerts and actionable issues
- **Quick actions**: one-click access to common admin tasks
- **Setup checklist**: shown on fresh instances to guide initial configuration

## Admin Overview Dashboard — Platform Status and Accurate User Count

The overview dashboard now shows accurate registered user counts and a full platform status panel.

- **Users card** displays the number of registered users (not session IDs) with active sessions (last 30 days) as a subtitle
- **Platform status panel** shows enabled/total counts for providers, models, sources, and tools; group count; active authentication methods (Local, OIDC, LDAP, Proxy, Anonymous); and OAuth server status
- Update notifications are informational only and no longer appear in "Needs your attention"

## Cmd+K Command Palette — Entity Search

The Cmd+K (or Ctrl+K) command palette now searches across all entity types:

- Apps, models, prompts, providers, sources, and tools are all searchable
- Results navigate directly to the entity's edit page
- Works correctly under subpath deployments (e.g. `/ihub/`)

## Change History for All Configuration Entities

All entity edit pages (apps, models, prompts, sources, tools) now include a **History** button in the page header. Opening it shows a before/after diff of every saved change.

- Only changed fields are shown in the diff viewer — unchanged fields are hidden
- History is recorded for both form edits and raw JSON editor edits
- The History button appears at the top of the edit form next to Download and Back

## Audit Log Timestamps

The audit log now displays the correct timestamp for each event. Previously, the timestamp column was blank due to a field name mismatch between the server and client.

## Sidebar Independent Scrolling

The admin sidebar now scrolls independently from the main content area. Selecting an item from the bottom of the sidebar no longer scrolls the page content. The sidebar scrollbar auto-hides when not in use.

## System Page Reorganized into Focused Platform Pages

The monolithic System page has been split into four dedicated pages under Platform:

- **Security** — SSL certificates, CORS configuration, cookie settings, value encryption
- **Backup & Restore** — configuration export and import
- **Updates** — version information, update check, and rollback
- **Advanced** — force client refresh and escape-hatch operations

`/admin/system` redirects to `/admin/security`.

## Breadcrumbs on All Admin Edit Pages

Every admin edit page now shows a breadcrumb trail (e.g. **Admin › Models › gpt-4o-mini**) so admins always know where they are and can navigate back without relying on the browser's Back button.

## Unsaved Changes Guard

All 16 admin edit pages now warn before navigating away with unsaved changes. A confirmation dialog appears whenever an admin tries to leave a page with a modified form, preventing accidental data loss.

- Triggers on in-app navigation (clicking sidebar links, breadcrumbs, Cancel button)
- Also triggers on browser tab close and page refresh
- Admins can choose to leave (discard changes) or stay

## URL-Persisted Filter State

Admin list pages now store their filter and search state in the URL. Filters survive navigation — drill into a record, come back, and the filters are still set. Filtered views can also be bookmarked and shared.

Applies to: Apps, Models, Users, Workflows, Tools, Skills, Audit Log, Marketplace, Short Links, Workflow Executions.

## Keyboard Shortcuts

The admin UI now supports keyboard shortcuts for faster navigation:

| Shortcut | Action |
|----------|--------|
| `g` then `a` | Go to Apps |
| `g` then `m` | Go to Models |
| `g` then `p` | Go to Prompts |
| `g` then `u` | Go to Users |
| `g` then `g` | Go to Groups |
| `g` then `s` | Go to Sources |
| `g` then `l` | Go to Audit Log |
| `n` | New item (on list pages) |
| `?` | Show keyboard shortcut cheatsheet |
| `Cmd+K` / `Ctrl+K` | Open command palette |

## Admin UI Design System — Dark Mode, Micro-interactions, and Design Tokens

The admin UI has received a comprehensive visual polish pass:

- **Full dark mode coverage** — every admin page, table, form, badge, and status indicator now has correct dark-mode colors. Previously several agent, workflow, and user pages were missing dark variants.
- **Micro-interactions** — all admin buttons now scale down slightly on press (`active:scale-97`) with a 150ms transition for responsive tactile feedback.
- **Design tokens** — admin color values (`admin.accent`, `admin.surface`, `admin.border`, `admin.muted`) are now defined as Tailwind theme tokens, ensuring consistent color usage across the admin interface.

## Reusable Admin Page Template Shells

Three new layout components establish a consistent skeleton across admin pages:

- **`<AdminListPage>`** — container, breadcrumb, title + description, header actions, optional toolbar (filters / search), content slot.
- **`<AdminSettingsPage>`** — two-pane layout with a left-rail section nav (anchor-scrolled with active highlighting) and an optional sticky save bar at the bottom of the viewport. The save bar surfaces a "you have unsaved changes" indicator with Save / Discard buttons when the form is dirty.
- **`<AdminIntegrationHubPage>`** — header, search box, category-grouped grid of status-pilled integration cards.

Existing pages can adopt these incrementally — they still accept arbitrary children. The Security page now uses the two-pane layout (SSL, Cookies, CORS, Encryption sections). The Integrations page now uses the hub layout.

## Form Validation Error Summary Banner

When an admin tries to save an invalid app, model, prompt, group, or user, a red banner appears at the top of the form listing every validation error. Each entry is a clickable link that scrolls to and focuses the field. Errored fields stay highlighted with a red border until fixed.

Localized fields are fully supported: errors on `description.en` jump straight to the English input and read as "Description — English" in the banner. The kebab overflow menu in tables now supports full keyboard navigation (Esc closes, arrow keys cycle), and tables announce themselves as busy during loading.

## Unified Admin Tables

All 12 admin list pages (Models, Apps, Sources, Prompts, Tools, Workflows, Agents, Users, Groups, Pages, Short Links, Audit Log) now use a shared table component with consistent behavior:

- **Click column headers to sort** — works on every table, sort state survives reload via the URL.
- **Pagination** with 10 / 25 / 50 / 100 page sizes, also URL-persisted.
- **Sticky right-aligned actions column** — primary actions stay reachable when the table scrolls horizontally. On narrow screens, low-priority actions collapse into a ⋮ overflow menu.
- **Long values are clamped** so a long description can no longer stretch a column or blow up row height.
- **Consistent loading skeletons, empty states, and dark mode** across every table.

The Audit Log keeps server-side pagination but adopts the new page-number controls instead of Prev / Next only.

## OAuth Pages — Merged into a Single Tabbed Surface

The OAuth Hub, Authorization Server, and OAuth Clients pages now share a single tabbed header (`Overview` / `Authorization Server` / `Clients`). The three URLs (`/admin/oauth`, `/admin/oauth/server`, `/admin/oauth/clients`) remain deep-linkable, but the tab bar at the top makes them read as one surface. The Clients tab shows a count badge for the number of registered clients.

## Integration Hub — Status Pills, Category Grouping, and Search

The Integrations page now shows each integration's status as a colored pill (**Connected**, **Available**, **Disabled**, **Needs attention**) derived from platform.json. Integrations are grouped by category (Productivity, Cloud Storage, Ticketing) and a search box filters across title, description, and category.

## Audit Log Retention Policies

The audit log now supports a configurable retention policy.

- **Daily cleanup job** runs on the server (once on boot, then every 24 hours) and deletes daily JSONL files older than `auditLog.retentionDays`. Set `cleanupEnabled: false` to disable, or `retentionDays: -1` to keep entries forever.
- **Default**: 365 days. New installations get this via migration `V049__add_audit_log_retention`.
- **Audit Log page** shows a retention badge in the header (`Retain 365 days`) and a "Run cleanup now" link to trigger the job manually.
- **New endpoints**: `GET /api/admin/audit-log/retention`, `POST /api/admin/audit-log/retention/run`.

## Recent Activity Feed on Overview Dashboard

The admin Overview now shows a **Recent activity** card listing the eight most recent audit log entries (action pill, summary, admin, resource, relative time). Clicking "View all" jumps to the filtered Audit Log page.

## Chat Export — Proper Markdown Rendering in PDF and HTML

PDF and HTML chat exports now render the full assistant markdown instead of showing raw markup. The export previously used a limited hand-rolled parser that left GFM tables as raw `| ... |` text, emitted list items without proper `<ul>`/`<ol>` wrappers, and wrapped all block content in a single invalid `<p>` tag.

- Exports now use the same `marked` + DOMPurify pipeline the chat UI uses, so **tables, headings, ordered/unordered lists, code blocks, blockquotes, links, and horizontal rules** all render correctly.
- An isolated `marked` instance is used for exports so the downloaded document contains clean semantic HTML — no interactive copy/download toolbars or mermaid placeholders that wouldn't work outside the app.
- Added print-friendly styling for tables, code blocks, blockquotes, and links in the export template.

## Accessibility — WCAG 2.2 AA Tooling and Remediation

The platform now targets **WCAG 2.2 Level AA** (up from 2.1), strengthening alignment with EN 301 549 and BITV 2.0 for public-sector procurement.

- **Static analysis in CI**: `eslint-plugin-jsx-a11y` is wired into linting and runs on every pull request, surfacing missing labels, unlabeled controls, and keyboard-handler gaps.
- **Automated runtime scans**: the axe-core suite now scans against WCAG 2.2 AA rule tags and runs on every pull request via a dedicated Accessibility GitHub Actions workflow.
- **Remediations**: the Export dialog is now a proper focus-trapped modal (`role="dialog"`, Escape to close, focus restored on close); image remove/download buttons expose screen-reader labels; and footer links are grouped in a labeled navigation landmark.
- See **docs/accessibility.md** for the full compliance statement, keyboard reference, and manual testing checklist.

## MCP Servers — Easier Setup, Connection Testing, and Per-App Tool Selection

Configuring and using external MCP (Model Context Protocol) servers is now far smoother.

- **Readable "Add MCP server" dialog**: form fields are no longer invisible (white-on-white) — inputs now have proper borders and focus styling in both light and dark mode.
- **Test before you save**: a **Test connection** button inside the create/edit dialog probes the server (even with unsaved changes) and lists the tools it exposes, so you can verify credentials and discover tool names without saving first.
- **Dedicated MCP tools section in the app editor**: each app now has an **MCP server tools** section that groups available tools by server with per-tool and "select all" toggles, instead of requiring you to know and type MCP tool ids in the generic tools list.
- **Stronger gateway authorization**: the inbound MCP gateway now re-checks the caller's scope (and, for apps and workflows, their permissions) at call time — not just when listing — so revoked access takes effect immediately within a session.

## Fix — Spurious "Unsaved Changes" Prompt After Saving

Clicking **Save** on any admin edit page (apps, models, prompts, sources, users, groups, and others) no longer triggers the "You have unsaved changes" confirmation dialog. Saving now navigates back to the list immediately.

- The unsaved-changes guard previously used a stale dirty-state value captured before the save completed, so the navigation triggered by Save itself was treated as an unsaved-changes navigation.
- The guard now reads the live dirty state at navigation time, so genuine back/cancel navigation with unsaved edits is still protected.

## Clearer Document Size Warning on File Upload

The warning shown when an attached document may exceed the model's context window now names the file responsible, so users can tell which upload is too large.

- For a single document, the warning includes the file name (e.g. `"report.pdf" is large (~270,509 estimated tokens)…`).
- When multiple documents are attached, the warning makes clear the estimate is the **combined** total across all of them and lists each file with its individual token estimate, so it's obvious which files contribute most.

## File Attachments — Collapsible List Keeps the Chat Input in View

Attaching many files to a chat message no longer pushes the message box and send button off-screen. The attached-files list now stays compact regardless of how many files are queued.

- With **four or more files**, the list **auto-collapses** to a one-line summary (`12 files · 4.3 MB`) with a chevron to expand it. Users can expand or collapse it at any time.
- When expanded, the list is **height-capped and scrolls internally** — about 6 rows on desktop and 4 rows in the narrow Outlook task pane — so the chat input always remains reachable.
- **1–3 files** display exactly as before, with no extra controls.
- **Remove All** stays one click away in both the collapsed and expanded states, and loading files are reflected in the summary.

## MCP and JSON Schema Tools Now Work with Google Gemini

Tools whose parameter schemas include standard JSON Schema metadata — most notably tools exposed through MCP servers — now work with Google Gemini models. Previously these calls failed with a `400 INVALID_REQUEST` error from Google.

- Gemini's tool format rejects JSON Schema keywords such as `$schema` and `additionalProperties`, which MCP tools routinely emit. These keywords are now stripped from tool parameter schemas before the request is sent to Google.
- A parameter literally named `additionalProperties` is preserved, so legitimate tool inputs are unaffected.
- Other providers (OpenAI, Anthropic, Bedrock, Mistral) are unchanged.

## Agent Long-term Memory Now Survives Gemini Grounded Runs

Agents running on Google/Gemini models with web grounding (`webSearch`) configured used to lose every other tool on grounded steps because Gemini's API rejects `google_search` + function tools in the same call. The most damaging consequence: **memory writes never landed**, because `write_memory` was silently dropped on every grounded planner task.

iHub now writes long-term memory at the end of every agent run through a **deterministic memory-finalize step** that calls the memory store directly — no LLM, no tool registration, immune to the grounding swap. The synthesizer is now asked to emit a structured `{ report, memoryDelta }` payload; the finalize step drains `memoryDelta` into the agent's memory file.

- New workflow node type: `memory-finalize` (deterministic).
- Synthesizer system prompt and `outputSchema` now request a `memoryDelta` field alongside the report (set `memoryDelta: null` when there's nothing worth remembering).
- The legacy LLM-driven `write_memory` tool stays auto-registered as a fallback for non-Gemini agents and for explicit mid-run writes — the deterministic finalize is additive insurance, not a replacement.
- Profiles with `memory.enabled: false` are unchanged (no memory-finalize node, no `outputSchema` on the synthesizer).

## Planner Now Splits Grounding and Function-tool Work Across Separate Tasks

The agent planner has been updated to know about Gemini's mutual-exclusion constraint between native grounding (`webSearch` → `googleSearch`) and function tools. On Gemini-targeted runs, the planner now puts `webSearch` on research / fact-finding tasks and OMITS it from tasks that need memory writes, app calls, or `create_task` — so function tools survive on those tasks. When a single goal needs both, the planner is asked to decompose it into two `dependsOn`-linked tasks.

No configuration change is required; the planner's system prompt now contains the guidance. Existing profiles benefit automatically on the next run.

## Plan-and-Review Loop for Agents (Opt-in via `profile.review.enabled`)

Agents can now run their planner inside a **plan-and-review loop**: after the first round of planned tasks completes, a toolless reviewer judges whether the work answers the original brief comprehensively. If material gaps remain, control loops back to the planner, which emits ONLY new gap-closing tasks (with `r{round}_`-namespaced ids to prevent collisions). The cycle repeats until the reviewer is satisfied or the bounded round budget is spent, then the run synthesizes and writes memory once at the end.

New profile block:

```json
"review": {
  "enabled": true,
  "maxRounds": 3,
  "modelId": "<optional override>",
  "system": { "en": "<optional custom reviewer system prompt>" }
}
```

- The reviewer returns structured `{ needs_more_work, rationale, gaps }`; the engine increments `_reviewRound` and surfaces the gaps and prior task results to the next planner iteration.
- The shared planner budget caps total tasks across all rounds at 100, so a runaway loop cannot multiply task emission.
- Defaults to OFF — existing profiles are unchanged in shape. Enable on profiles where extending and re-verifying a plan adds more value than a single planner pass.

## Agent Profile Workflow Auto-Repair (Migration V052)

Server startup now rebuilds the embedded workflow definition for every agent profile under `contents/agents/profiles/` so each profile picks up the canonical `synthesize → memory-compose → memory-finalize` chain and a cleaned-up planner prompt.

Fixes two issues that affected existing hand-authored profiles:

- **Long-term memory was never written.** Profiles whose embedded workflow wired `synthesize → memory-finalize` directly (without the explicit `memory-compose` LLM node) produced no entries for the deterministic memory-finalize executor to drain, leaving the memory file empty.
- **Planner emitted a redundant review task.** Where `planner.system` still contained the legacy "add another planner task to review what has been done" instruction, the planner produced an extra task that ran as a generic research task and re-dumped the full report instead of focused gap-finding. The dedicated reviewer node + review-loop now own that responsibility.

- Profiles with `workflow.ref === "external"` are untouched.
- Idempotent — re-running the migration produces no further changes.
- Admin profile saves already go through the same serializer, so future edits stay in the canonical shape.

## Agent Planner Inbox-Item Template Fix (Migration V053)

Agent profiles authored before the inbox-item accessor fix used `${$.data.currentInboxItem}` as a JSONPath template in planner/memory prompts. The runtime stringified the matching object literally as `"[object Object]"`, so the planner LLM was handed garbage and produced no plan — review-loop runs completed without any tasks ever running, then synthesizer wrote a report from an empty evidence base.

Migration V053 normalizes the bare JSONPath form to `${$.data.currentInboxItem.text}` across all profile fields, then regenerates the embedded workflow so the corrected goal lands in the planner node. The matching default in the memory-composer prompt was also corrected.

- Handlebars-style `{{currentInboxItem}}` is unaffected (its templating layer already renders the inbox item correctly with priority prefix).
- Profiles with `workflow.ref === "external"` are untouched.
- Idempotent.

## Review-Loop Visibility & Memory-Skip Reason

Agent runs that loop through plan-and-review now surface the loop's lifecycle in the run timeline and tell operators when memory was deliberately not written.

- **Loop step log + SSE**: every loop node (review-loop, drain, forEach, …) now emits `agent.step.started`, per-iteration `agent.loop.iteration.started` / `agent.loop.iteration.completed`, and `agent.step.completed`. The loop also writes its own entry into `_stepLogs` with iteration count and per-iteration timings, so reviewers can see how many rounds ran and how long each took.
- **Structured outputs surfaced in step logs**: prompt nodes that declare an `outputSchema` (reviewer, memory-composer, structured-record, …) now persist the parsed result onto `stepLog.output`. The timeline shows the reviewer's `{needs_more_work, gaps, rationale}` and the memory-composer's `{skip, mode, summary}` instead of `output: null`.
- **Memory-finalize noop reason**: when nothing is written (because the composer chose to skip or returned empty content), the step log now records `noopReason` and `composerSummary`. The "Memory" row reads "composer chose to skip — <summary>" instead of looking like a silent failure.

## Planner Failure Visibility

When the planner LLM call fails (parse error, truncated response, 4xx/5xx, validation error), the run timeline now records a `planner` step log with `failed: true`, the error message, the resolved goal preview, model id, response length and token usage. Previously a planner failure left no step log behind and the run looked like the planner never ran.

The matching loop step log already captures per-iteration timings and `failedAtNodeId`, so operators can see at a glance which iteration broke and why.

## Planner Uses Strict Structured Output

The planner's LLM call now passes an explicit `responseSchema` (in addition to `responseFormat: 'json'`). Without a schema, Gemini's "JSON mode" only hints at the format and `gemini-flash-latest` was observed appending stray characters after the closing brace, producing a valid object followed by a spurious trailing `}` — the planner then failed parsing and the run silently completed without any tasks.

With a schema, Gemini enforces the exact shape (`tasks[]`, `reasoning`, optional `activate_then_replan` and `skills_used`) and the trailing-junk class of failures is closed off.

## Planner Catalogs: Per-Task Tools, Apps, Sources, Skills

The planner now sees the agent's actual catalog of configured resources and can spotlight a subset per task — but only ids it was given. Per-task `tools` was always additive in `SubWorkflowMaterializer`; `apps` and `sources` are now additive too.

- Each catalog (`tools`, `apps`, `sources`) is built from `profile.taskTemplate.{tools,apps,sources}` and shown to the planner in the user prompt with the literal id list.
- The response schema enum-binds every field to that catalog, so structured output rejects fabricated ids at the LLM boundary. Previously `gemini-flash-latest` with an unconstrained array field would degenerate into emitting dozens of look-alike hallucinated ids until it hit `maxTokens`.
- Empty catalogs are omitted from both the prompt template and the schema so the model isn't tempted to populate a field it has nothing to fill.
- `skills_used` and `activate_then_replan` are still plan-level and now enum-bound to the names in `<available_skills>`.

## Gemini Structured Output Now Actually Enforced

The Google adapter was sending the response schema to Gemini under the snake-case field name `response_schema`, but Gemini's REST API expects `responseSchema` (camelCase) — the snake variant is silently dropped. Every workflow node that declared an `outputSchema` (reviewer, memory-composer, planner, etc.) was running in vanilla JSON-mode despite our calls. Renaming the field activates real structured output: trailing-junk failures, hallucination loops, and shape drift go away at the API boundary instead of being post-parsed (and frequently failing) on our side.

## Review Loop, Memory Composer, and Memory Finalize Visible in Run Timeline

The agent run timeline now shows four rows that were previously invisible:

- **Reviewing** — appears after the plan tasks. Description reflects the reviewer's structured verdict: "Round N: complete — no material gaps" or "Round N: more work needed — K gap(s)". Step log carries the full `{needs_more_work, rationale, gaps}` payload.
- **Composing memory** — appears after the synthesizer. Description shows the composer's decision: "Composer chose to skip — \<summary\>" or "Composer append — \<summary\>".
- **Memory written** / **Memory skipped** — final deterministic step. Title and description reflect actual outcome: how many updates were written, or why it skipped (composer skip, empty content, no profile id).

Each row pulls from its node's persisted `_stepLogs[nodeId]` entry, so the timeline survives a refresh.

## Planner: One Entity Per Task

Added an explicit decomposition rule to the canonical planner system prompt: when the brief lists multiple distinct subjects (people, products, companies, documents), emit a separate task for each one. "Research A and B" is two tasks, never one; "Research products X, Y, Z" is three tasks, never one. The only exception is when the comparison itself is the deliverable — and even then, per-entity research tasks feed a separate comparison task via `dependsOn`.

Existing profiles with hand-authored `planner.system` overrides are unaffected — operators who want this rule on those profiles need to add it to their override.

## Planner Decomposition: One Angle Per Task

When the brief enumerates multiple distinct angles for the same subject (e.g. "find out who X is, what they have written, their views on Y, and collect quotes"), the planner now emits a separate task per angle instead of one broad task. A single broad task with 25 tool iterations still tends to context-switch across angles and dilute coverage; a focused task with 3–5 searches on one angle reliably produces deeper, better-cited output.

The canonical planner system prompt now carries an explicit **DECOMPOSITION TEST**: read each task's title and description back — if it contains "and" joining research subjects, or a comma-separated list of distinct angles, it must be split. Three worked examples (Rowan Curran's 4 angles, two people, three products) are included so the model has anchors.

Migration **V054** clears stale `planner.system` overrides on agent profiles that were verbatim snapshots of the old default. Operator-customized prompts (longer than the snapshot or with a different opening sentence) are left untouched. Cleared profiles fall back to the canonical default at runtime, so the new decomposition rules take effect immediately on next server restart.
