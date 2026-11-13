# UI/UX Brief: Origin-aware activity, skills and sources (UI specification)

| | |
|---|---|
| Document | 04 UI spec: visual specification for the frontend developer |
| Author role | Senior UI designer (design system, enterprise chat, dark mode, accessibility) |
| Date | 2026-11-13 |
| Status | Draft for product-owner, UX and tech-lead review. No source file was edited, nothing was committed. |
| Binding inputs | `03-ux-brief.md` (structure, copy, state matrix, a11y), `02-product-brief.md` sections 0, 4, 6, `01-research.md` section 2 |
| Companion file | `mockups.html` in this folder (self-contained; open it in a browser; light and dark follow the system or the theme button) |
| Location | `concepts/2026-11-13 Activity origin/04-ui-spec.md`, with `mockups.html` next to it |

How to read this: section 0 is the verdict. Section 1 is the foundation (type, spacing, icon sizes, colour roles). Sections 2 to 9 are the elements a to h of the task, in the same order as the mockup sections. Section 10 is dark mode, contrast (with a calculated table), reduced motion and 320 px. Section 11 is the implementation map (file, today's class string, new class string). Section 12 lists every deviation from the UX and PM briefs. Section 13 is what I checked and fixed. Section 14 is what I could not verify. Section 15 is how to continue.

Evidence rules: **O** = observed in the screenshot or in code I read (`path:line`). **C** = calculated by script (contrast, heights) or measured in Chromium with the Inter font installed on this machine. **J** = design judgment. Colour values of Tailwind's gray, amber, red, emerald and purple scales are the Tailwind v4 default values (oklch converted to sRGB by my script, because Tailwind is not installed in this sandbox); the indigo ramp is the exact hex ramp pinned in `client/tailwind.css`. Re-check the converted values once against a real build (section 14).

---

## 0. Verdict in one screen

The activity block keeps its one visual language (12 px text, 16 px icons, the thin left rule, the indigo query chip) and gains **one atom**: a 16 px origin icon plus the origin noun, taken from the footer's `KIND_ICON`. Everything else is rearrangement, not decoration.

Key visual decisions:

1. **Origin atom = icon + noun, never colour.** Six icons (globe-alt, folder, document-text, book-open, document-duplicate, link). Three icon collisions are resolved by changing the *other* usage, not the footer: the iFinder search-profile glyph `folder` becomes `squares-2x2`; the created PDF/document glyph `document-text` becomes `document-plus`; the skill chip uses `academic-cap`, because `sparkles` is the footer's AI segment (section 2).
2. **Leading slot: status wins, origin otherwise.** The origin is always also in the words (section 3).
3. **Collapsed headline = segments.** `[icon] Noun facts`, noun in medium weight and primary ink, facts in the secondary grey, a trailing middle dot between facts, 16 px between segments, wrapping at segment and fact boundaries, never truncating; `+N` after two origins (section 4).
4. **Expanded rows keep the flat timeline** but get a hanging layout: an icon column and a body that wraps *under the phrase*, a 24 px first line, hit titles clamped at two lines with the host never clipped, 24 px link targets (section 5).
5. **"no results" is stated in primary-ink grey** (`gray-700` / `gray-300`), "partly read" and "via Brave Search" in the secondary grey. No amber, no green, no outlined provider chip. Hue is kept for failure (red) and for the one real warning (amber, "Not opened").
6. **Skill chip = a tinted status**, purple as today, no border, no focus stop, glyph `academic-cap`, text `Skill: <name> · <reason>` (section 6).
7. **Technical details** is a 28 x 16 px switch (outlined when off, filled indigo when on), 24 px high, directly under the headline (section 7).
8. **Thinking process** takes the activity button's own classes (section 8).
9. **Sources panel**: origin noun as medium-weight text at the start of every card's meta line, a summary line `Web 5 · Project 3` under the panel title, filter pills for "Next" (section 9).
10. **Every text pair passes AA in light and dark (calculated, section 10)**. Two failures were found in existing code and fixed in this spec (filter-pill border, secondary text on the highlighted source card).

Measured on the F1 run (screenshot), expanded, at the 640 px message width: Today 350 px, Option C 310 px, A-prime 384 px. At 320 px (EN): Today 558, C 638, A-prime 694 (C is taller than today on a narrow pane because hit titles wrap instead of truncating; the honest cost is in section 5.6). Single-origin run (F6) at 640 px: Today 168, C 168.

Deviations from the UX brief are small and listed in section 12 (the biggest: the row layout, the two-row filter, the profile glyph change now rather than later).

---

## 1. Foundations (reuse, nothing new)

### 1.1 Type, weights, line heights (all existing)

| Use | Tailwind | Size / line |
|---|---|---|
| Whole activity block, thinking line, skill chip, row text, facts, hits, details | `text-xs` | 12 / 16 px |
| Mono argument values | `font-mono` (inside `text-xs`) | 12 px |
| Segment noun, running label, skill name, panel meta noun | `font-medium` | 500 |
| Everything else in the block | regular | 400 |
| Panel title | `text-base font-semibold` | 16 / 24 |
| Card title | `text-sm font-medium` | 14 / 20 |
| Panel section label | `text-xs font-semibold uppercase tracking-wide` | 12 / 16 |

No new size. Only two weights (400, 500) inside the activity block.

### 1.2 Spacing (4 px grid; the half steps are the ones the file already uses)

| Token | px | Use |
|---|---|---|
| `gap-0.5` / `gap-y-0.5` | 2 | wrapped lines inside a row body |
| `gap-1`, `py-1` | 4 | segment rows, chip padding, switch gap |
| `gap-1.5`, `mt-1.5`, `ms-1.5` | 6 | icon-to-text, list offset (existing) |
| `gap-2`, `mb-2` | 8 | block bottom margin (existing), switch label gap |
| `gap-x-3`, `ps-3` | 12 | list inset, argument pairs |
| `gap-x-4` | 16 | **new:** between headline segments |
| `ms-5.5` | 22 | **new:** indent of hits and details = 16 px icon + 6 px gap, so they sit exactly under the phrase (today `ms-5` = 20 px, 2 px short) |
| `min-h-6`, `h-6` | 24 | target height (WCAG 2.5.8), first line of a row, pills |

### 1.3 Icon sizes

- `size="sm"` (16 px, `w-4 h-4`): lead slot of a headline, a row, a disclosure button, the chevron.
- `size="xs"` (12 px, `w-3 h-3`): inside a chip or pill (skill chip, footer chip, scope chip, "Uploaded").
- Stroke: Heroicons 24 outline, 1.5 at 24 px (about 1 px at 16 px). Do not mix solid.

### 1.4 Colour roles (Tailwind utilities; ratios are in section 10)

| Role | Light | Dark |
|---|---|---|
| Block text (phrase, inherited facts) | `text-gray-600` | `dark:text-gray-400` |
| Primary ink (segment noun, running label) | `text-gray-800` | `dark:text-gray-200` |
| Primary ink on hover | `text-gray-900` | `dark:text-gray-100` |
| Secondary (count, host, "via", "partly read", lead icons) | `text-gray-500` | `dark:text-gray-400` |
| Declared-empty ("no results") | `text-gray-700` | `dark:text-gray-300` |
| Link (hit, opened page) | `text-indigo-600` | `dark:text-indigo-400` |
| Query chip (unchanged) | `bg-indigo-50 text-indigo-600 border-indigo-200` | `dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700/50` |
| Active status icon (spinner) | `text-indigo-600` | `dark:text-indigo-400` (existing `ACTIVE_ICON`) |
| Failed text / icon | `text-red-600` / `text-red-500` | `dark:text-red-400` / `text-red-500` |
| Attention ("Not opened", awaiting) | `text-amber-700` | `dark:text-amber-400` |
| Skill chip | `bg-purple-100 text-purple-700` | `dark:bg-purple-900/30 dark:text-purple-300` (unchanged from today's pill) |
| Mono detail value | `bg-gray-100 text-gray-700` | `dark:bg-gray-800 dark:text-gray-300` (unchanged) |
| List rule | `border-gray-200` | `dark:border-gray-700` (decorative) |
| Focus ring | `focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500` | same |

Rule: **secondary grey (`gray-500`) only on white or `gray-50`**. On `gray-100` (4.39:1) or `indigo-50` (4.33:1) it fails; use `gray-600` there (section 9.4).

---

## 2. a) The origin atom, the icon map, the collisions

### 2.1 Atom

`[16 px icon, gray-500/400] Noun`. Icon first, then the noun as text. The noun is the footer's noun (`chatMessage.answerBasis.kind.*`), plus the system label for connected systems. Colour never tells origins apart. The atom appears in: the headline segment, the row's lead icon (the noun is in the row's phrase), and, noun only, the source card's meta line.

### 2.2 Icon map (reuse `KIND_ICON`, `answerBasisModel.js:21-33`; no change to that file)

| Origin | Icon | Noun (EN / DE) | Where the icon is drawn |
|---|---|---|---|
| web | `globe-alt` | Web / Web | headline segment, search and open rows |
| project | `folder` | Project / Projekt | same |
| ifinder | `document-text` | iFinder / iFinder | same |
| iassistant | `book-open` | iAssistant / iAssistant | same |
| documents | `document-duplicate` | Document sources / Dokumentquellen | same |
| integration | `link` | system label (Jira, Munich AD) | same |
| none (old chats) | no icon, the 16 px slot stays empty so text aligns with the rows | none | neutral segment only |
| unknown-origin row (older server) | the kind's own glyph: search `search`, open `document`, call `wrench` | n/a | row lead only |

### 2.3 Collisions and how each is resolved

| # | Collision | Where | Resolution |
|---|---|---|---|
| C1 | `folder` = Project (footer, headline, rows) **and** the iFinder search-profile chip and the panel header's scope list (`AnswerSources.jsx:664`, `:924`) | panel | Profile chip and header scope glyph become **`squares-2x2`** ("a slice of the index"; already registered in `Icon.jsx`). `folder` stays Project everywhere. |
| C2 | `document-text` = iFinder (footer) **and** the created PDF and Word document glyph (`activityHeadline.js:29-37`, `pdf` and `document`) **and** the generic read fallback (`ToolActivity.jsx:309`) **and** a source card's file glyph | rows, headline, cards | Created `pdf` and `document` become **`document-plus`** ("made", registered). The read fallback disappears: an open row leads with its origin icon. Unknown-origin reads use plain `document`. A source card's `document-text` stays: it means "a file" there, tinted by file type, and the origin is the noun beside it (no glyph on cards, UX D5). |
| C3 | `link` = integration (footer, `IntegrationChip`) **and** hyperlink **and** the panel menu's "Copy link" (`AnswerSources.jsx:1066`) **and** project provenance "Linked" (`ItemProvenance.jsx:7`) | row, chip, panel menu | `link` is the integration origin only. The "via Brave Search" chip (which wore `link`) becomes plain text, so no web row carries `link`. The menu item and the provenance marker have a visible word next to the glyph; no change. |
| C4 | `sparkles` = footer AI segment (reserved) **and** the skill pill today **and** `SkillCard` | skill chip | The skill chip uses **`academic-cap`** (registered; "a learned capability"). Rejected: `puzzle-piece` (reads as plug-in or integration, not registered), `bolt` (workflow), `book-open` (iAssistant), `light-bulb` (thinking). `SkillCard` and the admin screens may keep `sparkles` (outside the chat answer). |
| C5 | `light-bulb` = Thinking process **and** the idle "Thinking…" line | header | One meaning: the model's reasoning. Keep. |
| C6 | `eye` = the retired green "Read" marker **and** the panel menu's "Preview" action (`AnswerSources.jsx:1061`) **and** the card's `ReadStatus` | hits, panel | The activity-hit marker is removed (UX D2); `eye` stays Preview and the card's read status (unchanged in the MVP). |
| C7 | `document-text` and `document-plus` look alike at 16 px when the iFinder segment and "Created PDF" are neighbours (F3) | headline | Accepted residual: the words differ ("iFinder 3 results" / "Created PDF"). Revisit only if the label test (UX V10) says people confuse them. |

Mockup: section 0 (legend) and section 3 (F3 shows both glyphs).

---

## 3. b) The leading-slot rule

The lead slot is the first 16 px of a row and of the headline. **Status wins; otherwise the origin icon.** The origin is always also in the words, so the slot can be taken by status without losing it.

| Row state | Lead icon | Colour |
|---|---|---|
| running, or preparing and arguments not complete | `BusyIcon` (spinner; static `clock` under reduced motion) | `ACTIVE_ICON` (indigo) |
| preparing, ready to run | `clock` | gray-500 / 400 |
| awaiting approval | `shield-check` | amber-700 / 400 |
| failed | `exclamation-circle` | `text-red-500` |
| stopped | **origin icon** (the word "Stopped" carries the state; a stopped row is final information) | gray |
| completed, default | origin icon | gray |
| completed, origin unknown | kind glyph (section 2.2) | gray |

Headline lead:

| Headline mode | Lead |
|---|---|
| running, preparing, idle | spinner (static glyph under reduced motion), then the label |
| between (turn continues, nothing active) | spinner **replaces the first segment's icon only**; later segments keep theirs. At the end the first segment's icon appears in the same 16 px slot, so nothing shifts. |
| awaiting | `shield-check` amber, replaces all segments |
| finished, streaming-answer | each segment has its own icon |
| finished with failures | **no red icon**. The segment's fact "1 failed" is red text with words. A red globe would say "the whole Web segment failed". (Today `summaryIconOf` turns the single headline icon red; that goes away with the single icon.) |

Alignment: the icon column is 16 px wide and 24 px tall in a row (`flex h-6 shrink-0 items-center`), so it centres on the first line whatever that line contains (plain text 16 px, query chip 22 px, link 24 px). Mockup: sections 1 and 4.

---

## 4. c) The collapsed headline (finished)

### 4.1 Anatomy of one segment

```
[16 px icon]  Noun  fact · fact · fact · via Provider
 gray-500/400  500    secondary grey, trailing dot, nowrap per fact
```

- Order of facts: `results · searches (only if 2 or more) · opened · failed · via Provider`.
- Noun: `font-medium text-gray-800 dark:text-gray-200`, hover `group-hover:text-gray-900 dark:group-hover:text-gray-100`, `me-0.5` (so noun and first fact are about 7 px apart: a space plus 2 px).
- Facts: inherited grey (`text-gray-600 dark:text-gray-400`). Special facts: declared-empty `text-gray-700 dark:text-gray-300`; failed `text-red-600 dark:text-red-400`.
- Separator: a middle dot **inside the preceding fact**, `aria-hidden`, after a normal space: `<span class="whitespace-nowrap">5 results<span aria-hidden="true"> ·</span></span>`. It trails a line and never starts one. Between segments there is **no dot, only 16 px**: one separator, one meaning.
- Segment markup: `inline-flex min-w-0 items-start gap-1.5` with the icon `shrink-0` and the text column `min-w-0` (so a wrapped fact hangs under the noun, not under the icon).
- Segment row: `flex min-w-0 flex-wrap gap-x-4 gap-y-1`.
- `+N`: after the second named segment, `shrink-0 whitespace-nowrap text-gray-500 dark:text-gray-400` (same word as the footer: `chatMessage.answerBasis.more`), with a visually hidden suffix naming what it hides (UX 6.1).
- Output segments ("Created PDF") follow the origin segments, same atom with the output glyph, the label in noun weight, no facts.
- A segment without an icon (old chats) keeps an empty 16 px slot (`w-4 shrink-0`) so its text aligns with the rows below.

### 4.2 The button

Same classes as today with one change: `items-center` becomes `items-start`, so the lead icon and the chevron stay at the top when the headline wraps.

```
group inline-flex items-start gap-1.5 max-w-full py-1 -my-1 rounded-sm text-start
hover:text-gray-900 dark:hover:text-gray-200
focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500
```

Chevron: unchanged (`Icon chevron-down size="sm" shrink-0 transition-transform motion-reduce:transition-none`, `rotate-180` when open). It sits after the segment row, so with a short headline it follows the last segment, and with a wrapped one it sits top right of the first line.

### 4.3 Wrap rules

1. **A finished headline wraps; it never truncates** (remove `truncate`, `title`, `min-w-0 truncate` at `ToolActivity.jsx:82-91`).
2. Segments wrap at segment boundaries (`flex-wrap`).
3. Facts wrap at fact boundaries (`whitespace-nowrap` per fact), so "über Brave Search" or "via Brave Search" moves as a unit.
4. A running or between headline also wraps (`min-w-0 break-words`); at 320 px it can take two lines and the list below moves by at most that line (UX V8). Fallback if V8 shows jumps: `line-clamp-1` on the running label only.
5. No fixed heights anywhere (WCAG 1.4.12).

### 4.4 Examples (mockup section 1, 3, 8)

| Run | EN, 640 px | Lines |
|---|---|---|
| F1 | `[globe] Web 5 results · 3 opened · via Brave Search   [folder] Project no results   v` | 1 |
| F5 | `[folder] Project no results   [globe] Web 3 results · via Brave Search   v` | 1 |
| F3 | `[document-text] iFinder 3 results   [link] Jira 2 calls   +1   [document-plus] Created PDF   v` | 1 |
| F1 DE, 320 px | `Web 5 Ergebnisse · 3 geöffnet ·` / `über Brave Search` / `Projekt keine Ergebnisse` (chevron top right) | 3 (52 px measured, headline only) |

---

## 5. d) Expanded rows

### 5.1 Row structure (a deviation from today, UI reason: 320 px)

Today every row is `flex flex-wrap items-center gap-1.5` with the icon as the first flex item, so at 320 px a chip, a count or a title that does not fit wraps to the **left edge, under the icon**. That is ragged in German. New structure: an icon column and a body that wraps under the phrase.

```jsx
<li>
  <div className="flex items-start gap-1.5">
    <span className="flex h-6 shrink-0 items-center">{lead icon, size="sm"}</span>
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5
                    before:h-6 before:w-0 before:shrink-0 before:-me-1.5">   {/* 24 px strut */}
      {phrase} {query chip} {facts} ...
    </div>
  </div>
  {details}{error}{hits}
</li>
```

The `before:` strut (Tailwind v4 emits `content: ''` for `before:` utilities) forces the first line to 24 px, so the icon centres on it even when the first line holds only 16 px text (for example when a long link wrapped to line 2). `-me-1.5` cancels the flex gap after the strut. Rows are separated by `space-y-1` (4 px; was `space-y-2`, 8 px) because every row now has a 24 px first line, so the visual separation between two text lines stays about 12 px.

### 5.2 Search row

```
[origin icon]  <phrase>  [query chip]  <count or "no results"> · via <provider>
```

- Phrase: whole string per origin (UX 5.1), regular weight in block grey; while running, `font-medium text-gray-800 dark:text-gray-200` (existing `ACTIVE_LABEL`).
- Query chip: **unchanged** (`inline-flex items-center px-2 py-0.5 rounded-md bg-indigo-50 ... border border-indigo-200 ... break-all`).
- Facts block: one flex item containing the facts, same trailing-dot pattern as the headline, `text-gray-500 dark:text-gray-400`.
- Count: `5 results` (secondary grey). Declared zero: `no results` in `text-gray-700 dark:text-gray-300`: the one fact a reader must not skim past, made prominent by darkness, never by hue. Count unknown: nothing.
- Provider: `via Brave Search`, visible text, last fact. Replaces `IntegrationChip` (outlined, link glyph, `title` only), which looked clickable.
- Failed: `exclamation-circle` red-500 lead, the word `Failed` (`text-red-600 dark:text-red-400`), the reason line below (`ms-5.5 text-red-600 ... break-words line-clamp-3`, unchanged otherwise). Never "no results".
- Stopped: origin icon, grey word `Stopped`. Awaiting: amber shield, `Waiting for approval`.

### 5.3 Hit rows (under a search row)

```jsx
<ul className="ms-5.5 max-sm:space-y-1.5">
  <li className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
    <a className="inline-flex min-h-6 min-w-0 max-w-full items-center rounded-sm
                  text-indigo-600 hover:underline dark:text-indigo-400
                  focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500">
      <span className="line-clamp-2 break-words">{title}</span>
    </a>
    <span className="shrink-0 text-gray-500 dark:text-gray-400">{host}</span>
  </li>
</ul>
```

- Title clamps at two lines (never `truncate`); the **host is never clipped**: it follows the title on the same line when it fits and drops below it when it does not. The host is the only visible origin cue for a web hit (research F11).
- The link is a 24 px target (`min-h-6`) with the shared focus ring (today hit links have only the browser outline; a ring is added because the link is touched anyway).
- Below 640 px the hits get `space-y-1.5` (6 px) so that "title, title, host" of one hit does not run into the next hit (seen at 320 px in the mockup).
- iFinder and project hits without a URL: plain `text-gray-700 dark:text-gray-300` text in the same structure, no ring.
- **No "Read" marker, no "Not readable" marker** on hits (UX D2).

### 5.4 Opened row (flat, MVP)

```
[origin icon]  <Opened web page>  <title link>  <host>  <partly read>
```

- Phrase `Opened web page` / `Opened document in the project` / `Opened document in iFinder` (UX 5.1), lead icon = **origin icon** (globe for web), not a document glyph. This is what stops the three page openings in F1 from reading as children of the Project row; they say web by the globe and the words (section 5.6 states what this does not fix).
- Title link: `inline-flex min-h-6 min-w-0 max-w-full items-center ... break-words` with the same colours and ring as a hit (today `break-all`, which splits words; `break-words` only breaks when needed).
- `partly read`: `text-gray-500 dark:text-gray-400`, plain text, no tooltip (replaces amber `truncated`). Word counts move into Technical details.
- `Not opened` (page-read limit): label `Not opened`, the existing sentence below it stays amber (`text-amber-700 dark:text-amber-400`, `ms-5.5`). The only amber row in the list.
- Failed open: red lead and `Failed` and the reason line; no hit-level marker.
- Running: `Opening intrafind.com` phrase in `ACTIVE_LABEL`, spinner lead.

### 5.5 Plain rows (connected systems, creators)

`[link] Search issues · via Jira`, `[link] Search people · via Munich AD`, `[document-plus] Created PDF`. Lead = origin icon for integration calls (`link`), the output glyph for creators, `wrench` otherwise. The system name is a visible `via` fact (same style as a provider). `No. 2` (`RowChip`) is unchanged (see section 12, flag F-2).

### 5.6 What the list costs (C, measured in Chromium)

| Run | 640 px message | 320 px message |
|---|---|---|
| F1, Today | 350 px | 558 px |
| F1, Option C | **310 px** | 638 px |
| F1, A-prime | 384 px (C + 74) | 694 px |
| F6 single web, Today | 168 px | 212 px |
| F6 single web, Option C | **168 px** | 306 px |
| F1 German, Option C | n/a | 654 px |
| F5, Option C | 148 px | |
| F3, Option C | 232 px | |

Read it honestly: at 640 px C is 40 px lighter than today on F1 (the argument chips are gone) and equal on F6 (hit rows grew from 18 to 24 px, the argument line left). **At 320 px C is taller than today on result-heavy runs** (+80 px on F1, +94 px on F6) because today's hit titles are truncated to one line and the full title exists only in a `title` tooltip, while C wraps them (two lines plus the host). That is the price of the UX decision "wrap, never truncate, nothing only in a tooltip", not of the origin work. If the Outlook pane complains, the lever is the clamp (`max-sm:line-clamp-1` on the hit title), not the structure.

A-prime in this run: +3 header lines (one per origin change), every hit and read 22 px deeper, so more wrapping at 320 px; the three reads sit under a Web header and cannot be misread as children of the Project search. C reaches the same only with the globe and the words, until the later merge (a page shown once on its hit) removes the three read rows.

Streaming stability: in C only text changes in place and rows append; the first line of a painted row never changes height (the strut), so nothing above a new row moves (mockup section 4).

---

## 6. e) The skill chip

A **status, not a control**: #3619 says clickable = outlined, status = tinted. So: tinted fill, **no border, no focus ring, no tab stop, no `title`, no hover state.**

```jsx
<ul aria-label={t('toolActivity.skillsLabel')} className="mb-2 flex flex-wrap gap-1.5 text-xs">
  <li className="inline-flex max-w-full items-start gap-1.5 rounded-lg bg-purple-100 px-2 py-1
                 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
    <Icon name="academic-cap" size="xs" className="mt-0.5 shrink-0" />
    <span className="min-w-0 break-words">
      {t('toolActivity.skillLabel')} <span className="font-medium">{name}</span>
      <span aria-hidden="true"> ·</span><span className="sr-only">, </span>
      <span className="whitespace-nowrap">{reason}</span>
    </span>
  </li>
</ul>
```

- Anatomy: glyph (12 px), `Skill:` (regular), name (`font-medium`), a middle dot (hidden from screen readers; they hear a comma), reason (regular, `whitespace-nowrap` so it wraps under the name as a unit at 320 px).
- Shape: `rounded-lg`, not today's `rounded-full`. A two-line pill at 320 px would become a blob; `rounded-lg` reads as a chip at one and at two lines. Padding `px-2 py-1` (on the 4 px grid; today `px-2.5`).
- Colour: unchanged from today's pill (`purple-100/700`, dark `purple-900/30` and `purple-300`; 5.99:1 and 9.12:1, both pass). Purple is kept because users already know it as "skill" (also on `SkillCard`); the state is still carried by the word "Skill:" and the glyph, never by hue alone. All five reason states use the same colour.
- Reason states (EN / DE, from UX 5.3): started manually / manuell gestartet; chosen by the model / vom Modell ausgewählt; set by the app / von der App festgelegt; kept from an earlier message / aus früherer Nachricht übernommen; unknown: no dot, no reason (nothing guessed).
- Two or more chips: one `flex-wrap` row with 6 px gaps; they share a line when they fit (640 px) and wrap to their own rows at 320 px.
- Spacing: the chip row is above the Thinking line and the activity line, each block keeps `mb-2` (8 px). Between two stacked disclosure buttons the 24 px boxes touch exactly (4 px box padding each side plus 8 px margin minus the `-my-1`); never reduce that margin or the boxes overlap.
- Order in the header: skill chips, Thinking process, activity line, answer (UX D4).

Mockup: section 5 (five states, two chips at 640 and 320, header in context) and section 8 (German).

---

## 7. f) The "Technical details" switch

**Markup**: a `<button role="switch" aria-checked aria-describedby>` with a decorative track and thumb and a visible label.

```jsx
<div className="mt-1.5 ms-1.5">
  <button type="button" role="switch" aria-checked={on} aria-describedby={hintId} onClick={toggle}
    className="-ms-1 inline-flex min-h-6 items-center gap-2 rounded-md px-1 text-gray-700 dark:text-gray-300
               focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500">
    <span aria-hidden="true"
      className={`relative inline-block h-4 w-7 shrink-0 rounded-full border-[1.5px]
        transition-colors motion-reduce:transition-none
        ${on ? 'border-indigo-600 bg-indigo-600 dark:border-indigo-500 dark:bg-indigo-500'
             : 'border-gray-500 dark:border-gray-400'}`}>
      <span className={`absolute inset-y-0 left-0.5 my-auto h-[9px] w-[9px] rounded-full
        transition-transform motion-reduce:transition-none
        ${on ? 'translate-x-3 bg-white' : 'bg-gray-500 dark:bg-gray-400'}`} />
    </span>
    <span>{t('toolActivity.technicalDetails')}</span>
  </button>
</div>
```

- Size: track 28 x 16 px (with its 1.5 px border), thumb 9 px, label 12 px, **target 24 px high** (`min-h-6`, whole button including label).
- Off: outlined track (`gray-500` / `gray-400`, 4.84:1 / 6.82:1), thumb the same grey, at the left. A filled grey track (`gray-300`) was rejected: 1.47:1, fails 1.4.11. On: track filled indigo (`indigo-600`, dark `indigo-500`), white thumb (6.29:1 / 4.47:1 against the track), thumb moved 12 px right. State is carried by thumb position and fill and by `aria-checked`, not by hue alone.
- Focus: the same ring as every control (2 px `indigo-500`; 4.47:1 on white, 3.97:1 on gray-900), drawn on the 24 px box.
- Reduced motion: `motion-reduce:transition-none` on track and thumb.
- **Placement**: directly under the headline button, aligned to the list rule (`ms-1.5`, with the button's own `px-1` pulled back by `-ms-1`), above the list; the list then gets `mt-1` instead of `mt-1.5`. Rendered only when the turn is finished, the list is open and a row has details (UX D3). It adds 24 px + 4 px to an open finished list; nothing moves while streaming because it is not rendered then.
- **Off**: no argument names or values, no tool id, no duration, no word counts. Query chip, host, hits, count, "no results", provider, "partly read", "Failed" and its reason stay.
- **On**: under each row, a `dl` exactly as today (`ms-5.5 mt-0.5 mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1`, `dt` secondary grey, `dd` mono chip `bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 font-mono break-all`). New first pairs: `Tool` and the tool id, `Duration` and `1.2 s` (decimal comma in German). The word count is plain secondary text in the same line (`1,334 words read`), not a chip. Argument names stay as the model sent them.
- Measured (mockup section 6, 640 px): off 178 px, on 242 px for the same two rows.

Mockup: section 6 (off, on, focus ring).

---

## 8. g) "Thinking process" (the reasoning disclosure)

Restyled to the activity button's own classes, so the two disclosures read as one family:

```jsx
<div className="mb-2 text-xs text-gray-600 dark:text-gray-400">   {/* unchanged wrapper */}
  <button type="button" onClick={...} aria-expanded={showThoughts} aria-controls={thoughtsId}
    className="group inline-flex items-center gap-1.5 max-w-full py-1 -my-1 rounded-sm text-start
               hover:text-gray-900 dark:hover:text-gray-200
               focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500">
    <Icon name="light-bulb" size="sm" className="shrink-0 text-gray-500 dark:text-gray-400" />
    <span>{t('pages.appChat.thinkingProcess')}</span>
    <Icon name="chevron-down" size="sm"
      className={`shrink-0 transition-transform motion-reduce:transition-none ${showThoughts ? 'rotate-180' : ''}`} />
  </button>
  {showThoughts && <ul id={thoughtsId} ...unchanged...>}
</div>
```

- Light-bulb lead (same glyph as the "Thinking…" idle line), label regular weight, chevron, focus ring, `aria-expanded`. No underline, no show/hide verbs.
- Spacing: `mb-2` as today; the two disclosure lines stack with exactly touching 24 px boxes (section 6). Skill chips above it keep `mb-2`.
- The open region is **unchanged** (`list-disc pl-4 mt-1 space-y-1`). Option for later: the same left rule as the activity list; not in this slice.
- If the PM keeps the "no restyle" line (UX D4 fallback): only the label and `aria-expanded` change and the button stays an underlined text link; the family then rests on the word alone.

Mockup: every frame that shows the header; the focus ring in section 6.

---

## 9. h) The sources panel

### 9.1 Card meta line (origin as text, no glyph)

Today (`AnswerSources.jsx:901`): `flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400` with `truncate` on the site. New:

```
[n badge] [source icon] Noun · identity · date [scope chip]
```

```jsx
<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
  {badge}<SourceIcon source={source} className="h-4 w-4" />
  <span className="font-medium text-gray-700 dark:text-gray-300">{originNoun}</span>
  {site && <><span aria-hidden="true">·</span><span>{site}</span></>}
  {date && ...unchanged...}
  {scopeLabel && ...scope chip...}
</div>
```

- The noun is text only. The card's leading glyph already says page / file / item (favicon or initial, file icon tinted by type, cube), so an origin glyph would repeat or collide (section 2.3).
- `truncate` on the site is dropped; the line wraps (`flex-wrap`). At 320 px the date drops to a second line.
- Colour changes from `gray-500` to **`gray-600`** (`dark:gray-400` unchanged): the highlighted card is `bg-indigo-50`, where `gray-500` is 4.33:1 (fail); `gray-600` is 6.76:1.

### 9.2 Project versus iFinder versus web versus Jira

| Origin | Meta line | Under the title | Leading glyph |
|---|---|---|---|
| Web | `Web · intrafind.com · Nov 12, 2026` | snippet | favicon, else the initial on a colour (unchanged) |
| Project | `Project · Project Alpha` (the project name is `site`) | provenance line `[upload] Uploaded` (existing `ItemProvenance`, 12 px glyph) | file glyph, tinted by type |
| iFinder | `iFinder` + the search-profile chip (`squares-2x2`, section 2.3 C1) | none | file glyph, tinted by type (a PDF is red) |
| Jira (integration) | `Jira · PROJ-142` | snippet | cube |

Scope chip unchanged except the glyph (`inline-flex min-w-0 items-center gap-1 rounded-sm bg-gray-100 px-1.5 py-0.5 text-gray-600 dark:bg-gray-800 dark:text-gray-300`).

The card's `ReadStatus` (green "Read", words, "truncated") is **unchanged in the MVP** (UX D2.6). It still draws green with the eye, the vocabulary the activity list retires; that is UX validation item V2, not a UI change here.

### 9.3 Panel header: the mixed-origin summary

Directly under the title (before the query chips: the origin is the thing the owner asked for, and the query chips can wrap to several lines).

```jsx
<ul aria-label={t('sources.originSummary')} className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-gray-600 dark:text-gray-300">
  <li><span className="font-medium text-gray-700 dark:text-gray-300">Web</span> 5</li>
  <li><span aria-hidden="true" className="me-1.5">·</span><span className="font-medium text-gray-700 dark:text-gray-300">Project</span> 3</li>
</ul>   {/* the dot lives inside every item after the first, aria-hidden, so the list stays valid HTML */}
```

- Static text in the MVP: a list, not buttons, no border, no hover. Two or more origins only; one origin shows nothing (the cards say it). Nouns are the footer's; the numbers count cards.
- With four origins it wraps at item boundaries (mockup section 7).

### 9.4 "Next": filter pills (outlined = clickable)

Same classes as `ScopeFilter` (`AnswerSources.jsx:811`) plus `min-h-6`, and **a visible border**:

```
inline-flex min-h-6 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs
inactive: border-gray-500 text-gray-600 hover:bg-gray-50 dark:border-gray-500 dark:text-gray-300 dark:hover:bg-gray-800
active:   border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-900/40 dark:text-indigo-200
```

The current inactive border (`gray-200` light, `gray-700` dark) is 1.24:1 and 1.72:1 against the page, below the 3:1 that 1.4.11 needs for the component's boundary (existing defect in `ScopeFilter`, fixed here by one class; it also lifts today's profile pills). Pills: `All 11`, `Web 5`, `Project 3`, `iFinder 2`, `Jira 1`, in a `fieldset` with a screen-reader legend.

**Second level (iFinder profiles)**: **two stacked rows**, not one: the origin row stays visible with `iFinder` active, and beneath it, indented 12 px with a 1 px left rule (the activity list's motif), the profile row `All 2 · Contracts 1 · HR policies 1`. (UX 3.6 says "one row at a time"; a single row would hide the other origins and leave no way back to Web, so I draw two rows. See section 12, D-7.)

Mockup: section 7 (MVP on the left, Next on the right) and section 8 (German card at 320 px).

---

## 10. i) Dark mode, contrast, reduced motion, 320 px

### 10.1 Surfaces

Light: page and bubble `white`, borders `gray-200`. Dark: page and bubble `gray-900` (`#101828`), borders `gray-700` (the product's `data-theme="dark"` on `html`; the mockup supports both that attribute and `prefers-color-scheme`). Tints over `gray-900`: `indigo-900/30` = `#1a1f43`, `purple-900/30` = `#261746`, `indigo-900/40` = `#1d214c`.

### 10.2 Contrast (calculated with a script, WCAG relative luminance)

Text needs 4.5:1, UI components and graphics 3:1. Every pair used by the elements in this spec is listed, both themes. "existing" marks a pair that is in today's code; "rejected" marks a design I tried on paper and dropped; "today" marks what this change retires.

| # | Theme | Pair | Foreground | Background | Ratio | Need | Result |
|---|---|---|---|---|---|---|---|
| 1 | light | Phrase / facts text (inherited) gray-600 on white | `#4a5565` | `#ffffff` | 7.56:1 | 4.5:1 | pass |
| 2 | light | Noun, running label gray-800 on white | `#1e2939` | `#ffffff` | 14.67:1 | 4.5:1 | pass |
| 3 | light | Secondary fact (count, host, via) gray-500 on white | `#6a7282` | `#ffffff` | 4.84:1 | 4.5:1 | pass |
| 4 | light | "no results" gray-700 on white | `#364153` | `#ffffff` | 10.30:1 | 4.5:1 | pass |
| 5 | light | Hit / page link indigo-600 on white | `#4f46e5` | `#ffffff` | 6.29:1 | 4.5:1 | pass |
| 6 | light | Query chip text indigo-600 on indigo-50 | `#4f46e5` | `#eef2ff` | 5.62:1 | 4.5:1 | pass |
| 7 | light | Failed red-600 on white | `#e7000b` | `#ffffff` | 4.77:1 | 4.5:1 | pass |
| 8 | light | Not opened / awaiting amber-700 on white | `#bb4c00` | `#ffffff` | 5.06:1 | 4.5:1 | pass |
| 9 | light | Skill chip text purple-700 on purple-100 (unchanged from today) | `#8200db` | `#f3e8ff` | 5.99:1 | 4.5:1 | pass |
| 10 | light | Mono detail chip gray-700 on gray-100 | `#364153` | `#f3f4f6` | 9.36:1 | 4.5:1 | pass |
| 11 | light | Detail name gray-500 on white | `#6a7282` | `#ffffff` | 4.84:1 | 4.5:1 | pass |
| 12 | light | Panel card noun gray-700 on white | `#364153` | `#ffffff` | 10.30:1 | 4.5:1 | pass |
| 13 | light | Panel scope chip text gray-600 on gray-100 | `#4a5565` | `#f3f4f6` | 6.87:1 | 4.5:1 | pass |
| 14 | light | Active pill indigo-700 on indigo-50 | `#4338ca` | `#eef2ff` | 7.07:1 | 4.5:1 | pass |
| 15 | light | Inactive pill text gray-600 on white | `#4a5565` | `#ffffff` | 7.56:1 | 4.5:1 | pass |
| 16 | light | Number badge indigo-700 on indigo-100 | `#4338ca` | `#e0e7ff` | 6.41:1 | 4.5:1 | pass |
| 17 | light | Today: green "Read" emerald-700 on white (retires) | `#007a55` | `#ffffff` | 5.36:1 | 4.5:1 | pass |
| 18 | light | Today: "truncated" amber-700 on white (retires) | `#bb4c00` | `#ffffff` | 5.06:1 | 4.5:1 | pass |
| 19 | light | Switch label gray-700 on white | `#364153` | `#ffffff` | 10.30:1 | 4.5:1 | pass |
| 20 | light | Chevron / lead icon gray-500 on white | `#6a7282` | `#ffffff` | 4.84:1 | 3:1 | pass |
| 21 | light | Spinner / active icon indigo-600 on white | `#4f46e5` | `#ffffff` | 6.29:1 | 3:1 | pass |
| 22 | light | Error icon red-500 on white | `#fb2c36` | `#ffffff` | 3.81:1 | 3:1 | pass |
| 23 | light | Awaiting icon amber-700 on white | `#bb4c00` | `#ffffff` | 5.06:1 | 3:1 | pass |
| 24 | light | Focus ring indigo-500 on white | `#6366f1` | `#ffffff` | 4.47:1 | 3:1 | pass |
| 25 | light | Switch OFF: border/thumb gray-500 on white | `#6a7282` | `#ffffff` | 4.84:1 | 3:1 | pass |
| 26 | light | Switch ON: track indigo-600 on white | `#4f46e5` | `#ffffff` | 6.29:1 | 3:1 | pass |
| 27 | light | Switch ON: white thumb on indigo-600 track | `#ffffff` | `#4f46e5` | 6.29:1 | 3:1 | pass |
| 28 | light | Inactive pill border gray-200 on white (existing ScopeFilter) | `#e5e7eb` | `#ffffff` | 1.24:1 | 3:1 | FAIL (existing) |
| 29 | light | Inactive pill border gray-500 on white (fix) | `#6a7282` | `#ffffff` | 4.84:1 | 3:1 | pass |
| 30 | light | Active pill border indigo-500 on white | `#6366f1` | `#ffffff` | 4.47:1 | 3:1 | pass |
| 31 | light | List rule gray-200 on white (decorative) | `#e5e7eb` | `#ffffff` | 1.24:1 | n/a | decorative |
| 32 | dark | Phrase / facts text (inherited) gray-400 on gray-900 | `#99a1af` | `#101828` | 6.82:1 | 4.5:1 | pass |
| 33 | dark | Noun, running label gray-200 on gray-900 | `#e5e7eb` | `#101828` | 14.33:1 | 4.5:1 | pass |
| 34 | dark | Secondary fact gray-400 on gray-900 | `#99a1af` | `#101828` | 6.82:1 | 4.5:1 | pass |
| 35 | dark | "no results" gray-300 on gray-900 | `#d1d5dc` | `#101828` | 12.05:1 | 4.5:1 | pass |
| 36 | dark | Hit / page link indigo-400 on gray-900 | `#818cf8` | `#101828` | 5.95:1 | 4.5:1 | pass |
| 37 | dark | Query chip text indigo-300 on indigo-900/30 | `#a5b4fc` | `#1a1f43` | 7.97:1 | 4.5:1 | pass |
| 38 | dark | Failed red-400 on gray-900 | `#ff6467` | `#101828` | 6.14:1 | 4.5:1 | pass |
| 39 | dark | Not opened / awaiting amber-400 on gray-900 | `#ffb900` | `#101828` | 10.30:1 | 4.5:1 | pass |
| 40 | dark | Skill chip text purple-300 on purple-900/30 (unchanged from today) | `#dab2ff` | `#261746` | 9.12:1 | 4.5:1 | pass |
| 41 | dark | Mono detail chip gray-300 on gray-800 | `#d1d5dc` | `#1e2939` | 9.96:1 | 4.5:1 | pass |
| 42 | dark | Panel card noun gray-300 on gray-900 | `#d1d5dc` | `#101828` | 12.05:1 | 4.5:1 | pass |
| 43 | dark | Panel scope chip text gray-300 on gray-800 | `#d1d5dc` | `#1e2939` | 9.96:1 | 4.5:1 | pass |
| 44 | dark | Active pill indigo-200 on indigo-900/40 | `#c7d2fe` | `#1d214c` | 10.25:1 | 4.5:1 | pass |
| 45 | dark | Inactive pill text gray-300 on gray-900 | `#d1d5dc` | `#101828` | 12.05:1 | 4.5:1 | pass |
| 46 | dark | Number badge indigo-200 on indigo-900/60 | `#c7d2fe` | `#24255d` | 9.40:1 | 4.5:1 | pass |
| 47 | dark | Today: green "Read" emerald-400 on gray-900 (retires) | `#00d492` | `#101828` | 9.15:1 | 4.5:1 | pass |
| 48 | dark | Switch label gray-300 on gray-900 | `#d1d5dc` | `#101828` | 12.05:1 | 4.5:1 | pass |
| 49 | dark | Chevron / lead icon gray-400 on gray-900 | `#99a1af` | `#101828` | 6.82:1 | 3:1 | pass |
| 50 | dark | Spinner / active icon indigo-400 on gray-900 | `#818cf8` | `#101828` | 5.95:1 | 3:1 | pass |
| 51 | dark | Error icon red-500 on gray-900 | `#fb2c36` | `#101828` | 4.66:1 | 3:1 | pass |
| 52 | dark | Awaiting icon amber-400 on gray-900 | `#ffb900` | `#101828` | 10.30:1 | 3:1 | pass |
| 53 | dark | Focus ring indigo-500 on gray-900 | `#6366f1` | `#101828` | 3.97:1 | 3:1 | pass |
| 54 | dark | Switch OFF: border/thumb gray-400 on gray-900 | `#99a1af` | `#101828` | 6.82:1 | 3:1 | pass |
| 55 | dark | Switch ON: track indigo-500 on gray-900 | `#6366f1` | `#101828` | 3.97:1 | 3:1 | pass |
| 56 | dark | Switch ON: white thumb on indigo-500 track | `#ffffff` | `#6366f1` | 4.47:1 | 3:1 | pass |
| 57 | dark | Inactive pill border gray-700 on gray-900 (existing ScopeFilter) | `#364153` | `#101828` | 1.72:1 | 3:1 | FAIL (existing) |
| 58 | dark | Inactive pill border gray-500 on gray-900 (fix) | `#6a7282` | `#101828` | 3.67:1 | 3:1 | pass |
| 59 | dark | Active pill border indigo-400 on gray-900 | `#818cf8` | `#101828` | 5.95:1 | 3:1 | pass |
| 60 | dark | List rule gray-700 on gray-900 (decorative) | `#364153` | `#101828` | 1.72:1 | n/a | decorative |
| 61 | light | EDGE secondary gray-500 on indigo-50 (highlighted source card, today) | `#6a7282` | `#eef2ff` | 4.33:1 | 4.5:1 | FAIL (existing) |
| 62 | light | EDGE secondary gray-600 on indigo-50 (fix for card meta) | `#4a5565` | `#eef2ff` | 6.76:1 | 4.5:1 | pass |
| 63 | light | EDGE secondary gray-500 on gray-100 (not allowed) | `#6a7282` | `#f3f4f6` | 4.39:1 | 4.5:1 | FAIL (existing) |
| 64 | light | Switch OFF track gray-300 on white (rejected design) | `#d1d5dc` | `#ffffff` | 1.47:1 | 3:1 | FAIL (rejected) |
| 65 | dark | Switch OFF track gray-600 on gray-900 (rejected design) | `#4a5565` | `#101828` | 2.35:1 | 3:1 | FAIL (rejected) |
| 66 | dark | EDGE secondary gray-400 on indigo-900/30 (highlighted card) | `#99a1af` | `#1a1f43` | 6.11:1 | 4.5:1 | pass |
| 67 | light | Avatar initial white on indigo-500 (aria-hidden, decorative) | `#ffffff` | `#6366f1` | 4.47:1 | 4.5:1 | FAIL (existing) |
| 68 | light | Avatar initial white on amber-500 (aria-hidden, decorative) | `#ffffff` | `#fe9a00` | 2.13:1 | 4.5:1 | FAIL (existing) |

Failures found and what I did:

| Failure | Where | Fix |
|---|---|---|
| Inactive filter-pill border 1.24:1 (light), 1.72:1 (dark) | existing `ScopeFilter` | `border-gray-500` (4.84:1 / 3.67:1) |
| `gray-500` secondary text on `indigo-50` (highlighted card) 4.33:1; on `gray-100` 4.39:1 | existing card meta, would hit any new fact placed on a tinted fill | card meta `gray-600` (6.76:1); rule: `gray-500` only on white or `gray-50` |
| Filled grey switch track 1.47:1 / 2.35:1 | my first switch design | outlined track `gray-500` / `gray-400` |
| Avatar initial white on `indigo-500` 4.47:1, on `amber-500` 2.13:1 | existing `SourceIcon` letter avatars (`AnswerSources.jsx:1279`, `text-[0.5625rem]`) | **not changed**: the letter is `aria-hidden` and duplicated by the visible site name, but it is a real defect for sighted low-vision users. Flagged for a separate ticket (use `-600` fills). |

Everything else in the table passes, including the tight ones (`gray-500` on white 4.84, `red-600` on white 4.77, focus ring on white 4.47 against the 3:1 it needs).

A second, independent check ran on the **rendered** page: a script computed the contrast of every text node's computed colour against its effective background (alpha blended), in light and dark, at 1100 px and at 320 px: 941 text nodes per run, one below 4.5:1 (the decorative avatar initial above), zero elsewhere.

### 10.3 Reduced motion

| Element | Normal | `prefers-reduced-motion: reduce` |
|---|---|---|
| Busy icon (headline, rows) | `arrow-path` spinning (`animate-spin`) | static `clock` (existing `BusyIcon`: both rendered, CSS picks; follows an OS change with no script) |
| Chevron (headline, Thinking) | `transition-transform` | `motion-reduce:transition-none` |
| Switch track and thumb | `transition-colors` / `transition-transform` | `motion-reduce:transition-none` |
| Rows appearing | no animation (none exists) | same; no auto-scrolling |
| Streaming caret in the answer | n/a (not part of this change) | n/a |

Verified in Chromium with `reducedMotion: 'reduce'`: 0 spinners visible, 10 static clocks, thumb transition 0 s (mockup frame "Reduced motion, t = 1.4 s" in section 4).

### 10.4 320 px frames

Mockup section 8 (German, 320 px: collapsed with a skill chip, expanded F1, a sources card, four skill chips) and section 4 (German streaming frame). The page itself was also rendered at a 320 px viewport: no horizontal scroll.

What the 320 px frames show, as rules:
- headline: segments on their own lines when they do not fit, facts wrap under the noun, chevron top right;
- rows: phrase, then the query chip (`break-all`), then the facts, all under the phrase (hanging indent);
- hits: title clamps at two lines, the host drops to its own line, 6 px between hits;
- skill chip: the reason wraps under the name as one unit;
- sources card: meta line wraps, title clamps at two lines.

---

## 11. j) Implementation map (file, today's classes, new classes)

Line numbers are from the files as I read them today.

### `client/src/features/chat/components/ToolActivity.jsx`

| Element | Today | New |
|---|---|---|
| Wrapper (L73) | `mb-2 text-xs text-gray-600 dark:text-gray-400` | unchanged |
| Headline button (L79) | `group inline-flex items-center gap-1.5 max-w-full py-1 -my-1 rounded-sm text-start hover:text-gray-900 dark:hover:text-gray-200 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500` | `items-center` -> **`items-start`**, rest unchanged |
| Headline label (L82-91) | `<span title=... className="min-w-0 truncate [ACTIVE_LABEL ...]">` | running/between: `<span className="min-w-0 break-words [ACTIVE_LABEL ...]">` (no `title`). Finished: segment row `flex min-w-0 flex-wrap gap-x-4 gap-y-1`, segment `inline-flex min-w-0 items-start gap-1.5`, noun `font-medium text-gray-800 group-hover:text-gray-900 dark:text-gray-200 dark:group-hover:text-gray-100 me-0.5`, fact `whitespace-nowrap`, `+N` `shrink-0 whitespace-nowrap text-gray-500 dark:text-gray-400` |
| `HeadlineIcon` (L173-192) | one summary icon, red when failed | removed for finished (each segment draws its own); busy keeps `BusyIcon` as the first segment's icon; awaiting keeps the shield |
| Switch | none | new, section 7, between the button and the list |
| List `ol` (L131) | `mt-1.5 ms-1.5 ps-3 border-s border-gray-200 dark:border-gray-700 space-y-2` | `space-y-2` -> **`space-y-1`**; `mt-1.5` -> `mt-1` when the switch row is rendered |
| Row line (L232, L264, L308, L362) | `flex flex-wrap items-center gap-1.5` | icon column + wrapping body (section 5.1) |
| `StatusIcon` (L194-215) | fallback `'search'` / `'document-text'` / `'wrench'` / `'sparkles'` | fallback = `KIND_ICON[item.origin.kind]`; unknown origin: `search` / `document` / `wrench` |
| `SkillRow` (L228-251) | purple bordered chip in the list | **delete** (the chip lives in `ChatMessage.jsx`) |
| Query chip (L274) | `inline-flex items-center px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700/50 break-all` | unchanged |
| Results (L280) | `text-gray-500 dark:text-gray-400` | facts block, trailing dots; "no results" `text-gray-700 dark:text-gray-300` |
| `IntegrationChip` (L467-478) | `RowChip` with `link` icon, `title` | plain fact `via {name}`, `text-gray-500 dark:text-gray-400` |
| Fetch title link (L316-324) | `text-indigo-600 dark:text-indigo-400 hover:underline break-all` | `inline-flex min-h-6 min-w-0 max-w-full items-center rounded-sm text-indigo-600 hover:underline break-words dark:text-indigo-400 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500` |
| `truncated` (L334-341) | `text-amber-700 dark:text-amber-400` + `title` | `partly read`, `text-gray-500 dark:text-gray-400`, no `title` |
| Words read (L329) | `text-gray-500 dark:text-gray-400` | moves behind the switch |
| `limitReached` sentence (L345) | `mt-1 ms-5 text-amber-700 dark:text-amber-400` | `ms-5` -> `ms-5.5` |
| `ItemDetails` (L488) | `mt-1 ms-5 flex flex-wrap items-baseline gap-x-3 gap-y-1`; `dt` `text-gray-500 dark:text-gray-400`; `dd` `m-0 px-1.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono break-all` | wrapper `mt-0.5 mb-1 ms-5.5 ...`; `dd` unchanged; rendered only when the switch is on; adds Tool and Duration |
| `ItemError` (L517), `ItemOutcome` (L453, L458), `ProgressLine` (L431) | `mt-1 ms-5 ...` | `ms-5` -> `ms-5.5` |
| `ToolLabel` (L384-419) | tool id in `title` | id moves to the switch (no `title`) |
| Hit list (L290) | `mt-1 ms-5 space-y-0.5` | `ms-5.5 max-sm:space-y-1.5` (section 5.3) |
| `SourceRow` (L544-590) | `flex items-baseline gap-1.5 min-w-0`; link `... hover:underline truncate`; host `shrink-0 ...` | section 5.3; the read and "Not readable" spans (L567-587) are **deleted** |

### `client/src/features/chat/components/ActivityProgress.jsx`
`RowChip` (L189-197) stays for `No. 2` (see flag F-2). `ActivityHint` (L211): `mt-1 ms-5` -> `ms-5.5`. `BusyIcon` unchanged.

### `client/src/features/chat/activityHeadline.js`
`OUTPUT_GLYPHS` (L30-38): `pdf` and `document` -> `'document-plus'` (collision C2). `lookedAtIcon` (L338-344) goes with the single summary icon.

### `client/src/features/chat/components/ChatMessage.jsx`
| Element | Today | New |
|---|---|---|
| Skill pills (L972-984) | `flex flex-wrap gap-2 mb-2` > `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300` with `sparkles` `w-3 h-3` | section 6: `ul` `mb-2 flex flex-wrap gap-1.5 text-xs`, `li` `inline-flex max-w-full items-start gap-1.5 rounded-lg bg-purple-100 px-2 py-1 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300`, `academic-cap` `xs` |
| Thoughts button (L1000) | `<button onClick=... className="underline">` | section 8 |

### `client/src/features/chat/components/AnswerSources.jsx`
| Element | Today | New |
|---|---|---|
| Panel header summary (after L637) | none | section 9.3 |
| Header scope glyph (L664) and chip glyph (L924) | `folder` | `squares-2x2` |
| Card meta line (L901-908) | `flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400`, site `truncate` | section 9.1 |
| `ScopeFilter` pill (L811) | `inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs` + `border-gray-200 ... dark:border-gray-700` when inactive | add `min-h-6`; inactive border `border-gray-500 dark:border-gray-500` |
| Origin filter (Next) | none | section 9.4, a sibling `fieldset` above `ScopeFilter` |

### Not touched
`answerBasisModel.js` (`KIND_ICON`, `MAX_NAMED_KINDS`), `AnswerBasis.jsx` (the footer chip, `h-6 rounded-full border`, sparkles AI segment), the card's `ReadStatus`, `RunAnnouncer`.

### Strings and tests
EN and DE keys: UX brief section 5 (EN and DE parity test must stay green). New tests: segment wrapping markup, the switch (`role="switch"`, `aria-checked`), the focus move on automatic close, a 320 px layout check, axe. Add the SPDX header to any new file.

---

## 12. Deviations from the UX and PM briefs (UI reasons only)

| # | Deviation | Why (UI) |
|---|---|---|
| D-1 | Row layout: icon column + hanging body, 24 px first line via a strut, `space-y-1`, hits and details at `ms-5.5` | At 320 px German a wrapped chip, count or link otherwise returns to the left edge under the icon (seen in my first render). The strut keeps the icon centred on a first line that may hold only 16 px text. |
| D-2 | "no results" in `gray-700` / `gray-300` (primary-ink grey), other facts in the secondary grey | The empty search is the one fact the owner's run turns on; darkness, not hue, makes it unmissable. UX said "neutral grey"; this is still neutral. |
| D-3 | iFinder profile glyph `folder` -> `squares-2x2` **now** (UX: "when the filter lands") | `Project` (noun) and the folder glyph on an iFinder card sit on the same meta line from day one of the MVP. One class, no cost. |
| D-4 | Created `pdf` / `document` glyph `document-text` -> `document-plus` | A new collision I found (C2): F3 draws the iFinder glyph and "Created PDF" next to each other. |
| D-5 | Unknown-origin rows: `search` / `document` / `wrench`; no-origin segment keeps an empty 16 px slot | UX said "no icon"; an empty slot keeps the text aligned with the rows and avoids a jump from spinner to text. No origin is guessed. |
| D-6 | Origin summary sits directly under the panel title, not after the query chips | The chips can wrap to several lines and push the summary away from the heading it explains. (UX text says "under the title"; only its wireframe differs.) |
| D-7 | Origin filter + profile filter as **two rows**, not "one row at a time" | One row would hide the other origins and offer no way back to Web. |
| D-8 | Skill chip `rounded-lg` (not `rounded-full`), `academic-cap`, colour unchanged | A rounded-full pill turns into a blob at two lines. Colour kept so users keep recognising skills. |
| D-9 | Hit links get the shared focus ring | They become 24 px targets in this change; today they only have the browser outline. |
| D-10 | Filter-pill border and card meta colour changed | Calculated contrast failures (section 10.2). |
| D-11 | Headline icon never turns red | A red globe on a multi-origin headline claims too much; "1 failed" in red text with words carries it. |
| D-12 | Segments separated by 16 px, facts by a trailing dot | Needed so wrapping never starts a line with a dot (UX 3.1 wireframe does the same). |

Followed from the UX brief where the PM brief differs: Technical details at the top (PM: end of the list); the hit-level "Read" marker retired (PM: unchanged); skill reasons in person-neutral words; skill glyph not `sparkles`; "via" and "N opened" instead of a bare provider and "N pages read".

Flags (existing, kept because the task said "keep current look"; one-class fixes for later):
- **F-1** The query chip is outlined (`border-indigo-200`) but not clickable: #3619 says outlined = clickable. Dropping the border (keep the tint) fixes it.
- **F-2** `RowChip` ("No. 2") is outlined and not clickable for the same reason.
- **F-3** The card `ReadStatus` still draws green with an eye while the activity list retires that vocabulary.

---

## 13. Verification log

What I did (Chromium via the pre-installed Playwright, Inter installed, 107 screenshots that are not kept in the repo):

1. Rendered `mockups.html` at 1100 px (light, dark), 320 px (light, dark) and 2200 px (light, to check the side-by-side comparison); per-section images and per-frame images at 320 px. Looked at the section images and the 320 px frames.
2. DOM audit at all four size/theme combinations: horizontal overflow of any element beyond its bubble or panel (0), page horizontal scroll (none at 320 or 1100), contrast of every text node's computed colour against its blended background (941 nodes; one decorative exception, section 10.2).
3. Network: zero requests; no URL in the file; one inline script (theme toggle and the demo switches).
4. Theme toggle works from both system schemes and sets `data-theme`; the demo switches toggle `aria-checked`; no console errors.
5. Reduced motion emulated: spinners hidden, static clocks shown, thumb transition off.
6. Captions with numbers are **measured** (a two-pass build writes the heights into the captions), not estimated. The 320 px comparison numbers in section 5.6 were measured by resizing the same frames to 320 px.

What the first renders showed and I fixed:
- At 320 px a wrapped chip, count or link returned to the left edge under the icon (ragged German rows) -> icon column, hanging body, `ms-5.5` (D-1).
- The lead icon sat 4 px low when the first line held only text (link wrapped) -> 24 px strut.
- At 320 px the hits of one search ran into each other (title, title, host, title) -> 6 px between hits below 640 px.
- The uppercase frame label turned "t = 1.4 s" into "T = 1.4 S" -> no-transform span.
- The reduced-motion rule for the switch lost to a later rule of the same specificity (thumb still animated under reduce) -> moved after it. (In Tailwind the `motion-reduce:` variant is emitted after the base utility, so the product is not exposed to this; it is recorded so nobody copies the CSS instead of the classes.)
- The focus ring was drawn nowhere -> added a frame (section 6) and a ring on hit links.
- Skill chip colour: my first version used `purple-800/200`; today's `purple-700/300` already passes, so I reverted to avoid churn.
- Contrast: section 10.2.
- The sticky page header covered section titles in element screenshots and anchor jumps -> `scroll-margin-top`.

---

## 14. What I could not verify

- **Tailwind values.** Tailwind is not installed here, so gray, amber, red, emerald and purple are the v4 default oklch values converted by my script (they reproduce the well-known hex values, for example `gray-500 #6a7282`, `amber-700 #bb4c00`, `red-600 #e7000b`). Indigo is exact (pinned hex in `client/tailwind.css`). Run the pairs once against a real build.
- **The real components.** I did not run the app or edit it. The mockup mirrors the classes by hand in plain CSS; a class that behaves differently in Tailwind (for example the `before:` strut, `ms-5.5`, `line-clamp-2` with `items-baseline`) needs a look in the real page at 640 and 320 px.
- **Browsers.** Chromium only (Linux, Inter). Safari and Firefox: not rendered; `line-clamp`, `flex-wrap` with a pseudo-element strut and `inset-y-0 my-auto` are standard, but unchecked. Windows and macOS fonts (Segoe UI, SF) have different widths; wrap points will differ.
- **Screen readers, forced colours, 200 % text zoom, touch.** Not tested. The spec states the intended markup; V7 and V9 in the UX brief are the tests.
- **Streaming.** The filmstrip is static frames. Whether the headline at 320 px jumps (UX V8) needs a recording of a live run.
- **German strings** are the UX brief's, not reviewed by a native speaker; the mockup uses them as given.
- **Longer data.** Real runs have longer queries and 10 hits; I used the screenshot's data. A 10-hit run at 320 px is about 2 x 5 hits tall.
- **The skill glyph** `academic-cap` is my judgment; it is not tested (UX V3/V10 could include it).
- **Hit link height.** `min-h-6` on every hit makes the hit list 6 px taller per hit at 640 px than today (24 vs 18 px). It is the cost of the 24 px target rule; if the PO prefers density, the alternative is the spacing exception of 2.5.8 (16 px targets at 24 px pitch, which is not met at today's 18 px).

---

## 15. Handoff: how to continue (for a junior)

1. Open `mockups.html` in a browser. Press "Dark theme" to flip; every frame is a real component state. Section numbers match sections 2 to 9 of this spec.
2. `mockups.html` is a static file. It was generated by build scripts that are not part of the repo; edit the HTML directly, or rebuild the frames from the spec if it changes a lot.
3. Build order for the real code is `03-ux-brief.md` section 9; this spec's section 11 gives the class strings per element.
4. Do not: use colour to tell origins apart; reuse `sparkles` outside the footer's AI segment; make the skill chip or the provider look clickable (no border, no ring); put anything only in a `title`; shrink the `mb-2` between the disclosure lines; use `truncate` on a finished headline or a hit title.
5. Open decisions are the UX brief's O-1 to O-5; none of mine blocks the build. If the PO picks A-prime instead of C, the row and headline specs here still hold; only the list changes (section headers `[icon] Noun via Provider`, rows indented 22 px under them: see the frame in mockup section 1).
