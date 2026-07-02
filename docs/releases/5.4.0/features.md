# Features — 5.4.0

## Agents & workflows

### Plan-and-review loop (opt-in)

Agents can run their planner inside a **plan-and-review loop**. After the first round of tasks completes, a toolless reviewer judges whether the work answers the brief; if material gaps remain, control loops back to the planner, which emits ONLY new gap-closing tasks (with `r{round}_`-namespaced ids). The cycle repeats until the reviewer is satisfied or the round budget is spent, then the run synthesizes and writes memory once.

Enable per profile:

```json
"review": { "enabled": true, "maxRounds": 3, "modelId": "<optional>", "system": { "en": "<optional reviewer prompt>" } }
```

Defaults to OFF. The shared planner budget caps total tasks across all rounds at 100 so a runaway loop can't multiply task emission.

### Date-aware runs with fewer verification rounds

Agent runs now know the current date, and the phased agent stops over-verifying simple questions — together this sharply cuts review rounds and wall-clock time.

- **Temporal context everywhere.** The planner, task workers, report writer, and verifier all receive the real current date/timezone. Previously they had no notion of "today", so a run could write a date the verifier flagged as "in the future" and loop until it gave up. `{{date}}`, `{{year}}`, and `{{timezone}}` placeholders now work inside agent prompts.
- **Tighter retry budget.** The Claude-style (Phased) profile caps review at **3 rounds** (was 6) and bails sooner when rounds stop improving (`stallLimit` 4 → 2). Adjust under the profile's **Review** settings.
- **More accurate reports.** The report writer is now forbidden from letting the summary overstate the body, or attributing a figure/quote to a source that doesn't contain it — the embellishment that used to trigger extra rounds.

### Reliable planner decomposition and structured output

The planner produces cleaner, better-scoped plans and no longer silently fails on malformed model output.

- **One subject or angle per task.** When a brief lists multiple subjects ("Research A and B" → two tasks) or multiple angles for one subject ("who they are, what they wrote, their views on Y"), the planner splits them. A built-in **decomposition test** and worked examples anchor the rule. Migration **V054** clears stale verbatim `planner.system` overrides so the rule takes effect; customized prompts are left untouched.
- **Strict structured output.** The planner now sends an explicit `responseSchema` (not just `responseFormat: 'json'`), closing the trailing-junk / hallucinated-id failures that left runs with no tasks.
- **Per-task catalogs.** The planner sees the agent's actual `tools`, `apps`, and `sources` and can spotlight a subset per task — but only ids it was given; the schema enum-binds each field so fabricated ids are rejected at the LLM boundary.
- **Gemini grounding split.** On Gemini runs the planner keeps `webSearch` on research tasks and omits it from tasks needing memory writes / app calls / `create_task` (Gemini rejects `googleSearch` + function tools in one call), decomposing into `dependsOn`-linked tasks when a goal needs both. No configuration change required.

### Long-term memory that survives Gemini grounded runs

Memory writes used to be silently dropped on Gemini grounded steps. iHub now writes memory at the end of every run through two dedicated nodes: **`memory-compose`** (a toolless LLM node that returns a structured `{ skip, mode, content, summary }` delta) and **`memory-finalize`** (a deterministic node that drains the delta directly, immune to the grounding tool-swap). Operators get `profile.memory.{modelId, temperature, system, prompt}` knobs; profiles with `memory.enabled: false` skip both nodes. The legacy `write_memory` tool remains as a fallback for non-Gemini agents.

### Run-timeline visibility

Agent runs now surface the parts of the lifecycle that used to be invisible.

- **Review loop, memory composer, and memory finalize** appear as timeline rows with their structured verdicts (e.g. "Round 2: more work needed — 3 gaps", "Composer chose to skip — <summary>", "Memory written / skipped — <reason>"). Loop nodes emit per-iteration start/complete events and record iteration counts and timings.
- **Planner failures are recorded.** A failed planner call (parse error, truncation, 4xx/5xx, validation) now writes a `planner` step log with the error, goal preview, model id, and token usage instead of leaving no trace.
- **Gemini structured output is now actually enforced** — the Google adapter was sending the schema under `response_schema` (snake_case) which Gemini silently drops; it now uses `responseSchema`, so every `outputSchema` node runs in true structured-output mode.

### Completeness-analysis workflows (audit-grade Stellungnahmen)

A reusable set of workflow primitives for **audit-grade corpus-completeness analysis**, plus a reference workflow and agent profile for German government law-consultation review.

- Three node types (`evidence-collect`, `quote-validator`, `report-compose`) and an `evidence` tool family extract structured findings, verify every cited quote against the source, and produce a Markdown report with a coverage block.
- **Verbatim quote validation** uses a normalized substring match with an LLM fallback for PDF artifacts (line wraps, hyphenation); unvalidated quotes are flagged inline, never silently dropped.
- Ships two versioned schemas (`stellungnahmenReview/v1`, `corpusAnalysis/v1`), a reference workflow `stellungnahmen-review` (upload a PDF/DOCX/TXT → audit report), and a reference agent profile `completeness-analyst-stellungnahmen` for A/B comparison. Loop hard cap raised from 200 to 500 iterations. See `concepts/2026-06-02 Completeness Analysis Workflows.md`.

### Stellungnahmen review from iFinder (lazy per-document corpus)

A new workflow `stellungnahmen-review-ifinder` runs the same extraction as the upload variant but pulls candidates from iFinder by topic and loads each document's fulltext one at a time — for ministry-scale consultations (200+ documents) that exceed the chat upload ceiling. `corpus-search` runs metadata-only; the per-doc `iFinder_getContent` happens just before extraction and is cleared between iterations. An LLM decision node can request more topics (capped at 3 rounds). Audit guarantees are identical to the upload variant.

### Admin-driven corpus discovery

A new endpoint runs any registered tool with admin context and writes the result into an agent profile's long-term memory under a named section:

```
POST /api/admin/agents/profiles/<id>/memory/from-tool   { toolId, params, section, mode }
```

The canonical use is **iFinder corpus discovery**: `iFinder_discover` probes a search profile and returns facets and sample titles as markdown to store under `## iFinder corpus map`. A `readAgentMemorySection` workflow transform feeds a named section into workflows (used by `stellungnahmen-review-ifinder`). Gated by `adminAuth`; `iFinder_discover` is not exposed to agents at runtime.

### Profile auto-repair on startup (migrations V052, V053)

Server startup rebuilds each profile's embedded workflow so it picks up the canonical `synthesize → memory-compose → memory-finalize` chain and a cleaned planner prompt. This fixes profiles where memory was never written (missing `memory-compose` node) or the planner emitted a redundant review task. **V053** also normalizes the `${$.data.currentInboxItem}` template to `.text` so the planner receives real content instead of `"[object Object]"`. The prior definition is snapshotted to `workflow._preMigrationV052Backup`; profiles with `workflow.ref === "external"` are untouched; both migrations are idempotent.

## Admin experience

### Redesigned navigation — collapsible left-rail sidebar

The flat tab bar with a 20-item "More" dropdown is replaced by a collapsible left-rail sidebar organized into seven sections: **Overview, AI Workspace, Access & Identity, Integrations, Customization, Observability, Platform**. It collapses to icon-only (state persists), auto-expands the active section, becomes an off-canvas drawer on mobile, scrolls independently from content, and supports dark mode throughout.

### Overview dashboard

The 12-tile launcher is replaced by an operations dashboard:

- **Stat cards**: total apps, registered users with active sessions in the last 30 days (real users, not session IDs), total conversations, platform version.
- **Platform status panel**: enabled/total counts for providers, models, sources, and tools; group count; active auth methods (Local, OIDC, LDAP, Proxy, Anonymous); OAuth server status.
- **Needs your attention**, **Quick actions**, a fresh-instance **setup checklist**, and a **Recent activity** card showing the eight latest audit entries (update notifications are informational only).

### Command palette (Cmd+K)

`Cmd+K` / `Ctrl+K` searches across apps, models, prompts, providers, sources, and tools, navigating straight to the edit page. Works under subpath deployments (e.g. `/ihub/`).

### Change history for every entity

All entity edit pages (apps, models, prompts, sources, tools) get a **History** button showing a before/after diff of each saved change — only changed fields, for both form and raw-JSON edits.

### Unified tables

All 12 admin list pages share one table component: click-to-sort headers, pagination (10/25/50/100), a sticky right-aligned actions column that collapses to a ⋮ overflow menu on narrow screens, clamped long values, and consistent loading skeletons, empty states, and dark mode. Sort and pagination persist via the URL. (The Audit Log keeps server-side pagination with the new page-number controls.)

### Filters, navigation, and shortcuts

- **URL-persisted filters** on list pages — drill in, come back, filters are still set; views are bookmarkable and shareable (Apps, Models, Users, Workflows, Tools, Skills, Audit Log, Marketplace, Short Links, Executions).
- **Breadcrumbs** on every edit page (e.g. Admin › Models › gpt-4o-mini).
- **Unsaved-changes guard** on all 16 edit pages — warns on in-app navigation, tab close, and refresh. (Saving no longer trips it: the guard now reads the live dirty state at navigation time.)
- **Keyboard shortcuts**: `g` then `a`/`m`/`p`/`u`/`g`/`s`/`l` to jump to Apps / Models / Prompts / Users / Groups / Sources / Audit Log; `n` for a new item; `?` for the cheatsheet; `Cmd+K` for the palette.

### Focused Platform pages

The monolithic System page is split into four dedicated pages: **Security** (SSL, CORS, cookies, encryption, SSRF allowlist), **Backup & Restore**, **Updates** (version, check, rollback), and **Advanced**. `/admin/system` redirects to `/admin/security`.

### Design-system polish

- **Full dark-mode coverage** across every page, table, form, badge, and status indicator (previously several agent/workflow/user pages were missing dark variants).
- **Micro-interactions** — buttons scale on press (`active:scale-97`, 150ms).
- **Design tokens** — `admin.accent`/`surface`/`border`/`muted` as Tailwind theme values.
- **Form validation banner** — a save with errors lists every invalid field as clickable links that scroll to and focus the field (localized fields included); errored fields stay red until fixed.
- **Reusable page shells** (`<AdminListPage>`, `<AdminSettingsPage>` with a two-pane section nav + sticky save bar, `<AdminIntegrationHubPage>`) that pages adopt incrementally.
- **OAuth pages** merged into one tabbed surface (Overview / Authorization Server / Clients, still deep-linkable).
- **Integration hub** — status pills (Connected / Available / Disabled / Needs attention), category grouping, and search.

## Audit, privacy & security

### Configurable PII handling

New `platform.json` settings control what PII iHub keeps on disk:

- **`audit.anonymizeIp`** / **`logging.anonymizeIp`** — `true`/`"mask"` truncates the client IP (`/24` IPv4, `/48` IPv6), `"drop"` omits it. Default `false`.
- **`usageTracking.feedbackRetentionDays`** — drops old `feedback.jsonl` entries on the hourly rollup (default `-1`, keep forever). The previously-unwired `dailyRetentionDays`/`monthlyRetentionDays` are now honoured too (defaults 365 / -1).

A new `docs/pii-data-handling.md` catalogues every PII category, its retention default, and the switch that disables or anonymizes it, plus a recommended privacy-first config block.

### Richer audit log

The audit log now captures the security-relevant events compliance reviews (SOC 2, ISO 27001, EU AI Act) expect, not just config changes:

- **Auth events** (local/LDAP/NTLM/OIDC logins, failures, logouts — failed logins capture the attempted username), **OAuth client & API-key** changes (secrets never logged), and **user-management** changes (passwords never logged).
- A **global safety net** records any other mutating admin request, so new endpoints are covered automatically. Session-start requests are excluded so they no longer drown out real events.
- Each entry records an `actor`, `result` (success/failure), and `source` (web/admin/api/mcp); the page adds **Result** and **Source** columns/filters and an **Export CSV** button (`GET /api/admin/audit-log/export`). Timestamps now display correctly (a server/client field mismatch left the column blank).
- **Privacy & SIEM options** (`platform.json` → `audit`, migration **V059**): `includeEmail` (default `false`) masks emails, `verbosity` (`metadata`/`request`/`full`) controls safety-net detail, `winstonMirror` also emits entries to the structured logger for SIEM forwarding.
- **Retention policy**: a daily cleanup job deletes JSONL files older than `audit.retentionDays` (default 365; `-1` keeps forever, `audit.cleanupEnabled: false` disables). The page shows a retention badge and a "Run cleanup now" link (`GET`/`POST /api/admin/audit-log/retention[/run]`).

### SSRF hardening

- **IPv4-mapped-IPv6 bypass fixed** (GHSA-fp9c-pq7w-vr34): the address classifier now parses every IPv6 literal to canonical bytes, so mapped-hex (`[::ffff:a9fe:a9fe]`), dotted, and NAT64 forms of an internal address are all blocked. Adds CGNAT `100.64.0.0/10` to the blocklist and pins each request to the validated IP to close a DNS-rebinding window. No configuration change required.
- **Global SSRF allowlist** at **Admin → Security** lets admins permit specific internal hosts (exact, wildcard, subdomain patterns) for OpenAPI spec fetches, OpenAPI runtime calls, MCP connections, and anything through `safeFetch` — replacing per-tool/per-server allowlists. Stored as `ssrf.allowedHosts` (migration **V061** seeds the empty default).

## Integrations & tools

### OpenAPI tools — zero-code third-party integrations

Turn any OpenAPI-described API into a callable agent tool without code: add a tool of type **OpenAPI**, paste the document URL, pick an operation, choose a credential. Supports OpenAPI 3.0/3.1; auth via the credential store (bearer, basic, API key, OAuth2 client-credentials with refresh); outbound calls run through the SSRF guard and per-tool rate limiting; responses can hide sensitive fields, are capped at 256 KB, and paginate large arrays.

### Central credential store

Integration secrets now live in one place: **Admin → Credentials**. Create named, encrypted credential profiles (OAuth2, bearer, basic, API key, or opaque secret) and reference them from integrations and OpenAPI tools. Secrets are encrypted at rest and shown as `***REDACTED***`. Jira, OIDC, LDAP, NTLM, cloud storage, iFinder, and MCP servers now reference a profile instead of holding an inline secret.

### MCP servers — smoother setup and per-app tools

- **Readable Add-server dialog** (inputs now have borders/focus in light and dark mode).
- **Test connection** probes the server with unsaved changes and lists its tools, so you can verify credentials before saving.
- **Per-app MCP tool selection**: each app has an **MCP server tools** section grouping tools by server with per-tool and select-all toggles.
- **Stronger gateway authz**: the inbound MCP gateway re-checks the caller's scope (and app/workflow permissions) at call time, so revoked access takes effect immediately.

### MCP / JSON-schema tools now work with Google Gemini

Tools whose schemas include JSON Schema metadata (`$schema`, `additionalProperties`) — common for MCP tools — used to fail with `400 INVALID_REQUEST` on Gemini. Those keywords are now stripped before the request (a parameter literally named `additionalProperties` is preserved). Other providers are unchanged.

### iHub documentation as a knowledge source

A built-in **iHub Documentation** source lets apps answer questions about the platform itself. It's exposed **as a tool** (retrieved on demand, not inflating every prompt) — add it under an app's **Sources** for a self-service help assistant. Content is generated from `docs/` at build time so it stays in sync; available on new installs and delivered to existing installs on upgrade.

## Models & providers

### Thinking / reasoning for OpenAI and vLLM models

Reasoning models on the OpenAI and vLLM providers now show their thinking in the dedicated "thinking" stream already used for Gemini. Covers true OpenAI reasoning models, OpenAI-compatible endpoints (DeepSeek, OpenRouter, gpt-oss), and vLLM models (Qwen3, DeepSeek-R1). Enable with `"thinking": { "enabled": true }` and optional `"level"`; for vLLM, start with a matching `--reasoning-parser` and set `thinking.chatTemplateKwargs` if the model needs a toggle. App- and per-user toggles still override. The OpenAI adapter only adds `reasoning_effort` (no change to `max_tokens`/`temperature`).

### Clearer model limits — context window vs. output tokens

Model config splits the old single `tokenLimit` into **`contextWindow`** (total input+output capacity, used for upload/conversation warnings) and **`maxOutputTokens`** (the per-response cap sent as `max_tokens`). Document-size warnings now measure against the context window with an accurate tokenizer; model details show both values; and a latent bug where large-context models requested their full window as the output cap is fixed. Admins now edit two fields instead of one.

## Chat & documents

### Ephemeral chats — conversations that are never stored

Apps can be marked **ephemeral** so their chats are never persisted: messages live only in memory and are discarded on app switch or reload — nothing hits session/local storage, and iFinder/iAssistant backends create the conversation as ephemeral so no server-side record is kept. Toggle per app (**Ephemeral chat** in the app editor or `"ephemeral": true`); end users can flip it at runtime unless hidden with `"settings": { "ephemeral": { "enabled": false } }`. The **iFinder Document Actions** app ships with it on. Default `false`.

### Accessibility — WCAG 2.2 AA

The platform now targets **WCAG 2.2 Level AA** (up from 2.1), strengthening EN 301 549 / BITV 2.0 alignment. `eslint-plugin-jsx-a11y` and an axe-core suite run on every pull request; the export dialog is a proper focus-trapped modal; image controls expose screen-reader labels; footer links are a labeled landmark. See `docs/accessibility.md`.

### Chat export renders markdown properly

PDF and HTML exports now use the same `marked` + DOMPurify pipeline as the chat UI, so tables, headings, lists, code blocks, blockquotes, links, and rules all render (previously GFM tables came out as raw `| … |` and lists lacked wrappers). Exports use an isolated `marked` instance for clean semantic HTML with print-friendly styling. The export dialog also works inside the Outlook task pane and browser side panel: PDF prints through an in-place hidden frame (no blocked pop-up window, falling back to an HTML download), the layout collapses to one column on narrow screens, Copy is enabled only for text-copyable formats, and Esc / ✕ dismiss it.

### Clearer document-size warnings

The context-window warning on upload now names the file responsible (e.g. `"report.pdf" is large (~270,509 estimated tokens)…`). With multiple attachments it makes clear the estimate is the **combined** total and lists each file's individual estimate.

### Collapsible file-attachment list

Attaching many files no longer pushes the message box off-screen. With four or more files the list auto-collapses to a one-line summary (`12 files · 4.3 MB`) with an expand chevron; when expanded it is height-capped and scrolls internally (≈6 rows on desktop, 4 in the Outlook pane). 1–3 files display as before, and **Remove All** stays one click away.

### Fixes

- **High GPU usage on long chats** — only the actively streaming message now gets a GPU compositor layer (dropped when it completes), so an idle long conversation promotes zero extra layers instead of dozens.
- **Custom rendered components** (e.g. the NDA Risk Analyzer) no longer fail with `_jsxs is not defined` — the in-browser JSX compiler is pinned to the classic React runtime.

## Outlook & Office add-in

### Add-in scales on small / high-DPI panes

The iHub add-in now sizes itself to the Outlook task pane instead of rendering oversized on small high-resolution laptops (e.g. a 13" device at 125–150% scaling). The whole interface — app tiles, chat input, attachment chips, dialogs — scales together with pane width. No configuration required.

### Outlook `.msg` file support

Uploading Outlook `.msg` emails now works end to end.

- **Selectable**: the picker previously greyed out `.msg` because the upload component used a minimal built-in MIME fallback; it now loads the full server MIME config so every configured format is offered. The duplicate "MSG" entry in the admin upload-format selector is removed (migration **V064**; `application/vnd.ms-outlook` is the canonical type).
- **Processed**: selecting a `.msg` now reads its subject, sender, recipients, and body instead of failing with "Error processing file".
- **HTML-only bodies extracted**: newsletters and richly-formatted mails with no plain-text part now yield their full body — resolved across plain text, HTML (`PidTagHtml`/`PidTagBodyHtml`), and compressed RTF, decoded via the message's code page. Sender/recipient lines prefer real SMTP addresses over the internal Exchange address, and headers now include the **Date** and **attachment names**.

## Authentication & branding

### Unified login dialog

Every sign-in entry point — the header **Login**, the `/login` page, and the post-expiry prompt — now opens the same auth gate, which supports every configured method (local, LDAP, OIDC/SSO, Windows/NTLM). The separate in-app modal is retired, a "Remember me" option (on by default) pre-fills the username, and the header always shows a Login button when sign-in is possible.

### Session expiry returns you to the same page

When an admin's session expires in the admin panel, signing back in returns them to the page they were on instead of the home screen. The admin panel now uses the same in-place re-authentication as the rest of the app (including for multipart file-upload requests, which previously bypassed the prompt).

### Admin-configurable favicon

The browser-tab icon can now be set from **UI Customization › Header › Favicon URL** (a path or uploaded asset) and applies live without editing HTML. Stored as `header.favicon` in `ui.json`; existing installs get the default via migration **V057**.
