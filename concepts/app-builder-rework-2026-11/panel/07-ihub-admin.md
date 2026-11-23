# Panel report 07: iHub administrator at a customer

Role: I run iHub on-prem for 2,000 users. Login is OIDC. Models are a self-hosted vLLM and Azure
OpenAI. I have 60 apps, about 20 groups, and the instance runs under a subpath (`/ihub/`).
Paths are relative to `/workspace/ihub-apps`. I read the code and the walkthrough screenshots; I
did not run a browser myself and I did not read the other panel reports.

## Summary

Today I build every app myself, because nobody else can. Creation exists only in the admin area
behind `contentAdminAuth` (`server/middleware/contentAdminAuth.js:13-30`). A knowledge expert sends
me a mail, I duplicate an old app, and I fix the JSON.

I want knowledge experts to build their own apps. I will only allow it if four things hold:

1. **A new app reaches nobody until someone publishes it.** Today the wizard creates it enabled
   (`client/src/features/apps/components/AppCreationWizard.jsx:41`) and the shipped groups grant
   `apps: ["*"]` (`server/defaults/config/groups.json:9,27,62`). One click puts an untested app in
   front of 2,000 people.
2. **I can see who made what, and when.** The app schema has no creator or date field
   (`server/validators/appConfigSchema.js:582-739`). Only the audit log knows.
3. **The AI path cannot spend money or bind systems behind my back.** `POST /api/completions` is an
   open LLM proxy for content admins with no rate limiter (`server/routes/admin/prompts.js:1558`,
   `server/middleware/setup.js:598-635`). The generator may bind any installed integration.
4. **Nothing changes for my 60 apps, my scripts and my subpath.** JSON mode, Upload, Download,
   Duplicate, History and the POST/PUT contract stay as they are.

My proposal: one short creation flow that ends in the full editor, with the app created as
**disabled draft**. Content admins can test a disabled app. Publishing is a deliberate step that
names the audience. The server stamps creator and dates. The AI path gets a feature switch, a rate
limit, a chosen model, and never binds an integration without the creator ticking it. Personal
apps for all users are out of scope for this round; the gate stays the `content-admins` group.

## Findings

Each finding has an id (`ADM-n`), the evidence, and why it matters to me.

### Who can create, and what happens when they do

**ADM-1. A new app is live for everyone at once.** The wizard sets `enabled: true` (`AppCreationWizard.jsx:41`),
the editor's new-app defaults do the same (`client/src/features/admin/pages/AdminAppEditPage.jsx:95`),
and the schema default is `true`. With `apps: ["*"]` on `users` and `authenticated`, the app is in
every user's list the second it is saved. The walkthrough confirmed this (`en-20-user-home-with-new-app.png`).
In my instance that means a half-written "Test 2" app shows up for the whole company.

**ADM-2. A disabled app cannot be tested.** `AppTestPanel.jsx:216-222` shows "This app is disabled…
Enable it and save to test it." So the only way to test is to publish first. That is the wrong
order, and it is the reason I cannot simply tell people "create it disabled".

**ADM-3. The audience cannot be set before the first save.** Group access is disabled until the app
exists (`client/src/features/admin/components/ContentAccessSection.jsx:190`), and each grant is
saved at once into `groups.json` (`:40-41`), outside the app's save, history and unsaved-changes
guard. With the `*` wildcard, the section shows "wildcard" rows that I cannot remove per app. A
content admin sees only their own groups (`:39-40`). Nobody sees one sentence that says "when you
enable this, these people get it".

**ADM-4. Nobody owns an app.** No `createdBy`, `createdAt`, `updatedBy`, `updatedAt` in the schema.
Creation is audit-logged (`server/routes/admin/apps.js:737-743`) but not snapshotted; only update
and delete write history. If five experts create apps, the list (`AdminAppsPage.jsx`) cannot tell me
whose "Summary helper" this is, or whether anyone touched it since March.

**ADM-5. There is no name check.** The id is checked for uniqueness only at POST (`apps.js:724-727`).
Names are never compared. Duplicate keeps the original name unchanged (`AppCreationWizard.jsx:131-143`).
I already have three apps called "Übersetzer".

**ADM-6. Last save wins.** The `If-Match` guard covers only platform and UI config
(`client/src/api/adminConfigRevision.js:44-47`). `PUT /api/admin/apps/:appId` reads no `If-Match`
(`apps.js:583-626`). With one admin this is fine. With ten content admins it will eat edits.

### The AI path, seen as the person who pays for it

**ADM-7. `POST /api/completions` is unmetered.** It sits outside `/api/admin`, so the admin limiter
at `setup.js:635` does not apply, and no other limiter is mounted for it. The caller chooses the
messages, `maxTokens` and any model id in `configCache.getModels()` (`prompts.js:1560-1582`),
including models their groups may not use. A content admin can run my most expensive Azure
deployment from a browser console.

**ADM-8. The generator uses the platform default model, and I cannot choose another.** The wizard
sends no `model` (`AppCreationWizard.jsx:660-674`). My default model is the vLLM, because it is
free. It is weak at strict JSON, and the wizard's fallback parser cuts nested objects
(`:689-695`). Without a default model the server answers 400 and the user reads "Network error"
(`:753-757`). On my instance the AI path would fail often and blame the network, and the tickets
come to me.

**ADM-9. The generator prompt is ordinary content.** `app-generator` is a normal prompt in the
library (`server/defaults/prompts/app-generator.json`, `category: "system"`). Any content admin
can edit, disable or delete it; then generation answers 404 (`prompts.js:571-573`). No server code
hides it from the end-user prompt list (AI-B8, still open). My users can see and "use" an internal
prompt.

**ADM-10. A generated app can bind every installed integration.** The brief lists all enabled
integrations (`server/services/appGenerator.js:36-88`); the answer may bind any of them, with all
actions (`shared/appGenerator.js:21-36`). The wizard never shows these bindings, nor the web-search
switch, nor the generated prompt template. The creator saves an app that can reach Jira without
having seen the word Jira.

**ADM-11. The model answer is written to the browser console** (`AppCreationWizard.jsx:678, 739-740`).
Minor, but our works council asks about exactly such things.

### The model picker

**ADM-12. The picker shows the creator's models, not the audience's.** Wizard and editor both load
the public `fetchModels()` (`AppCreationWizard.jsx:1153`, `AdminAppEditPage.jsx:51`). The server
never checks that `preferredModel` exists or is enabled (`appConfigSchema.js:609, 644`). I pick the
Azure model; the audience group may use only the vLLM; the app silently falls back or fails. The
list column says "N/A" for most apps, so I cannot audit it either.

### Things I rely on today

**ADM-13. Two creation paths that behave differently.** The button opens picker and wizard
(`AdminAppsPage.jsx:792-799`); Cmd+K and the setup wizard open `/admin/apps/new`. They produce
different defaults (`preferredStyle: 'normal'` vs `'keep'`). My written instructions for colleagues
are wrong for one of the two.

**ADM-14. Upload has hard-coded English errors and no preview.** `handleUploadConfig`
(`AdminAppsPage.jsx:392-421`) posts the file as-is and reports with English strings. It is still my
main tool for moving apps from test to production, so it must keep working exactly like this, only
better explained.

**ADM-15. Files on disk may be invalid for the admin API.** The loader only warns
(`server/resourceLoaders.js:75`), the API is strict. Some of my 60 apps were written by hand years
ago. If the new editor blocks Save for them, I have a production problem on upgrade day.

**ADM-16. Duplicates carry dead lineage.** `parentId`, `inheritanceLevel` and `overriddenFields`
are written into the copy (`AppCreationWizard.jsx:71-73, 138-140`) and no server code reads them
for merging. Several of my apps have these fields. They must keep loading.

**ADM-17. German is half there.** No `admin.apps.wizard.*` or `admin.apps.template.*` key exists in
`shared/i18n/de.json`. My content admins work in German. An English-only dialog is the first thing
they will complain about.

**ADM-18. Subpath.** The wizard itself uses `navigate('/admin/apps')` (`:288`), which is
router-relative and fine. The risk is in new code: a new top-level route, a hand-built `href`, or a
bare `fetch('/api/…')`. `admin` is already in `KNOWN_ROUTES`
(`client/src/utils/runtimeBasePath.js:24-27`), so the new flow must stay under `/admin/`.

## Proposal

Ordered by what I need before I would give the `content-admins` group to knowledge experts.

### A. Draft first, publish on purpose (must)

1. **Every app created through the UI starts disabled.** The create flow and `/admin/apps/new` send
   `enabled: false`. The API default stays `true`, so my upload scripts and file-based deployments
   do not change. No migration, no breaking change.
2. **Content admins can test a disabled app.** The Test panel runs the saved app for a caller who
   passes `contentAdminAuth`, even when `enabled` is `false`. This needs a server change on the
   chat path, which today serves only enabled apps (`server/configCache.js:888-906`). The check
   must be the server's, bound to the content-admin permission, and must not open disabled apps to
   anyone else. Label test chats in the panel as tests.
3. **Publish is one switch in the editor header, with a confirmation that names the audience.**
   Example: "Publish 'Vertragsprüfer'? It becomes visible to: all signed-in users (wildcard on
   group *authenticated*)." or "…to groups *Legal*, *Procurement*." The server computes the list;
   the client only renders it. This is not a new permission model, so it does not pre-empt the
   open owner decision 1 ("only these groups"). It only makes today's rule visible.
4. **Status wording.** List and editor say "Draft" for a disabled app that was never enabled, and
   "Disabled" otherwise. If that needs a stored flag, skip the distinction and show "Disabled"
   for both; do not invent a state machine.

### B. Ownership and housekeeping (must)

5. **Server-stamped metadata.** On POST the server writes `createdBy` and `createdAt`; on PUT
   `updatedBy` and `updatedAt`. Values sent by the client are overwritten. The fields are optional
   in the schema, so old files stay valid and no migration is needed. Store the user id, show the
   display name.
6. **List columns and filters.** Add "Created by" and "Last changed" columns (sortable), and
   filters "Mine", "Drafts/Disabled". Old apps show a dash.
7. **Snapshot on create.** Creation writes a history snapshot like update does, so History is
   complete from the first version.
8. **Name collision warning.** While typing the name, warn (not block) when an app with the same
   localized name exists: "An app named 'Übersetzer' already exists (id `translator`)". The id is
   derived from the name and checked inline; show it under "Technical details", editable.
9. **Duplicate.** One action, "Duplicate". It copies the config, names it "<name> (copy)" /
   "<name> (Kopie)", proposes `<id>-copy`, writes no `parentId`, creates it disabled, and opens the
   editor. A note says: "Group access is not copied." Existing apps with lineage fields are left
   alone and keep validating.
10. **Optimistic locking for apps.** Send `If-Match` on app PUT and answer 412 with the existing
    conflict dialog (`AdminConfigConflictNotice`). The header stays optional, as the owner decided
    (Rework:36), so scripts without it still work.

### C. The AI path under my control (must before it is offered to non-admins)

11. **A feature switch.** Add `appGenerator` to `server/featureRegistry.js` (default on). When off,
    the "Describe it" option is not offered and the generator endpoint refuses. This is my kill
    switch.
12. **A dedicated server endpoint**, for example `POST /api/admin/apps/_generate`, replaces the
    browser calling the generic completions proxy. The server builds the messages, picks the
    model, validates the answer against the app schema, strips everything outside the allow-list
    and returns a draft config plus a list of problems. Then:
    - `POST /api/completions` gets a rate limiter and restricts `model` to what the caller may use.
      That is a behaviour change for anyone scripting it; state it in the release notes.
    - Errors are real: "No default model is configured. Ask an administrator." with the registry
      code, in en and de. No more "Network error".
    - No `console.log` of the answer.
13. **A chosen generator model.** A setting names the model the generator uses; empty means the
    platform default. I would point it at Azure while chat defaults to vLLM. If the setting lives
    in `platform.json`, say clearly whether it needs a restart.
14. **Integrations and web search are opt-in, visibly.** The result screen lists what the draft
    would be allowed to do: "Web search", "Jira: all actions". Each is a checkbox, off by default.
    Nothing is bound unless the creator ticks it. Only integrations the creator's groups may use
    are offered.
15. **Protect the generator prompt.** Hide `category: system` prompts from the end-user prompt list
    on the server. If the prompt was deleted or disabled, fall back to the shipped default instead
    of 404. I still want to be able to edit it (we add "always answer in Sie form").

### D. The creation flow and editor, from my chair (should)

16. **One entry.** Button, Cmd+K, setup wizard and `/admin/apps/new` open the same flow (W2 from the
    review). The flow ends in the full editor, not in a second copy of its fields. I agree with the
    earlier panel on this.
17. **Model step shows the truth.** List models with status (enabled, default) and warn when the
    chosen model is not usable by the app's audience. If no model is usable at all, say so on the
    first screen: "No chat model is available. The app can be created but will not answer."
    The server should also warn on save when `preferredModel` or `allowedModels` name unknown
    models. Warn, do not reject: my scripts create apps before models in some environments.
18. **Editor: collapsed sections, section index, sticky save bar.** Sections that differ from the
    defaults show a "configured" mark, so I can see at a glance what an expert changed. Keep it one
    page; Ctrl+F is how I work.
19. **Invalid existing apps stay editable.** If a loaded app fails strict validation, the editor
    opens it, names each problem with its path, and JSON mode remains available. The list marks
    such apps "Needs attention". See ADM-15.
20. **German complete** for every string in the new flow, `Sie` form, and the translation baseline
    shrinks accordingly.

### E. What must stay exactly as it is

- Form | JSON toggle in the editor, with every field reachable in JSON.
- Upload config and Download config; `POST /api/admin/apps` and `PUT` request and response shapes;
  schema default `enabled: true` for API and file-based creation.
- The id stays visible, stays immutable, and stays the file name.
- History with diff and rollback; Ctrl/Cmd+S; Reorder; Enable All / Disable All; the deep link
  `/admin/apps/:id`.
- `GET /api/admin/apps/templates` keeps answering (my colleagues may have scripts on it); the owner
  decision "list every enabled app" stands. I only ask that Duplicate in the UI can also pick a
  disabled app, since my archive of old apps is where I copy from. That is a small extension of the
  decision, not a reversal; if it needs the owner, keep enabled-only.
- Every new link uses the router or the existing API helper. Walk the flow by cold load at
  `/admin/apps/new` and `/ihub/admin/apps/new`.

### F. Not in this round

- Personal apps for every user (like `platform.userPrompts`, `platformConfigSchema.js:728`). It
  needs quotas, an approval or promotion step and per-user storage. Decide it separately.
- Approval workflow (submit, review, publish by a second person). The draft plus the publish
  confirmation plus the creator column cover my need for now.
- Per-app cost reports and "unused for 90 days" cleanup. I want them, but they belong to usage
  reporting.
- Item-level audience restriction (owner decision 1).

### What would make me switch it off

- Any path that publishes an app to all users without an explicit publish step.
- AI generation that fails more than occasionally on my default model, or that I cannot point at a
  specific model.
- AI generation binding an integration that the creator did not tick.
- An upgrade that changes the behaviour or validity of one of my existing 60 apps.
- An English-only flow in a German instance.

### Acceptance checks I would run after the upgrade

1. All 60 apps load; none changed on disk; the list shows no new "Needs attention" that the old
   version accepted through the API.
2. Create via the new flow as a content admin: the app is disabled, not in any user's list, and
   testable in the editor.
3. Publish: the confirmation names the groups; after confirming, a test user in that group sees it.
4. Upload a JSON exported before the upgrade: accepted, `enabled` as in the file.
5. Duplicate a legacy app that has `parentId`: copy has no `parentId`, original untouched.
6. Switch `appGenerator` off: no AI option, endpoint refuses.
7. Whole flow by cold load under `/ihub/`.
8. Two browsers edit one app: the second save gets the conflict dialog.
9. Audit log shows create, publish, and who did it.

## Pre-mortem

It is May 2027. The reworked app building failed. These are the stories I can imagine telling.

**1. "The Friday flood."** We gave 40 knowledge experts the content-admin role. Within a month the
user app list had 140 entries, among them "Test", "Test 2", "Mein Bot" and four translators. Users
stopped finding the real apps and complained to the board sponsor.
*Root cause:* creation got easy, publishing stayed implicit (`enabled: true` plus `apps: ["*"]`),
and there was no owner field to clean up by.
*Prevention:* created disabled, explicit publish with audience named, creator and date columns,
name collision warning (A1-A3, B5-B8).

**2. "The Jira bot nobody ordered."** An expert described "an assistant that helps with tickets".
The generator bound the Jira integration with all actions. The expert never saw that. A user asked
the app to "clean up old tickets" and it tried.
*Root cause:* generated bindings are saved but not shown (`AppCreationWizard.jsx:699-737`), and no
approval mode is set.
*Prevention:* capabilities listed as unticked checkboxes; only integrations the creator may use;
server-side allow-list (C12, C14).

**3. "Generate never works here."** On our instance the default model is vLLM. Two of three
generations ended with "Failed to parse generated configuration" or "Network error". People
concluded the feature is broken and went back to mailing me.
*Root cause:* no model choice, no schema-constrained answer, wrong error texts
(`prompts.js:1575-1578`, `AppCreationWizard.jsx:689-695, 753-757`).
*Prevention:* generator model setting, server-side parsing and validation with one repair attempt,
real error messages, and a test of the flow against a small local model before release (C12, C13).

**4. "The upgrade broke the tax app."** After the upgrade, saving an old hand-written app failed
with a validation error in a field the new form does not show. The department could not change the
prompt before their deadline. Rollback of the release followed.
*Root cause:* loader tolerates what the API rejects (`resourceLoaders.js:75`); the new editor
blocked Save harder than the old one, or dropped unknown fields on save.
*Prevention:* round-trip test with real legacy shapes (lineage fields, JSON-only fields, missing
`category`); invalid apps open with named problems and JSON mode; no migration that rewrites app
files in this round (D19, E).

**5. "The Azure invoice."** Someone found that `POST /api/completions` takes any model and any
`maxTokens`. A script ran against it over a weekend.
*Root cause:* no limiter, no model permission check (ADM-7), and more people now hold the role
that can call it.
*Prevention:* rate limit, model restricted to the caller's models, generation through a dedicated
endpoint with fixed parameters, usage attributed to the user (C12).

**6. "It worked on the demo, not under /ihub."** The new flow opened the editor through a built
URL. On our subpath a cold load of that URL showed "Unable to connect to the server". The Test
panel inside the flow called `/api/…` without the base path.
*Root cause:* the CLAUDE.md rule on routes and base paths was checked only at `/`.
*Prevention:* no new top-level route; router links and the API helper only; an e2e cold load at
`/ihub/admin/apps/new` in CI (E, check 7).

**7. "Two people, one app, one lost afternoon."** An expert and I edited the same app. My save
overwrote her new variables. She found out when users reported the old form.
*Root cause:* app PUT has no `If-Match` (`apps.js:583-626`); more editors made a rare problem
weekly.
*Prevention:* optional `If-Match` on app PUT with the existing conflict dialog (B10).

**8. "The draft that leaked."** Testing disabled apps was built by letting the chat endpoint serve
a disabled app when a query flag is set. A normal user found the flag and opened a draft containing
an unfinished HR prompt.
*Root cause:* the bypass trusted the request, not the permission.
*Prevention:* the server decides by `isContentAdmin` only; a test with a normal user against a
disabled app; the security panelist signs off on that one change (A2).

**9. "Simple for them, slower for me."** The new flow removed Upload from the header and hid JSON
behind an "advanced" menu. My routine of moving 15 apps from test to production doubled in time. I
went back to copying files on the server and stopped using the admin UI for apps, so History and
audit were empty for those changes.
*Root cause:* the rework optimised for the first-time creator only.
*Prevention:* the "must stay" list in section E is an acceptance criterion, with tests.

**10. "Half German."** The flow shipped with the wizard translated and the editor sections still
mixed. Our content admins filed it as a quality problem and management asked why we pay for it.
*Root cause:* translation done per file touched, not per screen the user sees.
*Prevention:* German walkthrough screenshots of every screen in the flow as a release gate (D20).

## Questions I did not ask

Only the product owner or a customer can answer these. I assumed an answer for each.

1. **Should "normal users" create apps without any admin role?** I assumed no for this round: the
   creator is a content admin. The owner's sentence "a normal user who is not technical" may mean
   more.
2. **Is a second person's approval required before an app goes live?** I assumed no; the creator
   publishes to the groups they may manage.
3. **May a content admin see the system prompts of all apps?** Today yes, through the admin list
   and the templates endpoint. I assumed that stays. In my company HR would object.
4. **Which model should generate apps when the default model is a small local one?** I assumed a
   setting, default "platform default".
5. **Is the cost of generation and of test chats charged to the creator's quota?** I did not verify
   how `kind: 'utility'` calls are counted. I assumed they are at least logged per user.
6. **Do customers script `POST /api/completions` or `GET /api/admin/apps/templates`?** I assumed
   some do, so I asked for additive changes and a release note for the limiter.
7. **How many customers run with the `authenticated: *` wildcard removed?** My publish confirmation
   is most useful where it is still there. I assumed most keep the default.
8. **Is storing a user id inside an app file acceptable under works-council and privacy rules?** I
   assumed yes, since the audit log already stores it.
9. **Do creators get notified when an admin disables or deletes their app?** I assumed no
   notification.
10. **What is the supported way to move apps between a test and a production instance?** I assumed
    Download and Upload stay the answer and that `createdBy` is re-stamped on upload.
11. **Should shipped starter templates be a curated gallery, and who curates it at a customer?** I
    assumed the earlier panel's small shipped gallery plus "Duplicate an existing app", and that I
    cannot add my own gallery entries yet.
12. **Are apps created by departed employees reassigned or archived?** I assumed nothing automatic;
    the creator column lets me do it by hand.
13. **Does "Draft" need to survive a later disable?** I assumed not; see A4.

## Decisions I took on my own

| # | Decision | Alternative I rejected | Reversible? |
|---|---|---|---|
| 1 | Creation stays in the admin area for content admins; no personal apps in this round. | A user-facing "My apps" with promotion, like user prompts. Rejected: needs quotas, storage and approval that do not exist. | Yes. It can be added later on top. |
| 2 | UI-created apps start disabled; the API default stays `enabled: true`. | Change the schema default to `false`. Rejected: breaks scripts and file deployments silently. | Yes. Only the client's payload changes. |
| 3 | Content admins may test disabled apps; the check is server-side by permission. | A separate draft store with a publish copy step. Rejected: larger, and two sources of truth. | Mostly. The permission check can be removed; habits formed around it cannot. |
| 4 | Publish shows the audience under today's rules; no new access model. | Wait for owner decision 1 and build per-app restriction first. Rejected: blocks everything on an open decision. | Yes. |
| 5 | Creator and dates are stamped by the server into the app file as optional fields. | Derive them from the audit log at list time. Rejected: the audit log can be rotated or disabled, and exports lose the data. | Partly. Once files carry the fields, removing them needs a migration. |
| 6 | No approval workflow. | Submit / review / publish by a second role. Rejected for now: I would be the bottleneck again. | Yes. |
| 7 | AI generation behind a feature flag, default on. | Default off. Rejected: nobody would find it; I can switch it off myself. | Yes. |
| 8 | Generated integrations and web search are unticked by default. | Keep them pre-bound and show them. Rejected: people confirm what is pre-ticked. | Yes. |
| 9 | Rate-limit `POST /api/completions` and restrict it to the caller's models. | Leave it and move only the wizard to a new endpoint. Rejected: the hole stays. | Yes, but it is a visible behaviour change for scripts; the owner should confirm it. |
| 10 | Unknown `preferredModel` gives a warning, not a 400. | Reject on save. Rejected: breaks bulk import where models arrive later, and would be a breaking change. | Yes. |
| 11 | Duplicate writes no lineage; existing lineage fields are left untouched, no migration. | A migration that removes `parentId` everywhere. Rejected: rewrites customer files for no user benefit and contradicts documented inheritance (`docs/apps.md:577-579`). | Yes. |
| 12 | Optional `If-Match` on app PUT in this round. | Leave for a later phase as the rework plan implies. Rejected: more editors make it urgent. | Yes. The header is optional. |
| 13 | Duplicate may pick disabled apps too. | Enabled only, as the owner decided for templates. I flag this as an extension of that decision. | Yes. |
| 14 | No migration touches existing app files in this round. | Normalise old apps to the new defaults. Rejected: upgrade risk on 60 production apps. | Yes. |
| 15 | I kept the earlier panel's shape: short flow ending in the full editor, one page with a section index, no tabs. | A longer guided wizard that covers variables and tools. Rejected: that is how the two paths drifted apart. | Yes. |
