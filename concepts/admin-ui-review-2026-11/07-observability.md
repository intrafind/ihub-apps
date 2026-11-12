# Observability: Usage reports, Feedback, Logging, Telemetry, System resources, Chat history, Scheduled tasks, Audit log — admin UI review

**Date:** 2026-11-12 · **Panel:** Product manager, UX designer, UI designer, Technical writer, iHub admin
**Pages in scope:** `/admin/usage` (tabs Overview, Breakdown, Reliability, Requests, Limits & quotas), `/admin/feedback` (tabs Settings, Feedback), `/admin/logging`, `/admin/telemetry`, `/admin/system-resources`, `/admin/chat-history`, `/admin/scheduled-tasks`, `/admin/audit-log` (with the audit entry drawer, the usage call drawer and the scheduled-task runs modal).

All five panel notes were delivered. One limit applies to the whole panel. Eight panels shared one instance and one IP, so the admin API limit (100 requests/min) returned 429 for much of the session. The instance also had no model traffic, so Usage and Feedback held almost no data. The panel reports how each page *behaves* after a failed load as a finding, because a real admin behind a NAT or a busy proxy hits the same limit. Nobody created entities or saved settings; the admin's task-3 level change was left unsaved on purpose. The lead re-checked every fact the panelists disagreed on in code and, where needed, in the running app (script in `SCRATCH/observability/lead/dark.js`). The appendix lists what was corrected.

## Summary

Observability holds eight pages under one sidebar heading, but only four of them observe anything: Usage Reports, the Feedback review tab, System Resources and the Audit Log. The other four are policy forms: Logging, Telemetry, Chat History, and the settings halves of Feedback and Scheduled Tasks. That split explains most of the friction. An admin who arrives with a job ("find the chat behind this complaint", "turn on debug for ten minutes", "show the works council what we store") finds a settings form where a viewer should be. **Two of the six panel tasks failed outright.** The complaint cannot be traced from feedback to conversation, and a debug session cannot be run or read in the UI. Three more were only partly done.

The worst defects are traps rather than gaps:
- Logging and Telemetry render an editable form full of defaults after a failed load, and saving it overwrites the real configuration.
- The Logging "component filter" hides every *other* component's errors.
- Every chat question is written to the log at the default `info` level, and the page never says so.
- The DPO reference doc says uploads are not stored, but they are.

Privacy settings are spread over five pages under three names. The tracking-mode names are inverted against GDPR vocabulary, and the default mode makes "Active users" count conversations.

There are wins to keep. System Resources is the best page in the admin (one look, honest thresholds). The Audit Log has strong filters, facets, presets and CSV export. The gate checklists on Chat History and Scheduled Tasks show which switches must be on, and every other two-switch feature should copy them.

## 1. What this part does

- **Usage Reports** (`/admin/usage`): token and request analytics over a shared range control (Today … 12 months, Custom; UTC days). Tabs: Overview KPIs and chart, Breakdown by user/group/app/model/provider/surface with Table and Raw-events CSV, Reliability (error rates, latency), Requests (per-call log with a drawer), Limits & quotas. The header also carries the privacy-relevant **Tracking mode** select. Used monthly for reports and ad hoc when someone asks "who uses what".
- **Feedback** (`/admin/feedback`): the Settings tab (collect/store switches, identification mode, per-app toggles) opens first. The Feedback tab shows rating averages per app and model for a fixed 90 days, then every stored rating, newest first, 20 per page. Used at rollout, then occasionally to check quality.
- **Logging** (`/admin/logging`): log level (7 tiles), format, a component allow-list, file output, IP anonymisation for the logs *and* the audit log, and authentication debug. Three separate Save buttons. There is no log viewer: the server exposes only `GET/PUT /api/admin/logging/config` (`server/routes/admin/logging.js:23,71`). Used during incidents.
- **Telemetry** (`/admin/telemetry`): OpenTelemetry export: enable, provider (OTLP / Prometheus / Console), endpoint or Prometheus host/port, signals, content capture, activity summary. Most changes need a restart. Used once at setup.
- **System Resources** (`/admin/system-resources`): host CPU, memory, disk, and per-process heap and event-loop delay, refreshed every 15 s. Used after an incident or an update.
- **Chat History** (`/admin/chat-history`): no chats. It is a 3,960 px page with a gate checklist, stats (stored chats, run ledger, shared chats), and settings for chat retention, uploaded files, the chat-title model, **chat sharing (public links, embed origins)** and the run ledger, with one Save at the bottom. Used at setup and for retention policy.
- **Scheduled Tasks** (`/admin/scheduled-tasks`): gate checklist, a platform on/off switch, 15 numeric limits, then the list of all users' tasks with pause, resume, disable, delete, runs and memory clear. Used occasionally to stop a failing task.
- **Audit Log** (`/admin/audit-log`): append-only record of admin actions and sign-ins. Quick-filter presets, 8 faceted filters with counts, search, an entry drawer, CSV export, a read-only retention chip and "Run cleanup now". Used at audits and after incidents.

## 2. Is it intuitive? — verdict

| Page | Score (1–5) | Why |
|---|---|---|
| Usage Reports | 4 | Clear tabs, URL-held state, KPI deltas, two CSV types. Loses points for the save-on-change Tracking mode select in the header, no calendar-month preset, no cost, and an "Active users" KPI that counts conversations in the default mode. |
| Feedback | 2 | Opens on Settings, not on what users said. The review is a flat all-time list (20 per page; only the averages cover 90 days) with no filters, no rated answer, no "who" and no chat link. One tab mixes two save models: per-app toggles save at once, the three switches above them need "Save Changes" below a 30-row list. |
| Logging | 2 | Configuration with nothing to observe. Three cross-coupled Save buttons, a "Current Level" that shows an unsaved draft, a filter that hides errors, and a restart note that contradicts the card above it. |
| Telemetry | 2.5 | Readable provider tiles, but too thin for a real collector (no auth headers, protocol or test). The endpoint field shows a raw env template, and nothing says whether the saved config is the one running. |
| System Resources | 4.5 | One screen answers disk, memory and processes. Only the disk sentence ("27 GB free of 252 GB (29.8 % used)") reads as contradictory, and it answers "resources", not "healthy". |
| Chat History | 3 | Good gate checklist and precise help text. But the name promises a chat viewer, the page is one very long form, "Run ledger" appears three times, and the only Save is about 1,500 px below the first field. |
| Scheduled Tasks | 3.5 | The gate checklist is excellent. But 15 limit fields without help text push the task list, which is what admins come for, below the fold. The platform kill switch is a small checkbox inside the Limits card. |
| Audit Log | 3.5 | The strongest page: presets, facets with counts, drawer, CSV. It is let down by entries that say *that* something changed but not *what*, a default view flooded with sign-ins, singular/plural resource names, and an unconfirmed "Run cleanup now". |

**Overall:** the read-only pages (Usage, System Resources, Audit Log) are intuitive and well built. The configuration pages are not: they come from three design generations, use three save models, and none of them uses the admin's own settings shell (`AdminSettingsPage`, sticky save bar) or the unsaved-changes guard. The part also fails at a higher level. It is organised by data topic, while admins arrive with investigation jobs, and the objects those jobs need (conversation id, request id, rated answer, changed field) are stored by the server but not linked or shown anywhere in the UI.

## 3. Task walkthroughs

Step counts are the admin's, cross-checked by UX.

1. **Monthly usage report per app, group and model, with cost, as CSV.** Usage → Breakdown → Custom → from → to → App → Table CSV → Group → CSV → Model → CSV: **11 steps, 3 downloads.** Where it hurt:
   - No "Last month" / "This month" preset (`client/src/features/admin/components/usage/RangeControl.jsx:22-30`), and days are UTC, so a German month is cut at 01:00/02:00 local time.
   - **No cost anywhere**: no price fields in the model schema or the usage pipeline. Cost was deferred in `concepts/2026-05-28 Admin UI Phase 3 Roadmap.md:198`, and `docs/usage-reporting.md:7` states it honestly.
   - One CSV per dimension. The Model CSV header repeats `model,model`, and a custom-range file is named `usage-by-app-custom.csv` without its dates (`BreakdownTable.jsx:105-120`). Headers are API names (`inputTokens`).
   - In the default pseudonymous mode, "Active users" and the User breakdown count conversations. A diagnostic model **Test** call showed up as a "user" with a 100 % error rate.

   **Outcome: partial.**
2. **"The answer was wrong yesterday": find the conversation and its feedback.** Feedback opens on **Settings** (`AdminFeedbackPage.jsx:55`). Click the Feedback tab and page through every rating, newest first, 20 per page, with no filter. The entry shows stars, comment, app, model and date, then **dead end**:
   - `feedback.jsonl` stores `chatId` and a 300-character `contentSnippet` of the rated answer (`server/feedbackStorage.js:52-64`, `server/routes/chat/feedbackRoutes.js:280-291`), but the UI shows neither.
   - Usage → Requests shows "Conversation / run" as plain text (`RequestLog.jsx:129`).
   - Chat History has no conversation browser.
   - No doc covers the task; in-product docs search for "find conversation" returns iFinder pages.

   **Outcome: failed** (admin frustration 5/5).
3. **Debug one component for 10 minutes and find the error.** Logging → Debug → tick "Enable component filtering" → pick a component → "Save Logging Configuration": 4 steps. Then:
   - The logs are not visible anywhere in the UI.
   - The filter silently drops every other component's lines, errors included (OB-B3).
   - Nothing reverts the change.
   - Leaving the page before saving discarded the level change without a prompt, while "Current Level" had already shown "debug".

   **Outcome: failed.**
4. **Show the works council what is logged, and who changed which setting last week.** Audit Log → Last 7 days → Hide sign-ins → search → open the row: 4 steps. Where it hurt:
   - At the default `audit.verbosity: "metadata"`, a logging-config or tracking-mode change reads `PUT /api/admin/logging/config -> 200`, with no field and no old or new value (`server/middleware/auditLogger.js:116-134`).
   - The drawer does not link to Change History.
   - "What is logged" has no answer in the product at all, only in `docs/pii-data-handling.md`, which is keyed by JSON paths and wrong about uploads.

   **Outcome: partial.**
5. **Is the server healthy (disk, memory)?** System Resources: 1 click. **Outcome: success** for resources. "Healthy" in the wider sense (providers reachable, error rate, storage writable, scheduler running) is split across Providers, Usage → Reliability, Chat History and Scheduled Tasks.
6. **Export OpenTelemetry to the company collector.** Telemetry → Enable → OTLP → Endpoint → Save → restart the server outside the UI: 5 steps plus the restart. Where it hurt:
   - The endpoint field shows `${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}`.
   - There is no auth-header field, so Grafana Cloud, Elastic or Dynatrace cannot be reached from the UI. (Outside the UI, the OTel SDK itself reads `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_CERTIFICATE`, but no page or doc says so.)
   - There is no protocol, service-name or TLS option.
   - There is no "send test span" and no restart-pending indicator.

   **Outcome: partial.**

## 4. What is broken

| ID | Status | What happens | Evidence | Severity |
|---|---|---|---|---|
| OB-B1 | Confirmed | **Telemetry saves defaults after a failed load.** When the platform GET fails, the page shows the error above a fully editable form filled with `DEFAULT_TELEMETRY`, and Save stays enabled. Save re-reads platform.json and writes `telemetry = <defaults>`, which wipes a configured endpoint and turns telemetry off. | `AdminTelemetryPage.jsx:75-101` (catch sets only `message`), Save `:535` (`disabled={saving}` only); admin `shots/telemetry.txt` (429 + form) | P1 |
| OB-B2 | Confirmed | **Logging saves defaults after a failed or partial load.** Any of three sequential GETs can fail, leaving hard-coded defaults. If the audit-settings GET fails after the others succeed, `privacyConfig` stays `off/off`, and "Save Privacy Settings" switches **audit IP anonymisation off**. | `AdminLoggingPage.jsx:228-288`, `:355-370`; UI `light-logging.png` (429 banner above a normal form) | P1 |
| OB-B3 | Confirmed | **Component filter hides errors.** It is a global allow-list: once enabled, every line from an unselected component is dropped, `error` included (only auth lines survive while auth debug is on). The UI offers 30 hard-coded ids. Three of them (`AdminRoutes`, `MistralAdapter`, `ModelsLoader`) are never emitted, so ticking them yields silence. Emitted components such as `WorkflowEngine`, `NtlmAuth` and `IFinderService` cannot be picked. The server uses about 280 distinct `component` values. | `server/utils/logger.js:156-182`; list `AdminLoggingPage.jsx:60-222`; help "only logs from selected components will be shown" (`:606`) | P1 |
| OB-B4 | Confirmed | **Chat questions are logged at the default level.** Every chat request writes the user's question and username at `info` (`type: CHAT_REQUEST, query`), including scheduled-task runs. The Logging page's "PII & Privacy" card covers only IP masking, and the page recommends "info for production". (The answer text is *not* emitted; see appendix.) | `server/utils.js:383-393`; callers `server/routes/chat/sessionRoutes.js:714` (chat UI), `server/services/inference/appTurn.js:229`, `server/services/scheduler/tasks/taskExecution.js:590` | P1 (privacy) |
| OB-B5 | Confirmed | **The DPO reference is wrong about uploads.** `docs/pii-data-handling.md:29` says "File/image uploads — Not persisted — In-memory only", but Chat History → Uploaded files keeps originals (per-user quota, retention days). | doc line; admin `shots/chat-history.txt` | P1 (compliance) |
| OB-B6 | Confirmed | **Platform changes are hard to reconstruct.** Logging-config and tracking-mode changes produce only the generic middleware line (`PUT … -> 200`) and **no** change-history snapshot. Telemetry and Feedback saves produce "Updated platform configuration" plus a platform snapshot, but no UI shows platform snapshots (ChangeHistoryDrawer exists only on the App, Model, Prompt and Project editors). "Who changed which privacy setting" cannot be answered for exactly these settings. | `auditLogger.js:116-134`; `routes/admin/configs.js:551-564`; no `logAudit`/`saveSnapshot` in `routes/admin/logging.js` or `usage.js` | P1 (compliance) |
| OB-B7 | Confirmed | **Tracking mode saves silently.** The Usage "Tracking mode" select saves on change, with no confirmation and no success message. On failure it only calls `console.error` and snaps back silently. If the meta load fails, the control disappears. | `AdminUsageReports.jsx:25-31, 46-60` | P2 |
| OB-B8 | Confirmed | **Unconfirmed audit deletion.** "Run cleanup now" deletes audit files immediately, with no confirmation, from a text link next to Export CSV. Chat History confirms its equivalent. | `AdminAuditLogPage.jsx:141-159, 186-194` vs `admin.chatHistory.retention.confirmMessage` | P2 |
| OB-B9 | Confirmed | **"Current Level" shows the unsaved draft.** `docs/logging.md:58` also says a click changes the level "immediately". | `AdminLoggingPage.jsx:393-395, 498-506` | P2 |
| OB-B10 | Confirmed | **"Save Privacy Settings" saves more than privacy.** It PUTs the whole `loggingConfig`, so it silently commits an unsaved level or component-filter change. | `AdminLoggingPage.jsx:365-368` | P2 |
| OB-B11 | Confirmed | **The restart note contradicts the card above it.** The auth-debug card says "no restart needed", while the note box says "requires restart" (en and de). The server reads `auth.debug` live, so the shipped `note5` string is the stale one. | `shared/i18n/en.json:2436` (+ `de.json`); `AdminLoggingPage.jsx:843, 1026`; `logger.js:141-151` | P2 |
| OB-B12 | Confirmed | **The retention tooltip points nowhere.** It says "Edit under Platform → Advanced", but that page has no audit fields. `audit.retentionDays`, `cleanupEnabled`, `includeEmail` and `verbosity` cannot be edited anywhere in the UI; the PUT accepts only `anonymizeIp`. | `AdminAuditLogPage.jsx:170-173`; `server/routes/admin/auditLog.js:153-170` | P2 |
| OB-B13 | Confirmed | **The OTLP exporters bypass the SSL whitelist.** They pass no agent or TLS options (`ssl.domainWhitelist` is never consulted), so a collector behind the company CA fails, which breaks the CLAUDE.md outbound rule. The only escape is the SDK's own `OTEL_EXPORTER_OTLP_CERTIFICATE` / `NODE_EXTRA_CA_CERTS` env vars, set outside iHub. `exporters.otlp.protocol` is stored but never used. | `server/telemetry/exporters.js:33-36, 64-67` | P2 |
| OB-B15 | Confirmed | **The feedback review never shows who rated, what was rated, or where.** It renders `entry.userId`, but `storeFeedback` never writes a user, even in Identified mode. The stored `contentSnippet` and `chatId` are not shown. | `FeedbackReview.jsx:186-215, 200`; `feedbackStorage.js:32-64` | P2 |
| OB-B16 | Confirmed | **Unsaved changes are lost without warning.** None of the 8 pages uses `useUnsavedChanges`. In the walk, sidebar navigation away from Logging dropped a draft with no prompt. | grep: 0 hits; admin task 3 | P2 |
| OB-B17 | Confirmed | **Admin ignores dark mode on a cold load.** A direct load of any `/admin` URL ignores both the stored preference and the OS setting. Lead repro: `/` rendered `class="dark"`, then a full load of `/admin/feedback` in the same context rendered no class. Only `?mode=dark` works. Affects every admin page. | `Layout.jsx:127-143` (no DarkModeToggle on admin); `utils/embedBootstrap.js:66-72`; `SCRATCH/observability/lead/dark.js` | P2 |
| OB-B18 | Confirmed | **German translation gaps.** The Feedback review tab has 12 strings missing from en/de.json, hard-coded "User:/App:/Model:", and an untranslatable `` `Page ${page} of ${totalPages}` ``. Six Logging keys (title, description, Current Level, auth warnings) are missing too. The German UI shows English. | `FeedbackReview.jsx:33, 58-61, 168-237`; TW `tw/keys.py`, `de-logging.txt` | P2 |
| OB-B19 | Confirmed | **Cmd+K doesn't find Feedback.** "feedback" returns "No results found": Feedback is missing from the palette's page list, and there are no synonyms ("debug", "OpenTelemetry", "privacy", "cost"). | `AdminCommandPalette.jsx:30-50`; UX `cmdk-feedback.png` | P2 |
| OB-B20 | Confirmed | **Latency percentiles are overstated.** p50/p95 are interpolated inside histogram buckets, so a single 4 ms call shows as "p50 250 ms". | `server/services/usage/rollup.js:21-30, 144-160`; UI `light-usage-requests.png` vs `light-usage-reliability.png` | P3 |
| OB-B21 | Confirmed | **Audit labels mislead.** Every POST is labelled "Create", so `…/_test` and `…/_discover` calls read "Create · Failure", and `_discover` renders as a resource-id link. Resource facets list `app`/`apps`, `model`/`models` and `group`/`groups` separately, so ticking one hides half the edits. | `auditLogger.js` `METHOD_ACTION`; `utils/auditLinks.js:6-35`; admin `audit-resource-dd.txt`; TW `en-audit-log.png` | P3 |
| OB-B22 | Confirmed | **Load errors look like empty data.** On a load error, Usage, Audit Log and Feedback render the error *and* their empty state ("No usage in this range", "No audit log entries found / Showing 0–0 of 0"). Logging, Telemetry and System Resources show the raw "Request failed with status code 429". | PM `pm/usage.txt`, `pm/audit.txt`; UI `mobile-usage.png` | P3 |
| OB-B23 | Confirmed | **The endpoint field shows internals.** It displays the raw `${OTEL_EXPORTER_OTLP_ENDPOINT:-…}` template; typing over it silently removes the env fallback. | UX `telemetry-otlp.png`; `AdminTelemetryPage.jsx:274-279` | P3 |
| OB-B24 | Confirmed | **Feedback links land on Settings.** Feedback opens on Settings, the tab is not kept in the URL, and Usage's "Review feedback →" link therefore lands on Settings. | `AdminFeedbackPage.jsx:55`; `AdminUsageReports.jsx:105-112` | P3 |
| OB-B25 | Confirmed | **Usage CSV and chart polish.** The Model CSV header has a duplicate `model` column, a custom-range filename has no dates, and the chart's y-axis ticks are raw quartiles (0.3 / 0.8). | `BreakdownTable.jsx:105-120`; `UsageChart.jsx:51` | P3 |
| OB-B26 | Confirmed | **Accessibility and mobile.** Scheduled Tasks helper text (`text-gray-500`) and Delete buttons (`text-red-600`) have no `dark:` variant and reach only 3.0:1 on the dark card (`gray-800`), below the 4.5:1 that AA requires for this small text. Telemetry's text and number inputs (Endpoint, Port, Bind Host, Max event size …) have no associated label (16 `<label>`s, 0 `htmlFor`; the checkbox labels wrap their inputs and are fine), and its provider tiles have no `aria-pressed`. At 390 px the Audit table shows only 3 columns with no scroll hint, and the demo-accounts banner wraps one word per line (cross-part). | `AdminScheduledTasksPage.jsx:328-512`; `AdminTelemetryPage.jsx:247-320`; UI `crop-mobile-audit-*.png` | P3 |
| OB-B27 | Confirmed | **Stale doc paths and claims.** "Admin → System → Logging Configuration" (`docs/logging.md:55, 294`) and "Admin → More → Telemetry" (`docs/telemetry.md:26`) point to pages that no longer exist. `docs/feedback-feature.md:502` puts `admin.pages.feedback` in `ui.json`; it is in `platform.json`. | files | P3 |
| OB-B28 | Confirmed | **"Anonymous (hashed)" overpromises.** The Feedback identification label suggests no person link, but `feedback.jsonl` stores the raw `chatId` in every mode (a chat id resolves to its owner when chats are stored), and every rating is also written to the application log at the default `info` level with the rater's username and the chat id, whatever the mode. | `feedbackStorage.js:52-63`; `server/routes/chat/feedbackRoutes.js:267-274` → `server/utils.js:360-371`; `en.json:4658` | P2 |

## 5. Findings by persona

### Product manager

- **OB-PM1. Complaint investigation, the #2 job, has no path.** Feedback, usage calls and the run ledger all carry the conversation id, but nothing links them, and in pseudonymous mode the Requests "User" filter matches conversations, not people (`docs/usage-reporting.md:55-63`). Build a **conversation trace** reachable from a feedback entry and a request row. It shows the rated snippet and comment, every model call of the conversation (tokens, outcome, latency, tools), run-ledger entries, and log lines by request id once a log viewer exists. The trace drops the `query` field of `CHAT_REQUEST` log lines (`server/utils.js:393`, see OB-B4), so the conversation's questions and answers stay out of it. The only content it shows is the 300-character snippet stored with the rating, and only once users are told about it (see §10).
- **OB-PM2. No cost, the first thing management asks.** Neither the model schema nor the usage pipeline has a price field. Add an optional per-model `pricing` block (input, cached input and output per 1M tokens, currency, effective date). Show a Cost KPI and column and "not priced" instead of 0. Copilot Studio, Dify and LibreChat all show cost per model.
- **OB-PM3. Tracking-mode names are inverted.** "Anonymous" keeps a stable keyed hash per person, which GDPR calls pseudonymisation. "Pseudonymous" (the default) stores no user ID, but each record keeps the conversation ID (`callRecord.js:152`), and saved chats link that ID to their owner. Rename the options by effect: "Per conversation, no user ID" / "Per person, hashed" / "Per person, by user id", and say in the help text that a conversation can still be traced to its owner through saved chats. In per-conversation mode, relabel the KPI "Active conversations" (`KpiCards.jsx:114-119`).
- **OB-PM4. JSON-only capabilities.** These settings exist on the server but have no UI:
  - `audit.retentionDays`, `cleanupEnabled`, `includeEmail`, `verbosity` (OB-B12);
  - `usageTracking.eventRetentionDays`, `dailyRetentionDays`, `monthlyRetentionDays`, and `feedbackRetentionDays`, which defaults to `-1` = **forever** (`server/defaults/config/platform.json:310-313`);
  - `telemetry.exporters.otlp.headers` and `protocol`, `spans.sampleRate`, `logs.*`, `resource.*`;
  - 250 of the ~280 log components;
  - platform change history.
- **OB-PM5. Two switches per feature.** Chat history, run ledger, chat sharing, scheduled tasks and feedback each need a Features flag *and* a switch on their own page. The gate checklists patch this. Feedback already mirrors the flag on its own page (`AdminFeedbackPage.jsx:44-48`); apply that pattern everywhere, so the feature page owns the master switch and Features becomes the index.
- **OB-PM6. Chat sharing ships permissive and is hidden in Observability.** Defaults are `allowPublic: true`, `defaultExpiryDays: 0` and `maxExpiryDays: 0` (`platform.json:478-480`), edited only on Chat History (`AdminChatHistoryPage.jsx:1214-1290`). A security reviewer looks under Security. Move the policy there and offer a "conservative" preset (no public links, 30-day maximum).
- **OB-PM7. No read-only reports role.** The DPO, a works-council delegate or a finance controller cannot get Audit or Usage read access without full admin (`AdminLayout.jsx:60-62`). `observability-admin` is planned in `concepts/admin-redesign-2026/…Product Strategy & IA.md:202-205` but not built. Enterprise RFPs ask for this.
- **OB-PM8. Health is not the same as resources.** Add a traffic-light "Health" strip at the top of System Resources covering provider reachability, the 24 h error rate (from Reliability), storage provider status (from Chat History) and the scheduler state, each linked to its detail page.

### UX designer

- **OB-UX1. "Logging" has no logs.** Add a **Logs** tab: the last N lines from an in-memory ring buffer per worker, filtered by level, component, request id and user. Request ids should be clickable from the Audit drawer and from Usage → Requests. Until it ships, rename the nav item to "Log settings".
- **OB-UX2. A debug session instead of global switches.** Replace Level + Component Filtering with "Start a debug session": component(s) → level → 10 / 30 / 60 min → Start. While it runs, the sidebar shows a "Debug logging on · 7 min left · Stop" badge. It reverts automatically and writes audit entries for start and end. A per-component level must *raise* verbosity for that component, never hide others.
- **OB-UX3. Make ids clickable everywhere.** requestId, chatId/runId and userId should link the Audit drawer, Requests, Feedback and Logs to the same filtered views. That turns six silos into one investigation surface without merging any pages.
- **OB-UX4. Feedback review first, with filters.** Make the review the default tab and keep it in the URL (`?tab=review`). Reuse the Usage range control and add filters for rating (preset "1–2 stars with comment"), app, model and user. Add CSV export and per-entry delete; GDPR deletion is currently "not implemented by default" (`docs/feedback-feature.md:478-479`).
- **OB-UX5. Confirmations that state the consequence.** Changing the tracking mode should say: "Switching to Identified stores real user ids for all new records. Existing records are not changed." Apply the same to audit cleanup, retention runs and task delete, using `ConfirmDialog` instead of `window.confirm` (`AdminScheduledTasksPage.jsx:125, 149`).
- **OB-UX6. A sane audit default view.** Sixteen of the first 16 rows were `Login` (`audit-log.png`). Add a "Configuration changes" quick filter that hides login, logout and test calls, and make it the default. Show human summaries ("Deleted short link x") and keep the raw request line in the drawer.
- **OB-UX7. Show an example of what is recorded.** Above each privacy control, show what a record actually looks like, e.g. "With *Per conversation*, a usage record is `{user: conv_8f3…, app: chat, tokens: 1,204}`". DPOs read examples faster than prose.
- **OB-UX8. Scheduled Tasks: the list is the hero.** Order the page status → task list → limits, with limits collapsed and the 4 most-used fields visible. Move the kill switch into the status card as a labelled toggle: "Scheduled tasks for everyone: On".

### UI designer

- **OB-UI1. Five header patterns in one nav group.** h1 sizes vary (`text-3xl` on Feedback `:363`, `font-semibold` on Scheduled `:218`), card-wrapped headers with a blue icon appear on Logging, Telemetry and Chat History, and widths are 5xl, 6xl or 7xl. Create `AdminPageHeader` (title, description, actions slot, tabs slot, `docsHref`) and use the Usage band pattern at max-w-7xl everywhere.
- **OB-UI2. Settings pages ignore the settings shell.** None of the 8 pages imports `formStyles.js`, `AdminSettingsPage`, `useUnsavedChanges`, `AdminEmptyState` or `AdminTabs`; only Audit Log uses `DataTable`. Move Logging, Telemetry, Chat History and the Feedback and Scheduled Tasks settings onto `AdminSettingsPage`, which provides a section nav and a sticky Save/Discard bar with a dirty label. That removes the 3 Save buttons on Logging and the Save at y≈3,900 on Chat History.
- **OB-UI3. Duplicate components.** The part has 3 tab implementations, 3 drawers (CallDrawer is hand-rolled with its own focus trap, `RequestLog.jsx:73-175`), 4 stat tiles (`Kpi`, `StatTile`, `InfoItem`, the feedback cards), 3 range pickers and 4 status-badge styles. Extract `StatCard`, `GateChecklist` (Chat History and Scheduled Tasks) and a shared `DateRangeControl` (from `usage/RangeControl`). For badges, extend the existing `client/src/shared/components/StatusBadge.jsx` (today it knows only job states) or `Badge.jsx` instead of creating a new one; System Resources and Scheduled Tasks each define their own local badge. Use `AdminTabs` and the shared `Drawer` everywhere.
- **OB-UI4. Colour drift.** Logging, Telemetry and Chat History use blue-600 primaries (30, 17 and 13 `blue-*` classes); the other pages use indigo. Using the `PRIMARY_/SECONDARY_/DANGER_BUTTON_CLASS` and `INPUT_CLASS` tokens fixes the drift, the missing focus rings and the missing dark variants (OB-B26).
- **OB-UI5. Audit density.** Rows wrap to 2 lines at 1440 px, so 50 rows make a 3,700 px page. The 8-column filter grid truncates "All resou…" and "Summ…". Use a nowrap compact timestamp, a one-line truncated actor, Search on its own row, facets in a "Filters" popover below lg, and card rows on mobile.
- **OB-UI6. Radio-card group for levels and providers.** The 7 Logging level tiles have no descriptions ("Http" and "Silly" mean nothing to an admin), and Telemetry's provider tiles lack the check icon Logging's have. Build one `RadioCardGroup` (role=radiogroup, check icon, one-line description) for level, format and provider. Drop the duplicate "Current Level" box.
- **OB-UI7. Chat History as tabs.** Split it into Overview (gates and stats), Retention (chats and ledger), Uploads, Sharing and Titles, or use the section nav of `AdminSettingsPage`.

### Technical writer

- **OB-TW1. No contextual help.** None of the 8 pages links to its docs; the only link is to opentelemetry.io (`AdminTelemetryPage.jsx:565`). `/admin/docs/*` already supports anchors (`AdminDocsPage.jsx:128, 228`). The mapping is in §9.
- **OB-TW2. One setting, three names, opposite meanings.** `features.usageTrackingMode` is "Tracking mode" on Usage, "Identification mode" on Feedback, and "privacy mode" in `feedback-feature.md:234, 421`. Chat History's ledger option "Pseudonymized — a stable hash" means what the tracking mode calls "Anonymous". `feedback-feature.md:341` calls the hashed mode "Anonymous Mode (Highest Privacy)", which is wrong for a DPO audience. Use one label, "User identification", with the effect-based options from OB-PM3 everywhere, plus a glossary entry.
- **OB-TW3. Say what `info` records.** Add a one-line description to each level button. Info: "Normal operation. Also records each chat question and who asked it." Warn: "Problems only. No chat content." Add a "What is logged" box linking to `pii-data-handling.md#5-structured-logs`.
- **OB-TW4. Help text that speaks HTTP and file paths.** Current: "…answers POST /api/feedback with 403. The same switch appears in Admin → Features → Content." Proposed: "Show the star rating under AI answers. Off hides it everywhere and refuses ratings sent by other clients." Current: "Write submitted feedback to contents/data/feedback.jsonl". Proposed: "Keep submitted ratings for the review and usage reports."
- **OB-TW5. The audit page doesn't say what it records.** Add a subtitle: "Every change an administrator made, and every sign-in. Chats, model calls and feedback are not recorded here — see Usage Reports." The exclusions are documented only in `pii-data-handling.md:176-179`.
- **OB-TW6. Scheduled Tasks limits have no help text, though the doc already has it.** The "Meaning" column of `scheduled-tasks.md:56-74` is ready-made help text for the 15 fields. The docs call the section "Settings"; the UI says "Limits".
- **OB-TW7. Copy fixes on Logging and Telemetry.**
  - Logging subtitle mentions "metadata" the page doesn't have.
  - "Json" and "Http" come from CSS `capitalize`; write "JSON" and "HTTP".
  - "Max Size (bytes)" defaulting to 10485760 should be "Largest log file (MB)", default 10.
  - The Telemetry title "Telemetry & Observability" repeats the nav section name.
  - "Emit gen_ai events (prompts, completions, tool calls)" reads as if content is sent. Proposed: "Emit gen_ai events (structure only; content needs the switches under Content & Privacy)".
  - The metric interval is entered in ms; it should be seconds.
- **OB-TW8. German search finds nothing.** Docs are English-only, so "Protokoll", "Nutzungsberichte" and "Betriebsrat" return 0 hits. Add German synonyms for the nav labels to the search index (`docsLibrary.js`).

### iHub admin

- **OB-AD1. Make Telemetry save its own block.** Telemetry round-trips the whole platform.json (`AdminTelemetryPage.jsx:93-101`), which is what lets OB-B1 do damage. Give it a scoped `PUT /api/admin/telemetry/config` like Logging has.
- **OB-AD2. Record who rated in Identified mode.** In Identified mode, store the user on feedback so "who complained" is answerable. Show "Chat expired" when the linked chat is gone.
- **OB-AD3. Changed keys in every audit entry.** Add changed field *names* (values redacted) to the middleware summary at the default verbosity. `configs.js:463, 478` already computes changed keys for AI-use acknowledgement. Normalise resource names to the singular.
- **OB-AD4. Keep test traffic out of management numbers.** Exclude `diagnostic-*` and surface `system` from KPIs by default, with a toggle. Offer an optional company timezone for month boundaries.
- **OB-AD5. Telemetry status.** Add a status card: exporter running, last successful export, last error, and "running config differs from saved, restart pending" (Chat History already shows `restartRequired`).
- **OB-AD6. Rate-limit friction.** Each admin navigation fires about 6 shell calls (`auth/status` ×2, integration requests, website-corpus domains, system storage, demo accounts) plus the page's own. `adminApi` is 100/min per IP, so several admins behind one egress IP hit 429 within a minute, and the pages then show raw "Request failed with status code 429". Cache the badge calls, key the limit per user, and translate 429 into "Too many requests, retrying in N s" with an automatic retry. This overlaps the Platform report.

## 6. What should be rearranged

Today's Observability items are sorted alphabetically (`AdminSidebarNavData.js:393`), so Audit Log comes first and Usage Reports last. Proposed structure, cutting along *observe vs configure*:

- **Observability → Monitor** (read): Usage Reports, Feedback (review first), Audit Log, System Health (renamed System Resources, with the health strip), Logs (new viewer), Scheduled Tasks (list first). Order by frequency, not alphabet.
- **Observability → Data & privacy** (configure): a new **Data & privacy** page (below); **Chats & retention** (renamed Chat History, without sharing); **Log settings** and **Telemetry** on `AdminSettingsPage`.

Moves:
1. **Tracking mode** leaves the Usage header and the Feedback settings tab and goes to Data & privacy. Usage keeps a read-only chip ("Counting: per conversation · Change") linking there. *Reason:* one GDPR-relevant setting, two controls, two labels, two save models (OB-B7, OB-TW2).
2. **Audit IP anonymisation** moves from Logging (`AdminLoggingPage.jsx:708`) to Data & privacy, next to an *editable* audit retention. The Audit Log keeps a "Retain 365 days · Change" chip. *Reason:* admins look for audit settings on the audit page or with privacy, not under Logging.
3. **Chat sharing policy** (public links, expiry, embed origins) moves to Platform → Security. Chats & retention keeps the read-only share stats and list. *Reason:* it is a security control that ships permissive (OB-PM6).
4. **Chat History → "Chats & retention"**, split into tabs (OB-UI7). *Reason:* the current name sends admins looking for a chat viewer.
5. **Feedback:** tabs renamed **Responses | Settings**, Responses first, tab in the URL. The settings keep only collect/store and per-app switches; identification moves to Data & privacy.
6. **Scheduled Tasks:** status → task list → limits (collapsed). The kill switch moves into the status card.
7. **Logging:** one save bar; the debug session (OB-UX2) replaces Level + Component filter as the main control, and the level selector moves to "Advanced".
8. **Data & privacy** (new) lists every data store: chats, uploads, run ledger, usage events and rollups, feedback, logs, audit, telemetry. For each: what is captured, identity mode, retention, IP handling, who can read it. Each row carries its edit control or a link to the owning page. It absorbs the JSON-only retention fields (OB-PM4).

## 7. Where another approach fits better

| Today | Proposed | Why |
|---|---|---|
| Four silos for a complaint (Feedback list, Requests text id, settings-only Chat History, no logs) | **Conversation trace drawer** opened from a feedback entry or a request row: snippet + comment, all calls of the conversation, ledger entries, log lines by request id (without the `query` field of `CHAT_REQUEST`) | One object, everything about it; closes task 2 without granting content access by default |
| Global log level + allow-list component filter | **Per-component level overrides with a TTL** (debug session) | Raises verbosity where needed and never hides other errors; auto-revert removes the "forgot debug on" risk |
| Log investigation by `jq` / `grep` on the server (`docs/logging.md:337-403`) | In-product **ring-buffer tail** of recent warn/error lines, filterable, with "download excerpt"; OTel stays the multi-replica answer | Admins often lack shell access; docs recipes signal a UI gap |
| Audit summary `PUT /api/admin/logging/config -> 200` | **Field-level summary** ("Changed logging: level info → debug") + "View change" link into Change History (incl. a platform history view) | Answers "what changed" at the point of reading |
| Privacy prose in `pii-data-handling.md` keyed by JSON paths | **Live, config-derived data inventory** (Data & privacy page) with PDF/Markdown export | The DPO table reflects *this* instance, not defaults; cannot drift |
| Three per-dimension CSVs + Excel merge | **One report export** (XLSX or multi-section CSV: app, group, model, user sheets + totals, dates in filename) and **saved views** | Turns an 11-step monthly chore into one click |
| Tracking mode select that saves on change | Setting on Data & privacy with a **consequence confirmation** | Irreversible-for-new-records privacy change deserves a deliberate step |
| Env template visible in the endpoint input | **"Effective value" chip** ("http://localhost:4318 · from env OTEL_EXPORTER_OTLP_ENDPOINT") with "Override" | Shows the truth without leaking config syntax; protects the env fallback |
| Static Telemetry form | **Status card + "Send test span/metric"** button (pattern exists: `POST /api/admin/voice/azure/_test`) | Admins can't otherwise tell whether export works |
| Scheduled-task runs in a `Modal`; usage CallDrawer hand-built | Shared `Drawer` for every detail view | Consistency, keyboard and focus handling for free |
| Text-glyph ✓/✗ (Scheduled `:256-262`) vs icon `GateRow` (Chat History) | Shared `GateChecklist` on every two-switch feature page | The best pattern in the part, applied consistently |

## 8. Wizards to add

**1. Connect OpenTelemetry**
- *Starts:* Telemetry page, shown as "Set up export" while telemetry is off. The plain form stays available for editing afterwards.
- *Who:* an admin connecting to the company's Grafana / Elastic / Dynatrace / Datadog collector, once.
- *Steps:*
  1. Pick a backend template (generic OTLP collector, Grafana Cloud/Tempo, Jaeger, Datadog OTLP, Elastic, Prometheus scrape). The template prefills paths and ports.
  2. Endpoint and protocol (http/protobuf or grpc), with the effective value shown when it comes from an env var.
  3. Auth headers as key/value pairs, masked and stored encrypted like other platform secrets; TLS honours the SSL whitelist (fixes OB-B13).
  4. Signals and privacy: content capture defaults to off, with a warning when it is turned on.
  5. "Send test span / test metric", which shows the collector's HTTP status or the TLS error.
  6. Save, then a "Restart required" banner with Docker and systemd instructions, and a status card that turns green after the restart.
- *Validates or creates:* a successful test export and the saved `telemetry` block.
- *Replaces:* the single-page form, JSON editing of headers, and guessing whether data arrives.

**2. Privacy profile and DPO report**
- *Starts:* the new Data & privacy page ("Choose a privacy profile"), and once from the first-run checklist before go-live.
- *Who:* the admin preparing a works-council agreement (Betriebsvereinbarung) or a DPO review.
- *Steps:*
  1. Choose a profile: **Strict (works council)**, **Balanced** or **Full accountability**.
  2. Review the roughly 20 resulting values: identification mode, feedback identity, IP masking for logs and audit, chat-question logging, audit e-mail masking, and retention for chats, uploads, usage, feedback, audit and the run ledger, plus telemetry content capture. Each value can be adjusted.
  3. Confirm, with a diff against the current settings.
  4. Generate the data inventory (store, captured fields, identity, retention, readers) plus "admin changes in the last N days" from the audit log, exported as PDF or Markdown.
- *Validates or creates:* the settings and an exportable document.
- *Replaces:* about 20 fields on 6 pages, JSON edits, and a hand-written annex.

**3. Debug session** (a mini-wizard, 3 fields)
- *Starts:* Logging, as the primary card, and from a "Debug" action in the Reliability and Requests error rows.
- *Who:* the admin during an incident.
- *Steps:*
  1. Choose the component(s) or an area preset (Authentication, LLM calls, Integrations, Scheduler).
  2. Choose the level and the duration (10 / 30 / 60 min); optionally narrow to a user or request id.
  3. Start; the live tail opens.
- *Validates or creates:* temporary per-component overrides, a countdown badge, an automatic revert, start and end audit entries, and "Download excerpt".
- *Replaces:* the component filter and the manual edit → save → remember → revert cycle.

**Templates, not wizards.**
- *Monthly usage report:* "Last month" / "This month" presets, a saved "Monthly management report" view (app × group × model, cost when priced) with one-file export, and later a scheduled delivery on the existing scheduler. It is a repeated task with fixed parameters, so a preset beats a wizard.
- *Complaint investigation:* the conversation trace (§7), reachable from a feedback entry or a request row. UX proposed a wizard; a modal flow would hide the evidence the admin needs to compare (§10).

**Where a wizard would be wrong.** Usage Reports browsing, the Audit Log, System Resources and the Scheduled Tasks list are read-and-filter screens used repeatedly by people who know what they want. Steps would only slow them down. Chat-retention changes are a single value with a confirmation. The Logging level selector stays available under "Advanced" for power users who want a permanent level.

## 9. Documentation

**What exists and how good it is**

| Doc | Quality for an admin |
|---|---|
| `docs/usage-reporting.md` | Good reference, accurate and honest ("no prices, costs or budgets", `:7`). Needs: p50/p95 are bucket estimates; no monthly-report how-to. |
| `docs/admin-ui.md` | Has Usage Reports (`:357`), System Resources (`:400`), Audit Log (`:445`, about 350 words, explains facets/presets/drawer well), Scheduled Tasks (`:320`). **No sections** for Feedback, Logging, Telemetry, Chat History. |
| `docs/feedback-feature.md` | Configuration leads with the UI. "Switching Privacy Modes" (`:421-450`) still says edit JSON and restart, filtering is taught with `jq` (`:505-535`), `ui.json` is wrong (`:502`), "Anonymous Mode (Highest Privacy)" is wrong (`:341`). |
| `docs/logging.md` (625 lines) | Mostly developer content (`logger.info({component})`, console.log migration, `X-Admin-Secret` at `:315`). The admin section (`:51`) is about 15 lines with a stale path and the false "immediately" claim; never mentions that `info` logs questions or that the component filter hides errors. |
| `docs/telemetry.md` | Wrong nav path (`:26`), JSON-first, documents fields the UI does not have (`:48-99`) without saying so, no OTLP "is data arriving?" check (only a Prometheus `curl`, `:42-45`), and no mention that `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_CERTIFICATE` (read by the OTel SDK itself) are today's only routes to auth headers and a private CA without hand-editing platform.json. |
| `docs/chat-persistence.md` | Admin section (`:108-139`) leaves out Shared chats, Uploaded files and Chat sharing; uses JSON key names; no screenshot. |
| `docs/scheduled-tasks.md` | Good administration section; "Settings" vs UI "Limits". |
| `docs/pii-data-handling.md` | Exactly the inventory a DPO needs, but keyed by `platform.json` paths, wrong on uploads (OB-B5), still marks long-shipped switches "(new)". |
| Audit log | No topic doc. Retention, verbosity and e-mail masking are documented only as JSON keys (`pii-data-handling.md:250-258`). |

Screenshots exist only for Usage, System Resources and Scheduled Tasks.

**Tasks a new admin cannot learn from the docs today**
- Investigate a user complaint (feedback → requests → conversation), including what the admin UI deliberately cannot show.
- Produce the monthly management report, including a cost workaround (Model CSV × price list) until cost ships.
- Debug one component temporarily and switch it back.
- Prepare evidence for the works council or DPO: what is stored, where it is set in the UI, who changed it.
- Connect to an authenticated OTLP collector over HTTPS with a private CA.
- Know what to do when System Resources says "Critical" (which directories to clean).

**Proposed pages**
1. **`docs/observability.md` — "Running iHub day to day"** (first page of a new *Observability* group in `SUMMARY.md` that mirrors the nav):
   - Which page answers which question (table)
   - Monthly usage report (steps; per-user figures need per-person identification)
   - A user says an answer was wrong (today's limits stated honestly)
   - Troubleshoot with debug logging and switch it back
   - Is the server healthy?
   - Connect a metrics or tracing backend
2. **`docs/audit-log.md`** (moved out of `admin-ui.md`, which keeps a link):
   - What is recorded and what is never recorded
   - Reading an entry
   - Filters and shareable URLs
   - Finding who changed a setting (entry → Change History)
   - Retention, IP and e-mail masking, with the UI path once it exists
   - CSV export for an auditor
3. **`docs/data-protection-guide.md` — "For the data protection officer and works council":**
   - Data inventory with a **"Where in the admin UI"** column
   - Recommended settings per profile (Strict / Balanced / Full accountability)
   - Producing evidence
   - Access and erasure requests, step by step (including feedback)
   - Glossary: anonymous / pseudonymous / identified, as iHub uses the terms and as GDPR uses them
4. **Split `logging.md`** into an admin guide (UI-first: levels including what `info` records, format, file output, auth debug, IP masking, temporary debugging, where logs go in Docker and as a Windows service) and `logging-development.md` (lines 105-625).
5. **Updates to existing docs:**
   - `telemetry.md`: a UI-first quick start with a screenshot, keys marked "UI" or "file only", and an OTLP verification step.
   - `chat-persistence.md`: add the three missing sections.
   - `pii-data-handling.md`: fix the uploads row and add the UI-location column.
   - `feedback-feature.md`: replace the JSON/restart and `jq` passages with the UI flow.
   - `admin-ui.md`: short sections and screenshots for Feedback, Logging, Telemetry and Chat History.

**Contextual help in the product**

| Page / field | Link to |
|---|---|
| Usage Reports header | `usage-reporting.md` |
| Feedback header / Identification | `feedback-feature.md#configuration` / glossary in `data-protection-guide.md` |
| Logging header / PII & Privacy | `logging.md#admin-interface` / `pii-data-handling.md#5-structured-logs` |
| Telemetry header | `telemetry.md#quick-start` |
| System Resources header | `admin-ui.md#system-resources` |
| Chat History header / Identity in the ledger | `chat-persistence.md#admin--chat-history` / glossary |
| Scheduled Tasks header / each limit | `scheduled-tasks.md#administration` / inline help from `scheduled-tasks.md:56-74` |
| Audit Log header / retention chip | new `audit-log.md` / `audit-log.md#retention` |

Help text to rewrite (current → proposed):
- Logging component filter: "only logs from selected components will be shown" → "Write log lines only from the checked components. Everything else, **including errors from other components**, is not logged while this is on." (Until it is replaced by per-component levels.)
- Logging `note5`: "Authentication debug logging is separate and requires restart" → "Authentication debug applies immediately; its traces are written at the info level."
- Audit retention chip tooltip: "Configured in platform.json → audit. Edit under Platform → Advanced." → "Set under Data & privacy → Audit log" (once it exists); until then, "Set in platform.json → audit.retentionDays (no admin form yet)."
- Usage tracking descriptions: "Users and conversations are recorded as irreversible fingerprints." → "Per person, hashed: the same person always gets the same code; the code cannot be turned back into a name." · "Each conversation is recorded as its own user; no user ids are stored." → "Per conversation: no user ID is stored. Each record keeps the conversation ID (`server/services/usage/callRecord.js:152`), and saved chats link that ID to their owner, so someone with access to both can still find the person. 'Active users' then counts conversations."
- Scheduled Tasks intro: "Tasks users saved to run by themselves." → "Tasks that users set up to run automatically on a schedule. Who may create them is set by the **Scheduled tasks** permission of a group."
- Empty states:
  - Feedback "No feedback available" → "No ratings yet. Users rate answers with the stars under each answer. [How feedback works]"
  - Scheduled Tasks "No scheduled tasks." → "No user has scheduled a task yet. [What users can schedule]"
- System Resources disk: "27.0 GB free of 252 GB (29.8% used)" → "12 GB used · 27 GB available (29.8 % of usable space)".

## 10. Where the panel disagreed

- **Can an admin read the conversation behind a complaint?** UX and the admin want a read-only, audited admin conversation viewer; the server already allows it (`docs/chat-persistence.md:652`). PM wants content kept private, with an "ask the user to share the chat" flow. **Resolution:** ship the trace view first. It shows metadata (calls, outcomes, ledger, logs) plus the 300-character snippet stored with the rating. The rating request attaches that snippet automatically (`ChatMessage.jsx:593`); the user doesn't choose to send it. So the trace needs a stated disclosure basis before showing it: tell users in the rating UI that the start of the answer is stored with their rating, and document it in the privacy notice. Admin read of full chat content becomes a separate, platform-level switch, **off by default**, with an access banner and an audit entry per open. Works councils in German enterprises routinely forbid silent content access, and the share flow already exists for consenting users.
- **Wizard or view for complaint investigation?** UX proposed a 4-step wizard; UI proposed a mode of the Requests tab. **Resolution:** a view (the trace drawer). The admin moves back and forth between feedback, calls and logs, and a linear wizard hides that context.
- **Where Feedback review lives.** The admin wants it as a sixth Usage tab, since it shares the pipeline and range; UX, UI and TW want it on the Feedback page, review first. **Resolution:** keep the Feedback page with Responses first and the shared range control, and deep-link it from Usage (`?tab=review`). Usage already has five tabs that scroll off at 390 px.
- **One privacy hub, or settings next to each feature?** PM, UX, TW and the admin want one Data & privacy page; UI proposed a small privacy card inside Usage. **Resolution:** the hub. The DPO job is cross-cutting, and the duplicate tracking-mode control is exactly the problem. Feature pages keep read-only chips that link to the hub.
- **Merge Logging and Telemetry?** UX proposed one "Export & diagnostics" page with tabs. **Resolution:** keep two pages. Logs (viewer + debug session + settings) is an incident tool; Telemetry is a one-time integration with a wizard. Both move to the same settings shell.
- **Where chat sharing goes.** PM: Security. The others: rename Chat History and keep sharing there. **Resolution:** move the *policy* to Security and keep the share list and stats on Chats & retention. It ships with public links on and no expiry, which is a security posture.
- **Where Scheduled Tasks goes.** PM floated AI Workspace; the others keep it in Observability with the list first. **Resolution:** keep it under Monitor. Admins open it to oversee and stop tasks, and the settings half is small once collapsed.
- **Severity of "Run cleanup now" without confirmation.** UX rated it P1, the others P2/P3. **Resolution:** P2. It deletes only files already past retention that the nightly sweep would remove anyway, but it is irreversible audit evidence on a one-click text link, and the fix is trivial.
- **Severity of chat-question logging (OB-B4).** PM P1; TW framed it as copy. **Resolution:** P1 (privacy). It is on by default, invisible on the page that claims to cover "PII & Privacy", and a works-council agreement typically forbids it. The fix is a switch (default off) or moving the query to `debug`, plus copy.

## 11. Top recommendations

| # | Recommendation | Why | Impact | Effort | Type |
|---|---|---|---|---|---|
| 1 | **Make the Logging and Telemetry pages safe to save.** On load failure, show `AdminLoadError` with Retry instead of the form. Give Telemetry its own scoped PUT. Decouple "Save Privacy Settings" from the log config. Show "Running: info / Selected: debug". Fix the `note5` string. Confirm "Run cleanup now" and tracking-mode changes with consequence text, and surface their errors. | A failed load currently lets one click wipe the OTLP config or turn audit IP masking off; several smaller traps on the same pages (OB-B1, B2, B7–B11) | H | S | fix |
| 2 | **Stop writing chat questions to the log at `info`.** Move them to `debug` or behind a "Log chat questions" switch in PII & Privacy (default off), and add level descriptions that say what each level records. | Default-on personal data in log files, invisible to the admin and the DPO (OB-B4, OB-TW3) | H | S | fix |
| 3 | **Replace the component filter with a debug session.** Per-component level overrides with a 10/30/60-minute TTL, a countdown badge, automatic revert and audit entries, plus a "Recent errors" ring-buffer tail filterable by component and request id. Build the component list from what the server actually emits. | Task 3 failed: today's obvious path hides the error being looked for, and nothing reverts it (OB-B3, OB-UX1/2) | H | M | fix / UX |
| 4 | **Connect the complaint path.** Feedback opens on Responses with range, rating, app and model filters, the rated snippet, export and delete. Feedback ids, request ids and chat ids become links into a conversation trace drawer. Store the rater in Identified mode. | Task 2 failed at frustration 5. The data is already stored, just not shown (OB-B15, OB-PM1, OB-UX3/4) | H | M | UX |
| 5 | **Make audit entries say what changed.** Changed-key summaries at default verbosity, explicit audit entries and snapshots for logging and tracking-mode changes, and a "View change" link from the drawer into Change History (including a platform history view). Add a "Configuration changes" default filter, singular resource names, and `_action` labels instead of "Create". | Task 4 was only partly done. "Who changed which privacy setting" is unanswerable today (OB-B6, B21, OB-AD3, OB-UX6) | H | M | fix / UX |
| 6 | **Build a Data & privacy page with a privacy-profile wizard.** One page for every retention, identity and IP setting, absorbing the JSON-only audit, usage and feedback retention. Rename the tracking modes by effect, make "Active users" mode-aware, and generate an exportable DPO report. | Privacy settings sit on 5 pages under 3 names, feedback is kept forever by default, and the mode names contradict GDPR (OB-PM3/4, OB-TW2, OB-UX5) | H | M | IA / wizard |
| 7 | **Fix and extend the docs, and link pages to them.** Correct the false statements: the uploads row, the logging and telemetry nav paths, "immediately", `ui.json`, and the "Anonymous" wording. Add a `docsHref` in every page header. Write `observability.md` (task guides), `audit-log.md` and `data-protection-guide.md`, and add an Observability group to SUMMARY.md. | The DPO reference is wrong on a compliance point, no page links to help, and 4 of the 6 tasks have no guide (OB-B5, B27, OB-TW1) | H | S–M | docs |
| 8 | **Add a monthly report preset.** "Last month" / "This month" presets, a one-file report export with dates in the filename (fixing the duplicate header), test traffic kept out of KPIs, then optional per-model pricing with a Cost KPI and column. | Task 1 takes 11 steps and 3 CSVs, and cost is missing (OB-PM2, OB-AD4, OB-B25) | M | S (presets/export) · M (cost) | UX |
| 9 | **Add the Telemetry wizard and fill its gaps.** Headers (encrypted), protocol, effective-endpoint chip, SSL whitelist in the exporters, test span, and a restart-pending status card. | Task 6 was only partly done: an authenticated or private-CA collector cannot be reached from the UI (OB-B13, B23) | M | M | wizard / fix |
| 10 | **Put the settings pages on the shared shell.** Logging, Telemetry, Chat History and the Feedback and Scheduled Tasks settings move onto `AdminSettingsPage` with `useUnsavedChanges`, formStyles tokens, a shared `AdminPageHeader`, `AdminTabs`, `DateRangeControl` and `Drawer`. Fix dark mode on cold admin loads and add Feedback plus synonyms to Cmd+K. | 5 header patterns, 3 save models and 3 range pickers; edits lost without warning; dark mode broken on every direct admin load (OB-B16, B17, B19, OB-UI1–3) | M | M | UI |

## Appendix — verification log

The lead re-checked every point where panelists disagreed on a fact.

**Corrected**
- **Answer text in the logs (TW).** TW said `info` also logs "the first 1,000 characters of the answer". That is wrong. `logInteraction` truncates `logEntry.response` to 1,000 characters (`server/utils.js:338`), but the `CHAT_RESPONSE` log line emits only ids, app, model and user (`:372-382`). Only the *question* (`query`, `:383-393`) is written. OB-B4 is worded accordingly.
- **Component count (PM vs admin).** The UI offers **30** ids, not 26, and `TokenStorage` *is* selectable (`AdminLoggingPage.jsx:202`). `AgentLoop` and `RunStream` are emitted through a `COMPONENT` constant, so only `AdminRoutes`, `MistralAdapter` and `ModelsLoader` are dead entries. The grep finds about 280 distinct literal `component` values in `server/`.
- **Audit retention location (UX vs TW).** UX repeated the page's tooltip ("Platform → Advanced"). TW is right: no client page edits `audit.retentionDays/cleanupEnabled/includeEmail/verbosity` (grep), and the PUT accepts only `anonymizeIp`.
- **Audit coverage of settings changes (PM).** Audit-settings changes *are* logged precisely (`audit.anonymizeIp -> mask`, `server/routes/admin/auditLog.js:179-185`). The gap applies to logging-config and tracking-mode changes (generic line, no snapshot) and to platform saves (generic summary, snapshot with no UI). OB-B6 is narrowed accordingly.
- **Tracking-mode failure (admin).** The select does not keep showing the unsaved mode: it is controlled and `setMode` runs only on success, so it snaps back silently (UX's account). OB-B7 is worded accordingly.
- **Scheduled Tasks limits (15 vs 16).** There are 15 numeric limits (`NUMBER_SETTINGS`, `AdminScheduledTasksPage.jsx:25-40`) plus the Enabled checkbox.
- **Admin B13 (env var switches to OTLP while the page shows "disabled").** Refuted in the shipped state: `initTelemetry` returns early when disabled, and the env merge applies only when no endpoint is configured (`server/telemetry.js:78-81, 98-106`). The same code produced a new finding instead (OB-B14; refuted by the adversarial verifier below).

**Confirmed by the lead**
- OB-B17: reproduced in the running app (`SCRATCH/observability/lead/dark.js`). The home page had `html.dark`; a full load of `/admin/system-resources` and `/admin/feedback` had no class.
- OB-B1, B2, B3, B8, B9, B10, B11, B12, B13, B15, B16, B19, B20, B21, B24 were re-read in code at the cited lines. OB-B20's arithmetic: one sample in bucket 0 gives `0 + (1/1) × 250 = 250 ms`.
- Sidebar order: alphabetical sort at `AdminSidebarNavData.js:393` (UI correct).
- No `/admin/docs` link and no `useUnsavedChanges` in any of the 8 pages; `AdminSettingsPage` is used only by `AdminSecurityPage`.

**Kept as reported by the panel (environment-dependent)**
- OB-B22 and OB-AD6 rest on panel captures made under 429.
- TW's "Admin Access Required on a rate-limited login" is not listed. The Platform panel's verifier traced the same screen to a client that was not signed in, not to a 429 on the status call.

### Adversarial verification

A second verifier tried to refute every row of §4, checked every §8 wizard and §11 recommendation against the code for an existing implementation, and grepped `docs/` for every §9 gap. Scripts and screenshots: `SCRATCH/observability/verify/` (`verify.js`, `verify2.js`, `otlp-headers.mjs`, `keys.mjs`). Nothing was saved; failed loads were simulated with Playwright `page.route` on GET requests only.

**Refuted (removed from §4)**
- **OB-B14 — Refuted.** The OTel SDK reads `OTEL_EXPORTER_OTLP_HEADERS` itself: `OTLPTraceExporter` builds its config with `convertLegacyHttpOptions(config, "TRACES", …)`, which takes env headers as the fallback layer and merges the user-provided `headers: {}` on top (`server/node_modules/@opentelemetry/otlp-exporter-base/dist/configuration/otlp-http-configuration.mjs`, `mergeHeaders`). `verify/otlp-headers.mjs` built the exporter config the way `server/telemetry/exporters.js:33-36` does, with the env var set, and got `Authorization` and `x-tenant` in the sent headers. iHub's own merge at `server/telemetry.js:98-106` is skipped, but it is not needed. The doc gap (nobody tells the admin this) stays in §9.
- **OB-B29 — Refuted as stated.** A reversed range is not accepted: the client drops an invalid custom range and falls back to the 7-day default, and the range control shows "7 days" pressed (`client/src/features/admin/components/usage/useUsageReportState.js:35-38`; `verify.js` run). In the UI the reversed range cannot be entered at all: Apply is disabled and the date inputs carry `min`/`max` (`RangeControl.jsx`, Apply `disabled={… draft.from > draft.to}`). The server also answers 400 "from must not be after to" (`server/services/usage/usageQuery.js:105`). Only a cosmetic remnant is left: a hand-edited URL keeps its invalid `from`/`to` with no notice.

**Corrected**
- OB-B4: the caller list now includes the main chat path (`server/routes/chat/sessionRoutes.js:714`) and the full scheduler path (`server/services/scheduler/tasks/taskExecution.js:590`). No platform switch suppresses `query`.
- OB-B13: still confirmed (no agent and no whitelist), but the SDK's `OTEL_EXPORTER_OTLP_CERTIFICATE` / `NODE_EXTRA_CA_CERTS` are an env-only escape. The text now says so.
- OB-B26: the measured contrast is 3.04:1 (`#6b7280` and `#dc2626` on `#1f2937`), not below 3:1. It is still below the 4.5:1 that AA requires for `text-xs`. The Telemetry checkbox labels wrap their inputs, so only the text and number inputs lack labels.
- OB-B28: upgraded from Suspected to **Confirmed**. Besides the raw `chatId`, `feedbackRoutes.js:267-274` calls `logInteraction('feedback', { user: req.user, sessionId: chatId })`, and `server/utils.js:360-371` writes the username and chat id at `info` in every tracking mode.
- §1, §2 and task 2: the Feedback review list is not limited to 90 days. Only the summary uses `range: '90d'` (`AdminFeedbackPage.jsx:80`). The entries list pages through the whole `feedback.jsonl`, newest first (`server/feedbackStorage.js:150-177`; `FeedbackReview.jsx` `pageSize = 20`).
- OB-UI3: a shared `StatusBadge` (`client/src/shared/components/StatusBadge.jsx`, job states) and `Badge.jsx` already exist, so the recommendation is narrowed to extending them.
- §9 telemetry row and recommendation 9: the "honour `OTEL_EXPORTER_OTLP_HEADERS`" item was dropped (see OB-B14). The doc gap was reworded.

**Confirmed again (reproduced or proven in code)**
- **Reproduced in the running app:** OB-B1 (platform GET forced to 429: the form still renders and "Save Telemetry Settings" stays visible and enabled, `verify/b1-telemetry-failed-load.png`). OB-B2 (audit-settings GET forced to 429: the audit select shows `off` and "Save Privacy Settings" is enabled; this instance's real value is also `off`, so the overwrite is proven by code at `AdminLoggingPage.jsx:52-55, 270-276, 355-368`). OB-B9 ("Current Level" changed from `info` to `debug` on a tile click, server still `info`). OB-B16 (sidebar navigation from Logging to Telemetry with that draft: no prompt, draft lost). OB-B17 (OS dark: `/` had `class="dark"`, a cold load of `/admin/system-resources` had none). OB-B19 (Cmd+K "feedback": "No results found.", `verify/b19-cmdk.png`). OB-B24 ("Review feedback →" landed on `/admin/feedback` showing "Collection" and "Per-app overrides"). OB-B12 (`/admin/advanced` has no audit fields). OB-B23 (the platform GET returns the raw `${OTEL_EXPORTER_OTLP_ENDPOINT:-…}`).
- **Proven in code at the cited lines:** OB-B3 (30 UI ids; `AdminRoutes`, `MistralAdapter` and `ModelsLoader` have 0 emitters; `WorkflowEngine`, `NtlmAuth` and `IFinderService` have 31–46 call sites and are not offered; 280 distinct literal components). OB-B5 (uploads are stored by default: `chatFilePolicy.js:162` `uploads.enabled !== false`). OB-B6 (`ChangeHistoryDrawer` is used only by the App, Model, Prompt and Project editors). OB-B7, B8, B10, B11 (`en.json:2436`, `de.json:2896`). OB-B15 (`storeFeedback` has no user field). OB-B18 (`keys.mjs`: 12 of 12 FeedbackReview keys and 6 of 54 Logging keys are missing in both en and de). OB-B20 (`percentileFromHist`). OB-B21 (`METHOD_ACTION` POST→create; `deriveResource` at `auditLogger.js:58-70` takes `_discover` as the id). OB-B22 (`UsageOverview.jsx:87-97` shows the empty state when there is an error; Audit renders `AdminLoadError` above an empty `DataTable`, `AdminAuditLogPage.jsx:736-744`). OB-B25 (`BreakdownTable.jsx:105-120`). OB-B27 (`admin.pages` is read from the platform config in `App.jsx:364`).

**Recommendations and wizards checked against the code (none already built)**
- No telemetry test endpoint or wizard, no privacy-profile or data-inventory page, no debug session or log override, no log viewer or ring buffer, no `observability-admin` role (only `contentAdmin` exists, `AdminLayout.jsx:58-62`; planned in Product Strategy & IA `:202-205`), no model pricing, no conversation trace, no `AdminPageHeader`/`docsHref`, no `GateChecklist`/`StatCard`/`DateRangeControl`, no "Last month" preset, and no feedback delete or export route. The first-run setup feature (`client/src/features/setup`) has no privacy or tracking step. `docs/releases/next/` announces none of these.
- Building blocks that the recommendations say to reuse do exist: `ConfirmDialog`, `Drawer`, `AdminLoadError`, `AdminSettingsPage` (used only by `AdminSecurityPage`), `useUnsavedChanges`, and Chat History's `restartRequired`. None of the 8 pages uses `useUnsavedChanges`, `AdminSettingsPage`, `formStyles`, `AdminEmptyState` or `AdminTabs` (grep).

**§9 doc gaps checked in `docs/`**
- `docs/admin-ui.md` has `##` sections only for Scheduled Tasks (`:320`), Usage Reports (`:357`), System Resources (`:400`) and Audit Log (`:445`). There is no `audit-log.md`, `observability.md` or `data-protection-guide.md`, and SUMMARY.md has no Observability group.
- The stale paths are real: `logging.md:55-58` ("Admin → System", "immediately") and `:294`, `telemetry.md:26` ("Admin → More"), and `feedback-feature.md:502` (`ui.json`).
- The JSON-and-restart passage is real (`feedback-feature.md:421-450`), as are the `jq` recipes (`:517-520`), "Anonymous Mode (Highest Privacy)" (`:341`) and "deletion not implemented" (`:478-479`). `pii-data-handling.md:29` (uploads) and its "(new)" markers are real too.
- `telemetry.md` mentions neither `OTEL_EXPORTER_OTLP_HEADERS` nor `OTEL_EXPORTER_OTLP_CERTIFICATE`, and has no OTLP verification step.
