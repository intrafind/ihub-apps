# Artifact Creation Progress: UI Spec (visual layer)

Issue: [intrafind/ihub-apps#3534](https://github.com/intrafind/ihub-apps/issues/3534) "Chat: show tool
call progress while the model streams tool arguments". Request that started this work: "improve our
artifact creation".

| | |
|---|---|
| Document | 03 UI spec (layout, spacing, type, colour, icons, motion, dark mode, responsive behaviour, component API) |
| Author role | UI (visual) designer |
| Date | 2026-11-09 |
| Status | Draft for review by the UX designer and product management. **No source code was changed.** |
| Reads with | `01-product-brief.md` (PM: scope, slices, wire format) and `02-ux-brief.md` (UX: states, copy, accessibility behaviour). This spec was first drafted in parallel with the UX brief and then reconciled with it (section 1.2). Where the two disagree, the UX brief owns behaviour and copy; this spec owns colour, icon, spacing, motion and layout. |
| Numbering note | The PM brief reserved `03` for a test plan and the UX brief suggests the technical design becomes `03`. Renumber when the folder is tidied. |

How to read this: section 0 is the whole answer on one page. Sections 1 to 3 are context and the data the
visuals read. Sections 4 to 10 are the specification. Sections 11 to 13 are responsive behaviour,
contrast and wireframes. Sections 14 to 17 are for the developer (copy-paste classes, CSS, open items,
checklist). A junior can build release 1 from sections 4, 6, 7 and 14.

---

## 0. Decisions at a glance

1. **Honest progress is a count-up in KB plus a clock, never a bar.** The total size is unknown, so there is
   no percentage, no growing bar and no eased "fake" progress (a fake bar stalls near the end, which is
   exactly the "hung" feeling we are removing). The size only grows, the clock ticks once per second: two
   numbers that visibly change prove the run is alive on any provider. Same decision as PM and UX.
2. **One motion per place: the spinner.** Everything else is text changing at 1 Hz. An indeterminate sweep
   bar is specified (section 8.3) and **held back**: with size and clock on screen it is a third liveness
   cue and more motion (WCAG 2.2.2) for little gain.
3. **Active is accent, history is quiet.** While a call is `preparing` or `running`, or the headline shows
   an idle or approval label, the icon is indigo and the label is the stronger gray-800/200. Finished
   rows return to the quiet gray the list uses today. This is what makes the one-liner read as alive
   instead of a hung spinner. (This is a visual-layer addition; the UX brief asks only for contrast, see
   section 1.2, item V1.)
4. **Reduced motion swaps the glyph, it does not freeze it.** The global reduced-motion rule in `App.css`
   stills `animate-spin` and leaves a static refresh arrow, which looks hung. `BusyIcon` shows a static
   clock (or light bulb) instead, by CSS only; the numbers carry the liveness.
5. **Headline and active row show the same facts** (UX section 5), from one shared clock so they tick in
   sync. In the headline the facts are a `shrink-0` suffix (` · 12 KB written · 0:41`); in the row they are
   their own line under the label (`mt-1 ms-5`, the indent `ItemDetails` already uses).
6. **Repeats are neutral.** A chip, "Attempt 2" or "No. 2" (UX section 7), in the same chip style as the
   integration chip; an explanation line under the row; "3 problems found" in amber with a triangle icon.
   No red, no "again".
7. **One status line.** The idle states ("Thinking…", "Still working…") live in the `ToolActivity` headline
   slot, in a headline-only mode when there are no rows (UX F3 and section 8). No separate component.
8. **New states get quiet, distinct looks:** `awaiting` (amber shield, no motion), `ready` (static clock,
   muted), `stalled` (a gray caption), `failed` (red icon plus the reason sentence), `stopped` (gray
   sentence, no red because the user chose it).
9. **Release 1 needs no new CSS and no theme token.** Only Tailwind utilities that already exist. Two new
   client files, `ActivityProgress.jsx` and (UX) `RunAnnouncer.jsx`; this spec owns only the first.
10. **Artifacts drawer: no placeholder** (UX section 5 and PM AC-3). Reasons and one optional empty-state
    line in section 9.
11. **Every text and background pair meets WCAG AA in light and dark** (section 12). Colour never carries a
    state alone: every state has words.

### State table (one line per state)

| State | Icon (motion ok, then reduced motion) | Colour (light / dark) | Motion | Progress line |
|---|---|---|---|---|
| preparing, with size | spinner, then static clock | icon indigo-600 / indigo-400; label gray-800 / gray-200 | spin 1 s linear | `12 KB written · 0:41` |
| preparing, no size | spinner, then static clock | same | spin | `0:41` |
| ready (arguments done, a parallel call still writing) | static clock | gray-500 / gray-400 | none | `12 KB written · ready to run`, no tick |
| awaiting approval | `shield-check` | amber-700 / amber-400, label gray-800 / gray-200 | none | none |
| running | spinner, then static clock | as preparing | spin | none |
| completed | kind glyph (by `outputKind`), gray | gray-500 / gray-400; label gray-800 / gray-200 | none | none; optional problems line |
| failed | `exclamation-circle` | icon red-500 / red-500; text red-600 / red-400 | none | last size, static, then the reason sentence |
| stopped | kind glyph, gray | gray-600 / gray-400 | none | last size, static, then the sentence |
| repeat (occurrence 2, 3, ...) | as the state it is in | chip gray-600 / gray-300, border gray-200 / gray-700 | none | explanation line when the reason is known |
| stalled (20 s without growth) | unchanged | caption gray-600 / gray-400 | none | caption under the progress line |
| idle, thinking | spinner, then static light bulb | icon indigo; text gray-800 / gray-200, medium | spin | clock `0:07` |
| idle, waiting | spinner, then static clock | same | spin | clock `0:12` |
| between calls (summary with spinner) | spinner, then static clock | icon indigo; text gray-600 / gray-400 | spin | none |
| stopping (3 s after Stop) | spinner, then static clock | as idle | spin | none |

### New and changed components (all small)

| Component | Where | Purpose |
|---|---|---|
| `BusyIcon` (new) | `features/chat/components/ActivityProgress.jsx` | Spinner with a reduced-motion static twin; replaces the two inline `animate-spin` icons |
| `ArgumentProgress` (new, name from UX 13.3) | same file | `12 KB written · 0:41`, aria-hidden, tabular numerals, clock from a shared `useNow` |
| `useNow` (new, from UX 13.3) | same file | One shared 1 s interval that runs only while some row is active |
| `RowChip` (new, tiny) | same file | The chip look shared by the integration chip and the "Attempt n" / "No. n" chip |
| `ActivityHint` (new, name from UX 13.4) | same file or own file | Gray caption lines (stalled, long wait) |
| `ToolActivity`, `ActivityItem`, `StatusIcon`, `ItemStatus`, `ItemError` | `ToolActivity.jsx` | Changed, see section 4.1 |
| `ChatMessage` | `ChatMessage.jsx` | Three-dot fallback stands down; reduced-motion fix for it |

---

## 1. Reconciliation with the PM and UX briefs

### 1.1 Vocabulary (use the UX and PM names in code)

The task brief for this spec used `attempt`, `progress.chars`, `progress.approxTokens`, `reasoning` and the
state name `failed`. The PM and UX briefs chose other names; this table is the single translation.

| Task-brief name | Name in code and in this spec | Source |
|---|---|---|
| `preparing` | `status: 'preparing'` | PM 8.3 (`tool/progress` phase `args`), UX 3.1 |
| `running` | `status: 'running'` | `tool/started` |
| `completed` | `status: 'completed'` | `tool/completed` |
| `failed` | UI word "Failed"; data value `error` today, UX proposes `failed` | UX 3.1 |
| `stopped` | `status: 'stopped'` | `shared/run/toolActivity.js` |
| (none) | `status: 'awaiting'`, flags `ready`, `stalled` | UX 3.1 |
| `attempt` | `occurrence` (number), `reason`, `issueCount`, `previousCallId` | PM section 6, UX 7 |
| `progress.chars` | `argBytes` (absolute, never decreases) | PM 8.3, UX 6 |
| `progress.approxTokens` | not used (KB, not tokens) | PM section 13, UX 6 |
| `reasoning` | `activity.idle = { kind: 'thinking', elapsedMs, receivedAt }` | UX 13.1 |
| liveness line | `activity.idle = { kind: 'waiting', ... }` (`model.waiting` frame) | PM P4, UX 13.1 |
| file name being written | `subject` (string, at most 80 characters, optional) | UX 13.2, PM P8 |
| artifact kind | `outputKind`: `webArtifact`, `document`, `presentation`, `workbook`, `pdf`, `file`, `archive` | UX 13.2 (server chosen) |

### 1.2 Where this spec follows, adds or differs

| # | Topic | UX / PM says | This spec | Status |
|---|---|---|---|---|
| F1 | Unit of progress | KB plus clock | Same | Agreed |
| F2 | Repeat label | UX: "Attempt n" with a known reason, otherwise "No. n"; never "again" | Same. The lead's task text ("again (2nd)") and PM P6 ("again (2)") are superseded | Agreed, tell the lead |
| F3 | Idle line | In the headline slot, headline-only mode | Same; my first draft's separate `ModelWorkingLine` is dropped | Agreed |
| F4 | Headline suffix and row both show size and clock | UX 5 and 14.2 | Same (my first draft showed them in one place only; dropped) | Agreed |
| F5 | Reduced motion | UX 11.4: static glyph, `motion-safe:animate-spin` | Same; the glyph is a clock or light bulb | Agreed |
| F6 | Live region | `aria-live="off"` on the list root, ticking parts `aria-hidden`, a separate announcer | Same; the markup in section 14 carries both | Agreed |
| F7 | Size format | Under 1 KB no size; whole KB; MB with one locale decimal; reuse `formatBytes` | Same | Agreed |
| F8 | Artifacts drawer | UX: no placeholder (modal covers Stop; list refreshes at answer end) | Same verdict; reasons in section 9 | Agreed |
| F9 | Target size | UX: `min-h-6` | Same 24 px, built with `py-1 -my-1` so the layout does not move; `min-h-6` is an acceptable alternative | Agreed |
| V1 | Colour of active status | UX 15: "everything else gray-600 (dark: gray-400)", existing tokens only | Active state uses existing tokens too (indigo-600 / 400 icon, gray-800 / 200 label) but is more prominent than gray-600. Contrast constraints met | **Needs UX confirmation** |
| V2 | Glyphs | UX leaves icons to UI | Static clock for waiting, light bulb for thinking, `shield-check` amber for awaiting, glyph by `outputKind` for finished rows | For UX review |
| V3 | Between-calls headline | UX 3.3: summary keeps a spinner while the turn runs | Accent spinner with the summary text in the quiet history colour; the idle label (active colour) replaces the summary text after 3 s | For UX review |

---

## 2. What the code does today (facts that shaped the design)

Read from the repository on 2026-11-09. Re-check line numbers before relying on them. The UX brief's F1 to F14
list the interaction facts; these are the visual ones.

1. `client/src/features/chat/components/ToolActivity.jsx`
   - Returns `null` with no rows (line 29), so the headline-only mode needs a deliberate change.
   - `open = expanded ?? loading` (line 30): the list is open while the answer streams and collapses to the
     one-liner when it ends, unless the user clicked.
   - The busy spinner is `<Icon name="spinner" size="sm" className="shrink-0 animate-spin" />` in two places:
     the headline (line 52) and `StatusIcon` (line 177).
   - Titled rows show the title in `text-gray-800 dark:text-gray-200`. `IntegrationChip` is `inline-flex
     items-center gap-1 px-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-600
     dark:text-gray-300`. Value chips are `px-1.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700
     dark:text-gray-300 font-mono break-all`. The amber used today is `text-amber-700 dark:text-amber-400`
     (the "truncated" and page-limit notes).
   - Rail `mt-1.5 ms-1.5 ps-3 border-s border-gray-200 dark:border-gray-700 space-y-2`; detail lines under a
     row use `mt-1 ms-5`; `ItemError` is `mt-1 ms-5 text-red-600 dark:text-red-400 break-words line-clamp-3`.
2. `ChatMessageList.jsx` line 204: `role="log" aria-live="polite"`. Ticking text inside it would be read every
   second (UX F8).
3. `App.css` line 108 redefines `.animate-pulse` as a 0.2 to 1 opacity blink (1.4 s). Never use it on text.
4. `App.css` line 427: the global `prefers-reduced-motion` rule ends every animation in 0.01 ms. `animate-spin`
   becomes a static refresh arrow.
5. `ChatMessage.jsx` (about line 750): the three-dot fallback appears when `!hasSearchStatus`; its dots use
   `animate-pulse` and have no reduced-motion variant.
6. `ArtifactsPanel.jsx` is a modal dialog (`fixed inset-0 z-50`, `bg-white dark:bg-gray-800`). Its list is
   newest first (`ArtifactRepository.js` line 373), rows are 56 px, the HTML preview is `h-[65vh]`
   (`ArtifactPreview.jsx` line 191), the empty state reads "This chat has no files yet...".
7. The download card (`GeneratedFiles.jsx`) appears only after `tool/completed`.
8. Tailwind v4 configured in CSS. `client/tailwind.css` is shared by four entry points (app, Office task pane,
   browser extension, Nextcloud embed), all of which render these components. Dark mode is
   `data-theme="dark"` on `<html>`; use `dark:` classes only. Indigo is overridden to the v3 sRGB ramp; gray,
   red and amber are the v4 defaults. Section 12's ratios were computed from those exact values and agree
   with the table in `docs/accessibility.md`.
9. Icon names verified in `shared/components/Icon.jsx`: `spinner`, `clock`, `light-bulb`, `shield-check`,
   `exclamation-circle`, `exclamation-triangle`, `code-bracket`, `document-text`, `presentation-chart-bar`,
   `table-cells`, `archive-box`, `document`, `document-plus`, `wrench`, `chevron-down`, `link`. Sizes: `xs`
   12 px, `sm` 16 px, `md` 20 px, `lg` 24 px.
10. Only `en` and `de` ship. The list already uses logical properties (`ms-`, `ps-`, `border-s`, `text-start`);
    keep that.
11. `ImageUpload.css` has an indeterminate-bar keyframe but loads only with the upload chunk. Do not depend
    on it (relevant only if the optional sweep ships).

---

## 3. Inputs the visual layer reads

Names follow UX 13.2 and 16. **Required** means the design breaks without it; **optional** means the slot
stays empty.

| Field | Where | Required | Visual use |
|---|---|---|---|
| `status` (`preparing`, `awaiting`, `running`, `completed`, `failed`, `stopped`) | row | yes | Selects the state look. `buildToolActivity` must also turn a still-`preparing` or `awaiting` row into `stopped` once the run is over (UX F11) |
| `id` (the `callId`) | row | yes | **Stable from `preparing` to `completed`**, so React keeps one `<li>` (PM AC-3). A changing key would remount and flash |
| `outputKind` | row | optional | Picks the noun (UX copy) and the finished glyph (section 4.3). Absent: generic label and `wrench` |
| `subject` | row | optional | File-name chip |
| `argBytes`, `elapsedMs`, `receivedAt` | row | optional | `ArgumentProgress`. No `argBytes`: clock only |
| `ready`, `stalled` | row | optional | Muted `ready` line; stall caption |
| `occurrence`, `reason`, `issueCount`, `fixedByCallId` | row | optional | Chip, explanation line, problems line |
| `errorCode` (`truncated`, `invalid`, `dropped`) | row | optional | Which failure sentence (UX 10) |
| `idle` = `{ kind, elapsedMs, receivedAt }` | activity | optional | Idle headline |

**The clock.** `elapsedMs` of the latest frame is the anchor. Between frames add `now - receivedAt`, both from
`performance.now()` (never `Date`, so a wrong system clock cannot matter). A new frame replaces the anchor, so
a reconnect corrects the clock at the next frame (PM AC-6, UX 6). One shared `useNow(1000)` ticks, and only
while some row or the idle line is active, so a finished chat has no timer.

---

## 4. Component breakdown

Reuse first. One new file; everything else is a change to an existing component.

### 4.1 Existing components that change

| Component | File | Change |
|---|---|---|
| `ToolActivity` | `ToolActivity.jsx` | Root `aria-live="off"`. New headline modes (section 7.1). Headline-only mode (no rows, `idle` set): a non-interactive `<div>`, no chevron. Headline button: 24 px hit area, focus ring, `BusyIcon`, `ArgumentProgress` suffix. List wrapper `aria-busy` while any row is active. Props: `{ activity, loading }` as today, `activity.idle` added (UX 13.1) |
| `ActivityItem` | same | Existing single `flex flex-wrap items-center gap-1.5` line (icon, label, chips, status word) plus second-line notes at `mt-1 ms-5`: progress, problems, explanation, stall caption, reason or stopped sentence. The `skill`, `search` and `fetch` branches keep their layout; a `preparing` row of those kinds renders like `running` |
| `StatusIcon` | same | `preparing`, `running` and the busy headline use `BusyIcon`; `awaiting` uses `shield-check`; `ready` a muted static clock; `error` and `stopped` as today; the finished fallback glyph comes from `outputKind` (4.3) |
| `IntegrationChip` | same | Switch to the shared `RowChip` class string. No visual change |
| `ItemStatus`, `ItemError` | same | The "Failed" and "Stopped" words stay; the reason and stopped sentences render through the `ItemError`-style line (red for failed, gray for stopped) |
| `ChatMessage` | `ChatMessage.jsx` | Three-dot fallback stands down while a labelled headline shows (UX 13.9) and gets `motion-reduce:animate-none` on its dots |
| `GeneratedFiles`, `ArtifactsPanel`, `ArtifactViewer`, `ChatInput` stop button, `ApprovalCard`, `SearchStatusIndicator`, `StreamingMarkdown` | | **No visual change in release 1.** (UX changes the stop button's name, description and focus return; follow-up card and viewer notes are in section 10) |
| shared `Badge` | | **Not used.** The row already uses border chips; a filled pill would be a second chip language in one row |

### 4.2 New: `ActivityProgress.jsx`

Packaging note: UX 17.2 lists `ArgumentProgress.jsx` and `ActivityHint.jsx` as separate files. This spec puts
them in one file with `BusyIcon`, `useNow` and `RowChip` because they share the helpers and the same two
consumers; splitting them later is harmless.

```ts
// BusyIcon: the one place that knows how "busy" looks.
type BusyIconProps = {
  size?: 'xs' | 'sm' | 'md' | 'lg';       // default 'sm' (16 px)
  tone?: 'accent' | 'inherit';            // accent = indigo (default)
  staticIcon?: 'clock' | 'light-bulb';    // glyph under prefers-reduced-motion, default 'clock'
  className?: string;
};

// ArgumentProgress: "12 KB written · 0:41". Always aria-hidden (UX 13.3).
type ArgumentProgressProps = {
  argBytes?: number | null;               // absolute; no size shown below 1 KB
  elapsedMs?: number;                     // absolute anchor of the latest frame
  receivedAt?: number;                    // performance.now() when that frame arrived
  running?: boolean;                      // true: clock ticks. false: static (ready, stopped, failed)
  showClock?: boolean;                    // default true; ready passes false
  showClockAfterMs?: number;              // 0 for rows, 3000 for idle lines (UX)
  suffix?: 'readyToRun' | null;           // replaces the clock with "ready to run"
  className?: string;
};

// RowChip: the chip look of the list. Children are the text.
type RowChipProps = { children: React.ReactNode; className?: string };

// ActivityHint: gray caption line (UX 13.4)
type ActivityHintProps = { kind: 'stalled' | 'longWait' | null };

// Pure helpers (unit-testable)
formatSize(argBytes: number, language: string): string  // '' below 1024; whole KB; MB with one locale decimal
formatClock(ms: number): string                         // 'm:ss', 'h:mm:ss' from one hour
useNow(intervalMs: number, active: boolean): number     // shared ticking time, performance.now() based
```

`BusyIcon` renders two icons and lets CSS choose, so it follows a live OS setting change and needs no
`matchMedia` code:

```jsx
<>
  <Icon name="spinner" size={size} className={`shrink-0 animate-spin motion-reduce:hidden ${tone}`} />
  <Icon name={staticIcon} size={size} className={`hidden shrink-0 motion-reduce:inline-block ${tone}`} />
</>
```

Test impact: `tests/unit/client/tool-activity.test.jsx` mocks `Icon` as a `span` with `data-name`, so a
`BusyIcon` is two spans; select with `getAllByTestId('icon').filter(...)` on `data-name`.

### 4.3 Finished glyph by `outputKind`

The server sends `outputKind` (UX 16); the client only maps it to a glyph, the way `fileLookOf` maps a MIME
type. Glyph colour is always the quiet history colour (the timeline stays monochrome; file colours belong to
the download card).

| `outputKind` | Glyph | Notes |
|---|---|---|
| `webArtifact` | `code-bracket` | same glyph as the `code` look of the card |
| `document`, `pdf` | `document-text` | |
| `presentation` | `presentation-chart-bar` | |
| `workbook` | `table-cells` | |
| `archive` | `archive-box` | |
| `file` | `document` | |
| absent or unknown | `wrench` (today) | generic |

If every row is a deliverable, the finished headline uses the glyph of the newest one; otherwise today's logic
(`sparkles`, `wrench`, `document-text`, `globe-alt`) is unchanged.

---

## 5. Tokens (semantic role to Tailwind class)

No new tokens. These are existing classes, named by role so the next person can find them.

| Role | Light | Dark | Used for |
|---|---|---|---|
| `activity.text.history` | `text-gray-600` | `dark:text-gray-400` | list container, finished headline, summary-with-spinner text (existing) |
| `activity.text.active` | `text-gray-800` | `dark:text-gray-200` | active label, idle label (matches today's titled-row label) |
| `activity.text.hover` | `group-hover:text-gray-900` | `dark:group-hover:text-gray-100` | headline label on hover |
| `activity.text.meta` | `text-gray-500` | `dark:text-gray-400` | progress line, headline suffix |
| `activity.icon.active` | `text-indigo-600` | `dark:text-indigo-400` | `BusyIcon` accent |
| `activity.icon.history` | `text-gray-500` | `dark:text-gray-400` | finished glyph (existing), `ready` clock |
| `activity.icon.attention` | `text-amber-700` | `dark:text-amber-400` | `awaiting` shield, problems triangle |
| `activity.text.attention` | `text-amber-700` | `dark:text-amber-400` | "3 problems found" (existing amber) |
| `activity.icon.failed` | `text-red-500` | `text-red-500` (both modes, existing) | failed icon |
| `activity.text.failed` | `text-red-600` | `dark:text-red-400` | "Failed" and the reason sentence (existing) |
| `activity.chip` | `border-gray-200 text-gray-600` | `dark:border-gray-700 dark:text-gray-300` | integration, "Attempt n", "No. n" |
| `activity.chip.value` | `bg-gray-100 text-gray-700` | `dark:bg-gray-800 dark:text-gray-300` | file-name chip (`subject`) |
| `activity.rail` | `border-gray-200` | `dark:border-gray-700` | timeline rail (existing) |

Spacing: existing values stay (`gap-1.5` = 6 px, `ms-1.5`, `ps-3`, `mt-1.5`, `space-y-2`, `ms-5`; they sit on a
2 px sub-grid and every current row uses them). Every **new** value is a multiple of 4 px (`mt-1`, `py-1`,
`-my-1`) except hairlines. Type: `text-xs` (12 px, line height 16 px) throughout, as today; the active headline
gets `font-medium`; numbers `tabular-nums`. Radius: chips `rounded`.

Never use: `text-gray-400` on light (2.60:1), `dark:text-gray-500` on dark (3.67:1), `text-gray-500` on
`bg-indigo-50` (4.33:1) or `bg-gray-100` (4.39:1), amber-600 (UX 11.4), `animate-pulse` on text.

---

## 6. States

Row anatomy (all states): one `<li>` keyed by `callId`; first line `flex flex-wrap items-center gap-1.5` with the
icon (16 px), label, chips and status word in that DOM order; under it, `mt-1 ms-5` note lines in the order
**progress, problems, explanation, stall caption, reason or stopped sentence** (UX wireframe 14.2). No exit or
entrance animation anywhere.

### 6.0 Number formats

- **Size** from `argBytes` (UX 6, F7): none below 1 KB; 1 KB to 999 KB whole KB (`12 KB`); from 1 MB one decimal
  (`1.4 MB`, German `1,4 MB`) via `Intl.NumberFormat(i18n.language)`. Reuse `formatBytes` thresholds but do not
  change `formatBytes` (other cards use it). The unit `KB` is not translated. The word "written" comes from the
  UX string (`{{size}} written` / `{{size}} geschrieben`); it says "running total", not "file size". Never show
  a value smaller than one already shown (keep the maximum in a ref).
- **Clock** `m:ss` (`0:41`, `12:05`), `h:mm:ss` from an hour, from `elapsedMs` plus the local stopwatch.
- **Separator** ` · ` inside one text node, wrapped in `<bdi>` so digits and a right-to-left sentence do not
  reorder. The clock is appended by the component, never part of a translated string (UX 12.1).
- **Rate** at most once per second; no tween, no fade, no smooth counting (a smooth counter implies a precision
  we do not have and is more motion).

### 6.1 Preparing, with size

- **Row line 1:** `BusyIcon` accent; label (UX: "Creating web artifact", no ellipsis in the row) in
  `text-gray-800 dark:text-gray-200`; optional occurrence chip; optional `subject` chip.
- **Progress line:** `<p className="mt-1 ms-5 tabular-nums text-gray-500 dark:text-gray-400" aria-hidden="true">12 KB written · 0:41</p>`
- **Headline:** `BusyIcon`; `Creating web artifact…` in `font-medium text-gray-800 dark:text-gray-200`; suffix
  ` · 12 KB written · 0:41` in `activity.text.meta`, `shrink-0 whitespace-nowrap`.
- **Truncation:** headline label truncates, suffix never; row label wraps; `subject` chip breaks anywhere
  (`break-all`, at most 80 characters).
- **Motion:** spinner rotates (`animate-spin`, 1 s linear). Text ticks at 1 Hz.
- **Reduced motion:** spinner hidden, static clock shown, same accent colour; numbers still change.

### 6.2 Preparing, no size

Same, with no size part: the progress line and suffix are the clock alone (`0:41`, no leading separator in the
line; the headline suffix is ` · 0:41`). The clock shows from the start of a row that exists (UX 6). Nothing
else changes, so the row does not jump when a size appears and looks the same on providers that cannot report.

### 6.3 Ready

`ready` (arguments complete, another parallel call still writing, UX 3.1). Spinner off: muted static clock
(`activity.icon.history`), label stays `activity.text.active`. Progress line `12 KB written · ready to run`,
static (no tick), `activity.text.meta`. A frozen number with a quiet icon and the words "ready to run" cannot be
mistaken for a hang.

### 6.4 Awaiting approval

Icon `shield-check` `text-amber-700 dark:text-amber-400` (the icon the `ApprovalCard` heading uses), no motion.
Label "Waiting for approval" in `activity.text.active`. Headline identical (UX 3.3). The `ApprovalCard` below is
unchanged. `aria-busy` stays on the list.

### 6.5 Running

Same icon, label and chips as preparing. **No progress line and no headline suffix**: the size and clock leave
(on a phone the row loses one line once, at this boundary, never per tick). For deliverable tools the label is
the preparing label without the size (UX 3.2), so `preparing` to `running` does not flicker. No clock for
running in release 1, as today (optional, open item O3).

### 6.6 Completed

Existing quiet look, no animation, no "done" flash. Glyph from `outputKind` (4.3) in `activity.icon.history`;
label in the titled style (UX: "Created web artifact", in the headline "Created web artifact · revised once").
Chips stay (provenance). If the server reported problems:

```jsx
<p className="mt-1 ms-5 flex items-center gap-1 text-amber-700 dark:text-amber-400">
  <Icon name="exclamation-triangle" size="xs" className="shrink-0" />
  3 problems found · being fixed   {/* or "· fixed in attempt 2", or just "3 problems found" */}
</p>
```

Text plus icon, so colour is never the only signal (UX 11.4).

### 6.7 Failed

Icon `exclamation-circle` `text-red-500`; word "Failed" `text-red-600 dark:text-red-400` (existing); then
under the row the last size (static, `activity.text.meta`) and the reason sentence in the `ItemError` style
(`mt-1 ms-5 text-red-600 dark:text-red-400 break-words line-clamp-3`), for example "Incomplete — the model
reached its output limit before the file was finished." A painted row for a dropped call turns failed with
"Not created — the model's request could not be used." (UX 10). Colour is never the only cue: icon shape, word
and sentence.

### 6.8 Stopped

Kind glyph in the history colour; no "Stopped" word on a stopped `preparing` row, because the sentence starts
with it: under the row the last size (static) and the sentence ("Stopped — the unfinished file was not saved.",
UX 9.1) in `text-gray-600 dark:text-gray-400`, `mt-1 ms-5`. Rows stopped from `running` keep the existing
"Stopped" word. No red: the user did this on purpose. Headline suffix: ` · Stopped` (existing key).

### 6.9 Repeat (occurrence 2, 3, ...)

A separate row (PM AC-4, UX 7.1), no grouping, the first row untouched. By what the server knows:

| Server knows | Label (UX) | Chip | Under the row |
|---|---|---|---|
| previous result had warnings | "Fixing web artifact" | "Attempt 2" | progress line, then the explanation sentence (UX `fixingWhy`) |
| previous call failed | "Retrying web artifact" | "Attempt 2" | progress line, then `retryingWhy` |
| no reason | "Creating web artifact" | "No. 2" | progress line only |

Chip: `RowChip` after the label, `whitespace-nowrap`, identical for 2, 3, 10 (neutral, not escalating):

```jsx
<span className="inline-flex items-center gap-1 px-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 whitespace-nowrap">
  Attempt 2
</span>
```

Explanation sentence: `<p className="mt-1 ms-5 text-gray-600 dark:text-gray-400 break-words">`, no clamp (it is the
sentence that calms the second wait; it wraps to three or four lines on a phone).

### 6.10 Stalled

`argBytes` unchanged for 20 s while frames still arrive (UX 9.2). Caption under the progress line, calm and
gray (UX 15), via `ActivityHint`:

```jsx
<p className="mt-1 ms-5 text-gray-600 dark:text-gray-400">No new output for a while. The model may be busy …</p>
```

No icon, no amber, no button (Stop is already on screen). Removed the moment growth resumes. The spinner keeps
turning and the clock keeps ticking, so the row still does not look frozen.

### 6.11 Idle headline: thinking, waiting, between calls, stopping

The headline slot (UX 8, 3.3). Content by mode:

| Mode | Icon | Text | Suffix | Notes |
|---|---|---|---|---|
| `idle.kind = 'thinking'` | `BusyIcon staticIcon="light-bulb"` accent | `Thinking…` `font-medium` active colour | ` · 0:07` | after 3 s of reasoning |
| `idle.kind = 'waiting'` | `BusyIcon staticIcon="clock"` accent | `Still working…` same | ` · 0:12` | from the `model.waiting` frame |
| between calls, loading, answer not started | `BusyIcon` accent | the summary text (`finishedHeadline`) in `activity.text.history` | none | UX F2: never a "done" icon while the turn runs; the idle label replaces the summary text after 3 s |
| stopping (3 s after Stop, run not ended) | `BusyIcon` accent | `Stopping…` active colour | none | |

**Headline-only mode** (no rows): a `<div className="mb-2 flex items-center gap-1.5 text-xs text-gray-600
dark:text-gray-400">`, not a button, no chevron, nothing to expand. Text wraps instead of truncating (it is
short). The three-dot fallback stands down; the idle label is announced once by the announcer (UX 11.1), the
clock is `aria-hidden`.

### 6.12 Dropped call, never painted

Nothing is shown (UX: 500 ms grace, section 10). A painted one becomes `failed` (6.7); a row is never removed
after first paint, so there is no exit animation to specify.

---

## 7. Collapsed one-liner versus expanded row

### 7.1 The one-liner (headline)

```
 slots :  [icon 16] [label  min-w-0 truncate] [suffix  shrink-0 whitespace-nowrap] [chevron 16]
 gap   :  6 px (gap-1.5)
 height:  16 px content, 24 px hit area (py-1 -my-1, no layout shift)
 width :  inline-flex max-w-full
```

Modes, first match wins (the logic is UX 3.3; this table is only the look):

| Mode | Icon | Label colour | Suffix |
|---|---|---|---|
| a row is awaiting | `shield-check` amber | active, medium | none |
| a row is preparing (newest) | `BusyIcon` accent | active, medium | ` · 12 KB written · 0:41`, plus ` · +1 more` for other active rows |
| a row is running | `BusyIcon` accent | active, medium | none |
| idle or stopping | see 6.11 | active, medium | clock or none |
| between calls | `BusyIcon` accent | history | none |
| finished or answer streaming | kind glyph gray (or red `exclamation-circle` if a row failed) | history | none; the text itself carries outcomes ("Created web artifact · revised once", "· Stopped") |

What it reads like while preparing (it must not look hung):

| Moment | EN | DE |
|---|---|---|
| first seconds, no size | `(*) Creating web artifact… · 0:03   v` | `(*) Web-Artefakt wird erstellt… · 0:03   v` |
| 41 s, list open or collapsed | `(*) Creating web artifact… · 12 KB written · 0:41   v` | `(*) Web-Artefakt wird erstellt… · 12 KB geschrieben · 0:41   v` |
| repeat with a reason | `(*) Fixing web artifact… · 4 KB written · 0:05   v` | `(*) Web-Artefakt wird korrigiert… · 4 KB geschrieben · 0:05   v` |
| parallel | `(*) Creating file… · 8 KB written · 0:20 · +1 more   v` | analogous |

Checklist that makes it read as alive: it names the thing; two numbers change every second; its icon is the
only indigo element in the message; its label is medium weight. An implementation missing one of these is a
defect against decision 3.

On a phone the ` · +N more` segment is hidden in the headline (`max-sm:hidden`): the German suffix alone
would leave the label about two characters. The rows below list the other calls.

Truncation: the label truncates with an ellipsis (`title={headline}` repeats the same text for a mouse; it
adds no information, which UX 11.4 forbids for `title`); the suffix never truncates. The toggle's accessible name
excludes the `aria-hidden` suffix, so it does not change every second while focused (UX 11.3).

### 7.2 The expanded row

```
 | [icon 16] label  [Attempt 2] [roi-calculator.html] [integration]  status
 |           12 KB written · 0:41                        (progress line, mt-1 ms-5)
 |           (!) 3 problems found · being fixed          (problems line)
 |           The previous version had 3 problems. ...    (explanation)
 |           No new output for a while. ...              (stall caption)
 | (the leading | is the list rail, border-s)
```

- Keep the existing single `flex flex-wrap items-center gap-1.5` line for icon, label, chips and status word
  (consistent with the other row kinds). Titles are short (UX copy: "Creating web artifact", German "Web-Artefakt
  wird erstellt"), so the label stays on the icon's line; chips wrap to the next line as separate items, as the
  existing query chips do. Known limit: a label longer than the column (about 44 characters at 360 px) would
  drop under the icon; not reachable with the UX strings.
- Note lines keep the 20 px indent of `ItemDetails` (the label starts at 22 px; every row of this list already
  has that 2 px offset).
- Rows are separated by the existing `space-y-2` (8 px). PM caps preparing rows at two, each with its own
  progress line.

### 7.3 Layout stability (no jumps)

- Nothing changes height per tick: lines are `tabular-nums`, and notes are separate lines, not inline text.
- Jumps happen only at state boundaries, once: the progress line leaves at `running`; the stopped, failed and
  problems lines appear when they apply; the download card appears after `completed` as today.
- The row key is the `callId`; a painted row is never removed or re-ordered (UX 10).

---

## 8. Motion

### 8.1 Spec

| Element | Motion | Timing | Reduced motion |
|---|---|---|---|
| `BusyIcon` (headline, rows, idle line) | rotate | `animate-spin`, 1 s linear, infinite | spinner `motion-reduce:hidden`, static glyph `motion-reduce:inline-block` |
| Size and clock text | text swap | at most 1 Hz, no tween or fade | unchanged (a number changing is not motion) |
| Chevron (existing) | rotate 180 degrees | `transition-transform` | add `motion-reduce:transition-none` |
| Three-dot fallback (existing) | blink | `animate-pulse` (the app's override) | add `motion-reduce:animate-none` (UX 13.9) |
| Row, note and chip appear or change | none | instant | n/a |
| Completed | none, no check flash | n/a | n/a |

The global rule in `App.css` already shortens animations under reduced motion; the swap in `BusyIcon` is what
makes the result correct instead of merely still.

### 8.2 Why this treatment

- **Spinner plus count-up plus clock.** Both numbers are true: the size only grows, the clock only ticks. On
  providers that burst (Anthropic) or are slow (30 tokens per second) the size can sit still for seconds; the
  clock keeps the row demonstrably alive (PM risk R6). After 20 s without growth the stall caption speaks (6.10).
- **Not a determinate or "determinate-ish" growing bar.** There is no denominator. A curve that approaches 100
  percent is a fabricated percentage and stalls near the end, which looks like a hang. Rejected outright.
- **Not a skeleton or shimmer on the label.** Gradient text via `background-clip: text` has no reliable contrast
  guarantee and disappears in forced-colours mode.
- **Not `animate-pulse`.** The app redefines it as a 0.2 to 1 opacity blink; text must not blink.
- **WCAG 2.2.2.** Size and clock update for longer than 5 s; they are the essential feedback of an operation
  the user started, change at most once a second, do not move, and the user can end the operation with Stop
  (UX 11.4 documents the same reading; a reviewer should confirm it).

### 8.3 Held back: the indeterminate sweep (optional, not in release 1)

If dogfooding shows the one-liner is still missed in peripheral vision, add a 2 px sweep under the headline: a
one-third-width indigo segment sliding across a track, 1.6 s ease-in-out, fading in after 2 s (fast calls never
show it), `motion-reduce:hidden`, decorative (`aria-hidden`), one per `ToolActivity`. Same idea as
`upload-progress-indeterminate`, but it must not import that file. Needs a `@theme` addition in
`client/tailwind.css` (shared by all four entry points):

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

Non-text contrast: segment indigo-500 on track indigo-100 3.63:1; dark indigo-400 on the dark track 5.12:1.
Reserve its 6 px of height from the moment the headline is active so it does not shift the list when it fades
in. If an RTL locale ever ships, add a mirrored `sweep-rtl` keyframe and select it with `rtl:`; flipping the
segment with a transform is not enough, the travel direction has to reverse.

---

## 9. Artifacts drawer: does a "being written" placeholder earn its place?

**Verdict: no placeholder, no skeleton, no pending row. This agrees with the UX brief (section 5) and the PM
brief (AC-3: the drawer behaves as today in release 1).**

Why not:

1. **The drawer is a modal that covers the Stop button.** A user who opens it to watch progress cannot stop the
   run without closing it, which re-creates the original problem one layer deeper (UX 5).
2. **The file does not exist until the call completes, and the drawer's list refreshes only when the whole
   answer finishes** (`producedRuns` requires `!message.loading`, UX F4). A placeholder would stay up for minutes
   after the file exists, or need the drawer to refresh mid-run first.
3. **It would promise a preview we do not have** in release 1 (PM section 3: live preview is gated to a later
   release). A skeleton that imitates the page would be invented structure; an HTML artifact cannot be shown
   half written in the sandboxed iframe.
4. **It would duplicate the answer to "is it alive"** in a place the user is not looking: the row and headline
   in the chat already carry the size and clock.

**One optional exception worth asking PM for ("Should", tiny):** if the user does open the drawer while a
deliverable row is active, the empty state says "This chat has no files yet." That is false at that moment.
Show one line instead, "A file is being created. It appears here when it is finished." (copy: UX), with a
`BusyIcon tone="inherit"`, in the same `p-4 text-sm text-gray-600 dark:text-gray-300` slot. It needs only the
active-row flag, which the panel can derive from its `messages` prop. No layout change, no transition.

**If the decision is ever reversed** (the drawer becomes non-modal or refreshes on file completion), keep the
box model so the swap causes no jump: a pending list row is the 56 px of a real row (`py-1.5` plus `p-1` plus a
36 px two-line block), placed at index 0 because the list is newest first, with a dashed ghost tile
(`border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50`, glyph gray-600 on
gray-50 7.23:1, dark gray-300 on the tile 8.41:1), not selectable and never focused; the preview pane reserves
the real preview's `h-[65vh]` frame for `html` and `pdf` targets (chosen by `previewTypeOf({ name: subject })`,
a file-name rule the panel already uses) and a compact block otherwise; real fixed-height previews are wrapped in
`min-h-[65vh]` so the "Loading preview…" line does not collapse the box. Not planned; recorded so the work is not
redone.

---

## 10. Follow-up visuals (UX section 7.3, not release 1)

Only the visual treatment; behaviour is in the UX brief.

- **Download card note** ("Draft — being fixed", "3 problems found"): a third line inside the card's text
  column, `text-xs`. "Draft — being fixed" is `text-gray-600 dark:text-gray-300` (gray-600 on white 7.56:1; gray-300
  on gray-800 9.96:1). "3 problems found" is `text-amber-700 dark:text-amber-400` with an `exclamation-triangle`
  `xs` icon (amber-700 on white 5.03:1; amber-400 on gray-800 8.52:1). The card keeps its size otherwise.
- **Viewer notice** ("A newer version is ready." with "Show newer version"): the viewer's existing
  `role="status"` area; the button uses the existing `SECONDARY` button class of `ArtifactsPanel`.
- **Replaced card:** hidden in favour of the newer one; no animation.

---

## 11. Responsive, long strings, RTL, dark mode

### 11.1 Widths

The message column is 328 px at a 360 px viewport (`p-4` on the message list). Inter at 12 px averages about
6.5 px per character; figures are estimates, verify in the browser.

| Viewport | Headline region (column minus icon, chevron, gaps: about 284 px at 360) | Row line 1 (column minus 19 px rail, minus 22 px icon: about 287 px at 360) |
|---|---|---|
| 360 px | about 43 characters | about 44 characters |
| 640 px and up | one line for realistic strings | chips stay on line 1 |
| 320 px | reflows, no horizontal scroll (promised in `docs/accessibility.md`) | same |

### 11.2 Stress strings (UX copy)

| String | Where | Expected at 360 px |
|---|---|---|
| `Creating web artifact…` plus suffix ` · 12 KB written · 0:41` (about 143 px plus 150 px) | headline | label shows about 19 of 22 characters, suffix complete; the row below shows the full label |
| `Web-Artefakt wird erstellt…` plus ` · 12 KB geschrieben · 0:41` (about 176 px plus 176 px) | headline | label shows about 15 of 27 characters (`Web-Artefakt w…`), suffix complete. The label gives way first by design |
| Parallel calls, German, plus ` · +1 weiterer` (about 90 px more) | headline | would leave about 2 characters for the label, so the ` · +N more` segment is `max-sm:hidden` (below 640 px the rows list the other calls) |
| `Attempt 2` chip after a 28-character label | row line 1 | fits on line 1 |
| 80-character file name `subject` | row | chip wraps over two or three lines (`break-all`), nothing overflows |
| `fixingWhy` (133 to 150 characters) | row note | three or four lines, no clamp |
| `stalled`, German (113 characters) | row note | three lines |
| `12:05`, `1.4 MB` | progress | tabular numerals, no wrap |

### 11.3 Touch and focus

- Headline hit area 24 px high (`py-1 -my-1`), meeting WCAG 2.5.8 without moving anything.
- Focus ring on the headline button: `focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500
  rounded-sm` (the pattern `GeneratedFileCard` uses). Rows, chips, notes and the headline-only line are not
  focusable. Nothing in this spec moves focus (UX 11.3).

### 11.4 Right to left

No RTL locale ships, but keep it correct: logical utilities only (`ms-`, `ps-`, `text-start`, `border-s`),
separators inside translated strings, `<bdi>` around file names and the numbers, chevron rotation is direction
independent. If the optional sweep ever ships, mirror it with `rtl:`. Test once with `dir="rtl"` on `<html>`.

### 11.5 Dark mode

Class based only (`dark:` with `data-theme="dark"`). The chat sits on `bg-white dark:bg-gray-900`. Dark accent
is `indigo-400` (indigo-600 would be 2.82:1 on gray-900). Dark meta is `gray-400` (`gray-500` would be 3.67:1).
Amber is `amber-400` in dark (amber-600 is banned, UX 11.4).

### 11.6 Forced colours and print

Icons use `currentColor` and survive forced colours; any background-only decoration (the optional sweep) may
disappear and is decorative by design; every meaning is also text. Print: `ChatMessage.css` already hides
buttons inside messages, so the headline button disappears on paper; unchanged.

---

## 12. Contrast (WCAG 2.2 AA: 4.5:1 text, 3:1 non-text)

Computed from the real palette (Tailwind v4 default gray, red and amber converted from oklch to sRGB; indigo is
the v3 override in `client/tailwind.css`). Page: `white` / `gray-900`. Card and drawer: `white` / `gray-800`.

| # | Element | Light (fg on bg) | Ratio | Dark (fg on bg) | Ratio | Needs | Result |
|---|---|---|---|---|---|---|---|
| 1 | Finished headline, summary-with-spinner, notes in history gray | gray-600 on white | 7.56 | gray-400 on gray-900 | 6.82 | 4.5 | pass |
| 2 | Active label, idle label | gray-800 on white | 14.67 | gray-200 on gray-900 | 14.33 | 4.5 | pass |
| 3 | Hovered label | gray-900 on white | 17.75 | gray-100 on gray-900 | 16.13 | 4.5 | pass |
| 4 | Progress line and headline suffix | gray-500 on white | 4.84 | gray-400 on gray-900 | 6.82 | 4.5 | pass |
| 5 | Active icon (`BusyIcon`) | indigo-600 on white | 6.29 | indigo-400 on gray-900 | 5.95 | 3 | pass |
| 6 | Finished glyph, ready clock | gray-500 on white | 4.84 | gray-400 on gray-900 | 6.82 | 3 | pass |
| 7 | "3 problems found" text | amber-700 on white | 5.03 | amber-400 on gray-900 | 10.30 | 4.5 | pass |
| 8 | Awaiting shield, problems triangle (non-text) | amber-700 on white | 5.03 | amber-400 on gray-900 | 10.30 | 3 | pass |
| 9 | "Failed" and the reason sentence | red-600 on white | 4.77 | red-400 on gray-900 | 6.14 | 4.5 | pass |
| 10 | Failed icon | red-500 on white | 3.81 | red-500 on gray-900 | 4.66 | 3 | pass |
| 11 | Chip text ("Attempt n", "No. n", integration) | gray-600 on white | 7.56 | gray-300 on gray-900 | 12.05 | 4.5 | pass |
| 12 | File-name chip text (on its fill) | gray-700 on gray-100 | 9.36 | gray-300 on gray-800 | 9.96 | 4.5 | pass |
| 13 | Card note, draft (follow-up) | gray-600 on white | 7.56 | gray-300 on gray-800 | 9.96 | 4.5 | pass |
| 14 | Card note, problems (follow-up) | amber-700 on white | 5.03 | amber-400 on gray-800 | 8.52 | 4.5 | pass |
| 15 | Optional sweep segment on track (non-text) | indigo-500 on indigo-100 | 3.63 | indigo-400 on `indigo-900/40` (about `#1d214c`) | 5.12 | 3 | pass |

Decorative borders carry no information (the text beside them does), so they are exempt from 1.4.11: chip
border gray-200 on white is 1.24:1.

Rejected combinations (do not introduce): `text-gray-400` on white 2.60; `dark:text-gray-500` on gray-900 3.67;
`text-gray-500` on `bg-indigo-50` 4.33 (a selected drawer row, so its meta stays `text-gray-600`); `text-gray-500`
on `bg-gray-100` 4.39; indigo-600 on gray-900 2.82; amber-600 anywhere.

---

## 13. Wireframes

Legend: `(*)` busy icon, rotating, indigo. `(c)` static clock under reduced motion. `(s)` shield-check, amber.
`(+)` finished kind glyph, gray. `(g)` globe, gray. `(!)` exclamation-circle, red. `(^!)` exclamation-triangle,
amber. `v` closed chevron, `^` open (rotated) chevron. `[..]` chip. `|` the list rail.

### 13.1 Moment 1: preparing, no size (desktop, first seconds, list open)

```
 (*) Creating web artifact… · 0:03                                     ^
  |
  |  (g) Searched for [berlin weather] · 5 results
  |  (*) Creating web artifact  [roi-calculator.html]
  |      0:03
```

If the provider never reports a size, the row stays like this for the whole wait, with the clock counting.

### 13.2 Moment 2: preparing, with size

```
 (*) Creating web artifact… · 12 KB written · 0:41                     ^
  |
  |  (g) Searched for [berlin weather] · 5 results
  |  (*) Creating web artifact  [roi-calculator.html]
  |      12 KB written · 0:41
```

List collapsed by the user (headline unchanged, the list is hidden):

```
 (*) Creating web artifact… · 12 KB written · 0:41                     v
```

360 px, German, list open (label shortened, suffix complete):

```
 (*) Web-Artefakt w… · 12 KB geschrieben · 0:41   ^
  |
  |  (*) Web-Artefakt wird erstellt
  |      [roi-rechner.html]
  |      12 KB geschrieben · 0:41
```

### 13.3 Moment 3: running (arguments complete)

```
 (*) Creating web artifact…                                            ^
  |
  |  (g) Searched for [berlin weather] · 5 results
  |  (*) Creating web artifact  [roi-calculator.html]
```

Progress line and suffix are gone; the spinner stays until `tool/completed`.

### 13.4 Moment 4: repeat attempt (warnings known)

```
 (*) Fixing web artifact… · 4 KB written · 0:05                        ^
  |
  |  (g) Searched for [pelican cafe pricing] · 5 results
  |  (+) Created web artifact  [roi-calculator.html]
  |      (^!) 3 problems found · being fixed
  |  (*) Fixing web artifact  [Attempt 2]  [roi-calculator.html]
  |      4 KB written · 0:05
  |      The previous version had 3 problems. The assistant is rewriting the
  |      whole file, which can take as long as the first time.
```

Without a reason the second row reads `Creating web artifact  [No. 2]` and has no explanation line.

### 13.5 Moment 5: finished and collapsed

```
 (+) Searched the web · 1 search · 5 results · Created web artifact · revised once   v

 +----------------------------------------------------------------------+
 | [</>]  roi-calculator.html                  Open >   Share   Download |
 |        33 KB                                                         |
 +----------------------------------------------------------------------+
```

The one-liner is the quiet gray history line; the card is the unchanged `GeneratedFileCard`.

### 13.6 More states

Idle, no rows (headline-only, not a button, no chevron):

```
 (*) Thinking… · 0:07
```

Between calls (summary text in the quiet gray, spinner in indigo; after 3 s the idle label replaces the text):

```
 (*) Searched the web · 1 search · 5 results   v
```

Awaiting approval (no motion):

```
 (s) Waiting for approval                                              ^
  |  (s) Creating web artifact  [roi-calculator.html]
  |      (the ApprovalCard follows below, unchanged)
```

Stalled:

```
  |  (*) Creating web artifact  [roi-calculator.html]
  |      8 KB written · 0:52
  |      No new output for a while. The model may be busy - you can wait or stop.
```

Failed during preparing (output limit):

```
 (!) Searched the web · Failed                                         v
  |  (!) Creating web artifact  [roi-calculator.html]  Failed
  |      11 KB written · 1:12
  |      Incomplete - the model reached its output limit before the file was finished.
```

Stopped by the user during preparing:

```
 (+) Searched the web · 1 search · Stopped                             v
  |  (+) Creating web artifact  [roi-calculator.html]
  |      8 KB written · 0:23
  |      Stopped - the unfinished file was not saved.
```

Reduced motion, same moment as 13.2: every `(*)` is `(c)`; the numbers still tick.

---

## 14. Tailwind recipes (copy-paste)

Class order follows the existing code. Names are for orientation.

```jsx
// Shared chip (extract from IntegrationChip; "Attempt n" / "No. n" use it too)
const ROW_CHIP =
  'inline-flex items-center gap-1 px-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300';

// Note lines under a row (all at the 20 px indent ItemDetails uses)
const NOTE = 'mt-1 ms-5 break-words';
const NOTE_MUTED = `${NOTE} text-gray-600 dark:text-gray-400`;
const NOTE_ATTENTION = `${NOTE} flex items-center gap-1 text-amber-700 dark:text-amber-400`;  // flex, not inline-flex: each note is its own line
const NOTE_ERROR = `${NOTE} text-red-600 dark:text-red-400 line-clamp-3`;   // = existing ItemError

// Root: aria-live off (UX 11.1); classes unchanged
<div aria-live="off" className="mb-2 text-xs text-gray-600 dark:text-gray-400">

// Headline button
<button
  type="button"
  className="group inline-flex items-center gap-1.5 max-w-full py-1 -my-1 rounded-sm text-start hover:text-gray-900 dark:hover:text-gray-200 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
  aria-expanded={open} aria-controls={listId}
  onClick={() => setExpanded(!open)}
>
  {iconNode /* <BusyIcon />, shield-check amber, or the kind glyph */}
  <span
    title={labelText}
    className={`min-w-0 truncate ${active ? 'font-medium text-gray-800 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-gray-100' : ''}`}
  >
    {labelText}
  </span>
  <ArgumentProgress /* renders aria-hidden, shrink-0 whitespace-nowrap, " · 12 KB written · 0:41" */ />
  <Icon name="chevron-down" size="sm"
        className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
</button>

// Headline-only mode (no rows): not a button, no chevron
<div aria-live="off" className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-600 dark:text-gray-400">
  <BusyIcon staticIcon={idle.kind === 'thinking' ? 'light-bulb' : 'clock'} />
  <span className="font-medium text-gray-800 dark:text-gray-200">{idleLabel}</span>
  <ArgumentProgress elapsedMs={idle.elapsedMs} receivedAt={idle.receivedAt} running showClockAfterMs={3000} />
</div>

// List wrapper: existing classes plus aria-busy
<ol id={listId} aria-busy={anyActive}
    className="mt-1.5 ms-1.5 ps-3 border-s border-gray-200 dark:border-gray-700 space-y-2">
```

```jsx
// Tool row
<li>
  <div className="flex flex-wrap items-center gap-1.5">
    <StatusIcon item={item} fallback={glyphOf(item.outputKind)} />
    <span className="text-gray-800 dark:text-gray-200" title={item.toolId}>{label}</span>
    {item.occurrence > 1 && <RowChip className="whitespace-nowrap">{occurrenceText}</RowChip>}
    {item.subject && (
      <span className="inline-flex min-w-0 max-w-full px-1.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono break-all">
        <bdi>{item.subject}</bdi>
      </span>
    )}
    <IntegrationChip item={item} />
    <ItemStatus item={item} />
  </div>
  {showProgress && (
    <p className="mt-1 ms-5 tabular-nums text-gray-500 dark:text-gray-400" aria-hidden="true">
      <ArgumentProgress {...progressProps} />
    </p>
  )}
  {item.problems > 0 && (
    <p className={NOTE_ATTENTION}>
      <Icon name="exclamation-triangle" size="xs" className="shrink-0" />
      {problemsText}
    </p>
  )}
  {explanation && <p className={NOTE_MUTED}>{explanation}</p>}
  {item.stalled && <ActivityHint kind="stalled" />}   {/* NOTE_MUTED */}
  {sentence && <p className={item.status === 'error' ? NOTE_ERROR : NOTE_MUTED}>{sentence}</p>}
  <ItemDetails item={item} />
</li>
```

```jsx
// BusyIcon accent tone and the awaiting icon
const ACCENT = 'text-indigo-600 dark:text-indigo-400';
<Icon name="shield-check" size="sm" className="shrink-0 text-amber-700 dark:text-amber-400" />
```

Stopped `preparing` rows render no "Stopped" word (the sentence starts with it); failed rows keep the existing
`ItemStatus` "Failed". The three-dot fallback in `ChatMessage` keeps its classes plus `motion-reduce:animate-none`.

---

## 15. CSS, theme and copy

- **CSS: release 1 needs none.** Every class above exists in Tailwind v4: no new `.css` file, no `@theme` token,
  no keyframes. The optional sweep (8.3) is the only candidate; it goes in `client/tailwind.css`, which all four
  entry points import, never in a component-level CSS file one entry might not load. A new `.css` file would need
  the two-line SPDX header (compact the generated `/* */` block to two lines).
- **Copy: the UX brief owns it.** The keys, English and German strings are in `02-ux-brief.md` section 12.1
  (`creating`, `fixing`, `retrying`, `written`, `readyToRun`, `attempt`, `occurrence`, `problemsFound`,
  `thinking`, `working`, `awaitingApproval`, `stopping`, `stalled`, the `output*` nouns, ...). This spec adds no
  string. The layout was sized with those strings (section 11.2). The clock is appended by the component, never
  part of a string.

---

## 16. Open items for the UX designer and PM

| # | Item | Why it matters | Proposed default |
|---|---|---|---|
| O1 | **V1: active-state colour.** UX 15 says "everything else gray-600"; this spec makes the active state indigo-icon plus gray-800 label | It is the main cue that separates a live status from provenance | Keep (contrast passes); UX to confirm or ask for gray-only, in which case drop the accent and rely on the spinner, the numbers and `font-medium` |
| O2 | **V2: glyphs** (clock, light bulb, amber shield, glyph by `outputKind`) | Icon choice is visual but changes meaning slightly | UX to review the table in 4.3 and 6.11 |
| O3 | A clock on slow `running` rows (an MCP tool at 40 s) | Useful, but beyond the PM scope | Off in release 1; one flag (`showClockAfterMs: 5000` for running) turns it on |
| O4 | **V3: between-calls headline** keeps the summary text in the quiet gray with an accent spinner, idle label replaces it after 3 s | UX 3.3 defines the logic, not the look | As specified in 6.11 |
| O5 | The drawer's optional one-line empty state (section 9) | Fixes a false statement with almost no cost | PM to decide; default off |
| O6 | The lead's task text said "again (2nd)" and tokens; PM and UX replaced both | Whoever briefs from the original issue text must know | Spec follows UX and PM |
| O7 | PM AC-1 and AC-15 forbid argument text on the wire but P8 needs `subject` (UX open question 4) | The file-name chip depends on it | The chip slot is optional and simply stays empty |
| O8 | `useNow` as one shared module-level interval versus per-component timers | Affects test setup (fake timers) and the number of intervals | One shared interval, as UX 13.3 specifies |

---

## 17. Implementation checklist for whoever builds it

Repo rules from `CLAUDE.md` that apply: new `.js` and `.jsx` files carry the two-line SPDX header; run
`npm run lint:fix && npm run format:fix` before committing; every user-visible string in both `en.json` and
`de.json` (UX 12.1); a release note in `docs/releases/next/` through the `/document-feature` skill; the client
renders what the server sends and infers nothing from a tool id (the `outputKind` to glyph map is a mapping of a
server-sent value, not an inference).

1. Add `features/chat/components/ActivityProgress.jsx`: `BusyIcon`, `ArgumentProgress`, `useNow`, `RowChip`,
   `ActivityHint`, `formatSize`, `formatClock`. Unit-test the pure helpers: sizes at 1 023, 1 024, 12 288,
   1 048 575, 1 048 576 chars in `en` and `de`; clocks at 0, 59, 60, 3 599, 3 600 seconds; the clock after a
   second frame resets its anchor; the shown size never decreases.
2. Change `ToolActivity.jsx` as in 4.1 (root `aria-live="off"`, headline modes, headline-only mode, `aria-busy`,
   chips, notes, focus ring and hit area, `StatusIcon` states, glyph map). Treat `preparing` like `running`
   wherever `running` is read (the `running` flag, `runningHeadline`, `reverse().find`).
3. In `ChatMessage.jsx` stand the three-dot fallback down while a labelled headline shows and add
   `motion-reduce:animate-none` to its dots.
4. Extend `shared/run/toolActivity.js` with the UX 13.2 fields; map a still-`preparing` or `awaiting` row to
   `stopped` when the run is over; keep the `callId` stable and the row in place.
5. Tests: extend `tests/unit/client/tool-activity.test.jsx` (the `Icon` mock now yields two spans per
   `BusyIcon`; add a case per state in section 6, both locales, headline modes in 7.1, headline-only mode, a
   `preparing` row coerced to `stopped`). Add an e2e check with `page.emulateMedia({ reducedMotion: 'reduce' })`
   that the spinner is not displayed and the static glyph is, and keep the axe baseline in
   `tests/e2e/accessibility.spec.js` green with a `preparing` row on screen.
6. Manual QA matrix: light and dark; 360 px and 1024 px; reduced motion on and off; `en` and `de`; an 80-character
   file name; a German repeat with a reason on a phone; `dir="rtl"`; forced colours; 200 percent text zoom; keyboard
   only (the headline button is the only tab stop; Enter and Space toggle; the headline-only line is not a stop).
7. Docs: a short "Activity list" note in `docs/ui.md` (states, the active-versus-history rule, the reduced-motion
   glyph swap).

### Do not

No percentage, no growing bar, no eased progress. No `animate-pulse` on text. No amber for a repeat (amber is
for "problems found" only). No red for a user stop. No per-tick announcements. No smooth counting. No
colour-only status. No new CSS file in release 1. No placeholder in the Artifacts drawer. No change to
`GeneratedFiles` or the stop button's look in release 1.

### Out of scope here (so nobody adds it by accident)

Live artifact preview (PM section 3), the long-wait caption (PM P11 and UX 9.2, release 2), the announcer logic
and strings (UX), browser tab title or favicon progress, sound, notifications while the tab is hidden, workflow
and agent run pages.
