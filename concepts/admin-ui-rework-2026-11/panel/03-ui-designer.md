# Panel deliverable: Senior UI (visual) designer

**Angle:** the "Visual P1s" row (AI-B3, ID-B7, ID-B9, CU-B6, PL-B5, PL-B6, SH-B9) and theme 4 (invisible controls, lost dark mode). I also specify the visual design of the confirm dialog (named-confirmations row) and the load-error state (load-gating row), because both rows ship UI that has to look the same everywhere.

Everything below was re-checked against the current code on 2026-11-16 (HEAD `24ec91d`). Corrections to the review are marked **[changed]**.

---

## 1. Angle summary

- **One root cause, and it can be fixed in one place.** Tailwind 4 Preflight sets `border: 0 solid` and `padding: 0` on every element. There is no `@tailwindcss/forms` (`client/tailwind.css:28` loads only `typography`), and the admin class strings say `border-gray-300` with no `border` width. A scan of `features/admin/**/*.jsx` finds **251 class strings** with `border-gray-300` and no width class (299 across the client; 48 are outside admin). The review's count of "~40" applies to one report only. A layered base rule, active only while the admin is mounted, gives every one of them a visible boundary and padding in one PR. It cannot override any explicit utility.
- **`INPUT_CLASS` does not meet WCAG 1.4.11 either.** Its `border-gray-300` against white measures **1.47:1**, and its dark `border-gray-600` against the gray-800 card measures **1.94:1**. The 3:1 threshold needs gray-500 in light (4.84:1) and gray-400 in dark (5.64:1 against the card, 3.96:1 against the gray-700 fill). "Use `INPUT_CLASS`" fixes the visible bug but not the WCAG failure PL-B6 is about. The token has to be retuned as well.
- **The end-user chat UI must not change. One admin page embeds it.** `AppTestPanel.jsx:9` renders the real `AppChat` inside the admin. So the scope cannot be "everything under `/admin`". It has to be "admin, minus marked `app` subtrees". This is the main source of blast radius, and it gets a regression check of its own.
- **Dark mode in the admin has a second, hidden cause.** In `App.css:378-402` an *unlayered* rule forces `bg-gray-700 border-gray-600 text-gray-100` on every typed input, select and textarea, app-wide. Unlayered CSS beats every Tailwind utility, so in dark mode the admin's own `dark:` classes on fields are ignored, and so are its red error borders (only `.admin-form-error-field` survives, through `!important`). I scope that rule out of the admin and leave it untouched for end users.
- **SH-B9 is partly fixed [changed].** `AdminLayout.jsx:53-54` now calls `useDarkMode()`, but only in `AdminLayoutInner`. The "Checking authentication…" and "Admin Access Required" screens (`:124-185`) still render light on a dark cold load. Nothing applies the theme before first paint either: `embedBootstrap.js:69-72` applies it only for `?mode=` or embed mode. The admin also still has no theme toggle.
- **`useDarkMode` instances do not share state.** Each caller keeps its own `preference` and its own `matchMedia` listener (`useDarkMode.js:29-30,62-86`). If a sidebar toggle is added next to `AdminLayout`'s bare call, the layout's stale `auto` listener will later override an explicit "dark" choice when the OS theme changes. The hook needs one shared store before a toggle ships.
- **PL-B5 is a one-token bug, but the token family is wrong.** `CookieSettingsConfig.jsx:172` is the *only* `*-primary-*` use in the client, and `@theme` has no `primary` ramp. Use `PRIMARY_BUTTON_CLASS`, retune it from `blue-600` to `admin-accent` (indigo-600, already in `tailwind.css:36`), and ban `-primary-\d` in CI.
- **ID-B9 is a class, not one page.** It covers 69 admin class strings with `text-gray-600..900` and no `dark:text-*`; `text-gray-700` on gray-800 measures **1.42:1**. Fix it with a mechanical codemod plus a ratchet test. Do not use a CSS backstop: guessing dark text colours in CSS breaks light preview surfaces.
- **Verification is computed-style, not screenshots.** A Playwright spec cold-loads each P1 route in light and dark and measures the border width, padding and border contrast against the effective background behind the field. It also asserts that `<html data-theme="dark">` is set at `domcontentloaded`, and that the chat composer's computed style is byte-identical to the base commit.

---

## 2. Now-phase plan (my angle)

I'd ship four small PRs, in this order. PR V1 and V2 are independent; V3 depends on V1 (tokens); V4 is the shared dialog/error visuals used by the load-gating and named-confirmation PRs.

### PR V1: "Admin controls are visible" (AI-B3, ID-B7, CU-B6, PL-B6; enables 1.4.11)

| # | Work item | Finding IDs | Files (current lines) |
|---|---|---|---|
| V1.1 | Add tokens `admin-control-border`, `admin-control-border-dark`, `admin-accent-fg-dark` to `@theme` | theme 4 | `client/tailwind.css:33-44` |
| V1.2 | `useSurface('admin')` sets `html[data-surface="admin"]` while `AdminLayout` is mounted (outer component, so the loading and denied screens are covered); `AppTestPanel` root gets `data-surface="app"` | scope | `AdminLayout.jsx:119`; `AppTestPanel.jsx` root |
| V1.3 | Scoped base rule for admin controls (exact CSS below) | AI-B3, ID-B7, CU-B6, PL-B6, AX-B25, IN-B10 | `client/src/App.css` (new block after `:20`) |
| V1.4 | Exclude the admin from the global unlayered dark-input rule, with specificity unchanged | ID-B9 (fields), CU-B27 | `App.css:378-402` |
| V1.5 | Retune `formStyles.js`: control border to the token, focus to the accent, checkbox to `accent-*` | PL-B6, AI-UI1, CU-UI1, IN-UI1 | `formStyles.js:10-32` |
| V1.6 | Move the cited P1 editors onto `INPUT_CLASS` / `LABEL_CLASS` / `CHECKBOX_CLASS`, so they pass 1.4.11 strictly | AI-B3, ID-B7, CU-B6, PL-B6 | `BasicInfoSection.jsx:56`, `InputModeSection.jsx`, `UploadConfigSection.jsx`, `StarterPromptsSection.jsx`, `VariablesSection.jsx`, `ModelFormEditor`, `PromptFormEditor`; `UserFormEditor.jsx:188,220,240,366,394`; `GroupFormEditor.jsx:174,203`; `AdminShortLinkEditPage.jsx:170,194,206,218,252,263`; `AdminPageEditPage.jsx:135,158,203`; `TranslationOverridesEditor.jsx:118,138,195`; `AdminLocalizationPage.jsx:180`; `AdminVoiceInputPage.jsx:260,533`; `voice/*`; `tts/TtsVoicesPanel.jsx:257`; `updates/InstallFromFileCard.jsx:315`; `updates/StagedUpdatePanel.jsx:240` |
| V1.7 | Playwright check: `tests/e2e/admin-controls-visible.spec.js` (spec below) | all above | new |
| V1.8 | Ratchet unit test `tests/unit/client/admin-class-hygiene.test.js`: counts borderless control strings, `-primary-\d`, and gray text with no dark variant under `features/admin`; fails if any count rises | enforcement (README §"Enforcement") | new, with a baseline JSON |

**Exact CSS for V1.3** (in `App.css`, not `tailwind.css`, so the Office, extension and Nextcloud entry points, which share `tailwind.css`, are untouched):

```css
/* Admin form controls. Tailwind 4 Preflight zeroes border-width and padding on
   every element, and the admin's class strings were written for
   @tailwindcss/forms. This is in @layer base, so ANY utility on the element
   (border-0, px-0, bg-transparent, border-red-500 …) still wins. It applies only
   while AdminLayout is mounted (html[data-surface='admin']). Subtrees marked
   data-surface='app' (the test panel's embedded chat), [data-bare] and
   third-party editors opt out. */
@layer base {
  [data-surface='admin']
    :is(
      input:not([type='checkbox'], [type='radio'], [type='range'], [type='color'],
        [type='file'], [type='hidden'], [type='button'], [type='submit'],
        [type='reset'], [type='image']),
      select,
      textarea
    ):not([data-surface='app'] *, [data-bare], .monaco-editor *, .react-flow *) {
    border: 1px solid var(--color-admin-control-border);
    border-radius: var(--radius-md);
    padding: calc(var(--spacing) * 2) calc(var(--spacing) * 3); /* 8px 12px */
    background-color: var(--color-white);
    color: var(--color-gray-900);
  }
  /* dark: same selector, prefixed with [data-theme='dark'] on html */
  [data-surface='admin'][data-theme='dark'] :is(/* same list */):not(/* same */) {
    border-color: var(--color-admin-control-border-dark);
    background-color: var(--color-gray-700);
    color: var(--color-gray-100);
  }
  /* disabled: exempt from 1.4.11, but still recognisable as a field */
  [data-surface='admin'] :is(/* same */):disabled {
    border-color: var(--color-gray-300);
    background-color: var(--color-gray-100);
    color: var(--color-gray-500);
    cursor: not-allowed;
  }
  [data-surface='admin'][data-theme='dark'] :is(/* same */):disabled {
    border-color: var(--color-gray-600);
    background-color: var(--color-gray-800);
    color: var(--color-gray-400);
  }
  /* A visible focus indicator for strings that set focus:ring-<colour> with no
     width (43 admin strings have focus:outline-hidden with no ring width). */
  [data-surface='admin'] :is(/* same */):focus-visible {
    outline: 2px solid var(--color-admin-accent);
    outline-offset: 1px;
  }
  [data-surface='admin'][data-theme='dark'] :is(/* same */):focus-visible {
    outline-color: var(--color-admin-accent-fg-dark);
  }
  [data-surface='admin'] :is(input[type='checkbox'], input[type='radio']) {
    accent-color: var(--color-admin-accent);
  }
  [data-surface='admin'][data-theme='dark'] {
    color-scheme: dark; /* native checkboxes, date pickers, select popups */
  }
}
```

Write the selector list once. Stylelint or PostCSS can't share it, so put a comment pointing to one canonical copy. Specificity is (0,3,1). That beats Preflight's `input, select, textarea` (0,0,1) inside the same `base` layer, and it loses to every utility because of layer order. That is the whole point of the design.

**V1.4: global dark rule.** Append `:where(:not([data-surface='admin'] *), [data-surface='app'] *)` to each selector at `App.css:378-402` (the typed inputs, placeholder and disabled blocks). `:where()` adds zero specificity, so on end-user pages the rule matches exactly as before. Inside the admin, the field's own `dark:` utilities and the base rule take over. Inside the test panel's chat, the global rule applies again.

**V1.1 tokens** (`tailwind.css` `@theme`, next to the existing `admin-*` tokens):

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--color-admin-accent` | `#4f46e5` (exists) | primary button bg, focus ring (light), checkbox accent | white text 6.29:1; ring vs white 6.29:1 |
| `--color-admin-accent-hover` | `#4338ca` (exists) | primary hover | — |
| `--color-admin-accent-fg-dark` **new** | `#818cf8` (indigo-400) | focus ring, links and icons in dark | vs gray-800 4.92:1, vs gray-900 5.95:1 |
| `--color-admin-control-border` **new** | `var(--color-gray-500)` | field boundary, light | vs white 4.84:1, vs gray-50 4.63:1 |
| `--color-admin-control-border-dark` **new** | `var(--color-gray-400)` | field boundary, dark | vs card gray-800 5.64:1, vs fill gray-700 3.96:1 |

Put the two `var()` tokens in `@theme inline { … }` so the generated utilities resolve to the gray value and not to a chained variable. The existing `--color-admin-border` (#e5e7eb) stays for decorative card borders, which 1.4.11 does not cover.

**V1.5 `formStyles.js` retune** (exact edits):
- `INPUT_CLASS`: `border-gray-300 dark:border-gray-600` → `border-admin-control-border dark:border-admin-control-border-dark`; `focus:border-blue-500 focus:ring-blue-500` → `focus:border-admin-accent focus:ring-admin-accent dark:focus:ring-admin-accent-fg-dark`; `disabled:opacity-60` → `disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed`. Opacity on a field also fades the border below what can be recognised.
- `CHECKBOX_CLASS` / `RADIO_CLASS`: drop `border-gray-300 text-blue-600 rounded-sm`, which do nothing on native controls without the forms plugin; use `h-4 w-4 accent-admin-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-admin-accent`.
- `PRIMARY_BUTTON_CLASS`: `bg-blue-600 hover:bg-blue-700 focus:ring-blue-500` → `bg-admin-accent hover:bg-admin-accent-hover focus:ring-admin-accent dark:focus:ring-admin-accent-fg-dark`.
- `SECONDARY_BUTTON_CLASS`: keep the `border-gray-300` (the button text identifies it; 1.4.11 does not need a boundary there); change only the focus ring colour.

**Done when (V1):**
1. On every route in the spec list, every visible text-like `input`, `select` and `textarea` has `border-top-width >= 1px`, `padding-left >= 8px`, and border contrast of at least **3:1** against the effective background, in light and dark. This holds on cold load and inside open dialogs.
2. On all other admin routes (crawl-based ratchet): border width at least 1px, and contrast at least 1.3:1 so the boundary is visible. The count of strict 3:1 failures is recorded in a baseline file and can only go down.
3. Chat composer on `/apps/chat` (and the test panel's chat) has computed `border-*`, `padding-*`, `background-color` and `color` identical to the base commit, in light and dark.
4. `npm run lint:fix && npm run format:fix` are clean, the axe baseline does not get worse, and there is a `docs/releases/next/` entry ("Admin form fields have visible borders in light and dark mode"), decided by `document-feature`.

**Approval flags (V1):** no API, config or behaviour change. It is a **visible restyle of the admin**: field borders get darker everywhere, and primary buttons on Document templates, the people pages and the other `formStyles` users turn from blue to indigo. README "Decisions" does not cover the brand colour. I picked indigo because roadmap 3B-3 and 82 vs 48 uses favour it (CU-UI1). I list this under §6 as a question.

### PR V2: "Dark mode survives a cold load" (SH-B9 = ID-B8 = OB-B17 = PL-B19)

| # | Work item | Files |
|---|---|---|
| V2.1 | **Shared theme store.** `themePreference.js` gets `subscribe(fn)` and `getSnapshot()` plus one module-level `matchMedia` listener. `useDarkMode` becomes a `useSyncExternalStore` wrapper with the **same return shape** (`preference`, `isDark`, `setPreference`, `toggleMode`, `enable*`). All callers (`DarkModeToggle`, `DualModeEditor`, `AdminLayout`) then agree. | `utils/themePreference.js`, `hooks/useDarkMode.js` |
| V2.2 | **Pre-render apply.** In `embedBootstrap.js:69-72`, always call `applyThemeToDocument(resolveIsDark(getStoredPreference()))`, not only with `mode` or embed. This runs at module evaluation, before React's first render, for every route. | `utils/embedBootstrap.js` |
| V2.3 | **Pre-paint script** in `client/index.html` `<head>`, after the base-path IIFE: about 8 lines that read `localStorage['ih-dark-mode']` (fallback `matchMedia`) and set `data-theme` plus the `dark` class. It **does nothing** when the URL has `embed` or `mode`, or when the embed session flag is set; `embedBootstrap` stays in charge there. A unit test (like `known-routes-sync.test.jsx`) checks that the inline logic matches `resolveIsDark` for the six (stored × OS) cases. | `client/index.html` |
| V2.4 | Move the `useDarkMode()` call from `AdminLayoutInner` (`:54`) to the outer `AdminLayout` (`:119`), so the loading and access screens are themed too. | `AdminLayout.jsx` |
| V2.5 | **Admin theme toggle** in the sidebar footer, reusing `DarkModeToggle`. It cycles through three states (Auto, Light, Dark), shows a visible text label (not icon only) and `aria-label="Theme: Auto (follows system)"`, and is 36px high to match the buttons. Also add "Theme: …" to Cmd+K. | `AdminSidebar.jsx`, `AdminCommandPalette` |

**Done when (V2):** in Playwright, with `colorScheme: 'dark'` and no stored preference, and separately with stored `dark` plus OS light, a direct load of `/admin`, `/admin/users`, `/admin/auth` and `/admin/does-not-exist` has `data-theme="dark"` already at `domcontentloaded`, and that holds through the auth check. A stored `light` with OS dark gives light. `?mode=light&embed=true` still wins. After the user picks Dark in the toggle, emulating an OS change to light leaves the admin dark (this is the shared-store regression). Release note: "The admin follows your light/dark choice on first load and has its own theme switch."

**Approval flags (V2):** the pre-paint script and the bootstrap change affect **every route's cold load**, not just the admin. The behaviour does not change (end-user pages already end up with the same theme once `DarkModeToggle` mounts); only the timing moves earlier. Low risk, but it is shipped behaviour on end-user pages, so I'd name it in the PR.

### PR V3: "Dark labels and the Cookies button" (ID-B9, PL-B5; also AX-B26, PL-B29 if cheap)

| # | Work item | Files |
|---|---|---|
| V3.1 | `CookieSettingsConfig.jsx:172` → `PRIMARY_BUTTON_CLASS`, with the spinner kept | PL-B5 |
| V3.2 | Codemod: in `features/admin/**/*.jsx`, a class string with `text-gray-N` (N ∈ 600, 700, 800, 900) and no `dark:text-*` gets `dark:text-gray-{400,300,200,100}`. **Review every diff by hand**: `StepDetails.jsx` (13) and `ArtifactViewer.jsx` (3) may render on a fixed light surface. Priority files: `LocalAuthSection.jsx:80,96`, `PlatformFormEditor.jsx`, `NtlmAuthSection.jsx`, `OidcProvidersSection.jsx` (ID-B9: the auth page, security task). | ID-B9 |
| V3.3 | The same codemod for `bg-white` with no `dark:bg-*` (16 strings) | AX-B26 white buttons |
| V3.4 | Wrap each `/admin/auth` checkbox and its text in one `<label>` with `CHECKBOX_CLASS` | ID-B9 |

**Done when (V3):** the Cookies Save button has a non-transparent computed background with white text, at 4.5:1 or more, in both themes. Every text node on `/admin/auth` in dark measures at least 4.5:1 (axe `color-contrast` on that route in dark mode, run in the new spec). The ratchet test baseline for "gray text without a dark variant" goes down by at least the ID-B9 files.

### PR V4: shared visuals for the dialog and the load error (used by the load-gating and named-confirmation PRs)

Specified in §3 (`ConfirmDialog` additions, `AdminLoadError` redesign). From my angle, done means: one look in both themes, every colour pair listed below passes, keyboard and screen-reader behaviour as specified, en+de strings.

### Verification: the Playwright computed-style check (V1.7)

`tests/e2e/admin-controls-visible.spec.js`, run by `tests/config/playwright.config.js` against the e2e server (fresh `contents/`).

- **Projects:** `light` (`colorScheme: 'light'`, `addInitScript` sets `localStorage['ih-dark-mode']='light'`) and `dark` (the same with `'dark'`). A third case, `auto-dark`, sets no stored key and uses `colorScheme: 'dark'`, which exercises SH-B9.
- **Login:** `page.request.post('/api/auth/local/login', { data: { username: 'admin', password: 'password123' } })` (CLAUDE.md default admin). The cookie lands in the context.
- **Strict routes (P1, at least 3:1):** `/admin/apps/chat`, `/admin/apps/new`, `/admin/models/<first>`, `/admin/prompts/new`, `/admin/users/new`, `/admin/groups/new`, `/admin/auth`, `/admin/shortlinks/new`, `/admin/pages/new`, `/admin/localization`, `/admin/voice-input`, `/admin/updates`, `/admin/system` (Cookies). Also every route under both base paths (`CRAWL_BASE_PATH=/ihub`), because subpath cold loads are where theme and base-path bugs meet.
- **Ratchet routes:** reuse the link discovery in `route-crawl.spec.js`, and store a per-route count of strict failures in `tests/e2e/baselines/admin-controls.json`.
- **Measurement in `page.evaluate`:**
  1. Select `#admin-main-content` plus `[role=dialog], [role=alertdialog]` → text-like `input`, `select`, `textarea` (same exclusions as the CSS), and keep those with a non-zero bounding box and `visibility != hidden`.
  2. Read `getComputedStyle(el)`: `borderTopWidth`, `borderTopStyle`, `paddingLeft`, `borderTopColor`.
  3. **Colour gotcha:** Chrome returns `oklch(...)` for Tailwind 4 colours, so do not regex-parse `rgb()`. Normalise each colour by painting it on a 1×1 `<canvas>` (`ctx.fillStyle = c; ctx.fillRect; getImageData`); that gives sRGB bytes.
  4. Effective background: walk up the ancestors until a `background-color` with alpha 1 is found, compositing semi-transparent layers on the way (cards such as `dark:bg-red-900/30`).
  5. Contrast is the WCAG relative-luminance ratio of border against the effective background. Assert width ≥ 1, style ≠ `none`, padding-left ≥ 8 (≥ 4 for `select`), and contrast ≥ 3 on strict routes.
  6. Also assert in dark: `getComputedStyle(field).backgroundColor` luminance < 0.2. This catches fields with `bg-white` and no dark variant, which V1.4 now exposes.
- **Theme assertions:** `page.goto(url, { waitUntil: 'domcontentloaded' })`, then `expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')` before any network idle wait (pre-paint). Then again after `networkidle` (no flip back).
- **End-user non-regression:** on `/apps/chat` and on the admin test panel, snapshot the computed style of the composer `textarea` and of every `input` in `ChatInput` (border*, padding*, background-color, color, outline) into `tests/e2e/baselines/chat-composer-style.json`. Capture this file on the base commit in a first commit of the PR, then assert `toEqual` in light and dark.
- **Failure output:** route, theme, a CSS path of the element, the measured values, and the `className`, so a junior can fix it from the CI log alone.

---

## 3. Shared components, hooks and layers

### `useSurface(name)` (new, `client/src/shared/hooks/useSurface.js`)
```js
useSurface('admin'): void  // sets document.documentElement.dataset.surface = name on mount; restores the previous value on unmount
```
StrictMode-safe: it stores and restores the previous value and does not blindly delete. It closes the scoping problem for AI-B3, ID-B7, CU-B6 and PL-B6, and for portals (dialogs, drawers), which render outside `#admin-main-content`. The `data-surface="app"` marker on `AppTestPanel` uses a plain attribute, not the hook.

### Theme store (`utils/themePreference.js` + `hooks/useDarkMode.js`)
```js
subscribe(listener): () => void
getSnapshot(): { preference: 'auto'|'light'|'dark', isDark: boolean }
setPreference(p): void   // stores, applies, notifies; one matchMedia listener total
```
`useDarkMode()` keeps its API. It closes SH-B9, ID-B8, OB-B17 and PL-B19, and it is what makes an admin toggle safe.

### `formStyles.js` tokens (retuned, V1.5)
These are the Now-phase "component". In Next they become the implementation of `AdminInput` / `AdminSelect` / `AdminTextarea` / `AdminCheckbox` / `AdminButton` (roadmap 3B-3). Closes AI-B3, ID-B7, CU-B6, PL-B6, PL-B5 and AI-UI1.

### `ConfirmDialog` (extended, `shared/components/ConfirmDialog.jsx`), visual and API spec

Additive props (the existing callers keep working):

| Prop | Type | Purpose |
|---|---|---|
| `tone` | `'default' \| 'warning' \| 'danger'` | replaces `danger` (kept as an alias, which is an internal prop and not an external API) |
| `consequences` | `ReactNode[]` | bullet list of what will happen ("3 users lose access to …") |
| `confirmText` | `string?` | if set, the user must type it exactly (trimmed, case-sensitive) |
| `irreversible` | `boolean` | shows the "This cannot be undone." callout |
| `busy` | `boolean` | spinner on confirm; both buttons disabled; Esc and backdrop ignored |
| `error` | `string?` | inline error callout; the dialog stays open |
| `confirmLabel` | `string` | **required when `tone='danger'`**: verb plus object, e.g. "Delete group "sales"". Never "OK" or "Confirm" |

Layout (4px grid):
```
┌──────────────────────────────────────────────── max-w-md (448) ─┐
│ p-6 (24)                                                         │
│ (●!) 40×40 disc   Title  text-lg/semibold  (18/28)               │
│      red-100 /    Message text-sm gray-600 / dark gray-300       │
│      red-900/40   • consequence 1        (mt-3, space-y-1)       │
│                   • consequence 2                                │
│                   ┌ CALLOUT danger: This cannot be undone. ┐ mt-4│
│                   Type  sales  to confirm   (LABEL_CLASS; code   │
│                   chip font-mono bg-gray-100 / dark bg-gray-700) │
│                   [ MONO_INPUT_CLASS, autocomplete=off ]   mt-1  │
│                   ┌ CALLOUT danger (role=alert) if error ┐       │
├──────────────────────────────────────────────────────────────────┤
│ px-6 py-4  bg-gray-50 / dark bg-gray-900/30  border-t            │
│                          [ Cancel ]  [ ⟳ Delete group "sales" ]  │
└──────────────────────────────────────────────────────────────────┘
```
- Backdrop `bg-black/50`, and `bg-black/70` in dark (the gray-800 panel on a gray-950 page measures 1.37:1, so the panel has to stand out through the backdrop and `shadow-xl`). Panel `rounded-md` to match `formStyles` (it is `rounded-lg` today, `ConfirmDialog.jsx:81`).
- Buttons come from `SECONDARY_BUTTON_CLASS` and a new `DANGER_SOLID_BUTTON_CLASS` (`bg-red-600 hover:bg-red-700 text-white`: white on red-600 4.77:1; ring red-500 with offset). Today's hand-written classes (`:117,:124`) go away. Buttons are at least 36px high (2.5.8). Below 400px the footer stacks as `flex-col-reverse` with full-width buttons, so the confirm button sits on top and Cancel at the bottom, nearest the thumb.
- A disabled confirm button (text not yet matched) keeps the danger fill at `opacity-50` with `cursor-not-allowed`, and uses `aria-describedby` to point at the "Type … to confirm" hint.
- Focus: on open it goes to the type-to-confirm input if there is one, otherwise to Cancel (as today, `:43-47`). It returns to the trigger on close. The trap already exists.
- Screen reader: `role="alertdialog"`, labelled by the title and described by the message plus the consequences. `busy` sets `aria-busy="true"`, and a polite live region says "Deleting…". On success the caller announces the result ("Group "sales" deleted") in its page-level live region, because the dialog has unmounted by then.
- Icon disc: `exclamation-triangle`, red-700 / dark red-400, `aria-hidden`. In the warning tone, amber-700 on amber-100.

### `AdminLoadError` (redesigned, `features/admin/components/AdminLoadError.jsx`), the load-gating visual

Current problems (`AdminLoadError.jsx:29-49`): Retry is plain red text with no button affordance and no focus style, and it does `window.location.reload()`, which throws away any state on other parts of the page. The icon is red-400 on red-50 (2.64:1) and is not hidden from screen readers. There is no difference between "you may not" (403), "try again" (429/5xx/network) and "not found" (404).

Additive props: `onRetry?: () => Promise<void>` (preferred over a reload), `status?`, `code?` (from problem+json), `resourceLabel` ("authentication settings"), `secondaryAction?`.

```
Page header + breadcrumb stay (the admin knows where they are)
┌ border red-200 / dark red-800 · bg red-50 / dark red-900/30 · rounded-md · p-4 ┐
│ (!) 20px red-700 / dark red-400, aria-hidden                                   │
│     Couldn't load authentication settings   text-sm semibold red-800 / red-200 │
│     <problem+json detail>                   text-sm red-700 / red-300          │
│     Nothing was changed. Saving is off until the settings load.   (same)      │
│     ▸ Technical details   (<details>: status, code, time; font-mono text-xs)    │
│     [ ⟳ Retry ]  (DANGER_BUTTON_CLASS outline style, 36px)   Open docs ↗        │
└─────────────────────────────────────────────────────────────────────────────────┘
(no form, no sticky save bar rendered below)
```
- Tone by status: **403** neutral (gray callout, lock icon, "You don't have access to …", no Retry). **404** neutral with "Back to <list>". **429/5xx/network** red with Retry. **409/412** is a save error, not a load error (another row).
- Retry: shows a spinner and "Retrying…", `aria-busy`, and the button stays focused. If it fails, the text updates (the `role="alert"` container re-announces). If it succeeds, the panel unmounts, focus moves to the page `<h1>`, and a polite live region says "Settings loaded".
- The gated form is **not rendered** (not rendered disabled). A disabled ghost form with a disabled Save invites the misreading that the values shown are real (ID-B1).
- Contrast: red-800 on red-50 and red-700 on red-50 (5.87:1) pass; dark red-200 and red-300 on red-900/30 over gray-950 pass (check with the Playwright helper's compositing).

---

## 4. Next and Later notes

- **Next:** `AdminField` + `AdminInput`/`Select`/`Textarea`/`Checkbox`/`AdminButton` (3B-3), built on the V1 tokens. Then a scripted codemod for the remaining ~200 `border-gray-300` control strings (jscodeshift on JSX `input`/`select`/`textarea` under `features/admin`), so every route reaches the strict 3:1. Ratchet the baseline down to zero, then delete the base rule's border-colour fallback, but **keep** the rule as a safety net.
- **Next:** the 48 borderless strings outside the admin (`AppCreationWizard`, `TaskEditorPage`, `PromptEditorModal`, `projects/item-dialog/*`, `workflows/editor/panels/forms/*`). These are end-user UI and need a product decision and their own screenshots. The admin scope deliberately leaves them alone.
- **Next:** retire the unlayered global dark-input rule (`App.css:378-402`) in favour of explicit `dark:` utilities in the end-user components. It hides end-user error borders in dark too.
- **Next:** a custom React Flow node type and dark controls (AX-B20, AX-B26); one radius scale; `text-2xl` page titles (IN-UI1).
- **Later:** a `primary` semantic token layer (`--admin-primary` → accent) if white-label theming of the admin is wanted. Today admin colours are deliberately not customer-themable.

---

## 5. Pre-mortem

| # | How it failed | Mitigation |
|---|---|---|
| 1 | **The chat in the admin test panel changed**: the composer got a second border and padding, because the base rule matched it. | `data-surface="app"` opt-out on `AppTestPanel`; the chat-composer computed-style baseline assertion; the selector also excludes `[data-bare]`. |
| 2 | **`data-surface="admin"` leaked to end-user pages** after client-side navigation from `/admin` to `/apps/x` (StrictMode double effect, or a missing cleanup), restyling chat inputs. | `useSurface` restores the previous value; a Playwright step navigates admin → chat with the router (no reload) and asserts the attribute is absent and the composer style matches the baseline. |
| 3 | **Double borders** on inputs that sit inside a bordered wrapper (search with icon, tag inputs, combobox) and relied on Preflight's 0 border. | Before merging, grep admin `input`s whose parent has `border` + `focus-within:`; add `data-bare` or `border-0` to them. The Playwright run also flags fields whose parent has a ≥1px border of the same colour. |
| 4 | **White fields in dark mode** after V1.4: fields with `bg-white` and no `dark:bg-*` lost the global rule that used to paint them gray-700. | The dark check asserts field background luminance < 0.2; the V3.3 codemod; ship V1 and V3 in the same release. |
| 5 | **Dark error borders now show up, but in the wrong colour**, or `focus:ring-indigo-500` overlaps the new outline into a "double ring". | Error borders become visible again intentionally (V1.4); check `border-red-500` against gray-800 (passes). The outline is on `:focus-visible` with offset 1px; where a string has a real `ring-2`, set `focus:outline-hidden` (already in `INPUT_CLASS`) so only the ring shows. |
| 6 | **Monaco / CodeMirror / React Flow internals got borders**, e.g. a visible box around Monaco's hidden `inputarea`. | `.monaco-editor *, .react-flow *` are excluded; library CSS is unlayered and wins anyway. The spec opens the JSON editor (`DualModeEditor`) and the workflow canvas in both themes. |
| 7 | **The pre-paint script fought embed mode**: a host's `?mode=light` was overridden by the user's stored dark. | The script returns early on `embed`, `mode` or the embed session flag; the parity unit test covers these cases; an e2e covers `?embed=true&mode=light`. |
| 8 | **The theme toggle "forgot" the choice** when the OS changed theme (two `useDarkMode` instances). | Shared store (V2.1) ships before or with the toggle; e2e: choose Dark, emulate OS light, still dark. |
| 9 | **Customers saw blue → indigo buttons and darker borders and filed bugs**, and screenshots in `docs/` went stale. | A release note with before/after; docs screenshots are listed in the PR; the brand-colour question goes to the maintainers up front (§6). |
| 10 | **Customer custom CSS** (`uiConfig.customStyles.css`, injected unlayered by `UIConfigContext.jsx:137-150`) targets `input` and now looks different in the admin, or overrides the fix. | Unlayered customer CSS still wins (unchanged power). Mention in the release note that admin fields now get a default border from a layered rule. |
| 11 | **German strings were missing** for the new dialog and error texts, and the theme toggle label showed English in a German admin. | Add en+de keys in the same PR; the translation-key ratchet (Now row AX-B7/SH-B13) covers new keys. |
| 12 | **The test was flaky or blind**: oklch colours were parsed as NaN and passed, or hidden fields were measured. | Canvas normalisation; assert at least N fields measured per strict route (a route with 0 measured fields fails); skip zero-size elements explicitly. |
| 13 | **Scope creep**: V1 turned into the full `AdminInput` migration, and the "S" row took three weeks. | V1 only touches tokens, the base rule and the cited P1 files. Everything else is the ratchet's job in Next. |
| 14 | **Forced-colors / high-contrast mode regressed.** | The existing `@media (forced-colors: active)` rule (`App.css`) sets `border: 1px solid ButtonText` and stays unlayered, so it wins. Run the spec once with `forcedColors: 'active'`. |

---

## 6. Questions I have NOT asked

1. **Brand primary in the admin: indigo or blue?** It matters because V1.5 recolours every `formStyles` primary button. *Default:* indigo (`admin-accent`), per roadmap 3B-3 and CU-UI1.
2. **Is a visibly darker field border (gray-500) acceptable, or do you accept gray-300 and a documented 1.4.11 deviation?** It decides whether the restyle passes WCAG or is only "visible"; it also matters for BITV/BFSG tenders. *Default:* gray-500 / gray-400 (pass).
3. **Should the admin share the end-user theme preference (`ih-dark-mode`) or have its own?** An admin may want a dark admin and a light chat. *Default:* shared (one key, simplest, matches today).
4. **Are there other places that embed end-user components inside the admin** besides `AppTestPanel` (previews in UI customization, page previews, the prompt library preview)? Each needs `data-surface="app"`. *Default:* audit by grep for imports from `features/{apps,chat,canvas}` in `features/admin` and mark all of them.
5. **Browser support floor?** `:not()` with complex selector lists needs Chrome 88+, Firefox 84+ or Safari 9+. *Default:* the evergreen browsers in the README; no fallback.
6. **Do on-prem customers rely on `customStyles.css` inside the admin?** It decides whether the release note needs a migration hint. *Default:* mention it, no shim.
7. **Should a load error hide the form completely or show a disabled read-only copy?** The UX and admin experts may differ. *Default:* hide (ID-B1 reasoning).
8. **Is `role="alertdialog"` for every confirmation right, or only for destructive tones?** *Default:* `alertdialog` for `warning`/`danger`, `dialog` for `default`.
9. **Should the 48 end-user borderless fields be in this release at all?** *Default:* no; Next, with product sign-off.

---

## 7. Decisions I made on my own

- **The scope lives on `<html data-surface>`**, not on `#admin-main-content`. Portalled dialogs and drawers would otherwise miss the rule.
- **The rule is in `@layer base` in `App.css`**, not unlayered and not in `tailwind.css`. That way utilities always win (minimal restyle), and the Office, extension and Nextcloud bundles do not get it.
- **The global dark rule is scoped out of the admin with `:where()`** instead of being rewritten, so end-user specificity and behaviour stay byte-identical.
- **I treat a field boundary as required by 1.4.11** (the W3C Understanding examples) and target 3:1 instead of accepting gray-300.
- **Tokens are added to the existing `admin-*` family**, with no new `primary` ramp, and `-primary-\d` is banned by the ratchet test.
- **No CSS backstop for dark text colours (ID-B9).** A codemod with review is safer than CSS that guesses the surface colour.
- **The pre-paint script deliberately skips embed and `mode` cases**, leaving them to `embedBootstrap`.
- **The theme toggle reuses `DarkModeToggle`** (three states) instead of new UI, and shows a visible label.
- **The ratchet is a unit test with a baseline JSON**, not an ESLint plugin. `eslint-plugin-tailwindcss` does not support Tailwind 4 class semantics reliably, and the repo already uses this pattern (`known-routes-sync.test.jsx`).
- **`AdminLoadError` gets `onRetry`** (refetch) and keeps the reload only as a fallback, which is additive.
- **`danger` on `ConfirmDialog` is kept as an alias of `tone='danger'`.** It is an internal component prop, so this is not an external compatibility shim under CLAUDE.md's rule.
- **I counted borderless strings with a regex scan** (251 admin / 299 total). These are approximate: template-literal classes split across lines and non-control elements may be miscounted. The Playwright ratchet is the source of truth.
