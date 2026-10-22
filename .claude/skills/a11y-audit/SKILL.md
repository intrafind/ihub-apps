---
name: a11y-audit
description: Audit iHub's accessibility (WCAG 2.2 AA, BITV 2.0 / BFSG, EN 301 549) against a requirement list, fix findings, or keep the axe baseline in tests/e2e/accessibility.spec.js honest. Use when asked whether iHub meets accessibility requirements, when a tender or customer lists Barrierefreiheit requirements, when adding or changing UI that needs keyboard or screen-reader care, or when the Accessibility CI check fails.
user-invocable: true
---

# Accessibility Audit

Read `docs/accessibility.md` first: it is the compliance statement, the contrast table and the
list of known gaps. This skill is the method.

## 1. Map the requirements, then test each one

Break a requirement list (for example a German Anhang "Anforderungen an die Barrierefreiheit")
into testable items and give each a status backed by evidence, not by reading `aria-*` counts:

| Requirement | How to test it |
| --- | --- |
| Keyboard only | `npx eslint client/src` (jsx-a11y warnings), then press Tab/Enter/Esc through the page in a real browser. Drag-only interactions need a button alternative. |
| Jump to regions | Landmarks (`main`, labelled `nav`/`aside`), skip links. Run axe's landmark rules; they are best practices and not in the WCAG tag set. |
| Visible focus | Press Tab in a browser and look at a screenshot. Read computed styles only after a real keyboard Tab and a short wait: reading them in the same tick as `focus()` shows no outline. |
| Focus order, dialogs | Open a dialog by keyboard; focus must move in, be trapped, and return to the opener on Esc. After an in-app route change, focus and announcement are the usual gap. |
| No context change on input | Look for `onChange` that navigates or reloads (the language `<select>` is one). |
| Feedback / notifications | `role="status"`, `role="alert"`, `aria-live` regions; check streaming content does not re-announce everything. |
| Contrast, text size | axe `color-contrast` in light **and** dark; resize to 320 px width and root font size 200% and check for horizontal scroll and clipped controls. |
| Labels, alt text | axe `label`, `select-name`, `button-name`, `image-alt`. |
| Screen reader | Cannot be proven by axe. Say plainly that an NVDA/JAWS walkthrough is still needed unless someone ran it. |

State what was **not** tested (browsers, pages behind dialogs, voice mode, canvas, embeds).

## 2. Run the real checks

```bash
npm run install:all                      # a fresh clone has no node_modules
npm run dev &                            # app on http://localhost:5173
node .claude/skills/a11y-audit/scan.mjs out.json   # axe over pages, see the script header
npm run test:a11y -- --project=chromium  # the CI suite
node scripts/check-a11y-diff.js origin/main        # jsx-a11y on changed lines (what CI runs)
```

Pitfalls that cost time:

- **Playwright's pinned browser may be missing** in sandboxes (`Executable doesn't exist at
  /opt/pw-browsers/chromium_headless_shell-NNNN`). Do not install; point at the installed binary
  with `CHROMIUM_PATH` for `scan.mjs`, or a throwaway Playwright config with
  `launchOptions.executablePath` kept outside the repo.
- **The auth API allows 50 requests per 15 minutes.** One login per test or per scan exhausts it;
  later runs get 429 and time out. The spec logs in once per worker; restart the dev server to
  reset the counter.
- **A fresh `contents/` redirects `/` to the setup wizard** and shows a disclaimer dialog
  ("I understand") that traps focus. Dismiss both before judging keyboard behaviour; `scan.mjs`
  does.
- **Admin pages do not apply the stored dark-mode preference**, so a dark scan of admin routes has
  to force the `dark` class; `scan.mjs` does. Dark failures on admin pages are only meaningful
  where the page has `dark:` styles.
- **Counts vary between scans** on list-backed pages. Scan three times and take the highest count
  per page and rule before writing a baseline.
- `npm install` rewrites lockfiles; `git checkout -- package-lock.json client/package-lock.json
  server/package-lock.json` before committing.

## 3. Fix patterns for this codebase

- **Skip links:** use `shared/components/SkipLink.jsx`. `index.html` injects a `<base>` element, so
  a bare `href="#id"` resolves to the app root and navigates away.
- **One `<main>` per page.** `Layout` and `AdminLayout` own it; pages inside them use `<div>`. Do not
  give two `aside`/`nav` landmarks the same role and label.
- **Clickable cards:** never `role="button"` around other buttons (`nested-interactive`). Use a
  stretched button in the heading (`after:absolute after:inset-0`) and `relative z-10` on the
  other controls.
- **File pickers:** `features/admin/components/UploadConfigButton.jsx`. Never lay an invisible
  `<input type="file">` over a button.
- **Switches and icon buttons:** `aria-labelledby` the visible name, or `aria-label` with the
  target ("Remove connection to X"), not a bare "Remove".
- **Contrast:** the table in `docs/accessibility.md`. Fix the class, not the scan; do not skip a
  failing node.
- **Text sizes:** `rem`, not `text-[11px]`.
- New strings: `t('key', 'Default')`; add keys to both `shared/i18n/en.json` and `de.json` for
  areas that already have them.

## 4. Keep the baseline honest

`tests/e2e/accessibility.spec.js` is a ratchet: `CLEAN_PAGES` must stay at zero critical/serious
violations, `KNOWN_VIOLATIONS` may only shrink. After a fix, rerun, then lower the number or move
the page into `CLEAN_PAGES`. Never raise a number to get CI green and never skip a test; fix the
element or, if it genuinely cannot be fixed in this change, say so in the PR. A new page or
route belongs in one of the two lists. Add a regression test for any structural fix (landmarks,
skip links, keyboard paths) next to the existing ones, and a Jest unit test under
`tests/unit/client/` for new components.

Changes visible to users get a `docs/releases/next/` entry (`/document-feature`).
