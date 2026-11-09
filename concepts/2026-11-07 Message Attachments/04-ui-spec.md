# UI spec: attachments on a sent user message

> Status: the card, tokens, states and accessibility markup were built as specified. The product
> owner chose **variant A**, so the UX engineer's fold ("+N more files") was built and the
> **summary chip** in §0 and §1 was not. The mockup is [mockups/attachments.html](mockups/attachments.html);
> the contrast script and the mockup's own screenshots are not kept in the repository, the numbers in
> §9 are.

UI engineer, 2026-11-07. Pairs with `03-ux-concept.md` (behaviour, copy, states) and `mockups/attachments.html` (open from disk; hash `#v=A&t=dark&w=280&s=seven&p=0`). Numbers: computed with a script and cross-checked on the rendered mockup.

## 0. Visual recommendation

**A, adaptive**: cards above the bubble up to 3 files, a summary chip in the same slot beyond. The bubble stays a pure text bubble and the contrast set stays simple. B needs a second surface set, another focus-ring offset, and the bubble grows to card width. C hides the facts that justify the redesign. The chip uses A's slot, so attachments never jump when the count changes.

Parts: `AttachmentCard` (row), `AttachmentThumb` (grid tile), `AttachmentSummaryChip`. Copy lives in one `COPY` object in the mockup.

## 1. Anatomy (4 px grid)

| Part | Size | Radius | Padding / gap |
|---|---|---|---|
| Row card | `w-80` (320), `max-w-full`, `min-h-14` (56), 1 px border | `rounded-lg` 8 | `px-3 py-2`, gap 12 |
| Type tile | 36, icon 20 | `rounded-md` 6 | |
| Image row tile | 40 thumbnail, 1 px border; row stays 56 | 6 | |
| Text | name 14/20 medium, 2 lines; meta 12/16; facts 12/16, 3 lines, `mt-0.5`, 12 px icon | | |
| Chevron | 16, gap 12 | | |
| Grid tile | 96, 1 px border, `object-cover`; 3 columns, gap 8 | 8 | |
| Chip | `min-h-9` (44 on coarse pointers); up to 3 mini tiles 24, overlap -6 | `rounded-2xl` | `py-1 pl-1.5 pr-3`, gap 8 |
| Disclosure | `min-h-9`, text-sm medium | `rounded-md` | `px-2` |

**Compact** (message column 320 px or less, container query): `p-2 gap-2`, tile 32, no chevron, grid tiles 80 in 2 columns, chip shows a paper-clip instead of the tile stack.
**Layout:** `flex flex-wrap gap-2`; A right-aligned, B and C left. Two cards share a row only at 648 px or more (desktop user column: 653), so usually one right-aligned column. Order: rows (documents, then 1-2 images), then for 3+ images a grid in a second `<ul>`.
**Slots:** A `mb-2` above the bubble (no bubble if attachments only). B `-mx-1 mt-0.5 mb-2` inside: card inset 12 = bubble radius 20 - card radius 8; attachments-only bubble `p-3`. C `mt-1.5` under the bubble. Fold (ux-concept section 6): `visible = n <= cap ? n : cap - 1`; rows cap 4, narrow (column under 360) 3; grid 6 and 4.

## 2. Classes (Tailwind 4.3; app conventions: `focus:outline-hidden` + ring, `dark:` via `data-theme`)

Row card (`<button>`; a static card is a `<div>` without hover, active and ring):
```
group relative flex w-80 max-w-full min-h-14 items-center gap-3 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left transition-colors scroll-my-24
hover:border-indigo-300 hover:bg-gray-50 hover:shadow-xs active:bg-gray-100
focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white
dark:border-gray-600 dark:bg-gray-800 dark:hover:border-indigo-600 dark:hover:bg-gray-700/50 dark:active:bg-gray-700
dark:focus-visible:ring-indigo-400 dark:focus-visible:ring-offset-gray-900
contrast-more:border-gray-500 dark:contrast-more:border-gray-400 @max-xs:gap-2 @max-xs:p-2
```
`@max-xs` needs `@container` on the message row in `ChatMessageList`.

| Part | Classes |
|---|---|
| Tile | `flex size-9 shrink-0 items-center justify-center rounded-md @max-xs:size-8` + look (section 3). Image: `size-10 overflow-hidden border border-black/10 dark:border-white/20`, `<img alt="" class="size-full object-cover">` |
| Body | `min-w-0 flex-1` |
| Name | `line-clamp-2 text-sm font-medium text-gray-900 [overflow-wrap:anywhere] dark:text-gray-100` |
| Meta | `text-xs text-gray-600 dark:text-gray-300`; type label `font-semibold tracking-wide` |
| Facts | `mt-0.5 flex items-start gap-1 text-xs text-gray-600 dark:text-gray-300`; icon `mt-0.5 size-3 shrink-0`; text `line-clamp-3` |
| Chevron | `size-4 shrink-0 text-gray-500 dark:text-gray-400 @max-xs:hidden` |
| Warn | `border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20`; facts `text-amber-800 dark:text-amber-200`; icon `text-amber-700 dark:text-amber-300` |
| Error | `border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20`; facts, icon `text-red-700 dark:text-red-300` |
| No access | `border-dashed border-gray-500 bg-gray-50 dark:border-gray-400 dark:bg-gray-800/60`; name `text-gray-700 dark:text-gray-200`; tile `bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300` |
| Grid tile | `relative block size-24 overflow-hidden rounded-lg border border-black/10 bg-gray-100 after:absolute after:inset-0 after:bg-black/0 hover:border-indigo-300 hover:after:bg-black/10 active:after:bg-black/15 dark:border-white/20 dark:bg-gray-700` + ring set |
| Chip | `inline-flex min-h-9 max-w-full items-center gap-2 rounded-2xl border border-gray-300 bg-white py-1 pl-1.5 pr-3 text-left text-sm font-medium text-gray-900 hover:border-indigo-300 hover:bg-gray-50 active:bg-gray-100 pointer-coarse:min-h-11 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700/50` + ring set; mini tile `size-6 rounded-md ring-2 ring-white dark:ring-gray-800 -ml-1.5 first:ml-0` |
| Disclosure | `inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300` + ring set |
| Spinner | `animate-spin text-indigo-600 dark:text-indigo-400` (not `animate-pulse`: App.css redefines it as a blink) |

**B overrides** (card on the bubble): `border-gray-200 bg-white hover:bg-gray-50 focus-visible:ring-offset-[#eef0f4] dark:border-white/10 dark:bg-white/[0.07] dark:hover:bg-white/[0.12] dark:focus-visible:ring-offset-[#2b303b]`. Better: a `--chat-user-bubble-bg` variable in `ChatMessage.css` used in both places.

## 3. Kinds

Looks reuse the `fileLookOf` / `lookOf` classes unchanged (light `bg-X-50 text-X-700`, dark `bg-X-900/30 text-X-300`, PDF `text-red-400`). Icons are `Icon` names, never emoji.

PDF `document-text` red · DOCX `document-text` blue · PPTX `presentation-chart-bar` orange · XLSX, CSV `table-cells` green · image `photograph` emerald (thumbnail when stored) · audio `musical-note` purple · e-mail `envelope` sky · meeting `calendar` violet · web page `globe` teal · text, code `code-bracket` slate (`bg-slate-100 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200`) · archive `archive-box` amber · other `paper-clip` gray.

Type label: bold text in the meta line (`uploadedFileBadge`), no pill. Origin (iFinder, SharePoint): a plain text segment of the meta line. Optional inline audio player (`p=1`): container with the open row and a native `<audio controls preload="metadata" class="h-10">` as siblings, never nested in a button; `color-scheme: dark` on it in dark mode. Without it, audio is an ordinary row.

## 4. States

| State | Change | Tokens beyond default |
|---|---|---|
| Hover | tint, border; nothing revealed | `hover:bg-gray-50 hover:border-indigo-300` / dark `hover:bg-gray-700/50 hover:border-indigo-600` |
| Focus-visible | 2 px ring, 2 px offset in the surface colour | indigo-500, dark indigo-400 |
| Pressed | darker fill | `active:bg-gray-100` / `dark:active:bg-gray-700` |
| Loading | `<li aria-busy>`, static, spinner in the tile, text "Loading" | spinner tokens, no hover |
| Error (retryable) | stays a button, `exclamation-circle` | Error row |
| Unavailable, expired | static, `exclamation-triangle` | Warn row |
| No access | static, dashed border, `lock-closed` | No-access row |
| Disabled | `aria-disabled="true"`, no chevron, no hover | same text colours |

State is icon plus text, never colour alone. **Disabled never uses opacity**: name and size are a record, and `disabled:opacity-50` would break 4.5:1. Notices (shortened, scan, original removed) get a 12 px `information-circle`; "nothing readable" uses the Warn row and stays openable.

## 5. Names

Max 2 lines, `[overflow-wrap:anywhere]`, soft breaks (`<wbr>`) after `_ - . /` in the stem. Longer names are shortened in the middle, extension kept: over 40 characters `22 + ... + 14`; compact, over 34, `14 + ... + 14` (two spans toggled by the container query). The visible span is `aria-hidden`; a `sr-only` span carries the full name. Full name reachable by pointer (`title`), screen reader (accessible name), keyboard and touch (the card opens the drawer, whose heading must wrap: change `truncate` to `break-words` on the `h3` in `UploadedFilesTab`).

## 6. Responsive (message column = pane - 32)

| Pane | Column / user max | Result |
|---|---|---|
| 900 | 768 / 653 | cards 320, two per row if they fit |
| 640 | 608 / 517 | one column |
| 360 | 328 / 279 | cards shrink to 279, narrow fold, grid 2 columns |
| 280 | 248 / 211 | compact: cards 211, grid 2 x 80, chip with paper-clip |

All 256 combinations (4 placements, 8 file sets, 4 widths, 2 themes, folds expanded) show no horizontal scroll, also with the page at a 280 px viewport, and no console errors. The test found and fixed three overflows (single-file chip name, B with an image grid, a 22 rem select).

## 7. Forced colours, motion, contrast, print, embeds

- **Forced colours:** icons use `currentColor`; every card keeps a real border (`App.css` adds `1px solid ButtonText` to buttons and a 3 px `Highlight` outline, which replaces the box-shadow ring that forced colours strip). Tints disappear, so icon shape and text carry state; no-access stays dashed. Checked in Chromium emulation (`screenshot-forced-colors.png`).
- **Reduced motion:** the global `App.css` rule stops spinner and transitions; state text never depends on animation.
- **`prefers-contrast: more`:** card border gray-500 (4.84) / dark gray-400 (6.82).
- **Print:** `ChatMessage.css` hides `.chat-widget-message button` in print, which would erase the cards. Add `@media print { .chat-widget-message .message-attachments button { display: flex !important } }` and hide the chevron.
- **Embeds:** Office, extension and Nextcloud reset `box-sizing: inherit` (issue #2594). Give `.message-attachments, .message-attachments *` an unlayered `box-sizing: border-box`, like `.chat-widget-message-edit`.

## 8. Accessibility markup, mapped to research section d

```html
<ul role="list" aria-label="Files (2)">
  <li><button type="button" aria-describedby="a1-d act">
    <span aria-hidden="true">[tile]</span> name <span class="sr-only">, </span>
    PDF<span aria-hidden="true"> · </span><span class="sr-only">, </span>2.3 MB
    <span id="a1-d" aria-hidden="true">Text read: 12,400 characters</span> [chevron aria-hidden]
  </button></li></ul>
<span hidden id="act">Opens in the Files panel</span>
```
| Checklist item | How |
|---|---|
| List | `<ul role="list">`; the image grid is a second labelled list inside `role="group"`; counts in labels |
| Button vs link | `<button>` opens the drawer; a future download is `<a href>`; no remove on a sent message; audio player is a sibling |
| Name | name, type, size (pages, origin), visible text first, commas from `sr-only` spans (2.5.3). Facts and action in `aria-describedby`, which also reads `aria-hidden` targets, so the `role="log"` live region does not read facts on mount |
| Decoration | tiles, `alt=""` thumbnails, chevrons, dots are `aria-hidden`; no emoji |
| Status | per-card `role="status"` sr-only text while loading, `aria-busy` on the `<li>`, cleared when done; no `role="alert"` |
| Focus | ring 3:1 against both neighbours; `scroll-my-24` clears the sticky composer (2.4.11); drawer returns focus |
| Target size | cards 56, chip 36 / 44, disclosure 36 (2.5.8 asks 24) |
| Contrast, dark, reflow | sections 9, 2, 6 |

## 9. Contrast (WCAG 2.2, 91 pairs computed)

Palette: Tailwind 4 default hex. `client/node_modules` is not installed here, so values are not read from the repo's `theme.css`; recompute them from the repository's `theme.css` if the palette changes. Alpha fills are composited over the real surface.

| Pair | Light | Dark | Need |
|---|---|---|---|
| Name on card | 17.75 | 13.33 | 4.5 |
| Meta, facts (gray-600 / 300); hover; pressed | 7.56; 7.23; 6.87 | 9.96; 8.40; 6.99 | 4.5 |
| B: name; meta | 17.75; 7.56 | 9.71; 7.25 | 4.5 |
| Warn text; error text | 6.84; 5.87 | 11.12; 7.49 | 4.5 |
| No access: name; meta | 9.86; 7.23 | 12.91; 10.85 | 4.5 |
| Chip text; disclosure | 17.75; 7.90 | 13.33; 8.90 | 4.5 |
| Chevron | 4.84 | 5.64 (B 4.11) | 3 |
| Warn icon; error icon | 4.85; 5.87 | 9.57; 7.49 | 3 |
| Focus ring on page (A, C); on bubble (B) | 4.47; 3.92 | 5.95; 4.43 | 3 |
| Spinner | 6.29 | 4.92 | 3 |
| Type tiles, 10 kinds, min / max | 4.72 / 6.65 | 3.87 / 7.38 | 3 |

**Below threshold, and what was done**
1. `text-gray-500` meta on the bubble: **4.24, fails 4.5**. Not used; meta is gray-600 / gray-300 everywhere.
2. Dark `ring-indigo-500` on the bubble: **2.96, fails 3**. Cards use `dark:ring-indigo-400` (4.43). Other app buttons that sit on the bubble share the fault.
3. Card border: **1.47** light (gray-300 on white), **2.35** dark (gray-600 on gray-900). Decorative by design: the card is identified by tile, text and chevron. `contrast-more` lifts it above 3.
4. Dark PDF tile 3.87 inside the bubble (4.89 on the page): passes 3, below 4.5, and the "PDF" label carries the meaning.

## 10. Build notes

- Add `@container` to the message row; view-model `{ id, name, kind, typeLabel, bytes, pages, origin, facts[], status, thumb }`, status `ready | loading | error | unavailable | noAccess`.
- `message.content` stays text; the block's position comes from placement, never from markup in the text.
