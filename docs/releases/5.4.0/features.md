# Features — 5.4.0

## Privacy: IP anonymization, rollup & feedback retention

Three new `platform.json` settings give admins finer control over what PII iHub
keeps on disk:

- **`audit.anonymizeIp`** — set to `true`/`"mask"` to truncate the client IP on
  every audit-log entry (`/24` for IPv4, `/48` for IPv6), or `"drop"` to omit
  the field entirely. Default `false` preserves existing behaviour.
- **`logging.anonymizeIp`** — same shape, applied to the IP merged into every
  structured log line by the per-request `AsyncLocalStorage` context.
- **`usageTracking.feedbackRetentionDays`** — drop `feedback.jsonl` entries
  older than N days on the existing hourly rollup cycle. Default `-1` keeps
  history forever (pre-5.4.0 behaviour).

The previously-unwired `usageTracking.dailyRetentionDays` and
`usageTracking.monthlyRetentionDays` are now honoured — daily and monthly
rollup files past the configured retention are deleted alongside the existing
event-log cleanup. Defaults (365 d / -1) are unchanged.

A new doc at `docs/pii-data-handling.md` catalogues every PII category iHub
captures, the retention default, and which switch disables or anonymizes it,
plus a recommended privacy-first configuration block.

## Stellungnahmen Review from iFinder — Lazy Per-Document Corpus

A new workflow, **`stellungnahmen-review-ifinder`**, runs the same audit-grade Stellungnahmen evidence extraction as the upload variant, but pulls candidates from iFinder by topic and loads each document's fulltext one at a time inside the iteration loop. Useful for ministry-scale consultations (200+ documents) that exceed the chat upload ceiling.

- **Lazy fetch**: `corpus-search` runs in metadata-only mode (`fetchFulltext: false`); the per-doc `iFinder_getContent` call happens just before extraction and is cleared between iterations.
- **Refinement loop**: an LLM decision node inspects the candidate list after each search round and can request additional topics, capped at 3 rounds. One search is rarely enough on broad consultations.
- **Same audit guarantees**: the extract prompt and JSON schema are identical to the upload variant — `quote-validator` and downstream consumers work unchanged.

## Admin-driven Corpus Discovery via Generic Memory-Builder Endpoint

A new admin endpoint runs any registered tool with admin context and writes the result to an agent profile's long-term memory under a named section:

```
POST /api/admin/agents/profiles/<id>/memory/from-tool
  { toolId, params, section, mode }
```

This is provider-agnostic. The canonical use case is **iFinder corpus discovery**: a new `iFinder_discover` tool function probes a configured search profile, returns facets and sample titles as ready-to-paste markdown, and the admin stores it under `## iFinder corpus map` so downstream agent runs and workflows can read it via the existing memory auto-include.

- **Access control**: gated by `adminAuth` — any registered tool can be invoked with admin context.
- **Workflow integration**: a new `readAgentMemorySection` transform op lets workflows pull a named section from a configured profile's memory; `stellungnahmen-review-ifinder` uses this to feed the corpus map into its `query-plan` node when an `agentProfileId` is supplied.
- **`iFinder_discover` is not exposed to agents at runtime** — only the admin endpoint can call it. Operators re-run discovery when the iFinder index changes materially.

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

- **Daily cleanup job** runs on the server (once on boot, then every 24 hours) and deletes daily JSONL files older than `audit.retentionDays`. Set `audit.cleanupEnabled: false` to disable, or `retentionDays: -1` to keep entries forever.
- **Default**: 365 days. Retention now lives in the unified `audit` config block (migrated automatically from the former `auditLog` block by `V059`).
- **Audit Log page** shows a retention badge in the header (`Retain 365 days`) and a "Run cleanup now" link to trigger the job manually.
- **New endpoints**: `GET /api/admin/audit-log/retention`, `POST /api/admin/audit-log/retention/run`.

## Audit Log — Authentication, OAuth, and User Events + CSV Export

The audit log now captures the security-relevant events that compliance reviews (SOC 2, ISO 27001, EU AI Act) expect, not just configuration changes:

- **Authentication events**: successful and failed logins (local, LDAP, NTLM, OIDC) and logouts are recorded with the actor, outcome, and source. Failed logins capture the attempted username even though no session exists.
- **OAuth clients & API keys**: creating, updating, deleting, and rotating client secrets, plus generating static API keys. Secrets and keys are never written to the log.
- **User management**: creating, updating, and deleting user accounts. Passwords are never written to the log.
- **Global safety net**: any other mutating admin request (POST/PUT/PATCH/DELETE) is recorded automatically, so new endpoints are covered without extra wiring.
- **Richer entries**: each entry now records an `actor` (id, username, groups, authenticated), a `result` (`success`/`failure`), and a `source` (`web`/`admin`/`api`/`mcp`). The Audit Log page adds **Result** and **Source** columns and filters.
- **CSV export**: an **Export CSV** button (and `GET /api/admin/audit-log/export`) downloads the currently filtered entries.
- **Privacy & SIEM options** (`platform.json` → `audit`, added by migration `V059__add_audit_options`): `includeEmail` (default `false`) masks email-shaped identifiers; `verbosity` (`metadata`/`request`/`full`) controls how much request detail the safety net records; `winstonMirror` (default `false`) also emits entries to the structured logger (`component: audit`) for SIEM forwarding.

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

## Outlook Add-in — Scales Correctly on Small / High-DPI Laptops

The iHub add-in in Outlook now sizes itself to the available task pane instead of rendering everything oversized on small, high-resolution laptops (e.g. a 13" Windows device at 125–150% display scaling). Previously users had to manually zoom the add-in out to fit the app tiles, chat input, and attachments on screen.

- The add-in now uses a fluid base scale keyed to the task pane width, so the whole interface — app tiles, chat input, attachment chips, and dialogs — shrinks together on narrow or high-DPI panes and returns to full size on wider panes.
- The app-selection tiles, which previously stayed at a fixed desktop size, now scale with the rest of the add-in.
- No configuration required; the behavior applies automatically in the Outlook (and other Office) task pane.

## MCP and JSON Schema Tools Now Work with Google Gemini

Tools whose parameter schemas include standard JSON Schema metadata — most notably tools exposed through MCP servers — now work with Google Gemini models. Previously these calls failed with a `400 INVALID_REQUEST` error from Google.

- Gemini's tool format rejects JSON Schema keywords such as `$schema` and `additionalProperties`, which MCP tools routinely emit. These keywords are now stripped from tool parameter schemas before the request is sent to Google.
- A parameter literally named `additionalProperties` is preserved, so legitimate tool inputs are unaffected.
- Other providers (OpenAI, Anthropic, Bedrock, Mistral) are unchanged.

## Export Dialog — Reliable in Outlook and on Small Screens

The chat export dialog now works inside the Outlook task pane and the browser-extension side panel, and adapts cleanly to narrow widths.

- **PDF export no longer crashes in embedded hosts.** Printing previously relied on opening a new browser window, which is blocked in the Outlook task pane and produced a "null is not an object" error. Export now prints through an in-place hidden frame and, where printing is unavailable, downloads the formatted document as HTML instead.
- **Responsive layout:** the format picker switches to a single column on narrow screens and the action buttons stack full-width, so the dialog stays usable in the Outlook task pane and on phones.
- **Copy button reflects the selected format:** it is now enabled only for formats that can be copied as text (Text, Markdown, JSON, JSON Lines) and disabled with an explanatory tooltip for PDF, Word, Excel, PowerPoint, CSV, and HTML.
- The dialog can be dismissed with the **✕ button** or the **Esc** key.

## iHub Documentation as a Standard Knowledge Source

iHub now ships with a built-in **iHub Documentation** source so apps can answer questions about the platform itself — configuration, authentication, features, and operations.

- The source bundles the complete product documentation (consolidated from the `docs/` folder) into a single knowledge source.
- It is exposed **as a tool**, so an app's model retrieves the documentation on demand instead of inflating every prompt. Add it under an app's **Sources** to build a self-service help or onboarding assistant.
- Available out of the box on new installations; existing installations receive it automatically on upgrade.
- The bundled content is generated automatically at build time (and on `npm run setup:dev`) from the docs, so it stays in sync without manual maintenance.

## Agent Long-term Memory Now Survives Gemini Grounded Runs

Agents running on Google/Gemini models with web grounding (`webSearch`) configured used to lose every other tool on grounded steps because Gemini's API rejects `google_search` + function tools in the same call. The most damaging consequence: **memory writes never landed**, because `write_memory` was silently dropped on every grounded planner task.

iHub now writes long-term memory at the end of every agent run through TWO new dedicated steps, slotted between the synthesizer and inbox-finalize:

1. **`memory-compose`** — a toolless LLM node that sees the brief, every sub-task result, the citations ledger, the tools/apps the agent used, and the current memory file, then returns a structured `{ skip, mode, content, summary }` delta. The flat schema is Gemini-friendly (no union types) and the composer is told to cite the tool/URL behind each fact, skip duplicates, and prefer append over replace.
2. **`memory-finalize`** — a deterministic node that drains the composer's delta into `memoryFile.writeMemory()` directly. No LLM, no tool registration, immune to the grounding swap.

The synthesizer stays plain text (no JSON schema), so the Gemini structured-output proto issue can't recur on the report path. Operators get dedicated `profile.memory.{modelId, temperature, system, prompt}` knobs for memory hygiene.

- New workflow node types: `memory-compose` (LLM, toolless) and `memory-finalize` (deterministic).
- The legacy LLM-driven `write_memory` tool stays auto-registered as a fallback for non-Gemini agents and for explicit mid-run writes — the deterministic finalize is additive insurance, not a replacement.
- Profiles with `memory.enabled: false` skip both new nodes (no `memory-compose`, no `memory-finalize`).

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
- The prior embedded workflow definition is **snapshotted into `workflow._preMigrationV052Backup`** before regeneration, so operators with hand-authored customizations (extra nodes, custom timeouts, inline edges) can recover them. The migration log records added / removed node ids per profile.
- Idempotent — re-running the migration finds the backup already present and produces no further changes.
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

## Security: Workflow HTTP Node SSRF Bypass Fixed

The SSRF guard that protects workflow HTTP-request nodes from reaching internal hosts and cloud metadata endpoints could be bypassed with an IPv4-mapped IPv6 address written in hex form (e.g. `http://[::ffff:a9fe:a9fe]/`, which is `169.254.169.254` — the AWS instance-metadata address). The address-classifier now parses every IPv6 literal to its canonical bytes and blocks it by network range regardless of how it is written, so the mapped-hex, dotted, and NAT64 (`64:ff9b::`) forms of an internal address are all caught.

- Closes the IPv4-mapped-IPv6 hex bypass (GHSA-fp9c-pq7w-vr34).
- Adds the shared-address / CGNAT range `100.64.0.0/10` to the blocklist.
- Pins each request to the exact IP addresses validated by the guard, closing a DNS-rebinding window where a hostname could resolve to a public IP during the check and an internal IP at connect time. Pinning applies to direct connections; when an outbound HTTP proxy is configured the proxy remains the egress boundary.

No configuration change is required. This affects any deployment whose workflows feed request-controlled input into an HTTP node's URL (including the public webhook trigger and chat `@mention` / MCP run triggers).

## Admin: Global SSRF Allowlist for Internal Services

Admins can now permit outbound HTTP calls to intentionally internal hostnames from a single place: **Admin → Security → SSRF Allowlist**. Entries support the same patterns as the SSL whitelist — exact (`api.internal.company.com`), wildcard (`*.intrafind.io`), and subdomain (`.example.com`). Patterns matching a hostname bypass the private-IP veto for OpenAPI tool spec fetches, OpenAPI tool runtime calls, MCP server connections, and any other path that goes through `safeFetch`.

- Previously the allowlist was per-tool (`openapi.security.allowedHosts`) or per-MCP server, and the OpenAPI builder's "Fetch & parse" button had no override at all — so internal OpenAPI specs could only be onboarded by hand-editing `tools.json` or by pasting the spec inline.
- DNS pinning, IPv4-mapped-IPv6 hex coverage, and CGNAT blocking remain unchanged; the allowlist only suppresses the private-IP rejection for matched hostnames.
- Configured via `platform.json` under `ssrf.allowedHosts: []` (migration V061 seeds the empty default).

## OpenAPI Tools — Zero-Code Third-Party Integrations

Admins can now turn any OpenAPI-described API into a callable agent tool without writing code. Add a tool of type **OpenAPI**, paste the OpenAPI document URL, pick an operation, and choose a credential — iHub validates the model's arguments against the operation schema, performs the call, and returns the result to the agent.

- Supports OpenAPI 3.0 and 3.1 (operations, parameters, request bodies).
- Auth via the credential store: bearer, basic, API key (header or query), and OAuth2 (client-credentials with automatic token refresh).
- Outbound calls run through the SSRF guard (private IPs blocked unless explicitly allow-listed) and per-tool rate limiting.
- Responses can hide sensitive fields (`x-display` hide list), are capped at 256 KB, and large arrays are paginated automatically.
- A new admin "OpenAPI" editor parses the document and lists operations to pick from.

## Central Credential Store

Integration secrets now live in one place: **Admin → Credentials**. Create named, encrypted credential profiles (OAuth2, bearer, basic, API key, or opaque secret) and reference them from integrations and OpenAPI tools instead of pasting secrets into each section.

- Secrets are encrypted at rest and never returned to the browser (shown as `***REDACTED***`).
- Jira, OIDC, LDAP, NTLM, cloud storage, iFinder, and MCP servers now reference a credential profile instead of holding an inline secret.

## Thinking / Reasoning for OpenAI and vLLM Models

Reasoning models served via the OpenAI and vLLM providers now show their thinking in the
same dedicated "thinking" stream already used for Gemini — separate from the final answer.
This covers true OpenAI reasoning models, OpenAI-compatible endpoints (DeepSeek, OpenRouter,
gpt-oss), and vLLM-served models like Qwen3 and DeepSeek-R1.

- Add `"thinking": { "enabled": true }` to a model config to turn it on. Optionally set
  `"level": "minimal" | "low" | "medium" | "high"` to control reasoning effort.
- For vLLM, start the server with a matching `--reasoning-parser` and (if needed) set
  `thinking.chatTemplateKwargs` to the model's toggle, e.g. `{ "enable_thinking": false }`
  for Qwen3 or `{ "thinking": true }` for Granite.
- App-level and per-user thinking toggles continue to override the model defaults, the same
  way they do for Gemini.

The OpenAI adapter stays conservative: it adds `reasoning_effort` only and does not change
`max_tokens` or `temperature`, so existing OpenAI-compatible endpoints are unaffected.

## Admin-Configurable Favicon (Branding)

The browser tab icon (favicon) can now be set from the admin panel instead of patching `index.html`. This completes the corporate-design / white-labeling branding set alongside the existing logo, theme colors, custom CSS, and live theme preview.

- A new **Favicon URL** field under **UI Customization › Header** accepts a path or an uploaded asset (e.g. `/favicon.ico` or `/uploads/assets/brand-icon.png`).
- The favicon is applied live in the browser without rebuilding or editing HTML; leave it empty to keep the built-in default.
- Stored as `header.favicon` in `ui.json`. Existing installations receive the default automatically via migration `V057__add_header_favicon`; no manual action required.

## Unified Login Dialog (Auth Gate Everywhere)

The app now uses a single login dialog — the auth gate — for every sign-in entry point. Clicking **Login** in the header, visiting the `/login` page, and being prompted after a session expires all open the same gate, which supports every configured method (local, LDAP, OIDC/SSO, Windows/NTLM).

- **One consistent dialog**: the separate in-app login modal has been retired, so the look, behavior, and available methods no longer differ between the startup screen and the in-app login.
- **Remember me**: the gate now offers a "Remember me" option (checked by default) that pre-fills your username on the next visit, matching the previous in-app form.
- **Login button always available**: the header always shows a **Login** button when sign-in is possible, regardless of how you entered the app — no more missing or empty user menu.
- Logout and post-login redirect behavior are unchanged.

## Clearer Model Limits — Context Window vs. Output Tokens

Model configuration now separates two distinct concepts that were previously conflated under a single `tokenLimit` field:

- **`contextWindow`** — the model's total input+output capacity. Used to estimate how much of a model's context an upload or conversation consumes, and to warn users before they exceed it.
- **`maxOutputTokens`** — the cap on what the model may generate in a single response, sent to the provider as `max_tokens`.

Highlights:

- Document-size warnings in the chat input are now measured against the model's **context window** (the correct frame of reference) and use an accurate tokenizer instead of a rough character estimate.
- Model details now display **Context Window** and **Max Output Tokens** as separate values.
- Fixes a latent bug where large-context models (e.g. Claude Opus) requested their full context window as the output cap, which could cause provider errors.

Admins editing models will see two fields (Context Window, Max Output Tokens) instead of one Token Limit.

## Fix — High GPU Usage When Viewing Long Chats

Open chat conversations no longer keep the GPU busy while idle. Every rendered assistant message was permanently promoted to its own GPU compositor layer, so a long or old conversation parked dozens of layers in video memory and saturated the browser's compositing budget even when nothing was happening on screen.

- The GPU-acceleration hint is now applied only to the single message that is actively streaming, where it actually helps smooth incremental rendering, and is dropped once the response completes.
- Measured effect: an idle chat now promotes **zero** extra compositor layers regardless of length (previously up to the browser's layer cap). No configuration change required.

## Fix — Audit Log No Longer Spammed by Session Starts

The audit log no longer records a `POST /api/session/start -> 200` entry every time an app loads. These high-frequency, low-value entries were drowning out the events admins actually care about (logins and logouts).

- Session-start requests are now excluded from the generic audit safety-net, matching how chat, inference, and page reads are already treated.
- Login and logout continue to be audited via their own explicit hooks — no change to security-relevant events.

## Fix — Session Expiry in the Admin Area Returns You to the Same Page

When an admin's session expires while they are working in the admin panel, signing back in through the login dialog now returns them to the admin page they were on, instead of dropping them on the application home screen.

- Previously an expired session triggered a hard redirect to the home page the moment an admin request failed, so the login dialog opened on the home screen and admins had to navigate all the way back into the admin area after re-authenticating.
- The admin panel now uses the same in-place re-authentication as the rest of the app: the login dialog appears over the current page, and after signing in the admin stays exactly where they were. This also covers file-upload (multipart) admin requests, which previously bypassed the re-authentication prompt entirely.

## Fix — Outlook `.msg` Files Can Now Be Selected for Upload

Uploading Outlook `.msg` email files now works. In the file picker, `.msg` files appeared greyed out and could not be selected even on apps that listed MSG as a supported format, while `.eml` files worked.

- The upload component never loaded the server's MIME-type configuration, so the file picker's accepted-types list was built from a minimal built-in fallback that omitted the `.msg` file extension. Because the Outlook MIME types (`application/vnd.ms-outlook`) are not recognised by the operating system's file dialog, `.msg` files had no matching rule and were blocked. `.eml` was unaffected because its MIME type (`message/rfc822`) is understood by the OS even without the extension. The component now loads the full configuration, so every configured format — `.msg`, `.eml`, `.xlsx`, `.pptx`, OpenOffice formats, and more — is correctly offered in the file picker.
- The MSG format also no longer appears twice when configuring an app's upload formats. `.msg` had been registered under two MIME types (`application/vnd.ms-outlook` and a redundant `application/x-msg`), producing duplicate "MSG" entries in the admin upload-format selector. The duplicate is removed automatically on upgrade (migration **V064**); `application/vnd.ms-outlook` remains the single canonical type.

## Fix — Outlook `.msg` Files Now Process After Selection

Once a `.msg` file could be selected, uploading it still failed with an "Error processing file" message and the email's contents were never extracted. Selecting and uploading an Outlook `.msg` email now reads its subject, sender, recipients, and body as expected.

## Fix — `.msg` Body Now Extracted from HTML-only Emails (Newsletters)

Uploading an Outlook `.msg` email that has no plain-text part — most newsletters and richly formatted mails — previously returned only the `Subject`, `From`, and `To` lines, with the actual message body missing. The full body is now extracted in every case.

- The body is resolved across every format Outlook may store it in: plain text, HTML (`PidTagHtml` / `PidTagBodyHtml`), and compressed RTF. HTML and RTF bodies are flattened to readable text, decoded using the message's declared code page so accented characters and umlauts survive.
- Sender and recipient lines now prefer real SMTP addresses (e.g. `name@company.com`) over the internal Exchange directory address (`/O=EXCHANGELABS/...`) that Outlook stores for internal mail.
- The extracted headers now also include the message **Date** and a list of **attachment names** (names only, not their content) for additional context.

## Fix — Custom Rendered Components (e.g. NDA Risk Analyzer) No Longer Fail to Display

Apps that render their results with a custom React component — such as the NDA Risk Analyzer's color-coded risk report — now display correctly again. Affected components had stopped rendering and showed a blank result or a `_jsxs is not defined` error in the browser console.

- The in-browser JSX compiler used by dynamic page and result renderers now pins the classic React runtime. A newer build of the underlying Babel library had begun defaulting to a different JSX runtime that expects helper imports the sandbox does not provide, which broke any custom-rendered component. No configuration change is required.

## Ephemeral Chats — Conversations That Are Never Stored

Apps can now be marked **ephemeral** so their chats are never persisted anywhere. Messages exist only in memory while the chat is open and are discarded the moment the user switches to another app or reloads the page — nothing is written to the browser's session/local storage, and for iFinder/iAssistant apps the backend conversation is created as ephemeral so no server-side record is kept.

- Enable it per app with the new **Ephemeral chat** toggle in the admin app editor, or by setting `"ephemeral": true` in the app configuration.
- End users can also switch it on or off at runtime from the chat's configuration panel (the **Ephemeral chat** checkbox), seeded from the app's default. Admins can hide this control per app with `"settings": { "ephemeral": { "enabled": false } }`.
- The built-in **iFinder Document Actions** app now ships with ephemeral enabled by default, so document conversations leave no trace.
- The flag is independent of chat history: when persistent chat history arrives in the future, ephemeral apps will remain opted out.
- Default is `false`, so all existing apps keep their current behaviour.

## AI OCR: custom prompt limited by tokens, not characters

The **Custom OCR Prompt** field in the AI OCR tool (Tools Service) is now bounded by token count instead of a raw 2,000-character cap, using the same token estimator as the chat. This lets admins write longer, more detailed OCR prompts.

- The limit is now **4,096 tokens** (previously 2,000 characters).
- The character counter under the prompt box is replaced by a live token counter (`N / 4096 tokens`) that turns red and blocks submission when the limit is exceeded.
