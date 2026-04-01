# Accessibility

iHub Apps is committed to meeting **WCAG 2.1 Level AA** accessibility standards. This page describes the compliance targets, keyboard navigation patterns, screen reader considerations, testing procedures, and known limitations.

## Compliance Statement

### Target Standard

**WCAG 2.1 Level AA** as defined by the [Web Content Accessibility Guidelines](https://www.w3.org/TR/WCAG21/).

### Regulatory Alignment

The accessibility work in iHub Apps is aligned with the following regulations and standards:

| Standard / Regulation | Scope | Notes |
|---|---|---|
| **EN 301 549** | EU — Harmonized European Standard for ICT accessibility | Mandatory for public-sector ICT procurement in the EU. References WCAG 2.1 AA for web content (clause 9). |
| **BITV 2.0** | Germany — Barrierefreie-Informationstechnik-Verordnung | German federal regulation implementing the EU Web Accessibility Directive. Requires WCAG 2.1 AA for public-sector websites and apps. |
| **BFSG** | Germany — Barrierefreiheitstaerkungsgesetz | German implementation of the European Accessibility Act (EAA). Extends accessibility requirements to private-sector products and services starting June 2025. |

### Current Status

Accessibility tooling infrastructure is in place. Automated scanning for WCAG 2.1 AA violations runs as part of the end-to-end test suite. Remediation of existing violations is tracked and will be addressed incrementally.

## Keyboard Navigation

All interactive elements in iHub Apps are reachable and operable via keyboard. The following patterns apply across the application.

### Skip Link

A **skip-to-main-content** link is the first focusable element on every page. It becomes visible on focus and lets keyboard users bypass repeated navigation to jump directly to the main content area.

**Usage:** Press `Tab` after page load to reveal the skip link, then press `Enter` to activate it.

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

The `test:a11y` command scans the following pages for WCAG 2.1 AA violations:

| Page | Route | Notes |
|---|---|---|
| Home / Apps list | `/` | Main landing page |
| Login | `/login` | Authentication page |
| Admin | `/admin` | Skipped automatically if authentication is required |

**Failure criteria:** Only **critical** and **serious** impact violations cause test failure. Moderate and minor violations are logged for awareness.

#### Static Analysis

ESLint with [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y) checks JSX code for common accessibility issues at development time:

```bash
# Run linting (includes jsx-a11y rules)
npm run lint

# Auto-fix where possible
npm run lint:fix
```

All `jsx-a11y` rules are currently set to **warn** severity to avoid blocking ongoing development. These will be promoted to **error** incrementally as violations are remediated.

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

## Known Limitations

The following accessibility gaps are tracked and will be addressed in future iterations:

- **Dynamic React components** (`ReactComponentRenderer`): Content rendered from user-authored JSX pages is not automatically validated for accessibility. Authors are responsible for following accessibility best practices in their components.
- **Third-party embeds**: Embedded content from external services (e.g., iframes) may not meet WCAG 2.1 AA standards. Where possible, `title` attributes are added to iframes.
- **PDF exports**: Generated PDF documents do not currently include accessibility tags (e.g., tagged PDF structure). This is planned for a future release.
- **Complex data tables**: Some admin configuration tables may lack full `scope` and `headers` attributes. These will be remediated as the admin UI is refactored.

These items are tracked as part of the ongoing accessibility initiative and will be addressed in subsequent phases.
