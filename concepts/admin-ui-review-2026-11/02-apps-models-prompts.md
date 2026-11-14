# AI Workspace core: Apps, Models & Providers, Prompts — admin UI review

**Date:** 2026-11-12 · **Panel:** Product manager, UX designer, UI designer, Technical writer, iHub admin
**Pages in scope:** `/admin/apps`, `/admin/apps/new`, `/admin/apps/:appId`, the Create App flow (template picker + wizard), `/admin/models`, `/admin/models/new`, `/admin/models/:modelId`, `/admin/providers` (a tab of Models), `/admin/providers/new`, `/admin/providers/:providerId`, `/admin/prompts` (tabs: Prompts, User prompts, Variables), `/admin/prompts/new`, `/admin/prompts/:promptId` ([App.jsx:551-588](../../client/src/App.jsx)).

All five panel notes were delivered. Eight panels shared one instance and one IP, so the admin API limit (100 requests/min) and the login limit often returned 429; several pages were first captured in their error state, which produced a finding of its own (AI-B11). Test entities (`zz-apps-models-prompts-*`: one provider, one model, three apps, one prompt) were created by the UX designer and the admin and deleted afterwards (all DELETEs 204; no references left in `contents/` or `groups.json`). The lead re-checked every disputed or single-source fact in code and live (`lead/check.js` in the scratch folder); see the appendix. Instance state at review time: 28 apps (19 enabled), 3 models (none enabled, no default), every shipped group except `anonymous` holding `apps: ["*"]`.

## Summary

This is the core of the product: connect an LLM endpoint (**Provider**), register what it serves (**Model**), build what employees use (**App**), and curate a **Prompt** library. The building blocks are strong and partly excellent (the Models tab with its setup strip and import dialog, the side-by-side app **Test** panel, `{{variable}}` detection in the prompt editor, the "Hidden from users until … is on" hints on the apps list). But the operator's jobs cut across pages that don't connect, and the area is **not intuitive** for a first-time admin: the admin finished one of six realistic tasks fully, four partially, and one failed.

The biggest problems:
- **Creating an app is broken on the main path.** The wizard drops name, description and system prompt on any `en-US`/`de-DE` browser and the save fails (AI-B1); the template picker is always empty (AI-B4); the wizard can't make a dropdown variable or starter prompts and its "Enable Image Upload" box does nothing (AI-B5).
- **Access can't be expressed where admins look for it.** Shipped groups hold `*`, so "only HR may use this app" and "hide this model from normal users" can't be done from the app or model; the only explanation is a hover tooltip, and models have no access card at all (AI-PM1).
- **One-click foot-guns:** Enable All / Disable All act on every app, model or prompt without confirmation; Disable All on Models also throws away the default (AI-B2).
- **Errors don't say what to do.** Model test, import and app test hide the HTTP status and host, and a keyless model is reported as "credentials rejected — contact your administrator" (AI-B10).
- **Visual debt:** ~40 borderless, unpadded inputs; unreadable dark-mode labels; Providers pages built in a different visual language (AI-B3, AI-UI9).
- **Docs teach JSON**, contain wrong statements (prompt `appId`, provider base URL, "restart the server"), and no page links to them (AI-TW1, AI-TW2).

## 1. What this part does

- **Apps list** (`/admin/apps`): all chat, iframe and redirect apps with search, category and status filters (kept in the URL), drag reorder, Upload Config, Enable All / Disable All, and row actions (edit, enable via an eye icon, clone, download, delete). Flags apps that are hidden because a feature or integration is off. Used weekly.
- **Create App** (button → `AppTemplateSelector` → 7-step `AppCreationWizard`, [AppCreationWizard.jsx](../../client/src/features/apps/components/AppCreationWizard.jsx), 1,638 lines): template or scratch, then AI-generated or manual, basics, system prompt, variables, advanced, review. A second, different path — the full editor at `/admin/apps/new` — is reachable only from Cmd+K "New App" and the setup wizard ([AdminCommandPalette.jsx:49](../../client/src/features/admin/components/AdminCommandPalette.jsx), [SetupWizard.jsx:599](../../client/src/features/setup/SetupWizard.jsx)). Used monthly.
- **App editor** (`/admin/apps/:appId`): a Form/JSON dual editor with 22 section cards for a chat app (26 section components in total; iframe/redirect add their own) plus Group access, Save / Save & Exit, Ctrl+S, unsaved-changes guard, History, Download, Open app, and the **Test** panel that runs the *saved, enabled* app beside the form ([AppTestPanel.jsx:164,213](../../client/src/features/admin/components/AppTestPanel.jsx)). Used weekly; the most-used editor in the admin.
- **Models** (`/admin/models`, tab): models with provider, key status ("Key found", "No key needed"), enabled/default pills, a 3-step "Set up your models" strip, Import models, Add model, and a ⋮ with Test, Enable All / Disable All. Used at setup, then monthly.
- **Model editor** (`/admin/models/:modelId`): connection (provider, API model ID, URL, key), limits, capabilities, sampling, reasoning, output marking, usage limits and statistics, "Apps using this model". 2,167-line `ModelFormEditor.jsx`.
- **Providers** (`/admin/providers`, tab under Models; create and edit pages): one endpoint + one API key shared by its models; API type, base URL (used only to list models for import), gateway, timeouts; "Test All" tests enabled models per provider; the shared "Timeouts for all providers" card. Used at setup and on key rotation.
- **Prompts** (`/admin/prompts` + editor): the end-user prompt library (Prompts tab), users' shared prompts with Promote (User prompts tab), and Global prompt variables plus Global context that feed every app's system prompt (Variables tab). The editor detects `{{placeholders}}` and offers "Describe". Used monthly.

## 2. Is it intuitive? — verdict

Panel median, persona range in brackets.

| Page | Score (1–5) | Why |
|---|---|---|
| Apps list | 3 (3) | Good filters and the "Hidden from users until iFinder integration is on" hint. But Model shows "N/A" for 27 of 28 apps where it means "platform default"; two "All" chips; raw category ids the filter can't select; Enable All / Disable All sit unguarded in the toolbar; enabling is an eye icon that never changes. |
| Create App (template picker + wizard) | 2 (1–2) | Template list always empty; "Create from Scratch" then asks again "AI or Manual?"; steps are unlabelled numbers; fails on regional browser locales (AI-B1); can't finish the realistic app; ends on the list without a toast. |
| `/admin/apps/new` (full form) | 2 (2) | Opens with 4 red errors in schema wording, listed twice, before anything is typed. |
| App editor | 2 (2–3) | Strong save model and Test panel; but ~7,000 px (≈9,900 px at 390) with no section index, Save only at the bottom, borderless inputs, and Group access last, saving immediately while everything else waits for Save. |
| App Test panel | 4 (admin) | The best thing in the area: real chat with variables and starter prompts beside the form. Its errors are unhelpful (AI-B10), and it shows nothing for a disabled app. |
| Models list | 4 (3–4) | Tabs with counts, setup strip, URL filters, one primary + ⋮: the model for other list pages. Missing: Set as default, visible Test, access. Provider filter shows raw ids. |
| Model editor | 2 (2–3) | Enabled and Default are checkboxes 7 and 8 among capability flags; URL required even when the provider has one; no access card; narrow `max-w-4xl` column. |
| Providers list | 3 (3) | Clear key and connectivity badges and the key-priority explainer. Hand-rolled table, scrolls sideways on mobile, empty-state CTA shown during load errors. |
| Provider create / edit | 3 (2–3) | Good help text, but no Test connection, API key below timeouts, stale subtitle, back to the list after create, disabled "Provider Enabled" checkbox. |
| Prompts list | 3 (3) | Clear tabs; but the internal App Generator prompt is listed (and served to users), a dangling app link shows a green ✓, two "All" chips, no Status column. |
| Prompt editor | 3 (2–4) | Placeholder detection is excellent; "Linked App" is misdescribed; icon is free text; Description required but unmarked. |
| Global variables (Prompts → Variables) | 3 (PM) | Good editor in the wrong place: the values feed app system prompts, and nothing in the app editor points here. |

**Verdict.** The area is organised by object (provider, model, app, prompt) while admins think in jobs: *make a model usable*, *give HR an assistant*, *hide this model*, *why can't Alice see this*. Every one of those jobs crosses two to four pages, and the pages hand off badly (create → back to the list; test only after enabling; access only on another page). Where the UI is newest — the Models tab, the import dialog, the Test panel — it is genuinely good; where it is older — Providers, the app form inputs, the wizard — it is inconsistent or broken. The single most important fact for access (shipped `*` wildcards) is hidden in a tooltip, and the creation wizard, the first thing a new admin clicks, fails for most browsers.

## 3. Task walkthroughs

The admin walked all six tasks end-to-end in the running UI; other personas repeated parts. Step counts and frustration (1–5) are the admin's.

**Task 1 — Connect an OpenAI-compatible / Azure-like endpoint and make one model usable.**
- Steps: ~15 (Models → Providers tab → Add provider → form → Create → land on list → find row → Import models → error → Models → Add New Model → URL again, with `/chat/completions` → guess "API Model ID" = deployment name → Save → list → ⋮ → Test).
- Hurt: no Test connection on the provider; Create returns to the list after 1.5 s ([AdminProviderCreatePage.jsx:79-83](../../client/src/features/admin/pages/AdminProviderCreatePage.jsx)); import dropped the HTTP 502 the server sent; the new model form opened with 5 errors; the model URL isn't taken from the provider ([ModelFormEditor.jsx:781](../../client/src/features/admin/components/ModelFormEditor.jsx)); "Azure OpenAI" appears nowhere in the API types; provider Test only covers *enabled* models, and enabling makes a model live for everyone; the test said "internal error, try again later". The new model silently became the platform default (AI-B13).
- Outcome: **partial** (frustration 4).

**Task 2 — Create an "HR helper" app with a dropdown variable and two starter prompts, restricted to one group.**
- Steps: ~28.
- Hurt: on an `en-US` browser everything typed in steps 2–3 was rejected at the last step (AI-B1). With locale `en` it saved, but the wizard has no dropdown type, no starter prompts and no access step; its Review shows an empty "Model:"; it ends on the list. In the editor, dropdown options need label + value per row and the default value is typed blind; an empty starter prompt disables Save via the bottom Validation Summary. Group access shows five locked wildcard chips; restricting needs replacing `*` in ≥4 groups.
- Outcome: **failed** on first try, **partial** after (app created, not restricted; frustration 5).

**Task 3 — Clone an app, change its model and icon.**
- Steps: 9 (row ⋮ → Clone → wizard prefilled → new ID → icon (free text) → model → review → create).
- Hurt: the clone keeps the name "Chat", so users get two identical tiles; the icon is free text with no preview; the review shows a literal `{templateName}`; hidden `parentId` and a Magic Prompt model that doesn't exist on this install are carried silently.
- Outcome: **success** (frustration 2).

**Task 4 — Make a model the default; hide a model from normal users.**
- Steps: default 4 (Models → open model → scroll to Options → tick Default → Save). Hide: searched the model page, Cmd+K, then Groups.
- Hurt: no "Set as default" row action; Cmd+K "default model" finds nothing; no access control on models ([ContentAccessSection.jsx:47](../../client/src/features/admin/components/ContentAccessSection.jsx) supports apps, prompts, skills, workflows only); `admins`, `users`, `authenticated`, `agents` and `agent-operators` hold `models: ["*"]` (`content-admins`, `browser-extension` and `nextcloud-embed` hold `[]`, `anonymous` an explicit list; verifier, live `GET /api/admin/groups`).
- Outcome: default **success**; hide **failed** (frustration 4).

**Task 5 — Create a prompt that is offered only in one app.**
- Steps: 8.
- Hurt: creation was easy and variable detection excellent; but "Linked App" only ranks the prompt first in that app (AI-B7), Description is required but unmarked, and Group access is wildcard-locked.
- Outcome: **partial** (frustration 3).

**Task 6 — Find out why users don't see an app.**
- Steps: open-ended; the admin compared the admin and a user's app list by hand (11 hidden apps, 9 simply disabled).
- Hurt: the list explains features and integrations that are off, but not missing group grants, disabled/keyless preferred models or `requiredFeatures`; the Test panel runs as the admin (who holds every wildcard) and shows nothing for disabled apps; `docs/apps.md:1511-1516` says to check JSON syntax and restart the server.
- Outcome: **partial** (frustration 3).

## 4. What is broken

P0 = data loss or lockout in a normal flow · P1 = blocked core task or silent wrong outcome · P2 = wrong/misleading with a workaround · P3 = polish.

| ID | Status | What happens | Evidence | Severity |
|---|---|---|---|---|
| AI-B1 | Confirmed (repro ×3) | **The app wizard loses localized fields on regional browser locales.** Basics and System Prompt steps write under `i18n.language` (`en-US`, `de-DE`), the draft starts as `{ en: '' }`, so Review shows an empty name and Create fails: "name.en: Localized string cannot be empty; description.en …; system.en …". The step's Language select shows "English", so the admin can't see why. Works only when the language was picked in the UI (stored as `en`). (UX, admin.) | [AppCreationWizard.jsx:28, 605, 854, 1134](../../client/src/features/apps/components/AppCreationWizard.jsx) (`useState(i18n.language \|\| 'en')`); [i18nService.js:72-96](../../client/src/services/i18nService.js) (LanguageDetector, no `supportedLngs` / `load: 'languageOnly'`); `ux/shots/wiz7.png`, `wiz8.png`; `admin/t2-after-create-top.png`; verifier: fresh `en-US` context → `localStorage.i18nextLng = "en-US"`, wizard Create → "Invalid app configuration: name.en: Localized string cannot be empty; description.en …; system.en …" (`verify/v2.js`). | **P1** |
| AI-B2 | Confirmed (code) | **Enable All / Disable All act on everything, at once, unconfirmed.** Apps, Models and Prompts send `_toggle` for `*`. Enable All re-enables the 9 deliberately disabled apps and the curated state can't be recovered (no undo, no list of what changed). Disable All on Models also clears `default` server-side; Enable All afterwards makes the *first* chat model default, not the old one. (PM; UI, UX.) | [AdminAppsPage.jsx:289-305, 618-631](../../client/src/features/admin/pages/AdminAppsPage.jsx); [AdminModelsPage.jsx:197-213](../../client/src/features/admin/pages/AdminModelsPage.jsx); [AdminPromptsPage.jsx:119-136](../../client/src/features/admin/pages/AdminPromptsPage.jsx); [models.js:759-780](../../server/routes/admin/models.js) (`default: false` on disable, then `ensureStoredDefault`). Live: 19 of 28 apps enabled. On Models the two items already sit in the ⋮ menu (`AdminModelsPage.jsx:551-561`); "Disable All" is styled `destructive` but `MoreActionsMenu` only colours it, no confirm. | **P1** |
| AI-B3 | Confirmed (code + screenshot) | **~40 inputs and selects have no border, no padding, no dark background.** Class strings assume `@tailwindcss/forms`, which this Tailwind 4 build doesn't load; `INPUT_CLASS` exists but isn't used here. App ID, Order, Preferred Model and Output Format render as bare text; a red error collapses App ID to ~18 px. Four labels have no dark variant and are unreadable in dark mode. Same root cause as ID-B7 in the Access & Identity report. (UI.) | [BasicInfoSection.jsx:56](../../client/src/features/admin/components/app-form/BasicInfoSection.jsx); `InputModeSection.jsx:36,55,215,605`, `UploadConfigSection.jsx:145`, `StarterPromptsSection.jsx:70`, `VariablesSection.jsx:198`, `ModelFormEditor` (Concurrency, Request delay, Sampling), `PromptFormEditor` (ID, Icon, Order); [formStyles.js:5-11](../../client/src/features/admin/components/formStyles.js); `ui/crops/full-light-apps-edit-chat-0.png` (lead looked), `ui/crops/dark-app-edit-bottom.png`; verifier: computed style of App ID on `/admin/apps/chat` → `border-top-width: 0px`, `padding-left: 0px`. | **P1** |
| AI-B4 | Confirmed (live) | **"Choose App Template" is always empty** and says "No apps found matching your search" with an empty search box. The route keeps apps with `allowInheritance !== false`; the schema prefaults it to `false`; no UI sets it; no shipped app sets `true`. Every Create App click passes a modal with one usable option. (All five.) | [apps.js:354-358](../../server/routes/admin/apps.js); [appConfigSchema.js:691](../../server/validators/appConfigSchema.js); `AppTemplateSelector.jsx:174-177`; lead: `GET /api/admin/apps/templates` → `{"items":[]}`, 28 of 28 apps `allowInheritance: false`. | P2 |
| AI-B5 | Confirmed (code) | **The wizard can't build the realistic app, and one control is dead.** Variable types: string/text/number/boolean (no `select`, no `date`); the editor offers string/text/select/date/number (no `boolean`), so neither offers all six schema types. No starter prompts, no access step. "Enable Image Upload" is stripped before POST (`imageUpload` "was never read"), so ticking it does nothing. On success: `navigate('/admin/apps')`, no toast. (PM, UX, admin, TW.) | [AppCreationWizard.jsx:1422-1425, 1512-1521, 283](../../client/src/features/apps/components/AppCreationWizard.jsx); [appWizardPayload.js:15-30](../../client/src/features/admin/utils/appWizardPayload.js); [VariablesSection.jsx:232-236](../../client/src/features/admin/components/app-form/VariablesSection.jsx); `appConfigSchema.js:45`. | P2 |
| AI-B6 | Confirmed | **Wizard writes categories the platform doesn't know.** Hard-coded `productivity`, `creativity` (plus three valid ones) vs `ui.json` categories used by the editor; the list shows raw ids the filter can't select. (UX, admin.) | [AppCreationWizard.jsx:1534-1540](../../client/src/features/apps/components/AppCreationWizard.jsx) vs `BasicInfoSection.jsx:119`, `contents/config/ui.json` `appsList.categories`. | P2 |
| AI-B7 | Confirmed (lead, code) | **Prompt "Linked App" doesn't restrict the prompt**, it ranks it first in that app; every user still gets it from `GET /api/prompts`. `docs/prompts.md:40` says it "is only offered when the user is in the specified app". (PM, UX, admin; TW had Suspected.) | [PromptSearch.jsx:130-141](../../client/src/features/prompts/components/PromptSearch.jsx) (sort only; JSDoc `:54` "to rank its prompts first"); no server filter. | P2 |
| AI-B8 | Confirmed (live) | **The internal "App Generator" system prompt is served to end users** as a global prompt and listed among curated prompts; the wizard's AI generation reads it, so an admin who tidies the library breaks generation. (PM, UX.) | Lead: `GET /api/prompts` contains `app-generator`; [AppCreationWizard.jsx:614-627](../../client/src/features/apps/components/AppCreationWizard.jsx). | P2 |
| AI-B9 | Confirmed (code + live) | **The app editor offers only models the admin may already use as a chat user** (public `/api/models`: enabled and permitted). A new or disabled model can't be chosen as Preferred Model before it is live for everyone; with all 3 models disabled here, Preferred Model is empty. Contradicts `docs/models.md:549` ("the admin pages … list models from `GET /api/admin/models`"). (UX.) | [AdminAppEditPage.jsx:51](../../client/src/features/admin/pages/AdminAppEditPage.jsx) → [models.js endpoint](../../client/src/api/endpoints/models.js) `apiClient.get('/models')`; lead live: 0 of 3 models enabled. | P2 |
| AI-B10 | Confirmed (live + code) | **Connection errors hide the facts and point the wrong way.** Import replaces the server's detail (which names the upstream status, e.g. "HTTP 502") with the generic translated headline "The endpoint answered with an error" ([modelImport.js:119-122](../../client/src/features/admin/utils/modelImport.js) `translateDiscoveryError`); an upstream 5xx on Model Test reads "The model service encountered an internal error. Please try again later" with no status or host; the keyless `local-vllm` (list badge "No key needed") answers **500** `AUTH_FAILED` "The model service rejected the server's credentials. Please contact your administrator" with detail "API key not configured"; the app Test panel says "openai API service error"; import details show a raw `ECONNREFUSED` string; no path maps TLS/private-CA failures to the SSL whitelist; remediations are English only. (Admin, UX, TW.) | [ModelImportDialog.jsx:235-238](../../client/src/features/admin/components/ModelImportDialog.jsx); [models.js:154-240](../../server/routes/admin/models.js) (`describeModelTestFailure`); lead and verifier: `POST /api/admin/models/local-vllm/_test` → 500 as quoted while `GET /api/admin/providers/_key-status` reports `local` as `keyless`; `admin/t1-import-error.png`, `t1-model-test.png`. Refused, unresolvable and timed-out hosts *are* mapped to specific translated headlines ([models.js:121-140](../../server/routes/admin/models.js)); see appendix for the removed "unreachable host" sub-claim. | P2 |
| AI-B11 | Confirmed (live) | **Load errors render as empty states.** Providers: error banner (no Retry) beside "No providers configured. Create your first provider" and tab counts "0"; Apps: error above "No apps found – adjust filters". Invites duplicate creates. (PM, UX, TW.) | [AdminProvidersPage.jsx:374-375, 760](../../client/src/features/admin/pages/AdminProvidersPage.jsx); `ux/shots/_admin_providers.png`; `tw/shots/en__admin_apps.txt`; verifier: `/api/admin/providers` forced to 500 → error text and "No providers configured" CTA both render, no Retry (`AdminLoadError … action={null}`, also `AdminAppsPage.jsx:647`); `verify/b11-providers-error.png`. | P2 |
| AI-B12 | Confirmed | **Deletes don't name the item or check dependants.** Provider delete refuses when in use; model and app deletes check nothing (preferred/allowed models, prompts linked to the app, apps-as-tools). Model, prompt and provider deletes use the browser's `confirm()`; the app dialog says "this app". (UX, UI, TW.) | `providers.js:843-852` vs [models.js:796-829](../../server/routes/admin/models.js), `apps.js:1126-1160`; `AdminModelsPage.jsx:253`, `AdminPromptsPage.jsx:139`, `AdminProvidersPage.jsx:290`, `AdminAppsPage.jsx:307-315`. (Model and app deletes do write a History snapshot, `models.js:813`, `apps.js:1141`, so a restore path exists; the dialogs don't mention it.) | P2 |
| AI-B13 | Confirmed (code) | **The first enabled chat model silently becomes the platform default**, with no notice. (Admin.) | On create: [resourceLoaders.js:41-49](../../server/resourceLoaders.js) (cache load promotes the first enabled chat model when none is default); on toggle/delete: [models.js:340-346](../../server/routes/admin/models.js) `ensureStoredDefault` (called at `:780`, `:806`); `admin/t1-model-created.png`. | P2 |
| AI-B14 | Confirmed (script) | **German admin is half English**: 287 of 1,034 `t()` calls in scope have a key in neither `en.json` nor `de.json` ("Apps Administration", "Create App", "Enabled" next to "Deaktiviert"); placeholders are hard-coded `{en, de}` objects. (TW.) | Worst: PromptFormEditor 41, AdminPromptsPage 37, AdminAppsPage 30, BasicInfoSection 23, VariablesSection 20; `tw/shots/de__admin_apps.txt`; `BasicInfoSection.jsx:140`, `SystemInstructionsSection.jsx:45-73`; verifier re-counted the five worst files with the same result (`contents/locales/*.json` are empty, so no override fills them). | P2 |
| AI-B15 | Confirmed | **"App not appearing" troubleshooting is wrong**: JSON syntax, file location, "Restart the server after adding new app files". Apps hot-reload; the real causes (disabled, group grant, `requiredFeatures`, integration, model) are missing. (All five.) | [docs/apps.md:1511-1516](../../docs/apps.md). | P2 |
| AI-B16 | Confirmed | **Blank forms open in an error state** (apps 4 errors, model 5, prompt 1), worded "id must be at least 1 characters", shown in a top banner and again as "Validation Summary". Required labels read "Name \* \*"; App ID's marker depends on the loaded schema; prompt Description is required but unmarked. Duplicate app ID is reported only after Save. (All five.) | [BasicInfoSection.jsx:48, 134, 154](../../client/src/features/admin/components/app-form/BasicInfoSection.jsx) + [DynamicLanguageEditor.jsx:320](../../client/src/shared/components/DynamicLanguageEditor.jsx); `ui/crops/full-light-apps-new-0.png`, `admin/t1-model-new.png`; verifier: `/admin/apps/new` on load shows 9 occurrences of "at least 1 character", a "Validation Summary" and "Name \* \*". | P2 |
| AI-B17 | Confirmed (screens) | **390 px breakages:** Model and Prompt editor headers don't wrap ("Back to Models" cut off); the hand-built Providers table scrolls sideways, hiding "Configure"; the last Prompts tab is clipped. (UI.) | `AdminModelEditPage.jsx:375,388`, `AdminPromptEditPage.jsx:~201,214`; `AdminPromptsPage.jsx:422`; `ui/crops/m-pair1.png`–`m-pair3.png`, `ui/shots/v2-mobile-prompts-list.png`. | P2 |
| AI-B18 | Confirmed (code) | **Accessibility:** provider API key, App ID/Type and Global Context labels aren't linked (`htmlFor`); provider search has only a placeholder; Prompts tabs lack `role="tablist"`/`aria-selected`; the wildcard explanation is a `title` tooltip that keyboard and touch users can't reach. (UI, TW.) | `AdminProviderEditPage.jsx:254`; `BasicInfoSection.jsx:46`; `GlobalPromptVariablesEditor.jsx:122`; `AdminPromptsPage.jsx:422`; [ContentAccessSection.jsx:264-270](../../client/src/features/admin/components/ContentAccessSection.jsx). | P2 |
| AI-B19 | Confirmed | **Clone writes inheritance metadata nothing reads** (`parentId`, `inheritanceLevel`, `overriddenFields`); the docs describe inheritance as working; the clone review shows literal `{templateName}` / `{fields}` (single braces); the clone keeps the original name. (PM, UX Suspected → lead grep: no server reader; admin.) | `AppCreationWizard.jsx:66-67, 133-134, 585, 1604, 1611`; [docs/apps.md:570-573](../../docs/apps.md); grep `parentId` in `server/` → schema and migration V144 only. | P3 |
| AI-B20 | Confirmed | **Provider pages:** subtitle still offers "a web search provider, or a generic API key" (moved to Integrations); no unsaved-changes guard on create; a permanently disabled "Provider Enabled" checkbox. (PM, UX, UI, TW.) | `shared/i18n/en.json:1064`; `AdminProviderCreatePage.jsx` (no `useUnsavedChanges`); `AdminProviderEditPage.jsx:306-319`. | P3 |
| AI-B21 | Confirmed | **Setup strip step 1 is never "done" for keyless endpoints**, though its copy says "or an endpoint that needs none". (PM, UX.) | [modelsArea.js:26](../../client/src/features/admin/utils/modelsArea.js) vs `ModelsSetupStrip.jsx:48`; `pm/shots/models.png`. | P3 |
| AI-B22 | Confirmed | **List noise:** two "All" chips on Apps and Prompts (page chip + `ui.json` `all`); Category "N/A" while the filter counts it as Utility; Model "N/A" for 27 of 28 apps; "APP CONNECTED" header clipped; a ✓ for `faq-question` → `faq-bot`, an app that doesn't exist. (PM, UX, UI.) | `AdminAppsPage.jsx:340, 714-737`; `AdminPromptsPage.jsx:284-285`; lead: 1 of 28 apps has `preferredModel`. | P3 |
| AI-B23 | Confirmed | **Model API key hint omits the provider key**, which is checked first: "the system will use the environment variable for the provider". Pushes admins to paste keys per model. (PM, TW.) | `ModelFormEditor.jsx:1009-1013` vs `server/utils.js:166-195` lookup order (model key → provider key → model env var → provider env var). | P3 |
| AI-B24 | Confirmed | **Hard-coded English** in breadcrumbs, the model "History" button and the provider unsaved-changes dialog. (UI.) | `AdminAppEditPage.jsx:469-471`, `AdminModelEditPage.jsx:359-361, 414`, `AdminPromptEditPage.jsx:186`, `AdminProviderEditPage.jsx:450`. | P3 |
| AI-B25 | Confirmed (lead, code) | **Docs contradict the product:** provider base URL "redirects" traffic (no chat adapter reads it except iAssistant); `admin-ui.md` promises templates, a model **Hints** field, prompts as "system prompt templates" with 2 tabs; `models.md:243` "Admin → Providers … category LLM Providers"; `admin-provider-new.png` shows the removed Category select; `models.md` has no H1 (search lists it as "models"). (All.) | `docs/models.md:325-326` vs `ProviderFormFields.jsx:157` and grep `baseUrl` in `server/adapters/`, `services/inference/`; `docs/admin-ui.md:144` (templates), `:211` (Hints), `:239` (prompts); `docs/assets/screenshots/admin-provider-new.png`. | P3 |

## 5. Findings by persona

### Product manager

- **AI-PM1 — Access is set in group lists, not on the item, and shipped defaults make "only these groups" impossible.** `admins`, `users`, `authenticated`, `agent-operators`, `content-admins` hold `apps: ["*"]`; `users`, `agent-operators` and `content-admins` inherit `authenticated`, and `admins` inherits `users` (`contents/config/groups.json`). The app card shows locked chips; models have no card. Restricting one app means replacing `*` in ≥4 groups with ~28 explicit ids and maintaining those lists forever; every new app is invisible to them until added. Copilot Studio, Open WebUI and Dify all set audience on the item. Recommendation: (a) now, non-breaking: visible wildcard explanation, Group access card on models, "Convert wildcard" helper (W3); (b) decision for the user: an item-level audience ("Everyone signed in" / "Only these groups") that the authorization layer honours, which changes what `*` means and therefore needs an explicit compat-vs-clean-break choice (CLAUDE.md). Co-reported by UX (AI-UX1), admin (AI-ADMIN3), TW (AI-TW7); same root as ID-B5 in the Access & Identity report.
- **AI-PM2 — No draft state; testing means publishing.** New apps default to `enabled: true` ([AdminAppEditPage.jsx:95](../../client/src/features/admin/pages/AdminAppEditPage.jsx)); the Test panel runs only the saved *enabled* app — for a disabled one it renders no chat ([AppTestPanel.jsx:164, 213](../../client/src/features/admin/components/AppTestPanel.jsx), lead). So "create disabled, test, then enable" is impossible, and `docs/admin-ui.md:185` advises testing risky changes on a clone. Recommendation: Draft status served only to admins in the Test panel, plus Publish; later, test unsaved changes via a preview endpoint.
- **AI-PM3 — Two divergent app-creation implementations.** The wizard re-implements basics, system, variables and advanced fields with different defaults (`preferredStyle: 'normal'` vs `'keep'`), different variable types and a dead upload checkbox (AI-B5). Every wizard bug in §4 is a symptom. Recommendation: one short creation dialog that creates the app and opens the full editor (W2); delete the wizard's duplicate field steps; keep "Generate with AI" as a starting point.
- **AI-PM4 — Config without UI (admins must use the JSON tab or files).** App: `greeting` (injected by `makeDefault`, never editable), `outputSchema` (enforced in `services/inference/structuredOutput.js:320-328`), per-app `thinking` and `imageGeneration`, `requiredFeatures`, `requiredIntegrations`, `disallowModelSelection`, `settings.model.filter`, `customResponseRenderer`, `allowUserTemplateUploads`. Model: user-facing `hint` (`admin-ui.md` lists it; the editor has none), `supportsTemperature` (`docs/models.md:156-178`: newer Claude models return 400 when a temperature is sent, and the editor exposes Sampling), `supportsStructuredOutput`, `supportsImages`, `thinking.chatTemplateKwargs`. Prompt: `actions` (no client consumer — Suspected dead) and `outputSchema`. Recommendation: expose model `hint` and `supportsTemperature` (auto-set on import for known families), app `greeting` and `outputSchema`; remove dead fields.
- **AI-PM5 — Three overlapping model-choice knobs in an app**: `allowedModels` (Basics), "Enable Model Selection" (`settings.model.enabled`, User Settings, section 21) and `disallowModelSelection` (no UI). Recommendation: one Model block — preferred model, "users may switch: no / among allowed", allowed list — and fold `disallowModelSelection` into it (migration).
- **AI-PM6 — Provider and model duplicate endpoint and key.** The provider Base URL is used only to list models for import; each model still requires its own URL; keys can sit on both. Recommendation: a model linked to a provider inherits the endpoint (read-only with "override") and defaults to "Use provider key ✓". Co-reported by admin (AI-ADMIN1).
- **AI-PM7 — Azure OpenAI is invisible; Bedrock and OpenRouter are missing from first-run setup.** (Verifier: Bedrock and OpenRouter ship as providers in `providers.json` and are listed on the Providers tab and in `admin-ui.md:223`; only the `/setup` tiles lack them.) Azure works only through Import's URL auto-detection ([ModelImportDialog.jsx:246-264](../../client/src/features/admin/components/ModelImportDialog.jsx), `docs/models.md:336-339`); setup wizard tiles are Google, Anthropic, OpenAI, Mistral, Local ([SetupWizard.jsx:13-48](../../client/src/features/setup/SetupWizard.jsx)); no Azure entry in `shared/llmProviders.js:33-39`. Recommendation: named vendor tiles in W1.
- **AI-PM8 — No bulk edit.** No row selection on Apps; the JTBD "switch 12 apps to a new model" from the 2026-05 strategy is unserved. Recommendation: row checkboxes with Enable, Disable, Set preferred model, Set category — each confirm names the affected items (replaces AI-B2's buttons).
- **AI-PM9 — Global prompt variables live where nobody using them looks.** They feed app system prompts, but `SystemInstructionsSection.jsx` has no variable list or link. Recommendation: an "Insert variable" menu in the system prompt and prompt template fields listing built-in, global and app variables, linking to the editor.

### UX designer

- **AI-UX1 — No single place answers "why can't users see this app?" (task 6).** The list covers features and integrations only ([AdminAppsPage.jsx:100-190](../../client/src/features/admin/pages/AdminAppsPage.jsx)); the Test panel shows "No models available" without a link. Recommendation: an **Availability** checklist at the top of the app editor and on the model editor (Enabled ✓ · Required features ✓/✗ → Features · Integrations ✓/✗ → Integrations · Model usable ✓/✗ → Models · Groups: 5 via wildcard), plus "Check a user or group" backed by the server's own filter (`utils/authorization.js`). Co-reported by PM, UI, TW, admin; pairs with the user-side Access tab proposed in the Access & Identity report (ID-PM1) — build one server explainer for both.
- **AI-UX2 — Connecting a provider is a loop, not a funnel.** Add provider → list → find row → open → import or add → enable (now live for everyone) → only then Test, because provider test iterates enabled models (`AdminProvidersPage.jsx:194-196`). The strongest path, Import models (creates a provider with its key on the spot), is a secondary button while the strip's primary says "Add a provider key". Recommendation: W1; meanwhile land on the provider after create with "Import models from this endpoint" as primary.
- **AI-UX3 — The app editor has no progressive disclosure.** 22 cards all expanded; starter prompts and variables sit below ~9 screens of tool settings for task 2 ([AppFormEditor.jsx:184-324](../../client/src/features/admin/components/AppFormEditor.jsx)). Recommendation: sticky section index; sections at their defaults collapse to a one-line summary ("Upload: off"). Order in §6.
- **AI-UX4 — Model lifecycle controls are buried.** Enabled and Default sit in "Options" between "Supports Vision" and "Auto Discovery"; no ★ Default row action; Cmd+K "default model" → no results. Recommendation: Default pill + "Make default" row action; Enabled/Default as a status control in the editor header; toast "X is now the default for apps without a preferred model".
- **AI-UX5 — Error prevention.** Errors before input (AI-B16); duplicate ID only after Save in a top banner. Recommendation: validate on blur/first submit, human wording ("Enter an ID"), inline ID availability check, suggest `<id>-copy` on clone, one summary.
- **AI-UX6 — Error states designed as empty states** (AI-B11): Models and Prompts collapse to "Error loading … Retry" and hide the tabs; App edit error offers only "Dismiss", then a blank form. Recommendation: keep chrome and stale data, Retry in the banner, never render the empty-state CTA while `error` is set.
- **AI-UX7 — Names don't match behaviour.** "Linked App" → "Opens in app" (or implement "Show only in app", §10); "Clone" → "Duplicate" without fake lineage; the model "Provider" dropdown mixes API types and provider instances ("OpenRouter (OpenAI-compatible (OpenAI, LLM Hub, LM Studio, …))") — split into *Connection* (provider) with API type read-only.
- **AI-UX8 — Same concept, different controls.** Icon: `IconPicker` in the app editor, free text in the wizard and the prompt editor ([PromptFormEditor.jsx:240-257](../../client/src/features/admin/components/PromptFormEditor.jsx)). `{{placeholder}}` detection exists in the prompt editor (`:453`) but not for app system prompts — the admin typed `{{tone}}` and had to create the variable by hand. Recommendation: reuse both everywhere. Co-reported by admin, UI, TW.
- **AI-UX9 — Cmd+K has entities but no tasks.** Quick actions are New App, View Audit Log, Run Backup, Check for Updates (`AdminCommandPalette.jsx:40-44`). Add New model, Add provider, Import models, New prompt, Set default model, Global variables, Timeouts.

### UI designer

- **AI-UI1 — Three primary colours and three button implementations.** Apps/Models/Prompts: `indigo-600 rounded-md`; Providers: `blue-600 rounded-lg`, "Test All" `bg-green-700` (`AdminProvidersPage.jsx:351`); "Add Variable" `bg-blue-600 rounded-sm` (`GlobalPromptVariablesEditor.jsx:185,236`). `formStyles.js` button classes are imported by none of these pages. Recommendation: a shared `<Button variant size icon>` on `formStyles`, one brand primary; replace ~60 inline class strings here.
- **AI-UI2 — Primary action placement varies.** Apps/Prompts: primary first plus 3–4 equal secondaries (Upload Config, Enable All, Disable All, Reorder); Models: primary + Import + ⋮; Integrations/Agents: primary last. Recommendation: the Models pattern everywhere — one primary, at most one secondary, the rest in `MoreActionsMenu`.
- **AI-UI3 — Editor headers are noisy.** App: Test · Open app · History · Download · Back to Apps (5 outline buttons, two rows with the Test panel open); Back duplicates the breadcrumb on every page. Recommendation: shared `AdminEditHeader` — title, status badge, [Test] [Open] [⋮ History / Download / Clone / Delete], no Back button. Fixes AI-B17's header overflow.
- **AI-UI4 — Save only at the bottom of very long forms** (app ≈7,000 px, model ≈3,800 px); labels differ ("Save"/"Save & Exit", "Save Changes", "Save Prompt"). Recommendation: sticky `AdminSaveBar` ("Unsaved changes · Discard · Save") on every `AdminEditPageShell` editor.
- **AI-UI5 — Mixed save models in one form.** "Group access … saved immediately" is the last card directly above Cancel/Save; Cancel does not revert it. Locked inherited chips are amber (warning) for a neutral state. Recommendation: move access out of the form into a header "Visible to: …" pill/drawer that is visibly instant; grey chips with a lock. Co-reported by admin (AI-ADMIN5 note), UX.
- **AI-UI6 — 23 cards of equal weight; two toggle idioms.** Five cards hold a single checkbox (Upload, Export, Compare, Feedback, Ephemeral); Web Search uses a `Switch`, everything else "Enable …" checkboxes. Recommendation: one "Chat features" card of switches; `Switch` for on/off, checkboxes for multi-select only.
- **AI-UI7 — List status is inconsistent.** Enable is an eye icon that never changes ([AdminAppsPage.jsx:541-543](../../client/src/features/admin/pages/AdminAppsPage.jsx)); "Disabled" is red on Apps, grey on Models; empty cells "N/A", "-", "—" or blank. Recommendation: inline `Switch` in the Status column (as on Users), `StatusBadge` with neutral Disabled, one "—"; app icon on its colour instead of a letter avatar.
- **AI-UI8 — Model editor hierarchy.** `max-w-4xl` with a 1/3 description column leaves ~240 px inputs and 10-line help columns ("Max Output Tokens"); two section patterns on one page (`AdminModelEditPage.jsx:441-590`); "API Model ID" value clipped. Recommendation: Enabled + Default switches in the header; Connection / Limits / Capabilities / Sampling / Reasoning / Output marking with the last three collapsed; one `AdminSection` component; one editor width (6xl); "Apps using this model" rows as links.
- **AI-UI9 — Providers look like another product.** No `AdminEditPageShell`; H1 `text-3xl font-bold` vs `text-2xl font-semibold`; `text-base` inputs; breadcrumb **and** back link; green inline success banner instead of a toast; API key below timeouts; hand-rolled list table with a full-width search and the timeouts card between search and results; two link colours. Recommendation: rebuild on the shell and `DataTable` + `DataTableRowActions`; order Name → API type + Base URL → API key with inline status → Test connection → collapsed Advanced (timeouts, gateway); timeouts card below the table.
- **AI-UI10 — Prompts tabs.** Hand-rolled tabs (vs `AdminTabs` with counts on Models/Integrations); the H1 changes per tab; Global context — a prefix to *every* system prompt — buried in Variables; neutral info in an amber box. Recommendation: `AdminTabs`, stable H1 "Prompts", a labelled Global context card with a blue info callout; add a Status column (the filter exists, the column doesn't).
- **AI-UI11 — Colour field** is a native `<input type=color>` stretched full width with no hex value. Recommendation: swatch + hex + preset palette with an avatar preview.
- **AI-UI12 — Patterns to spread:** `ModelsSetupStrip` (reads config, disappears when done), `ModelImportDialog`, `AppTestPanel` split view, URL-persisted filters (`useFilterState`), `AdminFormErrorSummary` anchor links.

### Technical writer

- **AI-TW1 — No page in this part links to the docs.** Only the sidebar, Cmd+K and the changelog link into `/admin/docs`; `utils/docsLinks.js` already resolves anchors; the "Learn more →" from the 2026-05 design brief (`:274`) was never built. Recommendation: a `DocsLink` "?" in card headers (map in §9). Co-reported by all.
- **AI-TW2 — Tasks are taught through JSON.** 6 of 14 core tasks are JSON-only, missing or wrong (coverage map §9). `local-llm-providers.md` (788 lines) never mentions the admin UI; `models.md:874-880` "Adding New Models" says to create a JSON file and check `server/adapters/`; `apps.md:25-31` Quick Start is a JSON file.
- **AI-TW3 — German: missing keys and term drift** (AI-B14). "Provider" (tab) vs "ANBIETER" (column); "Werkzeugnutzung" vs "Tool-Suche". Recommendation: add keys, pick one German term each ("Provider", "Tool", matching the nav), extend the existing `tests/unit/client/translation-keys-exist.test.jsx` (which already fails on keys missing from both files, but skips `client/src/features/admin` and every `admin.` key) to the admin area.
- **AI-TW4 — The fields that define an app have no explanation.** System Instructions: "System prompts that define the app behavior"; Prompt Template: no help, yet `{{content}}` and variables go there; variable Name: no hint; types "String / Text / Select". Rewrites in §9.
- **AI-TW5 — Hard model and provider fields have no hints:** "API URL \*" (base or full `/chat/completions`?), "Default Model" (ticking clears every other default, `models.js:676`; `models.md:862` still says "should"), Concurrency, Request Delay, Context Window; outdated placeholder "e.g., gpt-4, claude-3-opus"; Tool Calling help names specific models that will go stale.
- **AI-TW6 — One concept, several names.**

| Concept | UI | Docs |
|---|---|---|
| Provider's model name | "Model ID" / "API Model ID" | `admin-ui.md:207` describes the wrong field |
| Endpoint | model "API URL", provider "Base URL", import "endpoint URL" | mixed |
| System prompt | "System Instructions" | "System prompt" (`admin-ui.md:146`) |
| Access | "Group access" | "Permissions" (`admin-ui.md:151`) |
| Global variables | tab "Variables", heading "Global Prompt Variables" | "Global Variables" |
| Nav path | AI Workspace → Models → Providers tab | "Admin → Providers" (`models.md:31, 243, 325, 448`) |
| Create | "Create App" → "Add New App" → "New App"; "Add New Model"; "Add provider" → "Create New Provider"; "Create New Prompt" | — |

  Recommendation: one verb ("New app / model / provider / prompt"), one save pattern, real nav paths in docs, a glossary in `concepts.md`.
- **AI-TW7 — The wildcard explanation is a tooltip.** "Can use all apps through a wildcard. To withdraw a single one, an administrator replaces the wildcard…" lives in a `title` ([ContentAccessSection.jsx:264-270](../../client/src/features/admin/components/ContentAccessSection.jsx)). Recommendation: visible text above the chips with a link to the group editor and to the access guide.
- **AI-TW8 — Error copy.** The UI shows the server's `detail` ("Too many admin api requests from this IP…") rather than its friendlier `title`; test/import errors need translated "What to check" lines per `messageKey`, including a certificate case linking to the SSL whitelist (AI-B10).

### iHub admin

- **AI-ADMIN1 — Provider setup takes ~15 steps and re-entry** (task 1). The model URL is retyped (and must now include `/chat/completions`); "API Model ID" vs Azure deployment name is a guess; Test hides in the list ⋮ and exists neither on the model editor nor the provider page. Recommendation: W1 with live Test connection showing status, host and model count; prefill/inherit the model URL; Test buttons on the model editor and provider page.
- **AI-ADMIN2 — The wizard must be either short or complete, never halfway** (task 2). Today it collects half of an app and then drops you on the list. In the editor, dropdown options need label + value per row and the default is typed blind; an empty starter prompt disables Save. Recommendation: W2 (short) + option rows with "value = label" by default and a default-value picker.
- **AI-ADMIN3 — "Only HR" is the most common enterprise request and the UI can't express it** (task 2). Five groups hold `*`, and four of them inherit `authenticated` directly or through `users`; the admin would have to maintain explicit lists forever. See AI-PM1 and §10.
- **AI-ADMIN4 — Clones are look-alikes** (task 3): same name, free-text icon, carried parent link and Magic Prompt model (AI-B19). Recommendation: "Chat (copy)" / `chat-copy`, icon picker, readable list of what was copied. No wizard needed for clone.
- **AI-ADMIN5 — Every create throws the context away.** Provider (`AdminProviderCreatePage.jsx:82`), model (`AdminModelEditPage.jsx:337`) and app wizard (`:283`) return to the list. Recommendation: land on the new item with a next-step banner (provider → Import models; app → Variables, Access, Test).
- **AI-ADMIN6 — IDs follow different rules.** Provider IDs auto-slug from the name (`AdminProviderCreatePage.jsx:41`); app, model and prompt IDs are typed, with different rules (apps allow dots/underscores, max 50; prompt hint says lowercase + hyphens while the server also accepts dots and underscores). Recommendation: auto-slug everywhere with an edit affordance.
- **AI-ADMIN7 — What works:** the "Hidden from users until … is on" hints, the API-key status badges, variable detection with Describe, the Test panel, and the provider help text ("An LLM provider holds one API key for all of its models…") are exactly what an operator needs.

## 6. What should be rearranged

1. **App editor order by task, not by schema** (UX, UI, TW, admin; PM proposed tabs, see §10). Sticky left section index; sections at their defaults collapsed with a summary line:
   1. **Basics** — name, description, icon + colour, category (from `ui.json`), type
   2. **Instructions & inputs** — system instructions, prompt template, variables (with placeholder detection), starter prompts, greeting, usage guide
   3. **Model** — the merged block from AI-PM5
   4. **Knowledge & tools** — integrations, web search, tools, workflows, apps as tools, skills, projects
   5. **Chat features** — one card of switches: upload, export, compare, feedback, ephemeral, magic prompt, document template, AI notice
   6. **Input & voice** — input mode, microphone, voice
   7. **What users can change** (renamed "User Settings")
   
   **Enabled** and **Access** leave the form body: Enabled becomes a status switch in the header, Access a "Visible to: …" pill opening a drawer (AI-UI5). Sticky save bar at the bottom.
2. **Model editor:** header gets Enabled, Default and Test; body Connection → Limits → Capabilities → Sampling → Reasoning → Output marking (last three collapsed) → Access card (new). "Apps using this model" and usage statistics move to a right rail or a "Usage" tab.
3. **Provider editor:** API key directly under API type + Base URL, then Test connection; timeouts and gateway in a collapsed Advanced section; remove the disabled "Provider Enabled" checkbox.
4. **Providers list:** search → table → timeouts card (today the card sits between search and results); the "API Key Priority" box becomes a popover on the API key column header.
5. **Apps list toolbar:** one primary (New app); Upload Config, Enable All, Disable All and Reorder move into ⋮; replace the "Order" column (managed in Reorder mode) with "Access"; show "Default (Gemini Flash)" instead of "N/A".
6. **Prompts list:** hide `category: system` prompts (App Generator) behind a filter and from `/api/prompts`; add a Status column; rename the "Variables" tab to "Global variables (used in apps and prompts)".
7. **Providers stay a tab under Models** (admin wanted a sidebar entry, §10): fix the docs' "Admin → Providers". (Cmd+K already lists the Providers page, `AdminCommandPalette.jsx:14`; what is missing are the *tasks* "Add provider" / "Import models", AI-UX9.)
8. **Docs:** in `admin-ui.md`, move "Managing Providers" before "Managing Models", matching the setup strip's order.

## 7. Where another approach fits better

| Today | Proposed | Why |
|---|---|---|
| Template picker gated by `allowInheritance`, Clone writes unused `parentId` | Plain **Duplicate** from any app + a curated template gallery shipped in `server/defaults` (FAQ over iFinder, Translator, Document Q&A, Email composer) | Inheritance does nothing (AI-B19); the gate empties the picker (AI-B4) |
| Access only in group allow-lists with `*` | Visible "Visible to: …" summary on the item, a "Convert wildcard" helper (W3); later an item-level audience (decision, §10) | "Only HR" is the most common request and is impossible from the item (AI-PM1) |
| Save-to-test, apps live on first save | Draft status served only to admins in the Test panel; Publish; later preview of unsaved config | Testing = publishing today (AI-PM2) |
| Eye-icon row action; Enable All / Disable All buttons | Inline `Switch` per row; row selection with named bulk actions; ★ "Make default" on Models | One click affects every user (AI-B2); state invisible (AI-UI7) |
| Separate provider page, then list, then import | Connect-provider wizard for *creating*; shell-based page (not a drawer) for editing | The create flow is the error-prone part; editing is rare and needs history (AI-UX2) |
| Native `confirm()` / "Delete this app?" | Extend the existing shared `ConfirmDialog` (`shared/components/ConfirmDialog.jsx`, already used for app delete) to name the item, list dependants and point to History | Deletes break apps silently (AI-B12) |
| Single error headline + raw `ECONNREFUSED` | Test result as a checklist: key found ✓ · host reachable ✗ · certificate trusted ? · model accepted ? — each with a fix link | Admins can't act on today's errors (AI-B10) |
| Docs answer "why can't users see it" | An **Access check** diagnostic on the app and model (and the user page) | Only the server knows the full chain (AI-UX1) |
| Free-text icon, native colour input, hard-coded categories | `IconPicker`, preset palette with hex, categories from `ui.json` | Three controls for one concept (AI-UX8, AI-UI11, AI-B6) |
| Help text duplicated by hand in UI and docs | `DocsLink` opening the doc section in a side panel | The two disagree today (AI-B7, AI-B25) |
| Errors on mount | Validation on blur / first submit, Zod codes mapped to plain text | Forms open red (AI-B16) |

## 8. Wizards to add

**W1 — Connect a model provider** (highest value).
- **Starts from:** `ModelsSetupStrip` step 1, the Models empty state, "Add provider" on the Providers tab, Cmd+K; also replaces the provider step of `/setup`.
- **Who:** every first-time admin, and anyone adding a vendor.
- **Steps:**
  1. *Where are your models?* Tiles: OpenAI, Azure OpenAI, Anthropic, Google, Mistral, AWS Bedrock, OpenRouter, OpenAI-compatible gateway (LLM Hub), self-hosted (vLLM / LM Studio / Ollama), iFinder model gateway.
  2. *Connection:* tile-specific fields with examples (Azure: paste the deployment URL; self-hosted: base URL, "no key"); key, with the env-var alternative named.
  3. *Test connection:* calls the existing `_discover`; shows status, host and model count, or a mapped cause — DNS/unreachable, TLS/private CA (link to the SSL whitelist), 401/403 key rejected, 404 wrong path.
  4. *Pick models:* the existing `ModelImportDialog` list with detected context window, vision and tools.
  5. *Default model:* radio over picked chat models (explicit, unlike AI-B13).
  6. *Who can use them:* everyone, or groups (with the W3 explanation when wildcards exist).
- **Creates:** provider, models linked to it (endpoint and key inherited, AI-PM6), the default; ends on the provider page with a one-prompt smoke test and "Create an app with this model".
- **Replaces:** the 15-step loop of task 1; mostly wires existing pieces (`ModelImportDialog`, `ModelsSetupStrip`, provider test). Verifier: the first-run `/setup` wizard already has vendor tiles, a key field and **Test Connection** backed by `POST /api/setup/_test` (`server/routes/setup.js:111`, `adminAuth`), documented in `GETTING_STARTED.md:41-45` — W1 should grow out of that step rather than start anew.

**W2 — New app** (short; replaces template modal + 7-step wizard; one entry point for the button, `/admin/apps/new` and Cmd+K).
- **Who:** content admins creating an assistant; first-timers.
- **Steps:**
  1. *Start from:* Blank · Duplicate an existing app (searchable, all apps) · Template gallery · Describe it (AI).
  2. *Essentials:* name (ID auto-slugged, checked inline), description, `IconPicker`, category from `ui.json`, system instructions with live `{{placeholder}}` detection.
  3. *Model and audience:* preferred model from the **admin** model list with status badges (fixes AI-B9); "Everyone" or groups.
  4. *Create:* creates the app as a draft and opens the full editor at Instructions & inputs with the Test panel open and a next-steps checklist (variables, starters, access, publish). Prerequisite: the Test panel must run a draft or disabled app for admins; today it renders no chat for disabled apps (`AppTestPanel.jsx:213`, §10). Until that exists, the interim "create disabled" path opens the editor without the Test panel and says that testing needs the app enabled.
- **Validates:** ID uniqueness, base-language localized fields (fixes AI-B1 by construction), category, model availability.
- **Why short:** the full editor is where variables, starters and tools are configured; duplicating those steps is what produced AI-B1, B5 and B6 (§10).

**W3 — Restrict access** (mini-flow, launched from the Group access card or a model's Access card when wildcards cover the item).
- **Steps:** 1. Shows which groups grant the item through `*` and inheritance ("users → inherits authenticated → apps `*`"). 2. Proposes explicit lists minus this item, or "keep new apps visible by default?". 3. Preview: affected groups, users and items. 4. Apply, with an audit entry.
- **Replaces:** hand-editing four groups' wildcard lists. Becomes unnecessary if item-level audience is adopted (§10).

**Diagnostic, not a wizard — Access check** ("Why can't users see this?") on the app and model pages: pick a user or group → verdict with the reason chain. Answers task 6.

**Where a wizard would be wrong:** the app editor itself (power users edit one section at a time; needs an index, not steps), the model editor, cloning (a prefilled "(copy)" is enough), setting the default model (a row action), enabling/disabling (a switch), prompts (the form is short and its detection already guides), LLM timeouts, and global variables.

## 9. Documentation

**What exists and its quality**

| File | Quality |
|---|---|
| `docs/admin-ui.md` — Managing Apps (`:138-190`), Models, Providers, Prompts (`:237-243`) | Field lists, not walkthroughs. Wrong: templates, model **Hints** field, prompts as "system prompt templates" with 2 tabs. Right: Group access card (`:156`, `:280`), the list toggle (`:162`) and Test as a model-list row action (`:217`); see the appendix. Screenshots exist for the apps list, app start form, app projects card, models list, import dialog, providers list and provider create (stale); none for the app editor, model editor, provider edit, prompts. |
| `docs/apps.md` (~1,700 lines) | Thorough JSON reference. Quick Start is a JSON file; inheritance documented as working; troubleshooting wrong (AI-B15). |
| `docs/models.md` | Good import and timeout sections. No H1; default model and "Restricting Available Models" JSON-only; "Adding New Models" file-only; base URL claim wrong; nav path stale. |
| `docs/local-llm-providers.md` (788 lines) | JSON and env vars only; no admin UI, no SSL. |
| `docs/prompts.md` | File-first; `appId` wrong (`:40`). Has an `## Admin` section (`:233-243`) describing the three tabs, placeholder detection and Describe, but no create-a-prompt steps; a second, 2-line "Managing Prompts via Admin UI" (`:302-304`) duplicates it. |
| `docs/troubleshooting.md:397-410` | Only a `groups.json` snippet for missing apps. |
| `docs/GETTING_STARTED.md:41-57` | Teaches the first provider through the `/setup` wizard (key, Test Connection, Add your models) — the one UI-first walkthrough in this area; not linked from the Models tab. |

**Coverage map — can a new admin learn the task through the UI from the docs?** (TW, verified by admin)

| Task | Where | Rating |
|---|---|---|
| Add an API key to a built-in provider | GETTING_STARTED.md (via `/setup`), admin-ui.md#managing-providers | partial (setup-wizard path only; no steps for the Providers tab; stale screenshot) |
| Connect an OpenAI-compatible gateway | models.md custom providers + import | partial (manual path is JSON) |
| Connect Azure OpenAI | one paragraph in models.md:336 | partial; which API type and "API Model ID = deployment" never said |
| Connect a local LLM | local-llm-providers.md | JSON-only |
| Diagnose a failed model test | — | missing |
| Set the default model | models.md#model-selection-in-apps | JSON-only |
| Hide a model from a group | one bullet in admin-ui.md; concepts.md:40-51 table names the group `models` permission | partial (concept only, no UI steps) |
| LLM timeouts | admin-ui.md#managing-providers | good |
| Import models | models.md#importing-models | good |
| Create a chat app | admin-ui.md#managing-apps | partial (field list) |
| Dropdown variable, starter prompts | apps.md | JSON-only |
| Restrict an app to one group | admin-ui.md:280 | partial; it states the wildcard lock and "replace the wildcard", but not that the shipped groups hold wildcards, so following it is a group-editor project |
| Test an app | admin-ui.md "Testing an app" | good |
| Clone an app | — (search "clone" finds `git clone`) | missing |
| Prompt for one app | prompts.md | JSON-first and wrong |
| Global prompt variables | admin-ui.md, platform.md | partial |
| Why an app doesn't appear | apps.md troubleshooting | wrong |

**Proposed pages**
1. **`setup-first-model.md` — Connect your first AI model** (extends, and is linked from, `GETTING_STARTED.md` step 3). Before you start (key, URL, network, private CA → SSL whitelist) · Step 1 Models → Providers → Configure, add key, Test · Step 2 Import models, or add one manually (field table: API Model ID, API URL per provider) · Step 3 enable and make default · Recipes: OpenAI, Azure OpenAI (deployment name, api-version, which API type), OpenAI-compatible gateway, vLLM, LM Studio, Ollama · Troubleshooting: each test `messageKey` → cause → fix. Linked from the setup strip and W1.
2. **`app-quickstart.md` — Build your first app.** An assistant with one dropdown variable and two starter prompts, end to end, with screenshots; test it; enable it; give one group access; duplicate it and change model and icon.
3. **`access-control.md` — Who sees which apps, models and prompts** (shared with the Access & Identity report). Groups, inheritance, `authenticated`, wildcards, why chips are locked, replacing `*` without locking everyone out, content admins; checklist "an app / model / prompt doesn't appear" (enabled, features, integrations, group grant, preferred model permitted and keyed).
4. **Rewrites:** `prompts.md` admin section UI-first, `appId` corrected, file steps under "Reference"; `apps.md` Quick Start via the UI, troubleshooting replaced by the checklist, inheritance section removed or marked unsupported; `models.md` H1, nav paths, base URL, "Adding New Models" via the UI, a "Set the default / hide a model" section; `admin-ui.md` prompts definition and 3 tabs, remove the templates and Hints claims; `local-llm-providers.md` "Configure in the admin UI" before every JSON block; re-shoot `admin-provider-new.png`; screenshots for the app and model editors.

**Contextual help in the product (DocsLink targets)**

| Page / field | Link to |
|---|---|
| Setup strip, W1, provider form | `setup-first-model.md` (and `#azure-openai`) |
| Import dialog | `models.md#importing-models-from-an-endpoint` |
| Model test failure toast | `setup-first-model.md#troubleshooting` |
| App editor → Variables, Starter prompts | `apps.md#variable-types`, `#starter-prompts` |
| Group access card (apps, prompts, models) | `access-control.md` |
| Apps list "Hidden from users" hint, Access check | `access-control.md#checklist` |
| Prompts → Variables | `apps.md` global variables section |

**Help text to rewrite** (current → proposed)
- Provider create subtitle: "Create an LLM provider for your own endpoint, a web search provider, or a generic API key" → "Connect an LLM endpoint: a cloud API, a company gateway or a self-hosted server. All models of the provider share its API key."
- API type hint: add "Azure OpenAI: choose OpenAI-compatible and import from the URL you copied in Azure."
- System Instructions card: "System prompts that define the app behavior" → "Tells the model who it is and how to answer. Sent before every conversation."
- Prompt Template: (none) → "Optional. Wraps each user message. Write `{{content}}` where the message goes and `{{name}}` for each variable below."
- Variable Name: (none) → "Used as `{{name}}` in the prompt template. Letters, digits, underscores."
- Variable types: "String / Text / Select / Date / Number" → "Short text / Long text / Dropdown (choose one) / Date / Number / Yes-No"; "Predefined Values" → "Dropdown options".
- Model API URL: (none) → "Full URL of the chat endpoint, e.g. `https://api.openai.com/v1/chat/completions`. Easier: use Import models, which fills it in." (until AI-PM6 makes it inherited)
- Default Model: (none) → "Used by apps without a preferred model. Ticking it removes the default from {{current}}."
- Model API key: "API Key(Optional - leave empty to use environment variable)" → "Optional. Leave empty to use the provider's key, or else the `{{envVar}}` environment variable."
- Prompt Linked App: "Link this prompt to a specific app" → "Opens the prompt in this app and lists it first there. Other apps still offer it."
- Group access wildcard (tooltip → visible text): "All signed-in users can use this app through a wildcard in Users and Authenticated. To limit it, replace the wildcard — [Restrict access…]".
- Delete model: "Delete this model?" → "Delete model "{{name}}"? 3 apps use it as preferred model; they will fall back to the default model. You can restore it from History."

## 10. Where the panel disagreed

- **How to make "only these groups" possible.** PM: item-level audience that the authorization layer honours (changes what `*` means). Admin: an allow-list on the item that wins over group wildcards, or a deny list. UX: an Audience control plus a wildcard-conversion helper. TW: visible explanation plus a guide. UI: a header chip/popover. **Resolved:** now — visible explanation, model access card, W3 helper, Access check (non-breaking, all personas agree). The item-level audience is a semantic change to group wildcards affecting every install; per CLAUDE.md it goes to the user as a compat-vs-clean-break decision, jointly with the Access & Identity report's question about the shipped `authenticated: *` (ID §10).
- **New-app flow: short or complete?** PM: 3-step dialog → draft → editor. UX: 7-step W2 with variables, model, audience and Review & test. UI: 6 steps. Admin: "either short or complete, never halfway". **Resolved: short (W2, 4 steps)** ending in the full editor with Test open. Maintaining a second implementation of the editor's fields is what produced AI-B1, B5 and B6; the editor gets placeholder detection so variables follow naturally.
- **App editor: tabs or one page with an index?** PM: five tabs. UX, TW, admin: sticky index with collapse; UI: either. **Resolved: one page with a sticky index and collapsed defaults.** Tabs hide validation errors in other tabs, break the `AdminFormErrorSummary` anchors and Ctrl+F, and the Test panel already takes the right side.
- **Draft state.** PM and UX want Draft/Publish; UI and admin asked only for "create disabled". **Settled by code:** the Test panel renders no chat for disabled apps ([AppTestPanel.jsx:213](../../client/src/features/admin/components/AppTestPanel.jsx)), so "create disabled" doesn't give a testable draft. Draft needs server support (served to admins only); listed after the top 10, with "create disabled + allow admins to test disabled apps" as the cheap first step.
- **Prompt "Linked App": implement restriction or relabel?** UX/admin: either; PM: decide whether it's meant to be a feature. **Resolved: relabel and fix docs now** — the code deliberately ranks (`PromptSearch.jsx:54` "to rank its prompts first"); a "Show only in app" scope is a new feature only if customers ask.
- **Providers in the sidebar?** Admin looked for "Providers" under Integrations; UI rates the Models tab the best page. **Resolved: keep the tab**, fix the docs path and add Cmd+K entries; providers exist to serve models.
- **Provider form: drawer or page?** UI/UX: drawer. **Resolved:** creation moves into W1; the edit page stays a page (History, Test, linked models) rebuilt on the shell.
- **Severities.** Template picker: UX/UI P1, PM/admin P2 → **P2** (create from scratch and row Clone still work; it's a dead end, not a block). German gaps: TW P1 → **P2** (usable, no wrong outcome). Docs troubleshooting: TW P1 → **P2**. Borderless inputs: UI P1 → **P1**, consistent with ID-B7 (controls invisible in a core editor).
- **Facts settled by the lead.** Model "N/A": 27 of 28 apps (PM said 26). Editor sections: 22 cards for a chat app + Group access (PM 22, UI 23, admin 26 counted every `<h3>` incl. iframe/redirect-only sections). Prompt `appId` (TW Suspected) is Confirmed. Clone metadata (UX Suspected) is Confirmed unused. PM's "image upload dropped" is Confirmed but deliberate: the key was never read, so the checkbox is dead UI rather than a lost setting. Required asterisk on App ID: present on the edit page (`ui/crops/full-light-apps-edit-chat-0.png`), missing where the schema hadn't loaded (`BasicInfoSection.jsx:48`) — both observations are true.

## 11. Top recommendations

| # | Recommendation | Why | Impact H/M/L | Effort S/M/L | Type |
|---|---|---|---|---|---|
| 1 | **Unblock app creation now:** write wizard fields under the base language (or `load: 'languageOnly'` + `supportedLngs`) (AI-B1); list every app as a duplicate source or drop the template modal (AI-B4); categories from `ui.json` (AI-B6); remove the dead image-upload box; land on the new app's editor with a toast | The first thing a new admin clicks fails on most browsers | H | S | fix |
| 2 | **Defuse bulk actions:** Enable All / Disable All into ⋮ on Apps and Prompts (Models already has them there) with a confirm naming counts ("9 disabled apps will be enabled"); keep the default model on disable; notice when a default is auto-assigned (AI-B2, AI-B13) | One click changes what every user sees, irreversibly | H | S | fix |
| 3 | **Actionable connection errors:** builds on the existing `messageKey` mapping (`models.js:121-240`, `translateDiscoveryError`) — add status and host to Import and model Test, an upstream-5xx and a TLS/private-CA case (→ SSL whitelist link), map the app Test panel's errors, translate the remediation lines; fix the keyless `local-vllm` test (AI-B10) | Admins can't get from an error to the fix | H | S | fix |
| 4 | **Shared form controls and buttons** (`Input`/`Select`/`Textarea`/`Button` on `formStyles`) across `app-form/*`, `ModelFormEditor`, `PromptFormEditor`, Providers; same change as ID-B7 in Access & Identity | Fixes borderless inputs, invisible dark labels, double asterisks, unlinked labels, three primaries (AI-B3, B16, B18, AI-UI1) | H | M | UI |
| 5 | **Make access legible:** visible wildcard text, Group access card on models, W3 "Restrict access" helper, Availability/Access check on app and model pages; ask the user to decide on item-level audience (AI-PM1, AI-UX1) | Tasks 2, 4 and 6 fail or stall on this | H | M | UX |
| 6 | **Connect-a-provider wizard (W1)**, grown from the `/setup` provider step (tiles + `POST /api/setup/_test`), with Test connection, Azure/Bedrock/self-hosted tiles, import, explicit default; models inherit the provider's endpoint and key; land on the provider after create (AI-UX2, AI-PM6, AI-PM7) | Task 1 drops from ~15 steps to ~6 | H | M | wizard |
| 7 | **Three UI-first guides + fix wrong docs + DocsLinks:** `setup-first-model` (extending `GETTING_STARTED.md`), `app-quickstart`, `access-control`; correct troubleshooting, prompt `appId`, base URL, `admin-ui.md` prompts/templates/Hints, `models.md` H1 and paths; "?" links per card (AI-TW1, AI-TW2, AI-B15, AI-B25) | An admin who doesn't know how can today only learn JSON | H | M | docs |
| 8 | **App editor structure:** sticky section index and sticky save bar by reusing `AdminSettingsPage.jsx` (already has both, used by Security), collapsed defaults, one "Chat features" card, Enabled and Access out of the form body; one short creation path (W2) replacing the wizard's duplicate steps (AI-UX3, AI-UI4–6, AI-PM3) | The most-used editor is a 7,000 px scroll with two save models | H | M | IA |
| 9 | **Model lifecycle in the list and editor:** inline enable Switch (`shared/components/Switch.jsx`), ★ Make default, Test on the editor and provider page, admin model list in the app editor (AI-B9; `fetchAdminModels` already exists, `api/adminApi.js:142`), dependency-aware delete dialogs on `ConfirmDialog` (AI-B12), hide/stop serving the App Generator prompt (AI-B8) | Task 4 needs hunting; deletes break apps silently | M | S | UX |
| 10 | **German completeness:** add the 287 missing keys, unify terms, and drop the `features/admin` / `admin.` exclusions from the existing `translation-keys-exist.test.jsx` so CI catches new gaps (AI-B14) | German customers see a half-English admin | M | M | fix |

Next after the top 10: Draft/Publish for apps (AI-PM2), bulk row actions (AI-PM8), the merged Model block (AI-PM5), exposing model `hint` and `supportsTemperature` (AI-PM4), Providers rebuilt on `DataTable` and the shell (AI-UI9), Cmd+K tasks (AI-UX9).

## Appendix — verification log

The lead re-checked disputed and single-source claims (`lead/check.js` in the scratch folder; one login, read-only API calls plus one model test).

- **AI-B1 locale bug** (PM didn't hit it): Confirmed in code — `useState(i18n.language || 'en')` at `AppCreationWizard.jsx:605, 854, 1134`; LanguageDetector with no `supportedLngs` / `load` (`i18nService.js:72-96`). Two independent repros (UX, admin).
- **AI-B4 templates:** live `{"items":[]}`; all 28 apps return `allowInheritance: false` after schema defaults; 0 have `true`.
- **AI-B5 wizard types and image upload:** wizard options string/text/number/boolean (`:1422-1425`); editor string/text/select/date/number (`VariablesSection.jsx:232-236`). `imageUpload` is deliberately stripped (`appWizardPayload.js:20-29` comment: "this top-level key was never read") — the checkbox is dead UI.
- **AI-B7 prompt `appId`:** only a sort in `PromptSearch.jsx:130-141`; no server filter found (grep in `server/services/PromptService.js`, `dataRoutes.js`). TW's Suspected → Confirmed.
- **AI-B8:** live `GET /api/prompts` contains `app-generator`.
- **AI-B9:** `AdminAppEditPage.jsx:51` → `fetchModels` → `apiClient.get('/models')` (public). Live: 3 models, 0 enabled, so the app editor's Preferred Model list is empty.
- **AI-B10:** live `POST /api/admin/models/local-vllm/_test` → 500 `AUTH_FAILED`, title "…rejected the server's credentials. Please contact your administrator.", detail "API key not configured", remediation "API key not found for provider: local".
- **AI-B2 default handling:** `models.js:775` clears `default` on disable; `:780` `ensureStoredDefault()` promotes the first enabled chat model.
- **AI-B3:** looked at `ui/crops/full-light-apps-edit-chat-0.png` — App ID, Order, Preferred Model, Output Format have no border; `client/package.json` Tailwind `^4.3.3`, no forms plugin; `App.css` dark rules give only a background.
- **AI-B25 base URL:** `baseUrl` is read only by `adapters/iassistant-conversation.js` and `google.js` among adapters; nothing in `services/inference/` or `services/loop/` reads a provider base URL.
- **AI-PM2 test of disabled apps:** `AppTestPanel.jsx:164, 213` render the chat only when `enabled`.
- **Groups:** `admins`, `users`, `authenticated`, `agent-operators`, `content-admins` hold `apps: ["*"]`; `content-admins` has `models: []`; `users`, `agents`, `agent-operators`, `content-admins` inherit `authenticated`; `admins`, `browser-extension`, `nextcloud-embed` inherit `users`.
- **Counts:** 1 of 28 apps has `preferredModel` (Model "N/A" for 27). `AppFormEditor` + `app-form/*` contain 26 `<h3>` sections; a chat app shows 22 + Group access.
- No entities were created by the lead. Panel cleanup was reported complete by UX and admin (all DELETEs 204).

### Adversarial verification

A second pass by an adversarial verifier on 2026-11-12 tried to refute every row in §4 and checked every §8 and §11 item against the code to see whether it already exists. Scripts and screenshots are in `apps-models-prompts/verify/` in the scratch folder (`v1.js`, `v2.js`, `v3.js`). Two logins, read-only API calls, one model test, and one wizard run that the server rejected as expected (`GET /api/admin/apps/zz-apps-models-prompts-v1` → 404). Nothing was created or left behind.

**Result:** all 25 rows in §4 hold: Confirmed by code or reproduction, none downgraded to Suspected. Four sub-claims inside rows were refuted and removed, three statements elsewhere were corrected, and eight recommendations were narrowed because part of what they ask for already exists.

**Refuted or removed (one line each)**
- **AI-B10, "Model Test on an unreachable host says 'internal error'"**: Refuted (environment). In this sandbox the outbound proxy answers unknown hosts with HTTP 502, which the server maps to the upstream-5xx headline. On a real network, refused, unresolvable and timed-out hosts get their own translated headlines (`server/routes/admin/models.js:121-140`). What remains is the generic wording for a real upstream 5xx, which is still in the row.
- **AI-B23, "missing space 'API Key(Optional…'"**: Refuted. The text is on the provider page (`AdminProviderEditPage.jsx:254-260`), where the parenthetical is a separate `<span class="ml-2">` and so is visually spaced. The run-together text came from `innerText` extraction.
- **AI-B25, admin-ui.md promises a list "toggle"**: Refuted. The apps list has an eye-icon toggle row action, and `admin-ui.md:162` describes it correctly.
- **AI-B25, admin-ui.md "Test on the model list page" is wrong**: Refuted. Test is a row action on the model list (`AdminModelsPage.jsx:411-417`), so `admin-ui.md:217` is correct.
- **AI-PM7, "Bedrock and OpenRouter are invisible"**: Narrowed. Both ship in `providers.json`, appear on the Providers tab and are named in `admin-ui.md:223`. Only the `/setup` tiles lack them. Azure is still invisible.
- **§6 item 7, "add Providers to Cmd+K"**: Already done (`AdminCommandPalette.jsx:14`). Only the *task* entries are missing (AI-UX9).
- **§9, prompts.md "Admin UI in 2 lines"**: Wrong. `prompts.md:233-243` has an `## Admin` section covering the three tabs, placeholder detection and Describe. What is missing is step-by-step creation.

**Corrected references**
- AI-B13: the create path promotes the default in `server/resourceLoaders.js:41-49`, not in `ensureStoredDefault`, which runs only on toggle and delete (`models.js:780, 806`).
- AI-B23: the key lookup order is at `server/utils.js:166-195` (model key, then provider key, then env vars), not `:125`.
- AI-B25 and AI-TW6: Hints is at `admin-ui.md:211`, not `:205`, and the model ID text is at `:207`.
- AI-PM2: the clone advice is at `admin-ui.md:185`, not `:178`.
- Task 4: `content-admins` is not the only group without `models: ["*"]`. `browser-extension`, `nextcloud-embed` (`[]`) and `anonymous` (explicit list) also lack it.

**Already implemented, so the recommendation was narrowed (§7, §8, §11)**
- Sticky section index and sticky save bar: `client/src/features/admin/components/AdminSettingsPage.jsx` already has both (used by `AdminSecurityPage.jsx`). Rec 8 now says to reuse it.
- German CI check: `tests/unit/client/translation-keys-exist.test.jsx` already fails on keys missing from both locales, but it skips `features/admin` and all `admin.` keys. Rec 10 and AI-TW3 now say to extend it.
- Admin model list for the app editor: `fetchAdminModels` already exists (`client/src/api/adminApi.js:142`), so AI-B9 is a one-call swap. Rec 9 is updated.
- Shared `Switch` and `ConfirmDialog` exist in `client/src/shared/components/`. Deletes already write History snapshots (`models.js:813`, `apps.js:1141`). Rec 9 and §7 now say to extend these.
- Connection-error mapping: `messageKey` headlines with translations already exist (`models.js:121-240`, `modelImport.js:119-122`). Rec 3 is narrowed to status and host, a TLS case, upstream 5xx, the app Test panel and the keyless bug.
- W1: the `/setup` wizard already has vendor tiles, a key field and Test Connection (`POST /api/setup/_test`, `server/routes/setup.js:111`), documented in `GETTING_STARTED.md:41-45`. W1 and rec 6 now build on it.
- Docs: `GETTING_STARTED.md` teaches the first provider through the UI. `concepts.md:40-51` names the group `models` permission, and `admin-ui.md:280` explains the wildcard lock. The §9 coverage map and proposed page 1 are adjusted.
- Not found anywhere, so the recommendation stands as written: W2 short flow (only the 7-step wizard exists), W3 wildcard helper, an Access check or explain endpoint (no `explain` or `effectivePermissions` in `server/` or `client/`), a Group access card on models (`ContentAccessSection` serves apps, prompts, skills and workflows only), Test on the model editor and provider page (the provider page has only a dangling "Connectivity test state" comment, `AdminProviderEditPage.jsx:54`), DocsLinks from these pages (no `/admin/docs` link in any in-scope page), a shared `Button`, Set as default, and bulk-action confirms.

**How each row was checked**
- **Live reproductions:** AI-B1 (wizard in an `en-US` context), AI-B4 (`GET /api/admin/apps/templates` → `{"items":[]}`, picker screenshot `verify/b4-template-picker.png`), AI-B8 (`/api/prompts` contains `app-generator`), AI-B9 (`/api/models` → `{"items":[]}` with 0 of 3 models enabled), AI-B10 (local-vllm test → 500 `AUTH_FAILED`, key-status `local: keyless`), AI-B11 (route-intercepted 500), AI-B16 (`/admin/apps/new` on load), AI-B3 (computed border of 0 px).
- **Code re-read at the cited lines:** AI-B2, B5, B6, B7, B12, B13, B14 (re-counted), B15, B18, B19 (i18n keys absent, so single-brace fallbacks render literally), B20, B21 (`inspectProviderApiKey` returns `keyless`, which `getSetupSteps` doesn't count), B22, B23, B24, B25.
- **Screenshots looked at:** AI-B17 (`ui/crops/m-pair1.png`, the providers table scrolls sideways at 390 px), the AI-B10 import and test screenshots.
- **Docs gaps:** grep of `docs/` for every §9 claim, which led to the corrections above. `docs/local-llm-providers.md` has no mention of "admin" or "SSL", confirmed.
