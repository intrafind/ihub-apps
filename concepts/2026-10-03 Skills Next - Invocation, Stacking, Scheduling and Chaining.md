# Skills Next: Invocation, Stacking, Scheduling and Chaining

**Date:** 2026-10-03
**Status:** Proposal; decisions 1 and 3 taken (§6). Phase 0 is in #2670
**Related:** `concepts/2026-02-22 Agent Skills Integration PRD.md` (original skills PRD), `docs/scheduled-tasks.md`, marketplace PR "Everyday skills and Google's open-source skills" in `intrafind/ihub-marketplace`

## 1. Why now

The market is converging on skills as the main way to package repeatable know-how for AI assistants:

- **Google** launched *Gemini skills* on 30 Sep 2026, replacing Gems. Skills are invoked with `/` (`@` announced), can be stacked in one task, carry reference files, are picked automatically from intent, can be created through a chat interview, and run in the background through Gemini Spark schedules. Existing Gems migrate automatically (personal accounts from Nov 2026; Workspace business, enterprise and nonprofit accounts no sooner than Mar 2027; Workspace education accounts no sooner than Jun 2027). Workspace adds templated "on-brand" skills and admin-curated organizational skills ("coming soon").
- **The format is shared.** Gemini accepts uploaded `SKILL.md` files and enforces the same naming and 1,024-character description rules as the Agent Skills specification (agentskills.io). Anthropic (Claude), OpenAI (ChatGPT/Codex), Gemini CLI and Gemini Enterprise all read the same format.
- **Google publishes skills as open source** (Apache-2.0): `google/skills` (150 developer and cloud skills), `google-gemini/gemini-skills` (3 Gemini API skills). The consumer premade skills (`/prep-for-meetings`, `/match-my-writing-style`) are not published as files.

iHub already speaks this format, so the gap is not the file format but what the platform does with skills. This document maps that gap.

## 2. What iHub does today

All of it sits behind the `skills` feature flag (preview, off by default, `server/featureRegistry.js`).

| Capability | iHub today | Evidence |
|---|---|---|
| Format | Agent Skills spec: folder with `SKILL.md` (YAML frontmatter `name`, `description`; optional `license`, `compatibility`, `metadata`, `allowed-tools`) | `server/services/skillLoader.js` |
| Assign to apps | `app.skills: string[]`; `<available_skills>` (name + description) is added to the system prompt | `server/services/PromptService.js` (skills block), `configCache.getSkillsForApp` |
| Automatic recognition | Model-driven: `activate_skill` loads the body, `read_skill_resource` reads files | `server/toolLoader.js` (`activate_skill`, `read_skill_resource`) |
| Explicit invocation | `/` in an **empty** chat input opens the prompt/skill picker; picking a skill **sends immediately** a fixed message with `requestedSkill`, which pre-loads the body into the system prompt for that one request | `client/src/features/chat/components/ChatInput.jsx`, `client/src/features/apps/pages/AppChat.jsx` (`handleSkillSelect`) |
| Stacking | Not for explicit invocation (`requestedSkill` is a single string). The model can call `activate_skill` several times | `server/validators/index.js` (`requestedSkill: z.string()`) |
| Persistence across turns | `requestedSkill` applies to one request; the next turn has no `<active_skill>` block | `PromptService.processMessageTemplates` |
| Reference files | `references/`, `scripts/`, `assets/` (top level only), read as UTF-8 text; scripts are never executed | `skillLoader.getSkillContent`, `getSkillResource` |
| Authoring | Admin: list, view metadata, delete, validate, export zip, import zip (one top-level folder, 10 MB). No editor, no create/update endpoint | `server/routes/admin/skills.js` |
| Permissions | Group `permissions.skills` with inheritance; per-skill group access in admin | `server/utils/authorization.js`, `server/routes/admin/contentAccess.js` |
| Marketplace | Install from registries; `url` sources can bring companion files; Claude plugin `marketplace.json` registries are understood | `server/services/marketplace/ContentInstaller.js`, `RegistryService.js` |
| Agents | Agent profiles have `skills`; the planner can pre-activate skills (`skills_used`, `activate_then_replan`); activated skills persist in run state as `<active_skill>` | `PlannerNodeExecutor.js`, `PromptNodeExecutor._buildSkillsBlock` |
| Scheduled tasks | Tasks run a prompt against an app; that app's skills are available, but a task cannot name a skill | `server/services/scheduler/tasks/taskModel.js`, `taskExecution.js` |
| Workflows | No skill node; plain workflows get no `<available_skills>` | `server/validators/workflowConfigSchema.js` |
| MCP | Skills as MCP resources (`ihub://skill/<name>`), text files only, opt-in | `server/services/mcp/resourceAdapter.js` |
| UI feedback | Purple "skill activated" chips on the message; agent run detail shows activations | `client/src/features/chat/components/ChatMessage.jsx`, `client/src/features/admin/pages/AgentRunDetailPage.jsx` |
| Analytics | None beyond generic tool events | `server/telemetry/events.js` |

### Side by side with Gemini skills

| Gemini skills | iHub | Gap |
|---|---|---|
| `/` invocation anywhere in the prompt, combined with own text | `/` only in an empty input; sends a canned message; no own text | **G1** |
| Stack several skills in one task | One explicit skill per message | **G1** |
| Automatic use of enabled skills | Yes (model-driven) | — (needs authorization fix, §3) |
| User turns skills on/off for automatic use | No per-user control; admin assigns to apps | **G6** |
| Reference files: Markdown, PDFs, images, folders (100 MB) | Text files only, top-level listing, binary corrupted on marketplace install | **G7** |
| Create with Gemini (interview), templates, manual editor, upload | Zip import only; editor buttons call endpoints that don't exist | **G5** |
| Personal skills, sharing (coming) | Admin-managed only | **G6** |
| Skills reference other skills | Possible in prose only; no declared dependencies | **G4** |
| Background and scheduled runs (Spark, Workspace Flows) | Scheduled tasks exist, but cannot target a skill | **G3** |
| Admin-curated org skills, gallery | Marketplace + group permissions (stronger than Gemini today) | — |
| Gems → skills migration | No "convert prompt to skill" path | **G5** |

## 3. Fix first: bugs found during the review

These are defects in what already exists. They should be fixed before building on top.

| # | Problem | Where | Impact |
|---|---|---|---|
| B1 | **`activate_skill` and `read_skill_resource` do not check access.** Once an app has any skill, the model can load *any* installed skill by name, regardless of `app.skills` and the user's `permissions.skills`. A user can simply ask for another skill by name. | `server/toolLoader.js` (`runTool`, `activate_skill` / `read_skill_resource` branches) | Bypasses skill permissions |
| B2 | **`requestedSkill` is not checked.** Any request can name any installed skill and get its body pre-loaded, even on apps with no skills. | `server/services/PromptService.js` (pre-activation block) | Bypasses skill permissions |
| B3 | **Empty skill permissions fail open.** `getSkillsForUser` only filters when `permissions.skills.size > 0`; a signed-in user whose groups grant no skills sees all skills when anonymous access is off. Apps and tools filter on an empty set. | `server/configCache.js` (`getSkillsForUser`) | Users see and use skills they were never granted |
| B4 | **Agents never receive `activate_skill`.** `PromptNodeExecutor` adds the tool id, but `getAgentTools` builds the app config without `skills`, so `getToolsForApp` creates no skill tools. Only planner pre-activation works. | `PromptNodeExecutor.getAgentTools`, `toolLoader.getToolsForApp` | Agent skills mostly inert |
| B5 | **Agent skill filtering is a no-op.** `_buildSkillsBlock` filters with a user object without permissions and reads `getPlatform()?.data`, which doesn't exist. | `PromptNodeExecutor._buildSkillsBlock` | No permission filtering for agents |
| B6 | **Admin edit and enable toggle are broken.** The client calls `PUT /api/admin/skills/:name` and `POST /api/admin/skills/:name/toggle`; neither route exists. | `client/src/api/adminApi.js` (`updateSkill`, `toggleSkill`), `server/routes/admin/skills.js` | Admin UI actions fail |
| B7 | **Custom skills directory only half works.** `platform.skills.skillsDirectory` is used for discovery but not when loading bodies or resources. | `toolLoader.js`, `PromptService.js` (calls without `customDir`) | Skills listed but not loadable |
| B8 | **Unused settings.** `skillSettings.maxActiveSkills`, `skillSettings.autoActivate` and `platform.skills.maxSkillBodyTokens` are in schema and docs but never read. | `appConfigSchema.js`, `docs/apps.md`, `V003__skills-config.js` | Documented controls do nothing |
| B9 | **Minor:** skill names and descriptions are inserted into the prompt without XML escaping; the activation event always has an empty `description`; companion files are fetched with `res.text()`, which corrupts binary files; `compatibility` is a string in the loader but an object in the admin UI. | various | Robustness |

Proposed rule for B1–B3, applied in one shared helper (for example `configCache.isSkillUsable(name, { app, user })`): a skill may be loaded only if it is (a) installed, (b) listed on the app (or agent profile / node), and (c) granted to the user's groups. Once personal skills exist (G6), a user-owned skill is the one exception to (b): it may be loaded without an assignment entry when the platform allows personal skills (`platform.userSkills.enabled`), the app does not opt out (`skillSettings.allowPersonal: false`) and the skill's owner or shares authorize the user (the owner, a user or group it is shared with, or everyone signed in). `activate_skill`, `read_skill_resource`, `requestedSkill`, every entry of `requestedSkills[]` (G1, including the OpenAI-compatible API in G10), sticky re-injection (G1), scheduled runs (G3), the planner's pre-activation, the MCP resource adapter, and MCP `prompts/list` and `prompts/get` (G10) all call the same helper: `prompts/list` returns only permitted skills, and `prompts/get` checks access again before returning a skill body.

## 4. Gaps and proposals

### G1 — Invoke skills explicitly, combine them, keep them active

**Today:** `/` only works in an empty input, sends a canned message immediately, supports one skill, and forgets it on the next turn. That breaks multi-turn skills: an interview skill (for example the marketplace's `skill-builder`) loses its instructions as soon as the user answers the first question, unless the model happens to re-activate it.

**Proposal:**

1. **Skill chips in the input.** Typing `/` anywhere opens the picker; choosing a skill inserts a removable chip (`/match-my-writing-style`) and keeps the cursor in the input, so the user adds their own text. Several chips are allowed (stacking).
2. **API:** `requestedSkills: string[]`, a clean break from `requestedSkill` without an alias (decided, implemented in #2670 together with the access check and the `maxActiveSkills` cap).
3. **Sticky activation per chat.** Explicitly invoked skills are stored on the chat (`chat.activeSkills`) and re-injected as `<active_skill>` on every turn until the user removes the chip or starts a new chat. Before each injection the shared access check runs again; a skill that no longer passes (grant revoked, removed from the app, uninstalled) is left out and its chip shows why. Model-activated skills are added to the same list (so they persist too), shown as chips the user can remove.
4. **Limits.** Enforce `skillSettings.maxActiveSkills` (default 3) and a token budget per active skill (`platform.skills.maxSkillBodyTokens`). If the budget is exceeded, inject the description plus a note to read the body with `activate_skill` instead of failing.
5. **Precedence.** When several skills are active, inject them in the order chosen and add one line: *"Several skills are active. Follow all of them; where they conflict, the skill listed first decides, unless a skill states its own precedence."* Skills can state their own precedence in prose (the new marketplace skills do: "the other skill decides content, this one decides wording").
6. **Keyboard:** `/` for prompts and skills (as today), `@` stays for workflows. Gemini will move to `@`; we keep `/` because `@` is taken and users already know it from the prompt library.

### G2 — Let users control automatic use

Gemini lets users switch individual skills on and off for automatic use. In iHub, admins assign skills to apps, and every assigned skill is always offered to the model.

**Proposal:** a "Skills" menu in the chat header listing the app's skills with a toggle each ("use automatically"), stored per user and app. Disabled skills can still be invoked with `/`. This also helps when an app has many skills and the model picks the wrong one.

### G3 — Skills in scheduled tasks

**Today:** a scheduled task runs `instructions` against an app. The app's skills are available, but the task cannot name one, so the model must guess from the instructions.

**Proposal:**

1. **`skills: string[]` on the task** (validated against the app and the owner's permissions at save time and again at every run, like tools; a revoked skill pauses the task with a stored reason, as revoked tools do today).
2. Each run pre-activates those skills (the same `requestedSkills` path as G1), so a task like *"Every weekday 07:30, run `/inbox-triage`"* behaves the same every time.
3. **"Schedule this skill"** entry point: from a skill chip or the skill picker, open the task form with app and skill pre-filled.
4. **The chat tools learn it too:** `schedule_task` and `update_scheduled_task` accept `skills`, so the user can say "run the newsletter skill every Friday at 10".
5. **Optional skill metadata for unattended use:** skills can declare `metadata.ihub.unattended: supported` and a short `metadata.ihub.scheduleHint` ("weekly, Friday morning"). The task form shows the hint; skills without the flag show a warning that they may ask questions. The run already tells the model it is unattended and refuses `ask_user`; skills written for scheduling (such as the marketplace's `newsletter-composer` and `inbox-triage`) include a "Running on a schedule" section.
6. **Workflow schedule triggers** get the same: a workflow prompt node can pre-activate skills (see G4).

### G4 — Chain skills

"Chaining" covers three different needs:

| Need | Example | Proposal |
|---|---|---|
| A skill relies on another skill | `newsletter-composer` applies `brand-voice-framework` | **Declared dependencies**: `metadata.ihub.requires: [brand-voice-framework]`. When the skill is activated, required skills that the app and user may use are activated with it; missing ones are reported to the model ("required skill not available"). Validation warns admins at assignment time. |
| Output of one skill feeds the next | research brief → executive email → translation | **Skills in workflows**: a prompt node gets `skills` (offered) and `activeSkills` (pre-activated) for *all* workflows, not only agent runs. Chains are then normal workflows with human checkpoints where needed. A dedicated `skill` node (input → skill → output) is sugar on top of a prompt node. |
| The model decides the order | "prepare the board talk and stress-test it" | Already possible with stacking (G1) once activation persists; agents get it once B4 is fixed. |

Order of work: B4/B5 (agent wiring) → `activeSkills` on prompt nodes → `requires` → optional `skill` node.

### G5 — Author skills in iHub

**Today:** zip import only. Most users who would write a skill never touch a zip file.

**Proposal, in steps:**

1. **Fix B6 and add a real editor:** create, edit and preview `SKILL.md` (frontmatter form + Markdown body), add and edit reference files, validate live (name rules, 1,024-character description).
2. **"Create with AI":** the marketplace now ships `skill-builder`, an interview skill that produces a valid `SKILL.md`. Make it native: a "New skill → create with AI" button opens a chat with that skill active and a "Save as skill" action on the result.
3. **"Save as skill" from any chat:** turn the current conversation's instructions into a skill draft (the Gemini "Gemini offers to build skills from your chats" pattern).
4. **Convert prompts to skills:** a prompt library action that creates a skill draft from a prompt, its variables and description. This is also our answer for customers moving from Gems or custom GPTs.
5. **Import from URL or Git** (the original PRD's phase 4), reusing the marketplace's companion-file logic.

### G6 — Personal and shared skills, the same model as prompts

**Today:** only admins can add skills; every skill is global and then restricted by groups.

**Decision:** skills get exactly the ownership model user prompts already have (`docs/prompts.md`, `server/services/prompts/`). Users create their own skills and share them; admins manage them; global skills stay admin-managed; an admin can promote a user skill to a global one.

| | User prompts today | User skills |
|---|---|---|
| Who creates | Every signed-in user (`canHoldUserPrompts`: no anonymous, OAuth clients, agents or delegated authorization-code tokens) | Same rule (`canHoldUserSkills`) |
| Sharing | Private by default; share with users, groups or everyone signed in, each as `use` or `edit`; `restrictToGroups` narrows broad sharing | Same targets and levels |
| Global items | `contents/prompts/*.json`, visible through `groups.permissions.prompts` | `contents/skills/<name>/`, visible through `groups.permissions.skills` and assigned to apps |
| Admin management | Admin → Prompts → user tab lists prompts shared with a group or everyone; edit, share, history, delete through the user routes with the admin bypass (`adminAccess` or `contentAdmin`) | Admin → Skills → user tab, same scope and actions; skill admin routes move to `contentAdminAuth` and get audit logging like prompts |
| Promotion | Admin-initiated `POST /api/admin/prompts/:id/promote`: copies into a global prompt with a slug id, records `promotedTo`, keeps the original, audit entry | `POST /api/admin/skills/:id/promote`: writes `contents/skills/<slug>/` (frontmatter `name` = slug, `sourceSkillId`), refreshes the skills cache, records `promotedTo`, keeps the original, audit entry |
| Versions | One revision per change, restore, `maxVersions` | Same; a revision snapshots the whole file set |
| Limits | `platform.userPrompts`: `enabled`, `maxPromptsPerUser`, `maxVersions`, `sharing.*` | `platform.userSkills`: the same keys plus `maxSkillSizeKB` and `maxFilesPerSkill`, seeded by a migration |
| Favorites, recents, duplicate, transfer | Yes | Yes |

**What is different for skills:**

- **A skill is a folder.** The metadata document (owner, shares, revision, frontmatter fields, a manifest of files with sha256) lives in the documents facet; `SKILL.md` and reference files live in the blobs facet, like `ArtifactRepository`. Text files only, with size and count limits and the path validation `getSkillResource` already uses.
- **Ids.** User skills get `usk_…` ids, a separate id space from global skill names. The model sees the id in `<available_skills>` and calls `activate_skill` with it; the picker shows the display name.
- **Where they apply.** Prompts are inserted client-side, so they work in any app. Skills are resolved server-side, so the shared access rule (§3) gains the user-skill exception: a user's own and shared skills are usable in every app unless the app opts out with `skillSettings.allowPersonal: false`. They appear in the `/` picker (groups `mine` and `shared`, as prompts) and can be sent in `requestedSkills`. They are listed in `<available_skills>` for automatic use only when the user turns that on for the skill (G2), so a long personal library does not bloat every prompt.
- **Scheduled tasks** run as their owner, so a task can use its owner's personal skills; a revoked share pauses the task like a revoked tool.
- **Agents and MCP** keep using admin-assigned global skills only; a user skill reaches them after promotion.

**API (mirrors `/api/prompts`):** `GET /api/skills?scope=all|global|mine|shared|favorites`, `POST /api/skills`, `GET/PUT/DELETE /api/skills/:id`, `PUT /api/skills/:id/shares`, `PUT /api/skills/:id/owner`, `POST /api/skills/:id/duplicate` (from a global or shared skill), `GET /api/skills/:id/versions`, `POST /api/skills/:id/versions/:rev/restore`, `GET/PUT /api/skills/:id/files/*`; admin: `GET /api/admin/skills?scope=user`, `POST /api/admin/skills/:id/promote`, `GET/PUT /api/admin/skills/user-settings`.

**Client:** a `/skills` page like the prompt library (mine, shared, global; new, edit, share, duplicate, history, delete), a `SKILL.md` editor with live validation (name rules, 1,024-character description) and text reference files, "Save as skill" on a chat answer, and the share dialog shared with prompts. The new route goes into `KNOWN_ROUTES` and `client/index.html`.

### G7 — Reference files that work like attachments

- Recursive listing of `references/`, `assets/` (today only the top level).
- Non-text files: run PDFs, Office files and images through the existing document pipeline when read, instead of returning garbled UTF-8.
- Binary-safe marketplace install (fetch as `arrayBuffer`, write as buffer).
- Size limits per file and per skill, shown in the admin UI.
- Companion files for every marketplace source type. Today only `url` sources carry `companions`; `relative` and `github` sources install `SKILL.md` alone, so a registry cannot ship its own skills with reference files.
- Scripts stay non-executable. Skills that need computation should use tools; document this for authors (the marketplace `skill-builder` already says so).

### G8 — Many skills, small context

Gemini reportedly allows up to 100 active skills per user. With 100+ marketplace skills, listing every name and description costs tokens and confuses the model.

- When an app has more than N skills (configurable, for example 25), list only the top-k by relevance to the user's message (embedding search over descriptions), plus the active ones.
- Localized display names and descriptions (`metadata.ihub.displayName.de`, `metadata.ihub.description.de`) for the picker, while the English description keeps driving model selection.
- Escape names and descriptions before inserting them into the prompt (B9).

### G9 — Know which skills are used

- Count activations by skill, app, trigger (`slash`, `model`, `scheduled`, `planner`, `dependency`) and outcome in the usage tracker.
- Admin view: most and least used skills, skills never activated, skills often removed by users right after activation (a sign of a bad description).
- Thumbs up/down on messages carry the active skills, so feedback can be grouped per skill.

### G10 — Skills beyond the chat UI

- **MCP prompts:** expose each permitted skill as an MCP prompt (`prompts/list`, `prompts/get` returning the body), so MCP clients can invoke iHub skills explicitly.
- **OpenAI-compatible API:** accept `requestedSkills` as an extension field.
- **A2A:** advertise apps with their skills in the agent card.

## 5. Phasing

| Phase | Content | Size |
|---|---|---|
| **0 — Fix** | B1–B5 and part of B9 (shared access module, agent wiring, escaping), `requestedSkills[]` with the `maxActiveSkills` cap — **#2670** | S |
| **1 — Own** | G6: user skills with sharing, versions, admin tab, promotion, `/skills` page; B6 (admin create/update routes) | L |
| **2 — Invoke** | G1: chips, stacking in the UI, sticky per chat; G2 per-user automatic use; G9 counters | M |
| **3 — Automate** | G3: skills on scheduled tasks, chat tools, "Schedule this skill"; `activeSkills` on workflow prompt nodes | M |
| **4 — Author** | G5: editor polish, create with AI, save as skill, prompt → skill (builds on G6) | M |
| **5 — Scale** | G7 attachments; G8 relevance-based listing; G4 `requires`; G10 MCP prompts; B7 | L |

Phase 0 is a precondition for everything else: stacking and scheduled skills multiply the number of ways a skill gets loaded, so the access check must sit in one place first.

## 6. Decisions

**Taken:**

1. **`requestedSkill` → `requestedSkills`:** clean break, no alias (implemented in #2670).
2. **Personal skills:** yes, with the same model as prompts: users create and share, admins manage, global skills stay admin-managed, user skills can be promoted to global (G6).

**Open:**

3. **Sticky by default?** Proposal: explicitly invoked skills stay active for the chat; model-activated ones too, shown as removable chips.
4. **Relevance-based listing (G8):** acceptable to add an embedding dependency to the skills path, or start with a simple keyword prefilter?
5. **`metadata.ihub.*` namespace** for iHub-specific frontmatter (`unattended`, `scheduleHint`, `requires`, localized names). Proposal: yes, the spec reserves `metadata` for this.
6. **User skills on by default?** Proposal: `platform.userSkills.enabled` defaults to `true` (as `userPrompts`), effective only while the `skills` feature is on; apps can opt out with `skillSettings.allowPersonal: false`.

## 7. Marketplace changes made alongside this review

The marketplace PR adds:

- **Eight everyday skills** written for iHub, covering what Google ships or showcases as premade skills: `match-my-writing-style`, `presentation-prep`, `perspective-panel`, `newsletter-composer`, `vendor-evaluator`, `executive-email-drafter`, `inbox-triage`, and `skill-builder` (create a skill through an interview, or convert a prompt, Gem, or custom GPT). Google's `/prep-for-meetings` is already covered by `meeting-readiness-pack`.
- **89 of Google's 153 open-source skills** (Apache-2.0) that work in a chat without command execution, referenced at a pinned commit of Google's repositories and installed with their reference files. Skills that mainly drive `gcloud`, MCP servers or scripts were left out. An end-to-end install against a local iHub (registry → install → `/api/admin/skills`) worked for both relative and `url` + `companions` sources.
