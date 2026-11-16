# Accessibility

iHub Apps is committed to meeting **WCAG 2.2 Level AA** accessibility standards. This page describes the compliance targets, keyboard navigation patterns, screen reader considerations, testing procedures, and known limitations.

## Compliance Statement

### Target Standard

**WCAG 2.2 Level AA** as defined by the [Web Content Accessibility Guidelines](https://www.w3.org/TR/WCAG22/). WCAG 2.2 is backwards-compatible with 2.1 and adds success criteria such as **Focus Not Obscured**, **Dragging Movements**, **Target Size (Minimum)**, and **Consistent Help**.

### Regulatory Alignment

The accessibility work in iHub Apps is aligned with the following regulations and standards:

| Standard / Regulation | Scope | Notes |
|---|---|---|
| **EN 301 549** | EU — Harmonized European Standard for ICT accessibility | Mandatory for public-sector ICT procurement in the EU. References WCAG 2.1 AA for web content (clause 9); newer revisions track WCAG 2.2. |
| **BITV 2.0** | Germany — Barrierefreie-Informationstechnik-Verordnung | German federal regulation implementing the EU Web Accessibility Directive. Requires at least WCAG 2.1 AA for public-sector websites and apps; iHub Apps targets the stricter WCAG 2.2 AA. |
| **BFSG** | Germany — Barrierefreiheitstaerkungsgesetz | German implementation of the European Accessibility Act (EAA). Extends accessibility requirements to private-sector products and services starting June 2025. |

### Current Status

Accessibility tooling infrastructure is in place on three layers:

1. **Static analysis** — `eslint-plugin-jsx-a11y` runs as part of `npm run lint` (and on every pull request via the *Auto Lint & Format* workflow). Rules currently report at `warn` severity and are promoted to `error` as findings are remediated.
2. **Automated runtime scanning** — axe-core scans key pages for WCAG 2.2 AA violations as part of the end-to-end test suite, and runs on every pull request via the dedicated *Accessibility* GitHub Actions workflow (`.github/workflows/accessibility.yml`).
3. **Manual verification** — keyboard and screen-reader checks before major releases (see the checklist below).

Remediation of existing violations is tracked and addressed incrementally.

## Keyboard Navigation

All interactive elements in iHub Apps are reachable and operable via keyboard. The following patterns apply across the application.

### Skip Link

A **skip-to-main-content** link is the first focusable element on every page. It becomes visible on focus and lets keyboard users bypass repeated navigation to jump directly to the main content area.

**Usage:** Press `Tab` after page load to reveal the skip link, then press `Enter` to activate it. Focus moves to the main content area; the page does not navigate. Admin pages have their own skip link to the admin content.

The link is the `SkipLink` component (`client/src/shared/components/SkipLink.jsx`). Use it, not a bare `<a href="#id">`: `index.html` injects a `<base>` element for sub-path deployments, which makes a plain fragment link resolve against the app root and leave the page.

### Workspace Pane

The chat's workspace pane (files and sources next to the chat, see
[Artifacts → The workspace pane](artifacts.md#the-workspace-pane)) is a labelled region
("Workspace: <name>") inside `<main>`, not a dialog, while it is docked or full screen; below
1024px and on embedded surfaces it is a modal sheet with a focus trap. While it is open a second
skip link, **Skip to workspace**, leads to its heading. **F6 / Shift+F6** cycle sidebar → chat
messages → composer → pane, **Ctrl/Cmd+.** opens and closes it, and **Esc** closes the innermost
layer only (menu, selection chip, composer dock, full screen, pane) and never from the composer.
The divider is a focusable `role="separator"` with a value, resized with the arrow keys and
Home/End. One polite live region per pane announces copies and width changes; streamed answer
text never goes into it. Not yet tested with NVDA or JAWS.

Each page has exactly one `<main>`. The app layout provides it, `AdminLayout` provides it for admin pages; a page rendered inside either must not add another (use a `<div>`).

### Tab Order

Interactive elements follow a logical tab order that matches the visual reading order (left-to-right, top-to-bottom):

| Key | Action |
|---|---|
| `Tab` | Move focus to the next interactive element |
| `Shift + Tab` | Move focus to the previous interactive element |

### Menus and Dropdowns

| Key | Action |
|---|---|
| `Enter` or `Space` | Open a dropdown / activate a menu item |
| `Arrow Down` | Move to the next menu item |
| `Arrow Up` | Move to the previous menu item |
| `Escape` | Close the menu and return focus to the trigger |
| `Home` | Move to the first menu item |
| `End` | Move to the last menu item |

### Dialogs and Modals

| Key | Action |
|---|---|
| `Tab` | Cycle focus within the dialog (focus is trapped) |
| `Escape` | Close the dialog and return focus to the element that opened it |

### Chat Interface

| Key | Action |
|---|---|
| `Tab` | Move between message input, send button, and other controls |
| `Enter` | Send the current message (when the input is focused) |
| `Shift + Enter` | Insert a newline in the message input |

### Workflow Editor

Connecting steps on the canvas is a drag movement. The same can be done with the keyboard: select a
step, and the **Connections** section of its configuration panel lists its outgoing connections. Pick
a step under **Connect to** (and, for a decision step, the **Branch**) and press **Add connection**;
**Condition** edits a connection's condition and **Remove** deletes it. The rules are the same as
for drawing an edge on the canvas. A step's delete button also appears when the step has keyboard
focus.

## Screen Reader Considerations

### Live Regions

The application uses `aria-live` regions to announce dynamic content changes to screen readers:

- **Chat messages**: New assistant responses are announced via a polite live region so users are informed without interrupting their current context.
- **Loading states**: Progress indicators and loading spinners have appropriate `aria-busy` and `aria-live` attributes.
- **Notifications**: Toast messages and alerts use `role="alert"` or `aria-live="assertive"` for time-sensitive information.

### Run activity and live regions

While an answer is produced, the activity list above it (`ToolActivity`) shows what the turn is doing: searches, a file that is being written, "Waiting for the model…". It is the pattern to copy for any status that changes while the user waits.

- The chat log (`role="log"`) is a polite live region, and a clock inside it would be read every second. So the list opts out with `aria-live="off"`, and every ticking part (the size and the clock of `12 KB written · 0:41`) is also `aria-hidden`. If a screen reader ignored the nested `off`, the failure would be a missed number, never a chatter of numbers.
- What a screen reader needs is said by one persistent announcer, `RunAnnouncer` (`role="status" aria-live="polite" aria-atomic="true"`, `sr-only`). It is rendered by `ChatMessageList` next to the log, not inside it, from the start, because a live region that is injected together with its text is unreliable. Every host of the list (chat page, embed, Office pane) gets it.
- It speaks a short script, at most once per event: a call starts ("Creating web artifact"), a file is done, a call is cut off or refused, a file was stopped, the size has stopped growing, the model has been silent for a while ("Waiting for the model", "Thinking"). It never speaks sizes, clocks or reasoning text. The wording comes from the visible strings without their ellipsis. `deriveAnnouncements` decides this and is pure (unit-tested); at least 1.5 s separate two messages, at most three wait (the least important is dropped first), and the text is emptied after 5 s so an identical later message is read again. A turn that is already finished when it first appears (a reopened chat) is not read out. Where several lists are visible at once (compare mode) each has its own announcer and says its list first ("Model A: Creating web artifact"), so a screen reader says which model it means.
- The progress is a count and a clock, never `role="progressbar"`: there is no total, so there is no value to expose, and an indeterminate progress bar with changing text is noisy in several screen readers. A row is a plain `<li>`, not a status.
- A finished headline wraps and never truncates: one segment per place the turn looked (skills first), the noun and facts as text, the icons decoration. A skill row is plain text (no tab stop, no tooltip). A search the server declared empty is announced once ("The project search returned no results"); an empty source list alone never is.
- **Technical details** (arguments, tool id, duration) are behind a `role="switch"` button, off by default, 24 px high, remembered per browser in `localStorage` inside `try/catch` and described by a visible-to-screen-reader hint. It appears only on a finished turn. When the list closes by itself because the turn ended and focus was inside it, focus moves to the headline button.
- The headline toggle has a 24 px hit area and a visible focus ring. Its accessible name is the label without the ticking suffix, so it does not change every second while it has focus.
- The spinner is `motion-safe` only: under `prefers-reduced-motion` a static clock or light-bulb glyph replaces it (`BusyIcon`), and the three-dot loader does not pulse. The text and the clock carry the liveness; a number changing is not motion. The clock and size update automatically for longer than 5 s; they are the essential feedback of an operation the user started, change at most once a second, do not move, and the Stop button ends the operation, which is how WCAG 2.2.2 is read here.

### Dialog Announcements

Modal dialogs are implemented with:

- `role="dialog"` and `aria-modal="true"`
- `aria-labelledby` pointing to the dialog title
- `aria-describedby` pointing to the dialog description (when available)
- Focus is moved into the dialog on open and restored on close

### Form Labels

All form inputs have associated labels, either through:

- `<label>` elements linked via `htmlFor` / `id`
- `aria-label` for inputs where a visible label is not appropriate (e.g., icon-only buttons)
- `aria-labelledby` for composite labels

### Semantic HTML

The application uses semantic HTML elements where possible:

- `<main>` for the primary content area
- `<nav>` for navigation regions
- `<header>` and `<footer>` for page landmarks
- `<h1>` through `<h6>` in a logical hierarchy
- `<button>` for interactive controls (not `<div onClick>`)

### Shared Components

Four components in `client/src/shared/components/` carry the keyboard and screen-reader behaviour
of common controls. Use them instead of building the markup again; `role="switch"` appears
nowhere in `client/src` outside `Switch.jsx`, and there is no checkbox styled as a switch
(`sr-only peer`) left.

| Component | Use it for | What it guarantees |
|---|---|---|
| `Switch` | Any on/off setting | Native `<button role="switch" aria-checked>`: in the tab order, Space and Enter toggle it, disabled by `disabled` or an enclosing `<fieldset disabled>`. Sizes `sm` and `md`, dark mode. |
| `Badge` | Short status or kind labels ("Preview", "Installed", "Read and write") | Tones `neutral`, `info`, `success`, `warning`, `danger`, `accent`, `highlight` in `soft` or `outline`; every light and dark pair keeps 4.5:1 text contrast. The text carries the meaning. |
| `StatusDot` | The health of an integration, connection or server | Statuses `ok`, `warn`, `degraded`, `error`, `off`. The status is always in text as well: visually hidden by default, next to the dot with `showLabel`. `off` is a hollow ring. |
| `Drawer` | A panel that slides in from the right (details, history) | `role="dialog"` with `aria-modal`, named by its `title`; focus moves in on open, Tab stays inside, Escape and the backdrop close it, focus returns to the opener, the page does not scroll behind it, full width on phones. A dialog stacked on top (with its own `aria-modal`) keeps Escape and Tab. |

A switch needs a name. Give it one of `label` (rendered by the switch, with an optional
`description`), `aria-labelledby` (a label the screen lays out itself) or `aria-label`:

```jsx
<Switch
  checked={settings.enabled}
  onChange={enabled => update({ enabled })}
  label={t('admin.example.enable', 'Enable example')}
  description={t('admin.example.enableHelp', 'What switching it on does.')}
  labelPosition="start"
/>

<span id="pwa-enabled-label">{t('admin.ui.pwa.enable', 'Enable PWA')}</span>
<Switch checked={pwa.enabled} onChange={toggle} aria-labelledby="pwa-enabled-label" />
```

A `<label htmlFor>` the screen renders itself names the switch too, and a click on it toggles the
switch; pass the same `id` to the `Switch`:

```jsx
<label htmlFor="websearch-enabled">{t('admin.apps.edit.websearchEnabled', 'Enable Web Search')}</label>
<Switch id="websearch-enabled" checked={enabled} onChange={value => update({ enabled: value })} />
```

Inside an element that already is the control, such as a `role="menuitemcheckbox"` row of a
menu, a real switch would be a nested interactive control. Draw `SwitchIndicator` (a named
export of `Switch.jsx`) instead: the same look, hidden from assistive technology, not focusable.
The row keeps `aria-checked`, the tab index and Space/Enter (the chat **+** menu does this).

`StatusDot` without `showLabel` is only enough where other visible text already states the status;
otherwise show the label (WCAG 1.4.1). Use `showLabel` in lists and tables. Inside a `Badge`, pass
`labelClassName=""` so the text takes the badge's size and colour:

```jsx
<Badge tone="success">
  <StatusDot status="ok" label={t('…connected', 'Connected')} showLabel labelClassName="" size="sm" />
</Badge>
```

## Testing

### Automated Tests

Accessibility violations are detected automatically using [axe-core](https://github.com/dequelabs/axe-core) integrated with Playwright.

#### Running the Accessibility Test Suite

```bash
# Run only accessibility tests
npm run test:a11y

# Run all end-to-end tests (includes accessibility)
npm run test:e2e
```

Playwright starts the app itself with `tests/config/e2e-server.mjs`: a fresh install in its own git-ignored
`contents-e2e/` directory with every rate limit raised, so a full run is not answered with `429`, with the
remote marketplace off, so the pages do not depend on the network, and with one default model served by a
local stub (`tests/config/e2e-llm-stub.mjs`), so the chat specs run a real turn without a model key. The
specs do not write into your real `contents/`. Delete `contents-e2e/` to start from a fresh install.
A server you already run on port 5173 is reused as it is, with its own limits and contents.

The `test:a11y` command scans the following pages for WCAG 2.2 AA violations (axe-core tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`, `wcag22aa`):

| Page | Route | Notes |
|---|---|---|
| Home / Apps list | `/` | Main landing page (exercises header, nav, skip link, footer) |
| Apps browser | `/apps` | |
| Login | `/login` | Authentication page |
| Admin | `/admin` | Signed out: skipped automatically if authentication is required |
| Chat app | `/apps/chat` | Signed in |
| Prompt library | `/prompts` | Signed in |
| Chat history | `/chats` | Signed in |
| Admin overview, apps, models, users, groups | `/admin`, `/admin/apps`, `/admin/models`, `/admin/users`, `/admin/groups` | Signed in |
| Every other route reachable from the user and admin navigation | `CLEAN_PAGES` and `KNOWN_VIOLATIONS` in the spec | Signed in; about 50 pages |

Besides the axe scans the file also contains **landmark tests** (exactly one `main`, no ambiguous duplicate landmarks; axe's WCAG tags do not include these rules) and **skip link tests** that press `Tab` and `Enter` and check that focus lands in the content without a navigation.
Signed-in pages log in as the default local admin a fresh `contents/` ships (`admin` / `password123`). Set `TEST_ADMIN_USERNAME` and `TEST_ADMIN_PASSWORD` to run them against another environment.

**Failure criteria:** Only **critical** and **serious** impact violations cause test failure. Moderate and minor violations are logged for awareness.

**Baseline (ratchet):** Pages in `CLEAN_PAGES` have no critical or serious violation and are held at zero. `KNOWN_VIOLATIONS` records, per remaining page, how many elements fail each rule on a fresh `contents/` (the highest count over repeated scans, because list-backed pages render slightly differently per load). Up to that many are logged but do not fail the run; one more failing element, or any other rule, fails it. When a fix lowers a count, the log says so: lower the number, or delete the entry at zero and add the page to `CLEAN_PAGES`, so the fixed elements cannot regress unnoticed. The remaining entries are unlabelled form controls in admin forms (`label`, `select-name`, `button-name`) and the OAuth tab panels.

The suite signs in once per worker: the auth API allows 50 requests per 15 minutes, which one login per test would exceed.

**Continuous integration:** The `.github/workflows/accessibility.yml` workflow installs dependencies, boots the application, and runs `npm run test:a11y` against Chromium on every pull request targeting `main` or `develop`. The Playwright HTML report is uploaded as a build artifact.

#### Static Analysis

ESLint with [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y) checks JSX code for common accessibility issues at development time:

```bash
# Run linting (includes jsx-a11y rules)
npm run lint

# Auto-fix where possible
npm run lint:fix
```

The plugin's *recommended* ruleset is enabled, with each rule downgraded from `error` to **warn** so accessibility findings surface during development without blocking it. Rules the preset disables (e.g. the deprecated `label-has-for`) remain disabled, and per-rule option objects are preserved. Rules are promoted back to **error** incrementally as violations are remediated.

**Changed lines are held to the rules.** On pull requests, the "jsx-a11y (changed lines)" job runs `scripts/check-a11y-diff.js`, which fails on any jsx-a11y finding on a line the PR adds or changes and annotates it inline. It also lints each changed file as it was before the PR, so a change that breaks an untouched line (deleting `onKeyDown` from a clickable `<div>` is reported on the `<div>` line) fails too. Existing warnings elsewhere in a touched file do not count, so new code is accessible while the backlog shrinks as code is edited. Run it locally before pushing:

```bash
node scripts/check-a11y-diff.js origin/main
```

> **Note on ESLint compatibility:** `eslint-plugin-jsx-a11y` declares an ESLint `<= 9` peer range, while this project runs ESLint 10. A `package.json` `overrides` entry (`"eslint-plugin-jsx-a11y": { "eslint": "$eslint" }`) reconciles the peer dependency; the plugin is fully functional with ESLint 10's flat config.

### Manual Testing Checklist

Automated tools catch roughly 30-50% of accessibility issues. The following manual checks should be performed before major releases:

- [ ] **Keyboard-only navigation**: Navigate the entire application using only the keyboard. Verify that every interactive element is reachable and operable.
- [ ] **Skip link**: Confirm the skip-to-content link appears on Tab and functions correctly.
- [ ] **Focus visibility**: Ensure every focused element has a clearly visible focus indicator.
- [ ] **Color contrast**: Check that text and interactive elements meet the 4.5:1 contrast ratio (3:1 for large text).
- [ ] **Zoom / text resize**: Verify the layout is usable at 200% browser zoom without horizontal scrolling.
- [ ] **Screen reader walkthrough**: Test with at least one screen reader (e.g., VoiceOver on macOS, NVDA on Windows) to verify that:
  - Page landmarks are announced
  - Headings form a logical hierarchy
  - Form inputs have descriptive labels
  - Dynamic content changes are announced
  - Modal dialogs trap and manage focus correctly
- [ ] **Reduced motion**: Confirm that `prefers-reduced-motion` is respected for animations.
- [ ] **Dark mode**: Verify contrast ratios are maintained in both light and dark themes.

### Recommended Tools

| Tool | Purpose |
|---|---|
| [axe DevTools](https://www.deque.com/axe/devtools/) | Browser extension for on-demand accessibility scanning |
| [Lighthouse](https://developer.chrome.com/docs/lighthouse/) | Built into Chrome DevTools — includes accessibility audit |
| [WAVE](https://wave.webaim.org/) | Browser extension for visual accessibility feedback |
| [VoiceOver](https://support.apple.com/guide/voiceover/) | macOS built-in screen reader |
| [NVDA](https://www.nvaccess.org/) | Free screen reader for Windows |

## Colour Contrast for Developers

Normal text needs 4.5:1 (3:1 for large text and for icons or borders that carry meaning), in light and in dark mode. With the Tailwind palette:

| Text colour | Passes on | Fails on |
|---|---|---|
| `text-gray-400` | nothing in light mode (2.6:1 on white) | everything light; use `text-gray-500` or darker |
| `text-gray-500` | `bg-white`, `bg-gray-50` | `bg-gray-100` (4.39:1), `bg-gray-200`; use `text-gray-600` there |
| `dark:text-gray-500` | nothing in dark mode | every dark surface; use `dark:text-gray-400` |
| `dark:text-gray-400` | `dark:bg-gray-800`, `-900`, `-950` | `dark:bg-gray-700` (3.96:1); use `dark:text-gray-300` there |
| white on `bg-{green,orange,emerald,teal,amber}-600` | | all of them (about 3.2–3.7:1); use `-700` |
| `text-{green,amber,orange,yellow}-600` | | on white and tinted panels; use `-700` |

Use `rem`-based text sizes (`text-xs`, `text-[0.6875rem]`), not `text-[11px]`, so text follows the browser's text-size setting. Do not rely on colour alone: status badges carry their status as text.

## Known Limitations

The following accessibility gaps are tracked and will be addressed in future iterations:

- **Dynamic React components** (`ReactComponentRenderer`): Content rendered from user-authored JSX pages is not automatically validated for accessibility. Authors are responsible for following accessibility best practices in their components.
- **Third-party embeds**: Embedded content from external services (e.g., iframes) may not meet WCAG 2.1 AA standards. Where possible, `title` attributes are added to iframes.
- **PDF exports**: Generated PDF documents do not currently include accessibility tags (e.g., tagged PDF structure). This is planned for a future release.
- **Complex data tables**: Some admin configuration tables may lack full `scope` and `headers` attributes. These will be remediated as the admin UI is refactored.
- **Text size:** there is no in-app text-size control; text follows browser zoom and the browser's text-size setting. The layout reflows without horizontal scrolling at 320 px width.
- **Canvas page** (`/apps/:appId/canvas`): the editor styles use fixed white backgrounds, so it has no dark mode, and one `<select>` is unlabelled.
- **Login page:** rendered by the inlined auth gate (`client/src/auth-gate/`), outside React; it is not covered by the axe suite.
- **Screen-reader testing:** the axe and keyboard suites are automated. A walkthrough with NVDA or JAWS (login, chat, apps, prompts, admin) is a manual step and no results are recorded here yet.
- **Run activity announcements:** that the nested `aria-live="off"` really silences the activity list, and that `RunAnnouncer` is heard at most once per event, is not verified: unit tests and axe cannot show what a screen reader announces, and no end-to-end (Playwright) or screen-reader run has been done yet. The manual script (run a slow file creation with NVDA and Chrome or Firefox, JAWS and Chrome, VoiceOver and Safari; pass if "Creating web artifact" is heard once, no numbers are heard, "Created web artifact" is heard once) is still to do.
- **Heading order:** several pages skip a heading level (for example an `h3` empty-state heading directly under the `h1`). axe reports this as a moderate best-practice finding, so it does not fail the suite.

These items are tracked as part of the ongoing accessibility initiative and will be addressed in subsequent phases.
