# UI/UX Brief: AttachedFilesList Collapse & Bounded Scroll

> Author: UI/UX (design system custodian) · Date: 2026-06-02
> Status: Design recommendation — ready for implementation by lead dev
> Component: `client/src/features/upload/components/AttachedFilesList.jsx`
> Pattern source: `client/src/features/office/components/chat/OfficeContextStrip.jsx` (issue #1467)

## Executive Summary

When 4+ files are attached, `AttachedFilesList` grows unbounded and pushes the chat
textarea + send button off-screen. We fix this by reusing the proven Office collapse
pattern: a collapsible card that **auto-collapses at >= 4 files** (one row higher than
Office's threshold of 3 — see rationale) and, **when expanded, caps the row list with a
max-height + scroll** so even the expanded state can never push the input off-screen.

For the common case (1–3 files) the component stays fully expanded with **no collapse
chrome** — it renders almost exactly as today. This keeps the frequent path zero-friction
and only adds structure when the list actually threatens the layout.

This is a small, focused change. Do not over-engineer: no animations beyond a CSS height
transition, no virtualization, no per-file thumbnails.

---

## UX Rationale

- **Why a threshold of 4, not 3?** Office combines attachments + pinned emails into one
  strip where 3 rows already cost ~250px in a 600px task pane. Here a row is ~40px and the
  desktop chat area is taller. At 3 files the list is ~120px + footer ≈ 160px — comfortable
  and useful to see at a glance. The pain (input pushed off-screen) starts around 4–5 rows.
  Collapsing a 3-file list would hide information users almost always want visible. So:
  **keep 1–3 expanded with no chrome; auto-collapse at 4+.** This is the single most
  important deviation from Office and it matches the "don't over-engineer the common case"
  goal. (If the team prefers strict parity, 3 is acceptable — see Open Questions.)
- **Why also bound the expanded list?** Auto-collapse is only a *default*; the user can
  expand. With 30 files an expanded list still overflows. A `max-height` + internal scroll
  guarantees the input is reachable in every state on every surface.
- **Why mirror the override pattern?** Users who deliberately expand a 12-file list expect
  it to stay expanded while they curate it. `overrideExpanded` (null | boolean) makes
  auto-collapse a default, not a constraint — identical to Office, so behavior is
  consistent across the product.
- **Why slate vs the current gray?** Keep the **existing gray + indigo palette** of
  `AttachedFilesList`. Do NOT switch to Office's slate — that strip lives in a different
  surface. Consistency here means matching the chat input's own neighbors, which are gray.

---

## Behavior / Thresholds (the core spec)

```
AUTO_COLLAPSE_THRESHOLD = 4   // files.length >= 4 => default collapsed
```

| files.length | Default state        | Chrome rendered                                  |
| ------------ | -------------------- | ------------------------------------------------ |
| 0            | not rendered         | —                                                |
| 1–3          | **expanded, no header** | Today's UI exactly: row list + footer. No chevron. |
| 4+           | **collapsed**        | Collapsible header (summary + chevron). Expandable. |

- `shouldDefaultCollapse = files.length >= AUTO_COLLAPSE_THRESHOLD`
- `expanded = overrideExpanded === null ? !shouldDefaultCollapse : overrideExpanded`
- For 1–3 files, `shouldDefaultCollapse` is false so it's expanded — **and we suppress the
  header entirely** (no point in a collapse toggle when nothing would be hidden). See the
  `showHeader` flag below.

### Expanded scroll bound (applies whenever the row list is shown)

| Surface                         | max-height for the scroll region | Rows visible (~40px each) |
| ------------------------------- | -------------------------------- | ------------------------- |
| Desktop chat                    | `max-h-60` (240px)               | ~6 rows then scroll       |
| Narrow Outlook task pane (~280px) | `max-h-44` (176px)             | ~4 rows then scroll       |

Use a responsive utility so both surfaces are covered with one class:
`max-h-44 sm:max-h-60`. The Office task pane renders narrow (< 640px), so it lands on
`max-h-44`; desktop chat hits the `sm:` breakpoint and gets `max-h-60`. The footer
("Remove All" + count) stays **outside** the scroll region so it is always visible.

> The scroll bound applies even to the 1–3 expanded case — it's harmless there (3 rows
> never exceed the cap) and means one code path. The header is the only thing gated by count.

---

## Component Hierarchy

### AttachedFilesList (container card)

- **Purpose**: Show queued attachments above the chat form without consuming unbounded
  vertical space.
- **States**:
  - `empty` → renders `null`
  - `small` (1–3) → no header, expanded row list (bounded), footer
  - `collapsed` (4+, default) → header only (summary + chevron + Remove All)
  - `expanded` (4+, user override or toggled open) → header + bounded scroll list + footer
  - `disabled` → all buttons disabled (existing prop)
- **New state/props**:
  - internal `overrideExpanded: boolean | null` (useState, default `null`)
  - internal `prevSignatureRef` to reset override when the file set changes (see below)
  - **No new public props required.** Optional escape hatch: `defaultCollapseThreshold?: number`
    (default 4) if the lead wants to tune per-surface without code edits.

#### Header (only when `files.length >= threshold`)

- **Purpose**: Always-visible summary + toggle; hosts Remove All while collapsed.
- **Layout (left → right)**: paper-clip icon · title + summary line (stacked) · `Remove All`
  (text button, only shown while collapsed) · chevron toggle.
- **Accessibility**:
  - ARIA: the toggle button has `aria-expanded={expanded}` and
    `aria-controls="attached-files-region"`, plus `aria-label` ("Show file list" /
    "Hide file list").
  - Keyboard: button is natively focusable; Enter/Space toggle.
  - Screen reader: summary line text is read; count lives in an `aria-live="polite"` node.

#### Scroll region (the row list)

- **Purpose**: Bounded, scrollable list of file rows.
- **ARIA**: `role="list"` on the container, `role="listitem"` on rows, `id` matching the
  header's `aria-controls`. Add `tabIndex={0}` + `aria-label` so keyboard users can scroll
  the region and SRs announce it as a scrollable group. Rows unchanged from today.

#### Footer

- **Purpose**: Count + Remove All, always visible (outside scroll), shown when row list is
  visible (small state, or expanded state).
- When **collapsed**, the footer is hidden and Remove All moves into the header (so the
  primary destructive action is always one click away regardless of state).

---

## Collapsed Summary Design

Single header row, ~44px tall total. Format of the summary line (one line, truncated):

```
{{count}} files · {{totalSize}}
e.g.  "12 files · 4.3 MB"
```

- Title (line 1, `text-sm font-medium`): `t('attachedFiles.title', 'Attachments')`.
- Summary (line 2, `text-xs text-gray-500`): count + total size, joined with ` · `.
- **File-type chips**: optional and recommended-light — show up to 3 small type icons
  (camera/microphone/document-text/paper-clip) representing distinct types present, e.g.
  `[doc] [img] [audio]`, with a `+N` if more types exist. Keep them ≤ 16px and
  `aria-hidden` (the summary text already conveys the count). If this adds complexity,
  ship without chips first — text summary is sufficient. (Open Question #3.)
- **Remove All** sits in the header (right of summary, left of chevron) while collapsed.
- **Loading files**: if any file `loading`, append ` · {{n}} loading…` to the summary and
  keep the spinner only in the expanded rows. Total size sums only non-loading files.

---

## Expanded Design

- Keep **today's row markup verbatim** (source icon, type icon/spinner, name+size, remove X).
- Wrap the `divide-y` list in a bounded scroll container:
  `max-h-44 sm:max-h-60 overflow-y-auto`.
- Footer stays **below** the scroll container (sticky-by-position, not `position: sticky` —
  it's outside the scrolling element so it never moves).
- `onRemoveFile(index)` and `onRemoveAll()` unchanged. After Remove All the component
  unmounts (parent sets files to []). Removing files one-by-one down to 3 will, on the next
  render, drop below threshold — but because the user has an active `overrideExpanded`
  (they opened it) it stays open, which is correct (no surprise collapse mid-curation).

---

## Small File Counts (1–3) — exact behavior

- Render **exactly today's UI**: row list + footer, no header, no chevron, no summary.
- Internally still wrapped in the bounded scroll container (no visual effect at ≤3 rows).
- Rationale: zero added chrome for the overwhelmingly common case; the new structure is
  invisible until it's needed. Implement via a `showHeader = files.length >= threshold`
  flag — everything else is shared.

---

## Override reset on file-set change

Office resets `overrideExpanded` when `ctx.itemId` changes. Here there's no single id, so
reset when the **set of files** changes identity (not on every keystroke/re-render). Use a
cheap signature:

```jsx
const signature = files.length; // minimal: reset only when count changes
// (or `${files.length}:${files[0]?.fileName ?? ''}` if you want name-level sensitivity)
const prevSig = useRef(signature);
if (prevSig.current !== signature) {
  prevSig.current = signature;
  if (overrideExpanded !== null) setOverrideExpanded(null);
}
```

Recommendation: reset on `files.length` change only. Adding a file should re-evaluate the
auto-collapse default (4th file arrives → collapses); removing back to 3 re-expands. This
is the least surprising rule and matches "the default re-applies when the situation
changes." (Open Question #2 if you'd rather keep the override sticky across additions.)

---

## Illustrative Snippets (not full implementation)

### Collapsed header

```jsx
{showHeader && (
  <div className="flex items-center gap-2 px-3 py-2">
    <button
      type="button"
      onClick={() => setOverrideExpanded(!expanded)}
      className="flex-1 flex items-center gap-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors rounded-md px-1 py-0.5 -ml-1"
      aria-expanded={expanded}
      aria-controls="attached-files-region"
      aria-label={expanded
        ? t('attachedFiles.hideList', 'Hide file list')
        : t('attachedFiles.showList', 'Show file list')}
    >
      <Icon name="paper-clip" size="sm" className="flex-shrink-0 text-gray-500 dark:text-gray-400" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {t('attachedFiles.title', 'Attachments')}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate" aria-live="polite">
          {summaryLine /* "12 files · 4.3 MB" (+ " · 2 loading…") */}
        </div>
      </div>
      <Icon
        name={expanded ? 'chevronUp' : 'chevronDown'}
        size="sm"
        className="flex-shrink-0 text-gray-400"
        aria-hidden
      />
    </button>

    {/* Remove All lives in the header while collapsed */}
    {!expanded && (
      <button
        type="button"
        onClick={onRemoveAll}
        disabled={disabled}
        className="flex-shrink-0 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t('attachedFiles.removeAll', 'Remove All')}
      </button>
    )}
  </div>
)}
```

### Bounded expanded list + footer

```jsx
{expanded && (
  <>
    <div
      id="attached-files-region"
      role="list"
      tabIndex={0}
      aria-label={t('attachedFiles.regionLabel', 'Attached files')}
      className={`max-h-44 sm:max-h-60 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-700 ${showHeader ? 'border-t border-gray-200 dark:border-gray-700' : ''}`}
    >
      {files.map((file, index) => (
        <div role="listitem" key={index} className="flex items-center gap-3 px-3 py-2 ...">
          {/* unchanged row content */}
        </div>
      ))}
    </div>

    {/* Footer outside the scroll region => always visible */}
    <div className="flex items-center justify-between px-3 py-2 border-t ... bg-gray-50 dark:bg-gray-700/30">
      <div className="text-xs text-gray-600 dark:text-gray-400" aria-live="polite">
        {t('attachedFiles.filesCount', '{{count}} file(s) attached', { count: files.length })}
      </div>
      <button type="button" onClick={onRemoveAll} disabled={disabled} className="text-xs ...">
        {t('attachedFiles.removeAll', 'Remove All')}
      </button>
    </div>
  </>
)}
```

> `showHeader = files.length >= threshold`. When false, the header block above is skipped
> and `expanded` is effectively true → renders the small-count UI (list + footer, no border
> seam). Wrapper card stays `mt-2 mb-4 border ... rounded-lg bg-white dark:bg-gray-800 shadow-sm`.

---

## Accessibility Requirements

- **WCAG 4.1.2 (Name, Role, Value)**: toggle exposes `aria-expanded` + `aria-controls`;
  label updates between show/hide.
- **WCAG 1.3.1 (Info & Relationships)**: list semantics (`role="list"`/`listitem`).
- **WCAG 4.1.3 (Status Messages)**: count nodes are `aria-live="polite"` so adding/removing
  files announces the new total without stealing focus.
- **WCAG 2.1.1 (Keyboard)**: header toggle reachable via Tab; the scroll region is
  `tabIndex={0}` so it can receive focus and be scrolled with arrow keys/PageUp-Down.
- **WCAG 2.4.7 (Focus Visible)**: rely on existing app focus ring; ensure the new toggle
  and scroll region show it (Tailwind `focus:outline-none focus-visible:ring-2` if the
  card's neighbors use that — match the chat input's existing focus style).
- **Contrast**: keep `text-gray-500` on white/`gray-800` (passes AA for the summary's small
  text only if ≥ `text-gray-500`/#6B7280 on white = 4.6:1 ✓; verify dark mode
  `text-gray-400` on `gray-800` — that's borderline 4.0:1, acceptable for AA large/secondary
  but confirm). The current footer already uses these tokens, so no regression.
- **Color independence**: type chips are decorative (`aria-hidden`); the text summary
  carries the same info.

---

## Responsive

- One responsive class handles both surfaces: `max-h-44 sm:max-h-60`.
  - Outlook task pane (~280px, < 640px viewport) → `max-h-44` (176px, ~4 rows).
  - Desktop chat (≥ 640px) → `max-h-60` (240px, ~6 rows).
- Header summary, title, and all file names already `truncate`; at 280px the title may
  shorten to just the icon + count — acceptable. Remove All in the header is a short text
  label; if it crowds at 280px, allow it to wrap to icon-only is **not** recommended —
  instead keep text and let the title truncate first (title is least critical).
- Verify the component is rendered inside the Office task pane's chat column with the same
  horizontal margins as `OfficeContextStrip` (`mx-3`) if it shares that container; on
  desktop it keeps its current full-width-of-form placement.

---

## Edge Cases

| Case                      | Behavior                                                                 |
| ------------------------- | ------------------------------------------------------------------------ |
| Loading file (spinner)    | Spinner stays in expanded row. Summary appends `· {{n}} loading…`. Size sum excludes loading files. Remove button disabled while `file.loading` (already coded). |
| Mixed sources             | Source icon per row unchanged. Summary does not break sources out (keep it simple); the per-row source icon + title still communicates it. |
| Very long file names      | `truncate` on name (today) + `truncate` on header title/summary. `title` attr gives full name on hover. |
| Remove All while collapsed| Lives in header; unmounts component (parent clears files).               |
| Remove down to ≤3 while expanded | Stays expanded (active override). Header disappears once count < threshold AND override is null; while override is set it keeps the open list — fine, just no chevron once header is suppressed. **Edge to confirm:** if header is suppressed at ≤3 there's no way to collapse, which is correct (nothing to collapse). |
| Adding a 4th file         | Count signature changes → override resets to null → auto-collapses. Confirm this is desired (Open Q #2). |
| All files removed         | `files.length === 0` → `return null` (today's behavior).                 |

---

## New i18n Keys

Add under `attachedFiles` in `shared/i18n/en.json` and `shared/i18n/de.json` (existing keys
`removeAll`, `filesCount`, `remove`, `sourceLocal`, `sourceCloud`, `loading` stay).

| Key                          | English default                  | Notes |
| ---------------------------- | -------------------------------- | ----- |
| `attachedFiles.title`        | `Attachments`                    | Collapsed header title. |
| `attachedFiles.showList`     | `Show file list`                 | Toggle aria-label (collapsed). |
| `attachedFiles.hideList`     | `Hide file list`                 | Toggle aria-label (expanded). |
| `attachedFiles.regionLabel`  | `Attached files`                 | Scroll region aria-label. |
| `attachedFiles.summary`      | `{{count}} file · {{size}}`      | Use i18next plural: add `attachedFiles.summary_one` / `attachedFiles.summary_other` (`{{count}} files · {{size}}`). |
| `attachedFiles.loadingCount` | `{{count}} loading…`             | Appended fragment; pluralize if desired (`_one`/`_other`). |

> `filesCount` already uses `{{count}}` — note it currently hardcodes "file(s)" rather than
> i18next plural forms. If you want correct German pluralization, migrate it to
> `filesCount_one` / `filesCount_other` while you're in here (optional cleanup, flag to lead).

i18next plural example (en.json):

```json
"attachedFiles": {
  "title": "Attachments",
  "showList": "Show file list",
  "hideList": "Hide file list",
  "regionLabel": "Attached files",
  "summary_one": "{{count}} file · {{size}}",
  "summary_other": "{{count}} files · {{size}}",
  "loadingCount_one": "{{count}} loading…",
  "loadingCount_other": "{{count}} loading…"
}
```

---

## Implementation Notes (for the lead)

1. Single file change: `AttachedFilesList.jsx`. No prop changes needed by callers (the
   `defaultCollapseThreshold` prop is optional).
2. Add `useState` + `useRef` imports. Component is currently a pure function — keep it a
   function component, just add the two hooks.
3. Compute `totalSize` with the existing `formatFileSize` (already imported) over
   non-loading files.
4. `showHeader = files.length >= threshold` gates the header; `expanded` gates the list.
   For ≤3 files `showHeader` is false and the list always shows.
5. Keep the existing wrapper card classes and the existing row markup byte-for-byte to
   avoid visual regressions — only wrap the list and conditionally add the header/footer.
6. Add the i18n keys to **both** `shared/i18n/en.json` and `de.json`.
7. Per CLAUDE.md: this is a user-visible change → add a `docs/releases/` changelog entry via
   the `/document-feature` skill after implementing.
8. Run `npm run lint:fix && npm run format:fix` before committing.

---

## Open Questions (confirm before building)

1. **Threshold = 4 or 3?** I recommend 4 (keeps useful 3-file lists visible, pain starts at
   4). Office uses 3 for a combined strip in a tiny pane. Confirm you're OK diverging.
2. **Override reset rule.** Reset on `files.length` change (re-applies auto-collapse when a
   4th file lands) vs. keep the user's override sticky once set. I recommend reset-on-count.
3. **Type-icon chips in the collapsed summary** — nice-to-have or cut for v1? I lean: ship
   text-only summary first, add chips later if desired.
4. **Migrate `filesCount` to proper i18next plurals?** Optional cleanup for correct German
   forms; not required for the fix.
5. **Office surface margins** — does the chat column there expect `mx-3` like
   `OfficeContextStrip`, or is `AttachedFilesList` already inside a padded container? Verify
   placement so the card doesn't double-pad on the task pane.
