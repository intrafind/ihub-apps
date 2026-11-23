# App builder rework: Senior Product Manager

Panel report, 2026-11-20. Lens: who builds apps, the smallest shippable increment, cut lines,
metrics, creation sources, release framing, and what not to build.

Paths are relative to the repository root. "Wizard" is
`client/src/features/apps/components/AppCreationWizard.jsx`. "Review" is
`concepts/admin-ui-review-2026-11/02-apps-models-prompts.md`.

## Summary

Creating an app today takes 8 screens, 10 clicks and 17 offered controls. It ends on a list
without a confirmation, with an app that is already live for every signed-in user and has never
been tried. On a fresh install the app cannot answer at all, and nothing said so on the way.

The problem is not one bad screen. It is that we have two creation flows, both of which copy parts
of the editor, and neither of which ends in "I typed a question and my app answered".

My proposal for this increment:

1. **One way in.** The button, Cmd+K and the setup wizard all open the same "New app" screen at
   `/admin/apps/new`. The template modal and the 7-step wizard are deleted.
2. **One screen, two required fields.** The user names the app and says what it should do. Either
   they write the instructions or they let the AI write them. ID, icon, colour, category and
   language get good defaults.
3. **Create means "not published yet".** The new app is saved switched off and opens in the editor
   with the Test panel running. The builder can test an unpublished app. Publishing is one visible
   switch that says who will see the app.
4. **The editor shows the essentials first.** Everything else is collapsed, with a section index
   and a save bar that stays in view.
5. **The AI path tells the truth.** It checks for a model before the user types, shows the real
   error, validates the answer, and shows what it produced before anything is saved.

The builder in this increment is the admin and the content admin. A knowledge expert builds apps
by being given the content-admin role. Personal apps for users without that role are a separate
product decision and are not in this increment.

The single number I would hold us to: **a first-time builder gets a test answer from their own new
app in under three minutes, with at most five clicks after "New app".**

## Findings

### F1. Nobody outside the admin area can build an app

Creation exists only under `/admin/apps` (`client/src/App.jsx:555-559`). Every call goes through
`contentAdminAuth` (`server/middleware/contentAdminAuth.js:13-30`). There is no owner field in the
app schema and no personal-app setting, while personal prompts and skills do exist
(`server/validators/platformConfigSchema.js:728`, `:760`).

So the "non-technical knowledge expert who wants to create own apps" has exactly one route today:
an admin puts them into a group with `contentAdmin`. That role also lets them edit every other
app and every prompt. This is a real product gap, but closing it means ownership, sharing, quotas
and a promotion step. It is too large and too risky to bundle with a flow rework.

### F2. Two creation flows, two sets of defaults

The "Create App" button opens the template modal and then the wizard
(`client/src/features/admin/pages/AdminAppsPage.jsx:354-360`). Cmd+K and the first-run setup open
the full editor in "new" mode (`client/src/features/admin/components/AdminCommandPalette.jsx:51`,
`client/src/features/setup/SetupWizard.jsx:599`). The two disagree on defaults, for example
`preferredStyle: 'normal'` in the wizard and `'keep'` in the editor
(`AdminAppEditPage.jsx:94`). The Review already named this AI-PM3 and its rule is right: a wizard
that creates something ends in the full editor, never in a second copy of its fields.

### F3. The flow asks for things a newcomer cannot answer, and hides the one thing that matters

The wizard asks for an "App ID" typed by hand, an icon name as free text, a "Creation Method",
"Send Chat History" and "Display Order". It does not ask the one question a newcomer has: "does it
work?". Success sends the user to the list without a message (Wizard `:287-288`). The Test panel
exists in the editor but the wizard never leads there.

### F4. A new app is public before it has been tried

The wizard creates with `enabled: true` (Wizard `:41`); the schema default is also true
(`server/validators/appConfigSchema.js:714`). Shipped groups grant `apps: ["*"]` to signed-in
users. A half-finished app is in every user's sidebar from the first second. The Test panel
refuses disabled apps (`client/src/features/admin/components/AppTestPanel.jsx:216-222`), so
today "safe" and "testable" exclude each other.

### F5. The missing model is the real dead end on a new installation

On a fresh install `GET /api/models` is empty. The manual path produces an app that shows "No
models available". The AI path answers 400 "No model specified and no default model configured"
(`server/routes/admin/prompts.js:1574-1577`) and the user sees "Network error occurred while
generating app" (Wizard `:753-757`, screenshot `en-14-ai-result.png`). A newcomer concludes the
product is broken. No amount of wizard polish fixes this unless the flow checks first.

### F6. The AI path is the best idea we have and the least finished

One sentence in, a working app out: this is the right promise for a non-technical builder. Today
it has no preview, no validation of the answer, a parser that cuts nested JSON (Wizard
`:689-695`), a generic error for every failure, and it silently binds integrations and web search
that the wizard never shows. After generating, the user still walks five more steps. The promise
is broken at every point where it meets reality.

### F7. "Templates" are whatever happens to be enabled

The picker lists every enabled app (`server/routes/admin/apps.js:355-362`, an owner decision from
2026-11-17). On a fresh install that is 19 rows with `ID: chat` under each
(screenshot `en-02-template-picker.png`). Nine shipped apps are disabled and therefore not
offered, among them `summarizer` and `translator`, which are exactly the starters a newcomer
would want. Copying also writes `parentId` and `inheritanceLevel`, which no server code reads
(AI-B19). The user is promised inheritance and gets a copy.

### F8. Four creation sources, no shared mental model

Blank, copy-an-app, AI and the Marketplace are four separate places with four separate
vocabularies. The Marketplace is `adminAuth` only (`server/routes/admin/marketplace.js`), so a
content admin cannot use it. Upload Config is a fifth source on the list page. Nothing tells a
builder which one to pick.

### F9. The editor is ten screens tall

A four-field app opens as a 5,930 px page with 29 inputs and 18 checkboxes. Nothing is collapsed
(`client/src/features/admin/components/AppFormEditor.jsx:184-325`). Save is at the very bottom.
`/admin/apps/new` opens with four validation errors before any input (AI-B16). A short creation
flow that drops the user here without a map moves the complexity by one click. It does not remove
it.

### F10. German builders get an English tool

None of the 91 wizard and picker keys exist in `shared/i18n/en.json` or `de.json`. For a German
knowledge expert this alone is a reason to give up. Deleting the two components removes these
keys from the baseline; every new string must exist in both languages from day one.

## Proposal

### Who we build for in this increment

| Persona | Role in iHub | Served now? |
|---|---|---|
| iHub admin | `admins` | Yes |
| Knowledge expert with builder rights | group with `contentAdmin` | Yes: this is the main target |
| Knowledge expert without any admin right | `users` | No: needs personal apps, see "Later" |

The knowledge expert is the design target, not the admin. Every label in the new flow is tested
against "would someone who has never seen JSON understand this?". The admin benefits anyway.

For the third persona we do one cheap thing now: document the recipe "give a colleague the
content-admin group so they can build apps" in `docs/admin-ui.md`, and say plainly what else that
role allows.

### The flow

**Entry.** "New app" on the list, Cmd+K "New app" and the setup wizard all go to
`/admin/apps/new`. The row action "Clone" becomes "Duplicate" and goes to the same screen,
prefilled, with the name suffixed " (copy)".

**Screen 1: New app.** One page, not a stepper.

- A model check runs first. If no usable model exists, a notice at the top says: "No AI model is
  set up yet. Apps cannot answer until one is." Admins get a link to Models. Content admins are
  told to ask an administrator. The form stays usable; the AI option is switched off with the
  same reason.
- "What should the app do?" A text box with one example. Two buttons below it:
  **Write it for me** (AI) and **I'll write the instructions myself**.
- "Name". The ID is derived from the name, shown small as "Address: /apps/plain-summary", editable
  behind "Change", checked for uniqueness while typing.
- Icon and colour have defaults and a real picker (`IconPicker` exists). Category defaults to the
  first category of `ui.json`.
- Language is not asked. Content is stored under the UI language. More languages are added in the
  editor.
- A secondary line: "Or start from: Copy an existing app · Marketplace". "Copy an existing app"
  opens the searchable list of enabled apps (the owner's decision stands). "Marketplace" appears
  only for admins with the feature on, and is a plain link.

**AI result.** "Write it for me" fills the same form: name, short description, instructions,
icon, colour, and input fields if it proposed any. Anything it added beyond text is shown as a
removable line: "Uses web search", "Uses Jira: search issues". Nothing is saved yet. The user can
edit, ask again, or continue. Asking again warns before it overwrites edits.

**Create.** One button, "Create and test". It saves the app as not published and opens the editor
with the Test panel open. A short checklist sits above the form: "Try it · Add input fields ·
Add example questions · Publish".

**Publish.** A switch in the editor header, not a checkbox inside a card. Next to it one sentence
says who will see the app, taken from the real group access, for example "Visible to all signed-in
users once published". Changing who sees it stays in the existing Group access section; the
sentence links there.

**Editor.** Same fields, same page, three changes: a section index on the left, a save bar that
stays visible while there are changes, and collapsed sections. Open by default: Basics,
Instructions, Input fields, Example questions. Everything else is closed and shows a one-line
state ("Web search: off"). No validation errors before the user has typed.

### Creation sources, as one model

| Source | Where it lives | This increment |
|---|---|---|
| Describe it (AI) | New app screen, primary when a model exists | Yes, rebuilt |
| Blank | New app screen | Yes |
| Copy an existing app | New app screen and row action "Duplicate" | Yes, plain copy, no lineage |
| Marketplace | Link from the New app screen, admins only | Link only |
| Curated gallery of starter apps | New app screen | Next |
| Upload a config file | List page, as today | Unchanged |
| Example apps of an integration | Integration page, as today | Unchanged |

The rule: every source produces a prefilled New app screen or lands directly in the editor. None
gets its own wizard.

### Cut lines

**This increment (ship together; the flow has no value in halves):**

1. Single entry point and the New app screen; delete `AppCreationWizard.jsx` and
   `AppTemplateSelector.jsx`.
2. Auto ID with inline uniqueness check; icon picker; no language select.
3. Create as not published, land in the editor with Test open.
4. Builders can test an app that is not published. This needs a server change and is the
   precondition named in the Review (W2 step 4).
5. Publish switch in the header with the "who sees it" sentence.
6. AI path: model precondition, the server's real error text, answer validated against the app
   schema before it reaches the form, preview in the form, visible list of what it bound. No
   `console.log` of the answer.
7. Editor: section index, sticky save bar, collapsed sections, no errors before input.
8. "Duplicate" without `parentId` and `inheritanceLevel`. The schema keeps accepting them, so no
   existing file breaks and no migration is needed.
9. English and German for every new string; baseline entries of the deleted files removed.
10. One end-to-end test: create, test, publish, open as a user. One for the AI path with a stubbed
    model.
11. Docs: `docs/admin-ui.md` "Managing Apps", `README.md:171`, a short `docs/app-quickstart.md`
    (in `docs/SUMMARY.md`), new screenshots. One entry in `docs/releases/next/features.md`.

**Next (own tickets, after the metrics hold for one release):**

- Curated starter gallery shipped in `server/defaults`, independent of what is enabled.
- A dedicated server endpoint for generation if this increment keeps the generic one, plus moving
  the generator prompt out of the user-visible prompt library (AI-B8).
- "Improve with AI" on an existing app's instructions.
- Placeholder detection: typing `{{topic}}` offers to create the input field.
- Form fields for JSON-only settings a builder needs first: greeting, `disallowModelSelection`.
- Merged Model block with the admin model list and status (AI-B9, AI-PM5).
- Optimistic locking for apps (`If-Match`), used-by check on delete.

**Later (each needs an owner decision first):**

- Personal apps for users without admin rights, with a "request publishing" step.
- "Only these groups" as part of creating (open decision 1 of the Review).
- Drafts of an already published app, so edits do not go live on save.
- Marketplace access for content admins.

**Not to be built:**

- Any step that repeats editor fields (variables, uploads, advanced settings) in the create flow.
- Tabs in the editor (the Review's resolution stands).
- Inheritance or "based on" lineage in the UI.
- Letting the generator choose the app type, URLs, uploads, approval rules, skills or workflows.
  It keeps its current allow-list, and the allow-list moves to wherever the answer is validated.
- A chat-style builder agent. One description, one result, edit by hand. Conversation comes after
  we know the one-shot path works.
- A language picker in the create flow.

### Success metrics

| Metric | Today | Target |
|---|---|---|
| Time from "New app" to a test answer, first-timer, model present | not reachable inside the flow | under 3 min manual, under 2 min with AI |
| Clicks from "New app" to a test answer | 10 to create, then more to find Test | 5 or fewer |
| Fields the user must type | 4 (ID, name, description, instructions) | 2 (what it should do, name) |
| Screens before the app exists | 8 | 1 |
| Started flows that end in a created app | unknown | 80 % |
| Created apps tested before publishing | 0 % by design | 70 % |
| AI answers that pass validation on the first try | unknown | 90 % with the shipped prompt on the default model |
| Untranslated strings in the German flow | 91 | 0 |
| Apps visible to users before the builder published them | every one | none |

We have no product analytics that I could find, so the first four rows are measured by the
end-to-end test (clicks, screens) and by five moderated sessions with non-technical colleagues
before release. The rates need counters; the audit log already records creates and could record
"published". Whether we may count usage at customers is a question for the owner.

### Release framing

Headline for `docs/releases/next/features.md`: **"Create an app on one screen, test it before
anyone sees it."** Three bullets: describe it and let the AI draft it; new apps start unpublished
and can be tested at once; the editor shows the essentials first.

To state openly in the same entry:

- The 7-step wizard and the template window are gone. "Clone" is now "Duplicate".
- Apps created through the UI start unpublished. The API default is unchanged: a `POST` without
  `enabled` still creates an enabled app. So there is no breaking change for scripts.
- Duplicates no longer record a parent app.

Nothing here should need an entry in `breaking-changes.md`. If the implementation changes the
`POST /api/admin/apps` default or removes the inheritance fields from the schema, that changes,
and the owner decides first (CLAUDE.md, Breaking Changes).

### Where I deviate from prior art

- **W2 step 3 "Model and audience" is dropped from creation.** The audience half depends on open
  decision 1. The model half is replaced by the precondition check; a newcomer should not pick a
  model. Both stay in the editor.
- **W2 says "Duplicate an existing app (searchable, all apps)".** I keep the owner's later
  decision: enabled apps only.
- **W2 lists a template gallery as a start option.** I move the curated gallery to Next. The
  endpoint today returns live apps, and a real gallery needs content work and its own source.
- **W2 has four steps; I propose one screen plus the editor.** Same rule, fewer stops.

## Pre-mortem

It is May 2027. The rework shipped and failed. These are the stories.

**1. We shortened the wizard and nobody noticed.** The new screen was quick. Then users landed in
the same ten-screen editor, got lost, and told the owner "it is still too complicated". Root
cause: we treated creation and editing as two projects and shipped only the first. Prevention: the
collapsed editor with index and sticky save is in the same increment, and the acceptance test is
"test answer in five clicks", not "app created".

**2. The knowledge expert still could not build anything.** The owner demoed it to a customer's
department lead, who had no admin rights and never saw the button. Root cause: we assumed "builder
means content admin" and never confirmed it. Prevention: ask the owner now (question 1), state the
persona limit in the release note, and ship the "give someone builder rights" recipe in the docs.

**3. The AI path failed in the first demo.** The customer's default model wrapped the JSON in
prose, or returned an unknown category, and the user saw an error. They never tried again. Root
cause: tested against one model, no validation, no repair, no fallback. Prevention: validate and
normalise the answer in one place, fall back to "we filled in what we could" rather than an error,
test with at least three provider families, and keep manual creation one click away on the same
screen.

**4. New apps "disappeared".** Builders created an app, did not see the Publish switch, and
reported that their app was missing for users. Support tickets followed. Root cause: we changed
the default to unpublished without making the state loud. Prevention: a persistent "Not published
yet" banner in the editor with the Publish action in it, a "Not published" badge in the list, and
the checklist ending in "Publish".

**5. Testing unpublished apps turned into a security incident.** The server change that lets a
builder open a disabled app also let ordinary users open it by URL. Root cause: the check was
written as "skip the enabled filter" instead of "content admin, in the test context only".
Prevention: the security reviewer owns this change; a test proves a normal user gets the same
answer for a disabled app as before; no client-side-only gate.

**6. The generator created over-privileged apps.** One sentence, "help me with tickets", produced
an app bound to every Jira action, published to all signed-in users. Root cause: the AI binds whole
integrations, the old flow hid that, and we kept it hidden. Prevention: every binding the AI adds
is shown as a removable line before saving, the app starts unpublished, and the generator never
sets approval rules weaker than the default.

**7. We broke the people who were happy.** Experienced admins lost Clone-with-everything, JSON
mode moved, and scripted setups that relied on the wizard's saved fields stopped matching the
docs. Root cause: we optimised only for the newcomer. Prevention: Duplicate still copies the full
configuration, JSON mode and Upload Config are untouched, the API contract is unchanged, and one
experienced admin walks the flow before release.

**8. Scope grew until nothing shipped.** Gallery, personal apps, drafts and a conversational
builder were all "almost in". Three months later there was a branch and no release. Root cause: no
written cut line. Prevention: the "This increment" list above is closed; anything else gets a
ticket under epic #3741 and waits.

**9. It was simple in English only.** German strings came late, as fallbacks, with "Sie" and "du"
mixed. Root cause: i18n treated as cleanup. Prevention: both languages are part of "done" for each
screen, and the translation-key ratchet must shrink in this change.

**10. We could not tell whether it worked.** Six months on, nobody could say whether more apps
were being built. Root cause: metrics defined, never measured. Prevention: the click and screen
counts live in the end-to-end test; the five moderated sessions happen before release and again
one release later; the owner decides now whether counters are allowed.

## Questions I did not ask

1. Is "a non-technical user" someone we may give the content-admin role, or must a plain user be
   able to build an app for themselves? This decides whether personal apps are the next project or
   a distant one.
2. If personal apps are wanted: private to the creator, shareable with colleagues, or only after an
   admin approves? Who pays for the usage?
3. May a new app start unpublished, as a rule? Some customers may expect "create" to mean "live".
4. Is the AI path meant to be the main way to build, or one option among equals? I made it primary.
5. Which model should the generator use when the platform default is weak or absent? May an admin
   pick a dedicated one?
6. Should the generator be allowed to connect integrations and web search by itself at all, or
   only suggest them?
7. Do customers rely on "Clone" recording the parent app, or on the inheritance fields in any
   script or report?
8. Is a curated starter gallery something we want to maintain per release, in two languages? Or
   should the Marketplace be the gallery, which would mean opening it to content admins?
9. What does the owner count as "done": the flow, or also the editor? I assumed both.
10. May we collect usage counters (apps created, tested, published) at customer installations?
11. Open decision 1 (restrict an app to groups) and decision 11 ("System prompt" vs "System
    instructions") from the Review: still open, or decided since? I avoided both.
12. Are iframe and redirect apps something a non-technical builder should be able to create from
    the new screen, or are they an admin-only corner? I left them in the editor only.
13. Which customers or colleagues can we watch using the new flow before release?
14. Is there a release date or a customer commitment that fixes the scope from the other end?

## Decisions I took on my own

| # | Decision | Alternative I rejected | Reversible? |
|---|---|---|---|
| 1 | This increment serves admins and content admins only. | Build personal apps for all users now. | Yes. Nothing here blocks personal apps later. |
| 2 | One New app screen at `/admin/apps/new`; the wizard and the template window are deleted. | Shorten the wizard to W2's four steps and keep it as a modal. | Yes, but costly: the old code is gone. |
| 3 | Apps created in the UI start unpublished; the API default stays `enabled: true`. | Keep creating live apps; or change the server default. | Yes for the UI. Changing the API default would be a breaking change and is not proposed. |
| 4 | Testing an unpublished app is part of this increment. | Ship the interim path: create disabled, no test until enabled. | Yes. If the server change proves too risky, fall back to the interim path and say so. |
| 5 | No audience and no model choice during creation. | W2 step 3 as written. | Yes. Both can be added to the screen later. |
| 6 | The AI path is the primary option when a model exists. | Present Blank and AI as equals; or hide AI behind a setting. | Yes: it is an ordering choice. |
| 7 | The generator keeps its narrow allow-list and shows every binding it adds. | Let it set more fields; or forbid integrations entirely. | Yes. |
| 8 | "Copy an existing app" lists enabled apps only, as the owner decided. | W2's "all apps". | Yes. |
| 9 | Duplicate is a plain copy; no `parentId` written; schema untouched. | Keep lineage; or remove the fields from the schema with a migration. | Yes. Removing them from the schema would not be. |
| 10 | The curated starter gallery is Next, not now. | Ship four starters with this increment. | Yes. |
| 11 | The editor rework (index, sticky save, collapsed sections) ships with the flow. | Ship the flow first, the editor in a second release. | Yes, but splitting risks pre-mortem story 1. |
| 12 | Content language follows the UI language; no picker in creation. | Keep the language select; or use the platform default language. | Yes. |
| 13 | The ID is derived from the name and stays editable until creation. | Hide the ID completely; or keep it as a required field. | Yes before creation. An app's ID stays immutable after it. |
| 14 | Marketplace is a link for admins only; no change to its permissions. | Embed Marketplace apps in the New app screen. | Yes. |
| 15 | Success is measured by the end-to-end test and five moderated sessions, since I found no analytics. | Build usage telemetry first. | Yes. |
| 16 | No entry in `breaking-changes.md` is planned; removal of the wizard is described in the feature entry. | Announce the UI change as breaking. | Yes. |
