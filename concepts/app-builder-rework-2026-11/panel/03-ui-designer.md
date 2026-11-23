# Panel report 03: Senior UI Designer

Scope: the visual design of the new app creation flow and of the app editor, built from what the
codebase already has. Paths are relative to the repository root. `W` is
`client/src/features/apps/components/AppCreationWizard.jsx`, `T` is
`client/src/features/apps/components/AppTemplateSelector.jsx`, `E` is
`client/src/features/admin/pages/AdminAppEditPage.jsx`. Screenshots named below are in the
walkthrough folder of the reconnaissance (`walk/shots/`).

## Summary

The creation flow looks like a different product from the admin around it. The picker and the
wizard have no dark-mode class at all, use hand-written button classes, a purple button and a green
button that exist nowhere else, and a hand-built overlay whose footer leaves the dialog when a step
is tall. The editor uses the restyled admin fields, but it is one 8,352 px page of equal-weight
cards with the save buttons at the very bottom.

My proposal has three parts:

1. **Creation becomes a page, not a dialog.** One route, `/admin/apps/new`, with three short steps,
   a labelled step indicator and a sticky action bar. A page cannot lose its footer, works at
   390 px, and has room for German.
2. **A static preview card, not a live chat, during creation.** It shows the icon tile, name,
   description and input placeholder as users will see them. The real test stays where it is, in
   `AppTestPanel`, after the app exists.
3. **The editor gets the frame that already exists.** Section index and `AdminSaveBar` from
   `AdminSettingsPage`, collapsible section cards with a one-line state summary, the app's own name
   and icon in the header, and secondary actions in `MoreActionsMenu`.

Almost everything is reuse. I count five small components to build and three shared components to
repair (dark mode in `IconPicker` and `LoadingSpinner`, an optional message in `AdminSaveBar`).

## Findings

Each finding names the code or the screenshot it rests on.

**UI-1. The wizard overlay is hand-built and its footer escapes.** The panel is
`max-h-[90vh] flex flex-col` (`W:335`), but the child that should shrink is `flex-1 flex flex-col`
without `min-h-0` (`W:336`), so the scrolling body (`W:392`) never scrolls and the Back/Next row is
pushed out. Visible on desktop (`en-04b-step2-basic-required-errors`: Back and Next sit on the page
behind the dialog) and on mobile without any error (`en-43-mobile-step2-basic`). The shared `Modal`
(`client/src/shared/components/Modal.jsx:98-110`) already has the correct structure, a focus trap,
Escape and a dirty guard. Neither the wizard nor the picker uses it.

**UI-2. No dark mode in the creation flow.** `grep -c "dark:"` returns 0 for `W`, `T`,
`shared/components/IconPicker.jsx` and `shared/components/LoadingSpinner.jsx`. The dialogs are
`bg-white` with `text-gray-900` on a dark admin. Both files live under `features/apps`, outside the
scope of the class-hygiene ratchet (`tests/unit/client/admin-class-hygiene.test.jsx` counts only
`client/src/features/admin`), so nothing flags it.

**UI-3. Three off-system colours.** "Generate App" is `bg-purple-600` (`W:815`), "Finish App" and
finished steps are `bg-green-700` (`W:369`, `W:432`). The admin has one accent,
`bg-admin-accent` (`formStyles.js`, `PRIMARY_BUTTON_CLASS`). On the AI step two filled buttons
compete: a full-width purple one and an indigo "Next" that works without generating
(`de-14-ai-result`).

**UI-4. The step indicator carries no information.** Numbered circles without labels (`W:358-388`).
The count changes with the path (5, 6 or 7). There is no `aria-current`. At 390 px the connectors
shrink to 8 px dashes.

**UI-5. Template rows are a list, not cards, and show the wrong facts.** Each row shows a letter on
the app colour instead of the app icon (`T:147-152`), then "ID: chat" and "5 variables"
(`T:161-165`). The chevron-down suggests expanding (`T:167`). `AppCard` already draws the real icon
on the colour (`shared/components/AppCard.jsx:106-110`). In a fresh install 14 of the first rows
are the same indigo tile (`en-02-template-picker`), so colour does not help to tell them apart.

**UI-6. Errors are shown twice in two styles and one is wrong.** A red banner plus red borders and
red text on every required field (`en-04b`). The banner is a hand-written box (`W:396-405`);
`CALLOUT_CLASS.danger` exists for this.

**UI-7. The AI step has no designed states.** Generating is a disabled button. Failure is a banner
with a fixed wrong sentence (`W:753-757`). Success is a green box (`W:830-844`) and nothing
visibly changes. There is no skeleton, no cancel, no result.

**UI-8. The editor's two-column card wastes the width it needs.** Every section is
`md:grid md:grid-cols-3` with the title in column one (`app-form/BasicInfoSection.jsx:34-35`). The
breakpoint follows the viewport, not the column. With the Test panel open the form column is about
570 px, the title column still takes a third, and "App ID" is 160 px wide
(`en-34-editor-test-panel`). The header actions wrap into two rows there.

**UI-9. The editor header says "Edit App", not which app.** The name appears only in the breadcrumb
(`E:501-504`). Five outline buttons of equal weight follow (`E:513-593`). Three buttons with
hand-written classes sit at the bottom of the page (`E:657-698`), not sticky, although
`AdminSaveBar` exists.

**UI-10. Required fields show two asterisks.** "Name * *" and "Description * *" in
`en-30-editor-summarizer-viewport`: the section and `DynamicLanguageEditor` each add one.

**UI-11. Mixed controls for the same thing.** Native checkboxes in most sections, `Switch` in the
integration cards (briefing, section 2). A section's on/off control looks different from card to
card.

**UI-12. `IconPicker` is not ready for a narrow page.** Its grid is fixed `grid-cols-6`
(`IconPicker.jsx:175`); at 390 px each cell is about 55 px with a truncated label. No dark classes.

## Proposal

### 1. Creation flow: page layout

Route `/admin/apps/new`, inside `AdminLayout`. The main area already scrolls
(`AdminLayout.jsx:97`, `flex-1 overflow-y-auto`), so `sticky bottom-0` works there.

```
max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-28
 ├─ AdminBreadcrumb            Admin > Apps > New app
 ├─ h1  text-2xl font-semibold "New app"
 ├─ StepIndicator
 └─ lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8
     ├─ step body   (one card: bg-white dark:bg-gray-800 shadow-sm sm:rounded-lg px-4 py-5 sm:p-6)
     └─ PreviewCard (hidden below lg; lg:sticky lg:top-4)
sticky action bar (same look as AdminSaveBar)
```

The card classes are the ones the editor sections use (`BasicInfoSection.jsx:34`), so creation and
editor share one surface.

Steps, following W2 from the review:

| Step | Body |
|---|---|
| 1 Start | Four choice cards, then the content of the chosen one |
| 2 Essentials | Name, description, icon and colour, category, instructions |
| 3 Model and audience | Model select with status, visibility, then "Create" |

The fourth W2 step ("Create") is the primary button of step 3, not a screen.

### 2. Step indicator (build: `AdminStepIndicator`)

Start from the `<ol>` in `ModelsSetupStrip.jsx:72-97`: `h-6 w-6` circles, `text-xs font-semibold`,
check icon when done, label beside the circle.

- From `sm`: `flex flex-row gap-6`, circle plus label, `aria-current="step"` on the current one.
- Below `sm`: one line, "Step 2 of 3 · Essentials" (`text-sm font-medium`), over a 4 px bar
  (`h-1 rounded-full bg-gray-200 dark:bg-gray-700`, fill `bg-admin-accent`). German labels
  ("Modell und Zielgruppe") do not fit three across at 390 px.
- Done: `bg-admin-accent text-white` with the check. Current:
  `ring-2 ring-admin-accent text-admin-accent dark:text-admin-accent-fg-dark`. Upcoming:
  `border border-admin-control-border text-gray-600 dark:text-gray-400`. No green: green means
  "enabled" and "saved" in the admin (`Badge` tone `success`).
- Done steps are buttons. Upcoming steps are plain text, not disabled buttons.

### 3. Step 1: choice cards and the gallery

Four cards in `grid grid-cols-1 sm:grid-cols-2 gap-3`, as a radio group (`role="radiogroup"`, each
card `role="radio"`): Blank, From a template, Copy an existing app, Describe it (AI).

Card: `flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white
dark:bg-gray-800 p-4 text-left`. Hover `hover:border-admin-accent`. Selected
`border-admin-accent ring-2 ring-admin-accent dark:ring-admin-accent-fg-dark` plus a check icon top
right, so the state does not depend on colour. Icon in a `h-10 w-10 rounded-lg bg-indigo-50
dark:bg-indigo-900/30` tile. The AI card uses the `sparkles` icon in the same indigo; no purple.

Below the cards, the chosen option reveals its content in the same step:

- **Template or Copy:** search field (`INPUT_CLASS`, icon inside, `data-bare` not needed) and a
  grid `grid grid-cols-1 sm:grid-cols-2 gap-3` of app cards, capped with `max-h-[28rem]
  overflow-y-auto` from `sm` up and uncapped on phones (a scroll area inside a scrolling page traps
  the thumb).
- **AI:** see section 5.
- **Blank:** nothing; "Next" is enabled.

App card (build: `AppPickCard`, used for both template and copy):

- Tile `h-10 w-10 rounded-lg` in the app colour with `Icon name={app.icon}` in white, the pattern of
  `AppCard.jsx:106-110`. Not the first letter.
- Name `text-sm font-semibold line-clamp-1`, description `text-sm text-gray-600 dark:text-gray-400
  line-clamp-2 min-h-10` (the fixed two-line height is from `MarketplaceItemCard.jsx:147`; it keeps
  the grid rows even).
- One row of `Badge` (`size="sm"`): category in `neutral`, then at most two capability badges in
  `info`: "Asks questions first" (has variables), "Web search", "Uses documents". No ID, no
  variable count.
- No chevron. The whole card is the radio.

Empty and loading: three `animate-pulse motion-reduce:animate-none` placeholder cards while
loading; `AdminEmptyState` with two different texts for "no apps yet" and "nothing matches".

### 4. Step 2 and 3: fields

All fields use `LABEL_CLASS`, `INPUT_CLASS`, `HELP_CLASS` from
`features/admin/components/formStyles.js`. One column, `space-y-6`, `max-w-2xl`.

- **Name**: plain input. Under it, in `HELP_CLASS`, a quiet line "Address: …/apps/plain-summary"
  with a text button "Change". The ID input (`MONO_INPUT_CLASS`) appears only after "Change" or
  when the generated ID is taken. No "App ID" label in the default view.
- **Icon and colour**: one row. Left the live tile (`h-12 w-12 rounded-lg`), then `IconPicker`,
  then a swatch row (build: `ColorSwatchPicker`): eight `h-8 w-8 rounded-full` buttons as a radio
  group, selected with `ring-2 ring-offset-2 ring-admin-accent dark:ring-offset-gray-800`, plus a
  ninth "Custom" that opens the native colour input. `IconPicker` gets dark classes and
  `grid-cols-4 sm:grid-cols-6`.
- **Instructions**: textarea, 8 rows, `INPUT_CLASS`. Detected `{{placeholders}}` appear below as
  `Badge tone="accent"` chips with the sentence "Users will be asked for: topic, tone".
- **Model**: native select with `INPUT_CLASS`. When no model can be used, the select is replaced by
  `CALLOUT_CLASS.warning` with one link button "Set up a model". This is the dead end the
  walkthrough hit (`en-21-user-opens-new-app`); it must be visible before "Create".
- **Visibility**: two radio cards in the style of the choice cards: "Only me, until I publish"
  (creates the app disabled) and "Everyone who can use apps". The first is preselected.
- **Errors**: inline only, under the field, `text-sm text-red-700 dark:text-red-300` with
  `aria-describedby`, shown on blur or on "Next". On "Next" focus moves to the first invalid field.
  No banner for field errors. Server errors use `CALLOUT_CLASS.danger` above the action bar.

Action bar: the markup of `AdminSaveBar.jsx:23-27` (`sticky bottom-0 z-30 bg-white/95
dark:bg-gray-900/95 backdrop-blur-sm border-t`), with `SECONDARY_BUTTON_CLASS` "Back" on the left
and `PRIMARY_BUTTON_CLASS` "Next" or "Create and test" on the right. `flex flex-wrap gap-3`; on
phones the primary button is `w-full sm:w-auto` and comes first in DOM order after wrapping. One
filled button per screen.

### 5. AI path: five states

| State | What is drawn |
|---|---|
| Not available | The AI choice card stays selectable but shows `Badge tone="warning"` "Needs a model"; the revealed area is `CALLOUT_CLASS.warning` with a link to Models. Checked before the user types. |
| Idle | Textarea, 4 rows. Three example chips (`SECONDARY_BUTTON_CLASS`, `rounded-full`) that fill it. `PRIMARY_BUTTON_CLASS` "Draft the app" with the `sparkles` icon. |
| Generating | Button disabled with the spinner used at `E:673`. A `role="status"` line "Writing a draft. This can take up to a minute." A text button "Cancel". The preview card shows skeleton bars. Textarea read-only, not hidden. |
| Done | The flow moves to step 2 with the fields filled. Above them `CALLOUT_CLASS.info`: "Drafted by AI. Check the text before you create the app." and, as `Badge` chips, what the draft switched on: "Web search", "Jira (3 actions)". Buttons "Draft again" and "Discard draft". |
| Failed | `CALLOUT_CLASS.danger` with the server's `detail`, and one action that fits the `code`: "Try again", or "Set up a model". The description stays in the textarea. |

No green success box: success is that the fields are filled. "Next" is not offered on the AI
content until a draft exists or the user picks another start.

### 6. Preview card (build: `AppPreviewCard`)

Right column from `lg`, `lg:sticky lg:top-4`, heading "Preview" in `text-xs font-semibold uppercase
tracking-wide text-gray-600 dark:text-gray-400`.

- Wrapped in `data-surface="app"`, so the admin field restyle (`client/src/App.css:44-61`) does not
  touch the mock input; the same opt-out `AppTestPanel.jsx:108` uses.
- Top: the tile as on the start page (colour, icon, name `font-bold`, description
  `wrap-break-word`), the layout of `AppCard.jsx:104-120` rebuilt with plain markup. I do not
  import `AppCard`: it brings favourites and click handling.
- Below: a disabled mock of the chat input with the placeholder text, and the detected questions as
  chips.
- Caption in `HELP_CLASS`: "This is how the app appears in the list. You can try it after
  creating it."
- Below `lg` the column is hidden. The tile beside the icon picker (section 4) is the preview on
  phones.

It is deliberately not a chat. The Test panel runs saved apps only (briefing, section 7); a fake
chat here would promise something the page cannot do.

### 7. Editor

- **Frame**: the two-pane layout of `AdminSettingsPage.jsx:97-140`: index `hidden lg:block w-56`
  with `sticky top-4`, active item `bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700`, amber dirty
  dot. Seven groups from the review (Basics, Instructions and inputs, Model, Knowledge and tools,
  Chat features, Input and voice, What users can change). Below `lg` the index becomes a native
  `<select>` "Jump to section" pinned under the header.
- **Sections** (build: `AdminCollapsibleSection`): the existing card, with a header button
  (`flex w-full items-center justify-between`, `aria-expanded`) that holds the title, a one-line
  state summary in `text-sm text-gray-600 dark:text-gray-400` ("Off", "2 questions", "Web search,
  Jira") and a chevron. Basics and Instructions open by default; the rest closed. A section with an
  error opens itself and shows `Badge tone="danger"` with the count in its header and in the index.
  That is the condition under which collapsing is safe.
- **Section layout**: drop `md:grid-cols-3` inside sections. Title and description go on top, fields
  below in `grid grid-cols-1 @xl:grid-cols-2 gap-6` with `@container` on the form column. Tailwind 4
  (the project uses `@theme` in `client/tailwind.css`) ships container variants, so the layout
  follows the column and survives the Test panel.
- **Header**: tile `h-10 w-10` plus the app name as `h1`, the ID in `font-mono text-xs` under it.
  Right: a `Switch` with the label "Visible to users", `PRIMARY_BUTTON_CLASS` "Test", and
  `MoreActionsMenu` for Open app, History, Download. Below `sm`: name, switch, Test, menu; nothing
  wraps into a second row of buttons.
- **Save**: `AdminSaveBar`, rendered inside the form's scroll column (`E:476`,
  `lg:overflow-y-auto`), not at page level, so it does not run under the Test panel. It needs one
  additive prop: a message that replaces "You have unsaved changes" with "2 fields need attention"
  and a button that scrolls to the first one. "Save & Exit" goes away; the bar has Save and Discard.
- **One asterisk** per required label (UI-10) and `Switch` for every section on/off control
  (UI-11); native checkboxes stay for lists of options.

### 8. Component inventory

| Reuse as is | Repair (shared) | Build |
|---|---|---|
| `formStyles.js` classes, `Badge`, `Switch`, `Icon`, `Modal` (discard question only), `ConfirmDialog`, `AdminBreadcrumb`, `AdminEmptyState`, `AdminStatusNotice`, `AdminLoadError`, `AdminFormErrorSummary`, `MoreActionsMenu`, `AppTestPanel`, `DynamicLanguageEditor`, `AdminSettingsPage` index markup | `IconPicker` (dark mode, 4 columns on phones), `LoadingSpinner` (dark text), `AdminSaveBar` (optional message and action) | `AdminStepIndicator`, `AppPickCard`, `ColorSwatchPicker`, `AppPreviewCard`, `AdminCollapsibleSection` |

New files go under `client/src/features/admin/components/app-create/`, so the class-hygiene ratchet
covers them. `W` and `T` are deleted; their entries leave
`tests/unit/client/translation-keys-baseline.json` in the same change.

### 9. German and 390 px rules

- No fixed widths on buttons, cards or step labels. Rows of buttons are `flex flex-wrap gap-3`.
- Card titles `line-clamp-1`, descriptions `line-clamp-2`; headings `wrap-break-word`.
- Design every screen with the German string first. Examples: "Create and test" (15) becomes
  "Erstellen und testen" (20); "Model and audience" (18) becomes "Modell und Zielgruppe" (21);
  "Only me, until I publish" (24) becomes "Nur ich, bis ich veröffentliche" (31).
- At 390 px with `px-4` the content is 358 px wide: one column everywhere, swatches wrap to two
  rows, the icon grid has four columns.
- Controls keep the admin's `min-h-[36px]`; card targets are at least 56 px high.

### 10. Acceptance checks I would hold the implementation to

1. Every new screen in four screenshots: light and dark, 1440 and 390, in German.
2. `grep -c "purple\|green-700"` is 0 in the new files; no hand-written button class.
3. The class-hygiene baseline does not grow; the axe baseline does not grow.
4. At 390 px and at 1440 px with the Test panel open, no horizontal scrollbar and the primary
   button is fully inside the viewport.
5. With a validation error in a closed section, that section is open after "Save" and the bar names
   the count.

## Pre-mortem

It is May 2027. The rework shipped and failed. Eight ways it happened, from my lens.

**1. The new flow is white in dark mode.** Classes were copied from the old wizard to save time.
The old files had no `dark:` class and sat outside the ratchet. *Prevention:* new files live under
`features/admin`, use only `formStyles.js`, and check 1 above is a merge condition.

**2. German broke the layout.** Step labels overlapped at 390 px and "Erstellen und testen" pushed
"Zurück" onto a second line above it. English looked fine in every review. *Prevention:* German
first, the compact step line below `sm`, wrap-safe button rows, German screenshots in the PR.

**3. The preview was taken for the real thing.** Users saw a chat-like box, typed into it, and
filed bugs that the app does not answer. Others created an app and still met "No models available".
*Prevention:* the preview is a list tile plus a visibly disabled input with a caption; the model
warning is in step 3, before "Create".

**4. Collapsed sections hid the error that blocked Save.** The bar was disabled and nobody found
why; support told people to switch to JSON mode. *Prevention:* a section with an error opens
itself, carries a count badge in header and index, and the bar says how many fields need attention
and jumps to the first.

**5. The gallery became a wall of identical tiles.** Customers with 80 apps saw 80 cards, most of
them indigo with the chat icon. Nobody used templates; everybody chose Blank. *Prevention:* the
shipped templates get distinct icons and colours and come first under their own heading; own apps
sit behind "Copy an existing app" with search; capability badges give a second way to tell cards
apart.

**6. The sticky bar got in the way.** It ran under the Test panel on desktop, covered the last
field on phones, and jumped above the on-screen keyboard. *Prevention:* render it inside the form's
scroll column, keep `pb-28` on the content (as `AdminSettingsPage.jsx:86` does), and test with a
focused textarea at 390 px.

**7. A polished front door led into the old house.** Three calm steps ended on a 5,930 px page of
19 open cards. Users felt tricked, and the flow was blamed. *Prevention:* the editor frame (index,
collapsed sections, header, save bar) ships in the same release as the flow, or the flow waits.

**8. Generating looked like a hang.** A spinner in a button for 40 seconds. Users clicked again,
closed the tab, or got a layout jump when fields filled in. *Prevention:* the status line with an
honest duration, Cancel, skeleton in the preview, and a move to step 2 as the visible result.

**9. A third field style appeared.** The flow built its own field wrapper; the planned Tier 1-2
admin components (`AdminField`, `AdminButton`) arrived later with different spacing. *Prevention:*
build no field wrapper now. Use the class constants directly, so the later components replace
strings, not a parallel component.

## Questions I did not ask

1. Is there a brand palette for app colours, or may I pick the eight swatches? I assumed eight
   Tailwind 600 values that carry white text at 4.5:1.
2. Should the AI path have its own colour identity (the purple it has today, also used by Magic
   Prompt in the chat)? I assumed no: one accent in the admin.
3. Do customers theme the admin, or only the end-user side? I assumed the admin tokens
   (`admin-accent`) are fixed, as the owner's restyle decision says.
4. How many apps does a typical customer have: 20 or 200? The grid and its cap are designed for up
   to about 60 before search becomes the only way in.
5. Do admins really create apps on a phone? I designed 390 px to work fully, not to be elegant.
6. Is "Save & Exit" used? I removed it without usage data.
7. Will the shipped templates get their own artwork (distinct icons and colours), and who chooses
   them? The gallery depends on it.
8. Should the preview show the app in the customer's branding of the end-user side? I assumed a
   neutral tile.
9. Is the creation flow ever meant to be reachable for non-admins? If yes, it cannot live inside
   `AdminLayout`, and the page frame changes.
10. Does the owner accept "Only me, until I publish" as the preselected visibility? It changes the
    look of step 3 and depends on the open draft decision.

## Decisions I took on my own

| # | Decision | Alternative I rejected | Reversible |
|---|---|---|---|
| 1 | Creation is a full page at `/admin/apps/new` | Keep a dialog, rebuilt on `Modal` | Yes, the step bodies do not depend on the frame |
| 2 | The preview is a static tile, not a live chat | A live chat on the unsaved draft | Yes; a live preview can replace the card later |
| 3 | One accent: no purple for AI, no green for finished steps | Keep purple as the "AI" colour | Yes, class change only |
| 4 | Step indicator collapses to "Step 2 of 3" plus a bar below `sm` | Circles without labels at all widths | Yes |
| 5 | The ID is hidden behind "Change" under the name | Always show an "App ID" field | Yes |
| 6 | Eight colour swatches plus Custom | Native colour input only | Yes |
| 7 | Template and copy share one card; no ID and no variable count on it | Keep technical facts for admins | Yes |
| 8 | Editor sections collapse, with Basics and Instructions open | All open (today) or tabs (rejected by the review) | Yes, a default |
| 9 | Section layout switches from viewport breakpoints to container queries | Keep `md:grid-cols-3` | Yes, but it touches every file in `app-form/` |
| 10 | Secondary header actions move into `MoreActionsMenu`; "Save & Exit" is removed | Keep five buttons and three save buttons | Yes |
| 11 | New components live in `features/admin/components/app-create/`; the old two files are deleted | Restyle the old files in place | Deleting is reversible only through git |
| 12 | Repair `IconPicker`, `LoadingSpinner` and `AdminSaveBar` in shared code | Local copies for the new flow | Yes; the changes are additive, but they show on every page that uses them |
| 13 | No new field wrapper component; class constants only | Build `AdminField` now | Yes |
| 14 | Controls keep `min-h-[36px]` on phones | 44 px touch targets | Yes |

Decision 1 departs from nothing in the prior art: W2 names `/admin/apps/new` as the one entry
point. Decision 8 follows the panel resolution (sticky index and collapsed defaults, not tabs).
Decision 10 removes a button users may know; it is visible to admins and needs a release note.
