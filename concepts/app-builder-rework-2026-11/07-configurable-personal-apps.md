# Increment 3: configurable personal apps, and a builder that configures them

**Date:** 2026-11-24 · **Builds on:** [02-personal-apps.md](02-personal-apps.md),
[03-chat-based-app-builder.md](03-chat-based-app-builder.md),
[04-chat-builder-implementation-plan.md](04-chat-builder-implementation-plan.md) · **Status:** design,
not reviewed yet

## Summary

A personal app today stores 11 keys, and the conversational builder changes 9 of them. The owner
asked for more of the admin functionality in personal apps, with the conversation builder able to
set it. The access list ("who can use it") stays out of scope, because the share dialog owns it.

This document proposes the following:

1. **Open the allow-list further, key by key.** `USER_APP_FIELD_POLICY` gives every key of the app
   schema a verdict. 37 keys have the verdict `never`. We move a chosen set to `content` (the author
   sets it) or `capability` (the author sets it, an admin switch gates it, the ceiling decides at
   run time). Section 2.2 lists the keys.
2. **Add one registry of configurable keys** so a new setting costs one entry and not edits in six
   files (section 2.1).
3. **Let personal apps link projects**, with the rule that an app never widens access to a project
   (section 2.4). One part of this needs the owner's decision: a narrow exception to "every tool call
   asks" for iHub's own read-only tools (section 7, decision 1). Without it, a shared knowledge app
   shows an approval card for every search.
4. **Let the builder propose every configurable key** for both targets, admin and personal. Anything
   that adds cost, data reach or access arrives as a separate unticked item the author ticks
   (section 2.6).
5. **Keep the simple personal editor.** It gets a collapsed "Advanced" group that shares its input
   controls with the admin editor (section 2.5).

## Answers of the owner

| Question | Answer | Effect |
|---|---|---|
| Are projects in scope? | Yes. | Section 2.4 is part of this increment. |
| One admin switch per capability, or one "advanced" switch? | Per capability, grouped (my recommendation, accepted). | Section 2.3. |

The first request also said: besides "who can use it" and maybe the model, allow configuration. I
read this as "everything except access, and the model only where it is safe". The model rules are in
section 2.2.

## 1. Today

All statements in this section were read in the code on 2026-11-24.

- **Stored content.** `USER_APP_CONTENT_KEYS` (`shared/userAppContent.js`) has 11 keys: name,
  description, system, icon, color, prompt, messagePlaceholder, variables, starterPrompts,
  preferredModel, capabilities. `capabilities` holds `upload`, `webSearch`, `skills` (booleans) and
  `integrations` (a list of installation IDs with named actions).
- **Verdicts.** `USER_APP_FIELD_POLICY` has 9 `content`, 7 `capability`, 7 `fixed` and 37 `never`
  keys. A test fails when a schema key has no verdict.
- **Ceiling.** `effectiveUserApp` (`server/services/userApps/ceiling.js`) builds the app object of
  every chat. It copies content keys one by one and writes each capability only when the app asks for
  it, the installation allows it, the owner may use it and the person chatting may use it.
  `checkCapabilitiesForSave` runs the same test when someone saves.
- **Approval.** For the owner the mode is `writes`. For everyone else it is `always`: every tool
  call asks, reads included, and "allow for this chat" is not offered (02 section 6.3).
- **Projects.** `projects` is `never`. `personalAppBase` sets `features: { projects: false,
  userProjects: false }`, so a chat of a personal app uses no project.
- **Builder.** `appRevisionKeys('personal')` is the content keys without `preferredModel` and
  `capabilities`. `appRevisionKeys('admin')` is 10 content keys (`shared/appRevision.js`). A turn
  answers `question`, `change` or `message`. A `change` has a `patch` (content keys only) and
  `suggestions: { websearch, integrations }`, which never enter the patch. The card shows
  suggestions as unticked boxes. 03 section 3.6 says: "The builder sets no model."
- **Admin builder.** The admin target cannot set web search, upload, model, integrations or
  projects either. This increment widens both targets.

## 2. Design

### 2.1 One registry of configurable keys

**Problem.** Adding a setting today means editing the following places by hand:

- `contentShape` in `server/validators/userAppSchema.js`
- the key lists in `shared/userAppContent.js`
- `ceiling.js` (copies key by key)
- `pickUserAppContent` (draft to content)
- `ADMIN_REVISION_KEYS` and `PERSONAL_REVISION_KEYS` in `shared/appRevision.js`
- the publish copy (`publishUserApp.js`)
- the editor form (`userAppForm.js`)

A key forgotten in one place produces a setting that saves but does not run, runs but does not
publish, or shows in the editor but never reaches the builder.

**Proposal.** A new module `shared/userAppFields.js` holds one plain-data descriptor per
configurable key. A descriptor has:

- `key`
- `verdict` (`content` or `capability`)
- `targets` (`admin`, `personal` or both)
- `limits` (references into `USER_APP_LIMITS`)
- `gate` (the path in `platform.userApps` that switches it on, or none)
- `proposal` (`direct` or `confirm`, section 2.6)
- the i18n keys of label and help, and a one-line description for the builder prompt

The lists above (content keys, run keys, revision keys per target, form order, builder catalogue)
are derived from the descriptors. The Zod schemas stay hand-written, because a schema generated
from data is harder to read and review. A drift test fails when a descriptor key is missing from the
schema, the ceiling, the picker, the publish copy or the form.

Confidence: high that the drift test is worth it. Medium that deriving the lists is enough. If slice
0 shows that a data-driven schema would be clearer, switch.

### 2.2 Which keys

I read the schema comments (`server/validators/appConfigSchema.js`) for each key below. I did not
trace every key through the client and the chat path. Slice 1 starts by doing that for the keys
marked "verify".

**Tier A: `content`. The author sets it; it adds no cost and no reach; no admin switch.**

| Key | What it is | Personal form | Note |
|---|---|---|---|
| `greeting` | Title and subtitle on the empty chat, per language | Same shape. Title at most 80, subtitle at most 200 characters. | Text passes `stripHiddenCharacters` like every personal text. |
| `inputMode` | Input line: single or multi line, number of rows | `type`, `rows` only. The microphone block stays fixed. | |
| `startForm`, `variablesPanel` | How the input fields are laid out | Same shape. | Verify that neither carries markup. |
| `preferredOutputFormat` | How the answer is rendered | `markdown` or `text` only. | `json` and `html` stay `never`: they change the renderer. |
| `autoStart` | Sends the first message without the person typing | Same. | Decision 3 in section 7. |

**Tier B: `capability`. An admin switch gates it and the ceiling decides.**

| Key | Personal form | Gate in `platform.userApps.capabilities` | Ceiling rule |
|---|---|---|---|
| `thinking` | `capabilities.thinking: { level }` | `thinking` (boolean) | Dropped when the model does not support it. The level is cut to `thinkingMaxLevel`. |
| `imageGeneration` | `capabilities.imageGeneration` (boolean) | `imageGeneration` | Needs an image model that owner and runner may both use. |
| Web search tuning | `capabilities.webSearchSettings: { maxSearches, maxPageReads, researchGuidance }`, next to the existing `webSearch` boolean | existing `webSearch`, plus `webSearchLimits: { maxSearches, maxPageReads }` | Numbers are cut to the admin limits. `researchGuidance` is at most 1,000 characters (the admin schema allows 4,000) and is cleaned of hidden characters. |
| Models | `capabilities.models: { allowed: [id], lock: boolean }`, next to `preferredModel` | existing `modelChoice` | `allowed` is cut to the models that owner and runner both may use. If nothing is left, the chat of this runner does not start and says why (reason `modelNotAvailable`). Dropping the restriction instead would give the runner a model the author excluded, and the ceiling only ever removes things. `lock` hides the model picker and works the same way: if `preferredModel` is not usable for the runner, the chat does not start. At save time the same test refuses an app the owner could not run themselves. |
| Skills, by list | `capabilities.skillIds: [id]` narrows the granted skills | existing `skills` | A list can only narrow what the boolean grants. |
| Projects | `capabilities.projects: [{ id }]` | `projects` | Section 2.4. |

The model stays under the existing `modelChoice` switch. My answer to the owner's "maybe the model":
narrowing the list or locking one model is safe, because the ceiling only ever removes models.
Widening beyond what the person chatting may use is not possible and is not offered.

**Never. These stay `never`.**

- `type`, `redirectConfig`, `iframeConfig`, `customResponseRenderer`, `rendererConfig`,
  `outputSchema`: they change what the app is or how an answer is rendered.
- `workflows`, `apps`, `iassistant`, `toolChoice`, `toolSearch`: they add tools or chain apps.
  iFinder knowledge reaches personal apps through smart collections, which are projects (section 2.4).
- `toolApproval`: only the ceiling sets it, by who is chatting.
- `aiDisclosure`: the first-turn notice of Art. 50(1) EU AI Act comes from the platform. An author
  must not switch it off.
- `ephemeral`, `uploads.storageMode`: retention and storage are administrator policy.
- `documentTemplate`, `allowUserTemplateUploads`: they belong with the document skills; not now.
- `category`, `order`, `requiredFeatures`, `requiredIntegrations`, inheritance keys, `enabled`,
  `sourceUserAppId`, `usageGuide` (verify; it looks like an admin help text): administrator or
  system data.

### 2.3 Admin switches

`platform.userApps.capabilities` has `modelChoice`, `upload`, `webSearch`, `skills` and
`integrations`. This increment adds `thinking`, `imageGeneration`, `projects` (booleans) and
`webSearchLimits`. All new switches default to off, like `webSearch` and `skills` today. Tier A keys
have no switch.

`UserAppSettingsPanel` gets one group, "Advanced app settings", with one switch per capability and
the two limits. The admin schema `userAppSettingsSchema` gains the same keys; it stays `strict`.

A migration is needed unless `userAppSettings()` already fills missing keys with these defaults.
Slice 0 checks that; the `create-migration` skill decides.

### 2.4 Projects

**Today:** a personal app links no project. **With this increment:** the owner links up to 3
projects (`USER_APP_LIMITS.projects`), user projects and admin projects alike. The project's own
default knowledge mode applies. A per-link mode is a later step.

The rule is that an app never gives anyone access to a project. A project is used in a run only when
the person chatting may use it in their own right.

| Moment | Check | Where it lives |
|---|---|---|
| Save | The admin switch `projects` is on, the project exists, the platform features `projects` (and `userProjects` for a user project) are on, and the person saving may use the project. | New rows in `checkCapabilitiesForSave`; the use test is `projectPermissions(...).canUse`. |
| Run, owner side | The owner may still use the project. If not, the link is withheld with the reason `ownerMayNot`. | `effectiveUserApp`, same owner lookup as the other capabilities. |
| Run, runner side | The person chatting may use the project. If not, the link gives nothing. | Exists already: `resolveProjectScope` skips a project when `permissions.canUse` is false and says nothing. |

Admin projects cannot be opened through a personal app. `linkedProjectIds` finds the admin projects a
person reaches through apps from `configCache.getApps()`, and personal apps are not in that cache.
So the person chatting needs access to the admin project in their own right, for example because it
is global.

**What the owner sees.** Sharing an app with five people of whom two are project members gives three
of them the app without documents. The editor says so next to the picker ("People who are not
members of this project get no documents from it"). Sharing the project with the same people is a
separate step; a shortcut for it is not part of this increment.

**Two code changes this needs.**

1. **A linked user project is dark today.** In `resolveProjectScope`, a user project is skipped
   when `appAllowsUserProjects(appConfig)` is false, and `personalAppBase` sets
   `features.userProjects: false` so the person chatting cannot attach their own projects to a chat
   that follows another person's instructions. Proposal: the ceiling writes the granted links to
   `projects` and sets `features.projects: true`. `resolveProjectScope` lets entries with
   `origin: 'app'` of an app with a personal ID (`isUserAppId`) pass the `userProjects` check.
   Chat attachments and chat containers stay blocked for personal apps. Slice K2 verifies that no
   attachment path opens; the `appUsesProjects` block in `resolveProjectScope` covers links,
   attachments and containers together, so this needs a test, not an assumption.
2. **Project instructions.** For an app link, the instructions of the project go into the system
   prompt. Their authors are the project's owners and editors, who are not necessarily the app's
   owner, and they can change without any revision of the app. In a shared app that is text from a
   third person steering someone else's chat. Decision taken alone: for personal apps the project
   instructions are not injected (`instructions: false` for the entry). The author writes how to use
   the knowledge into the app's own instructions. Reversible; see section 7.

**Approval cards.** `default: 'always'` makes every tool call of a shared app ask, including
`knowledge_search` and `knowledge_read`. The knowledge tool is added automatically whenever a project
is in scope, in every knowledge mode. A shared app that answers from a handbook would show one card
per search. The part of `server/defaults/tools/knowledge.json` I read declares no `sideEffect` or
`dataFlow`.

Proposal (section 7, decision 1):

- Declare `sideEffect: read` and `dataFlow: internal` on the knowledge functions.
- In personal apps, a call to a tool shipped with iHub (`server/defaults/tools`) that is declared
  internal and read-only does not ask, for any runner. The data it returns stays in the chat and
  comes from projects the runner may read.
- `read_url`, web search, every integration and every tool not shipped with iHub keep asking.
  An instruction that chains a search with `read_url` still shows a card with the address.

This is a narrow form of "approval by data flow", which 02 section 20 deferred. The reason it is
needed now is that projects make internal reads the common case.

**iFinder.** A smart collection of the iFinder tier is a user project that is loaded with the
person's own rights (`ProjectScope.js`). Personal apps therefore reach iFinder knowledge through
this feature with the same rule, and `iassistant` stays `never`.

### 2.5 Editor

Today the personal editor has the sections Basics and Extras (`UserAppBasicsSection`,
`UserAppExtrasSection`). Extras already imports its classes from the admin `formStyles`.

- A collapsed group "Advanced" holds Tier A and the Tier B settings. A setting whose gate is off is
  not shown, as the editor today does not offer what would fail.
- Leaf controls (text per language, number, switch, picker) are shared with the admin editor.
  Sections stay separate.
- The project picker lists projects the person may use, with name, description and size, and the
  note from section 2.4.
- Decision P21 of 02 stands: the personal page is not the admin editor with fewer groups. Revisit it
  if Advanced grows to hold most of the admin form. At that point one editor with two profiles is
  simpler than two pages.

### 2.6 Builder

**Today:** the builder patches content keys. Cost and reach come back as `suggestions` for web search
and integrations only.

**With this increment:**

- `appRevisionKeys(target)` derives from the registry. A key is revisable for a target when its
  descriptor lists that target.
- Each descriptor has `proposal`. `direct` keys (Tier A) are part of the `patch`, as content keys are
  today, and the author applies the whole change with the card's Apply button. `confirm` keys
  (every Tier B key, projects, integrations) are never in the patch. They arrive as separate unticked
  items in the card, each with a plain sentence of what it turns on and what it costs ("Turns on web
  search. The app then sends search queries to the search engine."). The author ticks the ones they
  want.
- The response gains `suggestions.settings: [{ key, value }]`. The existing `websearch` and
  `integrations` members stay. The change is additive, so no compatibility shim is needed. The
  response shapes in `tests/contract/response-shapes.json` get the new member.
- Applying sends the merged content to `PATCH /api/apps/{id}`. The server runs
  `checkCapabilitiesForSave` and refuses with `USER_APP_CAPABILITY_DENIED` per capability. The
  builder therefore cannot grant anything: it can ask for everything, the ceiling answers.
- The model gets a catalogue of the settings this caller may set (gate on, ceiling allows), with one
  line each. It also gets the lists to choose from: models both may use (ID, name, whether it
  supports tools) and projects the caller may use (ID, name, description, size), each capped at 20.
  Names and descriptions pass `stripHiddenCharacters`, because other people wrote them.
- Server rules for proposals: a model that cannot call tools is dropped when the app binds an
  integration; a project the actor may not use is dropped; `write` on a project link is never
  proposed.
- The builder still cannot share, publish, hand over, delete, or change access. It names the button,
  as in 03 section 3.6.
- The admin target uses the same engine with its descriptors. It validates against the merged full
  app with `appConfigSchema`, as 03 section 5.1 step 6 says. No ceiling applies, but `confirm` items
  stay confirm items.

Cost: the catalogue lengthens every turn. Slice S1 measures prompt size per turn with the evaluation
of 03 section 8 and sets the caps. The rate limit stays at 60 turns per hour.

Gating: the builder routes stay behind the features `appGenerator` and `appBuilderChat` (preview,
off by default), which the merged builder already uses. The new proposals add no feature of their
own.

### 2.7 Publish

`publishUserApp.js` writes the granted capabilities as ordinary app config. The new keys map as
follows:

- Tier A keys are copied to the company app with the same names.
- Tier B keys are written as the ceiling grants them for the owner at that moment, as web search and
  skills are today.
- **Projects need a rule of their own.** A published company app that links an admin project gives
  every person who can use the app access to that project (`linkedProjectIds`). The owner may not
  have the right to widen access. So a published app with an admin-project link starts switched off
  and an admin switches it on after seeing the linked projects, like web search, skills and
  connected systems today (`publishing.adminEnables: 'withTools'` counts projects with tools).
  Links to user projects are not carried over. The publish dialog says which links were left out and
  why, because a company app that links a private project would answer without documents for
  everyone who is not a member.

## 3. Earlier decisions that change

| Earlier decision | New state |
|---|---|
| 02 P4: personal content is an allow-list of 11 keys | The allow-list grows by the keys of section 2.2. It stays an allow-list. |
| 02 P21: the editor is a page of its own | Stays; gains the Advanced group. |
| 02 P23: a personal app links no project | Replaced by section 2.4. |
| 02 section 6.3, approval row | Exception for internal read-only tools shipped with iHub (decision 1). |
| 02 section 20, "Next": a knowledge source, approval by data flow | Built here, in the narrow forms above. |
| 03 section 3.6: "The builder sets no model" and no capabilities | The builder proposes model, capabilities and projects as unticked items. It still never sets them without the author. |

## 4. Security

The reasoning of 02 section 6.4 applies unchanged: the instructions of a shared app steer the tools
of the person chatting.

- **Reach keys follow "both".** Every Tier B key and projects must pass the ceiling for owner and
  runner, at save and at run time.
- **New author texts.** `greeting` and `researchGuidance` pass `stripHiddenCharacters` and the length
  caps. Others read `greeting`, so it falls under the existing notice in the chat that names the
  owner and says that administrators did not check the app. "About this answer" shows the linked
  projects.
- **Projects.** No new access is created (section 2.4). The remaining exposure is that an app's
  instructions can steer a search through documents the runner may read. The documents reach the
  model; any step that sends data out (web search, `read_url`, an integration) still asks.
- **Builder.** It only proposes. Server filters and the save check bound it.
- **Never keys.** `aiDisclosure`, `toolApproval` and the renderer keys stay out so the guarantees of
  02 hold.

## 5. Compatibility, migration, documentation, tests

- **Data.** Stored content only gains keys, and `capabilities` gains keys with defaults
  (`prefault`). Existing records stay valid. Verdicts of moved keys in `USER_APP_FIELD_POLICY`
  change, so the tests that list verdicts change too.
- **API.** Additive: new body keys on `POST` and `PATCH /api/apps`, a new member in the `_revise`
  answer, new keys in `PUT /api/admin/user-apps/_settings`. No shim, no deprecation.
- **Config.** See section 2.3.
- **Docs.** Update `docs/personal-apps.md` and `docs/projects.md` (an app and a personal project).
  Add a release note under `docs/releases/next/` with `/document-feature`.
- **i18n.** Labels and help in `shared/i18n/en.json` and `de.json`, with the test that checks both.
- **Tests.**
  - The drift test of section 2.1.
  - Ceiling unit tests per new capability.
  - The authorization matrix (`tests/security/authz/user-apps-authz.spec.js`) for a project link:
    member, non-member, owner removed from the project, admin project that is not global.
  - A test that chat attachments and containers stay blocked in a personal app with a project link.
  - Builder evaluation on a fixed set of requests ("let it search the web", "answer from the
    handbook", "use a faster model", "make the answers shorter").
  - A subpath end-to-end run, as for the existing user-app specs.

## 6. Slices

| Slice | Content | Ships alone? |
|---|---|---|
| S0 | Registry, drift test, lists derived from it, check of the migration question. No behavior change. | Yes |
| S1 | Tier A keys: schema, ceiling, picker, editor Advanced group, publish copy. Builder keys from the registry for both targets, including the admin target. | Yes |
| S2 | Tier B keys with admin switches and panel group; `suggestions.settings`, confirm items in the card; model proposals. | Yes |
| K1 | Approval exception for internal read-only tools shipped with iHub. Needs decision 1. | Yes, but only useful with K2 |
| K2 | Project links: schema, ceiling, `resolveProjectScope` change, picker, builder proposals, publish rule, tests. Needs K1 before sharing makes sense. | After K1 |

**Cut lines**, in the order to cut if the work runs late: `skillIds`, `imageGeneration`, `thinking`,
`startForm` and `variablesPanel`, `webSearchSettings.researchGuidance`. Not cuttable: the "both"
rule, the publish rule for projects, the authorization tests.

## 7. Open decisions

1. **Approval exception for internal read-only tools (K1).** Recommended: yes, limited to tools
   shipped with iHub and declared internal and read-only. This changes the rule of 02 section 6.3,
   so it needs the owner's explicit yes. Without it, K2 still works, but every search in a shared app
   shows a card; the owner's own chat is not affected, because `writes` does not ask for reads.
2. **Project instructions in personal apps.** Decided alone: not injected (section 2.4). Reversible
   by one flag. The alternative is to inject them and to list them in the chat's "what the author
   wrote" view, which makes the third-person text visible but still lets it change without a revision
   of the app.
3. **`autoStart`.** It sends the first message without a keystroke and adds no tool. Today every
   tool call in a shared app asks. If decision 1 is accepted, a shared app with `autoStart` can run
   iHub's internal read-only tools, for example a project search, without a card. Other tool calls
   still ask. So the owner decides on `autoStart` together with decision 1: with both accepted, the
   first answer of a shared app can already draw on project documents before the person has done
   anything. I lean towards allowing it; decide in slice 1.

## 8. What was verified and what was not

**Read in the code:** `shared/userAppContent.js`, `server/validators/userAppSchema.js`,
`server/validators/appConfigSchema.js`, `server/services/userApps/ceiling.js`,
`shared/appRevision.js`, `shared/appGenerator.js`, `shared/appProjects.js`,
`server/services/knowledge/ProjectScope.js`, `server/services/projects/projectLinks.js`, the
concept documents 02 and 03, and `docs/projects.md`.

**Not verified:**

- The behavior of each Tier A key in the client and the chat path (`startForm`, `variablesPanel`,
  `usageGuide`, `greeting` rendering).
- That `userAppSettings()` fills missing keys with defaults, which decides whether a migration is
  needed.
- That no attachment or container path opens when `features.projects` becomes true for a personal
  app.
- The rest of `knowledge.json` (I read the start): whether any function already declares a side
  effect.
- How `publishUserApp.js` maps keys; I read only its header.
- Nothing was run: no tests, no server.
