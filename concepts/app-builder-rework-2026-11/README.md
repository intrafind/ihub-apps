# App builder rework: plan and this increment

**Date:** 2026-11-20 · **Epic:** #3741 (child of #3739) · **Input:** [`panel/`](panel/), [`../admin-ui-review-2026-11/02-apps-models-prompts.md`](../admin-ui-review-2026-11/02-apps-models-prompts.md) (the "Review"), [`../admin-ui-rework-2026-11/`](../admin-ui-rework-2026-11/README.md) (the "Rework") · **Status:** plan merged from nine panel reports and revised after three critiques (section 15); implementation follows in the same session.

## The problem, in the owner's words

> "I'm not happy the way we build apps. for a normal user who is not technical, it is far too
> complicated and we haven't touched the app admin, the wizard, the ai generated app, ... for a long
> long long long time."

A walk through the product on a fresh install confirms the complaint. Creating one simple app takes
8 screens and 10 clicks. The first required field is a hand-typed "App ID". The flow ends on the
app list without a message. The new app is visible to every signed-in user at once, and on an
install without a model it answers "No models available". The AI path reports a missing model as
"Network error". In German both dialogs are English. The editor behind the flow is one page of
about 8,000 px with every section open.

**What this increment does.** One page, `/admin/apps/new`, replaces the template picker, the
7-step wizard and the editor's "new" mode. It has two screens: *Start* (describe the app, pick a
template, start empty, or copy an app) and *Essentials* (name, short description, instructions).
The app is created as "Not published" and opens in the editor with the test chat running, so the
author tries it before anyone else sees it. The AI draft is produced and checked on the server.
The editor gets a section index, collapsed groups, a save bar that stays in view and a Publish
button that says who will see the app. Every new string exists in English and German.

**What it does not do.** Only admins and content admins can build apps, as today. Whether a user
without admin rights may build an app is the first question for the owner (section 10). No
permission list and no stored config shape changes. One response gains fields: the content-access
view now says whether every signed-in user can use the app. Two existing endpoints behave
differently: a content admin now gets an unpublished app by ID where the answer was 404, and
`POST /api/completions` falls under the admin rate limit. Section 16 lists every change a caller
or an admin can notice.

A panel of nine worked independently from the code, the research briefings and the prior art.
Each report ends with a pre-mortem, the questions its author did not ask, and the decisions its
author took alone. This README merges them. Three critics (feasibility, non-technical user, risk)
then challenged the merged plan against the code. Section 15 lists each of their points and what
became of it.

| File | Expert | Lens |
|---|---|---|
| [panel/01-product-manager.md](panel/01-product-manager.md) | Senior product manager | Who builds, cut lines, metrics, release framing |
| [panel/02-ux-designer.md](panel/02-ux-designer.md) | Senior UX designer | Flow, wireframes, error and empty states, keyboard and screen reader |
| [panel/03-ui-designer.md](panel/03-ui-designer.md) | Senior UI designer | Layout, components to reuse and build, dark mode, German at 390 px |
| [panel/04-technical-writer.md](panel/04-technical-writer.md) | Senior technical writer | Vocabulary, en/de strings, error texts, docs outline |
| [panel/05-quality-engineer.md](panel/05-quality-engineer.md) | Senior quality engineer | Test strategy, LLM stub, round-trip test, exact commands |
| [panel/06-senior-engineer.md](panel/06-senior-engineer.md) | Senior software engineer | Modules, endpoints, slices and file ownership |
| [panel/07-ihub-admin.md](panel/07-ihub-admin.md) | iHub administrator at a customer | What must not change, publishing, ownership, cost control |
| [panel/08-knowledge-expert.md](panel/08-knowledge-expert.md) | Non-technical knowledge expert | Where a newcomer stops, the words, what builds trust |
| [panel/09-security-expert.md](panel/09-security-expert.md) | Senior security engineer | Server-side guards for generated configs, invariants and their tests |

---

## 1. Principles

1. **One way in, one way out.** Every "new app" action opens `/admin/apps/new`. The flow ends in
   the editor of the new app. The creation flow holds no second copy of an editor section. This is
   the Review's rule (Review README:271); breaking it produced AI-B1, AI-B5 and AI-B6.
2. **Ask nothing the product can decide.** The ID comes from the name. The content language is the
   UI language. The model is the standard model. Icon, colour and category have defaults.
3. **Try before anyone sees it.** An app created in the UI starts "Not published". The first thing
   the author does with it is send a test message.
4. **The server checks what a model wrote.** A person who cannot read a config presses Create, so
   the person is no longer a control. The server builds a new app object from an allow-list,
   validates it against `appConfigSchema` and never returns an invalid app.
5. **Content is set, capability is offered.** A generated draft may contain text and input fields.
   Web search and connected systems come back as suggestions. Nothing is bound unless the author
   ticks it.
6. **The copy follows the build.** Every sentence that states behaviour ("only people who manage
   apps can open it") is tied to a code fact and checked against a named list in the pull request.
   Where the build may fall back, the alternative text exists. Where the page cannot know
   something (a content admin sees only the groups they manage), the main sentence says so.
7. **Disclose by section, not by mode.** A collapsed group with a summary line shows that a setting
   exists and what it is set to. The editor gets no Simple/Advanced switch and no tabs.
8. **Nothing changes for existing apps and scripts.** No migration, no changed default on the API,
   no removed endpoint. JSON mode, Upload, Download, History, Reorder and the bulk toggles stay.
9. **Both languages are part of done.** New files call `t('key')` without fallback text. A literal
   key that is missing in `en.json` or `de.json` fails the existing key test. That test reads only
   literal first arguments of `t()`. A key that code picks from a map (an error code, a start
   kind, a group ID) is therefore exported as part of that map, and a second test checks every
   value of every map in both files.
10. **Tests import product code and fail on today's code.** Logic lives in pure modules that Jest
    covers, because the main Playwright suite runs in no CI workflow.

## 2. Decisions taken

The lead took these when merging the reports. "Dissent" names who proposed something else and how
it was resolved. Decisions that need the owner are repeated in section 10.

| # | Topic | Decision | Dissent and resolution |
|---|---|---|---|
| D1 | Who builds | Admins and content admins, as today. No personal apps, no new permission. | The knowledge expert wants "My assistants" for users without admin rights and says that without it the complaint is half answered. Not built: the server has no owner field, no personal scope and no capability ceiling (security report, proposal 8). Owner question Q1. The release note says who can build. |
| D2 | Entry point | One page at `/admin/apps/new` for the button, Cmd+K, the setup wizard and Duplicate. `AppCreationWizard.jsx`, `AppTemplateSelector.jsx` and the editor's "new" mode are deleted. | None. All nine reports ask for it. |
| D3 | Number of screens | Two: Start, then Essentials. | PM: one screen. UI designer: three steps with "Model and audience". Writer: four. Two screens were chosen because every start (AI, template, copy, empty) converges on one Essentials screen, and neither model nor audience needs a screen (D17). |
| D4 | Order on Start | The description box comes first. The templates and "Start empty" follow. Copying an app, link apps and the Marketplace sit under one collapsed line, "Other ways to start". | UI designer and writer: four equal cards with a "Recommended" badge. Rejected: a newcomer cannot choose between unknown options, and a text box needs no choice. The first plan showed eight more options under the box, which is the same problem; the critic's fix was applied. |
| D5 | New apps start not published | The create page sends `enabled: false`. The schema and API default stays `true` (`appConfigSchema.js:714`). | Engineer: keep `enabled: true` with a switch, because a disabled app cannot be tested today. Resolved by D6. If D6 misses its gate, the fallback in section 6.3 applies. |
| D6 | Testing an unpublished app | Built now. A content admin can open an app that has `enabled: false` and chat with it in the interactive chat. Everyone else gets the unchanged 404, and so does every other way of running an app (scheduled task, app as a tool, workflow, inference API). | Engineer: not in this session; the lookup that hides disabled apps has many call sites and a partial patch risks a leak. PM, UX, admin and knowledge expert call it a precondition for D5. Resolved with a narrow design: one helper, a named list of call sites, a request builder that stays unchanged for every caller except the interactive chat route, one negative test per site, lists unchanged (section 5.4), and a hard gate with a fallback. |
| D7 | Where generation runs | On the server: `POST /api/admin/apps/_generate`. The browser no longer parses model output. | PM had the endpoint under Next. Engineer, QE, security and admin need it now; it also makes the failure paths testable in CI. |
| D8 | What a draft may switch on | Web search and connected systems are returned as suggestions and shown as unticked checkboxes. Input fields stay in the draft and are listed with a ticked checkbox. That checkbox is locked when the instructions use the fields. | UX, PM and UI designer: apply them and show removable chips. Security and admin: people confirm what is pre-ticked. The stricter rule was chosen. This changes today's behaviour, where both are applied silently (`AppCreationWizard.jsx:720-735`). |
| D9 | Which model drafts | A chat model the caller may use, the standard model first. This is the rule the usage-guide generator already uses (`selectGuideModel`, `server/utils/appUsageGuide.js:246-255`). | Admin: a setting that names the generator model. Engineer: standard model, else the first enabled one regardless of the caller's permissions. The existing rule was reused; a setting is owner question Q8. |
| D10 | The generator prompt | A library prompt `app-generator` that an admin changed wins. An unchanged library copy, a disabled one or a missing one is replaced by a brief the server owns. That brief asks for one language and plain wording. The server appends the output rules in every case. The response and the audit entry say which brief was used. **Update 2026-11-22:** the owner decided to remove the App Generator prompt completely (section "The App Generator prompt is removed"). Drafts always use the server's brief; the library prompt, the response field `brief` and the audit detail `brief` are gone. | Security: move the prompt out of the library now. Admin: hide `category: system` prompts from users. Both change what `GET /api/prompts` returns and affect customised copies: owner question Q5. The first plan used the shipped library text whenever it existed. That text asks for English and German, shows `preferredModel: "gpt-4"` and a German example in the *du* form, which contradicts the appended rules. The server brief removes the contradiction without a migration: owner question Q18. |
| D11 | Kill switch | A feature `appGenerator` in `server/featureRegistry.js`, default on. Off: no description box, and the endpoint answers 403 `FEATURE_DISABLED`. | None. Additive. |
| D12 | Templates | Six small template files written for the gallery, in `server/appTemplates/`, served by `GET /api/admin/app-templates`. Each holds only content fields (texts, input fields, conversation starters, icon, colour, category), in en and de. | PM: the gallery is Next because it needs content work. Engineer: serve six shipped default apps as they are. The critics showed that the shipped files do not fit: one binds a knowledge project, one has English-only instructions, four change upload, user settings or input mode, and one message template is a block of tags. The content work is six short files whose text is taken from the shipped apps and simplified. Owner question Q19. |
| D13 | "Copy an existing app" | The picker lists enabled apps through the existing `GET /api/admin/apps/templates`, which is the owner's decision of 2026-11-17 (Rework:46). It sits under "Other ways to start". The row action "Duplicate" works on every app, published or not. | Engineer and admin: list disabled apps in the picker too. Not done, to keep the owner's decision; the row action covers the admin's archive. |
| D14 | Duplicate | A plain copy: name with "(copy)", a derived free ID, no `parentId`, `inheritanceLevel` or `overriddenFields`, not published. The schema keeps accepting the three fields; existing files are untouched. | None. |
| D15 | App ID | Derived from the name, shown under "More details", editable until the app is created, checked against existing IDs while typing. The client refuses the IDs that routes shadow. | Knowledge expert: never show it. Engineer: also refuse reserved IDs on `POST /api/admin/apps`; that is a narrow breaking change, so it is owner question Q6. |
| D16 | Content language | The base language of the UI (`en` or `de`). An empty start and a draft store one language. A template start keeps only that language of every text. A copy keeps the languages of its source; a text the author changes on Essentials loses its other languages, and the screen says so. No language select in creation. | Engineer had a select under details; writer had a "Change language" key. Dropped: three selects were the problem. The first plan deep-copied templates and copies with all languages. Then an author who rewrites the German instructions leaves the old English instructions in place, and users with an English UI get those (`shared/localize.js:20-21`). |
| D17 | Model and audience in creation | Neither is asked. The Start screen names the model that receives the description. Audience is shown when publishing. | UI designer and writer: a model step and a visibility choice. Rejected: audience depends on open decision 1 of the Review ("only these groups"). |
| D18 | Model list for the page | The existing `GET /api/models` (models the caller may use). No new model endpoint. | Engineer: `GET /api/admin/app-models` listing every configured model for content admins. That widens what content admins see. Owner question Q7; AI-B9 stays open. |
| D19 | Words | "Instructions", "Input fields", "Conversation starters", "Templates", "Duplicate", "App", and "Published / Not published". The word "Draft" names only what the AI prepares. | UX: "Instructions for the assistant", "Suggested questions". Knowledge expert: "assistant", "How it should behave", "Questions it asks first", "Shared". Writer: "Available to users / Not available yet". One term per thing was chosen; the vocabulary is in section 4.1. "Instructions" departs from the Review's recommendation "System prompt" (open decision 11): owner question Q4. |
| D20 | Editor structure | One page. The existing sections are wrapped in the seven groups of the Review (Review:193-202), collapsible and always mounted. Open by default: Basics, Instructions and inputs. Every other group stays collapsed and shows a summary line; a group whose values differ from the defaults is marked "changed". A sticky index, "Expand all", and `AdminSaveBar`. In the app form, a text with one language shows one input without language codes. | Knowledge expert: a separate simple view with six blocks. UX: a third open section and a "Find setting" filter. UI designer: container queries. The simple view was rejected as a mode (principle 7); the filter and container queries are Next. The first plan opened every group that differs from the defaults. Dropped after critique: an app from a template then opened four long groups. |
| D21 | Publishing | A "Publish" button in the editor header opens a confirmation that names who will see the app. The audience comes from the content-access endpoint, which gains a field that says whether every signed-in user has access. "Unpublish" is under "More". Both call the existing `_toggle` action, so an app with a form error can still be unpublished. The `enabled` checkbox leaves the form body. | PM, admin and UI designer: a switch. Knowledge expert: block publishing until a test message was answered. A button with a confirmation was chosen because publishing has an audience to name; blocking was rejected (an admin who imports a known-good app would be forced through a ritual). The first plan published through the editor's full save; then a form error blocks Unpublish. |
| D22 | What stays | The Form/JSON toggle where it is, Upload config, Download, History, Reorder, Enable/Disable all (relabelled), Ctrl/Cmd+S, the deep link `/admin/apps/:id`. "Save & Exit" is removed. | UX: move JSON under "More" and the bulk actions into a menu. Not done: the admin's list of what must stay wins. |
| D23 | Who made what | No `createdBy` or date fields in app files. The audit entry of create carries the origin. No history snapshot is written on create. | Admin: server-stamped ownership fields and list columns now. That is a new stored data shape and a privacy question. Owner question Q9. The first plan wrote a create snapshot with `before: null`. The history drawer would show a rollback button for it that always answers 404 (`server/routes/admin/changes.js:106-109`). The first edit writes a snapshot whose before state is the created app, so nothing is lost. |
| D24 | Rate limits | `POST /api/completions` falls under the admin rate limiter; nothing else changes there. `POST /api/admin/apps/_generate` gets its own limit of 30 drafts per user per hour, and failed drafts count. The endpoints `POST /api/completions`, `GET /api/admin/prompts/app-generator` and `GET /api/admin/apps/templates` stay registered. | Security and admin: also cap `maxTokens` on `/api/completions` and check the caller's model permission. Both can break callers. Owner question Q3. The admin limiter is the configurable admin budget (300 per user per minute as shipped) and does not count failed requests (`platform.json:240-246`). A draft that ends in an unusable answer is a paid call, so the draft route needs a limit that counts it. |
| D25 | Optimistic locking for apps | Next. | Admin: now, because more editors make lost saves frequent. Not creation; the header would stay optional either way. |
| D26 | Link and embedded apps | Created on the same page: a variant of Essentials asks for the website address instead of instructions. | UX: open the full editor with the type preset. Engineer: Upload only. A variant keeps one creation path and lets the editor's "new" mode go. |
| D27 | Preview | A live tile (icon, colour, name, short description) beside the icon picker. No preview column and no mock chat. | UI designer: a preview card in a right column. Deferred: the tile is enough, and a chat-like mock risks being taken for the chat. |
| D28 | i18n ownership | One slice adds keys to `shared/i18n/en.json` and `de.json`. The app list, the app editor page and every file in `app-form/` reach zero missing keys. An entry of the translation baseline is removed by the change that makes it stale; nobody adds one. | None on ownership. The first plan let only the words slice touch the baseline, at the end. The key test fails on a stale entry at once, so the slice that deletes or renames must remove it. |
| D29 | Test weight | Most coverage in Jest tests of pure modules. One Playwright spec with its own config, contents directory and a single worker, plus a short spec in the subpath suite. Chromium is the gate. | None. |
| D30 | Schema hardening and secret detection | Next. | Security proposed length caps, an iframe sandbox enum and a secret detector. The enum and hard caps can refuse existing files on save: owner question Q10. The tight caps apply to generated drafts now. |
| D31 | Input fields that no text uses | For each such field of a draft, the server adds a line to the message template, so the model receives the value. The editor marks a field that no text uses and offers "Add to message template". A new field gets its placeholder from its field name. | W2's placeholder detection was Next. This half moved into the increment after critique: a field whose placeholder appears in no text is silently ignored (`server/services/PromptService.js:487-500`). The other half (a placeholder in a text without a field) stays Next. |
| D32 | Apps with one language in the rest of the admin area | `ResourceSelector` and the editor header resolve names with `getLocalizedContent`. | None. The risk critic found that a German-only name crashes the selector on the group page today (`ResourceSelector.jsx:31-32`). |
| D33 | When the AI path counts as done | When ten descriptions were run against one real model and at least eight drafts were usable without editing the instructions. If that run did not take place before the merge, the release entry says that draft quality was not measured, and the ticket for the run stays open. | QE and PM had the run as a manual check without a bar. No model key exists in the sandbox, so the lead cannot make it a merge gate. |
| D34 | Bulk publish | "Publish all" names every app that becomes visible and sends exactly those IDs. | Admin pre-mortem "The Friday flood". The existing confirmation counts the apps and names the first five (`bulkToggleConfirm.js`), but the action sends `*` (`AdminAppsPage.jsx:312`). Once new apps start unpublished, `*` also publishes every unfinished app. |

## 3. Target flow

```
 Apps list "New app" ─┐
 Empty state ─────────┤
 Cmd+K "New app" ─────┼─► /admin/apps/new ─► Start ─► Essentials ─► POST /api/admin/apps (enabled: false)
 Setup wizard ────────┘        ▲              │  describe ─ _generate ─┘          │
 Row action "Duplicate" ─► /admin/apps/new?from=<id> ──────────────────┘          ▼
                                                                   /admin/apps/<id>?created=1
                                                                   editor, test chat open ─► Publish
```

Counts for the path, compared with today (8 screens, 10 clicks, 4 typed fields):

| Start | Screens before the app exists | Clicks after "New app" | Fields the author must type |
|---|---|---|---|
| Describe | 2 | 2: Prepare draft, Create and test | 1 |
| Template | 2 | 2: the card, Create and test | 0 |
| Empty | 2 | 2: Start empty, Create and test | 3 |
| Duplicate | 1 | 1: Create and test | 0 |

"Copy an existing app" on the Start screen takes one click more than a template, because it sits
under "Other ways to start".

### 3.1 Screen 1: Start

A page inside the admin layout, not a dialog. It has a URL, survives a reload and has room on a
phone.

```
 Admin > Apps > New app
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │  New app                                                   Step 1 of 2: Start    │
 │                                                                                  │
 │  What should your app do?                                                        │
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ Example: An assistant that rewrites a difficult text in plain language.    │  │
 │  │ The user pastes the text and chooses a reading level.                      │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
 │  Say who uses the app, what they put in and what they should get back.           │
 │  Examples:  [Plain-language summary]  [Reply to a customer]  [Translate a text]  │
 │                                                                                  │
 │  [ ✦ Prepare draft ]    Your description is sent to the AI model Gemini Flash.   │
 │                                                                                  │
 │  ── or start from ─────────────────────────────────────────────────────────────  │
 │  Templates                                                                       │
 │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐         │
 │  │ (▤) Summarizer│ │ (◍) Translator│ │ (✉) Email     │ │ (✎) Plain     │  …      │
 │  │ Short summary │ │ Translates a  │ │ composer      │ │ language      │         │
 │  │ of a text     │ │ text          │ │ Asks for tone │ │               │         │
 │  │ [Input fields]│ │ [Input fields]│ │ [Input fields]│ │ [Input fields]│         │
 │  └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘         │
 │                                                                                  │
 │  [ Start empty ]                                                                 │
 │                                                                                  │
 │  ▸ Other ways to start                                                           │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

"Other ways to start", opened:

```
 │  ▾ Other ways to start                                                           │
 │    Copy an existing app                                                          │
 │    Create a link app        A link to a website, or a page shown inside iHub.    │
 │    More apps in the Marketplace                        (admins, feature on)      │
```

Behaviour:

- **Description first.** The example chips fill the box; they do not submit. Ctrl/Cmd+Enter starts
  the draft.
- **Model check before the first click.** The page loads `GET /api/models`. With no model the box is
  replaced by a notice, and the other starts stay usable:

```
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ (!) No AI model is set up yet                                              │  │
 │  │ You can prepare the app, but it cannot answer until a model is connected.  │  │
 │  │ [ Set up a model ]   (admins)      Ask an administrator to set up a model. │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
```

  An admin sees the link to `/admin/models`. A content admin cannot open that page (`adminAuth`,
  `server/routes/admin/models.js:404`) and sees the second sentence only. With the feature
  `appGenerator` off, the box is replaced by one line: "Drafting with AI is switched off on this
  installation."

  This check only knows that a model is configured. A model with a wrong key passes it. That
  case is caught by the error text for a failed draft (section 4.4).
- **Drafting.** The button reads "Preparing your draft. This can take up to a minute." with a
  "Cancel" link. The text box stays readable. A polite live region announces start and end. A
  second click cannot start a second request; an answer is applied only if its request is still
  the current one. "Cancel" aborts the request, and the server then stops the model call
  (section 5.2).
- **Draft failed.** The message names the cause and the next step (section 4.4). The description
  stays in the box. No path leads to an empty Essentials screen without the author choosing it.
- **Templates** are cards with the template's icon on its colour, one line, and the badge "Input
  fields" where the template has some. No ID, no chevron. The whole card is one button. If the
  list fails to load, the row shows "The templates could not be loaded. Try again" and the rest
  works.
- **Start empty** goes to Essentials with nothing filled in.
- **Other ways to start** is one collapsed line. It holds the three starts that few newcomers
  need, so that the screen shows the description box, the templates and "Start empty" and
  nothing else.
  - **Copy an existing app** opens a searchable list of enabled apps with the same card. On a
    fresh install the list contains the shipped apps, some with the same name as a template.
    This is accepted: a template is a short starting text, the shipped app is the full app.
  - **Create a link app** goes to the link variant of Essentials (3.2).
  - **Marketplace** is a plain link, shown to admins when the feature is on. Its permissions are
    unchanged.
- **Draft kept for the tab.** Description and Essentials input are stored in session storage and
  restored after a reload, with the line "Your unfinished draft was restored. Start over".

### 3.2 Screen 2: Essentials

One screen for every start. The heading and the notice at the top change with the start.

```
 Admin > Apps > New app
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │  ← Back                                               Step 2 of 2: Essentials    │
 │                                                                                  │
 │  Check your draft                              (empty start: "Describe your app")│
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ ✦ The AI prepared this draft. Check the text; you can change everything.   │  │
 │  │ Your description                                                           │  │
 │  │ ┌────────────────────────────────────────────────────────────────────────┐ │  │
 │  │ │ An assistant that rewrites a difficult text in plain language. The …   │ │  │
 │  │ └────────────────────────────────────────────────────────────────────────┘ │  │
 │  │ [ Prepare a new draft ]                                       Start over   │  │
 │  │ Also in this draft                                                         │  │
 │  │   [x] Input fields: Text, Reading level                                    │  │
 │  │ The app could also use            Nothing here is on unless you tick it.   │  │
 │  │   [ ] Web search: the app can search the internet.                         │  │
 │  │   [ ] Jira: search issues, read issue                                      │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
 │                                                                                  │
 │  (▤)     Name *                                                                  │
 │  tile    ┌──────────────────────────────────────────────┐                        │
 │  Icon ▾  │ Plain-language summary                       │                        │
 │  ● ● ● ● └──────────────────────────────────────────────┘                        │
 │  ● ● ● ● Users see the name in the app list.                                     │
 │                                                                                  │
 │  Short description *                                                             │
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ Rewrites a text so that everyone understands it.                           │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
 │  One sentence under the name. It tells users when to pick this app.              │
 │                                                                                  │
 │  Instructions *                                    Tips for good instructions ▾  │
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ You rewrite texts in plain language. Use short sentences and common words. │  │
 │  │ Keep all facts. Answer in the language of the text.                        │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
 │  Tell the AI what its task is and how it should answer. It reads this before     │
 │  every chat; users do not see it. (Also called the system prompt.)               │
 │                                                                                  │
 │  ▸ More details                                                                  │
 │                                                                                  │
 │  The app starts as "Not published". Only you and others who manage apps can      │
 │  open and test it until you publish it.                                          │
 │                                                    [ Cancel ]  [ Create and test ]│
 └──────────────────────────────────────────────────────────────────────────────────┘
```

Behaviour:

- **Required fields:** name, short description (the schema's `description`), instructions
  (`system`). The server does not require `system` (`appConfigSchema.js:605`); the page does,
  because an app without instructions is the plain chat.
- **One line above the button.** Only the "Not published" sentence stands there. The model is
  named on the Start screen and in the no-model notice, not here. A language line ("You are
  writing in German. …") appears only when the UI language differs from the platform's default
  language.
- **More details** is collapsed and shows no values. Opened, it holds the App ID and the category.
- **App ID.** It follows the name while the author types ("Plain-language summary" becomes
  `plain-language-summary`) until the author edits it under "More details". It is checked against
  the IDs from `GET /api/admin/apps` when the name field loses focus. A taken ID gets the next free
  suffix. If `POST` still answers 409 `CONFLICT` and the author never touched the ID, the page
  retries once with the next suffix. If the author did edit it, "More details" opens and the field
  gets the focus and the message. After creation the ID is shown in the editor header and cannot
  be edited.
- **Same name.** If an app with the same name exists, a warning appears under the field when the
  author leaves the field. It does not block. A name that a template or a copy pre-filled does not
  trigger it before the author has been in the field.
- **Icon and colour.** The existing `IconPicker` and a palette of eight swatches plus "Custom
  color". The tile beside them shows the app as the list will.
- **The draft notice holds the whole loop.** It shows the author's description in an editable box
  with "Prepare a new draft" beside it. The author reads the draft, adjusts the description and
  drafts again on one screen. If the author changed a field of the draft, "Prepare a new draft"
  asks first: "A new draft replaces the current one, including your changes." If an admin changed
  the generator prompt, one more line says so (section 5.2).
- **"Also in this draft".** Input fields the AI proposed are listed and ticked. Unticking removes
  the input fields and the lines of the message template that use them. If the instructions use
  one of the fields, the checkbox is locked and a note says: "The instructions use these fields.
  You can remove them in the editor." Suggestions are unticked. Only ticked suggestions go into
  the request body. A connected system is listed with its actions; one without declared actions
  reads "all functions".
- **Template.** The notice reads: Started from the template "Email composer". Change anything you
  like. The name is the template's name, with the focus and the text selected. Every text is in
  the content language only (section 5.1).
- **Duplicate and "Copy an existing app".** The notice reads: Copied from "Email composer".
  Everything is copied, including connected systems and file settings. Group access is not
  copied. The name is "Email composer (copy)" and has the focus with the text selected. The
  copy keeps every language of its source. When the author changes the name, the short
  description or the instructions, and that text has other languages, one more line appears:
  "You changed texts that also exist in other languages. Those other versions are removed, so
  that all users get your new text. You can add translations in the editor."
- **Link variant.** Instead of Instructions the screen asks for "Website address" and one choice:
  "Open the website" (`type: redirect`) or "Show the website inside iHub" (`type: iframe`).
- **Validation.** On leaving a field and on submit, never before input. On submit with errors the
  focus moves to a summary above the form; each entry links to its field. A 400 with
  `details.issues` is mapped to fields by `path`; an issue without a field appears in the summary.
  The page never branches on message text.
- **Leaving.** Back and Cancel ask once ("Discard this app?") when the author typed or changed
  something on this screen. Back from a draft, a template or a copy that the author did not
  change does not ask; a draft and its description are kept, so the author returns to the Start
  screen with the description still in the box. The page uses `useUnsavedChanges`, like the
  editor.
- **Create.** `POST /api/admin/apps?origin=<start>` with `cleanAppForSave(draft)`, then
  `navigate('/admin/apps/<id>?created=1', { replace: true })`.

### 3.3 Landing: the editor with the test chat open

```
 Admin > Apps > Plain-language summary
 ┌─────────────────────────────────────────────────────────┬───────────────────────────┐
 │ (▤) Plain-language summary        ○ Not published       │ Test                  ⟳ ✕ │
 │     plain-language-summary                              │                           │
 │     [ Publish ]   [ Test ]   [ More ▾ ]                 │   Plain-language summary  │
 ├─────────────────────────────────────────────────────────┤   Rewrites a text so that │
 │ ✓ Your app is ready to test                             │   everyone understands it │
 │   Write a message in the test chat on the right.        │                           │
 │   · Test it with a real example                         │                           │
 │   · Add input fields (optional)                         │                           │
 │   · Add conversation starters (optional)                │                           │
 │   · Check who can use the app                           │                           │
 │   · Publish                          Hide these steps   │                           │
 ├───────────────┬─────────────────────────────────────────┤                           │
 │ Expand all    │ ▾ Basics                                │                           │
 │               │   Name, short description, icon, …      │                           │
 │ • Basics      │ ▾ Instructions and inputs               │                           │
 │ • Instructions│   Instructions [....................]   │ ┌───────────────────────┐ │
 │   and inputs  │   Input fields (0)   + Add input field  │ │ Paste a text…         │ │
 │ • Model       │   Conversation starters (0)             │ └───────────────────────┘ │
 │ • Knowledge   │ ▸ Model               Standard model    │                           │
 │   and tools   │ ▸ Knowledge and tools  Web search off   │                           │
 │ • Chat        │ ▸ Chat features        Upload off · …   │                           │
 │   features    │ ▸ Input and voice      Single line · …  │                           │
 │ • Input and   │ ▸ What users can change   4 of 4 on     │                           │
 │   voice       │ ▸ Who can use this app    Everyone who  │                           │
 │               │                           signs in      │                           │
 │ • …           │                                         │                           │
 ├───────────────┴─────────────────────────────────────────┴───────────────────────────┤
 │ ● You have unsaved changes                                   [ Discard ]  [ Save ]  │
 └─────────────────────────────────────────────────────────────────────────────────────┘
```

- `?created=1` opens the test panel, shows the toast `App "…" created` and the next-steps card,
  moves the focus to the card's heading, and is then removed from the URL.
- The test chat runs the saved, unpublished app (section 5.4). With unsaved edits the panel keeps
  its amber hint and restarts after a save, as today.
- With no model the panel shows the notice of screen 1 instead of a dead send button.
- **When the author's groups do not grant the app.** Creating an app grants no group, and the
  test chat checks group permission like every chat (section 5.4). On an installation where the
  wildcard `apps: ["*"]` was removed from the group `authenticated`, a content admin's own new
  app answers 404 in the test panel (`server/routes/generalRoutes.js:355-358`), and today's panel
  says only "The app could not be loaded for the test." (`AppTestPanel.jsx:86-91`). When the load
  of an unpublished app answers 404, the panel now says: "Your groups cannot use this app yet.
  Give one of your groups access, then test it." with the button "Who can use this app", which
  opens that group. A content admin can grant the groups they manage there.
- The next-steps card is a list of links. Each link opens the matching group through the contract
  of section 3.5 and moves the focus there. "Hide these steps" is remembered per app in local
  storage. The steps do not tick themselves in this increment.

### 3.4 Publish

```
 ┌──────────────────────────────────────────────────────────────┐
 │  Publish "Plain-language summary"?                        ✕  │
 │                                                              │
 │  Who will see it                                             │
 │  Everyone who signs in can use this app.                     │
 │                                                              │
 │  · Your unsaved changes are saved first.     (only if dirty) │
 │  · No AI model is available. Users will see "No models       │
 │    available".                              (only if true)   │
 │                                                              │
 │                         [ Cancel ]   [ Publish ]             │
 └──────────────────────────────────────────────────────────────┘
```

**Where the audience comes from.** `GET /api/admin/content-access/apps/{id}`
(`server/routes/admin/contentAccess.js:218`; the type is `apps`, the singular answers 400). Today
the response holds `scope` and one row per group the caller manages. For a content admin the
groups that every signed-in user carries (`authenticated`, `anonymous`) are left out
(`server/utils/contentAccess.js:161-165`). On the shipped configuration the group `authenticated`
grants `apps: ["*"]`. A dialog built from the rows alone would therefore tell a content admin "No
group can use this app yet" while every signed-in user gets the app.

The response gains two additive parts (section 5.2):

- `audience: { allSignedIn, anonymous }`, computed on the server over all groups for both scopes.
  `allSignedIn` is true when the group every signed-in user carries grants this app or `*`.
  `anonymous` is true when anonymous access is on and its groups grant the app.
- `implicit: true` on the rows of those groups, so the dialog never prints "Authenticated" as a
  group name.

**What the dialog says**, in this order of precedence:

| Situation | Text |
|---|---|
| `audience.anonymous` | Everyone can use this app, including people who are not signed in. |
| `audience.allSignedIn` | Everyone who signs in can use this app. |
| else, `scope: all`, effective groups exist | Members of these groups can use it: Users, Sales. |
| else, `scope: all`, no effective group | No group can use this app yet. Choose groups under "Who can use this app". |
| else, `scope: membership`, effective groups exist | Members of these groups can use it: Sales. You see only the groups you manage. Other people may also be able to use it; ask an administrator. |
| else, `scope: membership`, no effective group | None of the groups you manage can use this app yet. Other people may be able to use it; ask an administrator. |

"No group can use this app" is never shown to a content admin, because the page cannot know it.
No group picker is offered: "only these groups" is open decision 1.

**How it publishes.** Publish and Unpublish call the existing action
`POST /api/admin/apps/{id}/_toggle` with `{ "enabled": true | false }`
(`server/routes/admin/apps.js:1030`). It changes only the flag in the stored file and writes an
audit entry.

- **Unpublish** (under "More") asks once and then calls `_toggle`. It does not save the form and
  does not depend on the form being valid. Unsaved edits stay unsaved.
- **Publish with a clean form** calls `_toggle`.
- **Publish with unsaved changes** saves first (the normal `PUT`, with validation, history and
  audit) and then calls `_toggle`. The dialog says so. If the save fails, nothing is published,
  the dialog closes and the error summary shows what to fix.
- After a toggle the page sets `enabled` in the form state and in its saved baseline, so the
  change does not count as an unsaved edit. The header then reads "● Published".

The save bar of a published app adds: "Users get the change as soon as you save." The word
"Draft" is not used for an app's state, because saving a published app changes it for users at
once.

One gap stays and is recorded: a second tab that still holds the old state sends the old
`enabled` value with its next save. This is the "last save wins" behaviour of today; optional
`If-Match` (Q12) closes it.

### 3.5 Editor groups

The existing section components are wrapped, not rewritten. Their `id` attributes stay, so links
and the error summary keep working.

| Group | Wraps (files in `app-form/`) | Open by default | Summary when collapsed |
|---|---|---|---|
| Basics | `BasicInfoSection`: name, short description, icon, colour, category. Inside it a collapsed "More details" with app type and position in the list. | yes | none |
| Instructions and inputs | `SystemInstructionsSection`, `VariablesSection`, `StarterPromptsSection` | yes | none |
| Model | preferred model, allowed models, answer format (moved out of `BasicInfoSection`) | no | "Standard model" or the model's name |
| Knowledge and tools | `IntegrationsConfigSection` (web search, iAssistant, iFinder, type bindings, connected systems), `ToolsConfigSection`, `WorkflowsConfigSection`, `AppsConfigSection`, `SkillsConfigSection`, `ProjectsConfigSection` | no | "Web search off · 1 connected system" |
| Chat features | `UploadConfigSection`, `MagicPromptSection`, `ExportConfigSection`, `DocumentTemplateSection`, `CompareModeSection`, `FeedbackSection`, `AiNoticeSection`, `UsageGuideSection`, and a new `ChatBehaviourSection` with "Auto-start conversation" and "Ephemeral chat" (moved out of `BasicInfoSection`) | no | "Upload off · export, feedback on" |
| Input and voice | `InputModeSection` | no | "Single line · microphone on" |
| What users can change | `SettingsConfigSection` | no | "4 of 4 on" |
| Who can use this app | `ContentAccessSection` (outside the form, as today) | no | "2 groups" or "Everyone who signs in" |

What leaves the first open group, compared with today's `BasicInfoSection`
(`BasicInfoSection.jsx:47-105`, `:291-330`):

- **App ID.** The input is removed. The ID is shown in the header and cannot be changed after
  creation, which is what the Essentials screen promises.
- **App type and order** move into the collapsed "More details" inside Basics. "Order" is
  labelled "Position in the app list".
- **Auto-start and Ephemeral chat** move to Chat features.
- **Preferred model, allowed models, answer format** move to Model.
- **`enabled`** leaves the form (3.4).
- **The usage guide** moves from the second open group to Chat features. It is a help dialog of
  the chat, and its labels ("Dialog heading", "Guide (Markdown)") are not first-visit material.

Rules:

- A group stays mounted when collapsed and is hidden with the `hidden` attribute. Validation, the
  dirty check and the round trip do not depend on what is open.
- A group opens itself in three cases only: it has a validation error; the author follows a link
  to it (next-steps card, save bar "Show", the test panel's "Who can use this app", a URL hash
  `#<group id>`); the author presses "Expand all".
- A group does **not** open because its values differ from the defaults. Its summary line shows
  the values, and a small "changed" marker appears beside the summary and in the index. An app
  created from a template or a copy therefore opens like every other app: two groups open, the
  rest collapsed.
- A group with a validation error shows a count in its header and in the index. The error summary
  opens the target group before it moves the focus.
- "Expand all" opens every group, so the browser's search finds every label.
- Below `lg`, or with the test panel open on a narrow window, the index becomes a "Jump to section"
  select above the form.
- The save bar is rendered inside the form's scroll column (`AdminAppEditPage.jsx:476`), not at
  page level, so it does not run under the test panel. With errors it reads "2 fields need your
  attention" ("1 field needs your attention") with a "Show" button that jumps to the first one.
- Header: icon tile, the app's name as `h1`, the ID in small monospace, the status, "Publish" (when
  not published), "Test", and "More" (Open app, History, Download, Duplicate, Unpublish) built on
  the existing `MoreActionsMenu`. The name is resolved with `getLocalizedContent(app.name,
  uiLanguage)`; today the header reads `name.en` and shows the ID for a German-only app
  (`AdminAppEditPage.jsx:468`). The breadcrumb labels go through `t()`.
- iframe and redirect apps keep Basics plus their one configuration card; the groups that apply to
  chat apps are not rendered, as today.

**Texts in one language.** The flow stores a new app in one language. The form's language
component treats English as the base language today: it locks the remove button for `en`,
requires `en`, shows upper-case code pills, and renders "No languages configured. Add a language
to get started." for an empty optional field (`DynamicLanguageEditor.jsx:436`, `:470`,
`:476-483`). The component has 35 callers, so it gets one optional prop and changes nothing for a
caller that does not pass it:

- `primaryLanguage` (the app form passes `primaryLanguageOf(app, uiLanguage)` from
  `shared/appDefaults.js`). With it: an empty field renders one input in that language instead of
  the "No languages configured" text; `required` and the lock on the remove button follow that
  language instead of `en`; a field with exactly one language shows no code pill.
- For every caller, wording only: "Add Language" becomes "Add a translation", and the language
  list shows names with the code in parentheses ("German (de)").

**Input fields that no text uses.** In `VariablesSection`:

- A new field gets its placeholder from its field name ("Reading level" becomes `reading_level`)
  until the author edits the placeholder. The placeholder input stays visible.
- A field whose placeholder appears in neither the instructions nor the message template shows a
  notice: "This field is not used yet. The AI does not receive what users enter." with the button
  "Add to message template". The button appends the line `<Field name>: {{placeholder}}` to the
  message template in the field's language.

**The contract between the page and the form.** The page (`AdminAppEditPage.jsx`, slice S7) and
the form (`AppFormEditor.jsx`, slice S8) share the group state, because the access group, the
index, the save bar and the next-steps card are rendered by the page, while seven groups are
rendered by the form inside `DualModeEditor` (`AdminAppEditPage.jsx:615-618`). S8 publishes these
two files, with signatures and empty bodies, before S7 and S8 start:

```js
// app-form/editorGroups.js
export const EDITOR_GROUPS          // ordered: [{ id, labelKey, defaultOpen, types }], 'access' last
export function groupOfField(path)  // 'variables.0.name' -> 'instructions'; unknown -> 'basics'
export function groupSummary(id, app, t, extra)  // text of the collapsed line; '' for none
export function groupChanged(id, app)            // true when the group differs from newAppDefaults()

// app-form/useEditorGroups.js
const groups = useEditorGroups({ app, errors });
// groups.isOpen(id), groups.toggle(id), groups.open(id, { focus }), groups.expandAll(),
// groups.collapseAll(), groups.errorCount(id), groups.totalErrors, groups.firstErrorField
```

- The page calls the hook once. It passes `groups` to the form through `formProps` of
  `DualModeEditor`, renders `<EditorGroupNav groups={groups} />`, and wraps
  `ContentAccessSection` in `<EditorGroup id="access" groups={groups}>`. `EditorGroup` and
  `EditorGroupNav` are S8 components.
- The form reports its errors through the callback it already has: `onValidationChange({ isValid,
  errors: [{ field, message }] })` (`AppFormEditor.jsx:126-131`). The page hands `errors` to the
  hook. The save bar reads `groups.totalErrors`; its "Show" button calls
  `groups.open(groupOfField(groups.firstErrorField), { focus: groups.firstErrorField })`.
- The next-steps card and the test panel call `groups.open(id, { focus: true })`.
- The `enabled` checkbox is removed by S8 and the Publish button is added by S7. Both land in the
  same merge. A Jest test of S7 asserts that the rendered page has exactly one control that
  changes `enabled`.

### 3.6 Apps list

- "Create App" becomes "New app" and navigates to `/admin/apps/new`; so does the empty state.
- The row action "Clone" becomes "Duplicate" and navigates to `/admin/apps/new?from=<id>`.
- The status reads "Published" or "Not published".
- "Enable all" and "Disable all" are relabelled "Publish all" and "Unpublish all". Their meaning
  changes with this increment: an unpublished app is now also an unfinished one. Today the
  confirmation counts the apps that change and names the first five, and the action sends `*`
  (`bulkToggleConfirm.js`, `AdminAppsPage.jsx:312`). With this change:
  - the confirmation of "Publish all" reads "These 7 apps become visible to their users:" and
    lists every name in a scrollable list;
  - with a search filter active, the action covers the rows shown, and the button reads "Publish
    shown" / "Unpublish shown";
  - the action sends exactly the IDs the confirmation listed, never `*`, so an app that another
    author created in the meantime is not published.
- "Upload Config" becomes "Upload a config file" and behaves as today. An uploaded file keeps the
  `enabled` value it carries.
- Empty state: "No apps yet. An app is an assistant for one task, for example "Summarize a text" or
  "Answer questions about our travel policy"." Empty search: `No app matches "…".`

### 3.7 Keyboard, screen reader, small screens

- Each creation screen has one `h1`. On a screen change the focus moves to it and the document
  title changes.
- The step line is text inside a `nav` with `aria-current="step"`.
- Fields have a real `<label for>`, `aria-invalid` and `aria-describedby`. The error summary is a
  region with `role="alert"` that receives the focus on a failed submit. One visible asterisk per
  required field, with the legend "Fields marked with * are required."
- Drafting is announced through a polite live region. Escape cancels a running draft.
- Group headers are buttons with `aria-expanded` and `aria-controls`; the summary line is part of
  the button's name. The index is a `nav`.
- Dialogs (Publish, Discard, copy picker, icon picker) use the shared `Modal` or `ConfirmDialog`,
  which trap the focus, close on Escape and return the focus.
- At 390 px every screen is one column. Button rows wrap; the primary button is full width. No
  fixed widths on buttons, cards or step labels. German strings are the design case: "Erstellen und
  testen", "Entwurf vorbereiten", "Bestehende App kopieren".
- New files use only the classes in `client/src/features/admin/components/formStyles.js` and live
  under `client/src/features/admin/`. Every new `.jsx` file that renders markup with a colour
  class carries the matching `dark:` variant. No purple and no `green-700` buttons.

## 4. Copy

The strings below are final for this increment. The writer's report holds the reasoning. Rules:
US English, sentence case; German with *Sie*, „…" and „Benutzer"; a button names what happens; an
error says what is wrong and what to do; the technical term appears once, in the help text;
interpolation uses `{{name}}`; no string lives in code.

### 4.1 Vocabulary

One term per thing, in the flow, the editor, the docs and the generator's output rules. JSON field
names do not change.

| Today | English | German | JSON |
|---|---|---|---|
| Create App | New app | Neue App | |
| System Instructions / System prompt | Instructions | Anweisungen | `system` |
| Prompt Template | Message template | Nachrichtenvorlage | `prompt` |
| Variables | Input fields | Eingabefelder | `variables` |
| Variable name | Placeholder | Platzhalter | `variables[].name` |
| Variable label | Field name | Feldname | `variables[].label` |
| String / Text / Select | Short text / Long text / Dropdown (choose one) | Kurzer Text / Langer Text / Auswahlliste (eine Auswahl) | `variables[].type` |
| Predefined Values | Options | Auswahlmöglichkeiten | `predefinedValues` |
| Message Placeholder | Hint in the message box | Hinweis im Eingabefeld | `messagePlaceholder` |
| Starter Prompts | Conversation starters | Einstiegsfragen | `starterPrompts` |
| Preferred Model / No preferred model | AI model / Standard model | KI-Modell / Standardmodell | `preferredModel` |
| Output Format | Answer format | Antwortformat | `preferredOutputFormat` |
| Enabled / Disabled (apps) | Published / Not published | Veröffentlicht / Nicht veröffentlicht | `enabled` |
| Clone | Duplicate | Duplizieren | |
| Create from Scratch | Start empty | Leer beginnen | |
| AI-Generated | Prepare draft (from a description) | Entwurf vorbereiten | |
| App Template (an existing app) | Existing app | Bestehende App | |
| (new) shipped starting point | Template | Vorlage | |
| User Settings | What users can change | Was Benutzer ändern können | `settings` |
| Group access | Who can use this app | Wer die App nutzen darf | |
| App ID | App ID | App-ID | `id` |
| Integrations (inside an app) | Connected systems | Angebundene Systeme | `integrations` |
| Order | Position in the app list | Position in der App-Liste | `order` |
| Default Value | Prefilled value | Vorbelegter Wert | `variables[].defaultValue` |
| Add Language | Add a translation | Übersetzung hinzufügen | |
| Inheritance, parent, overridden fields | not used | nicht verwendet | |

"App" stays the product noun. The empty state explains it as "an assistant for one task".

"Connected systems" is the name in the creation flow, in the summary line of the group and as the
title of the editor section (`admin.apps.edit.integrations.title`, "Integrations" today). The
admin page where an administrator installs a system keeps its name "Integrations"; the
quickstart's glossary maps the two.

### 4.2 Creation flow (`admin.apps.create.*`)

| Key | en | de |
|---|---|---|
| `title` | New app | Neue App |
| `stepOf` | Step {{current}} of {{total}}: {{name}} | Schritt {{current}} von {{total}}: {{name}} |
| `steps.start` | Start | Start |
| `steps.essentials` | Essentials | Grundlagen |
| `back` | Back | Zurück |
| `cancel` | Cancel | Abbrechen |
| `submit` | Create and test | Erstellen und testen |
| `submitting` | Creating app… | App wird erstellt… |
| `requiredHint` | Fields marked with * are required. | Mit * markierte Felder sind Pflichtfelder. |
| `restored` | Your unfinished draft was restored. | Ihr unfertiger Entwurf wurde wiederhergestellt. |
| `startOver` | Start over | Neu beginnen |
| `discard.title` | Discard this app? | Diese App verwerfen? |
| `discard.body` | You have not created the app yet. What you entered will be lost. | Sie haben die App noch nicht erstellt. Ihre Eingaben gehen verloren. |
| `discard.confirm` | Discard | Verwerfen |
| `discard.keep` | Keep editing | Weiter bearbeiten |
| `start.heading` | What should your app do? | Was soll Ihre App tun? |
| `start.label` | Your description | Ihre Beschreibung |
| `start.placeholder` | Example: An assistant that rewrites a difficult text in plain language. The user pastes the text and chooses a reading level. | Beispiel: Ein Assistent, der einen schwierigen Text in einfacher Sprache neu schreibt. Der Benutzer fügt den Text ein und wählt ein Leseniveau. |
| `start.help` | Say who uses the app, what they put in and what they should get back. Two or three sentences are enough. | Sagen Sie, wer die App nutzt, was eingegeben wird und was herauskommen soll. Zwei bis drei Sätze genügen. |
| `start.examples.label` | Examples: | Beispiele: |
| `start.examples.summary.chip` | Plain-language summary | Zusammenfassung in einfacher Sprache |
| `start.examples.summary.text` | An assistant that rewrites a difficult text in plain language. The user pastes the text and chooses a reading level. | Ein Assistent, der einen schwierigen Text in einfacher Sprache neu schreibt. Der Benutzer fügt den Text ein und wählt ein Leseniveau. |
| `start.examples.reply.chip` | Reply to a customer | Antwort an einen Kunden |
| `start.examples.reply.text` | An assistant that drafts a reply to a customer email. The user pastes the email and chooses a tone: friendly, neutral or formal. | Ein Assistent, der eine Antwort auf eine Kunden-E-Mail entwirft. Der Benutzer fügt die E-Mail ein und wählt einen Ton: freundlich, neutral oder förmlich. |
| `start.examples.translate.chip` | Translate a text | Text übersetzen |
| `start.examples.translate.text` | An assistant that translates a text and keeps its tone and formatting. The user chooses the target language. | Ein Assistent, der einen Text übersetzt und Ton und Formatierung beibehält. Der Benutzer wählt die Zielsprache. |
| `start.generate` | Prepare draft | Entwurf vorbereiten |
| `start.generating` | Preparing your draft. This can take up to a minute. | Ihr Entwurf wird vorbereitet. Das kann bis zu einer Minute dauern. |
| `start.privacy` | Your description is sent to the AI model {{model}}. | Ihre Beschreibung wird an das KI-Modell {{model}} gesendet. |
| `start.or` | or start from | oder beginnen Sie mit |
| `start.templates.heading` | Templates | Vorlagen |
| `start.templates.loadError` | The templates could not be loaded. | Die Vorlagen konnten nicht geladen werden. |
| `start.badge.inputFields` | Input fields | Eingabefelder |
| `start.copy` | Copy an existing app | Bestehende App kopieren |
| `start.blank` | Start empty | Leer beginnen |
| `start.other` | Other ways to start | Weitere Einstiege |
| `start.link.help` | A link to a website, or a page shown inside iHub. | Ein Link zu einer Website oder eine Seite, die in iHub angezeigt wird. |
| `start.link.action` | Create a link app | Link-App erstellen |
| `start.marketplace` | More apps in the Marketplace | Weitere Apps im Marktplatz |
| `noModel.title` | No AI model is set up yet | Es ist noch kein KI-Modell eingerichtet |
| `noModel.body` | You can prepare the app, but it cannot answer until a model is connected. | Sie können die App vorbereiten. Antworten kann sie erst, wenn ein Modell angebunden ist. |
| `noModel.actionAdmin` | Set up a model | Modell einrichten |
| `noModel.actionOther` | Ask an administrator to set up a model. | Bitten Sie einen Administrator, ein Modell einzurichten. |
| `generatorOff` | Drafting with AI is switched off on this installation. | Das Entwerfen mit KI ist in dieser Installation ausgeschaltet. |
| `copy.heading` | Which app do you want to copy? | Welche App möchten Sie kopieren? |
| `copy.search` | Search apps | Apps suchen |
| `copy.noMatch` | No app matches "{{query}}". | Keine App passt zu „{{query}}". |
| `copy.none` | There is no app to copy yet. Choose another way to start. | Es gibt noch keine App zum Kopieren. Wählen Sie einen anderen Einstieg. |
| `copy.loadError` | The apps could not be loaded. | Die Apps konnten nicht geladen werden. |
| `copy.sourceGone` | The app you wanted to copy no longer exists. | Die App, die Sie kopieren wollten, gibt es nicht mehr. |
| `retry` | Try again | Erneut versuchen |
| `copy.nameSuffix` | {{name}} (copy) | {{name}} (Kopie) |
| `copy.note` | Copied from "{{name}}". Everything is copied, including connected systems and file settings. Group access is not copied. | Kopiert von „{{name}}". Alles wird übernommen, auch angebundene Systeme und Datei-Einstellungen. Der Gruppenzugriff wird nicht übernommen. |
| `copy.languagesNote` | You changed texts that also exist in other languages. Those other versions are removed, so that all users get your new text. You can add translations in the editor. | Sie haben Texte geändert, die es auch in anderen Sprachen gibt. Diese anderen Fassungen werden entfernt, damit alle Benutzer Ihren neuen Text erhalten. Übersetzungen können Sie im Editor ergänzen. |
| `template.note` | Started from the template "{{name}}". Change anything you like. | Begonnen mit der Vorlage „{{name}}". Ändern Sie, was Sie möchten. |
| `essentials.heading.blank` | Describe your app | Beschreiben Sie Ihre App |
| `essentials.heading.draft` | Check your draft | Prüfen Sie Ihren Entwurf |
| `essentials.heading.copy` | Adjust your copy | Passen Sie Ihre Kopie an |
| `essentials.heading.template` | Adjust the template | Passen Sie die Vorlage an |
| `essentials.heading.link` | Set up your link app | Richten Sie Ihre Link-App ein |
| `essentials.name` | Name | Name |
| `essentials.namePlaceholder` | Plain-language summary | Zusammenfassung in einfacher Sprache |
| `essentials.nameHelp` | Users see the name in the app list. | Benutzer sehen den Namen in der App-Liste. |
| `essentials.nameExists` | An app named "{{name}}" already exists. You can still use the name. | Es gibt bereits eine App namens „{{name}}". Sie können den Namen trotzdem verwenden. |
| `essentials.description` | Short description | Kurzbeschreibung |
| `essentials.descriptionPlaceholder` | Rewrites a text so that everyone understands it. | Schreibt einen Text so um, dass ihn alle verstehen. |
| `essentials.descriptionHelp` | One sentence under the name. It tells users when to pick this app. | Ein Satz unter dem Namen. Er sagt Benutzern, wann sie diese App wählen. |
| `essentials.instructions` | Instructions | Anweisungen |
| `essentials.instructionsPlaceholder` | You rewrite texts in plain language. Use short sentences and common words. Keep all facts. Answer in the language of the text. | Sie schreiben Texte in einfacher Sprache um. Verwenden Sie kurze Sätze und gebräuchliche Wörter. Behalten Sie alle Fakten bei. Antworten Sie in der Sprache des Textes. |
| `essentials.instructionsHelp` | Tell the AI what its task is and how it should answer. It reads this before every chat; users do not see it. (Also called the system prompt.) | Sagen Sie der KI, was ihre Aufgabe ist und wie sie antworten soll. Sie liest das vor jedem Chat; Benutzer sehen es nicht. (Auch System-Prompt genannt.) |
| `essentials.tips.toggle` | Tips for good instructions | Tipps für gute Anweisungen |
| `essentials.tips.role` | Say what the app does: "You summarize meeting notes." | Sagen Sie, was die App tut: „Sie fassen Besprechungsnotizen zusammen." |
| `essentials.tips.form` | Say what the answer looks like: "Five bullet points at most." | Sagen Sie, wie die Antwort aussieht: „Höchstens fünf Stichpunkte." |
| `essentials.tips.limits` | Say what it must not do: "Do not add facts that are not in the text." | Sagen Sie, was sie nicht tun darf: „Fügen Sie keine Fakten hinzu, die nicht im Text stehen." |
| `essentials.icon` | Icon | Symbol |
| `essentials.color` | Color | Farbe |
| `essentials.colorCustom` | Custom color | Eigene Farbe |
| `essentials.details` | More details | Weitere Angaben |
| `essentials.id` | App ID | App-ID |
| `essentials.idHelp` | Part of the app's link. Lowercase letters, digits and hyphens. It cannot be changed after the app is created. | Teil des Links zur App. Kleinbuchstaben, Ziffern und Bindestriche. Sie lässt sich nach dem Erstellen nicht mehr ändern. |
| `essentials.idFree` | Available | Verfügbar |
| `essentials.category` | Category | Kategorie |
| `essentials.categoryHelp` | Users can filter the app list by category. | Benutzer können die App-Liste nach Kategorie filtern. |
| `essentials.language` | You are writing in {{language}}. You can add other languages in the editor. | Sie schreiben auf {{language}}. Weitere Sprachen können Sie im Editor ergänzen. |
| `essentials.audience` | The app starts as "Not published". Only you and others who manage apps can open and test it until you publish it. | Die App startet als „Nicht veröffentlicht". Bis Sie sie veröffentlichen, können nur Sie und andere, die Apps verwalten, sie öffnen und testen. |
| `essentials.audienceLive` | Everyone who may use apps through their group sees it as soon as you create it. | Alle, die über ihre Gruppe Apps nutzen dürfen, sehen sie, sobald Sie sie erstellen. |
| `draft.intro` | The AI prepared this draft. Check the text; you can change everything. | Die KI hat diesen Entwurf vorbereitet. Prüfen Sie den Text; Sie können alles ändern. |
| `draft.also` | Also in this draft | Außerdem in diesem Entwurf |
| `draft.inputFields` | Input fields: {{names}} | Eingabefelder: {{names}} |
| `draft.fieldsLocked` | The instructions use these fields. You can remove them in the editor. | Die Anweisungen verwenden diese Felder. Entfernen können Sie sie im Editor. |
| `draft.suggestions` | The app could also use | Die App könnte außerdem verwenden |
| `draft.suggestionsHelp` | Nothing here is switched on unless you tick it. | Nichts davon ist eingeschaltet, solange Sie es nicht ankreuzen. |
| `draft.webSearch` | Web search: the app can search the internet. | Websuche: Die App kann im Internet suchen. |
| `draft.system` | {{name}}: {{actions}} | {{name}}: {{actions}} |
| `draft.systemAll` | {{name}}: all functions | {{name}}: alle Funktionen |
| `draft.leftOut` | Some parts of the answer could not be used and were left out. | Einige Teile der Antwort ließen sich nicht verwenden und wurden weggelassen. |
| `draft.regenerate` | Prepare a new draft | Neuen Entwurf vorbereiten |
| `draft.regenerateWarning` | A new draft replaces the current one, including your changes. | Ein neuer Entwurf ersetzt den aktuellen, auch Ihre Änderungen. |
| `link.url` | Website address | Adresse der Website |
| `link.urlHelp` | The full address, starting with https:// | Die vollständige Adresse, beginnend mit https:// |
| `link.mode` | How should it open? | Wie soll sie geöffnet werden? |
| `link.redirect` | Open the website | Website öffnen |
| `link.iframe` | Show the website inside iHub | Website in iHub anzeigen |
| `link.iframeHelp` | Some websites do not allow being shown inside other pages. | Manche Websites erlauben nicht, in anderen Seiten angezeigt zu werden. |
| `done.toast` | App "{{name}}" created | App „{{name}}" erstellt |
| `done.heading` | Your app is ready to test | Ihre App ist bereit zum Testen |
| `done.body` | Write a message in the test chat on the right. Change the instructions, save, and try again. | Schreiben Sie eine Nachricht in den Test-Chat rechts. Ändern Sie die Anweisungen, speichern Sie und probieren Sie es erneut. |
| `done.steps.test` | Test it with a real example | Mit einem echten Beispiel testen |
| `done.steps.inputFields` | Add input fields, if users should choose something (optional) | Eingabefelder ergänzen, wenn Benutzer etwas auswählen sollen (optional) |
| `done.steps.starters` | Add conversation starters (optional) | Einstiegsfragen ergänzen (optional) |
| `done.steps.access` | Check who can use the app | Prüfen, wer die App nutzen darf |
| `done.steps.publish` | Publish | Veröffentlichen |
| `done.dismiss` | Hide these steps | Diese Schritte ausblenden |
| `done.guide` | Guide: Build your first app | Anleitung: Ihre erste App erstellen |

`essentials.audienceLive` is used only if the fallback of section 6.3 applies.
`essentials.language` is shown only when the UI language differs from the platform's default
language. The description box inside the draft notice reuses `start.label`. The model is named
only by `start.privacy` and by the no-model notice; the key `essentials.model` of the first plan
is dropped.

Keys that code picks from a map are exported with that map, so the i18n test can check them
(principle 9): `steps.<name>`, `essentials.heading.<start>`, `error.<key>`,
`start.examples.<name>.*`.

### 4.3 List, editor frame, publish

| Key | en | de |
|---|---|---|
| `admin.apps.title` | Apps | Apps |
| `admin.apps.subtitle` | Assistants your users can open. | Assistenten, die Ihre Benutzer öffnen können. |
| `admin.apps.createApp` | New app | Neue App |
| `admin.apps.list.duplicate` | Duplicate | Duplizieren |
| `admin.apps.list.uploadConfig` | Upload a config file | Konfigurationsdatei hochladen |
| `admin.apps.list.publishAll` | Publish all | Alle veröffentlichen |
| `admin.apps.list.unpublishAll` | Unpublish all | Alle zurückziehen |
| `admin.apps.list.publishShown` | Publish shown | Angezeigte veröffentlichen |
| `admin.apps.list.unpublishShown` | Unpublish shown | Angezeigte zurückziehen |
| `admin.apps.list.publishConfirm_one` | This app becomes visible to its users: | Diese App wird für ihre Benutzer sichtbar: |
| `admin.apps.list.publishConfirm_other` | These {{count}} apps become visible to their users: | Diese {{count}} Apps werden für ihre Benutzer sichtbar: |
| `admin.apps.list.unpublishConfirm_one` | Users can no longer open this app: | Benutzer können diese App nicht mehr öffnen: |
| `admin.apps.list.unpublishConfirm_other` | Users can no longer open these {{count}} apps: | Benutzer können diese {{count}} Apps nicht mehr öffnen: |
| `admin.apps.list.noMatch` | No app matches "{{query}}". | Keine App passt zu „{{query}}". |
| `admin.apps.empty.title` | No apps yet | Noch keine Apps |
| `admin.apps.empty.body` | An app is an assistant for one task, for example "Summarize a text" or "Answer questions about our travel policy". | Eine App ist ein Assistent für eine Aufgabe, zum Beispiel „Text zusammenfassen" oder „Fragen zur Reiserichtlinie beantworten". |
| `admin.apps.status.published` | Published | Veröffentlicht |
| `admin.apps.status.notPublished` | Not published | Nicht veröffentlicht |
| `admin.apps.edit.publish.action` | Publish | Veröffentlichen |
| `admin.apps.edit.publish.title` | Publish "{{name}}"? | „{{name}}" veröffentlichen? |
| `admin.apps.edit.publish.who` | Who will see it | Wer die App sehen wird |
| `admin.apps.edit.publish.everyone` | Everyone can use this app, including people who are not signed in. | Alle können diese App nutzen, auch Personen, die nicht angemeldet sind. |
| `admin.apps.edit.publish.everyoneSignedIn` | Everyone who signs in can use this app. | Alle, die sich anmelden, können diese App nutzen. |
| `admin.apps.edit.publish.groups` | Members of these groups can use it: {{groups}}. | Mitglieder dieser Gruppen können sie nutzen: {{groups}}. |
| `admin.apps.edit.publish.noGroups` | No group can use this app yet. Choose groups under "Who can use this app". | Noch darf keine Gruppe diese App nutzen. Wählen Sie Gruppen unter „Wer die App nutzen darf". |
| `admin.apps.edit.publish.partial` | You see only the groups you manage. Other people may also be able to use it; ask an administrator. | Sie sehen nur die Gruppen, die Sie verwalten. Möglicherweise können weitere Personen sie nutzen; fragen Sie einen Administrator. |
| `admin.apps.edit.publish.noOwnGroups` | None of the groups you manage can use this app yet. Other people may be able to use it; ask an administrator. | Keine der Gruppen, die Sie verwalten, darf diese App bisher nutzen. Möglicherweise können andere Personen sie nutzen; fragen Sie einen Administrator. |
| `admin.apps.edit.publish.savesFirst` | Your unsaved changes are saved first. | Ihre ungespeicherten Änderungen werden zuerst gespeichert. |
| `admin.apps.edit.publish.noModel` | No AI model is available. Users will see "No models available". | Es ist kein KI-Modell verfügbar. Benutzer sehen „Keine Modelle verfügbar". |
| `admin.apps.edit.unpublish.action` | Unpublish | Zurückziehen |
| `admin.apps.edit.unpublish.title` | Unpublish "{{name}}"? | „{{name}}" zurückziehen? |
| `admin.apps.edit.unpublish.body` | Users can no longer open the app. | Benutzer können die App nicht mehr öffnen. |
| `admin.apps.edit.notPublishedHint` | Not published. Only you and others who manage apps can open and test this app. | Nicht veröffentlicht. Nur Sie und andere, die Apps verwalten, können diese App öffnen und testen. |
| `admin.apps.edit.testNoAccess.title` | Your groups cannot use this app yet | Ihre Gruppen dürfen diese App noch nicht nutzen |
| `admin.apps.edit.testNoAccess.body` | Give one of your groups access, then test it. | Geben Sie einer Ihrer Gruppen Zugriff und testen Sie dann. |
| `admin.apps.edit.access.everyoneSignedIn` | Everyone who signs in | Alle, die sich anmelden |
| `admin.apps.edit.liveHint` | Users get the change as soon as you save. | Benutzer erhalten die Änderung, sobald Sie speichern. |
| `admin.apps.edit.fieldsNeedAttention_one` | 1 field needs your attention. | 1 Feld benötigt Ihre Aufmerksamkeit. |
| `admin.apps.edit.fieldsNeedAttention_other` | {{count}} fields need your attention. | {{count}} Felder benötigen Ihre Aufmerksamkeit. |
| `admin.apps.edit.showFirstError` | Show | Anzeigen |
| `admin.apps.edit.more` | More | Mehr |
| `admin.apps.edit.expandAll` | Expand all | Alle aufklappen |
| `admin.apps.edit.collapseAll` | Collapse all | Alle zuklappen |
| `admin.apps.edit.jump` | Jump to section | Zu Abschnitt springen |
| `admin.apps.edit.groups.basics` | Basics | Grundlagen |
| `admin.apps.edit.groups.instructions` | Instructions and inputs | Anweisungen und Eingaben |
| `admin.apps.edit.groups.model` | Model | Modell |
| `admin.apps.edit.groups.knowledge` | Knowledge and tools | Wissen und Werkzeuge |
| `admin.apps.edit.groups.chat` | Chat features | Chat-Funktionen |
| `admin.apps.edit.groups.input` | Input and voice | Eingabe und Sprache |
| `admin.apps.edit.groups.userSettings` | What users can change | Was Benutzer ändern können |
| `admin.apps.edit.groups.access` | Who can use this app | Wer die App nutzen darf |

The summary lines of collapsed groups are composed by the editor-form slice from existing on/off
words. That slice hands its keys to the words slice; the rule is in section 3.5.

The publish dialog never prints the name of a group that every signed-in user carries
("Authenticated"). The sentences `publish.everyone` and `publish.everyoneSignedIn` stand for
those groups (section 3.4).

### 4.4 Errors

**A failed draft.** The message is chosen from the response `code`, and for one row from
`details.limiter`. The client never branches on text. The mapping lives in `generateErrors.js`
as an exported map from code to key.

| Code | Key (`admin.apps.create.error.*`) | en | de |
|---|---|---|---|
| 503 `APP_GENERATOR_NO_MODEL` | `noModel` | No AI model is available to you, so a draft cannot be prepared. Start from a template or start empty, or ask an administrator to set up a model. | Ihnen steht kein KI-Modell zur Verfügung, daher kann kein Entwurf vorbereitet werden. Beginnen Sie mit einer Vorlage oder leer, oder bitten Sie einen Administrator, ein Modell einzurichten. |
| 502 `APP_GENERATOR_INVALID_ANSWER` | `unreadable` | The AI's draft could not be used. Try again. | Der Entwurf der KI ließ sich nicht verwenden. Versuchen Sie es erneut. |
| `NETWORK`, `PROVIDER_ERROR`, `EMPTY_RESPONSE`, `TIMEOUT`, and the client's own 90-second timeout | `model` | The AI model did not answer. Try again in a moment. | Das KI-Modell hat nicht geantwortet. Versuchen Sie es gleich noch einmal. |
| `AUTH_FAILED`, `MODEL_NOT_FOUND`, `INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED` | `modelSetup` | The AI model is not set up correctly. Ask an administrator. You can still start from a template or start empty. | Das KI-Modell ist nicht richtig eingerichtet. Wenden Sie sich an einen Administrator. Sie können trotzdem mit einer Vorlage oder leer beginnen. |
| 429 `QUOTA_EXCEEDED` | `quota` | You have reached your usage limit, so a draft cannot be prepared now. Ask an administrator, or start from a template or start empty. | Sie haben Ihr Nutzungslimit erreicht, daher kann jetzt kein Entwurf vorbereitet werden. Wenden Sie sich an einen Administrator oder beginnen Sie mit einer Vorlage oder leer. |
| 422 `CONTENT_POLICY` | `refused` | The AI model refused this description. Change the wording and try again. | Das KI-Modell hat diese Beschreibung abgelehnt. Ändern Sie die Formulierung und versuchen Sie es erneut. |
| 429 `RATE_LIMITED` with `details.limiter: "appGenerator"` | `tooManyDrafts` | You have prepared many drafts in the last hour. Try again later, or start from a template or start empty. | Sie haben in der letzten Stunde viele Entwürfe vorbereitet. Versuchen Sie es später erneut oder beginnen Sie mit einer Vorlage oder leer. |
| 429 `RATE_LIMITED` without that detail (the admin limit, or a throttled model provider) | `busy` | Too many requests right now. Wait a moment and try again. | Im Moment gibt es zu viele Anfragen. Warten Sie einen Moment und versuchen Sie es erneut. |
| 403 `FEATURE_DISABLED` | `admin.apps.create.generatorOff` | (see 4.2) | (see 4.2) |
| `ABORTED` (the author pressed Cancel) | none | no message | no message |
| any other code | `failed` | The draft could not be prepared. {{detail}} | Der Entwurf konnte nicht vorbereitet werden. {{detail}} |
| empty description (client check) | `empty` | Describe the app first. | Beschreiben Sie zuerst die App. |
| description over 2,000 characters (client check) | `tooLong` | Shorten your description to at most 2,000 characters. | Kürzen Sie Ihre Beschreibung auf höchstens 2.000 Zeichen. |

Why the rows are split: "Try again" is wrong advice when a retry cannot help. A model with a wrong
key passes the page's model check and then fails every draft with `AUTH_FAILED`. A draft call
counts against the author's usage limit (`server/services/loop/LLMClient.js:722-725`), so
`QUOTA_EXCEEDED` is a real answer. `RATE_LIMITED` is both the code of the server's own limiters
and the code of a throttled provider (`shared/apiErrors.js:61-63`), so the draft limiter marks
its answer with `details.limiter`. `{{detail}}` is the response's `detail`, which the server
already translates.

**The two new registry codes** need a text for every UI language the registry test checks
(`server/tests/errorMiddleware.test.js:365-371`):

| Key | en | de |
|---|---|---|
| `apiErrors.APP_GENERATOR_NO_MODEL` | No AI model is available to you, so a draft cannot be prepared. | Ihnen steht kein KI-Modell zur Verfügung, daher kann kein Entwurf vorbereitet werden. |
| `apiErrors.APP_GENERATOR_INVALID_ANSWER` | The AI's draft could not be used. | Der Entwurf der KI ließ sich nicht verwenden. |

**Creating.** The mapping lives in `createErrors.js`, again as an exported map.

| Case | Key (`admin.apps.create.error.*`) | en | de |
|---|---|---|---|
| name empty | `nameRequired` | Enter a name. | Geben Sie einen Namen ein. |
| description empty | `descriptionRequired` | Enter a short description. | Geben Sie eine Kurzbeschreibung ein. |
| instructions empty | `instructionsRequired` | Enter instructions. One sentence is enough to start. | Geben Sie Anweisungen ein. Ein Satz genügt für den Anfang. |
| ID empty | `idRequired` | Enter an app ID. | Geben Sie eine App-ID ein. |
| ID format | `idFormat` | Use only lowercase letters, digits, hyphens, dots and underscores, without spaces. Example: {{example}} | Verwenden Sie nur Kleinbuchstaben, Ziffern, Bindestriche, Punkte und Unterstriche, ohne Leerzeichen. Beispiel: {{example}} |
| ID over 50 characters | `idTooLong` | The app ID can have at most 50 characters. | Die App-ID darf höchstens 50 Zeichen haben. |
| ID taken, or 409 `CONFLICT` | `idTaken` | An app with the ID "{{id}}" already exists. Choose another ID. | Es gibt bereits eine App mit der ID „{{id}}". Wählen Sie eine andere ID. |
| ID is reserved | `idReserved` | "{{id}}" cannot be used as an app ID. Choose another ID. | „{{id}}" kann nicht als App-ID verwendet werden. Wählen Sie eine andere ID. |
| address empty or not http(s) | `urlFormat` | Enter the full website address, starting with https:// | Geben Sie die vollständige Adresse der Website ein, beginnend mit https:// |
| summary, one error | `summary_one` | 1 field needs your attention. | 1 Feld benötigt Ihre Aufmerksamkeit. |
| summary, several errors | `summary_other` | {{count}} fields need your attention. | {{count}} Felder benötigen Ihre Aufmerksamkeit. |
| 400 `VALIDATION_FAILED` | `validation` | The app could not be created because these entries are not accepted: {{fields}}. | Die App konnte nicht erstellt werden, weil diese Angaben nicht akzeptiert werden: {{fields}}. |
| 401 / 403 | `forbidden` | You are not allowed to create apps. Ask an administrator. | Sie dürfen keine Apps erstellen. Wenden Sie sich an einen Administrator. |
| network failure | `offline` | The server cannot be reached. Your entries are still here. Try again. | Der Server ist nicht erreichbar. Ihre Eingaben sind noch da. Versuchen Sie es erneut. |
| anything else | `unknown` | The app could not be created. {{detail}} | Die App konnte nicht erstellt werden. {{detail}} |

`{{fields}}` is built from `details.issues[].path` through the field labels of 4.2, so the author
reads "Name, Instructions", not `name.en, system`.

### 4.5 Editor relabels and help texts

Most of these keys are already referenced in code with an English fallback and are missing from
the JSON files. Defining a key changes the label. The key names below are the ones the code uses
today, so no call site has to be renamed for them. The baseline entry of a key is deleted in the
change that defines it.

**The rule for the two groups that are open by default** (Basics, Instructions and inputs): every
label, heading, legend, button and placeholder in them uses the vocabulary of 4.1. The words
Variable, Starter Prompt, System Prompt, Prompt Template, App Type and Order do not appear there
as a label, heading or button, in either language. "System prompt" appears once, in the help text
of Instructions.

Instructions (`SystemInstructionsSection.jsx`):

| Key (`admin.apps.edit.*`) | Today | en | de |
|---|---|---|---|
| `systemInstructions` | System Instructions | Instructions | Anweisungen |
| `systemInstructionsDesc` | System prompts that define the app behavior | Tell the AI what its task is and how it should answer. It reads this before every chat; users do not see it. (Also called the system prompt.) | Sagen Sie der KI, was ihre Aufgabe ist und wie sie antworten soll. Sie liest das vor jedem Chat; Benutzer sehen es nicht. (Auch System-Prompt genannt.) |
| `prompt` | Prompt Template | Message template | Nachrichtenvorlage |
| `promptHelp` (new) | | Optional. Text that is sent together with every message of a user. Write one placeholder for each input field. Write {{content}} where the user's message should go; without it, the message is added at the end. | Optional. Text, der mit jeder Nachricht eines Benutzers gesendet wird. Schreiben Sie je einen Platzhalter pro Eingabefeld. Schreiben Sie {{content}} an die Stelle, an der die Nachricht des Benutzers stehen soll; ohne diese Angabe wird die Nachricht am Ende angefügt. |
| `messagePlaceholder` | Message Placeholder | Hint in the message box | Hinweis im Eingabefeld |
| `messagePlaceholderHelp` (new) | | Grey text in the empty message box, for example "Paste your text here". | Grauer Text im leeren Eingabefeld, zum Beispiel „Fügen Sie Ihren Text hier ein". |

The hard-coded placeholder objects of this section ("Enter prompt template in English", …) are
removed. The help line under each field says what belongs there.

Input fields (`VariablesSection.jsx`):

| Key (`admin.apps.edit.*`) | Today | en | de |
|---|---|---|---|
| `variables` | Variables | Input fields | Eingabefelder |
| `variablesDesc` | Configure input variables for dynamic prompts | Fields users fill in before they send, for example a language or a tone. Each field has a placeholder. What a user enters replaces the placeholder in the instructions and in the message template. | Felder, die Benutzer vor dem Senden ausfüllen, zum Beispiel eine Sprache oder einen Ton. Jedes Feld hat einen Platzhalter. Die Eingabe des Benutzers ersetzt den Platzhalter in den Anweisungen und in der Nachrichtenvorlage. |
| `variablesEmpty` (new) | | No input fields. Users write a message, nothing else. | Keine Eingabefelder. Benutzer schreiben nur eine Nachricht. |
| `variable` | Variable | Input field | Eingabefeld |
| `addVariable` | Add Variable | Add input field | Eingabefeld hinzufügen |
| `variableLabel` | Label | Field name | Feldname |
| `variableLabelHelp` (new) | | The text users see above the field. | Der Text, den Benutzer über dem Feld sehen. |
| `variableName` | Name | Placeholder | Platzhalter |
| `variableNameHelp` (new) | | Write {{placeholder}} in the instructions or the message template. It is replaced by what the user enters. | Schreiben Sie {{placeholder}} in die Anweisungen oder die Nachrichtenvorlage. Es wird durch die Eingabe des Benutzers ersetzt. |
| `variableUnused` (new) | | This field is not used yet. The AI does not receive what users enter. | Dieses Feld wird noch nicht verwendet. Die KI erhält die Eingabe der Benutzer nicht. |
| `variableAddToTemplate` (new) | | Add to message template | Zur Nachrichtenvorlage hinzufügen |
| `variableType` | Type | Kind of field | Art des Felds |
| `typeString` | String | Short text | Kurzer Text |
| `typeText` | Text | Long text | Langer Text |
| `typeSelect` | Select | Dropdown (choose one) | Auswahlliste (eine Auswahl) |
| `typeDate` | Date | Date | Datum |
| `typeNumber` | Number | Number | Zahl |
| `required` | Required | Users must fill this in | Benutzer müssen das ausfüllen |
| `defaultValue` | Default Value | Prefilled value | Vorbelegter Wert |
| `predefinedValues` | Predefined Values | Options | Auswahlmöglichkeiten |
| `option` | Option | Option | Option |
| `value` | Value | Text the AI receives | Text, den die KI erhält |
| `addOption` | Add Option | Add option | Option hinzufügen |
| `startFormHelp` | (names "variables" and "prompt template") | A new chat opens with the input fields as a form instead of the message box, with a drop zone for files when uploads are on. Sending the form fills the message template once and sends it as the first message. The conversation then continues without the template. | Ein neuer Chat öffnet sich mit den Eingabefeldern als Formular statt mit dem Eingabefeld, bei eingeschaltetem Upload mit einer Ablagefläche für Dateien. Das Absenden füllt die Nachrichtenvorlage einmal aus und sendet sie als erste Nachricht. Danach läuft die Unterhaltung ohne die Vorlage weiter. |
| `variablesPanelPinned` | Pin the input parameters by default | Keep the input fields open beside the chat | Eingabefelder neben dem Chat geöffnet lassen |
| `variablesPanelPinnedHelp` | (names "input parameters") | Open, the input fields stay beside the chat. Otherwise they collapse each time a message is sent and can be opened again. Users can change this themselves; the setting says where it starts. | Geöffnet bleiben die Eingabefelder neben dem Chat stehen. Sonst klappen sie nach jeder gesendeten Nachricht zu und lassen sich wieder öffnen. Benutzer können das selbst ändern; die Einstellung legt den Anfangszustand fest. |

Conversation starters (`StarterPromptsSection.jsx`):

| Key (`admin.apps.edit.*`) | Today | en | de |
|---|---|---|---|
| `starterPrompts` | Starter Prompts | Conversation starters | Einstiegsfragen |
| `starterPromptsDesc` | Pre-defined prompts to help users get started | Buttons in an empty chat. A click puts the text into the message box. | Schaltflächen in einem leeren Chat. Ein Klick setzt den Text in das Eingabefeld. |
| `starterPrompt` | Starter Prompt | Conversation starter | Einstiegsfrage |
| `addStarterPrompt` | Add Starter Prompt | Add conversation starter | Einstiegsfrage hinzufügen |
| `title` | Title | Text on the button | Text der Schaltfläche |
| `message` | Message | Message | Nachricht |

Basics and the form frame (`BasicInfoSection.jsx`, `AppFormEditor.jsx`):

| Key (`admin.apps.edit.*`) | Today | en | de |
|---|---|---|---|
| `description` | Description | Short description | Kurzbeschreibung |
| `moreDetails` (new) | | More details | Weitere Angaben |
| `appType` | App Type | App type | App-Typ |
| `order` | Order | Position in the app list | Position in der App-Liste |
| `systemPrompt` (label in the error summary, `AppFormEditor.jsx:173`) | System Prompt | Instructions | Anweisungen |
| `validation.systemRequired` (`AppFormEditor.jsx:107`) | System instructions are required | Enter instructions. One sentence is enough to start. | Geben Sie Anweisungen ein. Ein Satz genügt für den Anfang. |
| `groupChanged` (new) | | changed | geändert |

Collapsed groups:

| Key (`admin.apps.edit.*`) | Today | en | de |
|---|---|---|---|
| `settings` | User Settings | What users can change | Was Benutzer ändern können |
| `settingsDesc` | Configure which settings users can modify | Each switch shows or hides one control in the chat. | Jeder Schalter blendet ein Bedienelement im Chat ein oder aus. |
| `enableModelSelection` | Enable Model Selection | Users can choose the AI model | Benutzer können das KI-Modell wählen |
| `enableOutputFormat` | Enable Output Format Selection | Users can choose the answer format | Benutzer können das Antwortformat wählen |
| `enableChatHistory` | Enable Chat History Control | Users can switch off "Remember earlier messages" | Benutzer können „Frühere Nachrichten berücksichtigen" ausschalten |
| `enableStyleControl` | Enable Style Control | Users can choose the response style | Benutzer können den Antwortstil wählen |
| `integrations.title` (defined today) | Integrations | Connected systems | Angebundene Systeme |
| `skillsTitle` (new; replaces the leaf `skills`) | Skills | Skills | Skills |
| `workflowsTitle` (new; replaces the leaf `workflows`) | Workflows | Workflows | Workflows |

The language component (`DynamicLanguageEditor.jsx`, every caller):

| Key (`admin.apps.edit.*`) | Today | en | de |
|---|---|---|---|
| `addLanguage` | Add Language | Add a translation | Übersetzung hinzufügen |

Notes for the implementers:

- `{{content}}` and `{{placeholder}}` in the help texts are literal text for the reader. i18next
  would treat them as interpolation, so pass them as values
  (`t(key, { content: '{{content}}' })`).
- "in the instructions" is true: `PromptService` replaces every variable in the system prompt
  (`server/services/PromptService.js:542-548`). "without it, the message is added at the end" is
  true as well (`PromptService.js:495-500`).
- **Two keys are used both as a text and as a parent of other keys**, which JSON cannot hold.
  `SkillsConfigSection.jsx:52,74` calls `t('admin.apps.edit.skills', 'Skills')`, while
  `SkillsSelector.jsx:192-193` calls `admin.apps.edit.skills.noResults` and `.noSkills`. The same
  holds for `WorkflowsConfigSection.jsx:15` and `WorkflowsSelector.jsx:175-176`. The two section
  files therefore switch to `skillsTitle` and `workflowsTitle`. The words slice defines these two
  keys and the nested selector keys. The existing key test counts a key that resolves to an
  object as present, so it would not catch the conflict; the new i18n test checks that every
  literal key used in `app-form/` resolves to a string.
- Every other key that the app list, `AdminAppEditPage.jsx`, `AppFormEditor.jsx` and the files in
  `app-form/` use without a definition gets its current fallback text as the English value and a
  German translation. These files then leave `tests/unit/client/translation-keys-baseline.json`
  (163 entries today, plus the 91 of the two deleted components).
- In the same pass, the `admin.apps.*` German strings that say „Nutzer" become „Benutzer", and
  `admin.apps.edit.integrations.notInstalledOptionalHelp` loses its *du* form.

## 5. Technical design

### 5.1 Shared modules

**`shared/appDefaults.js`** (new; imported by the create page, the editor and the server)

```js
export const DEFAULT_APP_COLOR = '#4F46E5';
export const DEFAULT_APP_ICON = 'chat-bubbles';
export const DEFAULT_APP_CATEGORY = 'utility';
/** false: apps created in the UI start not published. See README 6.3 before changing it. */
export const UI_CREATES_PUBLISHED = false;

export function newAppDefaults(language = 'en')   // a complete new chat app
export function padLoadedApp(app)                 // what the editor adds to a loaded app
export function cleanAppForSave(app)              // what is sent to POST and PUT
export function primaryLanguageOf(app, uiLanguage, platformDefault)  // the language the UI edits first
```

- `newAppDefaults` is today's `makeDefault()` (`AdminAppEditPage.jsx:82-154`) with
  `name`/`description`/`system` as `{ [language]: '' }` and `enabled: UI_CREATES_PUBLISHED`.
  `preferredStyle` is `'keep'`; the wizard's `'normal'` (`AppCreationWizard.jsx:40`) goes away
  with the wizard.
- `padLoadedApp` is the block the editor runs on load today (`AdminAppEditPage.jsx:156-228`).
- `cleanAppForSave` is `cleanAppData` (`AdminAppEditPage.jsx:257-324`) plus the two rules of
  `buildAppPayloadFromWizard`: drop empty languages of `name`, `description`, `system`; drop
  `messagePlaceholder` and `prompt` when no language has text.
- `primaryLanguageOf` returns the first of these that has text in `app.name`: the base language
  of the UI, the platform's default language, `en`, the first language of the object. For an app
  without a name it returns the base language of the UI. The editor's language component and the
  Essentials screen of a copy use it, so a German-only app is edited in German by an admin with
  an English UI.
- The editor imports all four and keeps no default object of its own.

**`shared/appId.js`** (new)

```js
export const RESERVED_APP_IDS = ['new', 'templates', 'integration-status'];
export function slugifyAppId(text)          // 'Übersetzer für Verträge' -> 'uebersetzer-fuer-vertraege'
export function isValidAppId(id)            // APP_ID_PATTERN, max 50, not reserved, no leading '_'
export function uniqueAppId(base, isTaken)  // base, base-2, base-3 …; '' -> 'app'
```

`slugifyAppId` maps ä/ö/ü/ß to ae/oe/ue/ss, strips other marks, lower-cases, turns every other run
into `-`, trims `-._` and cuts so that a suffix still fits in 50 characters. Its only source for
the pattern is `shared/validationPatterns.js`. An ID that starts with `_` is refused by the client
because action routes use that prefix (`_generate`, `_reorder`, `_toggle`).

**`shared/appPlaceholders.js`** (new; imported by the server's sanitiser, the create page and
`VariablesSection`)

```js
export function placeholdersIn(text)                  // '{{a}} … {{b}}' -> ['a', 'b']; 'content' is not a field
export function unusedVariables(app)                  // fields whose placeholder is in no language of system or prompt
export function variablesUsedInInstructions(app)      // field names found in any language of system
export function addVariableToTemplate(app, variable, language)  // appends '<label>: {{name}}' to prompt[language]
export function removeVariables(app)                  // drops the fields and the template lines that use them
export function placeholderFromLabel(label, taken)    // 'Reading level' -> 'reading_level'
```

A field is "used" when `{{name}}` occurs in the instructions or the message template. That is
the only way a value reaches the model: `PromptService` replaces placeholders where they occur
and appends nothing for a field without one (`server/services/PromptService.js:487-500`,
`:542-548`). `placeholderFromLabel` produces names that match `VARIABLE_NAME_PATTERN`
(`shared/validationPatterns.js:52`).

**`client/src/features/admin/utils/appDraft.js`** (new; replaces `appWizardPayload.js`)

```js
export function contentLanguage(uiLanguage, platformDefault)  // 'de-DE' -> 'de'; unknown -> platform default
export function appCategoryOptions(uiConfig, current)         // moved unchanged
export function draftFromBlank(language)
export function draftFromTemplate(template, { language, isTaken })
export function draftFromExistingApp(app, { isTaken, copyLabel })
export function draftFromGenerated(result, { webSearch, integrationIds, inputFields })
export function draftForLink({ language, mode, url })
export function dropOtherLanguages(draft, editedFields)       // for a copy, before create
export function buildCreatePayload(draft)                     // cleanAppForSave + id check
```

The language rule differs by start, and each rule has a test:

| Start | Languages of the stored app |
|---|---|
| Empty, link, AI draft | One: the content language. |
| Template | One: the content language. `draftFromTemplate` keeps only that language of `name`, `description`, `system`, `prompt`, `messagePlaceholder`, input-field labels and options, and conversation starters. The template files carry `en` and `de`. For another content language the `en` text is the starting text and is stored under the content language. |
| Copy (`?from=<id>` or the picker) | Every language of the source. `draftFromExistingApp` deep-copies. The Essentials screen edits the language `primaryLanguageOf(source, uiLanguage)`. Before create, `dropOtherLanguages` removes the other languages of each of `name`, `description` and `system` that the author changed. The screen says so (3.2). A text the author did not touch keeps all its languages. |

Why a copy loses languages: the runtime picks a text by the user's language first
(`shared/localize.js:20-21`). If the author rewrites the German instructions and the English
ones stay, users with an English UI get the instructions of the source app, and nothing shows
that.

`draftFromExistingApp` also removes `parentId`, `inheritanceLevel`, `overriddenFields`,
`allowInheritance` and `order`, appends the localized "(copy)" to every language of `name`, sets
`enabled` from `UI_CREATES_PUBLISHED` and derives a free ID. `draftFromTemplate` derives a free ID
and adds no "(copy)". `draftFromGenerated` takes the server's app as it is and adds only the
suggestions the author ticked; it never spreads raw model output. With `inputFields: false` it
calls `removeVariables`.

### 5.2 Server endpoints

New routes live in `server/routes/admin/appBuilder.js`, registered in
`server/routes/adminRoutes.js` before `registerAdminAppsRoutes`. Both use `contentAdminAuth`, sit
under `/api/admin` (so `adminApiLimiter` applies) and throw `ServiceError`. Each route carries its
OpenAPI comment block (request, 200 body, every code of its table), written before the handler,
as `docs/api-guidelines.md` section 9 asks.

#### `POST /api/admin/apps/_generate`

An action on the collection, like the existing `POST /api/admin/apps/_usage-guide`
(`server/routes/admin/appUsageGuide.js:58`). It stores nothing and answers 200.

Request: `{ "description": "…", "language": "de" }`. `description` is a string of 1 to 2,000
characters after trimming. `language` is optional and must match the language-code pattern; the
default is `platform.defaultLanguage`. No other key is read: the caller cannot send messages, a
model ID, `maxTokens` or a schema.

Response 200:

```json
{
  "app": { "id": "plain-language-summary", "name": { "de": "…" }, "system": { "de": "…" }, "enabled": false, "…": "…" },
  "suggestions": {
    "websearch": true,
    "integrations": [{ "id": "jira", "label": "Jira", "actions": ["searchIssues", "getIssue"] }]
  },
  "warnings": [{ "code": "CATEGORY_REPLACED", "field": "category" }],
  "model": { "id": "gemini-flash", "name": "Gemini Flash" },
  "brief": "standard"
}
```

`app` is `newAppDefaults(language)` plus the sanitised answer: complete, schema-valid, unsaved. It
never contains `integrations` or `websearch`. `suggestions` holds what the model proposed and the
caller may use. `warnings` lists what the sanitiser dropped, replaced or added. `brief` is
`standard` or `customised` (step 2).

| Situation | Status | `code` |
|---|---|---|
| Body invalid | 400 | `VALIDATION_FAILED` |
| Not a content admin; machine or delegated principal | 401 / 403 | as `contentAdminAuth` answers today |
| Feature `appGenerator` off | 403 | `FEATURE_DISABLED` (exists) |
| No chat model the caller may use | 503 | `APP_GENERATOR_NO_MODEL` (new) |
| The caller's usage limit is reached | 429 | `QUOTA_EXCEEDED` (exists; thrown by the model client) |
| The model call failed | as `llmClient` throws | the existing `LLM_API_ERROR_CODES` |
| The answer is not JSON, is cut off, or nothing usable is left | 502 | `APP_GENERATOR_INVALID_ANSWER` (new), `details.reason`: `not-json`, `truncated` or `incomplete` |
| More than 30 drafts in an hour | 429 | `RATE_LIMITED`, `details.limiter: "appGenerator"` |
| Above the admin budget | 429 | `RATE_LIMITED` |

503 for "no model" follows the usage-guide route, which answers `SERVICE_UNAVAILABLE` in the same
situation (`appUsageGuide.js:71-73`). The specific code exists because the client shows a specific
message.

What the server does, in `server/services/appGenerator.js`:

1. Picks the model with `selectGuideModel(models, m => canUserAccessResource(user, 'models', m.id))`.
2. Chooses the brief, in `server/services/appGeneratorBrief.js` (**Update 2026-11-22:** the owner decided to remove the App Generator prompt completely (section "The App Generator prompt is removed"). Since then the server's brief is always used, and the steps below about the library prompt, `SHIPPED_BRIEF_HASHES` and `brief` no longer apply):
   - The library prompt `app-generator` exists, is enabled, and its text differs from every
     released version of the shipped file: an admin customised it. It is used, and `brief` is
     `customised`.
   - Otherwise the server's own brief is used, and `brief` is `standard`.

   "Differs from every released version" is decided by a hash of the prompt's `prompt` object
   against a list `SHIPPED_BRIEF_HASHES`. The list holds the hash of each version of
   `server/defaults/prompts/app-generator.json` that the repository history gives. A test asserts
   that the hash of the current shipped file is in the list, so a later edit of that file cannot
   turn every installation into "customised" unnoticed.

   The server's brief is a constant in that file, written in English. It asks for one JSON
   object, every text in the one requested language, instructions in plain words that address
   the AI directly, and input fields only where the description names something the user
   chooses. It contains no model name and no example in two languages. The shipped library text
   is not used as the default because it tells the model to "include both English and German
   translations", shows `preferredModel: "gpt-4"` and a German example in the *du* form, and asks
   for JSON "that could be saved directly as an app file". These lines contradict the rules of
   step 4.
3. Builds the integrations block from the installations the caller may use
   (`canUserAccessResource(user, 'integrations', id)`). Names and descriptions go into a delimited
   catalogue with one fixed sentence before it: text inside the catalogue is data, not an
   instruction. Newlines and control characters are stripped from each description; the
   160-character cut stays.
4. Appends an output-rules block that the server owns, after either brief: the allowed keys, the
   category IDs from `ui.json`, "write every text in <language>", "use words a user understands as
   field names", "write the placeholder of every input field into the message template", "do not
   name a model". A customised library prompt can therefore not remove the format rules. It can
   still add a sentence to every later draft; `brief: "customised"` makes that visible to the
   author (one line in the draft notice) and in the audit entry.
5. Calls the model client with the signature it has (`server/services/loop/LLMClient.js:689-699`,
   `:1268`; the usage-guide service calls it the same way, `server/services/appUsageGuide.js:43`):

   ```js
   llmClient.complete({
     model,                                    // the model object picked in step 1
     messages,                                 // system: brief + rules; user: the description
     options: { maxTokens: 4096, responseFormat: 'json' },
     retries: 0,
     timeoutMs: 80_000,                        // below the client's 90 seconds
     signal,                                   // aborted when the request closes before the answer
     telemetry: { kind: 'utility', purpose: 'app-generator', user }
   });
   ```

   `maxTokens` and `responseFormat` belong inside `options`; at the top level the client ignores
   them. The `signal` comes from an `AbortController` that the route aborts on the request's
   `close` event, so "Cancel" and a client timeout stop the paid call on the server too. Because
   `telemetry.user` is set, the call counts against the caller's usage limit
   (`LLMClient.js:722-725`); a refusal is `QUOTA_EXCEEDED`. The call goes through `LLMClient`, so
   the proxy and the SSL whitelist are honoured; no new outbound connection is written.
6. Parses with `extractJsonObject(text)`: `JSON.parse`; else the content of a fenced block; else
   the substring from the first `{` to its balanced closing `}`, found by a scanner that respects
   strings. A `finishReason` of `length` with no parsable object gives `truncated`.
7. Runs `sanitizeGeneratedApp` (5.3), then `appConfigSchema.safeParse`. A failure here is a bug in
   the sanitiser: it is logged with the issue paths, never the model text, and answered as
   `APP_GENERATOR_INVALID_ANSWER`.
8. Writes an audit entry with the existing action `execute` and resource `app`. `details` holds
   `{ purpose: 'app-generator', modelId, usage, descriptionLength, brief }` (`brief` was dropped on 2026-11-22). The action
   `generate` of the first plan is not in the audit schema's list
   (`server/validators/auditEntrySchema.js:13-37`), so every draft would have logged a validation
   warning. Neither the description nor the answer is logged above debug level, and nothing
   reaches the browser console.

**The draft limit.** `server/middleware/rateLimiting.js` gets one more exported factory,
`createAppGeneratorLimiter(platformConfig)`, in the style of `createOAuthTokenLimiter`
(`rateLimiting.js:466`): keyed per user, counted in the store that all cluster workers share,
`limit: 30`, `windowMs` one hour, `skipFailedRequests: false`. Its values are code defaults under
a new fallback key `appGeneratorApi`; nothing is written to `platform.json` and no migration is
needed. The handler adds `details: { limiter: 'appGenerator' }` to the `RATE_LIMITED` error; for
that, `createRateLimiter` takes one more optional argument. The route mounts the limiter itself.
Failed drafts must count: a draft that ends in 502 is a model call that was paid for, and the
admin limiter skips failed requests as shipped (`server/defaults/config/platform.json:240-246`).

#### `GET /api/admin/app-templates`

```json
{ "items": [{ "id": "summarizer", "name": { "en": "…", "de": "…" }, "description": { "…": "…" },
              "icon": "document-text", "color": "#F59E0B", "category": "analysis",
              "hasInputFields": true, "app": { "…": "…" } }],
  "nextCursor": null }
```

The templates are files written for the gallery, in `server/appTemplates/`. The directory is
outside `server/defaults/`, because the setup copies everything under `server/defaults/` into an
installation's `contents/` (`server/utils/setupUtils.js`), and a template must not become a file
an admin edits. `server/services/appTemplates.js` holds the ordered list `APP_TEMPLATE_IDS`:

| ID | What it is | Input fields |
|---|---|---|
| `summarizer` | Summarises a pasted text. | Length (dropdown) |
| `translator` | Translates a text and keeps tone and formatting. | Target language (dropdown) |
| `email-composer` | Drafts an email from a few notes. | Tone (dropdown) |
| `plain-language` | Rewrites a difficult text in plain language. | Reading level (dropdown) |
| `meeting-minutes` | Turns meeting notes into minutes with decisions and tasks. | none |
| `idea-coach` | Asks questions that sharpen an idea. | none; three conversation starters |

The texts of `summarizer`, `translator`, `email-composer` and `idea-coach` are taken from the
shipped apps of the same name and shortened. A template file may contain only these keys: `id`,
`name`, `description`, `icon`, `color`, `category`, `system`, `prompt`, `messagePlaceholder`,
`variables`, `starterPrompts`, `allowEmptyContent`. So a template binds nothing and changes no
setting outside the two groups that are open in the editor.

`loadAppTemplates()` reads and caches the files and skips and logs a file that fails a check.
`server/tests/app-templates.test.js` asserts for every listed ID:

- the file exists and holds no key outside the list above, so it has no `projects`,
  `integrations`, `websearch`, `tools`, `apps`, `workflows`, `skills`, `iassistant`,
  `requiredIntegrations`, `preferredModel`, `allowedModels`, `upload`, `settings` or `enabled`;
- `newAppDefaults()` merged with the file passes `appConfigSchema`;
- `name`, `description` and `system` have text in `en` and in `de`, and so has every other
  localized text the file carries;
- `unusedVariables` is empty: every input field is used by a text;
- the German texts use *Sie* and „Benutzer".

Why not the shipped default apps as they are (the first plan): `meeting-agenda-generator` binds
the project `meeting-knowledge-base` and expects a content block from the Outlook add-in;
`idea-coach` has instructions in English only; `summarizer`, `translator` and `email-composer`
switch upload on and change user settings or the input mode; the message template of
`summarizer` is a block of tags. Four of the six were also shipped with `enabled: false`.

The path is outside `/api/admin/apps/`, so it shadows no app ID. `GET /api/admin/apps/templates`
(every enabled app) is unchanged and now serves "Copy an existing app".

#### Changes to existing routes

| Route | Change | Contract |
|---|---|---|
| `POST /api/admin/apps` (`apps.js:713`) | Reads an optional query parameter `origin` with the values `blank`, `template`, `copy`, `generated`, `link`, `upload`. An unknown value answers 400 `VALIDATION_FAILED`. The audit entry carries the origin in `details`. No snapshot is written on create (D23). | Body, status, `Location` and the `enabled` default stay as they are. The parameter is new and optional, so no existing caller sends it. The OpenAPI block documents it as audit metadata with its enum. |
| `GET` and `PUT /api/admin/content-access/{type}/{id}` (`contentAccess.js:218`, `:306`) | The view gains `audience: { allSignedIn, anonymous }` and, on the rows of groups that every signed-in user carries, `implicit: true`. Both are computed in `server/utils/contentAccess.js` over all groups, for both scopes. | Additive. `scope` and the existing row fields are unchanged. `tests/contract/response-shapes.json` is updated. |
| `POST /api/completions` (`prompts.js:1558`) | `adminApiLimiter` is mounted for the path in `server/middleware/setup.js` (today no limiter covers it, `setup.js:598-635`). | Body and response unchanged. A caller above the configurable admin budget gets 429. |
| Feature registry | New entry `appGenerator`, category `content`, default `true`. | Additive. |

`origin` is a query parameter although `docs/api-guidelines.md` section 1 reserves query
parameters for filtering, sorting and search. It cannot go into the body: the body schema is
strict (`appConfigSchema.js:745`) and the route stores the body as sent (`apps.js:714-732`), so a
body field would be refused or written into the app file. Section 13 names the deviation.

`audience.allSignedIn` tells a content admin that the group every signed-in user carries grants
the app. A content admin does not see that group's row today. The field reveals one fact about
it, the fact the author needs before publishing. Owner question Q20.

`GET /api/admin/prompts/app-generator`, `POST /api/completions` and
`GET /api/admin/apps/{id}/inheritance` stay registered. The first two lose their only client
caller.

### 5.3 What a generated draft may contain

`sanitizeGeneratedApp(raw, { language, categories, installed, isTaken })` is the only path from
model text to an app object. It builds a new object and never spreads the answer.

| Field | Rule |
|---|---|
| `name`, `description`, `system` | A string or a localized object becomes `{ [language]: text }`, trimmed. Caps: 100 / 500 / 8,000 characters. Without `name` or `system` the request fails with `incomplete`. A missing `description` becomes the first sentence of the author's description. |
| `id` | Ignored. The server sets `uniqueAppId(slugifyAppId(name), isTaken)`. |
| `category` | Kept when it is an ID in `ui.json`; else the default, with a warning. |
| `color` / `icon` | Kept when `#RRGGBB` / when it matches `^[a-z0-9-]{1,40}$`; else the default. |
| `prompt`, `messagePlaceholder` | Optional, same localisation. Caps: 4,000 / 200 characters. |
| `variables` | At most 8. `name` must match the schema's rule and be unique. `type` must be in the schema enum, else `string`. `label` becomes `{ [language]: text }` and falls back to the name. A `select` without options becomes `string`. Only `name`, `label`, `type`, `required`, `defaultValue`, `predefinedValues` are copied. |
| input fields that no text uses | After the rows above: for every field in `unusedVariables(app)`, `addVariableToTemplate` appends the line `<label>: {{name}}` to the message template, with the warning `FIELD_ADDED_TO_TEMPLATE`. Without this a model that lists a field and forgets its placeholder produces a field whose value the AI never receives. |
| `allowEmptyContent` | Not taken from the model. The server sets it to `true` when the message template uses at least one input field, so a user can send the form without typing an extra message (`AppChatStarter.jsx:307`). Otherwise the default `false` stays. |
| `starterPrompts` | At most 4; `title` (80) and `message` (500) only. |
| `websearch.enabled === true` | Not set. Reported as `suggestions.websearch`. |
| `integrations` | Not set. `integrationsFromAnswer` (`shared/appGenerator.js:21-35`) filters to installed IDs the caller may use and to declared actions; the result is reported as `suggestions.integrations`. |
| `enabled` | Always `false`. |

Never taken from the model: `type`, `iframeConfig`, `redirectConfig`, `order`, `preferredModel`,
`allowedModels`, `preferredOutputFormat`, `preferredStyle`, `outputSchema`,
`customResponseRenderer`, `rendererConfig`, `features`, `upload`, `uploads`, `toolChoice`,
`toolApproval`, `toolSearch`, `apps`, `workflows`, `skills`, `skillSettings`, `projects`,
`iassistant`, `inputMode`, `settings`, `aiDisclosure`, `documentTemplate`, `greeting`,
`allowEmptyContent`, the inheritance fields, and any key not in the table.

### 5.4 Letting a content admin run an unpublished app

Today `configCache.getApps()` returns only apps with `enabled !== false` whose features and bound
integrations are on (`server/configCache.js:887-906`). Every lookup by ID on the chat path goes
through that list, so a disabled app is "not found" for everyone, and the test panel shows a
message instead of a chat (`AppTestPanel.jsx:216-222`).

With this change one new method decides:

```js
/**
 * The app a request may run, by id (case-insensitive), or null.
 * Published: today's rule. Not published (enabled === false): only for a principal with
 * isContentAdmin === true, and only if the feature and integration gates pass.
 * Group permission is not checked here; every caller keeps its own check.
 */
configCache.getAppForRequest(appId, user)
```

- `isContentAdmin` is set in one place (`server/utils/authorization.js:811`). The anonymous
  principal, API keys, OAuth clients and agents never have it.
- The method does not touch group permissions. `chatAuthRequired` and `canUserAccessResource` run
  as today. A content admin whose groups do not grant the app cannot test it; the test panel
  then says what to do (section 3.3).
- No request flag, header or query parameter is involved.
- Lists are unchanged. `GET /api/apps`, `getAppsForUser` and the sidebar never contain an
  unpublished app, for admins too.

**The request builder is not keyed on the user.** `RequestBuilder.prepareChatRequest`
(`server/services/chat/RequestBuilder.js:410-445`) looks the app up in `getApps()`. It is called
by the interactive chat route (`server/routes/chat/sessionRoutes.js:1629`) and also by scheduled
tasks (`server/services/scheduler/tasks/taskExecution.js:447`), by the inference API
(`server/services/inference/appTurn.js:131`) and by apps that run as tools
(`server/services/chat/ChatService.js:1968`). A scheduled task runs as its owner, so for an
admin's task `isContentAdmin` is true. If the builder used `getAppForRequest(appId, user)`, "an
unpublished app runs only in an interactive chat" would rest on the separate pre-checks of those
callers alone.

So the builder gets one optional parameter, `resolvedApp`. When it is given, the builder uses it;
otherwise it looks the app up in `getApps()` as today. Only the interactive chat route passes it.
The route builds the options object itself (`sessionRoutes.js:1541`) from
`configCache.getAppForRequest(appId, req.user)`; nothing from the request body reaches the
parameter. Every other caller is unchanged and keeps getting "not found" for an unpublished app.

Call sites converted to `getAppForRequest` in this slice. The first two rows are what the test
chat needs. The other rows keep the test chat from behaving differently from the published app.

| Site | Route or function |
|---|---|
| `server/routes/generalRoutes.js:343` | `GET /api/apps/:appId` |
| `server/routes/chat/sessionRoutes.js:1100`, `:1336`, and `resolvedApp` at `:1541` | `POST /api/apps/:appId/chat/:chatId` |
| `server/routes/magicPromptRoutes.js:54` | magic prompt |
| `server/routes/integrations/scopes.js:54`, `userIntegrations.js:301` | integration scopes and user connections |
| `server/services/chat/transcriptionTurn.js:99` | audio transcription turn |
| `server/routes/chat/conversationRoutes.js:80`, `server/routes/chats.js:244`, `:624` | conversation delete, chat read and create |

Not converted, on purpose:

- `RequestBuilder.prepareChatRequest` itself (see above), and with it scheduled tasks, the
  inference API and apps called as tools. Their own guards stay as they are
  (`taskExecution.js:144-149`, `modelIdentifier.js:192`).
- The workflow chat route (`server/routes/workflow/workflowRoutes.js:1075`), the MCP and A2A app
  invokers and the prompt routes.
- `server/routes/voiceRoutes.js:84`. The first plan listed it, but it is not a lookup by ID: it
  loops over `getAppsForUser` to collect the voices a user may request. It stays a list.
  Consequence: a voice that only an unpublished app names is not in the allowed set, so
  read-aloud in the test chat of that app uses the model's voices.
- `server/routes/exports.js:49`, `:58`. Both helpers take an app ID and no user. Converting them
  means changing their signatures and every caller. They stay. Consequence: an export from the
  test chat of an unpublished app uses the default export settings, not the app's own.

Tests (`server/tests/app-unpublished-access.test.js`), written before the conversion:

- A matrix of principal and app state. Principals: anonymous, a normal user with `apps: ['*']`, a
  content admin with the app granted, a content admin without it, an admin's personal API key, an
  OAuth client. States: published, not published, not published with a required feature off.
- Only "content admin with the app granted" gets the unpublished app. For every other principal
  the status and the body are identical to those for an ID that does not exist.
- `GET /api/apps` contains the unpublished app for nobody.
- A scheduled task of a content admin on an unpublished app stays paused with
  `APP_NOT_AVAILABLE`.
- A published app that lists an unpublished app under `apps`: the tool is not offered, and a call
  to it is refused.
- The workflow chat route answers for an unpublished app as for an unknown ID.
- A request body field named `resolvedApp` is ignored.
- A shrink-only ratchet lists the remaining raw lookups by ID in `server/routes` and
  `server/services/chat`, so a new route cannot add one unnoticed.

The cross-user authorization suite attacks the same routes and runs in CI
(`tests/security/authz/resources.js:767-783`, `.github/workflows/security.yml:164`). S5 adds an
unpublished app to its seeded resources and one entry per converted route: a normal user and an
API key get the same 404 for it as for an unknown ID.

### 5.5 Client structure

```
client/src/features/admin/pages/AdminAppCreatePage.jsx     frame, screen switch, create, leave guard
client/src/features/admin/components/app-create/
  useAppDraft.js           reducer: { start, draft, description, idTouched, edited, extras, dirty } + session storage
  StartScreen.jsx          description box slot, templates, empty, "Other ways to start"
  DescribeStart.jsx        text box, examples, Prepare draft, cancel, error by code
  DraftExtras.jsx          the draft notice: description box, new draft, input fields, suggestions
  generateErrors.js        GENERATE_ERROR_KEYS: code -> message key (pure, unit-tested)
  TemplateGallery.jsx      cards from GET /api/admin/app-templates
  ExistingAppPicker.jsx    Modal with search, cards from GET /api/admin/apps/templates
  AppPickCard.jsx          icon tile, name, one line, badge
  EssentialsForm.jsx       name, short description, instructions or link fields, icon, colour
  AppDetailsDisclosure.jsx "More details": App ID, category
  ColorSwatchPicker.jsx    eight swatches plus custom
  NoModelNotice.jsx        also used by the test panel
  createErrors.js          CREATE_ERROR_KEYS; problem+json -> field errors (pure, unit-tested)
  createKeys.js            STEP_KEYS, HEADING_KEYS, NOTE_KEYS: the keys picked by start kind
client/src/features/admin/components/app-editor/           the page's parts (slice S7)
  AppEditorHeader.jsx, PublishDialog.jsx, NextStepsCard.jsx, audienceText.js
client/src/features/admin/components/app-form/             the form's parts (slice S8)
  editorGroups.js, useEditorGroups.js, EditorGroup.jsx, EditorGroupNav.jsx, ChatBehaviourSection.jsx
```

`audienceText.js` is the pure function behind the table of section 3.4: content-access view in,
message key and values out. The publish dialog and the summary line of the access group use it.

No file above 300 lines. The `_generate` call sets a 90-second timeout, because the default for
admin calls is 30 seconds (`client/src/api/client.js:11`), and passes an `AbortSignal` for
"Cancel". `client/src/App.jsx` gets one route, `admin/apps/new`, placed before
`admin/apps/:appId` (`App.jsx:559`). It is not a top-level route, so `KNOWN_ROUTES` and
`client/index.html` do not change.

### 5.6 Deleted

- `client/src/features/apps/components/AppCreationWizard.jsx`, `AppTemplateSelector.jsx` and
  `client/src/features/admin/utils/appWizardPayload.js`.
- Their only importer is `AdminAppsPage.jsx`; its two imports and the modal state go in the same
  change.
- The tests `app-wizard-locale-keys`, `app-wizard-payload` and
  `app-creation-wizard-overridden-fields`.
- The `jest.mock` blocks for the two components in `app-migration-warnings.test.jsx:59,63`,
  `admin-bulk-toggle-confirm.test.jsx:57,61` and `admin-apps-missing-integration.test.jsx:48,52`.
  `jest.mock` of a path that no longer exists fails when the test file loads.
- The 84 and 7 baseline entries of the two components in
  `tests/unit/client/translation-keys-baseline.json`, in the same change: the key test fails for
  a baseline file whose keys are no longer missing
  (`tests/unit/client/translation-keys-exist.test.jsx:199-208`).
- The editor's `makeDefault`, its `isNewApp` branches and its POST branch
  (`AdminAppEditPage.jsx:230-239`).
- The `/admin/apps/new` entry in `KNOWN_VIOLATIONS` (`tests/e2e/accessibility.spec.js:326`). It
  is the only entry that scans the app editor form today (`label: 19`, `select-name: 8`), so it
  is replaced, not only removed (section 7.3).

### 5.7 Migrations and compatibility

No migration. No field is added to, renamed in or removed from an existing config file. The
shipped file `server/defaults/prompts/app-generator.json` is not changed, and the library prompt
of an installation is not touched; the server only stops using an unchanged copy for drafts
(5.2). Apps that carry `parentId`, `inheritanceLevel` or `overriddenFields` keep them and keep
validating. Nothing in this increment needs an entry in
`docs/releases/next/breaking-changes.md`; section 16 lists the behaviour changes and why none of
them is treated as breaking.

## 6. This increment

### 6.1 Slices

Each file has one owner. A slice that needs a change in another slice's file asks its owner.
Slice S6 of the first plan (the apps list) is merged into S3; the number is not reused.

| ID | Slice | Owns | Depends on |
|---|---|---|---|
| S0 | Words | `shared/i18n/en.json`, `shared/i18n/de.json`, new `tests/unit/client/app-builder-i18n.test.jsx`. It is the only slice that adds keys. For `tests/unit/client/translation-keys-baseline.json` see the rules below. | none for pass 1; all for pass 2 |
| S1 | Shared core | `shared/appDefaults.js`, `shared/appId.js`, `shared/appPlaceholders.js`, `client/src/features/admin/utils/appDraft.js`; tests `app-builder-defaults`, `app-builder-id`, `app-builder-placeholders`, `app-builder-draft`, `app-editor-roundtrip` (pure level), rewritten `admin-app-cleanup` (all in `tests/unit/client/`) | none |
| S2 | Server: draft, templates, audience | `server/routes/admin/appBuilder.js`, `server/services/appGenerator.js`, `server/services/appGeneratorBrief.js`, `server/services/appTemplates.js`, the six files in `server/appTemplates/`, `shared/appGenerator.js`, `shared/apiErrors.js`, `server/featureRegistry.js`, one line in `server/routes/adminRoutes.js`, the `origin` change and its OpenAPI block in `server/routes/admin/apps.js`, `server/routes/admin/contentAccess.js`, `server/utils/contentAccess.js`, `server/middleware/rateLimiting.js`, the limiter mount in `server/middleware/setup.js`, `tests/contract/response-shapes.json`; tests `server/tests/app-generate-route.test.js`, `app-generator-sanitize.test.js`, `app-generator-brief.test.js`, `app-templates.test.js`, `content-access-audience.test.js`, extended `app-generator.test.js` and `admin-apps-schema-validation.test.js`; the directory `server/tests/fixtures/app-generator/` | S1 (signatures), S0 pass 1 (the two registry texts) |
| S3 | Create page and apps list | `AdminAppCreatePage.jsx`, everything in `components/app-create/` except the three files of S4, the route in `client/src/App.jsx`, the new calls in `client/src/api/adminApi.js`, `client/src/shared/components/IconPicker.jsx` (dark mode, four columns on phones), `client/src/features/admin/pages/AdminAppsPage.jsx`, `client/src/features/admin/utils/bulkToggleConfirm.js` (one additive option), `AdminCommandPalette.jsx` (label), `SetupWizard.jsx` (verify only). It deletes what section 5.6 lists outside the editor page and the axe entry, and owns the three test files that mock the deleted components: `app-migration-warnings.test.jsx`, `admin-bulk-toggle-confirm.test.jsx`, `admin-apps-missing-integration.test.jsx`. New test `tests/unit/client/app-builder-flow.test.jsx`. | S0 pass 1, S1, S2 (shapes) |
| S4 | Describe start | `app-create/DescribeStart.jsx`, `DraftExtras.jsx`, `generateErrors.js`; test `tests/unit/client/app-builder-describe.test.jsx` | S2 (shapes), S3 (props agreed first) |
| S5 | Try an unpublished app | `server/configCache.js`, the call sites of 5.4 (`generalRoutes.js`, `chat/sessionRoutes.js`, `magicPromptRoutes.js`, `integrations/scopes.js`, `integrations/userIntegrations.js`, `chat/conversationRoutes.js`, `chats.js`, `services/chat/transcriptionTurn.js`), the `resolvedApp` parameter in `server/services/chat/RequestBuilder.js`; test `server/tests/app-unpublished-access.test.js` and its ratchet baseline; the unpublished-app entries in `tests/security/authz/resources.js` and the seed it needs | none |
| S7 | Editor frame | `client/src/features/admin/pages/AdminAppEditPage.jsx`, `AppTestPanel.jsx`, `AdminSaveBar.jsx` (optional message and action), `ContentAccessSection.jsx` (an `onSaved` callback), new `components/app-editor/AppEditorHeader.jsx`, `PublishDialog.jsx`, `NextStepsCard.jsx`, `audienceText.js`; updates `admin-app-editor-save-and-test`, `admin-app-editor-upload-default`, `app-test-panel`; new `app-editor-publish.test.jsx`, `app-editor-audience.test.jsx` | S1, S2 (the `audience` shape), S5 (for the panel), the two contract files of S8 |
| S8 | Editor form | `client/src/features/admin/components/AppFormEditor.jsx`, every file in `components/app-form/` (existing and new: `editorGroups.js`, `useEditorGroups.js`, `EditorGroup.jsx`, `EditorGroupNav.jsx`, `ChatBehaviourSection.jsx`), `client/src/shared/components/DynamicLanguageEditor.jsx`; new tests `app-editor-groups.test.jsx`, `app-editor-one-language.test.jsx`, `app-editor-unused-field.test.jsx` and the rendered level of `app-editor-roundtrip` | S1, S0 pass 1 |
| S9 | End to end, stub, accessibility | `tests/config/e2e-llm-stub.mjs`, new `tests/config/playwright.app-builder.config.js` with its contents seed, new `tests/e2e/app-builder.spec.js`, new `tests/e2e/app-builder-subpath.spec.js`, `tests/config/playwright.subpath.config.js` (one more entry in `testMatch`), `tests/e2e/accessibility.spec.js`, `tests/e2e/admin-controls-visible.spec.js`, the script `test:e2e:app-builder` in `package.json`, new `.github/workflows/app-builder-e2e.yml` | S2 to S8, S11 |
| S10 | Docs and release note | `docs/app-quickstart.md` (new), `docs/SUMMARY.md`, `docs/admin-ui.md`, `docs/apps.md`, `README.md`, `docs/ihub-faq-en.md`, `docs/developer-onboarding.md`, `docs/GETTING_STARTED.md`, `docs/releases/next/features.md`, `docs/releases/next/fixes.md`, screenshots, new `tests/manual/app-builder-descriptions.md` | all |
| S11 | App names in one language | `client/src/features/admin/components/ResourceSelector.jsx`; new test `tests/unit/client/resource-selector-localized.test.jsx` | none |

Order:

1. S0 pass 1, S1, S5 and S11 start at once. S8 publishes its two contract files
   (`editorGroups.js`, `useEditorGroups.js`, section 3.5) with signatures and empty bodies.
2. S2 starts when S1 has published its signatures (empty bodies are enough) and S0 pass 1 is in.
3. S3, S4, S7 and S8 run in parallel after that.
4. S7 and S8 land in one merge, because one removes the `enabled` checkbox and the other adds
   the Publish button.
5. S0 pass 2, S9 and S10 close the increment.

**The first step of S3** is one change that keeps the build and the unit suite green:

- add the route `admin/apps/new` and a page shell;
- let the list button, the empty state and "Duplicate" in `AdminAppsPage.jsx` navigate to it, and
  remove the two imports and the modal state;
- delete the two components, `appWizardPayload.js` and their three tests;
- remove the `jest.mock` blocks from the three test files named above;
- remove the two components' blocks from the translation baseline;
- run the full unit suite.

The first plan gave the list to another slice that followed S3. The list is the only importer of
the two components, so the build would have been red from the deletion until that slice landed.

Rules that keep the slices apart:

- **i18n files.** Only S0 edits `en.json` and `de.json`. Pass 1 adds every key of section 4,
  including the two `apiErrors.*` rows of 4.4 and the fallback keys of the app list, the editor
  page, the form and `app-form/`. A slice that needs one more key hands over key, English and
  German; S0 adds it in pass 2. New client files call `t('key')` without fallback text.
- **Translation baseline.** Nobody adds an entry. An entry is removed by the change that makes it
  stale, whichever slice that is, because the key test fails on a stale entry at once. In
  practice: S0 pass 1 removes the entries of the keys it defines; S3 removes the two blocks of
  the deleted components; S8 removes entries of keys that its files stop using. Removing
  different lines of one JSON file merges without conflict.
- **Between S0 pass 1 and S8** the labels "Skills" and "Workflows" of two collapsed sections are
  wrong on the integration branch: S0 has defined `admin.apps.edit.skills` as an object, and the
  two section files still read it as a text. S8 switches them to `skillsTitle` and
  `workflowsTitle` in its first commit.
- Only S2 edits `shared/apiErrors.js`, `server/routes/admin/*`, `server/utils/contentAccess.js`,
  `server/middleware/rateLimiting.js` and `server/middleware/setup.js`. Only S5 edits
  `server/configCache.js` and the chat-path files.
- S3 only navigates to the editor. Everything on the editor page belongs to S7; everything in
  `app-form/` and the form belongs to S8. The interface between the two is the contract of
  section 3.5 and nothing else.
- Before a slice is merged, its diff is checked against the table. A file outside the slice is
  rejected.

### 6.2 Acceptance criteria

**S0 Words**
- Every key of section 4 exists in `en.json` and `de.json`, with `_one` and `_other` forms where
  the table has them.
- `app-builder-i18n.test.jsx` covers what the existing key test cannot see:
  - every value of the exported key maps exists in both files: `GENERATE_ERROR_KEYS`,
    `CREATE_ERROR_KEYS`, `STEP_KEYS`, `HEADING_KEYS`, `NOTE_KEYS` and the `labelKey` of every entry
    of `EDITOR_GROUPS`;
  - every literal key used in `app-form/`, `AppFormEditor.jsx` and `app-create/` resolves to a
    string, not to an object;
  - no German value under `admin.apps` contains „Nutzer".

  It does not repeat what `translation-keys-exist.test.jsx` already checks (literal keys in en and
  de, German completeness for `admin.*`, the *du* form).
- `translation-keys-baseline.json` has no entry for `AdminAppsPage.jsx`, `AdminAppEditPage.jsx`,
  `AppFormEditor.jsx`, any file in `app-form/`, `AppCreationWizard.jsx` or
  `AppTemplateSelector.jsx`, and no `admin.apps.edit.*` entry for `SkillsSelector.jsx` or
  `WorkflowsSelector.jsx`.
- `npm run test:server` passes the registry test: both new codes have an English and a German
  text.

**S1 Shared core**
- `newAppDefaults('de')` with ID, name and description filled passes `appConfigSchema` (the real
  schema is imported).
- `slugifyAppId`: umlauts, a name without Latin letters, a 60-character name plus suffix, and the
  reserved IDs; the result always matches `APP_ID_PATTERN` and has at most 50 characters.
- Locale table `en`, `en-US`, `de`, `de-DE`: name, description, instructions, placeholder and
  input-field labels land under the same base key.
- Language rule per start (section 5.1): an empty start in a German UI has `name.de` only; a
  template start in a German UI has `de` only in every localized text and no `en`; a copy of an
  en+de app keeps both until `dropOtherLanguages(draft, ['system'])`, after which `system` has
  one language and `name` still has two.
- `primaryLanguageOf`: a German-only app in an English UI gives `de`; an en+de app in a German UI
  gives `de`; an app without a name gives the UI language.
- `appPlaceholders`: `unusedVariables` finds a field that neither text references and ignores
  `{{content}}`; `addVariableToTemplate` appends `<label>: {{name}}`; `removeVariables` drops the
  fields and only the template lines that use them; `placeholderFromLabel` output always matches
  `VARIABLE_NAME_PATTERN` and avoids names already taken.
- Round trip, pure level: for each of the 27 files in `server/defaults/apps`, one app that sets
  every field the form does not show, one app with the three inheritance fields and one app with
  `name.de` only: `cleanAppForSave(padLoadedApp(app))` equals `app`, except for a short list of
  normalisations that the test names line by line. This test is written and green before S7 and
  S8 change the editor.
- `admin-app-cleanup.test.jsx` imports `cleanAppForSave`; no test re-implements product logic.
- No second default object exists under `client/src/features/admin` (a test greps for it).

**S2 Server: draft, templates, audience**
- `_generate` answers 401 for anonymous and 403 for a normal user, a personal API key, an OAuth
  client and an agent.
- `messages`, `model`, `maxTokens` and `responseSchema` in the body are ignored. The stubbed
  `llmClient.complete` was called with the model object picked by the server,
  `options.maxTokens === 4096`, `options.responseFormat === 'json'`, `retries === 0`, a
  `timeoutMs` below 90,000 and a `signal`.
- Closing the request before the answer aborts that `signal`.
- With the stub returning every key of the app schema with hostile values (`type: 'iframe'` with a
  URL, `preferredOutputFormat: 'html'`, `customResponseRenderer`, `upload`, `enabled: true`,
  `toolChoice`, `allowEmptyContent: true` without fields, an ID of `../../x`), the returned `app`
  contains none of them and passes `appConfigSchema`.
- `app` never has `integrations` or `websearch`; both appear only under `suggestions`, limited to
  installations the caller may use and to declared actions.
- A draft whose answer lists an input field that no text references comes back with the field's
  line in the message template, `allowEmptyContent: true` and the warning
  `FIELD_ADDED_TO_TEMPLATE`; `unusedVariables(app)` is empty for every draft.
- The description appears only in the user message. An integration description with newlines, the
  word `INTEGRATIONS:` and the closing delimiter cannot break out of the catalogue.
- Parser table: plain JSON, a fenced block with nested objects (fails with today's regex,
  `AppCreationWizard.jsx:689-695`), prose around JSON, braces inside strings, a cut-off object, an
  array, a number. The same table runs over every file in
  `server/tests/fixtures/app-generator/`; the directory starts with hand-written answers and
  receives the raw answers of the real-model run (7.5) when that run takes place.
- Brief: an unchanged library prompt, a missing one and a disabled one give `brief: "standard"`
  and a system message without "both English and German" and without "gpt-4". A library prompt
  with one changed sentence gives `brief: "customised"` and that sentence in the system message.
  The output rules follow in both cases. The hash of the current shipped file is in
  `SHIPPED_BRIEF_HASHES`. (Replaced on 2026-11-22: drafts always use the server's brief; the
  tests assert that and nothing else.)
- 503 `APP_GENERATOR_NO_MODEL` without a usable model; 502 `APP_GENERATOR_INVALID_ANSWER` for
  prose; 403 `FEATURE_DISABLED` with the feature off; `QUOTA_EXCEEDED` from the client is passed
  on with status 429; every error body is `application/problem+json`.
- Draft limit: with the stub returning prose, the 31st draft of one user within the window
  answers 429 `RATE_LIMITED` with `details.limiter === 'appGenerator'`. The 30 failed drafts
  before it were counted. A second user is not affected.
- A call writes one audit entry with action `execute`, `details.purpose === 'app-generator'` and
  `details.brief`, without description or answer text. The entry passes `auditEntrySchema`. No
  file under `contents/apps/` changes.
- `GET /api/admin/app-templates` returns `{ items, nextCursor }` with six items; the template
  test of section 5.2 is green.
- `POST /api/admin/apps?origin=generated` records the origin in the audit entry;
  `?origin=nonsense` answers 400 `VALIDATION_FAILED`; a POST without the parameter and without
  `enabled` still creates an enabled app; no snapshot is written on create.
- Content access: for a content admin on the shipped `groups.json`,
  `GET /api/admin/content-access/apps/chat` has `audience.allSignedIn === true` although no row
  for `authenticated` is returned. With the wildcard removed from `authenticated` it is `false`.
  For a full admin the `authenticated` row carries `implicit: true`. `scope` and the existing row
  fields are unchanged.
- `POST /api/completions` answers 429 above the admin budget; its body and response are unchanged.
- The OpenAPI blocks of the two new routes and of the changed routes exist;
  `npm run build:api-docs`, `npm run check:response-shapes` and `npm run security:audit` pass.

**S3 Create page and apps list**
- After the first step (6.1) the full unit suite is green and no file imports or mocks the
  deleted modules.
- The button, the empty state, Cmd+K, the setup wizard and a cold load of `/admin/apps/new` show
  the same page. No modal creation flow is left in the code.
- Empty, template, copy (`?from=<id>`) and link starts each end in one `POST` and a navigation to
  `/admin/apps/<id>?created=1`. The body has `enabled: false`, no `parentId`, no
  `inheritanceLevel`, no `overriddenFields`.
- Stored languages follow section 5.1, one test per start: empty in a German UI stores `name.de`
  only, and `name.en` only in `en-US`; a template in a German UI stores `de` only; a copy keeps
  the source's languages, and after the author changed the instructions, `system` has one
  language and the notice `copy.languagesNote` was shown.
- A template start shows `template.note`, not `copy.note`, and no "(copy)" in the name. The
  same-name warning does not appear before the author has left the name field.
- The Start screen shows the description box, the templates and "Start empty"; copy, link app and
  Marketplace appear only after "Other ways to start" is opened.
- Essentials shows one sentence above the button. "More details" is collapsed and shows no ID.
- The ID follows the name until edited; an existing ID shows "already exists" before submit; a 409
  with an untouched ID is retried once; with a touched ID the field gets the focus and all input is
  kept.
- A 400 with `details.issues` marks the named fields; a 403 keeps the input.
- No error is visible before input. The primary button stays enabled; a submit with errors moves
  the focus to the summary. One error reads "1 field needs your attention."
- With no model the notice is visible before any click; with a model it is absent.
- Leaving with typed input asks once; Back from an unchanged draft, template or copy does not
  ask; a reload restores the draft.
- Apps list: "New app" and the empty state navigate to `/admin/apps/new`; "Duplicate" navigates
  with `?from=<id>` for published and unpublished apps. The words "Clone", "Enabled" and
  "Disabled" no longer appear for apps on the page, in either language. Upload and Reorder work
  as before.
- "Publish all": the confirmation lists every app that will change, by name, with the count. The
  request carries exactly those IDs and never `*`. With a search filter the action covers the
  rows shown. The models and prompts pages, which share `bulkToggleConfirm.js`, behave as before.
- `grep -c "purple\|green-700"` is 0 in the new files; every new `.jsx` file with a colour class
  has the matching `dark:` variant; the class-hygiene baseline does not grow.

**S4 Describe start**
- A draft fills Essentials; the author's description is shown in an editable box inside the draft
  notice; input fields are listed and ticked; suggestions are unticked.
- "Prepare a new draft" in the notice sends the edited description. It asks first only when the
  author changed a field of the draft.
- With nothing ticked the POST body has no `integrations` and no `websearch`. Ticking one
  suggestion adds exactly that one.
- Unticking "Input fields" removes the fields and the template lines that use them. When the
  instructions use a field, the checkbox is disabled and `draft.fieldsLocked` is shown.
- ~~`brief: "customised"` shows `draft.briefCustomised`; `standard` shows nothing.~~ Dropped on 2026-11-22 with the prompt.
- Every row of the first table of section 4.4 has a test: the code (and `details.limiter` for the
  two 429 rows) gives its own message. `AUTH_FAILED`, `QUOTA_EXCEEDED` and `CONTENT_POLICY` do not
  say "try again in a moment". The description is kept; a retry clears the old error; "Start
  empty" stays reachable.
- One request at a time; "Cancel" aborts it and shows no error; a late answer is not applied.
- No `console.log` of the answer (a test spies on it).

**S5 Try an unpublished app**
- The matrix of section 5.4 is green; the normal-user rows are identical to the rows for a
  non-existent ID.
- `GET /api/apps` lists the unpublished app for no principal.
- A content admin's scheduled task on an unpublished app stays paused; an unpublished app listed
  under `apps` of a published app is not offered as a tool and a call is refused; the workflow
  chat route treats it as unknown; a body field `resolvedApp` is ignored.
- `RequestBuilder.prepareChatRequest` without `resolvedApp` behaves exactly as today (its existing
  tests are unchanged and green).
- The ratchet baseline lists every remaining raw lookup by ID.
- `npm run test:e2e:authz` is green with the new unpublished-app entries.
- The pull request carries this checklist, ticked by the reviewer: the decision in
  `getAppForRequest` reads only `user.isContentAdmin` and `app.enabled`; no request field, header
  or query parameter reaches it; `resolvedApp` is set in one place; no list function changed.

**S7 Editor frame**
- `/admin/apps/<id>?created=1` opens the test panel, shows toast and next-steps card once, and
  removes the parameter.
- The test panel runs an unpublished app and says that it is not published. When the load of an
  unpublished app answers 404, the panel shows `testNoAccess` with a button that opens "Who can
  use this app".
- Publish dialog, one test per row of the table in section 3.4. In particular: a content admin
  with `audience.allSignedIn` reads "Everyone who signs in can use this app."; a content admin
  never reads "No group can use this app yet"; the word "Authenticated" never appears.
- Publish with a clean form sends one `POST …/_toggle` with `enabled: true` and no `PUT`. Publish
  with unsaved changes sends the `PUT` first and then the toggle; if the `PUT` fails, no toggle is
  sent.
- An app with an invalid field can be unpublished: "Unpublish" sends `_toggle` with
  `enabled: false` and no `PUT`, and unsaved edits stay.
- After a toggle the page is not dirty because of it.
- The rendered page has exactly one control that changes `enabled`.
- The save bar is inside the form's scroll column, appears while dirty, names the error count with
  the right plural form and jumps to the first field through `groups.open`. Ctrl/Cmd+S and the
  leave guard work as before.
- The header shows the name of an app that has `name.de` only, in an English UI too; its ID; its
  status. Breadcrumb labels are translated.
- The next-steps links open their group and move the focus there.
- The page has no `makeDefault` and no create branch.

**S8 Editor form**
- With every group collapsed, a save sends the same body as with every group open (round trip,
  rendered level, for one flow-created app and the every-field app).
- A flow-created app opens with Basics and Instructions and inputs open and every other group
  collapsed with a summary line.
- An app created from the Summarizer template opens the same way. An app with upload on, changed
  user settings and a multi-line input also opens with only those two groups; the three other
  groups are collapsed and marked "changed".
- An invalid field in a collapsed group opens the group, shows a count in header and index, and is
  reachable from the error summary. A URL hash `#access` opens that group.
- Basics shows no App ID input. App type and "Position in the app list" are inside a collapsed
  "More details". Auto-start and Ephemeral chat are in Chat features. The usage guide is in Chat
  features.
- In the two open groups no label, heading, legend, button or placeholder contains Variable,
  Starter Prompt, System Prompt, Prompt Template, App Type or Order, in English, or Variable,
  Starter-Prompt, System-Prompt or Prompt-Vorlage in German. A test renders both groups in both
  languages and checks it. The help text of Instructions contains "system prompt" once.
- One language: a flow-created German app shows no language code and no "No languages
  configured" text; the author can type a hint for the message box and a message template
  without an "add language" step; the saved app has those texts under `de`. A second language can
  be added with "Add a translation", and the list shows language names.
- `DynamicLanguageEditor` without `primaryLanguage` renders as before (a test for one other
  caller's props).
- Input fields: a new field gets its placeholder from its field name until the placeholder is
  edited. A field that no text uses shows `variableUnused`; "Add to message template" appends its
  line, and the notice disappears.
- `skillsTitle` and `workflowsTitle` render as text; no label in `app-form/` renders an object.
- Form to JSON to Form without edits leaves the state deep-equal.
- iframe and redirect apps still open and save; `iframe-app-scheme` and `redirect-app-scheme`
  tests stay green.
- Required labels show one asterisk.

**S9 End to end**
- The spec's cases in section 7.3 pass on chromium with `--retries=0`, with one worker.
- The axe scan of each open state of the new page has zero violations; `/admin/apps/new` is in
  `CLEAN_PAGES` and no longer in `KNOWN_VIOLATIONS`.
- The app editor is scanned with every group expanded, against measured counts that may only
  shrink.
- `tests/e2e/admin-controls-visible.spec.js` passes with the changed entries.
- `npm run test:e2e:subpath` runs the new subpath spec.

**S10 Docs**
- The pull request carries a table with one row per sentence of the release entry and the
  quickstart that states behaviour, and beside it the test or the manual step that shows it.

**S11 App names in one language**
- `ResourceSelector` with an app whose `name` is `{ de: '…' }` renders the name, filters by it and
  does not throw. With `{ en, de }` it shows the name in the UI language.

**Whole increment ("works end to end")**

1. Fresh contents with the stub model, English and German: an author creates an app from three
   fields, lands in the editor, gets an answer in the test chat, changes one field and saves. The
   stored file differs from the first POST only in that field. A normal user does not see the app
   until it is published and sees it afterwards.
2. The same as a content admin who is not a full admin.
3. Fresh contents without a model: creation works, the page says a model is missing before the
   author meets a dead send button.
4. The same walk under `/ihub/` with a cold load of `/ihub/admin/apps/new` and of the editor URL.
5. Keyboard only, and at 390 px, in German, in light and dark.
6. The target of the PM report holds: a test answer at most five clicks after "New app".
7. After a German app exists, the page of a group with an explicit app list
   (`/admin/groups/anonymous`) and the OAuth client page open without an error.

### 6.3 The gate for S5, and the fallback

D5 (start not published) is only honest if D6 (test an unpublished app) works. S5 therefore has a
hard gate: its matrix is green, `npm run test:e2e:authz` is green, and the checklist of its
acceptance criteria is ticked without an open point. If the gate is not met
when S7 is ready, the lead flips `UI_CREATES_PUBLISHED` to `true` in `shared/appDefaults.js`. Then:

- new apps are created published, as today;
- the Essentials screen shows `essentials.audienceLive` instead of `essentials.audience`;
- the test panel keeps today's message for disabled apps, and "Unpublish" stays available;
- the release entry drops the sentence about starting unpublished;
- the S5 branch is not merged, and "test an unpublished app" moves to Next.

Nothing else depends on S5.

### 6.4 Cut lines

If time runs out, these are cut in this order, and each cut is recorded under Next: the
`.github` workflow (S9), the marketplace link (S3), the session-storage draft (S3), the link
variant of Essentials (S3; link apps are then created by Upload only), "Publish shown" for a
filtered list (S3; the explicit IDs stay), the placeholder derived from the field name (S8; the
"not used yet" notice stays), the German translation of `app-form/` files outside the relabelled
sections (S0). Not cuttable: S1, S2, S3, S4, S11, the group wrapper and save bar of S7 and S8,
the `audience` field and the publish dialog built on it, the one-language mode of the language
component, and the German of everything in section 4.

### 6.5 Findings this increment closes

For the ticket update on #3741 after the implementation.

| Finding | Closed by |
|---|---|
| AI-PM3 two creation implementations; AI-B16 new editor opens with errors | S3, S7 (one page; the editor has no "new" mode) |
| AI-B5 dead and missing wizard controls, lands on the list | S3, S7 |
| AI-B1 remnant: input-field labels stored under `en` | S1 |
| AI-B19 lineage fields and raw placeholders on clone | S1, S3 |
| AI-B14 untranslated app pages | S0 |
| AI-B24 hard-coded English breadcrumbs (editor) | S7 |
| AI-PM2 no draft: the first step (create not published, test it) | S3, S5, S7 |
| AI-UX3, AI-UI4 to AI-UI6: one long page, save at the bottom, Enabled inside the form | S7, S8 |
| AI-UX8 icon as free text | S3 |
| AI-ADMIN2/4/5/6: ID from the name, land on the new item, "(copy)" | S1, S3 |
| AI-B8 generator prompt can be deleted | S2 (the server's brief is the default). Closed on 2026-11-22: the prompt is removed, a migration deletes stored copies (Q5). |
| AI-B2 remnant: the bulk toggle sends `*` | S3 (explicit IDs, every name listed) |
| W2: placeholder detection, the half "a field that no text uses" | S1, S2, S8 |
| Still open | AI-B9 (model list of the creator, Q7), AI-B12 (used-by on delete), AI-PM1 and decision 1 (audience), AI-PM4, AI-PM5 |

## 7. Test plan

### 7.1 Where the tests live

- **Jest, client (`tests/unit/client/`, run by `npm run test:quick`):** the pure modules of S1, the
  create page (React Testing Library, real components, only the API module mocked), the describe
  start, the editor round trip at both levels, the group wrapper, publish, and the i18n key test.
  The existing ratchets must hold or shrink: translation keys, admin class hygiene, unsaved-guard
  coverage, load-gate coverage, native dialogs, known-routes sync.
- **Server tests (`server/tests/`, run by `npm run test:server`):** the `_generate` route with a
  stubbed `llmClient.complete`, the sanitiser and parser tables, the templates service, the
  unpublished-app matrix, the brief selection, the `audience` field of the content-access view,
  the draft limiter, the extended create tests. A new error code needs its en and de text
  (`server/tests/errorMiddleware.test.js:365-371`); a changed response needs its entry in
  `tests/contract/response-shapes.json`.
- **The cross-user authorization suite (`tests/security/authz/`, run by `npm run test:e2e:authz`
  and by CI):** API requests against its own server with a stub model. It gets an unpublished app
  and one entry per converted route.
- **Playwright:** one spec, `tests/e2e/app-builder.spec.js`, on its own config with its own
  contents directory, ports and one worker, modelled on
  `tests/config/playwright.admin-safety.config.js`. It needs its own server because two cases
  change shared state (one disables the stub model, one removes a group permission), and because
  the default config reuses a running dev server that has no stub model. A second short spec runs
  in the subpath suite.

### 7.2 Additions to the LLM stub

`tests/config/e2e-llm-stub.mjs` answers by a marker in the last user message, as it already does
for `e2e-fail`. No product code is written for tests.

| Marker in the description | Stub answer | Case |
|---|---|---|
| `e2e-app-json` | a valid app object with one dropdown input field, web search and one integration proposed | happy path |
| `e2e-app-fenced` | the same inside a fenced block with prose around it | parser fallback |
| `e2e-app-unused` | a valid app with an input field that neither text references | the server adds the field to the message template |
| `e2e-app-invalid` | JSON without a name and with `type: "iframe"` | unusable answer |
| none | `E2E reply to: …` (exists) | not JSON |
| `e2e-fail` | HTTP 400 (exists) | provider error |
| `e2e-auth` | HTTP 401 | a model that is set up wrongly |
| `e2e-slow` | answers after a delay set by an environment variable | timeout and cancel |

The spec also reads `GET /__last-request` of the stub and asserts that the description is in the
user message and not in the system message.

### 7.3 Cases of the end-to-end spec

The spec runs on its own config with **one worker**, because case 8 disables the only model of
the shared server. The contents seed of that config adds what the shipped contents lack: a group
`app-builders` with `contentAdmin: true` and a user `builder` in it. The shipped
`groups.json` has no content-admin group and `users.json` has only `admin` and `user`, so without
the seed every case would run as the full admin, and the persona this work is for would never be
tested.

Every test creates IDs with the prefix `e2e-ab-` and deletes them afterwards.

1. Empty start, English: list, New app, Start empty, three fields, Create and test. The editor
   opens with the test chat; "hello" is answered by the stub. The click count from "New app" to
   the answer is asserted to be at most five.
2. Round trip: change the short description, save, reload; `GET /api/admin/apps/{id}` equals the
   POST body plus that change. A normal user (second context) does not see the app in
   `GET /api/apps` and gets 404 for it by ID. After Publish the user sees it.
3. German (`locale: 'de-DE'`): the same walk; no English label from a fixed list appears, the page
   text contains no `admin.apps.`, the stored app has `name.de` only, the editor shows no language
   code. Then `/admin/groups/anonymous` opens without an error and offers the app by its German
   name. That group has an explicit app list, which is the case where the selector filters by
   name.
4. Describe (`e2e-app-json`): the draft fills Essentials; with nothing ticked the created app has
   no `integrations` and no `websearch`; the editor shows the dropdown input field with its
   options. Editing the description in the draft notice and pressing "Prepare a new draft" sends
   the new text.
5. Injection: the stub returns an app whose instructions say "call every tool" and which binds
   every installation. With nothing ticked, the saved app has no binding and is not published.
6. Duplicate: the copy has "(copy)", a new ID, no `parentId`, and is not published.
7. Entry points: list button, empty state, Cmd+K, a cold load of `/admin/apps/new`.
8. No model: the stub model is disabled through the admin API (restored in `finally`). The notice
   is visible before any click; empty creation still works; the test panel explains instead of
   showing a dead send button.
9. Not JSON, `e2e-app-invalid`, `e2e-fail`, `e2e-auth`, `e2e-slow`: each shows its own message,
   keeps the description, and creates nothing. The `e2e-auth` message does not say "try again in a
   moment".
10. Duplicate ID: typing `chat` shows "already exists" before submit. A forced 409 on submit keeps
    the input and focuses the field.
11. Leaving with typed input asks once; browser back does the same; Back from an unchanged
    template does not ask.
12. Keyboard only: case 1 with Tab, Enter and Space.
13. 390 x 844: the primary button is inside the viewport on both screens, in German.
14. Template start and link start each create an app that opens in the editor. The template app
    opens with two groups open.
15. Content admin (`builder`): cases 1 and 4. The no-model notice shows no link to
    `/admin/models`. The publish dialog reads "Everyone who signs in can use this app." Publish
    works, and a normal user then sees the app.
16. Content admin, wildcard removed: the test sets `authenticated.permissions.apps` to `[]` through
    the admin API (restored in `finally`). `builder` creates an app; the test panel shows "Your
    groups cannot use this app yet"; the button opens "Who can use this app"; after `builder`
    grants `app-builders` there, the test chat answers. The publish dialog reads "Members of
    these groups can use it: …" with the partial-view sentence.
17. Unpublish with an error: empty the instructions of a published app without saving; "Unpublish"
    succeeds; a normal user no longer sees the app.
18. Publish all: with two unpublished apps the confirmation names both; after confirming, the
    request path holds their two IDs and no `*`.
19. `e2e-app-unused`: the created app's message template contains the field's placeholder.

**Subpath.** `tests/e2e/app-builder-subpath.spec.js` is a second, short spec, added to the fixed
`testMatch` of `tests/config/playwright.subpath.config.js:23`. It loads `/ihub/admin/apps/new`
and, after an empty creation, the editor URL, both cold. It asserts no chat answer, because the
subpath server has no stub model. The subpath suite runs against the production build, so the
client is built first (7.4).

**Existing specs that depend on today's page.**

- `tests/e2e/admin-controls-visible.spec.js:50` expects at least five form fields on
  `/admin/apps/new`. The Start screen has one. The entry becomes
  `{ path: '/admin/apps/new', minFields: 1 }`, and a second entry
  `{ path: '/admin/apps/new?from=chat', minFields: 3 }` measures the Essentials screen.
- `tests/e2e/accessibility.spec.js:326` is the only scan of the app editor form today, with 27
  known label violations (`label: 19`, `select-name: 8`). Collapsed groups are hidden from axe,
  so after this change a plain load of the editor would scan almost nothing, and the known
  violations would leave the ratchet without being fixed. S9 therefore moves `/admin/apps/new`
  to `CLEAN_PAGES` and adds a test of its own for the editor, in the style of the workspace-pane
  tests of that file: open `/admin/apps/chat`, press "Expand all", scan, and compare with
  measured counts that may only shrink.

### 7.4 Commands

Setup, once:

```bash
cd /workspace/ihub-apps
npm run install:all
npx --no-install playwright install --with-deps chromium
node -v        # the repo requires Node 24 (package.json engines); the sandbox has 22.23.5
```

While implementing:

```bash
npx jest --config tests/config/jest.config.js tests/unit/client/app-builder
npx jest --config tests/config/jest.config.js tests/unit/client/app-editor
npx jest --config tests/config/jest.config.js tests/unit/client/translation-keys-exist.test.jsx
node scripts/run-server-tests.js app-gener
node scripts/run-server-tests.js app-templates
node scripts/run-server-tests.js app-unpublished
node scripts/run-server-tests.js content-access
node scripts/run-server-tests.js admin-apps
node scripts/run-server-tests.js errorMiddleware
```

Merge gate, in this order:

```bash
npm run lint:fix && npm run format:fix
npm run test:quick
npm run test:integration:ci
npm run test:boot
timeout 10s node server/server.js || echo "Server startup check completed"
npm run build:api-docs
node scripts/check-response-shapes.js --update   # once, after the route changes; commit the snapshot
npm run check:response-shapes
git diff origin/main | node scripts/check-api-guidelines.js
npm run security:audit
npm run test:e2e:authz
npm run test:e2e:app-builder -- --project=chromium --retries=0
npm run test:a11y -- --project=chromium
npm run test:e2e:crawl -- --project=chromium --retries=0
npx playwright test --config tests/config/playwright.config.js tests/e2e/admin-unsaved-guards.spec.js tests/e2e/admin-controls-visible.spec.js tests/e2e/admin-load-gating.spec.js tests/e2e/admin-confirmations.spec.js --project=chromium
(cd client && npm run build) && npm run test:e2e:subpath
node scripts/check-a11y-diff.js origin/main
reuse lint
```

Notes:

- `npm run test:e2e:app-builder` is the script S9 adds:
  `playwright test --config tests/config/playwright.app-builder.config.js`.
- `npm run build:api-docs` fails on a malformed OpenAPI block; `npm run check:response-shapes`
  compares the responses with `tests/contract/response-shapes.json`
  (`.github/workflows/response-shapes.yml:54`); `npm run security:audit` checks that every admin
  route has a guard; `npm run test:e2e:authz` is the cross-user suite that CI runs
  (`.github/workflows/security.yml:164`). The first plan's gate had none of the four.
- A dev server from the walkthrough may still run on ports 5173 and 3000 with a `contents/`
  directory that has no model. The default Playwright config would reuse it. Stop it before the
  runs that use the default config.
- On Node 22 the server tests need `ALLOW_UNSUPPORTED_NODE=1`, and some suites cannot load. Such a
  run is reported as "not on the supported Node version".
- `reuse` is not installed in the sandbox; CI runs it. Every new source file gets the two SPDX
  lines. The template files are JSON and are covered by the `**` rule of `REUSE.toml`.
- `scripts/check-a11y-diff.js` treats `jsx-a11y` warnings on changed lines as errors. The files
  that are rewritten will surface old warnings; plan time for them.
- Every test report names the Node version, the browser build, the contents directory and the
  suites that were skipped.

### 7.5 Manual checks

- The walk of section 6.2 ("works end to end") at `/` and `/ihub/`, in German and English, light
  and dark, at 1440 and 390 px. Screenshots go into the pull request.
- One keyboard-only walk and one screen-reader pass of the two creation screens and the editor.
- **The quality of a draft from a real model cannot be checked in the sandbox.** No model key
  exists there, and no panelist saw a successful generation. The check is defined here and
  decides whether the AI path counts as done (D33):
  - Someone with a key runs the ten descriptions in `tests/manual/app-builder-descriptions.md`
    (five English, five German, each two or three sentences) against one real model, and if
    possible against a second, small local one.
  - A draft is "usable" when the author could press "Create and test" without editing the
    instructions, and the test chat then does what the description asked.
  - The bar is eight usable drafts of ten on the first model.
  - The raw answers are stored under `server/tests/fixtures/app-generator/`, and the parser table
    of S2 runs over them from then on.
  - If the run did not take place before the merge, or the bar is missed, the release entry says
    so in one sentence ("The quality of AI drafts was not yet measured with real models"), the
    feature ships switched on, and a ticket under #3741 keeps the run open. It ships on because
    the path it replaces is worse: it reports a missing model as "Network error" and applies
    bindings without asking.

## 8. Docs plan

- **New `docs/app-quickstart.md`, "Build your first app".** No JSON on the page. Outline: what an
  app is; what you need (the admin or content-admin role, one working model); create the app by
  describing it; test it; improve the instructions with three before/after examples; add one
  dropdown input field and use its placeholder; add two conversation starters; check who can use
  the app and publish; duplicate an app; what the error messages of section 4.4 mean; a glossary
  that maps each UI term to its JSON field. It also says plainly what else the content-admin role
  allows, that test chats are ordinary chats of the admin, that drafts and test chats count
  against the author's own usage limit, that credentials belong in an integration's connection
  and never in an app's instructions, and that answering from a document uploaded once is not
  part of this flow yet. The glossary also maps "Connected systems" to the admin page
  "Integrations".
- **`docs/SUMMARY.md`:** `- [Build your first app](app-quickstart.md)` above `- [Apps](apps.md)`
  (line 21).
- **`docs/admin-ui.md:159-209` "Managing Apps":** the new flow; Upload is its own button; the
  Marketplace is an admin feature; the new labels with the JSON name in parentheses; "Published /
  Not published"; "cloned app" (`:206`) becomes "a copy (Duplicate in the app list)"; a short
  "What the AI draft can and cannot set"; new screenshots of Start, Essentials and the editor with
  the test chat.
- **`docs/apps.md`:** the Quick Start (`:32-50`) points to the quickstart and keeps the JSON
  example under "Creating an app as a file"; the ID rule (`:447`) says lower case and 50
  characters; `system` (`:453-459`) is "recommended; the admin UI asks for it"; the inheritance
  fields (`:577-580`) are described as stored but not applied; anchors `#input-fields` and
  `#conversation-starters`, each opening with the UI name and the JSON name; the troubleshooting
  section drops the wizard.
- **Other pages:** `README.md:171` and `:431`, `docs/ihub-faq-en.md:94` and `:186`,
  `docs/developer-onboarding.md:486`, `docs/GETTING_STARTED.md` (the setup wizard now ends on the
  new page).
- **API docs:** the OpenAPI blocks live in the route files, which only S2 may edit. They are
  therefore part of S2's acceptance, not of the docs slice: the two new routes, the `origin`
  parameter, the `audience` field, and `system` no longer listed as required in the block for
  `POST /api/admin/apps` (`apps.js:59-65`).
- **`docs/admin-ui.md`, prompt library:** one sentence that the entry "App Generator" steers
  drafts only after an admin changed it.
- **Release notes (`docs/releases/next/`, written with the `document-feature` skill):**
  - `features.md`, one entry, "Apps: create an app on one page and test it before anyone sees
    it". It states the changes an admin will notice: the wizard and the template window are gone;
    apps created in the UI start not published, while an API `POST` without `enabled` still
    creates a published app; the AI draft no longer switches on web search or connected systems by
    itself; "Clone" is "Duplicate" and no longer records a parent; "Save & Exit" is gone; the new
    names, with the note that JSON field names are unchanged; the feature switch `appGenerator`;
    that only admins and content admins can build apps. It also states: "Publish all" now
    publishes apps that were switched off on purpose and unfinished apps alike, so its
    confirmation lists every app; the App ID is no longer an input in the editor; an unchanged
    "App Generator" prompt in the library no longer steers drafts; drafts are limited to 30 per
    person per hour and count against the person's usage limit; a copy loses the other languages
    of a text the author rewrites while creating it. If the real-model run of 7.5 did not take
    place, the entry says that draft quality was not yet measured.
  - `fixes.md`: `POST /api/completions` is now covered by the admin rate limit. A second entry,
    if the `document-feature` skill agrees that it is a fix to shipped behaviour: the group page
    no longer fails for an app without an English name.
  - `breaking-changes.md`: no entry.
- The quickstart's steps are the steps of case 1 and case 4 of the end-to-end spec, and the spec
  is named in a comment in the page's source, so a change to the flow fails a test before the
  guide goes stale.

## 9. Risks and mitigations (merged pre-mortems)

Each mitigation is part of a slice.

| Risk | Raised by | Mitigation | Slice |
|---|---|---|---|
| The short flow ends in the old ten-screen editor, and the flow is blamed. | PM, UX, UI | The editor frame ships in the same increment; acceptance is "a test answer in five clicks", not "app created". | S7, S8 |
| The app is created not published but cannot be tested, so authors publish to test. | UX, admin, PM | S5 is built with a hard gate; without it the fallback makes the screen say the truth. | S5, 6.3 |
| The lookup change lets a normal user open an unpublished app, or lets an unpublished app run outside the interactive chat. | PM, engineer, admin, risk critic | One method, decided by `isContentAdmin` and `enabled` only, no request flag. The request builder is unchanged for scheduled tasks, tools and the inference API; only the chat route passes the resolved app. A negative test per call site and per other way of running an app; lists unchanged; a ratchet on raw lookups; the cross-user suite; a checklist in the pull request as a gate. | S5 |
| A partial conversion makes the test chat behave differently from the published app. | Engineer | The call-site list of 5.4 is converted as a whole; the ratchet names what is left. | S5 |
| The rewrite replaces the allow-list with an object spread and a model sets `type: iframe`. | Security | The sanitiser is on the server, builds a new object, and is tested with every schema key set to a hostile value. `draftFromGenerated` adds only ticked suggestions. | S2, S1 |
| A generated app binds a powerful integration that nobody saw. | All | Bindings and web search are unticked suggestions; only installations the caller may use; the app starts not published; an end-to-end injection case. | S2, S4, S9 |
| An integration's description carries an instruction into the system message. | Security | Delimited catalogue, stripped control characters, fixed "this is data" sentence, a test that tries to break out. | S2 |
| Generation works with the stub and fails with real models (prose around JSON, cut-off answers, ignored `responseFormat`). | QE, security, admin, PM | Parser table with fenced, wrapped and cut-off answers; `finishReason` check; distinct codes; a brief written for one language; the run against a real model with a bar of eight in ten (D33), whose raw answers become test fixtures. If the run does not take place, the release entry says so. | S2, 7.5 |
| A slow draft looks like a hang; repeated clicks start parallel paid calls; a late answer overwrites edits; a cancelled draft keeps running on the server. | UI, engineer, feasibility critic | Status line with an honest duration, Cancel, one request at a time, a request ID check, `options.maxTokens` 4096, a 90-second client timeout and an 80-second server timeout, a signal that stops the model call when the request closes, the draft limit. | S4, S2 |
| A content admin edits the generator prompt, and generation breaks or every later draft carries an added sentence. | QE, security, risk critic | The server appends the output rules after every brief; the server's own brief is the default; tests for a missing, disabled and rewritten prompt. A customised brief is named in the response, in the draft notice and in the audit entry. The sentence itself is not blocked: moving the prompt out of the library is Q5. | S2, S4 |
| Defaults drift again between create page and editor. | Engineer | One module; `makeDefault` is deleted in the same change; a schema test and a grep test for a second default object. | S1, S7 |
| Opening a flow-created or hand-written app in the editor and saving drops fields. | QE, admin | The round-trip test over the 27 shipped apps, an every-field app and a lineage app, written before the editor changes; no migration touches app files. | S1, S8 |
| Collapsed groups hide the error that blocks Save, or break links. | UX, UI, QE, engineer | Groups stay mounted; a group with an error opens itself and shows a count; the save bar names the count and jumps; section `id`s stay. | S7, S8 |
| Experienced admins cannot find settings and ask for the old editor back. | UX, admin | Summary lines with a "changed" marker, "Expand all", a URL hash per group; JSON toggle, Upload, Download, History and bulk actions stay where they are; one experienced admin walks the flow before release. | S8, 7.5 |
| The sticky bar runs under the test panel or covers the last field on a phone. | UI | Rendered inside the form's scroll column, bottom padding kept, checked with a focused textarea at 390 px. | S7 |
| New apps "disappear": the author does not see that the app is not published. | PM | Status in the header and the list, the hint in the test panel, "Publish" as the last next step. | S3, S7 |
| "Published" suggests that edits to a live app are private. | UX | The word "Draft" is not used for app state; the save bar of a published app says users get the change on save. | S7 |
| The copy states something the build does not do. | Writer | Both audience strings exist; the pull request carries a table that ties each behavioural sentence to a test or a manual step; the release entry is written last. | S0, S10 |
| German is half English again. | PM, UX, writer, admin, knowledge expert | No fallback text in new files; a key test; the app list, editor page and all `app-form/` files leave the baseline; a German walk before review. | S0 |
| German strings break the layout at 390 px. | UI | German is the design case; wrapping button rows; German screenshots at 390 px in the pull request. | S3, S7 |
| The new flow is white in dark mode. | UI | New files under `features/admin`, `formStyles.js` only, light and dark screenshots. | S3 |
| The new words cannot be found in docs or by support. | Writer | The technical term once in each help text; a glossary with the JSON names; the release entry lists the renames. | S0, S10 |
| The ID helper yields collisions, empty IDs or over-long IDs. | Engineer | One shared helper with the edge cases as tests; one retry on 409; the server stays the authority. | S1, S3 |
| Deleting the wizard breaks the build, the baseline and unrelated tests. | Engineer, feasibility critic | The first step of S3 deletes the components together with their only importer's imports, the `jest.mock` blocks in three tests and their baseline blocks, and runs the full unit suite. | S3 |
| Parallel engineers overwrite each other in the editor page and the i18n files, or build two halves that do not fit. | Engineer, feasibility critic | The ownership table is binding; one owner for the i18n files; diffs are checked against the table. The page and the form share one contract (section 3.5), published before both slices start, and land in one merge. | 6.1, 3.5 |
| The end-to-end spec is green at merge and rots because no pipeline runs it. | QE | A workflow for this spec; most logic in Jest. | S9 |
| "All tests pass" is reported from a partial run on the wrong Node. | QE | The reporting rule in 7.4. | all |
| The flow breaks under `/ihub/`. | Admin | No new top-level route; router navigation and the API helper only; a subpath case with cold loads. | S3, S9 |
| The owner demos it to a user without admin rights, who never sees the button. | PM, UX, knowledge expert | Q1 goes to the owner now; the release entry and the quickstart say who can build and how to grant the role. | S10 |
| Scope grows until nothing ships. | PM | The slice list is closed; the cut lines are written down; everything else is a ticket under #3741. | 6.4, 12 |
| Copies named "(copy)" pile up and get published by accident. | UX | A copy starts not published; the name field has the focus with the text selected; a warning for an existing name. | S3 |
| An author pastes a key into the instructions. | Security | One sentence in the quickstart now; the detector is Next. | S10 |
| Nobody can say whether more apps get built. | PM | The click count is asserted in the spec; the audit log records create with its origin; counters are Q17. | S9, S2 |
| The publish dialog tells a content admin a wrong audience: it lists only the author's groups while every signed-in user gets the app. | Risk critic, non-technical critic | The server computes `audience` over all groups; the dialog leads with "Everyone who signs in"; "No group can use this app" is never shown for a partial view; a server test with a content admin on the shipped `groups.json`; one Jest test per row of the text table; end-to-end case 15. | S2, S7, S9 |
| On an installation without the wildcard, the author cannot test the own app and reads "could not be loaded". | Risk critic, non-technical critic | The test panel names the cause and opens "Who can use this app"; the screens say "you and others who manage apps", not "administrators"; end-to-end case 16 with a seeded content admin. | S7, S9 |
| Failed drafts are paid model calls that no limiter counts. | Risk critic, feasibility critic | A limiter of its own for the draft route: 30 per user per hour, failures counted, shared across workers; a test that fails 30 drafts and expects 429. A draft also counts against the caller's usage limit. | S2 |
| An app with a German name only crashes the group page and shows its ID in the editor header. | Risk critic | `ResourceSelector` and the header resolve names by language; a Jest test; end-to-end case 3 opens a group page. | S11, S7, S9 |
| "Publish all" publishes every unfinished app and every app an admin switched off on purpose. | Risk critic, admin | The confirmation lists every app by name; the request carries those IDs only; the release entry explains the changed meaning. | S3, S10 |
| An app with a form error cannot be unpublished. | Risk critic, admin | Unpublish calls `_toggle` and never saves the form; a Jest test and end-to-end case 17. | S7 |
| A second tab with a stale state saves the old `enabled` value and publishes or unpublishes the app again. | Risk critic | Not mitigated in this increment. It is today's "last save wins"; optional `If-Match` is Q12. Recorded in section 3.4. | none |
| A template or a copy keeps text in a language the author never saw, and users of that language get the old text. | Risk critic, non-technical critic | Templates keep the content language only; a copy drops the other languages of a text the author rewrites and says so; template files may hold only content keys, checked by a test. | S1, S2, S3 |
| The AI ignores an input field, because no text contains its placeholder. | Non-technical critic | The server adds the field to the message template of a draft; the editor marks an unused field and offers a button; the checkbox on Essentials is locked when the instructions use the fields. | S1, S2, S4, S8 |
| A one-language app shows language codes and "No languages configured" in the editor. | Non-technical critic | An opt-in prop of the language component, used by the app form; a test that a caller without the prop renders as before. | S8 |
| The change to the language component breaks one of its 35 callers. | Lead | The new behaviour is behind the prop. Without it only one label and the names in the language list change. | S8 |
| A template app or a copy opens four long groups, and the long page is back. | Non-technical critic | Groups do not open because their values differ; they show a "changed" marker. An acceptance case with a template app. | S8 |
| The existing merge-gate specs fail on the new page, and the editor form leaves the axe scan. | Feasibility critic | S9 owns `admin-controls-visible.spec.js`, the subpath config and the axe spec; the editor is scanned with every group expanded. | S9 |
| The new audit entries fail validation, or the new error codes have no text. | Feasibility critic | The existing action `execute`; the two registry texts are rows of section 4.4 and S2 waits for S0 pass 1. | S2, S0 |

## 10. Open questions

### 10.1 For the owner

None of these is built in this increment unless the row says so. Each row gives the answer the
plan assumes and what a wrong assumption costs.

| # | Question | Assumed | Cost if wrong |
|---|---|---|---|
| Q1 | May a user without admin rights build an app ("My assistants": private, shared with the own team, "everyone" on request)? And is the content-admin role meant for people like the knowledge expert, although it shows every app with a delete button? | **Answered by the owner on 2026-11-20:** "we definitely have to plan an chat-based app builder too. regarding the question if users should be able to do it. yes let's just do this as well. similar to projects, where you can have projects managed by the admins. a user can create an own app. a user can share an app. a user can publish an app (it comes an admin managed app). the owner can be transfered." Increment 2 implements the answer: [02-personal-apps.md](02-personal-apps.md). **The owner added on the same day:** "An admin should be able to configure if user based apps are allowed. Similar to projects. Same principal. We will make this a common scheme later for skills/prompts as well". Section 3.1 of that document compares the admin configuration with projects, and section 3.2 names the common scheme; publishing is direct, as in projects (its section 8.2). The chat-based builder is planned in [03-chat-based-app-builder.md](03-chat-based-app-builder.md). For this increment the assumption stays: No change. Builders are admins and content admins. | The complaint is half answered for people who cannot get the role. Personal apps need an owner field, a personal scope, a capability ceiling checked on every run, a promote step and quotas; that is a project of its own. The creation components take their data from `adminApi.js` only and can be mounted elsewhere. |
| Q2 | May apps created in the UI start not published, and may content admins open and test an unpublished app in the interactive chat? | Yes. Built (D5, D6). It changes no permission list and no API default. | Flip `UI_CREATES_PUBLISHED`, do not merge S5; half a day. |
| Q3 | `POST /api/completions`: cap `maxTokens` and allow only models the caller may use? Is the admin rate limit on it acceptable? | The limit is added now (D24). Cap and model check wait. | If the limit is unwanted: remove one line. While cap and check wait, a content admin can run the most expensive configured model through this endpoint, up to the admin budget. That budget does not count failed requests. |
| Q4 | Is "Instructions" / „Anweisungen" acceptable where the Review recommended "System prompt" (open decision 11)? | Yes, with "system prompt" once in the help text. | Four strings and the docs glossary. |
| Q5 | May the App Generator prompt leave the user prompt library (a server default, hidden from `GET /api/prompts`), with customised copies kept but disabled? | Not now. A customised library copy still wins and is marked as such in the draft notice and the audit log. | Users keep seeing "App Generator" in their prompt list, and any content admin can still add a sentence to every later draft (AI-B8). Doing it later needs a migration and a release note. **Update 2026-11-22:** the owner decided to remove the App Generator prompt completely (section "The App Generator prompt is removed"). Migration V261 deletes `contents/prompts/app-generator.json`, shipped or customised; a breaking-changes entry says so. |
| Q6 | May `POST /api/admin/apps` refuse the IDs `new`, `templates`, `integration-status` and IDs that start with `_`? | No. Only the client refuses them. | A script can still create an app that the admin UI cannot open. The check is a narrow breaking change. |
| Q7 | May content admins see every configured model (name, provider, status), including models their groups cannot use? | No. Pickers show what the creator may use. | AI-B9 stays: an app can name a model its audience cannot use, and nothing warns. |
| Q8 | Should an admin be able to name the model that drafts apps? | No setting. The standard model the caller may use drafts. | Where the standard model is a small local one, many drafts end in "cannot be used". A setting is additive later; the manual run of 7.5 shows how urgent it is. |
| Q9 | May app files carry `createdBy`, `createdAt`, `updatedBy`, `updatedAt` (privacy, works council), with list columns and a "Mine" filter? | No stored fields. The audit entry of create carries the origin. | With many builders the list cannot be filtered or cleaned up by creator. Adding the fields later is additive; apps created until then show no creator. |
| Q10 | May the schema refuse unknown iframe sandbox tokens and over-long fields? | No. Tight caps apply to generated drafts only. | Hand-written configs stay unbounded. A hard refusal can block saving an old app. |
| Q11 | Remove or deprecate `POST /api/completions` and `GET /api/admin/prompts/app-generator`, which lose their only client caller? | They stay registered and unchanged. | Unused API surface, one of them a general LLM proxy. Removal needs `Deprecation` and `Sunset` headers. **Update 2026-11-22:** the owner removed `GET /api/admin/prompts/app-generator` together with the prompt, without a shim; `POST /api/completions` stays. |
| Q12 | Optional `If-Match` on `PUT /api/admin/apps/{id}` now? | Next. | With several editors the last save wins, as today. |
| Q13 | Remove the inheritance fields from schema and docs? | Kept; the docs say "stored, not applied"; new copies do not write them. | None now. Removal is a migration and a breaking change. |
| Q14 | Rename "Starter prompts" in the end-user chat to "Conversation starters" as well? | Admin side only. | Two names for one thing across the two surfaces until it is decided. |
| Q15 | Should "Copy an existing app" also list unpublished apps? | No: enabled apps, as decided on 2026-11-17. The row action covers the rest. | An author looks for an archived app in the picker and has to use the list. |
| Q16 | May a workflow run the app-builder spec on pull requests? | Yes; the file is part of the pull request and needs a maintainer's approval there. | Without it the spec runs only when a developer runs it. |
| Q17 | May usage counters (created, tested, published) be collected at customer installations? | No. Click counts in the spec, the audit log, and five moderated sessions before release. | Nobody can say later whether more apps were built. |
| Q18 | May the server use its own brief for drafts whenever the library prompt "App Generator" is unchanged, although the library still shows the old text? | Yes (D10). The shipped text asks for two languages and names a model, which contradicts the output rules. | An admin reads the library entry and believes it steers drafts. If unwanted: the server uses the library text again; one function. The clean end state (replace the library file) needs a migration. **Update 2026-11-22:** the owner decided to remove the App Generator prompt completely (section "The App Generator prompt is removed"). |
| Q19 | Are six templates written for the gallery acceptable, instead of the shipped default apps as they are? Who maintains them? | Yes (D12); the team that maintains `server/defaults/apps`. | Two sets of similar texts to keep up to date. If the owner prefers the shipped apps: a projection over them and a different list of six, with the language and binding problems of section 5.2 to solve. |
| Q20 | May a content admin learn that every signed-in user can use an app (`audience.allSignedIn`), although the group that grants it is not shown to them? | Yes. Without it the publish dialog cannot name the audience. | The dialog for content admins falls back to "Other people may be able to use it; ask an administrator", and principle 6 does not hold for them. |
| Q21 | Is a fixed limit of 30 drafts per person per hour acceptable, without a setting? | Yes; the value is a code default. | A workshop where one account drafts for a group hits it. A setting in `platform.json` is additive later. |
| Q22 | May the editor stop offering the App ID as an input? | Yes. The Essentials screen says the ID cannot be changed after creation. | One input back. What a save with a changed ID does today was not checked. |

### 10.2 Other questions nobody asked, with the assumption used

| Question | Assumed | Cost if wrong |
|---|---|---|
| Is "done" the creation flow only, or the editor too? | Both. | If only the flow: S7 and S8 could have shipped later. |
| Is the description box the main way to build, or one option among equals? | Main, when a model exists. | An ordering change on one screen. |
| May the draft suggest every connected system the creator may use, including ones with service-account access? | Yes, as an unticked suggestion. | An installation flag "never suggest" would be needed. |
| Is it acceptable to send the description to the standard model, and to show the model's name? | Yes; the screen says so before the click. | Hide the name, or Q8. |
| Do drafts and test chats count against a usage quota or budget? | Yes, verified: a model call with `telemetry.user` is checked against that user's usage limit (`LLMClient.js:722-725`), and a refusal is `QUOTA_EXCEEDED`. The quickstart and the release entry say so. | An author who drafts a lot reaches the limit earlier; the error text says what to do. |
| Are test chats of unpublished apps stored and counted like other chats? | Yes, as today; the quickstart says so. | A separate "test" marker would be needed. |
| How long may a draft take? | Up to 80 seconds on the server and 90 on the client, with a status line and Cancel. The default client timeout is 30 seconds (`client/src/api/client.js:11`), so this call sets its own. | Slow local models still time out; streaming would be the next step. |
| Should the description box ask follow-up questions? | No. One shot, with examples that show the level of detail. The author can adjust the description beside the draft and draft again. | Thin descriptions give generic drafts; a guided refine step is Next. |
| Is there a quality bar for drafts? | Yes, set by the lead after critique: eight usable drafts of ten on one real model (D33). Nobody on the panel has seen a real draft. | If the bar is too high or too low, the release note says the wrong thing about the feature. |
| In which language is content stored? | The UI's base language only, for empty, template and AI starts. A copy keeps its languages, minus those of texts the author rewrites. More languages in the editor, with its Translate button. | Users of the other language see the first language until someone translates. |
| Which UI languages must the copy ship in? | English and German. | More files to translate. |
| Is the product noun "App" or "Assistant"? | "App", explained once as "an assistant for one task". | A wording pass. |
| Who reviews the German, and does a customer glossary exist? | One native reader on the team before merge; no glossary. | Stiff or inconsistent German. |
| Do "Hint in the message box" and "Remember earlier messages" read as intended? | Probably; not tested with non-technical readers. A 20-minute check with three people is Next. | Two strings. |
| Which templates, and who maintains them? | The six of 5.2, written for the gallery. Q19. | Six short files. |
| Is a FAQ over a document a template? | No. Answering from a document uploaded once needs knowledge sources and is not simple today. The quickstart says so. | The knowledge expert's first use case stays out of the simple flow (WZ-8 "Add knowledge to an app", Later). |
| Is there a brand palette for app colours? Should AI have its own colour? | Eight Tailwind 600 values with white text at 4.5:1; one accent, no purple. | Class changes. |
| Do customers theme the admin area? | No; the admin tokens are fixed (Rework:47). | None here. |
| How many apps does a customer have? | Up to about 60 before search is the only way in. | The copy picker needs paging. |
| Do admins build apps on a phone? | It must work at 390 px and is not optimised further. | Layout work. |
| Is "Save & Exit" used? | Probably rarely. Removed; the release entry says so. | One button back. |
| Do current admins accept collapsed groups? | Yes, with summaries, a "changed" marker and "Expand all". No session with real admins took place. | A "Find setting" filter (Next) moves up. |
| Must link and embedded apps be creatable by non-technical authors? | Yes, through the link variant; it is the first item on the cut list. | None. |
| Should iframe and redirect apps be limited to allowed hosts? | No. | A platform setting. |
| Which models do customers use, and do they honour `responseFormat: json`? | OpenAI-compatible endpoints; at least one ignores it, so the parser accepts prose and fences. | More unusable answers. |
| Which browsers are a release requirement? | Chromium as the gate; Firefox and Safari by hand. | A wider test matrix. |
| Is the main Playwright suite out of CI on purpose? | Never decided. | None here. |
| Do customers edit the generator prompt on purpose? | Some do; their copy kept winning until 2026-11-22, when the owner removed the prompt. | Q5. |
| Does anyone rely on `parentId` of cloned apps, or script the endpoints that lose their caller? | Possibly; existing data and endpoints are untouched. | None now. |
| May content admins see the instructions of every app? | Unchanged: they can today. | A permission project. |
| Is a second person's approval needed before publishing? Are creators told when their app is unpublished or deleted? What happens to apps of people who left? | No workflow, no notification, nothing automatic. | Customer process. |
| How long are audit entries kept, and may they hold token counts per user? | Counts yes, texts never. | A works-council topic at some customers. |
| How many customers removed the `authenticated: *` wildcard? | Unknown. | On such an installation a content admin cannot test a new app until one of their groups is granted. The test panel says so and links to the access group; end-to-end case 16 covers it. |
| Should creating an app grant it to one of the author's groups? | No. Creating grants nothing, as today. | On an installation without the wildcard every new app needs one more step before its author can test it. |
| Is `allowEmptyContent: true` right for every draft whose message template uses an input field? | Yes; the shipped email composer does the same. | A user can send a form with empty optional fields and no message. |
| Do customers override the two renamed label keys (`admin.apps.edit.skills`, `.workflows`) or other relabelled keys in their own locale files? | Probably not. | A customised label falls back to the new default text. |
| How is an app moved between a test and a production instance? | Download and Upload, unchanged; an uploaded file keeps its `enabled` value. | None. |
| How many non-technical builders does a customer have, and is there usage data for the old wizard? | Unknown; none. | Priorities of Q1 and of the Next list. |
| Is there a release date or customer commitment? Who can be observed using the flow? | None known; five colleagues who never opened the admin area, before release. | Scope pressure. |

## 11. Choices made without asking

### 11.1 By the lead, when merging

- Testing an unpublished app is built now, against the engineer's advice, with the narrow design of
  5.4 and the fallback of 6.3.
- `getAppForRequest` decides by `isContentAdmin` and `enabled` only. It does not bypass group
  permission and is not used for scheduled, workflow, tool or API runs.
- No new model endpoint; the page uses `GET /api/models`. The draft model follows the usage-guide
  rule.
- The templates are six files written for the gallery (D12). The first plan served six shipped
  apps as they are; the critics showed that those bind a project, lack German instructions or
  change settings outside the two open groups.
- Publishing is a button with a confirmation fed by the content-access endpoint, not a switch.
  The endpoint gains the `audience` field. The next steps do not tick themselves, and the dialog
  has no "not tested yet" line, because both would need a signal from the embedded chat.
- Link and embedded apps get a variant of Essentials, so the editor's "new" mode can go.
- The create origin travels as the query parameter `origin`, because the body schema is strict.
  An unknown value answers 400.
- "No model" answers 503 with a new code, following the usage-guide route; an unusable answer is
  502.
- A description may have 2,000 characters; a draft at most 8 input fields and 4 conversation
  starters.
- The bulk actions are relabelled "Publish all" and "Unpublish all", so that one flag has one name.
- Every file in `app-form/` leaves the translation baseline. The labels of the two open groups
  are reworded (4.5); the other sections keep their wording, except the title "Connected
  systems".
- The admin rate limit on `POST /api/completions` is treated as a fix.
- The editor has the Review's seven groups plus access; conversation starters sit inside
  "Instructions and inputs" instead of in a group of their own.
- The client refuses IDs that start with `_`.

Taken when revising after the critiques:

- The server uses its own brief when the library prompt is unchanged (D10, Q18). Since 2026-11-22 it always does: the prompt is removed.
- `audience.allSignedIn` is shown to content admins (Q20).
- A copy loses the other languages of a text the author rewrites on Essentials. The risk critic
  proposed only a note that other languages keep the source text. The stricter rule was chosen,
  because a note does not stop users of the other language from getting the old instructions.
- Groups do not open because their values differ from the defaults.
- The App ID input leaves the editor; app type and order move under "More details"; auto-start,
  ephemeral chat and the usage guide move to Chat features.
- The language component changes behaviour only behind a new prop; its "Add Language" label and
  the names in its list change for every caller.
- Publish and Unpublish call `_toggle`; a dirty form is saved first.
- "Publish all" sends explicit IDs and covers the rows shown when a filter is active.
- No snapshot on create; the audit action is the existing `execute`.
- The draft limit is 30 per person per hour as a code default, without a setting (Q21). It is not
  mounted on `POST /api/completions`: that would tighten an endpoint with possible external
  callers, which is Q3.
- `exports.js` and `voiceRoutes.js` are not converted for unpublished apps; the two consequences
  are written down in 5.4.
- The apps list moved into S3; `ResourceSelector` got a slice of its own (S11).
- The AI path counts as done at eight usable drafts of ten; without the run it ships switched on
  with a sentence in the release entry (D33).
- `allowEmptyContent` is set by the server for a draft whose message template uses a field.
- "Copy an existing app" moved under "Other ways to start", one click further away than in the
  first plan.

### 11.2 By the panelists, and what became of them

| Decision taken alone | By | In this plan |
|---|---|---|
| Builders are admins and content admins; no personal apps | PM, UX, admin, security, QE, engineer | Adopted (D1) |
| Include the permission question in this effort | Knowledge expert | Adopted as Q1; nothing built |
| A page at `/admin/apps/new`; wizard and picker deleted | PM, UX, UI, engineer | Adopted (D2) |
| One screen / two screens / three steps / four steps | PM / UX, engineer / UI / writer | Two (D3) |
| The description box is the first option | PM, UX, knowledge expert | Adopted (D4) |
| UI-created apps start not published; API default unchanged | PM, UX, UI, admin, security, QE, knowledge expert | Adopted (D5) |
| New apps stay enabled; testing disabled apps is not built | Engineer | Overruled (D6), kept as the fallback |
| Dedicated server endpoint that returns an unsaved app | Engineer, QE, security, admin | Adopted (D7) |
| The model's ID is ignored; one retry on 409 | Engineer | Adopted |
| Reserved IDs refused on create | Engineer | Client only; server check is Q6 |
| Suggestions unticked | Security, admin | Adopted (D8) |
| Bindings shown as removable chips | UX, PM, UI | Changed to unticked checkboxes |
| The generator keeps a narrow allow-list | PM, security, engineer | Adopted; security's "never" list is the union of the three |
| Tight caps for drafts, generous caps for the schema | Security | Draft caps adopted; schema caps are Q10 |
| Audit records sizes and usage, never text; origin as an audit detail | Security | Adopted |
| Server-stamped ownership fields | Admin | Not adopted; Q9 |
| Feature switch `appGenerator`, default on | Admin | Adopted (D11) |
| A configurable generator model | Admin | Q8 |
| Rate-limit `/api/completions` and restrict its models | Admin, security | Limit adopted; the rest is Q3 |
| The old endpoints stay registered | Engineer, QE | Adopted |
| Generator prompt: library copy wins, shipped fallback, no migration | Engineer | Changed after critique: only a customised copy wins; otherwise the server's brief (D10) |
| Generator brief becomes a server default | Security | Q5 |
| `GET /api/admin/app-models` | Engineer | Not adopted; Q7 |
| Templates from a fixed list of shipped files | Engineer | Changed after critique: six files written for the gallery (D12) |
| Gallery is Next / no gallery copy | PM / writer | Overruled; the copy is in 4.2 |
| Copy picker lists enabled apps / all apps | PM, UX / engineer, admin | Enabled apps (D13) |
| Duplicate without lineage, "(copy)", not published | PM, UX, engineer, admin | Adopted (D14) |
| ID derived, behind "Change" / never shown | PM, UX, UI, writer, engineer / knowledge expert | Derived, under "More details" (D15) |
| Content language is the UI language; AI text in one language | PM, UX, engineer | Adopted (D16) |
| No audience and no model choice in creation | PM, UX | Adopted (D17) |
| "Published / Not published", never "Draft" | UX | Adopted |
| "Available to users / Not available yet"; "Draft" only for the AI's output | Writer | The second half adopted; the state wording is UX's |
| "Instructions", "Input fields", "Duplicate", "Standard model", „Benutzer" and *Sie* | Writer | Adopted |
| "Instructions for the assistant", "Suggested questions", "What it does", "Link" for the ID | UX | Not adopted; one vocabulary (4.1) |
| "Assistant", "How it should behave", "Questions it asks first" | Knowledge expert | Not adopted; "App" is explained once |
| New namespace `admin.apps.create.*`, no fallback text | Writer | Adopted |
| Only four editor sections are relabelled | Writer | Widened after critique: every label in the two open groups (4.5) |
| The quickstart is a new page; `apps.md` stays the reference | Writer | Adopted |
| No Simple/Advanced switch; collapsed sections | UX, UI, engineer, admin | Adopted (D20) |
| A simple six-block view in front of the editor | Knowledge expert | Not adopted |
| Three sections open by default / two | UX / UI, engineer | Two groups; starters are inside the second |
| Sticky save bar; "Save & Exit" removed | UX, UI | Adopted |
| Form/JSON, History, Download under "More" | UX, UI | History, Download, Open app, Duplicate under "More"; the JSON toggle stays |
| Publish dialog informs about "untested", does not block | UX | The line is dropped; nothing blocks |
| Sharing blocked until tested once | Knowledge expert | Not adopted |
| Publish states the audience, no group picker | UX, admin | Adopted (D21) |
| Unknown model is a warning, not a 400 | Admin, security | Next (referential warnings) |
| Optional `If-Match` on app PUT now | Admin | Next (D25) |
| No migration touches app files | Admin, engineer | Adopted |
| Link apps open the full editor with the type preset | UX | Changed to a variant of Essentials (D26) |
| Static preview tile, not a chat | UI | A tile beside the icon picker (D27) |
| One accent colour; no field wrapper component; controls keep 36 px | UI | Adopted |
| Container queries for section layout | UI | Next |
| Repair `IconPicker` and `AdminSaveBar` in shared code | UI | Adopted; `LoadingSpinner` only if the new page uses it |
| Draft of the two screens in session storage | UX | Adopted |
| Jest-heavy coverage, one spec, own config, stub markers, chromium gate | QE | Adopted |
| Zero known axe violations for new UI; delete the baseline entry | QE | Adopted |
| Round trip over the 27 shipped apps with named normalisations | QE | Adopted |
| 502 for upstream and unusable answers | QE, engineer | Adopted for the unusable answer; model failures keep their existing codes |
| A CI job for the spec | QE | Adopted, pending approval (Q16) |
| Real-model quality as a manual checklist | QE | Adopted, with a bar and a consequence (D33) |
| Success measured by the spec and five moderated sessions | PM | Adopted |
| No entry in `breaking-changes.md` | PM | Adopted |
| Secret detector: warn in the editor, refuse in the generator | Security | Next |
| `preferredStyle: 'keep'` as the single default | Engineer | Adopted |
| `exampleApps.js` keeps its own ID helpers | Engineer | Adopted |
| One owner for the i18n files | Engineer | Adopted |

## 12. Deferred

**Next (tickets under #3741):**

- The other half of placeholder detection: a placeholder in the instructions that has no input
  field ("Add an input field for *name*"). The half "a field that no text uses" is built (D31).
- A "Find setting" filter in the editor index; container-query layout for `app-form/` sections;
  `Switch` instead of checkboxes for section on/off controls. They improve an editor that is
  usable without them.
- Next steps that tick themselves and a "not tested yet" line in the publish dialog. Both need a
  signal from the embedded chat.
- A merged Model block with the admin model list and status (AI-B9, AI-PM5), after Q7.
- Referential warnings on save (unknown model, integration, category) and a validate-only call.
- Secret detector shared by client and server.
- A setting for the generator model (Q8) and a configurable limit for drafts.
- Relabelling the remaining editor sections (web search, upload, voice, the body of the
  connected-systems section, the usage guide); the copy must be checked against code section by
  section.
- A "Give my group access" button on the next-steps card, for installations without the
  wildcard.
- Export settings and app-specific voices in the test chat of an unpublished app (5.4).
- Removing other languages when the author rewrites further texts of a copy in the editor
  (message template, input-field labels).
- Form fields for JSON-only settings a builder needs first: greeting, `disallowModelSelection`.
- Optional `If-Match` on app PUT (Q12); a used-by check on delete (AI-B12).
- "Improve with AI" on an existing app's instructions, with before/after and undo.
- A comprehension check of the new terms with three non-technical readers; replacing the shipped
  library prompt by the server's brief (needs a migration that updates unmodified copies only),
  after Q18.
- Folding the ID helpers of `server/services/integrations/exampleApps.js` into `shared/appId.js`.
- Scripted screenshots for the quickstart.

**Later (each needs an owner decision first):**

- Personal apps for users without admin rights (Q1), with the five preconditions of the security
  report. **Q1 is answered: the owner decided on 2026-11-20 that users may build, share, publish
  and hand over apps of their own** ("yes let's just do this as well. similar to projects").
  The design is [02-personal-apps.md](02-personal-apps.md) (increment 2). The owner also asked
  for a chat-based app builder; its plan is
  [03-chat-based-app-builder.md](03-chat-based-app-builder.md).
- "Only these groups" when creating or publishing (open decision 1), and marketplace access for
  content admins.
- Drafts of an already published app (open decision 6).
- Ownership fields and list filters (Q9); approval before publishing.
- The generator brief as a server default (Q5); removing old endpoints (Q11); schema hardening
  (Q10); reserved IDs on the server (Q6).
- Adding knowledge to an app in a simple way (WZ-8).

**Not to be built:**

- A wizard step that repeats an editor section.
- Tabs or a Simple/Advanced mode in the editor.
- Inheritance or "based on" lineage in the UI.
- A generator that chooses app type, URLs, uploads, approval rules, skills or workflows.
- A chat-style builder before the one-shot path is known to work.
- A self-service switch for non-admins before owner, scope and capability ceiling exist on the
  server.
- A partial patch that opens disabled apps by a request flag.
- A field wrapper component ahead of the planned Tier 1 and 2 admin components.

## 13. Where this plan departs from prior art

- **W2 has four steps (Review:242-250); this plan has two screens.** "Model and audience" is
  dropped from creation: the model has a correct default, and audience depends on open decision 1.
- **W2 step 2 asks for category and placeholder detection.** Category has a default and sits under
  "More details". Of placeholder detection, the half "a field that no text uses" is built; the
  half "a placeholder without a field" is Next.
- **W2 step 3 uses the admin model list (AI-B9).** Not built; Q7.
- **W2 says "Duplicate an existing app (searchable, all apps)".** The picker lists enabled apps,
  following the owner's later decision (Rework:46). The row action works on all apps.
- **W2 says "creates the app as a draft".** The app is created with `enabled: false` and called
  "Not published". W2's prerequisite, that admins can test such an app, is built.
- **The Review names four gallery entries (FAQ over iFinder, Translator, Document Q&A, Email
  composer; Review:215).** The gallery ships six templates written for it, without bindings. The
  two entries that need iFinder or a knowledge source are left out.
- **The Review recommends "System prompt" (open decision 11).** The label is "Instructions"; Q4.
- **The Review turns Enabled into a header switch and access into a pill or drawer
  (Review:193-202).** Here it is a status with a Publish button and a confirmation; access stays a
  group at the end of the page.
- **The Rework puts WZ-7 and the editor frame under Next and Tier 1 and 2 components before
  them (Rework:179).** This increment pulls flow and frame forward at the owner's request and
  builds no field wrapper.
- **The 5.7.1 fix "App Generator Creates Apps That Use Integrations" bound integrations
  directly.** They are now suggestions the author ticks.
- **The Test Mode concept of 2026-09-24 is unchanged in one point:** the test chat runs the saved
  configuration only.

- **`docs/api-guidelines.md` section 1 reserves query parameters for filtering, sorting and
  search.** `POST /api/admin/apps?origin=…` uses one for audit metadata, because the strict body
  schema leaves no other place (section 5.2). The parameter is documented with its enum and an
  unknown value answers 400.
- **The Review's finding AI-B8 asks that the generator prompt cannot be broken from the library.**
  This plan goes one step further than the first version: an unchanged library copy is no longer
  used at all (D10). A customised copy still is; Q5. (Since 2026-11-22 no copy is used: the prompt is removed.)
- **The Rework's "Now" phase (PR #3796) gave the bulk toggles a confirmation that names the first
  five apps.** The apps list now names every app and sends explicit IDs. Models and prompts keep
  the merged behaviour.

Nothing here contradicts an owner decision of 2026-11-17.

## 14. What was verified, and what was not

### 14.1 The merge gate, run on 2026-11-21

The gate of section 7.4 ran once on the finished working tree. The increment caused no failure.
The following commands ended red, and each of them fails in the same way on the commit the branch
started from (`f7714f8`, release v5.7.3):

- `npm run test:quick`: the server test "replaces a thread that crashed"
  (`server/tests/extraction-pool.test.js:247`) fails.
- `npm run check:response-shapes`: two routes differ, but only because this sandbox sets
  `STAAN_API_KEY`. Without the variable the check is green.
- The four admin specs: "a choice made in the sidebar survives an OS theme change"
  (`tests/e2e/admin-controls-visible.spec.js:361`) fails.
- `npm run test:e2e:subpath`: the route crawl fails on `/apps/embedded-website-wikipedia`.

Not done at all: the run of the ten descriptions against a real model (7.5, D33) and the manual
walk of 7.5.

**Environment.** Node 24.22.3. Chromium build 1243 (157.0.8103.78) and ffmpeg build 1011, which
the sandbox ships; Playwright 1.65 expects builds 1254 and 1013, so the runs used aliases in a
private `PLAYWRIGHT_BROWSERS_PATH` outside the repository.
`npx --no-install playwright install --with-deps chromium` was therefore not run. Every Playwright
run started its own server. The runs on the default config, the app builder run and the authz run
started from a fresh contents directory (`contents-e2e`, `contents-e2e-app-builder`,
`contents-e2e-authz`). The subpath run used `contents-subpath` as earlier runs had left it. Only
the chromium project ran; Firefox, WebKit and the mobile projects did not.

**The base of the comparison.** The local ref `origin/main` of this checkout is stale: it points
at `9882782`, 61 commits before the commit the branch started from. A diff against it contains
the work of those 61 commits. The two diff-based checks therefore ran against `f7714f8`, and once
more against `origin/main` as section 7.4 writes them. "Fails on the base" below means: the same
command, run in a separate worktree at `f7714f8` in the same sandbox, failed with the same
message.

| Command | Result |
|---|---|
| `npm run lint:fix` | Passed: 0 errors, 541 warnings (the base has 552). It changed no file. |
| `npm run format:fix` | Passed. It changed no file. |
| `npm run test:quick` | **Red, fails on the base.** Config-access check passed. Jest, `tests/unit`: 559 suites and 8661 tests passed. Server tests, `node:test` group (676 files): 8523 of 8526 tests passed, 2 skipped, 1 failed. Server tests, Jest group: 315 suites and 4440 tests passed. The script stops at the first failure, so its last three parts ran separately: `test:token-stats`, `test:export-formats` and `test:feature-flags` passed. |
| `npm run test:integration:ci` | Passed: 4 suites, 91 tests passed, 6 skipped. |
| `npm run test:boot` | Passed: the server booted in all 3 scenarios. |
| `timeout 10s node server/server.js` | The server started, listened, and shut down at the timeout. The log has no entry of level error. |
| `npm run build:api-docs` | Passed: 104, 150 and 10 paths in the three documents. |
| `node scripts/check-response-shapes.js --update` | With `STAAN_API_KEY` unset, and after Prettier, the snapshot is identical to the committed one. The route changes of the increment were already in it (`GET /api/admin/app-templates`). |
| `npm run check:response-shapes` | **Red in this sandbox, fails on the base.** Passed with `STAAN_API_KEY` unset: 352 routes, all answers match. |
| `git diff … \| node scripts/check-api-guidelines.js` | Passed: 0 violations in the 21 server files the increment changes. |
| `npm run security:audit` | Passed: 355 admin endpoints, 354 guarded, 1 documented exception. |
| `npm run test:e2e:authz` | Passed: 21 tests. |
| `npm run test:e2e:app-builder -- --project=chromium --retries=0` | Passed: 22 tests in 3.5 minutes, one worker, with `STAAN_API_KEY` unset as in CI. The slice ran it twice before with the variable set, also green. |
| `npm run test:a11y -- --project=chromium` | Passed: 90 tests. |
| `npm run test:e2e:crawl -- --project=chromium --retries=0` | Passed: 115 pages. |
| The four admin specs (`admin-unsaved-guards`, `admin-controls-visible`, `admin-load-gating`, `admin-confirmations`) | **Red, fails on the base.** 41 passed, 1 failed. The two changed entries for `/admin/apps/new` pass in all three themes. |
| `(cd client && npm run build) && npm run test:e2e:subpath` | **Red, fails on the base.** The build passed. 2 tests passed (among them the new `app-builder-subpath.spec.js`), 1 failed, 6 skipped (the connect flow, which needs `CONNECT_E2E=1`). |
| `node scripts/check-a11y-diff.js` | Passed: 0 findings in the 83 client files the increment changes. |
| `reuse lint` | Passed with reuse 6.3.0 from a private virtual environment (CI pins 6.2.0): 5857 of 5857 files have copyright and licence information. A script also confirmed the two SPDX lines in each of the 93 new source files. |

**The four red results.**

- *`extraction-pool.test.js`, "replaces a thread that crashed".* The test gives a worker thread
  a heap of 8 MB and expects the extraction to end with `EXTRACTION_FAILED`. In this sandbox the
  assertion on the error type fails, in three of three runs of the file alone and in two of two
  runs on the base. The increment does not touch the extraction code. Whether the test also fails
  in CI was not checked.
- *Response shapes.* The sandbox has the environment variable `STAAN_API_KEY`. With it, the
  server installs a web search integration, and `GET /api/integrations` and
  `GET /api/admin/apps/integration-status` answer with additional entries. The snapshot was
  not changed for this.
- *"A choice made in the sidebar survives an OS theme change".* The test looks for a button named
  "Theme:" in the admin sidebar. Neither the base nor the branch renders one. Someone has to
  decide whether the test or the sidebar is wrong; the increment changes neither.
- *The subpath crawl.* The shipped app `embedded-website-wikipedia` frames Wikipedia, and the
  browser logs an error about Wikipedia's report-only Content Security Policy. The crawl counts
  every console error. It needs the network: the same crawl on the default config passed in this
  run.

**Also checked.**

- `tests/unit/client/known-routes-sync.test.jsx` passes. The increment adds the route
  `admin/apps/new` below the known route `admin`, so both lists stay as they are.
- No file outside the increment changed. `git status` and the checksum of every modified and
  untracked file were the same after the gate as before it; `lint:fix` and `format:fix`
  rewrote nothing. The diff against `f7714f8` holds 122 added, 86 modified and 6 deleted
  tracked files plus 12 untracked ones, all of them files of a slice or of this concept folder.
- `contents/` is git-ignored and holds no app, group or user of this increment. The twelve
  server test files of the increment leave it untouched. Older server tests do write into it
  when `npm run test:server` runs (group and integration settings, audit entries, change
  history), for example `server/tests/loop/toolApprovalReviewFixes.test.js`, which installs an
  integration named `jira`. That is the state of the base and was not changed.
- No server was left running. The ports 3000, 5173, 5174, 3085, 5185, 8979 and 8985 answer
  nothing. The git-ignored directories of the runs remain: `contents-e2e*`, `contents-subpath`,
  `test-results/`, `playwright-report/`, `client/dist`.

**Not verified by the gate.**

- A draft from a real model (7.5, D33). The release entry and the quickstart say that the
  quality of drafts was not yet measured; the ticket under #3741 stays open.
- The manual walk of 7.5: `/ihub/`, German, dark mode, 390 px, keyboard only, screen reader.
  The automated suites cover parts of it (the German walk, the keyboard walk and the 390 px
  check of the app builder spec; the subpath spec), but nobody looked at the screens.
- Any browser other than Chromium, and Chromium only in a build older than the one Playwright
  expects.
- The workflow `.github/workflows/app-builder-e2e.yml` itself. It never ran; the gate ran the
  command it calls.
- The no-model state of the create page, the copy start and the restored-draft notice were not
  scanned with axe. The scan of the open icon list leaves out the colour group.

**Open points the gate found or passes on.** None of them is a red test.

- Focus after "Create and test": the heading of the next-steps card gets the focus (3.3), and
  about 140 ms later the message box of the test chat takes it. The Jest test of the arrival
  replaces the chat and does not see this. The owner of the editor decides whether the message
  box may keep the focus.
- The icon picker is still a dropdown and not the shared Modal that 3.7 names. S9 added a layer
  that catches clicks beside the open list; the change applies to every page that uses the
  picker.
- The editor with every group expanded has 11 known axe findings on `/admin/apps/chat`
  (7 checkboxes without a label, 4 selects without a name). The accessibility spec records them
  as a count that may only shrink. Before the increment the count was 27.
- `tests/e2e/app-builder.spec.js` is also collected by the default Playwright config and skips
  itself there (22 skipped tests in a full run of the default config).

**After the review.** The fixes of the review were in the working tree, uncommitted (83 changed
or new files on top of `1f298ed`), when the following part of the gate ran again on 2026-11-22
in the same environment. No run needed a change, and nothing outside the known red results
failed.

| Command | Result |
|---|---|
| `npm run lint:fix && npm run format:fix` | Passed: 0 errors, 541 warnings. Prettier rewrote no file, and the list of `git status` was the same before and after. |
| `npm run test:quick` | **Red, the known failure only.** Config-access check passed. Jest, `tests/unit`: 563 suites and 8724 tests passed. Server tests, `node:test` group: 8530 of 8533 tests passed, 2 skipped, 1 failed ("replaces a thread that crashed"). Server tests, Jest group: 315 suites and 4440 tests passed. Run separately afterwards: `test:token-stats`, `test:export-formats` and `test:feature-flags` passed. |
| `env -u STAAN_API_KEY npm run check:response-shapes` | Passed: 352 routes, all answers match. |
| `npm run test:e2e:authz` | Passed: 21 tests. |
| `env -u STAAN_API_KEY npm run test:e2e:app-builder -- --project=chromium --retries=0` | Passed: 22 tests in 3.4 minutes. |
| `E2E_FRESH_CONTENTS=1 npm run test:a11y -- --project=chromium --reporter=list` | Passed: 94 tests in 3.7 minutes. |
| `timeout 10s node server/server.js` | The server started, listened, and was stopped by the timeout. The log has no entry of level error. |

Not repeated after the review: the integration tests, `test:boot`, the API documents, the
guideline and security checks, the route crawl, the four admin specs, the subpath run,
`check-a11y-diff.js` and `reuse lint`. No server was left running.

### 14.2 Verified in code while planning


- `getApps()` filters `enabled !== false` (`server/configCache.js:887-906`), and the lookups of
  5.4 exist at the lines named. The engineer counted 45 calls of `getApps(` and `getAppsForUser(`
  outside admin routes; the lookups by ID on the interactive chat path are the ones listed in 5.4.
- `isContentAdmin` is computed once and is never true for delegated or machine principals
  (`server/utils/authorization.js:803-811`).
- `POST /api/admin/apps/_usage-guide`, `selectGuideModel` and its 503 exist and are the precedent
  for the draft endpoint.
- No rate limiter is mounted for `/api/completions`; the shipped admin budget is 300 per user per
  minute (`server/defaults/config/platform.json:240-246`).
- Variables are replaced in the system prompt (`server/services/PromptService.js:542-548`).
- `GET /api/admin/content-access/:type/:id` returns `scope` and, per group, `effective` and
  `wildcard`.
- The six shipped apps that the first plan named as templates do not fit: a script over
  `server/defaults/apps` shows that `meeting-agenda-generator` binds a project, `idea-coach` has
  `system` in `en` only, and four of the six carry `enabled: false`. The template files of this
  plan do not exist yet; S2 writes them.
- `LLMClient.execute` reads `maxTokens` and `responseFormat` from `options`
  (`server/services/loop/LLMClient.js:689-699`); the usage-guide service passes the model as an
  object (`server/services/appUsageGuide.js:43-44`); `responseFormat: 'json'` is the value other
  callers pass (`server/services/inference/structuredOutput.js:367`).
- A call with `telemetry.user` is checked against the user's usage limit
  (`LLMClient.js:722-725`).
- The audit schema has no action `generate`; `execute` exists
  (`server/validators/auditEntrySchema.js:13-37`).
- `createRateLimiter` is not exported; `createOAuthTokenLimiter` is the pattern for a limiter that
  a route mounts itself (`server/middleware/rateLimiting.js:150`, `:466`). The shipped admin
  limiter skips failed requests (`server/defaults/config/platform.json:240-246`).
- The content-access view leaves out the groups `authenticated` and `anonymous` for a content
  admin (`server/utils/contentAccess.js:161-165`); the type in the path is `apps`
  (`server/routes/admin/contentAccess.js:40-48`); the shipped group `authenticated` grants
  `apps: ["*"]`.
- `POST /api/admin/apps/:appIds/_toggle` exists, uses `contentAdminAuth`, changes only `enabled`
  and writes an audit entry (`server/routes/admin/apps.js:1030-1070`).
- `AdminAppsPage.jsx` is the only importer of the two components to delete, and three test files
  mock them (`app-migration-warnings`, `admin-bulk-toggle-confirm`,
  `admin-apps-missing-integration`).
- The key test fails on a stale baseline entry and counts a key that resolves to an object as
  present (`tests/unit/client/translation-keys-exist.test.jsx:113-125`, `:199-208`).
- `ResourceSelector.jsx:31-32` calls `toLowerCase` on `resource.name?.en || resource.name`, which
  is an object for a German-only name.
- `DynamicLanguageEditor` is imported by 35 files and treats `en` as the base language (`:436`,
  `:470`).
- A message template without `{{content}}` gets the message appended
  (`server/services/PromptService.js:495-500`); a field without a placeholder in a text is not
  sent.
- `prepareChatRequest` is called by the chat route, scheduled tasks, the inference API and
  app tools (`sessionRoutes.js:1629`, `taskExecution.js:447`, `appTurn.js:131`,
  `ChatService.js:1968`). `voiceRoutes.js:84` is a loop over `getAppsForUser`. The two helpers in
  `exports.js:49,58` take no user.
- The rollback route answers 404 for a snapshot without a before state
  (`server/routes/admin/changes.js:106-109`).
- The setup copies `server/defaults` into `contents/` (`server/utils/setupUtils.js`), which is why
  the template files live elsewhere.
- `tests/e2e/admin-controls-visible.spec.js:50`, `tests/e2e/accessibility.spec.js:326` and
  `tests/config/playwright.subpath.config.js:23` depend on today's page as section 7.3 says.
- The scripts `build:api-docs`, `check:response-shapes`, `security:audit` and `test:e2e:authz`
  exist in `package.json`; `scripts/check-api-guidelines.js` exists.
- `AdminSaveBar`, `AdminSettingsPage`, `MoreActionsMenu`, `IconPicker`, `ConfirmDialog` with
  consequences, `requireFeature`, `useFeatureFlags` and `logAudit` with `details` exist.
- The translation baseline lists 163 missing keys for the app list, the editor page, the form
  editor and `app-form/`, and 91 for the two components to delete.
- The default client timeout is 30 seconds; a per-call timeout is supported
  (`client/src/api/adminApi.js:762`).
- The npm scripts of 7.4 exist, except `test:e2e:app-builder`, which S9 adds.

### 14.3 Not verified while planning, and what became of it

- A successful draft from a real model. **Still open.** No panelist and no engineer saw one.
- Whether `timeoutMs` and `signal` of the model client stop the upstream request for every
  provider adapter. **Shown for one adapter.** Case 9b of the app builder spec runs against the
  stub, which speaks the OpenAI protocol: the server ends a draft after 80 seconds with 504, and
  after Cancel the stub reports that the caller hung up. The other adapters were not checked.
- What `PUT /api/admin/apps/{id}` does today when the body carries another ID (Q22). **Not
  checked by the gate.**
- Earlier released versions of the shipped generator prompt. **Done as far as the history
  reaches:** `SHIPPED_BRIEF_HASHES` lists 12 hashes. An installation with an unchanged copy of
  a version that is not among them still counts as "customised".
- Whether `ContentAccessSection` saves at once or with the form. **It saves at once** and calls
  `onSaved` with the answer.
- Whether the subpath test server has an admin sign-in. **It has;** the subpath spec signs in and
  passes.
- Whether customers override relabelled keys in their own locale files. **Still open.**
- How answers render when `preferredOutputFormat` is `html`. **Still open.**
- The exact route for disabling the stub model in case 8.
  **`POST /api/admin/models/{id}/_toggle`;** the case passes.
- Whether the sandbox can install the chromium build that the repo's Playwright expects. **It
  cannot.** The runs used the installed build 1243 under the name of build 1254.
- Which further client requests the embedded chat sends for an app beyond the routes in 5.4.
  **Recorded as a ratchet:** `server/tests/app-unpublished-access.baseline.json` lists every
  lookup that still reads only published apps, with the reason. Two of them limit the test chat
  of an unpublished app: an `@workflow` mention is refused, and the view of an MCP App does not
  open. `docs/admin-ui.md` names both.

## 15. Critique and resolution

Three critics read the merged plan against the code: feasibility, the non-technical user, and
risk. All three said "ship with changes". Each point was checked in the code before it was
accepted; all of them held. The table says what became of each point and where the plan changed.
"Applied" means the critic's fix was taken as proposed.

### 15.1 Feasibility

| # | Severity | Point | Resolution | Where |
|---|---|---|---|---|
| F1 | blocker | S3 deletes the wizard, but its only importer and two test files that mock it belong to nobody or to a later slice. | Applied. The apps list moved into S3. S3 owns the three test files. Its first step is one change that deletes, rewires and runs the unit suite. | 6.1, 5.6 |
| F2 | major | The translation ratchet fails when the files are deleted; only S0 may edit the baseline. | Applied, as a general rule: an entry is removed by the change that makes it stale; nobody adds one. | 6.1 |
| F3 | major | Two keys are used as a text and as a parent of other keys. | Applied. `skillsTitle` and `workflowsTitle`; S8 owns every file in `app-form/`; a test checks that no label resolves to an object, because the existing test would not notice. | 4.5, 6.2 |
| F4 | major | S2 needs the texts of its two new error codes; they were prose, and S0 was no dependency. | Applied. Two rows in 4.4; S2 depends on S0 pass 1. | 4.4, 6.1 |
| F5 | major | The model call was written with a signature the client does not have. | Applied. The call is written out; a signal and a server timeout stop the paid call on Cancel. | 5.2 |
| F6 | major | The audit action `generate` is not allowed. | Applied: the existing action `execute` with `details.purpose`. | 5.2 |
| F7 | major | `voiceRoutes.js:84` is a list, not a lookup by ID. | Applied: removed from the conversion; the consequence is written down. | 5.4 |
| F8 | major | One template binds a knowledge project; the test would not catch it. | Applied, and taken further: the templates are now files written for the gallery, limited to content keys by a test. | 5.2, D12 |
| F9 | major | Two end-to-end specs of the merge gate depend on today's page; the editor loses its axe scan; the subpath config has a fixed spec list. | Applied. S9 owns the three files; the editor is scanned with every group expanded. | 7.3, 6.1 |
| F10 | major | S7 and S8 share four features and had no interface. | Applied: a contract of two files, published first; one merge for both slices. The slices stay separate. | 3.5, 6.1 |
| F11 | major | The error mapping gives wrong causes for codes the model client returns. | Applied. | 4.4 |
| F12 | minor | The draft limit was an "if"; the helper is not exported. | Applied: the limit is mandatory, with an exported factory. | 5.2 |
| F13 | minor | A create snapshot without a before state shows a rollback that always fails. | Applied, by the second option: no snapshot on create. | D23, 5.2 |
| F14 | minor | The OpenAPI blocks sat in the docs slice; the gate lacked the API checks. | Applied. | 5.2, 7.4, 8 |
| F15 | minor | `origin` is a query parameter that is no filter, and unknown values were ignored. | Applied: documented, named as a deviation, 400 for an unknown value. | 5.2, 13 |
| F16 | minor | Principle 9 does not hold for keys picked from a map; the new i18n test repeated an existing one. | Applied. | 1, 6.2 |
| F17 | minor | Some acceptance criteria could not be tested. | Applied: the dark-mode line, two checklists in place of "review", a language rule per start. | 6.2 |

### 15.2 Non-technical user

| # | Severity | Point | Resolution | Where |
|---|---|---|---|---|
| N1 | major | The first open group keeps App ID, App Type, Order and two chat options; the open groups keep the old words. | Applied. The App ID input is removed; the other fields move; every label of the two open groups is in 4.5; an acceptance test checks the words in both languages. The usage guide moves to Chat features as well, which the critic did not ask for. | 3.5, 4.5, 6.2 |
| N2 | major | A German-only app shows language codes, "Add Language" and "No languages configured" in the editor. | Applied, narrower than proposed. The component has 35 callers, so the new behaviour sits behind an opt-in prop that the app form passes. Only the label "Add a translation" and the language names change for every caller. | 3.5, 6.2 |
| N3 | major | Auto-open brings the long page back for every template and copy. | Applied: no auto-open; a "changed" marker. | 3.5, D20 |
| N4 | major | Templates and copies carry two languages while Essentials edits one; two templates are poor starting points. | Applied. Templates keep the content language only and are written for the gallery. A copy drops the other languages of a text the author rewrites and says so. | 5.1, 5.2, 3.2 |
| N5 | major | The publish dialog cannot tell a content admin who will see the app; the path was wrong; "Authenticated" is jargon. | Applied: the `audience` field, the corrected path, a text table that never prints the group name. | 3.4, 5.2 |
| N6 | major | Without the wildcard the author cannot test the own app; "only administrators" reads as "not me". | Applied with the smaller fix: the test panel names the cause and opens the access group; the strings say "you and others who manage apps"; the cost in 10.2 is corrected; an end-to-end case covers it. Not applied: a "Give my group access" button on the next-steps card. The access group already offers the choice, and picking a group for the author is a decision the page should not take. It is under Next. | 3.3, 4.2, 7.3, 12 |
| N7 | major | Input fields depend on hand-written placeholders; an unreferenced field is ignored; unticking leaves placeholders behind. | Applied. The server adds unused fields to the message template and sets `allowEmptyContent`; the editor marks an unused field and derives the placeholder from the field name. For unticking, the critic's second option was taken: the checkbox is locked when the instructions use the fields, because stripping a placeholder out of a sentence leaves a broken sentence. | 5.1, 5.3, 3.2, 3.5 |
| N8 | major | The AI path is unproven; no way to improve a weak draft; the brief contradicts the appended rules; the real-model check is no gate. | Applied in three parts: the description is editable beside the draft; the server uses its own brief unless the library copy was changed; the run has a bar of eight in ten. One part differs: the run cannot be a merge gate, because the sandbox has no model key. If it does not take place, the release entry says so and a ticket stays open. | 3.2, 5.2, 7.5, D33 |
| N9 | minor | Essentials shows the ID, three information lines and the duplicate notice for a template. | Applied. | 3.2, 4.2 |
| N10 | minor | The Start screen offers eight more options under the box. | Applied: one collapsed line for copy, link app and Marketplace. The overlap between templates and shipped apps in the copy list is accepted and stated. | 3.1 |
| N11 | minor | One error text for every model failure. | Applied (same as F11). | 4.4 |
| N12 | minor | "Connected systems" in the flow, "Integrations" in the editor. | Applied: the section title is relabelled; the admin page keeps its name and the glossary maps the two. | 4.1, 4.5 |

### 15.3 Risk

| # | Severity | Point | Resolution | Where |
|---|---|---|---|---|
| R1 | blocker | The publish dialog tells a content admin the wrong audience. | Applied (same as N5), with the server test and the Jest cases the critic asked for. | 3.4, 5.2, 6.2 |
| R2 | major | The cost bound for drafts does not hold: failed drafts are not counted, and the dedicated limit was optional. | Applied for the draft route: a mandatory limiter that counts failures, marked with `details.limiter`. Not applied for `POST /api/completions`: the critic wanted the same limiter there. That endpoint may have external callers, and 30 per hour would be a tighter contract than today's; it stays under the admin limiter, and the cap is part of Q3. | 5.2, D24 |
| R3 | major | Drafts do count against a usage limit; the refusal was mapped to "try again". | Applied. | 4.4, 10.2, 14, 8 |
| R4 | major | Keying the request builder on the user opens unpublished apps to scheduled tasks, tools and the inference API. | Applied: the builder is unchanged; only the chat route passes the resolved app. Three rows were added to the matrix. For `exports.js` the plan does not change the two signatures but leaves the helpers unconverted and records the consequence. | 5.4 |
| R5 | major | A German-only name crashes `ResourceSelector`; the editor header shows the ID. | Applied: slice S11, the header in S7, a Jest test, an end-to-end step. | 3.5, 6.1, 7.3 |
| R6 | major | The six templates do not match what the plan said about them. | Applied (same as F8 and N4). For copies the plan chose the stricter rule of N4 over the proposed note. | 5.1, 5.2 |
| R7 | major | The target persona is never tested and cannot test its own app on a hardened installation. | Applied: a seeded content admin, cases 15 and 16, the panel message. | 7.3, 3.3 |
| R8 | major | Publish and Unpublish through the full save. | Applied: both call `_toggle`. The last-save-wins part is recorded and not solved here (Q12). | 3.4, 6.2 |
| R9 | major | "Publish all" becomes dangerous. | Applied: every name listed, explicit IDs, the filter respected, a release-note sentence. | 3.6, 8 |
| R10 | major | The merge gate misses the authorization suite, two CI checks and the client build; the subpath case could not be added; no single worker. | Applied. | 7.4, 6.1, 7.3 |
| R11 | minor | The poisoned brief and the recorded-answer corpus were dropped. | Applied: the response field `brief` (values `standard` and `customised`), a line in the draft notice, the audit detail, and a fixtures directory that the real-model run fills. The added sentence itself is not blocked; that needs Q5. | 5.2, 6.2, 7.5 |
| R12 | minor | No plural forms; the rollback on a create snapshot. | Applied. | 4.3, 4.4, D23 |

## 16. What a caller or an admin can notice

No endpoint is removed or reshaped, and no compatibility shim is added. The rows marked "owner"
are behaviour changes that wait for the owner's confirmation in section 10; each can be undone as
that question says.

| What | Change | Assessment |
|---|---|---|
| `GET /api/apps/{id}`, `POST /api/apps/{id}/chat/{chatId}` and the other routes of 5.4 | A content admin gets an unpublished app where the answer was 404. Every other principal gets the same answer as today. | Wider for one role, on purpose (D6). Owner: Q2. |
| `POST /api/completions` | 429 above the admin budget; no limiter covered it before. | Treated as a fix. Owner: Q3. |
| `POST /api/admin/apps` | New optional query parameter `origin`; an unknown value answers 400. No snapshot change. A POST without `enabled` still creates an enabled app. | Additive; no existing caller sends the parameter. |
| `GET` / `PUT /api/admin/content-access/{type}/{id}` | New fields `audience` and, on some rows, `implicit`. | Additive. Owner: Q20. |
| `POST /api/admin/apps/_generate`, `GET /api/admin/app-templates`, feature `appGenerator` | New. | Additive. |
| `GET /api/admin/prompts/app-generator`, `POST /api/completions` | The client no longer calls them. `GET /api/admin/prompts/app-generator` was removed on 2026-11-22 with the prompt. | Q11. |
| Library prompt "App Generator" | Removed on 2026-11-22: the shipped file, the library entry, `GET /api/admin/prompts/app-generator`, and stored copies (migration V261). Drafts always use the server's brief. | Owner: Q5, Q18. |
| Apps created in the admin UI | Start not published. | Owner: Q2. |
| AI draft | Web search and connected systems are suggestions the author ticks; 30 drafts per person per hour; drafts count against the person's usage limit. | Stricter than today, on purpose (D8, D24). |
| "Publish all" / "Unpublish all" | Lists every app; sends explicit IDs; covers the rows shown when a filter is active. | Behaviour of one button. |
| Removed from the UI | The wizard, the template window, "Save & Exit", the `enabled` checkbox in the form, the App ID input in the editor, "Clone" writing `parentId`. | Release entry. Owner: Q22 for the ID input. |
| Labels | The renames of section 4. Two key names change (`admin.apps.edit.skills` and `.workflows` as texts become `skillsTitle` and `workflowsTitle`). "Add Language" reads "Add a translation" on every admin page that uses the language component. | An installation that overrides these keys gets the default text. |

## The App Generator prompt is removed (2026-11-22)

The owner decided on 2026-11-22 to remove the prompt `app-generator` completely. Nobody used it
directly; apps are built with the app builder, whose drafts use the server's brief. This settles
Q5 and Q18 and closes AI-B8.

- `server/defaults/prompts/app-generator.json` is deleted, so new installations do not ship it.
- Migration `V261__remove_app_generator_prompt.js` deletes `contents/prompts/app-generator.json`
  on existing installations, whether shipped or customised. V231 stays as it was.
- Drafts (`POST /api/admin/apps/_generate`, `POST /api/apps/_generate`) always use
  `STANDARD_BRIEF`. `chooseBrief`, `SHIPPED_BRIEF_HASHES`, `hashBriefPrompt`,
  `APP_GENERATOR_PROMPT_ID` and `APP_GENERATOR_BRIEFS` are gone. The response field `brief`, the
  audit detail `brief` and the client note `draft.briefCustomised` are gone too; the endpoints
  had not shipped, so no compatibility is kept.
- `GET /api/admin/prompts/app-generator` and `buildAppGeneratorBrief` are removed (no client
  caller). The release notes carry a breaking-changes entry.
