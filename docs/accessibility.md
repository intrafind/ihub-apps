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

## Screen Reader Considerations

### Live Regions

The application uses `aria-live` regions to announce dynamic content changes to screen readers:

- **Chat messages**: New assistant responses are announced via a polite live region so users are informed without interrupting their current context.
- **Loading states**: Progress indicators and loading spinners have appropriate `aria-busy` and `aria-live` attributes.
- **Notifications**: Toast messages and alerts use `role="alert"` or `aria-live="assertive"` for time-sensitive information.

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
- **Heading order:** several pages skip a heading level (for example an `h3` empty-state heading directly under the `h1`). axe reports this as a moderate best-practice finding, so it does not fail the suite.

These items are tracked as part of the ongoing accessibility initiative and will be addressed in subsequent phases.
