# AI Workspace advanced: Skills, Projects, Workflows, Agents, Marketplace — admin UI review

**Date:** 2026-11-12 · **Panel:** Product manager, UX designer, UI designer, Technical writer, iHub admin
**Pages in scope:** `/admin/skills` (tabs: Skills, User skills), `/admin/skills/:skillName`, `/admin/projects`, `/admin/projects/new`, `/admin/projects/:id`, `/admin/workflows`, `/admin/workflows/new`, `/admin/workflows/:id`, `/admin/workflows/:id/edit` (full-screen canvas, outside `AdminLayout`), `/admin/workflows/executions`, `/admin/agents`, `/admin/agents/new`, `/admin/agents/:profileId`, `/admin/agents/:profileId/runs`, `/admin/agents/:profileId/memory`, `/admin/agents/inboxes`, `/admin/agents/inboxes/:inboxId`, `/admin/agents/approvals`, `/admin/agents/runs`, `/admin/agents/runs/:runId`, `/admin/marketplace`, `/admin/marketplace/registries` ([App.jsx:531-672](../../client/src/App.jsx)).

All five panel notes were delivered and used. Eight panels shared one instance and one IP. During the panel runs the admin API limit was 100 requests/min, so most panelists saw long stretches of HTTP 429 and walked fewer flows live than planned. The UX designer and the technical writer worked mostly from code plus EN/DE page dumps; the admin walked six tasks end to end. The limit now reads 100000 (`contents/config/platform.json:254-257`). How each page renders a failed request is a finding in its own right (AX-B9).

**Instance incident (disclosed by the admin):** the admin's script deleted the shipped "iHub Official Marketplace" registry, because the native delete confirm does not name the registry (AX-B14). It was re-created within a minute from `server/defaults/config/registries.json` and refreshed. The lead checked it afterwards: `ihub-official`, enabled, 373 items. Test entities (`zz-skills-projects-workflows-agents-marketplace-*`: a user skill, a promoted skill, a project, a workflow, an agent profile, a registry, an inbox file) were deleted. Leftovers are run history (`wf-exec-cd68d095`, `wf-exec-8bc1be82`, `wf-exec-9367a29e`), change-history records, and one stale pending approval for the aborted run `wf-exec-8bc1be82`. That stale approval is itself a defect (AX-B16). The lead re-checked every disputed or single-source fact in code and live (`lead/check.js`, `lead/pend.js` in the scratch folder); see the appendix.

## Summary

This part is the composition layer above apps:
- **Projects** hold knowledge.
- **Skills** hold reusable procedures.
- **Workflows** are fixed multi-step graphs.
- **Agents** are workflows that run unattended under a service account, with an inbox, memory and approvals.
- The **Marketplace** brings all of these in from catalogues.

**Projects and the Marketplace are good.** Projects in particular is the reference page for the whole admin: Estimate tokens, Test, Try in chat, Used by, and delete blocked while in use, with a named and clickable list.

**The rest is not intuitive.** The admin finished one of six tasks only through a workaround, three partially, and failed two: create an agent and approve its action, and explain the five concepts. Panel median for the agent editor: 1/5.

The biggest problems:
- **Agents don't do what they promise.** The server discards the Schedule on save (`serializeProfile()` rebuilds the definition without triggers), so a scheduled agent is never stored with its schedule and never runs (AX-B1). The editor's JSON mode drops keystrokes (AX-B2). Commas cannot be typed into the approver and service-account fields (AX-B3). The model picker offers disabled and transcription models (AX-B8).
- **Approvals can get stuck.** An "Ask a Person" step with no options can be saved and can never be answered (AX-B4). Its option labels show `[object Object]` and editing them destroys the German text (AX-B5). A cancelled run leaves its approval in the queue (AX-B16). The queue is admin-only although the API serves approver groups (AX-B24).
- **Workflows have two half-editors.** Neither can run a test. The canvas loses work without warning (AX-B6). "Publish" changes nothing at runtime (AX-B11). Nobody can tell from the UI what the run input is called (AX-B12).
- **Admins cannot write a skill in Admin → Skills.** It takes 18 steps through the end-user library, sharing and Promote.
- **German is missing on Skills, Workflows and Agents** (about 320 keys, AX-B7).
- **Failed loads look like empty content** and offer "Create your first…" or "Add Registry" (AX-B9).
- **The docs don't teach these tasks.** `concepts.md` has no Workflow or Agent row. `agents.md` is an engineering spec. No page links to the docs.

## 1. What this part does

- **Skills** (`/admin/skills`, `/admin/skills/:skillName`): global skills (a `SKILL.md` plus files) in a hand-built table with a System badge.
  - Actions: Import Skill (.zip), Export, Disable, Delete.
  - A **User skills** tab lists users' shared skills, offers Promote, and holds the user-skill limits form.
  - The detail page renders SKILL.md read-only and has Files and Configuration tabs (group access, description override).
  - There is no create or edit of SKILL.md here ([AdminSkillsPage.jsx:264-272](../../client/src/features/admin/pages/AdminSkillsPage.jsx), `AdminSkillEditPage.jsx:536-551`).
  - Used monthly; skills get created quarterly.
- **Projects** (`/admin/projects`, `/new`, `/:id`): knowledge collections (uploads, URLs, iFinder) linked to apps, workflows and agents.
  - The list has stat tiles, kind and status filters, bulk enable, disable and merge, and a "Project settings" disclosure for *user*-project sharing.
  - The detail page has an items table and a summary rail (availability: Linked apps only / Everyone signed in / Off), plus Estimate tokens, Test, Try in chat, Used by and History.
  - Used weekly. It is the most complete flow in the admin.
- **Workflows** (`/admin/workflows`, `/new`, `/:id`, `/:id/edit`, `/executions`): a DataTable of workflows (18 ship; 5 are v1/v2 near-duplicate pairs and 2 are disabled copies of agent profiles).
  - Two editors. The **form page** holds metadata, a raw JSON textarea that "overrides the metadata fields above", Chat integration, and Group access, which saves immediately. The **full-screen canvas** has a step palette, Save and Publish.
  - Executions shows status tiles and filters. Its detail opens the end-user `/workflows/executions/:id`, outside the admin shell.
  - Used monthly. Building is quarterly; checking runs is daily once live.
- **Agents** (`/admin/agents` and sub-routes): profiles (name, ID, inbox, schedule, an On/Off toggle chip, Run).
  - The editor is one 1,418-line page with 14–15 always-open sections, about 6,200 px tall (UI): identity, persona, model, capabilities, projects, skills, decomposition, synthesizer, plan-and-review loop, schedule, inbox, memory, composer, budgets, HITL approvers, service account.
  - Header buttons lead to Manage Inboxes (markdown checklists) and Pending Approvals. Pending Approvals is the queue for **all** paused agent runs **and** workflows.
  - Per-profile Runs and Memory pages exist. The all-runs page `/admin/agents/runs` is linked from nowhere.
  - Rarely used, but each agent is high value.
- **Marketplace** (`/admin/marketplace`, `/registries`): a card grid with type tabs and counts, registry and status filters, a detail drawer with releases, and install, update, replace and uninstall. Registries has add and edit with Test Connection, auth types, channel and pins, and trust-for-code.
  - Used monthly; registries are set up once.

## 2. Is it intuitive? — verdict

Panel median; the persona range is in brackets.

| Page | Score (1–5) | Why |
|---|---|---|
| Skills list | 2 (2–3) | Clean table, but the only create action is "Import Skill (.zip)". There is no usage column and no link to marketplace skills. Action icons jump position between system and custom rows. Delete uses a native `confirm()`. |
| Skill detail | 3 (2–3) | Good "enable it for an app in the app's Skills settings" notice. But SKILL.md is read-only, there is no "Used by apps", no Try in chat, and the rendered markdown H1 is larger than the page H1. |
| Projects list | 4 (4) | Clear filters, availability column, merge and dependency dialogs. Platform-wide user-project settings sit between the tiles and the table. "1 items" plural bug. |
| Project new / detail | 4 (4) | The best flow in the admin: ID derived from the name, availability cards that state consequences, "Create and add items", Estimate tokens, Test, Used by, and delete blocked while in use. Gaps: no group scoping, Used by is read-only, and a banner sends admins to the JSON key `platform.projects.scan`. |
| Workflows list | 3 (2–4) | Consistent DataTable, but two edit actions ("Edit" and "Visual editor"), no Run, no last run, a misleading Groups column (AX-B10), and the primary button sits between two secondaries. |
| Workflow form page | 2 (2) | Metadata form, a raw JSON textarea that overrides it, and group access that autosaves: three save models on one page. No steps can be added here, yet "Create New Workflow" lands here. Shows "Name * *". |
| Workflow canvas | 3 (2–3) | Good palette, a "Connect to" keyboard alternative, and an unknown-variable warning. But: stray frames behind nodes, overlapping edge labels, no Run or Test, unexplained Save vs Publish, no unsaved-changes guard, and white controls in dark mode. |
| Workflow executions | 3 (3–4) | Status tiles and filters work (admin: 4). The detail leaves the admin shell; there is a "← Back" link instead of a breadcrumb. Agent runs are not listed although they are executions. |
| Agents list | 2 (1.5–3) | No last run, next run or failure state. The inbox shown does not exist. The On/Off chip is an unconfirmed toggle. No link to all runs. |
| Agent editor | 1 (1–1.5) | 15 equal cards with planner, reviewer and composer system prompts. Developer copy. Free-text inbox and group IDs. A raw UTC cron that never fires. JSON mode that cannot be typed in. Save only at the top. |
| Agent inboxes | 2 (1.5–3) | One unlabelled, borderless ID box plus "Create". No delete. The help text contradicts the agent form ("via read_inbox" vs "no LLM tool calls"). |
| Pending Approvals | 3 (3) | A clear queue with kind tabs and a good empty state. But it is buried under "Agent Profiles", has no badge, no inline decision, and for a workflow run "Open run" leaves the admin area (agent runs open `/admin/agents/runs/:id`, `AdminAgentApprovalsPage.jsx:62-68`). |
| Agent runs / run detail | 3 / 4 | The run detail is readable (steps, inbox item, error). The runs list has no entry point, and the run detail is hard-coded English. |
| Agent memory | 2 (UI) | A bare textarea with "Version 0" and a lone disabled Save. |
| Marketplace | 4 (3–4) | Strong cards, counts and drawer, with local-copy warnings. But a failed load shows "No registries configured / Add Registry", there is no "Updates available" view, and "Replace local copy" is the main call to action on half the cards. |
| Registries | 3 (3–4) | Test Connection exists. But Save ignores a failed test, errors appear in `alert()`, delete doesn't name the registry, the modal footer is cut off at 900 px, and the table is hand-rolled. |

**Verdict.** Admins think in assemblies: "give the sales app our price list and the quoting procedure", "run this every Monday and let a team lead approve it". The UI is organised in one-way silos:
- A skill, project or workflow is linked to an app only from the App editor.
- Group access lives on a third page.
- Runs and approvals are hidden under Agents.

**Where the newest pattern was applied, the UI works.** Projects has Test, Used by, consequence copy and a delete guard. The Marketplace has tabs, a drawer and warnings. **Where it wasn't, the UI exposes the runtime instead of the job.** Agents ask an admin for planner prompts and a UTC cron that is never read. Workflows ask them to choose between a JSON page and a canvas.

**The fastest wins are fixes, not redesign.** Seven P1 defects sit in agents, workflow approvals and translations, and most are S effort. The structural win is to copy the Projects pattern (Used by + Add to app, inline test, honest states) to Skills, Workflows and Agents, and to give runs and approvals one home.

## 3. Task walkthroughs

Walked live by the admin (step counts are theirs). The others repeated parts where the rate limit allowed.

**T1 — Create a skill and attach it to an app** · 18 steps · frustration 4/5 · **success, only via a workaround**
1. Admin → Skills offers only Import Skill (.zip).
2. The admin guessed their way to the end-user library: `/prompts` → New → New skill. The dialog itself is good.
3. Back in Admin → Skills → User skills, the skill was missing: the tab lists only skills shared with a group or with everyone. They had to share their draft with "Admins" (which exposes it to users), then Promote. The Promote dialog has good copy.
4. Apps → Translator → Skills → "Enable skills in this app" → search: **the same skill appears two or three times, identically** (AX-B22). They picked one at random.
5. "Save & Exit" gave no toast. Saving also wrote a default `greeting` and `inputMode` into the Translator app (`AdminAppEditPage.jsx:160-175`; covered as AI-PM4 in report 02).
6. The skill page has no "Used by", so the result could not be checked from the skill's side.

**T2 — Knowledge project: upload, share with a group, token count, use in an app** · 14 steps · frustration 3/5 · **partial**
1. New project → name. The ID is derived from the name and silently cut at 50 characters mid-word (AX-B33).
2. "Create and add items" → upload → **Estimate tokens** recommends "in the prompt" → **Test** works without an LLM ("Every item can be read").
3. **Share with a group: impossible.** Availability offers only Linked apps only / Everyone signed in / Off. Group scope comes only indirectly, from the linked app's groups.
4. Linking from the app editor worked, Used by updated, and deleting the linked project is blocked with a named, clickable list.

**T3 — Two-step workflow (summarise → translate), run, inspect** · ~25 steps on 4 pages · frustration 4/5 · **partial**
1. "Create New Workflow" opens the metadata/JSON form, not the canvas. It accepts the default name "New Workflow" and duplicates.
2. The list row has no Run or Executions action.
3. "Open visual editor" → palette (good) → nodes with stray black frames (AX-B20) → wire Start → Summarise → Translate → End → Save ("Workflow saved").
4. The canvas warns that `{{input}}` and `{{summary}}` are "used but never set". The `summary` warning is correct. For the user's text the admin had no way to learn the name: the run dialog sends `initialData.message`, chat sends `input`, and the Variables tab says "No variables yet" (AX-B12).
5. Running required leaving the admin area for `/workflows`, finding the card by its placeholder description, and confirming an AI-use dialog.
6. Failure message: "Node prompt-1794518310650 failed: Agent execution failed: openai API service error". It shows an internal node id and names "openai" for an Azure model (AX-B32).
7. Admin → Workflows → View Executions listed the run.

**T4 — Agent with an inbox; find runs; approve a pending action** · ~22 steps · frustration 5/5 · **failed**
1. New Profile is a form of about 10,000 characters with seven model dropdowns and two variable syntaxes (`${$.data.brief}` and `{{previousTaskResults}}`).
2. The inbox is a free-text ID; the schedule is raw cron.
3. On the list, the On/Off chip looked like a status badge. Clicking it disabled the agent with no confirmation. Run stayed clickable and failed with "Profile … is disabled".
4. After re-enabling, the run failed with "Model not found: local-vllm": the picker had offered a disabled model (AX-B8). The run detail page was good.
5. Agent Runs is not linked from the Agents header.
6. To get something to approve, the admin added an **Ask a Person** step to their workflow. It has no "who approves" field and a timeout in **ms**. They saved it with zero options.
7. The run appeared in Pending Approvals with only "Open run", which jumps to the end-user UI. There, **Submit Response is permanently disabled** (AX-B4). The only exit was Cancel, and the cancelled run's approval is **still listed** in Pending Approvals (AX-B16, lead).
8. The test inbox could not be deleted (AX-B18).

**T5 — Marketplace: browse, add a registry, install/uninstall** · 12 steps · frustration 3/5 · **partial**
1. Browsing is good.
2. Add Registry → Test Connection returned "HTTP 502: Bad Gateway" (environment). **Save still created an enabled registry with 0 items.**
3. Refresh showed `alert("Request failed with status code 500")` and dropped the server's `detail` (AX-B15).
4. Delete uses a `confirm()` that does not name the registry, which is how the official registry was deleted (AX-B14).
5. Install and uninstall were not executed: items install under their own ID, and the panel rules require `zz-` names.

**T6 — Explain app vs skill vs workflow vs agent vs project to a colleague** · **failed (all five personas)**
- `docs/concepts.md:7-17` and its decision guide (`:81-89`) have no Workflow, Agent or Marketplace row.
- The sidebar lists the eight AI Workspace items alphabetically, with no relationships between them.
- "Claude-style Autonomous Agent" exists both as a workflow and as an agent profile.
- No page subtitle says what the object *is*. For example, Skills: "Install, configure, and manage skills for your iHub Apps".

## 4. What is broken

Personas are in brackets; "lead" means the lead verified the claim (appendix).

| ID | Status | What happens | Evidence | Severity |
|---|---|---|---|---|
| AX-B1 | Confirmed | **The agent Schedule never fires — it is not even saved.** The editor writes `workflow.definition.triggers = [{type:'schedule', config:{cron, timezone:'UTC'}}]` into the profile. On create and update the server runs `serializeProfile()`, which rebuilds an embedded `workflow.definition` from the profile flags and discards the old one, triggers included; the field is empty after a reload (verifier: POST with a schedule trigger, GET back → `definition.triggers` undefined). Even if it were kept, the scheduler reads only `contents/workflows` through `configCache.getWorkflows`, and it needs `trigger.id` plus a top-level `trigger.cron`. `docs/agents.md:5,37-38` promises "wait for the schedule", and the list subtitle promises schedules and webhooks. A nightly agent stays silent. (PM; lead; verifier) | `AdminAgentEditPage.jsx:211-224,326-328`; `server/routes/admin/agents.js:194,224`; `server/agents/profile/profileWorkflowSerializer.js:919-956`; `server/services/scheduler/workflowTriggerSource.js:53,112-117`; `server/startup/worker.js:567-568`; `verify/live.js` | P1 |
| AX-B2 | Confirmed | **Agent JSON mode drops every structural edit.** It is a controlled `value={JSON.stringify(profile)}`, and `onChange` discards every keystroke that leaves the JSON invalid. Edits inside an existing string value survive; adding a key, a comma, or anything with an invalid intermediate state is lost. Only pasting a complete document works for those. (UX; UI; verifier: typing `,"x":1` was dropped, typing inside the `id` string was kept) | `AdminAgentEditPage.jsx:372-382`; `ux/agentjson.js`; `verify/live.js` | P1 |
| AX-B3 | Confirmed | **Commas cannot be typed into "HITL approver groups" or "Service account groups".** Typing `agent-operators,admins` yields `agent-operatorsadmins`: the field splits, filters and re-joins on every keystroke. Approvals then reach nobody and the agent gets no permissions. (UX; lead live repro) | `AdminAgentEditPage.jsx:1291-1324`; `lead/check.js` → `approver field: agent-operatorsadmins` | P1 |
| AX-B4 | Confirmed | **An "Ask a Person" step with zero options can be saved and is unanswerable.** `options: []` resolves to no buttons, `canSubmit = !!selectedOption` is never true, and the run is stuck until Cancel or timeout. (admin) | `HumanCheckpoint.jsx:255,531`; `HumanNodeExecutor.js:347-357`; `admin/shots/t4-openrun.png` | P1 |
| AX-B5 | Confirmed | **The "Ask a Person" panel shows `[object Object]`** in every option label of the shipped approval workflow. Typing into it replaces the `{en,de}` label with a string, so the German label is lost. (UI) | `HumanForm.jsx:64` (`value={opt.label \|\| ''}`); `contents/workflows/approval-workflow.json:79`; `ui/shots/light-dlg-wf-node.png` | P1 |
| AX-B6 | Confirmed | **The workflow canvas loses unsaved work without warning** on Back (`navigate(-1)`), on the "Chat integration" link, or when the tab is closed. The only warning is in that link's tooltip. The form page next to it does use `useUnsavedChanges`. (UX, PM, UI) | `WorkflowEditorPage.jsx:195` (Back), `:226-237` (link); no guard under `features/workflows/editor/`; `docs/workflows.md:406-408`; cf. `AdminWorkflowEditPage.jsx:59` | P1 |
| AX-B7 | Confirmed | **German is missing on Skills, Workflows, Executions and all Agents pages.** `t()` keys exist in neither `en.json` nor `de.json`. AdminAgentEditPage is missing 99 of 104, AdminWorkflowsPage 29 of 29, AdminSkillsPage 23 of 35, AdminAgentsPage 25 of 29. AgentRunsPage and the run-detail Approve/Reject buttons are hard-coded English. Projects and Marketplace are complete. (TW, UI; lead spot-check) | `tw/tkeys.mjs`; `tw/de_admin_agents_new.txt`; `AgentRunsPage.jsx:60-130`; `AgentRunDetailPage.jsx:498-551` | P1 |
| AX-B8 | Confirmed | **The agent model pickers (×5) offer disabled and transcription models.** The filter drops only `supportsImageGeneration`, and the run fails with "Model not found: local-vllm". Verifier: all three disabled models (`iassistant-conversation`, `local-vllm`, `voxtral-mini-realtime`) are offered on `/admin/agents/new`. (admin, PM; verifier) | `AdminAgentEditPage.jsx:519-520` (also 691, 850, 1062, 1205); run `wf-exec-9367a29e`; `verify/live.js` | P2 |
| AX-B9 | Confirmed | **A failed load renders as empty content.** Projects shows the error *and* "No projects yet. Create your first project". Agents shows "No agent profiles yet". Skill and project detail say "Skill not found" / "Project not found". Marketplace swallows the registry error and shows "No registries configured / Add Registry" while a 373-item registry exists. All of these invite duplicates. Marketplace also fetches `?limit=1000` on every mount and after every install. (all five) | `AdminMarketplacePage.jsx:65-67,76-88,91-98,142`; `AdminProjectsPage.jsx:438,546-560`; `AdminAgentsPage.jsx:244-279`; `ux/shots/_admin_projects.txt`, `_admin_agents.txt`; `pm/shots/_admin_marketplace.png` | P2 |
| AX-B10 | Confirmed | **The Workflows "Groups" column shows the legacy `allowedGroups`, not the access rule.** 17 of 18 rows read "—". `research-assistant` reads "users, admin". Access is decided only by `permissions.workflows`, which **no shipped group grants**, so no non-admin can run any shipped workflow. (PM, UX; lead settled their conflict) | `AdminWorkflowsPage.jsx:33-34`; `workflowAccess.js:29-44`; `contents/config/groups.json`; `lead/check.js` row text | P2 |
| AX-B11 | Confirmed | **"Publish" has no runtime effect.** It writes a snapshot to `contents/workflows/.history/` that no route or UI reads, and sets `status:'published'`, which nothing reads either. Draft and published run identically. It is undocumented. (PM, TW, UX) | `workflowRoutes.js:1916-1962`; `grep` for readers of `status`/`historyDirFor` finds none | P2 |
| AX-B12 | Confirmed | **The workflow input variable cannot be found from the UI.** The run dialog (for a workflow without inputs) sends `initialData.message`, a chat run sends `input` (`PromptNodeExecutor.js:954`), and the canvas flags `{{input}}` as "used but never set". (admin; lead) | `StartWorkflowModal.jsx:470`; `docs/workflows.md:276-278`; `admin/shots/t3-aftersave.png` | P2 |
| AX-B13 | Confirmed | **Deleting a skill or workflow, or uninstalling from the marketplace, has no usage check.** Apps keep dangling IDs, and the confirm text names neither the object nor the consequence. Projects block this with `PROJECT_IN_USE`. (UX, TW) | `server/routes/admin/skills.js:347-380`; `workflowRoutes.js:713-735`; `ContentInstaller.js:1009-1050`; `AdminSkillsPage.jsx:108`; `AdminWorkflowsPage.jsx:95` | P2 |
| AX-B14 | Confirmed | **The registry delete confirm does not name the registry.** This led to deleting the shipped official registry during the review. There is no "restore default". (admin) | `shared/i18n/en.json:2734`; `AdminMarketplaceRegistriesPage.jsx:77-84` | P2 |
| AX-B15 | Confirmed | **Registry errors are hidden.** Refresh failures use `alert("Request failed with status code 500")` and drop the server `detail` ("HTTP 502: Bad Gateway"). Save creates an enabled registry after a failed Test Connection. (admin) | `AdminMarketplaceRegistriesPage.jsx:66` | P2 |
| AX-B16 | Confirmed | **A cancelled run leaves its approval in Pending Approvals.** Run `wf-exec-8bc1be82` is `aborted`, and its workflow is deleted, yet `GET /api/interactions/pending` still returns its checkpoint and the queue shows it with "Open run". Workflow cancel does not cancel the run's interactions (`interactionService.cancel` is called only from chat and scheduled tasks). (lead, following the admin's T4; verifier re-ran the GET: `ckpt-a91feef1…` still `pending`) | `contents/data/runs/wf-exec-8bc1be82-….json` (`status: aborted`); `lead/pend.js`; `lead/approvals.png`; `verify/live.js` | P2 |
| AX-B17 | Confirmed | **Shipped agents point at a non-existent inbox.** `"inboxId": "claude-style-agent"`, while the inbox list is empty. The field is free text with no validation. (PM, UX) | `contents/agents/profiles/claude-style-agent.json:26`, `-phased.json:31`; `GET /api/admin/agents/inboxes` → `{"items":[]}` | P2 |
| AX-B18 | Confirmed | **Agent inboxes cannot be deleted**, neither in the UI nor through the API. (admin; verifier: `DELETE /api/admin/agents/inboxes/:id` → 404) | `server/routes/admin/agentInboxes.js:25-80` (GET/PUT/POST only) | P3 |
| AX-B20 | Confirmed | **The canvas draws a stray box behind every node.** The custom node is registered as React Flow's `default` type, so the library's `.react-flow__node-default` border, 150 px width and white fill apply. Edges attach to it and loop, and branch labels overlap. In dark mode the frames, zoom controls and minimap are white. (UI, admin, PM) | `WorkflowEditor.jsx:41`; `ui/shots/light-workflow-editor.png`, `dark-workflow-editor.png`; `admin/shots/t3-addstep.png` | P2 |
| AX-B21 | Confirmed | **The cron field is unvalidated and fixed to UTC.** "not a cron" is accepted; the timezone is hard-coded to UTC and never shown. Editing it replaces the whole `triggers` array, which drops any webhook trigger (today the server discards the embedded triggers on save anyway, AX-B1). Relevant once AX-B1 is fixed. (UX, TW) | `AdminAgentEditPage.jsx:211-224`; `ux/agent.js` | P2 |
| AX-B22 | Confirmed | **The app editor's skill picker lists the same skill 2–3 times** (global, the admin's user copy, the shared copy), with no labels. It reads the *user* `/api/skills`, keys by `name`, and the app stores only the name. (admin) | `SkillsSelector.jsx:30-35,165`; `admin/shots/t1-app-skill-search.png` | P2 |
| AX-B23 | Confirmed | **The agent list's On/Off chip is an unconfirmed toggle** styled like a badge, and Run stays clickable on a disabled agent. (admin, UI) | `AdminAgentsPage.jsx:143-166` (chip), `:172-178` (Run, no `disabled`) | P3 |
| AX-B24 | Confirmed | **Non-admin approvers have no queue.** `GET /api/interactions/pending` is `authRequired` and filters by `policy.approverGroups` and ownership. Its only client is the admin-only `/admin/agents/approvals`. Nothing notifies anyone when an approval is raised. (PM) | `server/routes/runs.js:436-470`; `App.jsx:638`; `client/src/api/endpoints/runs.js` | P2 |
| AX-B25 | Confirmed | **Borderless inputs.** Classes set `border-gray-300` without `border`, so in Tailwind v4 the width is 0. Affected: on `/admin/agents/new` 22 of 27 text inputs and selects have a computed `border-top-width: 0px` (verifier), among them agent ID, colour, every model select, max iterations and max tasks, cron, inbox, approver and service-account groups; workflow "Max execution time"; "Create inbox". They read as plain text. (UI; verifier) | `AdminAgentEditPage.jsx:1373` (`FieldText`) and the selects/inputs using `rounded-lg border-gray-300`; `AdminWorkflowEditPage.jsx:457`; `AdminAgentInboxesPage.jsx:81`; `verify/live.js`; `ui/shots/crop-agent-new-top.png` | P2 |
| AX-B26 | Confirmed | **Dark-mode gaps.** The agent editor's JSON and Cancel buttons and the icon picker are white with near-invisible text. Cold-loading any admin URL ignores the saved theme (cross-part, SH-B9 in report 01). (UI) | `AdminAgentEditPage.jsx:347,362`; `ui/shots/d-sheet1.png` | P2 |
| AX-B27 | Confirmed | **The Add Registry modal is cut off and inaccessible.** Its footer (Cancel/Save) scrolls out of view at 1440×900. It has no `role="dialog"`, Escape handling or focus trap, although the shared `Modal` exists. (UI) | `components/marketplace/RegistryFormDialog.jsx:188`; `ui/shots/light-dlg-registry-add.png` | P2 |
| AX-B28 | Confirmed | **On a load error, Skills and Workflows erase the whole page.** They render only `AdminLoadError`: no H1, breadcrumb or actions. (UI) | `AdminSkillsPage.jsx:210-218`; `AdminWorkflowsPage.jsx:300-307` | P3 |
| AX-B29 | Confirmed | **"Name * *": a double required marker** on the workflow and agent editors. The page adds a `*` and `DynamicLanguageEditor` adds another. (UI, TW, UX) | `AdminWorkflowEditPage.jsx:416-424`; `AdminAgentEditPage.jsx:418`; `DynamicLanguageEditor.jsx:320` | P3 |
| AX-B30 | Confirmed | **Plural bug: "1 items" / "from 1 projects"** on the projects list, the merge dialog and the agent project picker. (UI) | `shared/i18n/en.json:5282` (no `_one`) | P3 |
| AX-B31 | Confirmed | **Orphans in navigation.** `/admin/agents/runs` is linked from nowhere. Cmd+K has no Workflows entry and no skill, workflow or agent entity search. (PM, UX, TW) | `App.jsx:649`; `AdminCommandPalette.jsx:11-45,75-83` | P3 |
| AX-B32 | Confirmed | **Wrong or leaked copy.** The agent page's skill picker says "add to **this app**". The workflow errors show node ids and the provider type instead of step and model names. (UI, TW, admin) | `SkillsSelector.jsx:202`; `WorkflowEngine.js:1229` | P3 |
| AX-B33 | Confirmed | **The project ID slug is cut mid-word at 50 characters**, without notice. (admin) | `client/src/features/admin/utils/projectAdmin.js:43,237` (`slugify(text).slice(0, MAX_PROJECT_ID_LENGTH)`) | P3 |
| AX-B34 | Confirmed | **Mobile (390 px) problems.** The canvas palette takes about 55% of the width and hides "Auto Layout". The Agents header squeezes the title into about 90 px. The hand-rolled tables (Skills, Inboxes, Registries, Executions) push their actions off-screen. (UI) | `ui/shots/m-sheet1.png`, `m-sheet3.png`; `AdminAgentsPage.jsx:208` | P3 |
| AX-B35 | Confirmed | **`docs/marketplace.md` contradicts itself:** ":21 One registry is preconfigured" vs ":38 Both registries are fetched". (PM) | `docs/marketplace.md:21,38` | P3 |
| AX-B36 | Confirmed | **The "Start Workflow" dialog is not exposed as a dialog:** automation found no `[role=dialog]`; the code has no `role="dialog"`, `aria-modal` or Escape handler, and does not use the shared `Modal`. (admin; verifier in code) | admin T3 script output; `client/src/features/workflows/components/StartWorkflowModal.jsx:340-350` | P3 |

**Not a defect (settled by the lead):** the UI designer's suspected crash on run detail with localized option labels (`AgentRunDetailPage.jsx:505-521`). The server resolves labels to strings before sending them (`HumanNodeExecutor.js:347-357`), so the page receives strings.

## 5. Findings by persona

### Product manager

- **AX-PM1 — Three schedulers and two memory systems.** All three schedule AI work:
  - Scheduled Tasks: UI, timezone, memory (`docs/scheduled-tasks.md`).
  - Workflow `triggers`: JSON only (`docs/workflows.md:514-524`; schema `workflowConfigSchema.js:589-625`).
  - The agent Schedule: UI, no effect (AX-B1).

  Agent memory and task memory are separate stores (`docs/scheduled-tasks.md:325-333`). *Recommendation:* one "When it runs" component, the Scheduled Tasks picker (presets, timezone, next three runs), writing the `{id, type, cron, timezone}` shape the scheduler reads. Use it on agents and workflows, register agent triggers with the same source, and show Next run on both lists.
- **AX-PM2 — The agent editor exposes the runtime, not the job.**
  - It asks for planner, synthesizer, reviewer and memory-composer system prompts (`AdminAgentEditPage.jsx:629-1243`).
  - Its hints are developer jargon: "NOT exposed as LLM tools … opt-in escape hatch", `app__<id>`, "features.appAsTool flag" (`:558-572`).
  - Copilot Studio and LibreChat agents start from "describe what it should do", then add knowledge, actions and triggers.

  *Recommendation:* the New-agent wizard (§8) and an "Advanced runtime" collapse with the shipped defaults.
- **AX-PM3 — Operations are buried under build pages.** Pending Approvals is a header button on Agents. The all-runs list is orphaned. Workflow executions and agent runs are two lists of one object ("An AgentRun is a WorkflowExecution", `docs/agents.md:16`). Approvers who are not admins get no queue or notification (AX-B24). *Recommendation:* "Runs & approvals" (§6), with a count badge and a non-admin "My approvals" page, plus a notification when an approval is raised.
- **AX-PM4 — Access control overlaps.**
  - Workflows have legacy `allowedGroups`, shown in the list, alongside `permissions.workflows`, which is enforced (AX-B10).
  - Admin projects cannot be scoped to a group. `MEMBER_TARGET_TYPES` (user, group, everyone) exist only for user projects (`server/services/projects/projectConstants.js:25`).
  - Open WebUI knowledge and Glean both scope knowledge by group.

  *Recommendation:* migrate `allowedGroups` away and show effective groups computed from `groups.json`; add a "Specific groups" option to admin-project availability.
- **AX-PM5 — Capabilities with no UI:**
  - workflow schedule and webhook triggers (HMAC secret, timezone, `initialData`);
  - agent webhooks (promised at `AdminAgentsPage.jsx:218`);
  - agent `nodeModels` per-step model overrides (`agentProfileSchema.js:218`);
  - agent `artifacts.outputDir/primary` and profile visibility `groups` (`AdminAgentEditPage.jsx:72,103`);
  - project malware scanning `platform.projects.scan`, which the banner sends to JSON (`AdminProjectEditPage.jsx:513`);
  - `GET /api/admin/marketplace/updates`, which has no client caller and no "Update available" filter across 373 items (`AdminMarketplacePage.jsx:234-241`).
- **AX-PM6 — The shipped examples clutter the first impression.** 18 workflows ship (16 enabled), including 5 v1/v2 pairs, 4 German "Stellungnahmen" audits, an iFinder corpus analysis, and 2 disabled agent copies. Yet AX-B10 means no non-admin can use any of them. There is no plain "summarise → translate" starter. *Recommendation:* a 4-template "New from template" gallery; move the rest to the marketplace and retire the superseded v1s.
- **AX-PM7 — "Agent" means five things:** Agent Factory profiles; remote A2A agents (Integrations); the Microsoft 365 Copilot agent; the "Agent runtime" palette group shown in every workflow; and the two `claude-style-agent*` workflows that duplicate the profiles. *Recommendation:* "Agents" means autonomous agents only. Say "Remote agents" for A2A. Hide the agent-runtime nodes (Inbox Load/Finalize, Memory Finalize) unless the canvas is editing an agent. Stop shipping the agent workflows as standalone workflows.

### UX designer

- **AX-UX1 — Every block is connected somewhere else.** The project Used by card is read-only (`ProjectUsedByCard.jsx:60-110`). The workflow page says "Not assigned to any app yet. Assign it under Admin → Apps → Workflows" with no action (`WorkflowChatIntegrationSection.jsx:64`). Skills have no Used by at all. *Recommendation:* a shared `UsedByCard` with **Add to app…** (an app multi-select that writes the app's `skills`/`projects`/`workflows`) on the Skill, Workflow and Project pages. Linking then works from both ends. (Admin AX-AD2 and TW AX-TW11 independently made the same proposal.)
- **AX-UX2 — A skill needs three switches with no checklist:** skill enabled; groups granted `permissions.skills`; the app lists the skill *and* has `skillSettings.enabled` (`AppFormEditor.jsx:261-273`). *Recommendation:* a readiness panel on the skill page: "✓ Enabled · ✓ 2 groups may use it · ✗ No app offers it [Add to app…]".
- **AX-UX3 — The workflow has two editors and no clear entry point.**
  - "Create New Workflow" opens a page where no steps can be added.
  - The canvas for a new workflow (`/admin/workflows/new/edit`) is linked only from the end-user Workflows page (`WorkflowsPage.jsx:52`).
  - "Open visual editor" appears only after the first save (`AdminWorkflowEditPage.jsx:330`).
  - Save returns to the list (`:253`).

  *Recommendation:* one page (§6, §10).
- **AX-UX4 — Three state concepts with no explanation:** Save, Publish and Enabled. The starter template sets `status:'draft'` with `enabled:true`. *Recommendation:* remove Publish until it does something (AX-B11). Then one control, "Draft → Published", plus a separate "Available in chat" toggle, each saying what users see.
- **AX-UX5 — No test from any editor.** Workflow row actions are Edit, Visual editor, Toggle, Clone, Download, Delete (`AdminWorkflowsPage.jsx:259-293`). The canvas toolbar is Auto Layout, Publish, Save. The agent editor has no Run now. *Recommendation:* a Test-run drawer on the canvas that takes inputs from the Start node and shows a live step timeline (reusing `StepDetails`), and "Run now" on the agent editor. Dify's debug panel is the benchmark.
- **AX-UX6 — Split vocabulary.** Workflows say "Executions" and open the end-user detail page; agents say "Runs" and stay in admin (`AdminWorkflowExecutionsPage.jsx:266`). *Recommendation:* call both "Runs" and use one admin run-detail page.
- **AX-UX7 — The agent editor has no progressive disclosure.** The `Section` component cannot collapse (`AdminAgentEditPage.jsx:1348`). HITL and Decomposition are unexplained. *Recommendation:* in edit mode keep Identity, Persona, Model, Capabilities and Trigger open; move the rest under "Advanced".
- **AX-UX8 — Raw text where a picker belongs:** cron, the inbox ID, approver groups and service-account groups (AX-B3), and the scan banner pointing at JSON. *Recommendation:* a schedule builder (Daily / Weekly / Custom, timezone, next three runs), an inbox select with "Create new…", and the group multi-select from `GroupFormEditor`.
- **AX-UX9 — Destructive actions differ per page.** Projects block and list dependents. Skills and workflows use native `confirm()`. Uninstall shows "This will delete the files." without dependents. *Recommendation:* use the existing shared `ConfirmDialog` (`client/src/shared/components/ConfirmDialog.jsx`, already used by Agents, Projects and the workflow form page) on the Skills list, the Workflows list and Registries, which still call native `confirm()` (`AdminSkillsPage.jsx:108`, `AdminWorkflowsPage.jsx:95`, `AdminMarketplaceRegistriesPage.jsx:79`); make it name the object, list dependents and offer "Disable instead" (fixes AX-B13 and AX-B14).
- **AX-UX10 — Approvals are undiscoverable.** No sidebar entry, badge or Cmd+K entry, and no inline decision. *Recommendation:* see §6. Add inline Approve/Reject for simple approvals, with "Open run" as the secondary action. Show the approval detail in a drawer, as the marketplace already does for items.
- **AX-UX11 — Marketplace install is a dead end.** After installing a skill or workflow, only "View Skill" or "Set up integration" is offered (`MarketplaceItemDetail.jsx:268-292`). *Recommendation:* a "Next: grant to groups / add to app" toast with actions.

### UI designer

- **AX-UI1 — Five page shells in one part.**
  - H1 weight: `font-semibold` on Skills, Projects and Workflows; `font-bold` on Agents and Marketplace.
  - Content width varies from `max-w-7xl` to `max-w-3xl`, so going from Agents to Inboxes moves the left edge from x=300 to x=430.
  - Page backgrounds: `gray-900` vs `gray-950`.
  - Breadcrumb roots: "Overview >", "Admin >", plain-text "Marketplace /", and a "← Back" link.

  *Recommendation:* a new `AdminPageHeader` (breadcrumb, H1, subtitle, actions, help link). Adopt the existing `AdminEditPageShell` for the Skill, Project, Workflow, Agent and Inbox edit pages (none use it today).
- **AX-UI2 — Primary buttons in three colours.**
  - Indigo is used with three different radii.
  - **Blue-600** is used for Marketplace Install, "+ Add Registry", the project Test button (`AdminProjectDetail.jsx:118`) and the canvas Save.
  - Publish is **green-700**.
  - The project bulk bar uses four solid colours, and the marketplace files use `blue-` 26 times.

  *Recommendation:* migrate this part to the planned `AdminButton` (Roadmap 3B-3) first; it has the worst drift.
- **AX-UI3 — Three table implementations.** Skills, Inboxes, Registries and Executions hand-roll `<table>`. Action positions shift between rows (system skill rows show 2 icons, custom rows 4). Icon buttons have only a `title` (`AdminSkillsPage.jsx:479-536`). At 390 px the actions scroll off-screen. *Recommendation:* move them to `DataTable` with a kebab menu (`DataTableRowActions` already sets `aria-label`).
- **AX-UI4 — Badges, tabs, empty and loading states are hand-rolled, though shared components exist:**
  - at least 9 status badges, while `Badge.jsx` is used here only by `MarketplaceIntegrationFacts`;
  - three tab styles, while `AdminTabs` is unused here;
  - empty states that skip `AdminEmptyState` (which has no docs-link prop today, `AdminEmptyState.jsx:12`; add one);
  - four loading patterns, while `AdminPageSkeleton` is unused.

  *Recommendation:* use the shared components throughout.
- **AX-UI5 — The canvas chrome:**
  - text-xs buttons in three colours float over the canvas;
  - the header has only "← Back" and the "Chat integration" text link;
  - the status pill shows raw `workflow.status`;
  - zoom controls and minimap are white in dark mode.

  *Recommendation:* one header bar: name, status badge, secondary Auto-layout, Save, a split Publish, and "Test run". Theme the React Flow controls. Show an "open on a desktop" notice at 390 px.
- **AX-UI6 — The agent editor layout:** a single column of about 6,200 px with 15 equal cards. Schedule and Inbox are cards 9 and 10. Save is only at the top. *Recommendation:* `AdminEditPageShell` with a left-rail section index or tabs (Basics, Model & persona, Capabilities, Triggers, Advanced), a sticky Save, advanced cards collapsed, and `DualModeEditor` for JSON (fixes AX-B2).
- **AX-UI7 — Hierarchy slips.** The skill detail's rendered SKILL.md H1 (~30 px) outranks the page H1 (24 px). Name and display name both show "dashboard". The Projects Items-column pills wrap to three lines. Marketplace cards make "Replace local copy" (amber) the main call to action on about half the cards. *Recommendation:* an "Instructions" card with `prose-sm` and headings demoted one level; `whitespace-nowrap` kind icons with counts; an "Installed" badge on the card, with replace/update moved into the drawer.
- **AX-UI8 — Naming and icons.** H1s ("Skill Management", "Workflow Management", "Agent Profiles") differ from the sidebar labels. Agents and Models share the cpu-chip icon; Skills and Marketplace share sparkles. *Recommendation:* make the H1 equal the sidebar label; use a bot icon for Agents and a storefront for Marketplace.
- **AX-UI9 — Agent sub-pages each built differently.** Memory is a bare textarea with "Version 0". The run detail is a single column of 10 stacked h2 cards. Executions has six pastel tiles that do not filter. *Recommendation:* a Markdown editor with preview and a `ChangeHistoryDrawer` for memory; a two-column run detail (timeline | status, tokens, artifacts); status chips with counts instead of tiles.

### Technical writer

- **AX-TW1 — Agent form copy is developer-facing.** Rewrites are in §9. "knowledge sources" should be "projects", and "Create inboxes from Agents → Inboxes" should name the real button, "Manage Inboxes".
- **AX-TW2 — Terminology drifts on one screen.**
  - Agents: "Agents" (nav), "Agent Profiles" (H1, breadcrumb), "New Profile" (button), "New Agent Profile" (heading), "New Agent" (breadcrumb), "Agent Factory (V1)" (docs).
  - The approvals queue: "Pending Approvals" vs "Pending Approvals & Questions".
  - Inboxes: "Manage Inboxes", "Agent Inboxes", "Agents → Inboxes".
  - Export: "Export Skill", "Download Config", "Export".

  *Recommendation:* **Agent**, **Run**, **Approvals & questions**, **Export**; H1 = nav label.
- **AX-TW3 — Delete confirmations name neither the object nor the consequence.** Rewrites: `Delete the skill "{{name}}"? Apps that list it stop offering it. This cannot be undone.` and `Delete the workflow "{{name}}"? It disappears from the chat of {{count}} apps; past runs stay.` The model to follow is Projects: `Delete "{{name}}" and all of its items? This cannot be undone.`
- **AX-TW4 — Empty states that lie (AX-B9).** Rewrite: "Agent profiles could not be loaded. {detail} [Try again]", with no "Create your first…" call to action. Marketplace: show the error and do not suggest "Add Registry". Map 429 to "The server is busy — try again in N s", as report 01 proposes (SH-UX7).
- **AX-TW5 — Projects copy leaks internal values.**
  - `largeContextHint` uses the old mode names "always in the prompt" / "auto"; the UI labels are "Read everything" / "Automatic".
  - `tierPolicy.ifinderHelp` says `"both"`.
  - `sharing.permissionHint` names `"projectSharing"`.

  Rewrite of `largeContextHint`: "This project is larger than the ~{{budget}} tokens loaded into a prompt. With "Read everything" it fills the context window of every request; "Automatic" searches it instead."
- **AX-TW6 — Schedule time zone is unstated.** The editor treats the cron expression as UTC without saying so (`AdminAgentEditPage.jsx:213`). Today the schedule is discarded on save anyway (AX-B1); once that is fixed, an admin in Berlin who types `0 8 * * 1-5` would get 09:00 or 10:00 local time unless the field states or takes a time zone.
- **AX-TW7 — Skills and Workflows lack an "Install from Marketplace" shortcut.** Models has one (`AdminModelsPage.jsx:547`, `?type=model`). Add `?type=skill|workflow` links to both list headers and to the Skills empty state.
- **AX-TW8 — The docs IA doesn't mirror the admin.** In `SUMMARY.md`, Skills and Projects sit under Configuration, while Workflows, Marketplace and Agent Factory sit under Features among 40 pages. Searching "agent" in `/admin/docs` ranks `a2a-agents.md` first. *Recommendation:* an "AI Workspace" docs group.

### iHub admin

- **AX-AD1 — Projects are the model to copy.** Estimate tokens + Test + Try in chat + Used by + delete-in-use protection answered every "did it work?" question in T2. Copy them: "Try in chat with this skill" for skills, "Run test" for workflows, and "Dry run" for agents (checks that the model exists and is enabled, the inbox exists and the schedule parses).
- **AX-AD2 — Admin skill authoring.** Add **New skill** (the Library dialog) and **Create with AI** to Admin → Skills, writing a global skill directly. Let Promote list the admin's own private skills too, so a draft does not have to be shared before it can be promoted.
- **AX-AD3 — Fix the skill picker in the admin app editor.** Use the admin (global) skill list, or label the scope (Global / Mine / Shared) and dedupe by id (AX-B22).
- **AX-AD4 — Workflows need a built-in `input`.** The Start step should always expose a built-in `input` (the chat or run message) in every step's Variables tab. The unknown-name check should know it, and the run dialog should send the same name (AX-B12). Errors should name the step, the model's display name, and link to Admin → Models → Test (AX-B32).
- **AX-AD5 — Ask a Person:** require at least one option, or default to Approve/Reject (AX-B4). Add an "Approvers (groups)" field: the interaction model already has `policy.approverGroups` (`routes/runs.js:458`). Take the timeout in minutes or hours, not ms.
- **AX-AD6 — Agent list:** a real switch, a confirmation before disabling a scheduled agent, and Run disabled with "Enable the agent first" (AX-B23).
- **AX-AD7 — Registries:** run the connection test on Save; on failure offer "Save anyway (disabled)". Translate 502, DNS and TLS errors into operator language (proxy, SSL whitelist, certificate) with a docs link. Protect the shipped registry: "switch off" instead of delete, or add "Restore default registry" (AX-B14, AX-B15).
- **AX-AD8 — Agent inboxes:** a delete action, and one explanation of how the agent reads them (inbox detail "via read_inbox" vs agent form "no LLM tool calls involved").
- **AX-AD9 — Mark agent-internal workflows.** Show "Used by agent X" on embedded or generated workflows, and hide or flag them in the Workflows list (the "Claude-style Autonomous Agent" double).

## 6. What should be rearranged

1. **Regroup AI Workspace by task, not A–Z** (the 01 report resolved the same question as "task order"). Proposed:
   - **Build**: Apps, Projects, Skills, Prompts.
   - **Automate**: Workflows, Agents, **Runs & approvals**.
   - **Connect**: Models (with Providers), Marketplace.

   Reason: the five personas proposed four near-identical groupings. All of them separate the building blocks from runtime operations and from sources. A–Z puts Agents first and Workflows last.
2. **Create "Runs & approvals"** (one sidebar entry with a pending-count badge). Tabs:
   - **Pending** (approvals, questions, reviews, with inline decisions);
   - **Runs** (workflow and agent runs in one list, with a type filter);
   - **Failed**.

   Move Pending Approvals off the Agents header and `/admin/workflows/executions` into it, and point the orphaned `/admin/agents/runs` at it. Reason: the queue already serves workflows; one object should not have two lists. Add a non-admin **My approvals** page that reuses the same component (AX-B24).
3. **Make one workflow page.** Tabs **Design** (the canvas, default) · **Settings** (name, description, limits, triggers) · **Access & chat** (groups, chat integration) · **JSON** · **Runs**, with one unsaved-changes guard and one Save. "Create New Workflow" opens Design via the template picker. Rename the row action "Visual editor" to "Open", and drop the form-only "Edit". Reason: two half-editors with three save models and a data-loss link (AX-B6).
4. **Agents get tabs.** On the list: Agents · Inboxes (create and delete). On a profile: **Setup · Trigger · Knowledge & tools · Advanced · Runs · Memory**. Order inside Setup: Identity, Persona, Model, then Trigger (schedule/inbox) and Access (approvers, service account) *before* capabilities. Decomposition, Synthesizer, Review loop, Composer and Budgets move under Advanced. Reason: the two fields that make an agent run are cards 9 and 10 today.
5. **Skills:** put **New skill ▾** (Write it · Draft with AI · From marketplace) first; move Import (.zip) and Export into a ⋯ menu; turn the User-skills limits card into a Settings section. Keep the page title fixed ("User Skills" replaces it today).
6. **Projects:** move "Project settings" (user-project sharing, `ProjectSharingSettingsPanel`, `AdminProjectsPage.jsx:436`) into a header gear or Settings tab, renamed **User projects: sharing and limits**. Make **Add item** the primary action on the detail page, with Test, Estimate tokens, History and Try in chat as secondary actions.
7. **Workflows header order:** Upload Config · View Runs (secondary) · **New workflow** (primary, rightmost). Move Delete on the form header into an overflow menu.
8. **Add "Used by" cards everywhere** (Skill, Workflow, Agent) with **Add to app…**, so linking works from both ends.

## 7. Where another approach fits better

| Today | Proposed | Why |
|---|---|---|
| Free-text inbox ID, comma-text approver and service-account groups (`AdminAgentEditPage.jsx:1110-1330`) | Inbox select with "Create inbox…"; the group multi-select from `GroupFormEditor`/`ContentAccessSection` | Removes AX-B3 and AX-B17 by construction |
| Raw cron, UTC-only, never fires | The Scheduled Tasks schedule picker: presets, timezone, "next 3 runs" | One scheduler (AX-PM1); fixes AX-B1, AX-B21 and AX-TW6 |
| Agent JSON `<textarea>` that swallows parse errors | Shared `DualModeEditor`/`MonacoJsonEditor` with an error gutter (the workflow form already keeps `jsonText` separately) | Fixes AX-B2 |
| "Go to Admin → Apps → …" hints | `UsedByCard` with an inline "Add to app…" picker | Linking from both ends (AX-UX1) |
| Native `confirm()`/`alert()` for delete, uninstall and refresh | The existing shared `ConfirmDialog` naming the object and listing dependents, with "Disable instead"; inline error with `detail` | AX-B13–B15 |
| Approval only via "Open run" in the end-user UI | Inline Approve/Reject plus a detail drawer in the queue | Admins can answer without leaving the queue; the same component serves "My approvals" |
| Blank "New Workflow" metadata form | Template gallery → canvas with steps placed | Task 3 drops from ~25 steps on 4 pages to about 8 on 1 |
| A 15-card agent form for first-time creation | A wizard for new agents; a sectioned editor for existing ones | §8 |
| Six pastel stat tiles on Executions; four tiles on Projects | Status chips with counts that filter; a count subtitle ("5 projects · 5 enabled") | Tiles take a row and don't act |
| Marketplace refetches `?limit=1000` on every mount | Cached catalogue plus an "Updates (n)" tab backed by `/api/admin/marketplace/updates` | Load and maintenance (AX-B9, AX-PM5) |
| Agent memory textarea "Version 0" | Markdown editor with preview and `ChangeHistoryDrawer` | Memory is prose that agents rewrite |
| "Uploads are not scanned. Configure platform.projects.scan" | A scan toggle under Platform → Security, linked from the banner | No JSON for admins |

## 8. Wizards to add

**W1 — New agent** (all five personas; the highest value)
- *Starts:* "New agent" on `/admin/agents` (replaces "New Profile"). *Who:* an admin creating the first agents, rarely but with high stakes.
- *Steps:*
  1. **What it does:** name, description, persona; optional template ("Weekly research digest", "Inbox worker", "Monitor a source and report").
  2. **Model:** only enabled text models (AX-B8).
  3. **Knowledge & tools:** projects, skills, apps as tools, integrations, web search. If "apps as tools" is off, say "Switch on Apps as tools under Platform → Features" with a link.
  4. **When it runs:** Manually · On a schedule (the shared picker, with timezone) · From an inbox (select, or create inline, with one sentence on what an inbox is) · Webhook (URL and secret shown once).
  5. **Who approves and as whom it acts:** group multi-selects with plain sentences ("Runs as agent:weekly-digest with the permissions of group X").
  6. **Review & dry run:** the model is enabled, the inbox exists, the schedule parses and its next runs are listed; then "Run now", which opens the run page.
- *Creates:* the profile with shipped defaults for planner, synthesizer, review loop, composer and budgets. *Replaces:* the 15-card form as the creation path.

**W2 — New workflow from template** (PM, UX, UI, TW, admin)
- *Starts:* "New workflow" on `/admin/workflows`. *Who:* admins and power users building a first process.
- *Steps:*
  1. **Start from:** Blank · Summarise → Translate · Document analysis · Research with approval · From marketplace.
  2. **Inputs:** Start fields; the built-in `input` is always shown.
  3. **Steps:** an ordered list ("AI step: Summarise", "AI step: Translate into {{language}}"), each with a model, a prompt and an optional project. A mini preview shows the graph; "Open in canvas" handles branching.
  4. **Test run** with sample input and a step timeline.
  5. **Make available:** add to apps, grant groups (writes `permissions.workflows`), chat output format.
- *Validates:* unknown variables, Ask-a-Person steps without options, disabled models. *Replaces:* the metadata/JSON form as the entry point.

**W3 — New skill** (PM, UX, UI, TW, admin)
- *Starts:* "New skill" on `/admin/skills`. *Who:* admins who want a company procedure in several apps.
- *Steps:*
  1. Write it (the Library editor) · Draft with AI (`skill-builder`, `docs/skills.md:105-171`) · Upload .zip.
  2. Preview SKILL.md and files, then validate the frontmatter.
  3. **Readiness:** grant groups, add to apps, switch on skills in those apps.
  4. "Try in chat".
- *Creates:* a global skill directly. *Replaces:* the 18-step Library → share → Promote route.

**W4 — Add knowledge to an app** (admin, UX)
- *Starts:* the app editor's Projects section ("New project…"), and the banner shown after a project's first item is *Ready* ("Link it to an app so users can ask it").
- *Steps:* create the project → upload → Estimate tokens (shows the recommended mode) → link to apps → Try in chat.
- *Replaces:* 14 steps across two pages, and docs step 4 ("Link the project to apps…"), which has no affordance on the project page.

**Where a wizard would be wrong:**
- the **project detail page**, which already works and is used weekly;
- the **registry form**: enforce its existing Test Connection instead;
- **editing an existing agent**: a sectioned editor, not a replay of the wizard;
- the **workflow canvas** for power users with branching and loops;
- **marketplace browsing**.

Also do not put a wizard in front of Skills import for admins who already have a `.zip`: keep "Upload .zip" one click away.

## 9. Documentation

**What exists and its quality**

| Topic | Files | Quality |
|---|---|---|
| Projects | `docs/projects.md` (~1,440 lines, screenshots), `admin-ui.md:286` | Good: task-oriented with a "Who can use this project?" table. Too long without a quick start. The `write` flag is "not editable in the forms yet; set it in the JSON". |
| Marketplace | `docs/marketplace.md`, `admin-ui.md:302` | Good: teaches through the UI. Contradiction at :21 vs :41 (AX-B35). No Test Connection troubleshooting. |
| Skills | `docs/skills.md` | Good for users. The Admin section (:229-252) never says how to *create* a global skill. User-skill limits are taught as a `platform.json` block, although the tab has a form (`AdminUserSkillsTab.jsx:294-427`). |
| Workflows | `docs/workflows.md` (603 lines, 0 images) | Developer-first. Opens with "Loop containers" (:7). No first-workflow walkthrough, node reference, Run/test section, or Publish. Triggers are JSON-only (:514-524). Release-note phrasing ("until this release…", :538). Palette labels ("AI Step", "Ask a Person", "Repeat") differ from the documented types (`prompt`, `human`, `loop`). |
| Agents | `docs/agents.md` "Agent Factory (V1)" (0 images) | An engineering spec. Quick start step 1 edits `platform.json`. Uses JSON keys (`inboxId`, `dynamicTasks`) instead of form labels. Approvals are taught as `POST /api/runs/:runId/interactions/:id/answer` (:250). Promises a cron schedule that does not work (AX-B1). Has "Out of scope for V1", "Events" and "File layout" sections. |
| Concepts | `docs/concepts.md` | Good table, but no Workflow, Agent or Marketplace (:7-17, :81-89). The skill link goes to `architecture.md#skills-system` (:73), not `skills.md`. |
| Admin guide | `docs/admin-ui.md` | Has Projects and Marketplace sections; none for Skills, Workflows or Agents. |

German admins: the docs are English-only (no `docs/de`). State this in `admin-ui.md`.

**Gaps — tasks a new admin cannot learn today:** create a global skill; make a skill available in an app (three settings in two places); share an admin project with a group, or learn why it's impossible; build, run and test a first workflow; know the run's input variable; Save vs Publish vs Enabled; schedule a workflow from the UI (impossible); create and schedule an agent; answer an approval from the UI; find all runs; tell an app, skill, workflow, agent and project apart.

**Proposed pages and updates**
- `concepts.md`: add rows
  - "**Workflow** — a fixed multi-step procedure a person or an app starts. Admin → Workflows."
  - "**Agent** — a workflow that runs by itself on a schedule or from an inbox, with memory and approvals. Admin → Agents."
  - "**Marketplace** — where to get ready-made apps, skills, workflows…"

  Add decision rows: "Steps must run in a fixed order and the result is checked → Workflow"; "Work recurs without a person starting it → Agent"; "Know-how reused across apps → Skill"; "Facts and documents → Project". Fix the skill link.
- **New `workflows-getting-started.md` — "Build your first workflow":**
  1. New workflow on the canvas (or from a template).
  2. Start → AI step "Summarise {{input}}" → AI step "Translate {{summary}} into German" → End.
  3. The Variables tab and the built-in `input`.
  4. Save vs Publish vs Enabled.
  5. Run and follow the run.
  6. Runs: find, filter, read a failed step.
  7. Make it available in chat and grant groups.

  Screenshots at every step.
- **New `workflow-nodes.md`:** one row per node, with the palette label ↔ JSON type, purpose, key fields as labelled in the UI, output variable, and common mistakes (e.g. Ask a Person with no options).
- **`agents.md` rewritten as "Agents: an admin guide":** what an agent is (vs a workflow); create one with the form (Advanced collapsed); schedules (time zone!); inboxes; approvals & questions (answered in the UI); runs and run detail; memory; permissions (service account); troubleshooting (model not enabled, image model breaks the planner, timeouts and "Max wall time"). Move the engineering content to `agent-factory-internals.md` under Development.
- **`skills.md`:** "Create a global skill" (zip layout, frontmatter fields, an example) and "Make a skill available in an app" as a three-item checklist. Point user-skill limits to the form first.
- **`admin-ui.md`:** Skills, Workflows and Agents sections matching the Projects and Marketplace ones.
- **`projects.md`:** a five-minute quick start at the top and a FAQ line, "Limit an admin project to a group" (today: link it to an app only that group can use).
- **`marketplace.md`:** fix :21/:41 and add a Test Connection troubleshooting table (502/DNS/TLS → proxy and SSL whitelist).
- **`SUMMARY.md`:** an "AI Workspace" group with these five topics.

**Contextual help in the product.** No page in scope links to `/admin/docs`. Only the sidebar and the palette do, and the redesign brief's "Learn more →" was never built (`concepts/admin-redesign-2026/…Design Brief.md:274`). Add a `HelpLink` to every header and empty state. No such component exists yet; `client/src/features/admin/utils/docsLinks.js` (`docsLinkTarget`, :74-94) already resolves a docs path to its `/admin/docs/...` URL, so the component is small. Where each link goes:
- Skills header → `skills.md#admin`
- Skills empty state → `marketplace.md#skills-for-users`
- Workflow page → `workflows.md`, later `workflows-getting-started.md`
- Variables tab → `workflows.md#knowing-which-variables-exist`
- Chat integration → `workflows.md#chat-integration`
- Agent Trigger → the new Schedules section
- Approvals → the new section
- Project "Knowledge mode" → `projects.md#knowledge-modes`
- Token count → `projects.md#checking-a-project`
- Registries → `marketplace.md#registries`
- Trust for code → `marketplace.md#security`

**Help text to rewrite (current → proposed)**

| Where | Current | Proposed |
|---|---|---|
| Agent persona hint | "Do NOT include workflow instructions (read inbox / write artifact / mark done) — the runtime handles those automatically." | "Describe who the agent is and what it knows. Don't describe the steps (reading the inbox, saving results): iHub does those." |
| Agent capabilities hint | "Inbox and artifact lifecycle are owned by the runtime now, NOT exposed as LLM tools (… opt-in escape hatch)." | Delete it, or move it under Advanced. |
| Dynamic tasks | "At runtime the agent may call create_task() to enqueue work; a drain loop processes it FIFO until empty." | "The agent may add follow-up tasks while it works; they run one after another until none are left." |
| Apps as tools | "Requires the features.appAsTool flag to be ON." | "Switch on **Apps as tools** under Platform → Features first." (link) |
| Capabilities | "… apps and knowledge sources." | "… apps and projects." |
| HITL approvers | "HITL approver groups — Comma-separated group IDs." | Label "Who approves", with a group picker. |
| Schedule | "Optional cron expression." | "How often it runs. Times are in {timezone}." Presets plus the next three runs. |
| Inbox | "Optional. ID of the inbox… Create inboxes from Agents → Inboxes." | An inbox dropdown with "Create inbox…"; hint: "Work items people add here are picked up one at a time." |
| Variables in hints | "Available variables: ${$.data.currentInboxItem}…" | Insert chips, reusing the workflow Variables tab. |
| Skills subtitle | "Install, configure, and manage skills for your iHub Apps" | "Skills are reusable instructions an app can follow — for example, how to write a quote. Learn more" |
| Workflow JSON | "Changes here will override the metadata fields above." | Behind "View JSON": "Advanced: the full definition. Edits here replace the Settings tab on save." |
| Projects scan banner | "Configure platform.projects.scan to scan them" | "Uploads are not scanned for malware. Turn on scanning in Platform → Security." (link) |
| Project availability | (no group option) | Under "Linked apps only": "Reaches: groups X, Y (through app Z). To limit to a group, link it to an app only that group can use." |

## 10. Where the panel disagreed

1. **Where runs and approvals live.**
   - PM: an "Activity" area.
   - UX: a top-level Approvals item plus a unified Runs page near Overview or Observability.
   - UI: a tab strip on the Agents page.
   - TW: an AI Workspace-level item.
   - Admin: an "Automate" group.

   *Resolution:* one **Runs & approvals** entry inside AI Workspace › Automate (§6), with a badge. The Agents and Workflows pages deep-link into it, filtered. Non-admin approvers get **My approvals**, which reuses the same component. This combines PM's "out of admin for approvers" with the admin's "approve inline in admin".
2. **One workflow editor: drawer or tabs.** PM, UI and admin want the canvas with a settings drawer; UX wants a tabbed page. *Resolution:* tabs with the canvas as the default tab. Access and chat integration are full forms with their own help, and they fit a tab better than a drawer that covers the canvas. All five agree on one page, one guard and one Save.
3. **Project group sharing.**
   - PM and admin: add "Specific groups" to admin-project availability.
   - UX and TW: explain and show the inherited audience instead, since group reach already flows through the app.

   *Resolution:* do both, in order. First show "Reaches: groups X, Y (through app Z)" (S effort, honest today). Then add a group option, reusing `MEMBER_TARGET_TYPES` from user projects (M effort).
4. **Severity of the German gaps.** TW rated it P1; nobody else mentioned it. *Resolution:* P1. German is a primary market. About 320 English strings on three of five areas are visible on every page load in `de`, and the Projects and Marketplace pages prove the bar is achievable.
5. **Canvas styling severity.** UI rated the stray node frames P1; the admin rated them P3 ("cosmetic"). *Resolution:* P2. They are not data loss, but the edges loop and branch labels overlap, which makes graphs misreadable. The fix is S effort (register under a custom type).
6. **Executions page:** admin 4, the others 3. The admin valued the working counters and filters; the others weighed the off-shell detail page and the duplicate list. *Resolution:* keep the counters as filter chips and fold the page into Runs & approvals.
7. **Sidebar grouping labels:**
   - PM: Build / Source / Operate.
   - UX: Build / Configure / Get content.
   - Admin: Build / Knowledge / Automate / Get more.

   *Resolution:* Build / Automate / Connect (§6), consistent with report 01's "task order" resolution.

**Factual conflicts the lead settled:**
- **The Groups column:** PM said it shows "users, admin"; UX said every row reads "—". Both are right: 17 rows are empty, `research-assistant` shows "users, admin", and neither value is the enforced rule (AX-B10).
- **Publish:** PM said "no effect"; TW said it "writes a version snapshot". Both are right: the snapshot is written to `.history` and never read (AX-B11).
- **New workflow on the canvas:** TW said "only after the first save"; UX said `/admin/workflows/new/edit` exists. Both are right: the route exists but is linked only from the end-user page.
- **Run-detail crash:** UI's suspected crash does not happen; the server localizes the labels (§4 note).

## 11. Top recommendations

| # | Recommendation | Why | Impact H/M/L | Effort S/M/L | Type |
|---|---|---|---|---|---|
| 1 | **Agent editor fixes:** register agent schedule triggers with the scheduler (or move them to the Scheduled Tasks picker with timezone and next runs) and correct `agents.md`; replace the comma fields and the inbox field with group and inbox pickers; use `DualModeEditor` for JSON; show only enabled text models; validate cron | Four confirmed P1/P2 defects: a scheduled agent never runs, approvals reach nobody, typed JSON is lost, runs fail (AX-B1–B3, B8, B17, B21) | H | M | fix |
| 2 | **Unstick approvals:** require options in Ask a Person (default Approve/Reject); fix the `[object Object]` binding; cancel a run's interactions when it is cancelled; inline Approve/Reject; non-admin "My approvals" with a badge and a notification | Approvals can be stuck, unanswerable, stale, or invisible to the approvers they are meant for (AX-B4, B5, B16, B24) | H | M | fix |
| 3 | **Workflow quick fixes:** unsaved-changes guard on the canvas; register nodes under a custom React Flow type; a built-in `input` used by chat and the dialog; the Groups column computed from `permissions.workflows`; hide Publish until it means something; step and model names in errors | Data loss and misreadable or misleading screens, all S effort (AX-B6, B10–B12, B20, B32) | H | S | fix |
| 4 | **Translate Skills, Workflows and Agents:** move the ~320 inline strings (plus AgentRunsPage and Approve/Reject) into `en.json`/`de.json`, apply the §9 copy rewrites at the same time, and add a CI check that every `t('admin.…')` key exists in both | Three of five areas are English-only in German (AX-B7, AX-TW1) | H | M | fix/docs |
| 5 | **Honest states and shared components:** error ≠ empty on every list (never offer "Create first…" or "Add Registry" after a failed load); keep the header on error; switch skill/workflow delete, uninstall and registry delete from native `confirm()` to the existing `ConfirmDialog`, naming the object and listing dependents; replace `alert()` with an inline `detail`; registry Save after a failed test → "Save anyway (disabled)" | Failed loads invite duplicates; an unnamed confirm deleted the shipped registry in this review (AX-B9, B13–B15, B28) | M | S | fix/UX |
| 6 | **Docs that teach this part:** Workflow, Agent and Marketplace rows in the mental-model table and the existing decision guide of `concepts.md` (:7-16, :81-88); rewrite `agents.md` as an admin guide; add `workflows-getting-started.md` and `workflow-nodes.md`; Skills/Workflows/Agents sections in `admin-ui.md`; "Learn more" `HelpLink`s on every header and empty state | Task 6 failed for all five; no page links to the docs (§9) | H | M | docs |
| 7 | **Admin skill authoring + Used by everywhere:** New skill (write / draft with AI / from marketplace) in Admin → Skills; a shared `UsedByCard` with "Add to app…" and a readiness checklist on the Skill, Workflow and Project pages; a deduped admin skill picker | T1 takes 18 steps via a workaround; linking is one-way (AX-AD2, AX-UX1–2, AX-B22) | H | M | UX/wizard |
| 8 | **Runs & approvals + IA cleanup:** one entry with a badge (Pending, Runs, Failed) merging workflow executions and agent runs; regroup AI Workspace as Build / Automate / Connect; one vocabulary (Agent, Run, Approvals & questions, H1 = nav label); Agents/Workflows in Cmd+K | Operations are hidden under build pages; two lists of one object; orphaned routes (AX-PM3, AX-UX6, AX-TW2, AX-B31) | M | M | IA |
| 9 | **One workflow page with a test run and templates:** canvas as the default tab, then Settings, Access & chat, JSON and Runs tabs; one Save; a Test-run drawer with a live step timeline; the New-workflow-from-template wizard (W2); trim the shipped examples to four templates | Two half-editors and no test loop; task 3 takes ~25 steps on 4 pages (AX-UX3–5, AX-PM6) | H | L | UX/wizard |
| 10 | **New-agent wizard + sectioned editor:** W1 with a dry run, then a tabbed editor with Trigger and Access near the top and the runtime prompts under Advanced; adopt `AdminEditPageShell`, `AdminButton`, `DataTable`, `Badge`, `AdminTabs`, `AdminEmptyState` across this part | The agent editor scored 1/5 from everyone; this part has the worst visual drift (AX-PM2, AX-UX7, AX-UI1–6) | H | L | wizard/UI |

## Appendix — verification log

| Claim | Source | Check | Result |
|---|---|---|---|
| The agent schedule never fires | PM | Read `handleCronSchedule`, `workflowTriggerSource.js` (`trigger.id` and `trigger.cron` required; reads `configCache.getWorkflows`), `worker.js:567`. Grepped `server/agents`, `routes/agents` and `configCache.js` for any reader of profile triggers | Confirmed: none exists |
| Comma fields | UX | `lead/check.js` typed `agent-operators,admins` on `/admin/agents/new` | Confirmed: `agent-operatorsadmins` |
| JSON mode drops input | UX | Code at `AdminAgentEditPage.jsx:372-382` | Confirmed |
| Groups column ("users, admin" vs "—") | PM vs UX | Read all 18 workflow files plus `groups.json`; live row text | Both right; no group grants `permissions.workflows` |
| Publish has no effect vs writes a snapshot | PM vs TW | `workflowRoutes.js:1916-1962`; grepped for readers of `status` / `historyDirFor` | Both right; nothing reads either |
| Visual editor only after first save vs `/new/edit` exists | TW vs UX | `AdminWorkflowEditPage.jsx:330`; `App.jsx:533` | Both right |
| Run detail crashes on localized labels | UI (suspected) | `HumanNodeExecutor.js:347-357` resolves labels | Not a defect |
| Input variable `message` vs `input` | admin | `StartWorkflowModal.jsx:470`; `PromptNodeExecutor.js:954`; `docs/workflows.md:276-278` | Confirmed |
| Zero-option approval stuck | admin | `HumanCheckpoint.jsx:255`; executor returns `[]` for `options: []` | Confirmed |
| Stale approval after cancel | lead | `lead/pend.js`: `/api/interactions/pending` returns the checkpoint of the aborted run `wf-exec-8bc1be82`; the queue page lists it (`lead/approvals.png`) | Confirmed (new) |
| Non-admin approver queue | PM | `routes/runs.js:436-470` is `authRequired` with approver-group filtering; the only client is the admin page | Confirmed |
| Inbox delete missing | admin | `agentInboxes.js` routes: GET, GET, PUT, POST, POST | Confirmed |
| Missing i18n keys | TW | Lead regex count: AgentEdit 99/104, Workflows 29/29, Skills 23/35, Agents 25/29, Projects 1/41, Marketplace 0/16 | Confirmed (small count differences from the regex) |
| The official registry is restored | admin | `GET /api/admin/marketplace/registries` | `ihub-official`, enabled, 373 items |
| Marketplace false empty state | PM, UX, TW | Code at `AdminMarketplacePage.jsx:91-98`; live with the limit lifted the page renders items, so the empty state appears only on failure | Confirmed (failure-path only) |
| Dark mode on admin cold load | UI | Already SH-B9 in report 01 | Cross-referenced, not re-counted |
| Default greeting written on app save | admin | Already AI-PM4 in report 02 | Cross-referenced |

### Adversarial verification

A second pass tried to refute every §4 row, checked §8 and §11 against the code for work that already exists, and checked the §9 doc gaps against `docs/`. Scripts: `verify/tkeys.mjs`, `verify/live.js` in the part's scratch folder. Live checks created one entity (`zz-skills-projects-workflows-agents-marketplace-verify`, an agent profile, disabled) and deleted it (204).

**Verdicts per §4 row**

| ID | Verdict | How |
|---|---|---|
| AX-B1 | Confirmed, stronger | Live: POST a profile with a schedule trigger, GET it back → `workflow.definition.triggers` undefined. `serializeProfile()` (`profileWorkflowSerializer.js:919-956`, called at `routes/admin/agents.js:194,224`) rebuilds the embedded definition; it has no `triggers`. Row rewritten. |
| AX-B2 | Confirmed, narrowed | Live: `,"x":1` dropped; typing inside the `id` string kept. Title changed from "cannot be typed in" to "drops every structural edit". |
| AX-B3 | Confirmed | Live: `agent-operators,admins` → `agent-operatorsadmins`. |
| AX-B4 | Confirmed | Code: `_resolveOptions([])` returns `[]`; an `approval` checkpoint is not a question (`interactionToCheckpoint.js:78`), so `canSubmit` needs an option. |
| AX-B5 | Confirmed | Code `HumanForm.jsx:64`; screenshot `ui/shots/light-dlg-wf-node.png` shows `[object Object]` ×3. |
| AX-B6 | Confirmed | No `useUnsavedChanges`/`useBlocker`/`beforeunload` in `WorkflowEditorPage.jsx` or `features/workflows/editor/`. Line refs corrected (195, 226-237). |
| AX-B7 | Confirmed | `verify/tkeys.mjs`: AgentEdit 99/104, Workflows 29/29, Skills 23/35, Agents 25/29, Executions 29/30, Inboxes 12/14 missing in both `en.json` and `de.json`; Projects 1/41, Marketplace 0/16. `AgentRunsPage.jsx` has no `useTranslation`. |
| AX-B8 | Confirmed | Live: all 3 disabled models offered in the picker. |
| AX-B9 | Confirmed | Code: Projects renders the error banner and the "No projects yet" empty state together; Agents likewise; Marketplace catches registry and item errors silently. Line refs extended. |
| AX-B10 | Confirmed | Live row text: 17 rows "—", `research-assistant` "users admin". No group in `groups.json` has `permissions.workflows`; `workflowAccess.js:29-44` uses only that. |
| AX-B11 | Confirmed | Only reader of `status` is the canvas pill (`WorkflowEditorPage.jsx:209`); nothing reads `.history`. |
| AX-B12 | Confirmed | `findUnknownReferences` treats only loop and `_engine` names as built-in (`workflowEditorUtils.js:871`); `input` is not among them. |
| AX-B13 | Confirmed | No usage check in skill/workflow delete; uninstall checks only integration instances (`ContentInstaller.js:1028-1038`). |
| AX-B14 | Confirmed | `en.json:2734` has no `{{name}}`, so the fallback text with the name never shows. |
| AX-B15 | Confirmed | `alert(err.message)` at `:66`; `RegistryFormDialog.jsx:163-184` saves regardless of the test result. |
| AX-B16 | Confirmed | Live: `/api/interactions/pending` still returns `ckpt-a91feef1…` for the `aborted` run. |
| AX-B17 | Confirmed | Live: inbox list `{"items":[]}`. |
| AX-B18 | Confirmed | Live: `DELETE /api/admin/agents/inboxes/<zz id>` → 404 (no route). |
| AX-B19 | **Refuted, removed** | The banner branch runs only when the response has no `executionId`, but the trigger route's only success response is `202 { executionId, status, profileId }` (`server/routes/agents/runs.js:372`); the admin's own T4 run navigated to the run page. Dead defensive code, not a user-visible defect. The §2 "Agents list" sentence was removed too. |
| AX-B20 | Confirmed | `nodeTypes = { default: WorkflowNode, … }` (`WorkflowEditor.jsx:41`); no CSS override for `.react-flow__node-default`/controls/minimap anywhere in `client/src`. Screenshot confirms. |
| AX-B21 | Confirmed | `handleCronSchedule` writes any string with `timezone:'UTC'`; schema `triggers: z.array(z.any())`. Note added that the server discards it anyway (AX-B1). |
| AX-B22 | Confirmed | `SkillsSelector.jsx` uses the user `fetchSkills()` and keys by `name`; screenshot `admin/shots/t1-app-skill-search.png` shows the same skill three times. |
| AX-B23 | Confirmed | Run action has no `disabled`. Line refs corrected. |
| AX-B24 | Confirmed | Only client of `fetchPendingInteractions` is `AdminAgentApprovalsPage.jsx:45`; no notify channel is wired to raised interactions. |
| AX-B25 | Confirmed, wider | Live: 22 of 27 inputs/selects on `/admin/agents/new` have a 0 px border (Tailwind v4 preflight; no `@tailwindcss/forms`). Line refs corrected. |
| AX-B26 | Confirmed | `AdminAgentEditPage.jsx:349,364`: `border bg-white` with no `dark:` classes. |
| AX-B27 | Confirmed | `RegistryFormDialog.jsx:188`: plain `div` with `max-h-[90vh] overflow-y-auto`; no `role`, Escape or focus trap. The footer can be reached by scrolling inside the dialog, so "cut off" means "below the fold", not unreachable. |
| AX-B28 | Confirmed | Early `return <AdminLoadError/>` at the cited lines. |
| AX-B29 | Confirmed | Live label text `Name**`. |
| AX-B30 | Confirmed | `en.json:5282` `"itemCount": "{{count}} items"` without `_one`. |
| AX-B31 | Confirmed | No `navigate`/`href` to `/admin/agents/runs` (only to `/runs/:id`); `ADMIN_PAGES` and `TYPE_ROUTES` have no Workflows/skill/workflow/agent entries. |
| AX-B32 | Confirmed | `SkillsSelector.jsx:202` "this app" is shared with the agent editor; `WorkflowEngine.js:1229` "Node ${nodeId} failed". |
| AX-B33 | Confirmed, path fixed | The slug cut is client-side: `client/src/features/admin/utils/projectAdmin.js:43,237`, not `server/routes/admin/projectAdmin.js` (no such file). |
| AX-B34 | Confirmed (screenshots) | `ui/shots/m-sheet1.png`, `m-sheet3.png` exist; header at `AdminAgentsPage.jsx:209` is `flex justify-between` without wrap. |
| AX-B35 | Confirmed, line fixed | `docs/marketplace.md:21` vs `:38` (not :41). |
| AX-B36 | Suspected → Confirmed | `StartWorkflowModal.jsx:340-350` has no `role="dialog"`, `aria-modal` or Escape handler. |

**Cross-reference fixes:** T2 pointed at AX-B36 for the slug cut (now AX-B33); T3 pointed at AX-B35 for the leaked provider name (now AX-B32). §2 "Pending Approvals": "Open run" leaves the admin area only for workflow runs; agent runs open the admin run page (`AdminAgentApprovalsPage.jsx:62-68`). AX-PM6: 18 workflows ship, 16 enabled (live list), not "18 enabled".

**§8 wizards and §11 recommendations: already implemented?** None of W1–W4 exists: no wizard component under `features/admin` for agents, workflows, skills or app knowledge; no template picker in `WorkflowEditorPage`/`AdminWorkflowEditPage`; no "New skill" on `AdminSkillsPage`; no "New project…" in `ProjectsConfigSection`. For §11 nothing is already done, but some recommendations named building blocks as if new, and they exist:
- `ConfirmDialog` (`client/src/shared/components/ConfirmDialog.jsx`) exists and is already used by Agents, Projects, the workflow form page and run detail. AX-UX9, the §7 row and §11 #5 now say to move the remaining native `confirm()` calls to it.
- `DualModeEditor`, `MonacoJsonEditor`, `AdminEditPageShell`, `AdminTabs`, `AdminEmptyState`, `AdminPageSkeleton`, `ChangeHistoryDrawer`, `Badge`, `useUnsavedChanges` exist; none is used by the in-scope pages (grep), so "adopt/reuse" stands.
- `AdminButton`, `HelpLink`, `UsedByCard` do not exist. §9 no longer implies `docsLinks.js:93` provides a `HelpLink`; it provides `docsLinkTarget()`. AX-UI4 no longer says `AdminEmptyState` has a docs link (it has no such prop).
- `concepts.md` already has a decision guide (:81-88); §11 #6 now says "add rows" instead of "add a decision table".
- No scan UI for `platform.projects.scan`, no approvers field or minutes/hours timeout in `HumanForm.jsx`, no client caller of `/api/admin/marketplace/updates`, no Workflows/Skills `?type=` marketplace shortcut (only `AdminModelsPage.jsx:547`). `docs/releases/next/` has no entry covering any of these.

**§9 doc gaps:** all confirmed. `concepts.md:7-16` has no Workflow/Agent/Marketplace row and links Skill to `architecture.md#skills-system` (:73); `workflows.md` is 603 lines with 0 images and opens with "Loop containers" (:7), triggers are JSON-only (:512-524), release phrasing at :536-537; `agents.md` has 0 images, quick start edits `platform.json` (:30) and teaches approvals via `POST …/answer` (:22, :247-250); `skills.md` "Admin" (:229-292) has no create-a-global-skill section and teaches user-skill limits as a `platform.json` block although `AdminUserSkillsTab.jsx` has the form; `admin-ui.md` has `## Projects` (:286) and `## Marketplace` (:302) but no Skills/Workflows/Agents section; `docs/de` does not exist; no in-scope admin page links to `/admin/docs`.
