# UI (visual) brief: EU AI Act Art. 50 epic (#3325, #3326, #3329)

Paths are relative to `/workspace/ihub-apps/client/src/`. Tailwind v4, config in `../tailwind.css`. Dark mode is `data-theme="dark"` on `<html>` (custom `dark:` variant), so use plain `dark:` classes. Icons: Heroicons via `shared/components/Icon.jsx` (`<Icon name="check-circle" size="sm|md|lg" />`; sizes are w-4/5/6).

## 0. Findings that shape every decision

- **Theming reality.** `/api/theme.css` publishes `--ih-primary`, `--ih-surface`, `--ih-text` and so on, but no client component reads them (grep: zero `var(--ih-*)`). Components hardcode the Tailwind **indigo** ramp (kept sRGB in `tailwind.css`) and gray neutrals. Customers re-theme through `customStyles.css` and the header colour.
  - Recommendation: follow the existing idiom (indigo-600 primary, gray surfaces), with no new hex values and no `style={{}}` colours. Anything that overrides indigo then carries over.
  - Status colours (green/amber/red/gray) are **semantic and must not follow the brand colour**.
  - Open question for the owner: should the new UI use `var(--ih-primary)`? I advise no, for consistency.
- **No shared Card, Button or Input component.** Cards are inline: `bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700` (see `features/admin/pages/AdminSecurityPage.jsx`). I define two small local wrappers (section 4) instead of copying the classes 6 times.
- **Primary button** (as in `ConfirmDialog`): `px-4 py-2 rounded-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed`. `AdminUsersPage` still uses blue-600 for "Add User"; do not copy that.
- **Secondary button**: `border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600` (same shape as primary).
- **Destructive**: solid red is **only** in the `ConfirmDialog danger` confirm button (`bg-red-600 hover:bg-red-700`, plus the triangle icon block). Triggers on the page are outline-danger: `border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/30`.
- **Status.** `shared/components/Badge.jsx` (tones `success|warning|danger|neutral|info|accent`, `icon` prop, `size sm`) carries text plus icon and has verified contrast in both themes. `StatusDot.jsx` is a dot only, so use it for small inline hints, not for traffic lights.

## 1. Reuse map

| Need | Existing file | Use |
|---|---|---|
| Dialog shell | `shared/components/Modal.jsx` (`labelledBy`, `initialFocusRef`, `closeOnBackdropClick`, `maxWidthClassName`) | ack dialog, key-reveal dialog |
| Confirm (destructive or not) | `shared/components/ConfirmDialog.jsx` (`danger`, focus starts on Cancel) | remove all, delete key, request again |
| Badges | `shared/components/Badge.jsx` | all statuses, technique chips |
| Table | `features/admin/components/data-table/DataTable.jsx` (`columns`, `hideBelow`, `actions[].destructive`, `loading`, `empty`, `pagination={false}`, `density="compact"`) | users column, key list |
| Empty / error / skeleton | `features/admin/components/AdminEmptyState.jsx`, `AdminLoadError.jsx` (`framed={false}` inside a card), `AdminPageSkeleton.jsx` | per card |
| Overflow menu | `features/admin/components/MoreActionsMenu.jsx` | users page "AI acknowledgements" menu |
| Copy | `features/admin/components/integrations/editors/InstallationEditorParts.jsx` -> `CopyableValue` | move to `shared/components/`, add a `multiline` prop (see 4.3) |
| Inline markdown + link | `features/chat/components/GreetingView.jsx` (`marked.parseInline` + `DOMPurify`) | notice and dialog text |
| Spinner | `shared/components/LoadingSpinner.jsx` is full-page; for buttons use the inline `animate-spin` svg from `AdminSecurityPage` | |
| Admin nav | `features/admin/components/AdminSidebarNavData.js` (heroicons outline) | new item `eu-ai-act`, `ScaleIcon`, in the Security group |

Icon names available in `Icon.jsx`: `check-circle`, `x-circle`, `exclamation-triangle`, `minus-circle`, `information-circle`, `shield-check`, `key`, `eye`, `eye-slash`, `copy`, `download`, `upload`, `trash`, `refresh`, `clock`, `beaker` (self-test), `photograph`, `musical-note`, `external-link`, `spinner`.

## 2. #3325 First-turn notice (empty chat)

**Where.** `features/apps/pages/AppChat.jsx` `renderStartupState()` feeds both layouts (mobile scroll area ~L3345, desktop centred stack ~L3398). Append the notice **inside `renderStartupState`'s return**, after `startupView(...)`, so both layouts get it once. New file `features/chat/components/AiFirstTurnNotice.jsx`. It renders only when `messages.length === 0`, so it vanishes on send, is never a message, and is never stored.

```
 Desktop / tablet (centred in the empty chat)       Mobile (360 px)
 ┌──────────────────────────────────────┐          ┌────────────────────────┐
 │            [ chat icon ]              │          │      [ chat icon ]      │
 │          Welcome to <App>             │          │     Welcome to <App>    │
 │     greeting or starter-prompt grid   │          │   starter prompts...    │
 │                                       │          │                         │
 │   (i) You are chatting with an AI     │          │ (i) You are chatting    │
 │       system. Answers can be wrong.   │          │     with an AI system.  │
 │       AI policy ↗                      │          │     AI policy ↗         │
 │  ┌────────────────────────────────┐  │          │ ┌─────────────────────┐ │
 │  │ composer                      >│  │          │ │ composer           >│ │
 └──────────────────────────────────────┘          └────────────────────────┘
```

**Component tree.** `AiFirstTurnNotice` -> `<p role="note">` -> `<Icon name="information-circle" size="sm" aria-hidden>` + text span (inline markdown, links allowed).

**Classes.** Calm, no box and no tinted border:
- Wrapper: `mt-6 mx-auto max-w-md px-4 flex items-start justify-center gap-2 text-center text-sm leading-5 text-gray-600 dark:text-gray-400`
- Icon: `mt-0.5 shrink-0 text-gray-500 dark:text-gray-400`
- Links: copy the usage-guide link from `StarterPromptsView.jsx`: `font-medium text-indigo-700 dark:text-indigo-300 underline underline-offset-2 rounded-sm focus-visible:ring-2 focus-visible:ring-indigo-500`; external links get `target="_blank" rel="noopener noreferrer"` plus an `sr-only` "(opens in a new tab)".
- Do **not** reuse `ModelHintBanner` or `ModelUsageNotice` styles: they are tinted boxes with `role="alert"`, which is exactly what this is not. Contrast: gray-600 on white is about 7.5:1; gray-400 on gray-900 is about 6.9:1.

**Behaviour and a11y.**
- Static text. No `role="alert"` or `aria-live` (it is present at load, so there is nothing to announce). DOM order puts it right before the composer, so screen-reader users meet it before the input.
- No dismiss button: "dismissible by sending" means it unmounts with the first send. Never fixed or sticky.
- Long customer text: `max-w-md`, wraps, no clamping (it is a legal text). Above 3 lines use `text-left`.
- Empty or disabled text: render nothing (no empty icon).
- Loading: while `hydrating` or `modeResolving`, `renderStartupState` already returns a spinner or null. The notice follows it, so it never flashes and then disappears for a stored chat.
- Motion: none.

## 3. #3326 Acknowledgement

### 3.1 Blocking dialog (chat) - new `features/chat/components/AiAcknowledgementDialog.jsx`

Built on `Modal` with `maxWidthClassName="max-w-lg"`, `closeOnBackdropClick={false}`, `labelledBy="ai-ack-title"`, `initialFocusRef` = the title (`tabIndex={-1}`, so screen readers read the text first and Enter cannot confirm by accident). Escape does the same as "Cancel" (the typed message stays in the composer, nothing is sent). Not an `alertdialog`: it needs reading, not an interruption.

```
┌─────────────────────────────────────────────┐
│ (i) Before you start                         │  icon disc: w-10 h-10 rounded-full
├─────────────────────────────────────────────┤  bg-indigo-100 dark:bg-indigo-900/40,
│ You are about to use AI tools. Confirm that │  icon text-indigo-700 dark:text-indigo-300
│ you have read our AI policy ↗ and that       │  body scrolls, max-h-[50vh]
│ results must be checked before use.          │
│ [error line, role=alert, only on failure]    │
├─────────────────────────────────────────────┤  footer: border-t px-6 py-4
│                   [ Cancel ] [ I understand ]│  bg-gray-50 dark:bg-gray-900/30
└─────────────────────────────────────────────┘
```

- Header `px-6 pt-6`, `h2 text-lg font-semibold text-gray-900 dark:text-white`. Body `px-6 py-4 text-sm leading-6 text-gray-700 dark:text-gray-300` (markdown sanitised like `GreetingView`).
- Footer `flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3`. On mobile both buttons are full width with `min-h-11` (44 px), primary on top. Cancel is secondary; confirm is primary indigo (not red, not green: it is consent, not danger).
- States:
  - default.
  - submitting: confirm shows an inline spinner plus "Saving…", both buttons `disabled`, panel `aria-busy="true"`.
  - error: red box above the footer (`AdminLoadError` classes, `role="alert"`, "Could not save your confirmation. Try again."); the button becomes "Try again".
  - success: the dialog closes and focus returns to the composer, never to `body`.
- Policy link inside the text: external-link icon and sr-only "(opens in a new tab)". The dialog stays open while the link is used in another tab.
- Dark: panel `dark:bg-gray-800`; overlay is `Modal`'s `bg-gray-600/50`.
- Motion: `Modal` has none; add none. Spinner `motion-reduce:animate-none`, the "Saving…" text stays.
- Small screens: `Modal` gives `p-4` and `max-h-[90vh]`. Check landscape phones: the body scrolls and the footer stays visible because the panel is `flex flex-col overflow-hidden`.

### 3.2 Admin users page additions - `features/admin/pages/AdminUsersPage.jsx`

- **Column** (insert after `authMethods`): `key: 'aiAck'`, header "AI acknowledgement", `hideBelow: 'md'`, sortable by date. A new `AiAckCell` in the same file, using `Badge size="sm"`:
  - valid: `tone="success"` `icon=check-circle` "Acknowledged v2", with the date under it (`text-xs text-gray-500 dark:text-gray-400`, same two-line pattern as `LastActiveCell`);
  - outdated (version < required): `tone="warning"` `icon=exclamation-triangle` "Outdated (v1)";
  - none: `tone="neutral" variant="outline"` `icon=minus-circle` "Not acknowledged".
  - The text hash is not shown in the table; show it as `font-mono text-xs` in `AdminUserViewPage.jsx` and in the CSV.
- **Filter**: add a fifth `FilterSelect` "AI acknowledgement" (All / Acknowledged / Outdated / Not acknowledged). Grid `grid-cols-1 sm:grid-cols-2 lg:grid-cols-5` (the current `md:grid-cols-4` would leave an orphan).
- **Bulk actions**: in the header, next to "Add User", one `MoreActionsMenu` "AI acknowledgements": Export CSV (download), Request again (refresh), a divider, then **Remove all** (trash, `text-red-700 dark:text-red-300`). The header stays at two controls; the full set is on the EU AI Act page. CSV honours the current filter. The menu is hidden when the feature is off.
- **Row action**: `actions` gets `{ id: 'removeAck', label: 'Remove acknowledgement', icon: 'trash', destructive: true }`, shown only if the user has entries. With 4 actions the DataTable kebab takes over (`kebabThreshold` 4).
- Confirmations through `ConfirmDialog`: single removal (danger), remove all (danger, message names the user count), request again (not danger: "Everyone is asked at their next message. Existing entries stay as history.").
- Result feedback: reuse the page's `message` banner (icon plus text); add `role="status"` to it (missing today).

## 4. #3329 Page `/admin/eu-ai-act`

New `features/admin/pages/AdminEuAiActPage.jsx`, card components in `features/admin/components/euAiAct/`. Route under `/admin` in `App.jsx` via `LazyAdminRoute`. Nav: `AdminSidebarNavData.js`, Security group, `ScaleIcon`.

Local building blocks (new, small):
- `EuAiActCard({ id, icon, title, description, actions, children })`: `<section aria-labelledby>`, `bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 overflow-hidden`; header `flex flex-wrap items-start justify-between gap-3 px-6 py-4 border-b border-gray-200 dark:border-gray-700` with `h2 text-lg font-semibold text-gray-900 dark:text-gray-100` and description `text-sm text-gray-600 dark:text-gray-400`; body `p-6`. Each card loads independently with its own skeleton, error (`AdminLoadError framed={false}` with Retry) and content states.
- `CheckStatus({ level })`: a `Badge` with a **different icon shape and a text word per level**: ok `success` check-circle "OK"; warn `warning` exclamation-triangle "Attention"; error `danger` x-circle "Failing"; off `neutral` minus-circle "Off"; checking `neutral` spinner "Checking…". Never colour alone (WCAG 1.4.1).

Page header: copy `AdminUsersPage` (`bg-white dark:bg-gray-800 border-b`, `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6`, `h1 text-3xl font-bold` plus one line of description). Right side: "Re-run checks" secondary button with refresh icon and "Last checked 12:04" (`text-xs`). Body `max-w-7xl ... py-8 space-y-6`. Headings: h1 page, h2 card, h3 per model.

**Layout.** Single column everywhere. The admin sidebar stays visible from `md`, so a 768 px tablet leaves only ~500 px of content: no card grids by breakpoint; `grid-cols-3` only for the small stat tiles. Tables hide secondary columns with `hideBelow` and sit in `overflow-x-auto`.

```
┌ EU AI Act (Art. 50) ───────────────────────  [↻ Re-run checks]  ┐
│ ┌ Configuration check ────────────  ✖ 2 failing  ⚠ 1 attention ┐│  summary Badges
│ │ ✔ OK     Guardrail active                                    ││
│ │ ✔ OK     First-turn notice text set          [Edit →]        ││  every row: icon+word,
│ │ ⚠ Attn   Acknowledgement on, enforcement off [Settings →]    ││  label, right-aligned
│ │ ✖ Fail   llama-70b (vLLM): no active key     [Add key ↓]     ││  fix link
│ │ ✖ Fail   llama-70b: detector unreachable                     ││
│ │ ⚠ Attn   gpt-5 (provider): statementRef missing [Model →]    ││
│ │ ✔ OK     Provenance retention 365 days                       ││
│ └──────────────────────────────────────────────────────────────┘│
│ ┌ Acknowledgements ───────────────────────────────────────────┐ │
│ │ [ 112 Acknowledged ] [ 8 Pending ] [ 120 Total ]  Version 3  │ │
│ │ [Export CSV] [Request again]             [Remove all (red)]  │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ ┌ Watermark keys ────────────────────────  [+ Generate key]   ┐ │
│ │ key_id        Created      Status               Actions      │ │
│ │ k-2026-11-a   2026-11-10   ✔ Active             [Reveal]     │ │
│ │ k-2026-09-c   2026-09-30   ◔ Retired            [Reveal][⋮]  │ │
│ │ ── Models ──────────────────────────────────────────────── │ │
│ │ llama-70b   Detector URL [____________] Token [Set ✓ Replace]│ │
│ │             [Save]  [Run self-test]   ✖ Failed: wrong key…   │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ ┌ Verification ───────────────────────────────────────────────┐ │
│ │ Paste text [textarea..............]  or  [ Choose file ]      │ │
│ │ [Verify]                                                     │ │
│ │ Result: ✔ Marked by this installation · Watermark · k-2026…  │ │
│ └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

### 4.1 Configuration check
`<ul role="list" class="divide-y divide-gray-200 dark:divide-gray-700">`; each `<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">`: `CheckStatus` (fixed `w-24` column so text lines up), label `text-sm text-gray-900 dark:text-gray-100`, optional detail `text-sm text-gray-600 dark:text-gray-400`, fix link `ml-auto text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:underline` (router `<Link>`, accessible name "Fix: <label>"). Failures sort first. The card-header summary is a row of Badges ("2 failing", "1 attention"), or one green "All checks passed". The live ping gives each row its own "Checking…" state; the list is `aria-busy` while any check runs, and a `role="status"` (polite) summary announces a re-run once. Loading: 5 skeleton rows (`h-4 bg-gray-200 dark:bg-gray-700 rounded-sm animate-pulse motion-reduce:animate-none`, `aria-hidden`) plus an `sr-only` "Loading checks". Error: `AdminLoadError framed={false}`.

### 4.2 Acknowledgements
Three tiles `grid grid-cols-3 gap-3`: `rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-4`, number `text-2xl font-semibold tabular-nums`, label `text-xs text-gray-600 dark:text-gray-400`. Pending gets a warning Badge when > 0 (the number itself stays neutral). Below: buttons `flex flex-wrap gap-3`; Remove all is outline-danger, pushed right with `sm:ml-auto`. The same three `ConfirmDialog`s as the users page; extract the handlers to `features/admin/hooks/useAiAcknowledgementActions.js` so both pages share one implementation. Export is a link-button with `download`. Empty state: "Acknowledgement is switched off" (info Badge plus link to the setting); actions hidden.

### 4.3 Watermark keys
- Key list: `DataTable columns=[key_id (font-mono text-xs), created (hideBelow 'sm'), status]`, `actions=[Reveal (eye), Delete (trash, destructive, retired only)]`, `pagination={false}`, `density="compact"`. Status: active = `Badge success` check-circle "Active"; retired = `Badge neutral` clock "Retired (detect only)". Empty: `AdminEmptyState icon="key"` with a "Generate key" CTA.
- **Generate** (primary button in the header; secondary "Add existing key" opens a form `Modal` with a textarea). Confirm first with a non-danger `ConfirmDialog`: "The current key becomes retired and detects only. Update vLLM afterwards."
- **Reveal / generated-key dialog** (`Modal max-w-2xl`, `closeOnBackdropClick={false}`, title "Watermark key k-…"), top to bottom:
  1. Amber callout (`bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-3`, `exclamation-triangle` icon, "Update vLLM with this key now. Showing it is written to the audit log."), pattern from `AdminSecurityPage`.
  2. **Secret display**: label plus `<textarea readOnly rows=2>` or `<pre tabIndex=0>` with `font-mono text-xs break-all bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded-md p-3 select-all`, `autoComplete=off`, `spellCheck=false`. Not inside a live region (never announce a secret); the Copy button's "Copied" text is the only live text (`aria-live=polite`, as in `CopyableValue`). No dots/mask: it was asked for explicitly.
  3. "vLLM config" snippet: same block style with a Copy button top-right (`absolute top-2 right-2`, as in `AdminSecurityPage`), `overflow-x-auto max-h-48 overflow-y-auto`, focusable so it scrolls by keyboard. It scrolls horizontally and never wraps (it is a command).
  4. Footer: one primary "Done". The key lives only in component state and is cleared on close (never `localStorage` or a URL).
- **Delete retired key**: `ConfirmDialog danger`; the message names the key_id and says "Text marked with it will no longer be verified".
- **Models** (h3 per model, `border-t pt-4`): fields in `grid grid-cols-1 md:grid-cols-2 gap-4`, labels `text-sm font-medium text-gray-700 dark:text-gray-300`, inputs `block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs sm:text-sm focus:ring-indigo-500 focus:border-indigo-500`. The token is write-only: it shows "Token set" (success Badge) and a "Replace" button; the stored token is never sent back to the page. Field error: `text-sm text-red-700 dark:text-red-300` with a warning icon and `aria-describedby`, input `border-red-500`.
- **Self-test** (secondary button per model): idle, then running (button `aria-disabled`, spinner, "Generating ~300 tokens…", expect 5-30 s, `motion-reduce:animate-none`), then pass or fail. The result sits in `role="status" aria-live="polite"` under the button. Pass = `CheckStatus ok` + "Detector recognised the key". Fail = `CheckStatus error` + reason in plain words ("The detector does not know this key. vLLM probably still runs the previous one.") + link "Show vLLM config". A run also updates the matching row in the Configuration check.

### 4.4 Verification
Layout `grid gap-4`: label plus `<textarea rows=6>` (same input classes), a divider "or" (`text-xs uppercase text-gray-500 dark:text-gray-400` between two `border-t` lines), then the file picker. A real `<input type=file accept="image/*,audio/*">` sits visually hidden (`sr-only`) behind a dashed drop zone `rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 p-6 text-center text-sm text-gray-600 dark:text-gray-400 hover:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500` with a visible "Choose file" button (drag-over: `border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20`). The chosen file shows as a chip with a remove button. "Verify" is primary, disabled until text or a file is present (say why via `aria-describedby`, not just greying). Running: button spinner plus "Verifying…", result region `aria-busy`.

Result panel `role="region" aria-labelledby aria-live="polite"`, `rounded-lg border p-4`. The header row carries the verdict with icon and word; a coloured `border-l-4` is decoration only.
- Match: `success` check-circle "Marked by this installation".
- No mark: `neutral` information-circle "No mark found", plus "This does not prove the content is human-made".
- Error: `danger` x-circle + reason + retry.
- Below, `<dl class="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">` with one row per technique (Watermark, Hash lookup, C2PA): technique name, a Badge (found / not found, icon+text) and, for a watermark, the `key_id` in `font-mono text-xs` and its status (active or retired). Technique and `key_id` are required output (CoP 2.3). For text under 200 tokens show "Short texts carry no watermark".

## 5. Cross-cutting
- **Contrast**: all pairs come from `Badge` and `ConfirmDialog` (>= 4.5:1). Focus rings: `focus-visible:ring-2 ring-indigo-500` with `ring-offset-2` and `dark:ring-offset-gray-800`. Targets >= 24 px (WCAG 2.5.8), 44 px for the chat dialog buttons on mobile.
- **Dark mode**: surface `dark:bg-gray-800` on page `dark:bg-gray-950`; borders `dark:border-gray-700`; inputs `dark:bg-gray-700`; code blocks `dark:bg-gray-900`.
- **Reduced motion**: the only motion is spinners and the skeleton pulse. Add `motion-reduce:animate-none` and keep a text label ("Checking…", "Saving…"). No transitions beyond `transition-colors`.
- **i18n**: all strings via `t('euAiAct.…', 'English default')` and `t('aiAck.…')`; add en and de.
- **Customer theming**: check once with a custom header colour and a dark theme that status colours do not clash; the notice and dialog use only gray and indigo.
- **Tests to expect**: axe in `tests/e2e/accessibility.spec.js` (dialog focus trap, status text), a unit test per `CheckStatus` level (icon plus word), a reduced-motion class check.
