# App builder rework: Senior UX Designer report

Panel role: Senior UX Designer. Lens: the end-to-end flow, progressive disclosure, the editor's
information architecture, microcopy, keyboard and screen-reader flow.

Abbreviations: `W` = `client/src/features/apps/components/AppCreationWizard.jsx`,
`T` = `client/src/features/apps/components/AppTemplateSelector.jsx`,
`L` = `client/src/features/admin/pages/AdminAppsPage.jsx`,
`E` = `client/src/features/admin/pages/AdminAppEditPage.jsx`.
"Review" = `concepts/admin-ui-review-2026-11/02-apps-models-prompts.md`.

How I checked: I read the code at the lines cited and opened the walkthrough screenshots
(`en-02-template-picker`, `en-04b-step2-basic-required-errors`, `en-14-ai-result`,
`en-30-editor-summarizer-viewport`, `en-34-editor-test-panel`). I did not run the app myself.
Where a number comes only from a briefing, I say so.

## Summary

Today a person who wants a simple app passes a list, a template picker, a method question and
five to six wizard steps. They type an ID by hand, never see the app run, and land back on the
list without a message. The app is live for every signed-in user from that second. If no model is
configured, the app cannot answer, and nothing on the way said so.

I propose the following flow:

1. **One entry point.** Every "new app" action opens the page `/admin/apps/new`. The page replaces
   the template modal, the wizard modal and the editor's "new" mode.
2. **Two screens before the app exists.** Screen 1 asks "What should your app do?" and offers
   four starts: describe it, pick a template, copy an app, start blank. Screen 2 shows three
   required fields: name, a one-line description, and the instructions. All four starts lead to
   the same screen 2. The AI start fills it in; the others fill in less.
3. **The app is created unpublished and opens in the editor with the Test panel open.** The user
   tries the app before anyone else sees it. A checklist names the next steps. "Publish" is one
   button with a short check.
4. **The editor gets an index and collapsed sections.** Three sections are open: Basics,
   Instructions and inputs, Suggested questions. The other sections are collapsed and show a
   one-line summary ("Web search: off"). There is no Simple/Advanced switch.
5. **Plain words.** "ID", "System Instructions", "Variables", "String" disappear from the
   creation flow. The editor keeps exact terms where an admin needs them, with a plain label next
   to each.

This deviates from the Review's W2 in two points, both explained in "Decisions I took on my own":
I use two creation screens, not three, and I move "audience" from creation to Publish.

Two server changes are prerequisites for this flow, not options: an admin must be able to test an
unpublished app, and the flow must know before the first click whether a usable model exists.

## Findings

Each finding names what the user experiences. IDs are mine (UX-F…); Review IDs are given where a
finding repeats one.

**UX-F1. There are two creation flows, and the entry decides which one you get.** The "Create App"
button opens the picker and then the wizard (`L:354-360`, `L:615`). Cmd+K "New App" and the
first-run setup open the full editor in "new" mode (`AdminCommandPalette.jsx:51`,
`SetupWizard.jsx:599`). The two flows have different fields and different defaults (Review
AI-PM3). A first-time admin coming from setup sees a form with a red error box before typing
anything (walkthrough defect 12).

**UX-F2. The user answers "how do you want to start" twice.** The picker offers "Create from
Scratch" or an app. After "Create from Scratch" the wizard asks "AI-Generated or Manual
Configuration" (briefing, `W:463-600`). The two questions are one question.

**UX-F3. The flow asks for things a non-technical person cannot answer.** The first required field
is "App ID" with a rule about dots, underscores and hyphens. The icon is a text field containing
`chat-bubbles` (screenshot `en-04b`). Variable types are String, Text, Number, Boolean. None of
this is needed to get a working first app.

**UX-F4. The flow never shows the app working.** The wizard ends with `onClose();
navigate('/admin/apps')` (`W:287-288`): no message, no link to the app, no test. The Test panel
exists, but only in the editor, and the wizard does not lead there.

**UX-F5. The first real feedback is a dead end.** On a fresh install the new app shows "No models
available" with a disabled send button (screenshot `en-34`). The wizard offered a model dropdown
labelled "Optional" with one entry. The user learns about the missing model only after the app is
already visible to others.

**UX-F6. The AI path hides its result and its failures.** Every failure shows "Network error
occurred while generating app" (`W:753-757`, screenshot `en-14`), including "no default model".
"Next" still works after a failure and leads to an empty form that is now step 3 of 7. On success
the user sees a green box, not the generated app. Web search and integrations chosen by the model
are saved but never shown (briefing, creation flow §6).

**UX-F7. Errors appear far from their cause.** A duplicate ID is reported four steps later on the
Review step. A badly formed ID shows "App ID is required" although the field is filled. The banner
"Please fill in all required fields" stays after the fields are filled (walkthrough defects 3, 4,
9).

**UX-F8. The dialogs are not dialogs.** Both overlays are a plain `div` with `fixed inset-0`
(`W:334`, `T:57`): no `role="dialog"`, no focus trap, no Escape, an unnamed close button. Closing
discards all input without asking (`W:350`, briefing). A shared `Modal` with focus trap and
`aria-modal` exists (`client/src/shared/components/Modal.jsx:104-105`) and is not used. On a
390 px screen the Next button leaves the dialog (walkthrough defect 5); in `en-04b` the Back/Next
row also sits outside the white box on desktop.

**UX-F9. The editor is one 8,000 px page without a map.** The summarizer app renders 19 sections,
all expanded, about 10 screens tall (briefing). The save buttons are at the very bottom and not
sticky (`E:657-698`). Screenshot `en-30` shows that the first screen is filled by ID, type, order
and category: the four things a non-technical author cares about least.

**UX-F10. The editor's order follows the schema, not the task.** "Web Search", "Integrations" and
"Tools" come before "Variables" and "Starter Prompts". The greeting has no field at all (briefing,
editor §8). The switch that makes the app visible ("Enabled") is one checkbox among fourteen in
Basic Information.

**UX-F11. Nothing is translated, and the content language is chosen three times.** None of the
wizard and picker keys exist in `en.json` or `de.json` (briefing). The wizard has three
independent language selects, so a name can be saved in German and the instructions in English.

**UX-F12. "Template" means "any live app".** The picker lists every enabled app with its ID and a
variable count (screenshot `en-02`). The chevron on each card suggests "expand" but the card
selects. A new author cannot tell a good starting point from a colleague's one-off.

## Proposal

### 1. Principles

1. **One way in, one way out.** One route creates apps. It ends in the editor of the new app.
2. **Nothing is asked that can be derived.** The ID comes from the name. The language comes from
   the UI. The model is the default model. Colour and icon have defaults.
3. **Show the app before others see it.** A new app is unpublished. The first thing the author
   does with it is try it.
4. **The creation flow has no field the editor lacks, and no second copy of editor sections.**
   Variables, uploads, tools and access are edited in the editor only. This is the Review's rule
   (Review README:271).
5. **Disclose by section, not by mode.** A collapsed section with a summary line tells the author
   that a setting exists and what it is set to. A mode switch hides that.
6. **Errors appear at the field, when the user leaves the field or submits.** Never before input.
   The save button stays enabled; pressing it with errors moves focus to the summary.

### 2. Flow overview

```
 Apps list ─┐
 Cmd+K ─────┤
 Setup ─────┼──► /admin/apps/new ──► Screen 1: Start ──► Screen 2: Essentials ──► POST (unpublished)
 Empty state┘                         │  describe ─ generate ─┘      ▲                │
                                      │  template ───────────────────┤                ▼
 Row action "Duplicate" ─► /admin/apps/new?copyOf=<id> ──────────────┘      /admin/apps/<id>?created=1
                                      │  blank ──────────────────────┘      Editor, Test panel open,
                                      └─ "Link or embedded website" ──────► checklist ─► Publish
                                                                             (editor, type preset)
```

Counts for the happy path, compared with today (walkthrough: 8 screens, 9 clicks, 4 required
fields):

| Start | Screens before the app exists | Clicks | Fields the user must type |
|---|---|---|---|
| Describe (AI) | 2 | 3: New app, Generate, Create and try | 1 (the description) |
| Template | 2 | 3: New app, template card, Create and try | 0 to 1 (name, if they change it) |
| Blank | 2 | 3: New app, Start blank, Create and try | 3 (name, description, instructions) |
| Duplicate | 1 | 2: Duplicate, Create and try | 0 |

### 3. Screen 1: Start

A page, not a modal. A page has a URL, survives reload, works with the browser's back button, and
has room on a phone.

```
 Admin > Apps > New app
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │  New app                                                    Step 1 of 2 · Start  │
 │                                                                                  │
 │  What should your app do?                                                        │
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ e.g. "Answer questions about our travel policy and name the section        │  │
 │  │ the answer comes from."                                                    │  │
 │  │                                                                            │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
 │  Try:  [Summarise a text in plain language]  [Draft a reply to a customer]       │
 │        [Translate and keep the tone]                                             │
 │                                                                                  │
 │  [ ✦ Create a draft ]   Takes about 20 seconds. You can change everything.       │
 │                                                                                  │
 │  ── or start from ─────────────────────────────────────────────────────────────  │
 │                                                                                  │
 │  Templates                                                       [Search…     ]  │
 │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐        │
 │  │ (i) Ask your  │ │ (i) Summarise │ │ (i) Translate │ │ (i) Write an  │        │
 │  │ documents     │ │ a text        │ │               │ │ email         │        │
 │  │ Answers from  │ │ Short, plain  │ │ Keeps tone    │ │ Asks for tone │        │
 │  │ uploaded files│ │ summaries     │ │ and format    │ │ and recipient │        │
 │  └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘        │
 │                                                                                  │
 │  [ Copy one of your apps ▾ ]     [ Start with an empty app ]                     │
 │                                                                                  │
 │  Need a link to a website or an embedded page instead?  Create a link app        │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

Behaviour:

- **Describe is first because it needs the least knowledge.** The example chips fill the text box;
  they do not submit.
- **Templates are a curated set**, shown as cards with the app's real icon and one line. No ID, no
  variable count. Review:215 asked for a curated gallery in `server/defaults`. If the gallery is
  not built in this round, this row is omitted and "Copy one of your apps" stays.
- **"Copy one of your apps"** opens a searchable list (name, description, icon). It lists every
  enabled app, which is the owner's decision of 2026-11-17. A disabled app can be copied with the
  row action "Duplicate" on the list.
- **"Create a link app"** opens the full editor with the type preset to redirect or iframe. These
  two types need a URL and no instructions, so screen 2 does not fit them.
- **No model configured.** The page checks this on load. The Describe box is then replaced by a
  notice, and the other starts stay available:

```
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ (!) No AI model is set up yet.                                             │  │
 │  │ Apps need a model to answer. You can prepare an app now, but you can only  │  │
 │  │ try it once a model exists.                                                │  │
 │  │ [ Set up a model ]  (admins)      or: Ask your iHub administrator.         │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
```

  A content admin cannot open the Models pages (`adminAuth`, server briefing §5). For them the
  notice shows the second sentence only.

- **Generating.** The button becomes "Creating your draft…" with a Cancel link. The text box stays
  readable. A polite live region announces start and end.

```
 │  [ ◌ Creating your draft… ]   Cancel                                             │
 │  Writing the instructions · choosing an icon · checking available tools          │
```

- **Generation failed.** The message names the cause and the next action. The description stays in
  the box. "Continue" never leads to an empty step.

| Cause (server `code`) | Message | Action |
|---|---|---|
| No default model | "No AI model is set up yet, so a draft cannot be created." | Set up a model / Fill in the form yourself |
| Model error or timeout | "The model did not answer. This is usually temporary." | Try again / Fill in the form yourself |
| Answer unusable | "The draft came back incomplete. We kept what was usable." | Opens screen 2 with the usable fields |
| Generator prompt missing | "The app generator is switched off on this installation." | Fill in the form yourself |

### 4. Screen 2: Essentials

One screen for all starts. Its heading and its top notice change with the start.

```
 Admin > Apps > New app
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │  ← Back                                                Step 2 of 2 · Essentials  │
 │                                                                                  │
 │  Check your draft                         (blank start: "Describe your app")     │
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ ✦ Drafted from your description. Also set up:                              │  │
 │  │   [Web search  ✕]  [2 input fields: Text, Tone  ✕]  [Tool: Jira  ✕]        │  │
 │  │   You can change these after creating the app.          Start over         │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
 │                                                                                  │
 │  ( ◉ )  Name *                                                                   │
 │  icon   ┌──────────────────────────────────────────────┐                         │
 │  Change │ Plain language summary                       │                         │
 │         └──────────────────────────────────────────────┘                         │
 │         Link: /apps/plain-language-summary   Edit                                │
 │                                                                                  │
 │  What it does *            Users see this on the app's tile.                     │
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ Summarises a text in plain language                                        │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
 │                                                                                  │
 │  Instructions for the assistant *                                                │
 │  Tell the assistant how to behave, as you would brief a new colleague.           │
 │  ┌────────────────────────────────────────────────────────────────────────────┐  │
 │  │ You rewrite the user's text in plain language. Keep all facts. Use short   │  │
 │  │ sentences. Answer in the language of the text.                             │  │
 │  │                                                                            │  │
 │  └────────────────────────────────────────────────────────────────────────────┘  │
 │                                                                                  │
 │  Model: Default model (Gemini Flash)   Change                                    │
 │  Written in English. You can add other languages after creating the app.         │
 │                                                                                  │
 │  The app starts unpublished. Only you and other admins can open it.              │
 │                                              [ Cancel ]   [ Create and try it ]  │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

Behaviour:

- **Three required fields.** Name, "What it does" (the schema's `description`) and the
  instructions. Everything else has a default.
- **The ID is derived from the name** while the user types ("Plain language summary" →
  `plain-language-summary`), shown as the link. "Edit" turns the line into a field with the format
  rule. Once the user edits the ID by hand, it stops following the name. Uniqueness is checked when
  the name field loses focus; a taken ID gets a suffix proposal: "This link is taken. Use
  `plain-language-summary-2`?"
- **Icon and colour** open the existing `IconPicker` and a small swatch palette. The native colour
  input stays behind "Custom colour".
- **"Also set up" chips** (AI and template starts) say in plain words what else is in the draft.
  The ✕ removes that part before creation. Without this strip, the generator can add tools that
  the author never sees (UX-F6).
- **Model** is one line of text with "Change". "Change" reveals a select. If the default model is
  missing, the line reads "No model set up yet" with the notice from screen 1.
- **Content language** is the UI language. There is no language select here. The sentence under
  the form says which language was used.
- **Template and Duplicate starts** show a different notice: "Copy of *Email composer*. Everything
  else was copied too: 5 input fields, file upload on." The name is prefilled as "Email composer
  (copy)", the ID as `email-composer-copy`. No parent link is written (Review:215, AI-B19).
- **"Start over"** returns to screen 1 with the description kept.
- **Leaving.** Back and Cancel with input ask once: "Discard this draft?" Reload restores the
  draft from session storage for this tab.
- **Validation.** On leaving a field and on submit. On submit with errors, focus moves to an error
  summary above the form; each entry is a link to its field. A server refusal (400 with
  `details.issues`) is mapped to the field by its `path`; an unmapped issue is shown in the summary
  with the server's `detail`.

### 5. Landing: the editor with Test open

`POST /api/admin/apps` creates the app with `enabled: false`. The browser goes to
`/admin/apps/<id>?created=1`.

```
 Admin > Apps > Plain language summary
 ┌─────────────────────────────────────────────────────────┬───────────────────────────┐
 │ (◉) Plain language summary      ● Not published         │ Try your app          ⟳ ✕ │
 │     [ Publish ]  Visible to: nobody yet    ⋮ More       │ Only admins see this.     │
 ├─────────────────────────────────────────────────────────┤───────────────────────────│
 │ ✓ Your app is ready to try.                             │                           │
 │   1. ☐ Send a test message  →                           │   Plain language summary  │
 │   2. ☐ Add suggested questions                          │   Summarises a text in    │
 │   3. ☐ Choose who can use it                            │   plain language          │
 │   4. ☐ Publish                               Hide       │                           │
 ├───────────────┬─────────────────────────────────────────┤                           │
 │ Find setting… │ ▾ Basics                                │                           │
 │               │   Name, What it does, icon, category    │                           │
 │ ESSENTIALS    │                                         │                           │
 │ • Basics      │ ▾ Instructions and inputs               │                           │
 │ • Instructions│   Instructions for the assistant        │                           │
 │ • Suggested   │   [..................................]  │                           │
 │   questions   │   Input fields (0)   + Add input field  │ ┌───────────────────────┐ │
 │               │                                         │ │ Paste a text…         │ │
 │ MORE OPTIONS  │ ▾ Suggested questions                   │ └───────────────────────┘ │
 │ • Model       │   + Add a suggested question            │                           │
 │ • Knowledge   │                                         │                           │
 │   and tools   │ ▸ Model            Default model        │                           │
 │ • Chat        │ ▸ Knowledge and tools   Web search off  │                           │
 │   features    │ ▸ Chat features    Export, feedback on  │                           │
 │ • Input and   │ ▸ Input and voice  Single line, mic on  │                           │
 │   voice       │ ▸ What users can change   4 of 4 on     │                           │
 │ • Users can   │                                         │                           │
 │   change      │                                         │                           │
 ├───────────────┴─────────────────────────────────────────┴───────────────────────────┤
 │ ● Unsaved changes                              [ Discard ]   [ Save ]   Ctrl+S      │
 └─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Focus** lands on the banner heading "Your app is ready to try". The checklist ticks itself:
  step 1 when a test message got an answer, step 2 when a suggested question exists, step 3 when
  access was opened, step 4 on publish. "Hide" removes the banner for this app.
- **The Test panel runs the unpublished app for admins.** Today it shows "This app is disabled…
  Enable it and save to test it" (`AppTestPanel.jsx:216-222`). That message must go. Without this
  change the whole flow ends in the same dead end as today, one screen later.
- **Unsaved edits.** The panel keeps the existing amber hint and restarts after save. The hint gets
  a button: "Save and try".
- **No model.** The Test panel shows the same notice as screen 1, not a disabled send button.

### 6. Publish

```
 ┌──────────────────────────────────────────────────────────────┐
 │  Publish "Plain language summary"?                        ✕  │
 │                                                              │
 │  ✓ Has a name, a description and instructions                │
 │  ✓ A model is available: Gemini Flash                        │
 │  ! You have not sent a test message yet.   Try it first      │
 │                                                              │
 │  Who will see it                                             │
 │  Everyone who is signed in  (groups: Users, Authenticated)   │
 │  Change who can use it                                       │
 │                                                              │
 │                         [ Cancel ]   [ Publish ]             │
 └──────────────────────────────────────────────────────────────┘
```

- Publishing sets `enabled: true` and saves. The header then reads "● Published" with "Unpublish"
  under "⋮ More".
- **"Who will see it" states today's facts.** It reads the groups that grant the app. It does not
  promise a restriction the product cannot enforce: "only these groups" is open owner decision 1.
  "Change who can use it" opens the existing group access section.
- The untested warning informs and does not block.
- I use "Published / Not published", not "Draft". "Draft" would promise that edits to a live app
  stay private until published, and they do not: saving a published app changes it for users at
  once. The save bar of a published app therefore says "Save. Users get the change immediately."

### 7. Editor information architecture

The grouping follows Review:193-202. I add what is open by default and the summary lines.

| Group | Section | Contains | Open by default | Summary when collapsed |
|---|---|---|---|---|
| Essentials | Basics | name, what it does, icon and colour, category; under "Details": ID (read-only), type, order | yes | – |
| Essentials | Instructions and inputs | instructions, input fields (variables), prompt template and start form under "Details" | yes | – |
| Essentials | Suggested questions | starter prompts, greeting, usage guide | yes | – |
| More options | Model | preferred model, allowed models, output format | no | "Default model" |
| More options | Knowledge and tools | web search, integrations, tools, workflows, apps as tools, skills, projects | no | "Web search off · 1 tool" |
| More options | Chat features | upload, export, compare, feedback, magic prompt, document template, AI notice | no | "Upload off · export, feedback on" |
| More options | Input and voice | input mode, microphone, voice | no | "Single line · microphone on" |
| More options | What users can change | the four `settings.*` switches | no | "4 of 4 on" |

Rules:

- **A section opens itself when it differs from the defaults or contains an error.** An author who
  switched web search on finds the section open next time.
- **The index is sticky on the left** and marks sections with an error dot or an unsaved dot.
  `AdminSettingsPage` already does scroll-spy and dirty dots (`AdminSettingsPage.jsx:11-27`).
  Below 1280 px with the Test panel open, the index becomes a "Jump to section" select above the
  form.
- **"Find setting…"** filters by label and help text and opens the matching sections. Browser
  search does not find text inside collapsed sections; this box replaces it.
- **Header.** Status and Publish on the left; Test is a toggle; Open app, History, Download and
  Duplicate move to "⋮ More". Today five equal buttons compete (screenshot `en-30`).
- **Save bar** is sticky at the bottom and appears while there are unsaved changes (`AdminSaveBar`
  exists). "Save & Exit" is dropped; the leave guard already covers leaving.
- **Form / JSON** moves to "⋮ More → Edit as JSON". It is an expert tool and today sits above the
  first field.
- **New-app validation.** No error is shown before the first input or the first save attempt
  (AI-B16).
- **Input fields (variables)** use plain type names: Short text, Long text, Dropdown, Date, Number
  (Review:314-326). The instructions field detects `{{name}}` and offers "Add an input field for
  *name*".
- **Group access** stays a section until owner decision 1 is taken. The header pill "Visible to: …"
  scrolls to it.

Not in this round, from my lens: a field for every JSON-only setting, a merged Model block with
status badges, and an "Improve with AI" action inside the editor.

### 8. Apps list

```
 Apps                                                      [ + New app ]   [ ⋮ ]
 Assistants your users can open.                                 ⋮ = Upload a config file,
 [Search…           ] [All categories ▾] [All ▾]                     Reorder, Enable all,
                                                                     Disable all
 Name                     Category   Status            Model
 (◉) Plain language summ. Utility    ○ Not published   Default (Gemini Flash)   Edit  ⋮
 (◉) Chat                 –          ● Published       Default (Gemini Flash)   Edit  ⋮
                                                         row ⋮ = Try, Open, Duplicate, Delete
```

Empty state (no apps): "No apps yet. An app is an assistant with a fixed task, for example
'Summarise a text'. [ + New app ]". Empty search: "No app matches '…'. Clear search".

### 9. Error and empty states, complete list

| Where | State | What the user sees |
|---|---|---|
| Screen 1 | No model | Notice from §3; other starts remain |
| Screen 1 | Templates fail to load | "Templates could not be loaded. Retry" in the template row; the rest works |
| Screen 1 | No templates, no apps | The two rows are hidden; Describe and Start empty remain |
| Screen 1 | Template search without match | "No template matches '…'." |
| Screen 1 | Generation fails | Table in §3 |
| Screen 2 | Required field empty | At the field, after blur or submit: "Give your app a name." |
| Screen 2 | ID taken | At the link line, with a proposal |
| Screen 2 | ID format wrong | "Use lowercase letters, numbers and hyphens." (never "required") |
| Screen 2 | Server refuses | Summary with links; field messages from `details.issues[].path` |
| Screen 2 | Session expired | "You were signed out. Your draft is kept in this tab. Sign in again." |
| Screen 2 | Copy source deleted meanwhile | "The app you wanted to copy no longer exists." Back to screen 1 |
| Editor | Test, no model | Notice, not a disabled send button |
| Editor | Test, unsaved | Hint with "Save and try" |
| Editor | Save refused | Error summary directly above the save bar, not between header and form |
| Publish | No model | Publish stays possible; the check line is a warning: "Users will see 'No models available'." |

### 10. Microcopy

Principles:

1. Say what the user gets, not what the system stores. "What it does", not "Description".
2. One term per thing, everywhere. The glossary below is binding for the creation flow.
3. Buttons name the result: "Create and try it", "Publish", "Save and try". Never "Next" as the
   last step, never "Finish".
4. An error says what happened and what to do, in one or two sentences. No "Network error" unless
   the network failed.
5. German: *Sie*, „…", "Benutzer" (Rework:172). Every string exists in `en.json` and `de.json`;
   no default text in code stands in for a missing key.
6. Help text sits under the label and is at most one sentence. Longer help is a docs link.

| Today | Creation flow and section titles | German |
|---|---|---|
| Create App | New app | Neue App |
| Choose App Template / Create from Scratch | Templates / Start with an empty app | Vorlagen / Mit leerer App beginnen |
| AI-Generated | Describe it ("What should your app do?") | „Was soll Ihre App tun?" |
| App ID | Link (editor: "ID") | Link (Editor: „ID") |
| Description | What it does | Was sie tut |
| System Instructions | Instructions for the assistant | Anweisungen für den Assistenten |
| Variables | Input fields | Eingabefelder |
| String / Text / Select / Boolean | Short text / Long text / Dropdown / Yes-No | Kurzer Text / Langer Text / Auswahlliste / Ja-Nein |
| Starter Prompts | Suggested questions | Vorgeschlagene Fragen |
| Preferred Model | Model | Modell |
| Enabled / Disabled | Published / Not published | Veröffentlicht / Nicht veröffentlicht |
| Clone | Duplicate | Duplizieren |
| User Settings | What users can change | Was Benutzer ändern können |
| Upload Config | Upload a config file | Konfigurationsdatei hochladen |

"Instructions for the assistant" touches open owner decision 11 ("System prompt" vs "System
instructions"). See "Decisions I took on my own".

### 11. Keyboard and screen reader

- **Pages, not overlays**, for both creation screens. Each has one `h1`. On a screen change, focus
  moves to the `h1` (`tabindex="-1"`), and the document title changes ("New app: Essentials").
- **Step indicator** is text ("Step 2 of 2 · Essentials") inside a `nav` with
  `aria-current="step"`. No numbered circles without labels.
- **Start options** are real buttons and links in reading order: text box, Create a draft,
  template cards, Copy, Start empty. Template cards are buttons whose accessible name is the title
  plus the one-line description.
- **Generation** is announced through a polite live region: "Creating your draft", then "Draft
  ready" or the error. `Ctrl/Cmd+Enter` in the text box starts generation. Escape cancels a running
  generation.
- **Errors.** Each field has `aria-invalid` and `aria-describedby` to its message. The summary is
  a region with `role="alert"` that receives focus on a failed submit.
- **Required fields** carry `required` and one visible asterisk with a legend "* required".
- **Collapsible editor sections** are buttons with `aria-expanded` and `aria-controls`; the summary
  line is part of the button's name. The index is a `nav` with `aria-current` on the section in
  view.
- **Dialogs** (Publish, Discard, icon picker) use the shared `Modal`, which traps focus, closes on
  Escape and returns focus to the opener.
- **Test panel** is a labelled `aside`. Opening it does not steal focus, except after creation,
  where the banner link "Send a test message" moves focus into the message box.
- **Shortcuts.** `Ctrl/Cmd+S` saves (exists, `E:385-394`). No single-letter shortcuts.
- **390 px.** Screens 1 and 2 are single-column; the action row is sticky at the bottom of the
  viewport inside the page, so it cannot leave its container. Targets are at least 44 px high.
  In the editor the Test panel is the existing full-screen dialog.
- **Motion.** The generating indicator respects `prefers-reduced-motion`.

### 12. What I need from other roles

| Need | Why the flow depends on it |
|---|---|
| Admins can chat with an app that has `enabled: false` | Otherwise "create unpublished, then try" is impossible (§5) |
| The new-app page learns whether a default model exists, also for content admins | No-model notice (§3) |
| Generation errors carry a registry `code` | Message table (§3) |
| The generated answer is validated before screen 2 | "We kept what was usable" (§3) |
| ID availability check, or an accepted 409 mapping to the field | Inline uniqueness (§4) |
| A curated template source | Template row (§3); the flow works without it |

### 13. Order of delivery, from the UX lens

1. `/admin/apps/new` as a page with screens 1 and 2; Blank and Copy starts; unpublished create;
   landing in the editor with Test open; delete the two modals. All entries point here.
2. Describe start on the same screen 2, with the "Also set up" strip and the error table.
3. Editor: index, collapsed sections with summaries, sticky save bar, header with status and
   Publish, errors only after input.
4. Publish dialog and checklist.
5. Template gallery; placeholder detection in the instructions; plain type names for input fields.

Slice 1 alone removes the dead end and the double question. Each later slice is usable on its own.

### 14. How we know it worked

A person who has never seen iHub gets the task "Make an app that summarises a text in plain
language and try it".

- They reach a first answer from their own app without help, in under three minutes, on an
  installation with a model.
- They never type an ID.
- On an installation without a model they can say why the app does not answer and whom to ask.
- With a screen reader and keyboard only, the same task succeeds.
- In the German UI no English string appears on the way.

## Pre-mortem

It is May 2027. The rework shipped, and app building is still called too complicated. These are
the stories I can imagine, with the cause and what prevents each one now.

**P1. "The new flow is nice, then you fall off a cliff."** Authors created apps in a minute and
landed in an editor that still showed 19 expanded sections. They closed the tab. *Cause:* the
creation flow shipped first and the editor rework was cut for time. *Prevention:* the landing state
(§5) belongs to slice 1: Test open, checklist, and at least the collapsed sections with the three
essentials open. Do not ship the short flow onto the old editor page.

**P2. "I cannot try my app."** The app was created unpublished, and the Test panel still said
"This app is disabled. Enable it and save to test it." Authors enabled the app to test it, so
every half-finished app was live. *Cause:* the server change for testing unpublished apps was
treated as optional. *Prevention:* treat it as a blocker for slice 1. If it cannot be built, do not
create unpublished; say so openly on screen 2 ("The app is visible to all users as soon as you
create it") and keep the Review's interim path.

**P3. "The AI made something, I do not know what."** Generated apps had web search on and a Jira
tool bound. Authors found out when the app posted a ticket in a test. *Cause:* screen 2 showed only
three fields, and the "Also set up" strip was dropped as a detail. *Prevention:* the strip is part
of the acceptance criteria for the Describe start. A generated tool binding that is not shown is a
defect.

**P4. "Where did the settings go?"** Experienced admins could not find upload settings, because
the section was collapsed and browser search found nothing. They asked for the old page back, and
a "classic editor" switch was added. Now there were two editors. *Cause:* collapsing without a
summary line and without "Find setting…". *Prevention:* summary lines, auto-open for non-default
sections, the filter box, and a test with two current admins before merge.

**P5. "Published" lied.** An author edited a published app, expected a private draft because the
status wording suggested one, and broke the app for 400 users. *Cause:* the word "Draft" in the
UI without draft behaviour behind it. *Prevention:* "Published / Not published" only; the save bar
of a published app says that users get the change immediately (§6).

**P6. The German version shipped half English again.** New screens were translated; the editor
sections kept English defaults in code. The owner's first click in German showed "Basic
Information". *Cause:* keys added for new components only; the baseline of missing keys was left
as it was. *Prevention:* every file touched in this rework reaches zero missing keys and leaves
the baseline (`tests/unit/client/translation-keys-baseline.json`). Walk the whole flow once in
German before review.

**P7. The describe box produced generic apps, and people stopped using it.** "Summarise a text"
gave a three-line system prompt no better than the template. *Cause:* one-shot generation with no
way to refine, and no example of a good description. *Prevention:* example chips that show the
level of detail that works; "Start over" keeps the description; measure how many generated drafts
are created unchanged versus abandoned. Add a refine box only if the numbers ask for it.

**P8. Non-technical users never saw any of this.** The flow was built for "normal users", but only
admins and content admins can open `/admin/apps`. The knowledge expert in the department still
had to ask IT. *Cause:* the question "who may create apps" was never put to the owner; the rework
improved the admin's flow and was announced as self-service. *Prevention:* ask now (first question
below). Design the two creation screens so that they do not depend on the admin frame, so a later
user-side entry can reuse them.

**P9. Keyboard users got stuck in the three-pane editor.** Index, form and Test panel produced a
tab order of 150 stops before the save bar. *Cause:* no skip links and no landmark structure.
*Prevention:* landmarks (`nav`, `main`, `aside`), a skip link "Skip to save", `Ctrl/Cmd+S`, and
collapsed sections (their content leaves the tab order). Add the editor to the axe spec and do one
keyboard-only walk.

**P10. The duplicate flow produced look-alikes.** Copies named "Email composer (copy)" piled up,
published by accident with the original's group access. *Cause:* duplicate copied `enabled` and
nobody renamed. *Prevention:* a duplicate is always unpublished; screen 2 puts the cursor in the
name field with the text selected.

## Questions I did not ask

Only the product owner or a customer can answer these. For each, I state what I assumed.

1. **Who is the "normal user"?** Today only admins and content admins can create apps. Should a
   regular user create apps for themselves or their team? *Assumed:* no change of permissions in
   this round; the flow serves content admins, and stays reusable outside the admin frame.
2. **May a new app start unpublished?** This changes today's behaviour, where a new app is live at
   once. *Assumed:* yes, for apps created through the UI. Apps created by API or file keep
   `enabled: true` by default.
3. **Is "audience" part of creating an app?** It depends on open decision 1 ("only these groups").
   *Assumed:* not in creation; Publish shows who will see the app and links to group access.
4. **Which label for the system prompt?** Open decision 11. *Assumed:* "Instructions for the
   assistant" in the creation flow.
5. **Which language should the content be written in?** The UI language of the author, the
   platform's default language, or both? What do users of another language see? *Assumed:* the UI
   language only, with a sentence saying so.
6. **Is there a curated template set, and who curates it?** Shipped defaults, the marketplace, or
   apps an admin marks as templates? *Assumed:* a small shipped set; without it the row is
   omitted.
7. **Should the describe start ask follow-up questions?** A short dialogue gives better apps and
   costs time and tokens. *Assumed:* one shot, plus "Start over".
8. **Do the current admins accept collapsed sections and a hidden JSON switch?** I have no session
   with real admins. *Assumed:* yes, if summaries and "Find setting…" exist.
9. **Is the content admin allowed to know that no model exists, and whom should the notice name?**
   *Assumed:* yes, with the neutral text "Ask your iHub administrator".
10. **Is mobile creation a real use?** *Assumed:* it must not break at 390 px, and it is not
    optimised beyond that.
11. **Must link and embed apps be creatable by non-technical users?** *Assumed:* no; they keep the
    full editor behind one link.
12. **May generation send installed integration names to the model for every content admin?** It
    does today. *Assumed:* unchanged; the security panelist owns this.

## Decisions I took on my own

| # | Decision | Alternative I rejected | Reversible |
|---|---|---|---|
| D1 | Creation is a page at `/admin/apps/new`, not a modal | A repaired modal wizard on the shared `Modal`. Rejected: no URL, no reload, cramped on phones, and it keeps two entry points alive | Yes |
| D2 | Two creation screens. W2 in the Review has four steps, three before creation | W2 as written, with a "Model and audience" step. Rejected: the model has a correct default, and audience depends on open decision 1. **This deviates from the Review's W2** | Yes; a third screen can be added |
| D3 | Describe is the first option on screen 1, with templates, copy and blank below | Four equal tiles. Rejected: a newcomer cannot choose between four unknown options; one text box needs no choice | Yes |
| D4 | All starts end in the same Essentials screen; the AI fills it in | A separate AI review screen or a chat-style builder. Rejected: a second copy of fields is what produced AI-B1, B5 and B6 | Yes |
| D5 | The ID is derived from the name and shown as a link | Keep the required ID field. Rejected: the first required field is the one a non-technical user understands least | Yes |
| D6 | New apps are created with `enabled: false`; "Published / Not published", never "Draft" | Keep `enabled: true`. Rejected: an untested app is live for all users. Also rejected: the word "Draft", because edits to a published app are live at once. **Changes today's behaviour and needs the owner's confirmation** | Yes; one default |
| D7 | No Simple/Advanced mode switch in the editor. Collapsed sections with summaries instead | A mode toggle, or tabs. Rejected: a toggle hides that settings exist; tabs were rejected in Review:332 | Yes |
| D8 | Three sections open by default: Basics, Instructions and inputs, Suggested questions | Everything collapsed, or the Review's order without defaults. Rejected: the author should see what they just wrote | Yes |
| D9 | "Save & Exit" and the bottom button row are replaced by a sticky save bar | Keep both buttons and make them sticky. Rejected: three actions for one job | Yes |
| D10 | Form/JSON, History, Download and Open app move under "⋮ More" | Keep five header buttons. Rejected: Publish and Test must stand out | Yes |
| D11 | Content language equals the UI language; the three language selects are removed from creation | One language select on screen 2. Rejected: one more question whose effect the author cannot judge | Yes |
| D12 | "Instructions for the assistant" in the creation flow, ahead of open decision 11 | Wait for the decision, or "System prompt". Rejected for the creation flow: a non-technical author does not know the term | Yes; a string |
| D13 | Variables, uploads, tools and access are not part of creation | A reduced variables step. Rejected: the wizard's reduced copy is the source of AI-B5 | Yes |
| D14 | Duplicate writes no parent link and always creates an unpublished copy | Keep `parentId` and the "Revert to parent" links. Rejected: no server code reads the link (AI-B19). Existing apps keep their stored fields | Yes |
| D15 | Link and embed apps skip screen 2 and open the full editor | A type selector on screen 1 (App Types concept, 2025-11-14). Rejected: it puts "Chat / Iframe / Redirect" in front of every newcomer | Yes |
| D16 | The untested-app warning in Publish informs and does not block | Block publishing until a test message was sent. Rejected: an admin importing a known-good app would be forced through a ritual | Yes |
| D17 | Publish states who will see the app and does not offer "only these groups" | A group picker in Publish. Rejected: with `*` grants the picker would promise a restriction that does not hold (decision 1 is open) | Yes |
| D18 | The draft of screens 1 and 2 is kept in session storage for the tab | A server-side draft. Rejected: needs a new server concept (decision 6 is open) | Yes |
