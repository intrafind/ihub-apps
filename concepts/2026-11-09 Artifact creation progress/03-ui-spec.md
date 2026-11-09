# Artifact Creation Progress: UI Spec (visual layer)

Issue: [intrafind/ihub-apps#3534](https://github.com/intrafind/ihub-apps/issues/3534) "Chat: show tool
call progress while the model streams tool arguments". Request that started this work: "improve our
artifact creation".

| | |
|---|---|
| Document | 03 UI spec (layout, spacing, type, colour, icons, motion, dark mode, responsive, component API) |
| Author role | UI (visual) designer |
| Date | 2026-11-09 |
| Status | Draft for reconciliation with the UX brief and the PM brief. **No source code was changed.** |
| Reads | `01-product-brief.md` (PM, in this folder). The UX brief is written in parallel; every place where this spec depends on a UX decision is listed in section 16 as an assumption (A1 to A12). |
| Numbering note | The PM brief reserved `03` for a test plan. This file was assigned `03-ui-spec.md` by the lead; rename one of them when the folder is tidied. |

How to read this: section 0 is the whole answer on one page. Sections 1 to 3 are context and the data
the visuals need. Sections 4 to 9 are the specification. Sections 10 to 12 are responsive, contrast
and wireframes. Sections 13 to 17 are for the developer who builds it (copy-paste classes, i18n,
checklist). A junior can implement release 1 from sections 4, 6, 7 and 13 alone.

---

## 0. Decisions at a glance

1. **Honest progress is a count-up plus a clock, not a bar.** The total size is unknown, so there is
   no percentage, no growing bar and no eased "fake" progress (a fake bar stalls at 90 percent, which
   is exactly the "hung" feeling we are removing). The size only ever goes up and the clock ticks once
   per second: two numbers that visibly change prove the run is alive on any provider.
2. **One motion per place: the spinner.** Everything else is text changing at 1 Hz. An indeterminate
   sweep bar is specified (section 8.3) but **held back** from release 1: with a size and a clock on
   screen it is a third liveness cue and adds motion (WCAG 2.2.2) for little gain.
3. **Active is accent, history is quiet.** While a call is `preparing` or `running` its icon is indigo
   and its label is the stronger gray-800/200. When it finishes the row goes back to the quiet gray that
   the activity list uses today. This is what stops the one-liner looking like a hung spinner: it is the
   only coloured, medium-weight thing on screen and it carries numbers.
4. **Reduced motion swaps the glyph, it does not freeze it.** Today the global reduced-motion rule
   (`App.css`) stills `animate-spin`, which leaves a static refresh arrow: that looks hung. We render a
   static clock (or light bulb) instead, by CSS only, and let the numbers carry the liveness.
5. **Size and clock live in exactly one place.** In the row of the active call when the list is open
   (the default while streaming), in the one-liner when the list is collapsed. Never in both: two
   moving copies of one number is noise.
6. **Repeat label is a small neutral chip, "again (2)"**, the same chip as the integration chip. Repeats
   are normal, so no amber, no warning icon. The first row stays unlabelled.
7. **The headline-only states ("The model is still working... 0:12", "Thinking...") are one new small
   component, `ModelWorkingLine`**, that replaces the three-dot fallback. `ToolActivity` keeps returning
   nothing when it has no rows.
8. **Release 1 needs no new CSS and no theme token.** Only Tailwind utilities that already exist. Two new
   files: `ActivityProgress.jsx` (`BusyIcon`, `ProgressMeta`, `AttemptChip`, helpers) and
   `ModelWorkingLine.jsx`.
9. **Artifacts panel: unchanged in release 1** (PM acceptance criterion AC-3). A pending row and a
   size-matched placeholder are specified for release 2 (section 9), plus one optional release 1
   exception: do not say "This chat has no files yet" while a file is being written.
10. **Every text/background pair in this spec meets WCAG AA in light and dark** (section 11). Meaning is
    never carried by colour alone: every state has text.

### State table (one line per state)

| State | Icon (motion ok, then reduced motion) | Colour (light / dark) | Motion | Meta |
|---|---|---|---|---|
| preparing, with size | spinner, then static clock | icon indigo-600 / indigo-400, label gray-800 / gray-200 | spin 1 s linear | `12 KB · 0:41` |
| preparing, no size | spinner, then static clock | same | spin | `0:41` only |
| running | spinner, then static clock | same | spin | none (as today) |
| completed | kind icon, gray | icon gray-500 / gray-400, label gray-800 / gray-200 (titled) | none | none |
| failed | `exclamation-circle` | icon red-500 / red-500, text red-600 / red-400 | none | last size, muted |
| stopped | kind icon, gray | gray-600 / gray-400 | none | last size, muted |
| repeat (2nd, 3rd...) | as the state it is in | chip: gray-600 / gray-300 text, gray-200 / gray-700 border | none | n/a |
| working line, waiting | spinner, then static clock | icon indigo, text gray-800 / gray-200 | spin | clock `0:12` |
| working line, reasoning | spinner, then static light bulb | same | spin | clock `0:12` |
| dropped call | row disappears at once, no exit animation | n/a | none | n/a |

### New components (all small)

| Component | Where | Purpose |
|---|---|---|
| `BusyIcon` | new file `ActivityProgress.jsx` | Spinner with a reduced-motion static twin; replaces the two inline `animate-spin` icons |
| `ProgressMeta` | same file | `12 KB · 0:41`, aria-hidden, tabular numerals, ticking clock |
| `AttemptChip` | same file | `again (2)` chip, shares the chip classes of `IntegrationChip` |
| `ModelWorkingLine` | new `ModelWorkingLine.jsx` | Headline-only "still working" and "Thinking..." line with a clock |
| `PendingArtifactRow`, `ArtifactWritingBlock` | release 2, inside `ArtifactsPanel.jsx` | Placeholder row and pane while a file is written |

---

## 1. Where this spec sits (vocabulary reconciliation)

The lead's brief, the PM brief and the code each name things slightly differently. This table is the
single translation. Use the left column in component props.

| UI name (props, this spec) | Lead brief | PM brief (wire) | Code today |
|---|---|---|---|
| `item.status === 'preparing'` | `preparing` | `tool/progress` phase `args` (until `args.ended`) | does not exist |
| `item.status === 'running'` | `running` | `tool/started` | `running` |
| `item.status === 'completed'` | `completed` | `tool/completed` | `completed` |
| `item.status === 'error'` (shown as "Failed") | `failed` | error on `tool/completed` or a closed preparing row | `error` |
| `item.status === 'stopped'` | `stopped` | run ended with the row open | `stopped` (mapped in `shared/run/toolActivity.js`) |
| `item.attempt` (integer, 1 = no label) | `attempt` | `occurrence`, only for qualifying calls (PM section 6) | does not exist |
| `item.progress.chars` | `progress.chars` | `argChars` (absolute, never decreases) | does not exist |
| `item.progress.elapsedMs` | n/a | `elapsedMs` (absolute) | does not exist |
| `item.progress.approxTokens` | `progress.approxTokens` | not used (PM section 13: KB, not tokens) | does not exist |
| `item.target` (optional file name) | n/a | PM item P8, "Should" | does not exist |
| `ModelWorkingLine phase="waiting"` | n/a | `model.waiting` frame (PM P4) | does not exist |
| `ModelWorkingLine phase="reasoning"` | `reasoning` | derived on the client from `run.thinking` | `message.thoughts` |

**Where the lead's brief and the PM brief disagree, this spec follows the PM brief:** size is shown in
KB (exact, locale formatted), not in tokens; the repeat label is `again (2)`, not an English ordinal.
`approxTokens` is supported by the formatter only as a fallback behind a flag (section 15); do not
enable it without telling PM.

---

## 2. What the code does today (facts that shaped the design)

All read from the repository on 2026-11-09. Re-check line numbers before relying on them.

1. `client/src/features/chat/components/ToolActivity.jsx`
   - Returns `null` when there are no rows (line 29). So a headline-only state cannot live in it
     without changing that rule; that is why `ModelWorkingLine` is separate.
   - `const open = expanded ?? loading;` (line 30): the list is **open while the answer streams** and
     collapses to the one-liner when the turn ends, unless the user clicked. So during a long
     preparing phase the user normally sees headline plus row, not the collapsed one-liner.
   - `running = items.some(item => item.status === 'running')` (line 37) and the headline comes from
     `runningHeadline` / `finishedHeadline`. Both need to treat `preparing` like `running`.
   - The busy spinner is `<Icon name="spinner" size="sm" className="shrink-0 animate-spin" />` in two
     places: the headline (line 52) and `StatusIcon` (line 177).
   - A titled row shows only the title, in `text-gray-800 dark:text-gray-200`
     (`item.titled`). The title is the tool definition's localised name (`toolDisplayOf`), for example
     "Create interactive web artifact". PM AC-1 keeps it that way.
   - Chips: `IntegrationChip` is `inline-flex items-center gap-1 px-1.5 rounded border border-gray-200
     dark:border-gray-700 text-gray-600 dark:text-gray-300`. Value chips (`ItemDetails`) are
     `px-1.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono break-all`.
   - Rail: `mt-1.5 ms-1.5 ps-3 border-s border-gray-200 dark:border-gray-700 space-y-2`. Detail lines
     under a row use `mt-1 ms-5`.
2. `ChatMessageList.jsx` line 204: the list is `role="log" aria-live="polite"`. **Any text that changes
   every second inside a message would be read out repeatedly.** All ticking text in this spec is
   `aria-hidden` for that reason (PM AC-14: start and end announced once).
3. `App.css` line 108 redefines `.animate-pulse` as a `blink` animation (opacity 0.2 to 1, 1.4 s). Do
   **not** use `animate-pulse` on text or for skeletons. It is used by the three-dot fallback.
4. `App.css` line 427: the global `prefers-reduced-motion` rule sets every animation to 0.01 ms and one
   iteration. `animate-spin` therefore ends as a static refresh arrow (decision 4 above).
5. `ChatMessage.jsx` (about line 750): the three-dot fallback shows when `!hasSearchStatus`. The
   `ModelWorkingLine` replaces it while it is on screen (same rule `SearchStatusIndicator` already
   follows: never two loaders on one message).
6. `ArtifactsPanel.jsx` is a modal dialog (`fixed inset-0 z-50`, `bg-white dark:bg-gray-800`), not a
   side pane: while it is open the chat is not visible. Its list is newest first
   (`ArtifactRepository.js` line 373 sorts `createdAt` descending), rows are 56 px high, the HTML
   preview is `h-[65vh]` (`ArtifactPreview.jsx` line 191) and the empty state reads "This chat has no
   files yet...".
7. The download card (`GeneratedFiles.jsx`) appears only after `tool/completed` (`runToMessage.js` builds
   it from `tool.files`). Unchanged.
8. Tailwind v4, configured in CSS: `client/tailwind.css` is shared by four entry points (main app, Office
   task pane, browser extension, Nextcloud embed), all of which render these components. Dark mode is
   `data-theme="dark"` on `<html>` (`@custom-variant dark`). Use `dark:` classes only. The indigo ramp is
   overridden to the v3 sRGB values; gray, red and amber are the v4 defaults (oklch). Contrast ratios in
   section 11 were computed from those exact values and agree with the table in `docs/accessibility.md`.
9. Icon names verified in `shared/components/Icon.jsx`: `spinner`, `clock`, `light-bulb`, `document-plus`,
   `wrench`, `exclamation-circle`, `stop-circle`, `chevron-down`, `link`, `sparkles`, `search`,
   `document-text`, `globe-alt`. Sizes: `xs` 12 px, `sm` 16 px, `md` 20 px, `lg` 24 px.
10. Only `en` and `de` locales ship; the components already use logical properties (`ms-`, `ps-`,
    `border-s`, `text-start`). Keep that so a host page with `dir="rtl"` still works.
11. `ImageUpload.css` has an indeterminate-bar keyframe (`upload-progress-indeterminate`) but it only
    loads with the upload chunk. Do not depend on it (relevant only if the optional sweep ships).

---

## 3. Inputs the visual layer reads

The client draws what the server sends (repo rule "Run Activity: the Server Decides, the Client Renders").
This is what the components below read. **Required** means the design breaks without it; **optional**
means the slot simply stays empty.

### 3.1 Row (`ActivityItem`) fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | `'preparing' \| 'running' \| 'completed' \| 'error' \| 'stopped'` | yes | `preparing` is new. `shared/run/toolActivity.js` must also map a still-`preparing` row to `stopped` when the run has finished (it does this for `running` today). |
| `id` | string | yes | **Must be the same `callId` from `preparing` through `completed`** (PM AC-3) so React keeps one row; a changing key would remount the row and flash. |
| `name` / `titled` | string / boolean | yes | The server's localised title. Layout assumes at most about 36 characters (section 10). |
| `attempt` | integer >= 1 | optional | Chip when `>= 2`. Server only sends it for qualifying calls. |
| `progress` | `{ chars?: number, elapsedMs?: number }` | optional | Absolute values. Missing `chars` = "preparing, no size". |
| `target` | string | optional | File name being written (PM P8). May appear mid-way; the slot just fills. |
| `activityKind` | `'create'` | optional | Only to pick the `document-plus` icon. Without it the row keeps `wrench`. See A9. |

### 3.2 Working line

`ModelWorkingLine` reads `phase: 'waiting' | 'reasoning'` and `elapsedMs` (absolute, from the server
frame for `waiting`; derived from the first hidden reasoning chunk for `reasoning`). The client keeps its
own stopwatch between frames.

### 3.3 The clock

Absolute `elapsedMs` from the latest frame is the anchor. Between frames the client adds the time since
that frame arrived (`performance.now()` difference, not `Date`, so a wrong system clock cannot matter).
Each new frame replaces the anchor. A reconnect therefore corrects the clock at the next frame (PM AC-6:
correct within 2 seconds). Tick once per second.

---

## 4. Component breakdown

Reuse first. Only two new files; everything else is a change to an existing component.

### 4.1 Existing components that change

| Component | File | Change |
|---|---|---|
| `ToolActivity` | `features/chat/components/ToolActivity.jsx` | Treat `preparing` as active (`running` flag, headline picker, `reverse().find`). Headline gets the active look (section 6) and, only while collapsed, `ProgressMeta`. Headline button gets a 24 px hit area and a focus ring. Replace the inline spinner with `BusyIcon`. No change to props: `{ activity, loading }`. |
| `ActivityItem`, tool branch | same | New two-column row (icon column, content column), `AttemptChip`, target chip, `ProgressMeta`. The `skill`, `search` and `fetch` branches keep their layout; a `preparing` row in those kinds renders exactly like `running` (only `StatusIcon` changes). |
| `StatusIcon` | same | `preparing` and `running` render `BusyIcon`. `error` and `stopped` unchanged. `fallback` icon becomes `document-plus` when `item.activityKind === 'create'`. |
| `IntegrationChip` | same | Extract its class string into a shared constant `CHIP` so `AttemptChip` matches it. No visual change. |
| `ItemStatus` | same | After the "Failed" / "Stopped" word, append the last known size (`ProgressMeta retained`). |
| `ChatMessage` | `ChatMessage.jsx` | Render `<ModelWorkingLine>` where the three-dot fallback sits today and **suppress the three-dot fallback while it shows**. |
| `GeneratedFiles`, `StreamingMarkdown`, `ChatInput` (stop button), `ApprovalCard`, `SearchStatusIndicator` | | **No change.** Stop stays exactly where it is; it is the user's pause/stop control for all motion here. |
| `ArtifactsPanel` | `ArtifactsPanel.jsx` | Release 2 (section 9), plus one optional release 1 exception. |
| shared `Badge` | | **Not used.** The row already uses border chips (`IntegrationChip`); a filled pill would be a second chip language in one row. |

### 4.2 New: `ActivityProgress.jsx` (`features/chat/components/ActivityProgress.jsx`)

Exports four small things. It is shared by `ToolActivity`, `ModelWorkingLine` and (release 2)
`ArtifactsPanel`, which is why it is not local to `ToolActivity.jsx`.

```ts
// BusyIcon: the one place that knows how "busy" looks.
type BusyIconProps = {
  size?: 'xs' | 'sm' | 'md' | 'lg';   // default 'sm' (16 px)
  tone?: 'accent' | 'neutral';        // accent = indigo (default), neutral = inherit
  staticIcon?: 'clock' | 'light-bulb';// glyph shown under prefers-reduced-motion, default 'clock'
  className?: string;
};

// ProgressMeta: "12 KB · 0:41". Always aria-hidden: the start and end are announced elsewhere.
type ProgressMetaProps = {
  chars?: number;                     // absolute argument size; hidden below 512
  elapsedMs?: number;                 // absolute anchor from the latest frame
  active?: boolean;                   // true = clock ticks; false = static (retained values)
  showClock?: boolean;                // default true; retained values pass false
  className?: string;
};

// AttemptChip: "again (2)". Renders nothing for attempt < 2.
type AttemptChipProps = { attempt?: number; className?: string };

// Helpers (pure, unit-testable)
formatSize(chars: number, language: string): string   // '' below 512 chars, else '8.2 KB' / '12 KB' / '1.4 MB', locale formatted (6.1)
formatClock(ms: number): string                       // 'm:ss', 'h:mm:ss' from one hour
useElapsed(anchorMs: number | undefined, active: boolean): number | undefined
```

`BusyIcon` renders **two** icons and lets CSS pick, so it reacts to a live OS setting change and needs
no `matchMedia` code:

```jsx
<>
  <Icon name="spinner" size={size} className={`shrink-0 animate-spin motion-reduce:hidden ${tone}`} />
  <Icon name={staticIcon} size={size} className={`hidden shrink-0 motion-reduce:inline-block ${tone}`} />
</>
```

Test impact: `tests/unit/client/tool-activity.test.jsx` mocks `Icon` as a `span` with `data-name`; a
`BusyIcon` is now two spans. Count with `getAllByTestId('icon').filter(...)` on `data-name`.

### 4.3 New: `ModelWorkingLine.jsx`

```ts
type ModelWorkingLineProps = {
  phase: 'waiting' | 'reasoning';
  elapsedMs?: number;     // anchor, see 3.3
  className?: string;
};
```

Renders one line, no button, no chevron, nothing to expand (section 6, state 8 and 9). Mount and
unmount are driven by the reducer (PM AC-6: gone as soon as visible output or a tool row appears).

### 4.4 Release 2 only: panel placeholders

`PendingArtifactRow` and `ArtifactWritingBlock`, both private to `ArtifactsPanel.jsx`. Props in section 9.

---

## 5. Tokens (semantic role to Tailwind class, light and dark)

No new tokens. These are the existing classes, named by role so the next person can find them.

| Role | Light | Dark | Used for |
|---|---|---|---|
| `activity.text.history` | `text-gray-600` | `dark:text-gray-400` | list container, finished headline (existing) |
| `activity.text.active` | `text-gray-800` | `dark:text-gray-200` | active label, working line text (matches today's titled-row label) |
| `activity.text.hover` | `group-hover:text-gray-900` | `dark:group-hover:text-gray-100` | headline label on hover |
| `activity.text.meta` | `text-gray-500` | `dark:text-gray-400` | size, clock, retained size |
| `activity.icon.active` | `text-indigo-600` | `dark:text-indigo-400` | `BusyIcon` accent |
| `activity.icon.history` | `text-gray-500` | `dark:text-gray-400` | finished kind icon (existing) |
| `activity.icon.failed` | `text-red-500` | `text-red-500` (both modes, existing) | failed icon |
| `activity.text.failed` | `text-red-600` | `dark:text-red-400` | "Failed" and the error text (existing) |
| `activity.chip` | `border-gray-200 text-gray-600` | `dark:border-gray-700 dark:text-gray-300` | integration chip, attempt chip |
| `activity.chip.value` | `bg-gray-100 text-gray-700` | `dark:bg-gray-800 dark:text-gray-300` | target (file name) chip |
| `activity.rail` | `border-gray-200` | `dark:border-gray-700` | timeline rail (existing) |

Spacing: existing values stay (`gap-1.5` = 6 px, `ms-1.5`, `ps-3`, `mt-1.5`, `space-y-2`, `ms-5`; they sit on
a 2 px sub-grid and every current row uses them, so mixing them with others would misalign rows). Every
**new** value is a multiple of 4 px (`gap-y-1`, `py-1`, `-my-1`, `p-8`) except hairlines (borders). Type:
everything is `text-xs` (12 px, line height 16 px), the size of the whole list today; the headline gets
`font-medium` while active. Radius: chips `rounded`, ghost tile (release 2) `rounded-md`.

Do not use: `text-gray-400` on light (2.60:1), `dark:text-gray-500` on dark (3.67:1), `text-gray-500` on
`bg-indigo-50` (4.33:1) or on `bg-gray-100` (4.39:1), `animate-pulse` on text.

---

## 6. States

Common to all row states: the row is one `<li>` (the key is the stable `callId`), `text-xs`, icon
column 16 px (`size="sm"`), 6 px gap, content column `min-w-0 flex-1`. Reading order in the DOM equals
visual order: icon, label, attempt chip, target chip, meta, status word.

### 6.1 Number formats (apply to every state that shows a size or a clock)

- **Size.** From `progress.chars`. Hidden while `chars < 512` (so the first second shows the clock alone,
  never "0 KB"). `< 10 KB`: one decimal (`8.2 KB`, German `8,2 KB`). `>= 10 KB`: whole number (`12 KB`).
  `>= 1024 KB`: `1.4 MB`. Format the number with `Intl.NumberFormat(i18n.language)`: PM AC-13 requires
  the German decimal comma, which the existing `formatBytes` in `utils/artifactFiles.js` does not do
  (keep its thresholds, add the locale; do not change `formatBytes`, other cards use it). The unit text
  (`KB`) is not translated. Never render a value smaller than one already shown (keep the maximum in a
  ref); the server already guarantees monotonic values, this guards a replayed frame.
- **Clock.** `m:ss` (`0:41`, `12:05`), `h:mm:ss` from an hour. Tabular numerals (`tabular-nums`) so the
  width does not shake each second.
- **Separator.** ` · ` (middle dot with spaces) inside one text node, as `finishedHeadline` already does.
  Wrap the whole meta in `<bdi>` so digits and a possible right-to-left sentence do not reorder.
- **Update rate.** The text changes at most once per second. **Never tween or count up smoothly**: a
  smooth counter implies a precision we do not have and is more motion.

### 6.2 State 1: preparing, with size

- **When.** `status === 'preparing'` and `progress.chars >= 512`.
- **Icon.** `BusyIcon` accent (spinner; static clock under reduced motion).
- **Label.** The tool title, `text-gray-800 dark:text-gray-200`, wraps inside its column, `break-words`.
  Titles are short by contract (A1, about 36 characters), so it normally takes one or two lines.
- **Chips.** Optional `AttemptChip`, optional target chip.
- **Meta.** `12 KB · 0:41`, `text-gray-500 dark:text-gray-400`, no wrap. Below 640 px it takes its own
  line, aligned with the label column (deterministic, never an accidental wrap).
- **Truncation.** Label wraps, chips and meta never truncate, the file name breaks anywhere (`break-all`).
- **Reads like.** EN `Create interactive web artifact [roi-calculator.html]  12 KB · 0:41`;
  DE `Interaktives Web-Artefakt erstellen [roi-rechner.html]  12 KB · 0:41`.
- **Motion.** Spinner rotates (Tailwind default `animate-spin`, 1 s linear). Text ticks at 1 Hz.
- **Reduced motion.** Spinner hidden, static clock glyph shown, same accent colour. The two numbers
  still change: they are the liveness cue.

### 6.3 State 2: preparing, no size

Same as state 1 with the size part absent: either the first second, or a provider that reports no size.
The meta is the clock alone (`0:41`, no leading separator). Nothing else changes, so the row neither
jumps when the size appears nor looks different on providers that cannot report it.

### 6.4 State 3: running

`status === 'running'` (arguments complete, tool executing; often milliseconds, a few seconds for a
document render). Same icon, same label and chips as above. **No meta**: size and clock disappear
(on a phone the row loses one line once, at this boundary; never per tick). No clock for running in
release 1, as today (optional extension, A10).

### 6.5 State 4: completed

Existing look, no animation, no "done" flash. Icon is the kind icon in `activity.icon.history`
(`document-plus` for `activityKind === 'create'`, else `wrench`). The label stays in the titled style.
Chips stay (the attempt chip and target chip are provenance). No size, no clock.

### 6.6 State 5: failed

`status === 'error'`. Icon `exclamation-circle` `text-red-500`; word "Failed" in `text-red-600
dark:text-red-400`; below, `ItemError` (existing: `mt-1 ms-5 text-red-600 dark:text-red-400 break-words
line-clamp-3`). New: after the word, the last known size in muted meta (`12 KB`, no clock), because a
failure during preparing (output limit, provider error) is explained by how far it got. Colour is never
the only signal: the word and the icon shape are there.

### 6.7 State 6: stopped

`status === 'stopped'` (user pressed Stop, or the run ended with the row open). Kind icon in the history
colour, word "Stopped" in the inherited gray-600/400 (existing), then the last known size in muted meta.
No red: the user did this on purpose.

### 6.8 State 7: repeat (attempt 2, 3, ...)

A separate row (PM AC-4). `AttemptChip` right after the label:

```jsx
<span className="inline-flex items-center px-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 whitespace-nowrap">
  {t('toolActivity.again', 'again ({{count}})', { count: attempt })}
</span>
```

Rules: only `attempt >= 2`; same look for 2, 3, 10 (neutral, not escalating; if UX wants a stronger cue
at 3 or more that is a copy/tone decision, A6); the earlier rows keep their completed look. In the
**headline** the same text follows the label as plain `shrink-0` text (`Create interactive web
artifact… again (2)`), because the headline has no chips. Plain integer in the string, so German needs
no ordinal (`erneut (2)`).

### 6.9 State 8 and 9: the working line

`ModelWorkingLine`. One line, same container as the activity headline, **not a button**, no chevron.

- Waiting: icon `BusyIcon staticIcon="clock"`, text `The model is still working…`, clock after it.
- Reasoning: icon `BusyIcon staticIcon="light-bulb"`, text `Thinking…`, clock after it (assumption A5: PM
  names no clock for thinking; layout works with or without).
- Colours: icon accent, text `font-medium text-gray-800 dark:text-gray-200`, clock `activity.text.meta`.
- Placement: where the three-dot fallback sits today (after the answer so far; with no answer yet it
  sits directly below `ToolActivity`). `mb-2`. It replaces the dots while visible.
- Truncation: wraps (`flex-wrap`), never truncates; the clock stays on the same line when it fits.
- Reduced motion: static clock or light bulb; the clock text is the cue.
- When both a finished `ToolActivity` summary and the working line are present they stack: history above,
  live below (`ToolActivity` has its own `mb-2`).

### 6.10 Dropped call

PM AC-5: a call that never ran and was dropped disappears. Remove the row in the same render that the
frame arrives, with no exit animation (also the reduced-motion answer). If it was the only row,
`ToolActivity` returns `null` again.

---

## 7. Collapsed one-liner versus expanded row

### 7.1 The one-liner (the `<button>` headline)

```
 slot  :  [icon 16] [label  min-w-0 truncate] [again (2) shrink-0] [meta shrink-0 (collapsed only)] [chevron 16]
 gap   :  6 px between slots (gap-1.5)
 height:  16 px content, 24 px hit area (py-1 -my-1: no layout shift)
 width :  inline-flex max-w-full (never wider than the message column)
```

- **While active (preparing or running):** icon is `BusyIcon` accent; label is `font-medium
  text-gray-800 dark:text-gray-200` with the existing hover darkening; text is the new `{{name}}…` for a
  titled row (for example `Create interactive web artifact…`; replaces the awkward `Running Create
  interactive web artifact`; copy is UX, A1). Untitled rows keep today's `Running {{name}}`.
- **Meta in the one-liner:** shown only when the list is **collapsed** (`!open`). When the list is open the
  row carries it. One rule, one place (decision 5).
- **While finished:** exactly today's headline and icon logic (`finishedHeadline`), in
  `activity.text.history`. Add: if any row failed, the icon becomes `exclamation-circle` `text-red-500`
  and the text ends with the failed count; if any row stopped, text ends with "stopped". Wording is UX.
- **What it reads like while preparing (it must not look hung):**

  | Moment | EN | DE |
  |---|---|---|
  | 0 to 1 s | `(*) Create interactive web artifact…  v` | `(*) Interaktives Web-Artefakt erstellen…  v` |
  | list collapsed, 41 s | `(*) Create interactive web artifact…  12 KB · 0:41  v` | `(*) Interaktives Web-Artefakt erstellen…  12 KB · 0:41  v` |
  | list open, 41 s | headline `(*) Create interactive web artifact…  ^`, the row below carries `12 KB · 0:41` | analogous |
  | no size, 90 s, collapsed | `(*) Create interactive web artifact…  1:30  v` | analogous |

  Checklist that makes it read as alive: it names the thing; two numbers change every second; the icon is
  the only indigo element in the message; the label is medium weight. If any one of these is missing in an
  implementation, it is a defect against decision 3.
- **Truncation:** the label truncates with an ellipsis and carries `title={headline}` for a mouse; on touch
  the open row shows the full text. The attempt text and the meta never truncate (`shrink-0`), the label
  gives way first.

### 7.2 The expanded row (tool branch)

```
 | [icon 16]  [ label (wraps) ] [again (2)] [ roi-calculator.html ]  12 KB · 0:41
 | column 1    column 2 (min-w-0 flex-1, flex-wrap, gap-x 6 px, gap-y 4 px)
 | (the leading | is the list rail, border-s)
```

- Two columns so a long label wraps inside its own column and the icon stays on the first line (the
  single `flex-wrap` row used by other kinds would drop a long label under the icon).
- Column 2 items in order: label, `AttemptChip`, target chip, `ProgressMeta`, `ItemStatus`.
- `ProgressMeta` below 640 px: `max-sm:basis-full` (own line, aligned with the label column). From 640 px:
  inline after the chips.
- Under the row, unchanged: `ItemDetails` (`mt-1 ms-5`) and `ItemError` (`mt-1 ms-5`). They keep their 20 px
  indent; the label column starts at 22 px (the same 2 px offset every row of this list already has).
- Rows are separated by the existing `space-y-2` (8 px). Two preparing rows at once (PM caps it at two)
  each carry their own meta.

### 7.3 Layout stability (no jumps)

- Per tick nothing changes height: meta is `whitespace-nowrap`, tabular, and on phones already on its own line.
- Jumps happen only at state boundaries and only once: meta leaves at `running` (up to 20 px on a phone,
  the answer text normally starts right after); a dropped row leaves the list; the download card appears
  after `completed` exactly as today.
- The row key is the `callId`, so `preparing`, `running`, `completed` update one `<li>`.

---

## 8. Motion

### 8.1 Spec

| Element | Motion | Timing | Reduced motion |
|---|---|---|---|
| `BusyIcon` (rows, headline, working line) | rotate | Tailwind `animate-spin`, 1 s linear, infinite | spinner `motion-reduce:hidden`, static glyph `motion-reduce:inline-block` |
| Size and clock text | text swap | at most 1 Hz, no tween, no fade | unchanged (not motion) |
| Chevron (existing) | rotate 180 degrees | `transition-transform` | add `motion-reduce:transition-none` |
| Row appear / disappear | none | instant | n/a |
| Completed | none, no check flash | n/a | n/a |

The global rule in `App.css` also shortens every animation under reduced motion; the swap in `BusyIcon`
is what makes the result correct instead of merely still.

### 8.2 Why this treatment (and why not the alternatives)

- **Spinner plus count-up plus clock.** The size only ever grows and the clock ticks, so both are true.
  On providers that burst (Anthropic) or are slow (a local model at 30 tokens per second) the size can sit
  still for several seconds; the clock keeps the row demonstrably alive (PM risk R6).
- **Not a determinate or "determinate-ish" growing bar.** There is no denominator. Any curve that
  approaches 100 percent asymptotically is a fabricated percentage, and it stalls near the end, which looks
  like a hang. Rejected outright.
- **Not a skeleton or shimmer on the label.** Gradient text via `background-clip: text` has no reliable
  contrast guarantee and vanishes in forced-colours mode.
- **Not `animate-pulse`.** The app redefines it as a 0.2 to 1 opacity blink; text blinking is hostile to
  readers and to WCAG 2.3.1 spirit.

### 8.3 Held back: the indeterminate sweep (optional, not in release 1)

If dogfooding shows the one-liner is still missed in peripheral vision, add a 2 px sweep under the
headline: a one-third-width indigo segment sliding across a track, 1.6 s ease-in-out, fading in after 2 s
(so fast calls never show it), `motion-reduce:hidden`, decorative (`aria-hidden`), one per
`ToolActivity`. It is the same idea as `upload-progress-indeterminate` but must not import that file.
Needs a `@theme` addition in `client/tailwind.css` (shared by all four entry points):

```css
@theme {
  --animate-sweep: sweep 1.6s ease-in-out infinite;
  --animate-sweep-in: sweep-in 200ms ease-out 2s both;
  @keyframes sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
  @keyframes sweep-in { from { opacity: 0; } to { opacity: 1; } }
}
```

```jsx
<div aria-hidden="true" className="mt-1 ms-5 h-0.5 w-32 max-w-full overflow-hidden rounded-full bg-indigo-100 dark:bg-indigo-900/40 animate-sweep-in motion-reduce:hidden">
  <span className="block h-full w-1/3 rounded-full bg-indigo-500 dark:bg-indigo-400 animate-sweep" />
</div>
```

Contrast (non-text, 3:1): segment indigo-500 on track indigo-100 3.63; dark indigo-400 on the dark track
5.12. Reserve its 6 px of height from the moment the headline is active so it does not shift the list when
it fades in. If an RTL locale ever ships, add a mirrored `sweep-rtl` keyframe (`translateX(100%)` to
`translateX(-300%)`) and select it with the `rtl:` variant; flipping the segment with a transform is not
enough, the travel direction has to reverse.

---

## 9. Artifacts panel: does a "being written" placeholder earn its place?

**Verdict: not in release 1; in release 2 as a small, size-matched placeholder; plus one optional release
1 exception.** PM acceptance criterion AC-3 says the Artifacts panel behaves exactly as today in release 1
and the live preview is a release 2 ladder (R2a streams text into the Code tab). This section is the visual
spec for that ladder so R2a does not need a redesign.

### 9.1 Why it is not needed in release 1

- The panel is a modal dialog opened on demand; the user waits in the chat, where the row now answers
  "is it alive". Opening the panel mid-wait is an edge case.
- The file does not exist until `tool/completed` (the list comes from the artifact store). A placeholder
  needs the panel to read run state, plus a matching rule between the placeholder and the stored file.
  That is plumbing for little first-release value.

### 9.2 The one release 1 exception worth asking PM for (optional)

If the user does open the panel while a file is being written, the empty state says "This chat has no
files yet." That is false in that moment. A one-line fix, no placeholder: when a row is `preparing` or
`running` for a `create` call and the list is empty, show instead "A file is being created. It appears
here when it is finished." (copy: UX) with a `BusyIcon neutral`. Treat as a "Should", PM decides; it
touches `ArtifactsPanel` copy only and needs the pending state from `messages`, which the panel already
receives.

### 9.3 What earns its place in release 2

| Option | Decision | Reason |
|---|---|---|
| Status text in the empty state (9.2) | yes, release 1 optional | Fixes a false statement at almost no cost |
| **Pending row** at the top of the list | **yes, release 2** | List is newest first, so the new file lands at index 0: the row is replaced in place. Same 56 px as a real row, so nothing moves |
| **Size-matched writing block** in the preview pane | **yes, release 2** | Reserves the exact frame the preview will use; becomes the host for the R2a code stream |
| Skeleton that imitates the page layout | **no** | We do not know the layout; drawn structure would be invented. An HTML artifact cannot be rendered half-written in the sandboxed iframe |
| Live HTML in the iframe while writing | **no** | PM section 3: security review item, out of scope |
| Ghost download card in the chat | **no (v1 and v2)** | Would duplicate the row's size and clock in a second place; the real card appearing is itself the "done" signal |

### 9.4 Pending row (release 2)

Same box model as a real row (`ArtifactsPanel.jsx` list item), so the swap changes nothing in height:

```jsx
<li className="flex items-center gap-2 px-3 py-1.5" data-testid="artifact-pending-row">
  <span className="h-4 w-4 flex-none" aria-hidden="true" />{/* spacer where the checkbox is */}
  <div className="flex-1 min-w-0 flex items-center gap-2 rounded-md p-1">
    <span className="flex-none flex items-center justify-center w-8 h-8 rounded-md border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300">
      <BusyIcon tone="neutral" />
    </span>
    <span className="min-w-0">
      <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100" title={name}>{name}</span>
      <span className="block truncate text-xs text-gray-600 dark:text-gray-300 tabular-nums">
        <ProgressMeta ... />{/* already aria-hidden */}
      </span>
    </span>
  </div>
</li>
```

Height: `py-1.5` (12) + `p-1` (8) + 36 (20 line plus 16 line) = 56 px, identical to a real row. `name` is
`item.target` when the server sent it, else the row title. Not a button, not selectable, never takes focus,
no checkbox. Colours: ghost tile glyph gray-600 on gray-50 7.23:1; dark gray-300 on the tile 8.41:1.

### 9.5 Writing block in the preview pane (release 2)

Shown when the pane has nothing selected (no earlier file). If the user is looking at another file the pane
stays on it; the block never steals the selection. Two sizes, chosen from the **file extension** of
`item.target` through the existing `previewTypeOf({ name })` (a file-name rule the panel already uses, not
a tool-id rule):

| Target type | Block | Why |
|---|---|---|
| `html`, `pdf` (real preview is a fixed `h-[65vh]` frame) | `h-[65vh]` | Same frame as the iframe it becomes, no jump |
| anything else or unknown (Office files show a one-line "no preview") | compact, `py-12` | Real result is a short line; a tall block would collapse on arrival |

```jsx
<div className="mb-3 min-h-9" />{/* the toolbar row of the real preview, empty, keeps 36 px */}
<div role="status" className="flex h-[65vh] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-300 dark:border-gray-600 p-8 text-center">
  <BusyIcon size="lg" tone="neutral" />
  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-all">{name}</p>
  <p className="text-xs text-gray-600 dark:text-gray-300">It appears here when it is finished.</p>
</div>
```

### 9.6 Transition into the real preview (no layout jump)

1. The panel shows the two-column shell whenever a pending item exists, **even with zero stored files**
   (otherwise the empty paragraph to two-column switch is itself a jump).
2. The pending row stays until the stored item with the same `runId` and name is listed (the panel already
   re-lists once after 1.5 s, see `RELIST_DELAY_MS`). In one render the pending row is removed and the real
   row inserted at index 0 with a 150 ms fade (`motion-safe:animate-fade-in`, see below).
3. If the writing block was showing, `previewId` is set to the new file (today the code falls back to
   `list[0]`, which is the new file anyway because the list is newest first; keep it that way and add a
   test). The block's dashed border becomes the preview's solid border inside the same `h-[65vh]` frame;
   the toolbar row fills the 36 px that was reserved.
4. Wrap fixed-height previews (`html`, `pdf`) of `ArtifactPreview` in `min-h-[65vh]` so the short
   "Loading preview..." line sits in a reserved box instead of collapsing and then jumping (an existing
   jump that this transition would otherwise expose).
5. Call ends without a file (stopped, failed, dropped): remove the row and the block; with no files the
   existing empty paragraph returns. No toast.

Release 2 CSS addition (only if the fade ships; `client/tailwind.css` `@theme`):

```css
--animate-fade-in: fade-in 150ms ease-out both;
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
```

Accessibility: the pending row and block are static text; the size and clock are `aria-hidden`. Whether a
polite announcement fires when the file lands is UX's call (the panel already has a status region).

---

## 10. Responsive, long strings, RTL, dark mode

### 10.1 Widths

The message column is 328 px at a 360 px viewport (`p-4` on the message list). Inter at 12 px averages
about 6.5 px per character (the figures below are estimates; verify in the browser).

| Width | Headline region (after icon, chevron and gaps: column minus 44 px) | Row content column (column minus 19 px rail, minus 22 px icon) |
|---|---|---|
| 360 px | about 284 px, about 43 characters | about 287 px, about 44 characters |
| 640 px and up | one line for all realistic strings | meta moves inline |
| 320 px | reflows, no horizontal scroll (docs/accessibility.md promises this) | same |

### 10.2 Stress strings

| String | Where | Expected at 360 px |
|---|---|---|
| `Create interactive web artifact…` (32) | headline, open | fits |
| `Interaktives Web-Artefakt erstellen…` (36) | headline, open | fits (about 234 px of 284) |
| German title plus `erneut (2)` (10, `shrink-0`, about 65 px) | headline, open | label truncates after about 28 characters with an ellipsis; `title` shows the rest; the row shows it all |
| same, list collapsed, plus meta `12 KB · 0:41` (about 78 px) | headline, collapsed | label truncates after about 17 to 19 characters. Accepted: it needs a collapsed list, a repeat, a phone and German at once. The first thing it still shows is the spinner and the numbers |
| 55-character file name `Q3-Umsatzprognose_Vertrieb_final_v2_mit_Anmerkungen.docx` | row chip | breaks across two lines (`break-all`), nothing overflows |
| Title wrapping to 3 lines | row | icon stays on line 1 (two-column row), chips and meta follow below |
| `12:05` clock, `1.4 MB` | meta | tabular numerals, no wrap |

### 10.3 Touch and focus

- Headline hit area is 24 px high (`py-1 -my-1`), meeting WCAG 2.5.8 without moving anything.
- Focus ring on the headline button: `focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500
  rounded-sm` (same pattern as `GeneratedFileCard`). The working line, rows and chips are not focusable.
- Nothing in this spec moves focus on a state change.

### 10.4 Right to left

No RTL locale ships, but keep it correct: logical utilities only (`ms-`, `ps-`, `text-start`,
`border-s`), separators inside translated strings, `<bdi>` around file names and the meta so digits stay
intact, chevron rotation is direction independent. If the optional sweep ships, mirror it with `rtl:`.
Test once by setting `dir="rtl"` on `<html>` in devtools.

### 10.5 Dark mode

Class-based only (`dark:` with `data-theme="dark"`). The chat sits on `bg-white dark:bg-gray-900`; the
panel on `bg-white dark:bg-gray-800`. Dark accent is `indigo-400` (not `600`, which would be 2.82:1 on
gray-900). Dark meta is `gray-400` (not `500`).

### 10.6 Forced colours and print

- Forced colours: icons use `currentColor` and survive; any background-only decoration (the optional sweep,
  the ghost tile fill) may vanish and is decorative by design; text carries every meaning.
- Print: `ChatMessage.css` already hides buttons inside messages, so the headline button disappears on
  paper; unchanged. The rail and rows print as plain text.

---

## 11. Contrast (WCAG 2.2 AA: 4.5:1 text, 3:1 non-text)

Ratios computed from the real palette (Tailwind v4 default gray/red/amber converted from oklch to sRGB;
indigo is the v3 override from `client/tailwind.css`). Page surface: `white` / `gray-900`. Panel surface:
`white` / `gray-800`.

| # | Element | Light (fg on bg) | Ratio | Dark (fg on bg) | Ratio | Needs | Result |
|---|---|---|---|---|---|---|---|
| 1 | Finished headline and list text | gray-600 on white | 7.56 | gray-400 on gray-900 | 6.82 | 4.5 | pass |
| 2 | Active label, working-line text | gray-800 on white | 14.67 | gray-200 on gray-900 | 14.33 | 4.5 | pass |
| 3 | Hovered label | gray-900 on white | 17.75 | gray-100 on gray-900 | 16.13 | 4.5 | pass |
| 4 | Meta: size, clock, retained size | gray-500 on white | 4.84 | gray-400 on gray-900 | 6.82 | 4.5 | pass |
| 5 | Active icon (`BusyIcon`) | indigo-600 on white | 6.29 | indigo-400 on gray-900 | 5.95 | 3 | pass |
| 6 | Finished kind icon | gray-500 on white | 4.84 | gray-400 on gray-900 | 6.82 | 3 | pass |
| 7 | "Failed" and error text | red-600 on white | 4.77 | red-400 on gray-900 | 6.14 | 4.5 | pass |
| 8 | Failed icon | red-500 on white | 3.81 | red-500 on gray-900 | 4.66 | 3 | pass |
| 9 | Attempt chip text | gray-600 on white | 7.56 | gray-300 on gray-900 | 12.05 | 4.5 | pass |
| 10 | Target chip text (on chip fill) | gray-700 on gray-100 | 9.36 | gray-300 on gray-800 | 9.96 | 4.5 | pass |
| 11 | Panel pending name (release 2) | gray-900 on white | 17.75 | gray-100 on gray-800 | 13.33 | 4.5 | pass |
| 12 | Panel pending meta and hint | gray-600 on white | 7.56 | gray-300 on gray-800 | 9.96 | 4.5 | pass |
| 13 | Ghost tile glyph | gray-600 on gray-50 | 7.23 | gray-300 on `gray-700/50` over gray-800 (about `#2a3546`) | 8.41 | 3 | pass |
| 14 | Optional sweep (non-text) | indigo-500 on indigo-100 | 3.63 | indigo-400 on `indigo-900/40` (about `#1d214c`) | 5.12 | 3 | pass |

Decorative borders carry no information (the text beside them does), so they are exempt from 1.4.11: chip
border gray-200 on white is 1.24:1, the dashed ghost border gray-300 on white is 1.47:1.

Rejected combinations (do not introduce): `text-gray-400` on white 2.60; `dark:text-gray-500` on
gray-900 3.67; `text-gray-500` on `bg-indigo-50` 4.33 (the selected panel row, so its meta stays
`text-gray-600`); `text-gray-500` on `bg-gray-100` 4.39; indigo-600 on gray-900 (2.82, hence `indigo-400`
in dark mode).

---

## 12. Wireframes

Legend: `(*)` busy icon, rotating, indigo. `(c)` static clock glyph under reduced motion. `(+)`
document-plus icon, gray. `(g)` globe icon, gray. `(!)` exclamation-circle, red. `v` closed chevron, `^`
open (rotated) chevron. `[..]` chip. `|` the list rail. Sizes are exact KB, not tildes.

### 12.1 Moment 1: preparing, no size (desktop, first seconds, list open)

```
 (*) Create interactive web artifact…                                  ^
  |
  |  (g) Searched for [berlin weather]   5 results
  |  (*) Create interactive web artifact  [roi-calculator.html]   0:03
```

If the provider never reports a size, this is how the row stays for the whole wait (clock only):

```
  |  (*) Create interactive web artifact   1:30
```

### 12.2 Moment 2: preparing, with size

List open (default while streaming):

```
 (*) Create interactive web artifact…                                  ^
  |
  |  (g) Searched for [berlin weather]   5 results
  |  (*) Create interactive web artifact  [roi-calculator.html]   12 KB · 0:41
```

List collapsed by the user (meta moves up to the one-liner):

```
 (*) Create interactive web artifact…   12 KB · 0:41                   v
```

360 px, German, list open:

```
 (*) Interaktives Web-Artefakt erstellen…   ^
  |
  |  (*) Interaktives Web-Artefakt
  |      erstellen  [roi-rechner.html]
  |      12 KB · 0:41
```

### 12.3 Moment 3: running (arguments complete)

```
 (*) Create interactive web artifact…                                  ^
  |
  |  (g) Searched for [berlin weather]   5 results
  |  (*) Create interactive web artifact  [roi-calculator.html]
```

Size and clock are gone; the spinner stays until `tool/completed`.

### 12.4 Moment 4: repeat attempt

```
 (*) Create interactive web artifact…  again (2)                       ^
  |
  |  (+) Create interactive web artifact  [roi-calculator.html]
  |  (*) Create interactive web artifact  [again (2)]  [roi-calculator.html]   3.1 KB · 0:19
```

The first row is the quiet completed look; the second carries the chip and its own size and clock.

### 12.5 Moment 5: finished and collapsed

```
 (g) Searched the web · 1 search · 5 results · 2 tool calls            v

 +----------------------------------------------------------------------+
 | [</>]  roi-calculator.html                  Open >   Share   Download |
 |        18 KB                                                         |
 +----------------------------------------------------------------------+
```

The one-liner is the quiet gray history line (unchanged); the download card is the unchanged
`GeneratedFileCard`.

### 12.6 More states

Working line, waiting (no tool row yet, provider with no early signal), replaces the three dots:

```
 (*) The model is still working…  0:12
```

Working line, reasoning, with the existing thoughts toggle above it:

```
 Show thinking analysis
 (*) Thinking…  0:07
```

Failed during preparing (output limit), with the last size:

```
 (!) 1 tool call failed                                                v
  |  (!) Create interactive web artifact  [roi-calculator.html]  Failed  11 KB
  |      The model reached its output limit before it finished.
```

Stopped by the user during preparing:

```
 (+) 1 tool call · stopped                                             v
  |  (+) Create interactive web artifact  [roi-calculator.html]  Stopped  8.2 KB
```

Reduced motion, same moment as 12.2: every `(*)` above is `(c)`; the numbers still tick.

Release 2 panel, pending (list newest first, preview pane showing the block):

```
 Artifacts                                                          [x]
 --------------------------------------------------------------------
  [ ]  (c) roi-calculator.html            |   (toolbar row, empty, 36 px)
          12 KB · 0:41                    |  +- - - - - - - - - - - - - -+
  [ ]  [</>] older-chart.html             |  :                          :
          6 KB · Answer 1 · 09.11.        |  :    (*)  roi-calculator.html
                                          |  :    It appears here when  :
                                          |  :    it is finished.       :
                                          |  +- - - - - - - - - - - - - -+
```

---

## 13. Tailwind recipes (copy-paste)

Names are for orientation; keep existing class order where a class already exists.

```jsx
// Shared chip (extract from IntegrationChip; AttemptChip uses it too)
const CHIP =
  'inline-flex items-center gap-1 px-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300';

// Root: unchanged
<div className="mb-2 text-xs text-gray-600 dark:text-gray-400">

// Headline button: existing + hit area + focus ring + group for the label hover
<button
  type="button"
  className="group inline-flex items-center gap-1.5 max-w-full py-1 -my-1 rounded-sm text-start hover:text-gray-900 dark:hover:text-gray-200 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
  ...
>
  {active ? <BusyIcon /> : <Icon ... className="shrink-0 text-gray-500 dark:text-gray-400" />}
  <span
    title={headline}
    className={`min-w-0 truncate ${active ? 'font-medium text-gray-800 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-gray-100' : ''}`}
  >
    {headline}
  </span>
  {attempt > 1 && <span className="shrink-0 whitespace-nowrap">{againText}</span>}
  {!open && active && <ProgressMeta className="shrink-0" ... />}
  <Icon name="chevron-down" size="sm"
        className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
</button>
```

```jsx
// Tool row (preparing, running, completed, failed, stopped): two columns
<li>
  <div className="flex items-start gap-1.5">
    <StatusIcon item={item} fallback={item.activityKind === 'create' ? 'document-plus' : 'wrench'} />
    <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="text-gray-800 dark:text-gray-200 break-words" title={item.toolId}>{item.name}</span>
      <AttemptChip attempt={item.attempt} />                     {/* CHIP + whitespace-nowrap */}
      {item.target && (
        <span className="inline-flex min-w-0 max-w-full px-1.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono break-all">
          <bdi>{item.target}</bdi>
        </span>
      )}
      <IntegrationChip item={item} />
      <ProgressMeta chars={item.progress?.chars} elapsedMs={item.progress?.elapsedMs}
                    active={item.status === 'preparing'}
                    className="max-sm:basis-full" />               {/* null unless preparing */}
      <ItemStatus item={item} />                                 {/* + retained size on failed/stopped */}
    </div>
  </div>
  <ItemDetails item={item} />
  <ItemError item={item} />
</li>
```

```jsx
// ProgressMeta
<span aria-hidden="true" className={`whitespace-nowrap tabular-nums text-gray-500 dark:text-gray-400 ${className}`}>
  <bdi>{[size, clock].filter(Boolean).join(' · ')}</bdi>
</span>

// BusyIcon accent tone
const ACCENT = 'text-indigo-600 dark:text-indigo-400';

// ModelWorkingLine
<div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-600 dark:text-gray-400">
  <BusyIcon staticIcon={phase === 'reasoning' ? 'light-bulb' : 'clock'} />
  <span className="font-medium text-gray-800 dark:text-gray-200">{text}</span>
  <ProgressMeta elapsedMs={elapsedMs} active />
</div>
```

Failed and stopped keep the existing classes (`ItemStatus`, `ItemError`); only the retained size is new
(`<ProgressMeta chars={...} active={false} showClock={false} />`).

---

## 14. CSS and theme changes

- **Release 1: none.** Every class above exists in Tailwind v4. No new `.css` file, no `@theme` token, no
  keyframes.
- **Release 1 optional sweep (section 8.3) and release 2 fade (section 9.6):** `@theme` additions in
  `client/tailwind.css`, which all four entry points import. Do not add them to a component-level CSS file
  that only one entry loads.
- Any new `.css` file would need the two-line SPDX header (repo rule; CSS has no `--single-line`, compact
  the generated `/* */` block to two lines).

---

## 15. Copy needed (layout test strings; final wording is the UX brief's)

Keys live in `shared/i18n/en.json` and `de.json` under `toolActivity.*` (PM AC-13). These are the strings
this spec was sized with. Sizes and clocks are never part of a translated string (they are formatted
values), so German needs no special case.

| Key | EN | DE | Notes |
|---|---|---|---|
| `toolActivity.working` | `{{name}}…` | `{{name}}…` | Headline for an active titled row |
| `toolActivity.again` | `again ({{count}})` | `erneut ({{count}})` | Chip and headline suffix; plain integer, no ordinal |
| `toolActivity.waiting` | `The model is still working…` | `Das Modell arbeitet noch…` | `ModelWorkingLine waiting` |
| `toolActivity.thinking` | `Thinking…` | `Denkt nach…` | `ModelWorkingLine reasoning` (existing `pages.appChat.thinking` uses three dots; use the ellipsis character like the other `toolActivity` strings) |
| screen-reader start and end text | UX | UX | Slot: a visually hidden `<span className="sr-only">` next to the row; UX writes the strings (AC-14) |

Optional token fallback (off by default, only if PM reverses the KB decision): `toolActivity.sizeTokens`
`~{{size}} tokens` / `~{{size}} Tokens`, with `Intl.NumberFormat` compact notation. Not specified further.

---

## 16. Assumptions to reconcile (UX and PM)

| # | Assumption | Depends on | If it changes |
|---|---|---|---|
| A1 | The row title is the tool definition's localised name (PM AC-1), e.g. "Create interactive web artifact". The headline uses `{{name}}…`. A progressive verb ("Creating web artifact…") would have to come from the server per status | UX copy, server | Label slot is plain text; no layout change |
| A2 | The ticking size and clock are `aria-hidden`; start and end are announced once through the existing polite log (PM AC-14). UX owns the strings and whether to add a "still working" nudge after a long time | UX | `sr-only` slot already exists in the layout |
| A3 | The clock shows immediately on a preparing row (it only exists for long calls: PM sections 5 and 6), and on the working line from first display. No threshold on the row | UX | Add a threshold prop to `ProgressMeta` |
| A4 | Size is KB from `argChars`, not tokens (PM section 13) | PM | Section 15 fallback |
| A5 | `ModelWorkingLine` shows a clock for reasoning too (PM names none) | UX | Drop `ProgressMeta` in that branch |
| A6 | The repeat chip is neutral for every attempt number | UX | Add a tone prop to `AttemptChip` for `>= 3` |
| A7 | While `waiting` or `reasoning`, the three-dot fallback is suppressed; during the first 3 seconds the dots remain | UX, PM | Hide dots from the first moment, or keep them under the line |
| A8 | Failed and stopped rows keep the last size, muted | UX | Remove the retained `ProgressMeta` |
| A9 | The server may send `activityKind: 'create'` only to choose the `document-plus` icon. Without it the row keeps `wrench` and everything else works. If `kind` becomes `create`, `finishedHeadline` must count it with the tool calls and `isPlain` must include it | PM, server | Icon stays `wrench` |
| A10 | `running` rows get no clock in release 1 (as today). A slow `running` call (an MCP tool at 40 seconds) would benefit; enabling it is one prop (`showClockWhenRunning`, clock after 5 seconds) | PM | Optional |
| A11 | The Artifacts panel is untouched in release 1 (AC-3); section 9 is release 2 plus one optional exception | PM | Pull 9.2 into release 1 |
| A12 | While the list is open the row carries size and clock, the headline does not; collapsed, the headline carries them | UX | Show in both, or only in the row |

---

## 17. Implementation checklist for whoever builds it

Repo rules from `CLAUDE.md` that apply here: new `.jsx`/`.js` files carry the two-line SPDX header; run
`npm run lint:fix && npm run format:fix` before committing; every user-visible string in both `en.json`
and `de.json`; a release note in `docs/releases/next/` through the `/document-feature` skill; the client
renders what the server sends and infers nothing from a tool id.

1. Add `features/chat/components/ActivityProgress.jsx` (`BusyIcon`, `ProgressMeta`, `AttemptChip`,
   `formatSize`, `formatClock`, `useElapsed`). Unit-test the pure helpers: sizes at 511, 512, 8 192,
   10 240, 1 048 576 chars in `en` and `de`; clocks at 0, 59, 60, 3 599, 3 600 seconds.
2. Add `ModelWorkingLine.jsx`; wire it in `ChatMessage.jsx`; suppress the dots while it shows.
3. Change `ToolActivity.jsx` as in section 4.1 (headline, tool row, `StatusIcon`, `ItemStatus`, `CHIP`).
4. Extend `shared/run/toolActivity.js`: `preparing` status, `attempt`, `progress`, `target`,
   `activityKind: 'create'`; map a still-`preparing` row to `stopped` when the run is over; keep the
   `callId` stable.
5. Strings in `shared/i18n/en.json` and `de.json` (section 15).
6. Tests: extend `tests/unit/client/tool-activity.test.jsx` (the `Icon` mock now yields two spans per
   `BusyIcon`; add cases for each state in section 6, the attempt chip, a dropped row, the collapsed
   one-liner carrying the meta, the open list carrying it in the row, both locales). Add an e2e check with
   `page.emulateMedia({ reducedMotion: 'reduce' })` that the spinner is not displayed and the static glyph
   is, and keep the axe baseline in `tests/e2e/accessibility.spec.js` green with a preparing row on screen.
7. Manual QA matrix: light and dark, 360 px and 1024 px, reduced motion on and off, `en` and `de`, a 55
   character file name, a 36 character German title with a repeat, `dir="rtl"`, forced colours, 200 percent
   text zoom, keyboard only (the headline button is the only tab stop; Enter and Space toggle).
8. Docs: add a short "Activity list" note to `docs/ui.md` (states and the active-versus-history rule).

### Do not

No percentage, no growing bar, no eased progress. No `animate-pulse` on text. No amber or warning icon
for a repeat. No per-tick announcements. No smooth counting. No colour-only status. No new CSS file in
release 1. No change to `GeneratedFiles`, `ChatInput` or the stop button.

### Out of scope here (listed so nobody adds it by accident)

Stall detection ("no output for 30 seconds", PM P11), live artifact preview (PM R2 and later), browser
tab title or favicon progress, sound, notifications when the tab is hidden, workflow and agent run pages.
