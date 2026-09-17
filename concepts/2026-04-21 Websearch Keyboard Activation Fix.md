# Websearch Keyboard Activation Fix

**Date**: 2026-04-21 (implementation revised 2026-09-17)
**Issue**: #1295 — WCAG issue: Websearch can't be activated via keys
**Related**: #1225 — Accessibility (Barrierefreiheit) – WCAG 2.1 AA Compliance Audit & Remediation

## Problem

In the chat input's `+` actions menu (`ChatInputActionsMenu`), the Web Search switch could be
reached with the keyboard but never activated: arrow keys, Space and Enter all did nothing. That
is a WCAG 2.1 Level A failure of 2.1.1 (Keyboard) — the capability was mouse-only.

## Root cause

The menu navigates with the roving-tabindex pattern implemented by
`client/src/shared/hooks/useKeyboardNavigation.js`. The hook discovers its items from the DOM
(`button`, `a[href]`, `[role="menuitem"]`, `[role="menuitemcheckbox"]`, `[role="menuitemradio"]`,
`[role="option"]`), moves focus with the arrow keys, and hands the component an `activeIndex` that
`menuNavItems` mirrors so React-rendered `tabIndex` values agree with the hook's imperative ones.

The Web Search row was a plain `<div>` wrapping a visually hidden (`sr-only`) checkbox:

- no `role`, so the hook never saw it — arrow keys skipped past it,
- no entry in `menuNavItems`, so it never received the roving `tabIndex`,
- no key handler, so Space and Enter had nothing to act on.

The hidden checkbox itself was focusable via Tab, which is what made the switch look reachable —
but the Space keystroke landed on an `sr-only` input with no visible focus indicator, and the menu
container's own keydown listener called `preventDefault()` on Space before the browser could
toggle it.

## Fix

The Tools section directly below already implements the correct pattern, so the Web Search row now
mirrors it (`client/src/features/chat/components/ChatInputActionsMenu.jsx`):

1. **Registered in the navigation order.** `menuNavItems` gains `'websearch'` between the cloud
   storage providers and the tool rows — the position must match the DOM order the hook
   discovers, otherwise the roving `tabIndex` lands on the wrong element.
2. **The row is the control.** It carries `role="menuitemcheckbox"`, `aria-checked`,
   `tabIndex={navTabIndex('websearch')}`, a visible `focus:ring`, an `onClick`, and an `onKeyDown`
   that toggles on Space and Enter.
3. **The switch is decoration.** The `sr-only` checkbox keeps rendering the switch graphic
   (Tailwind `peer-checked:` styling) but is now `readOnly`, `tabIndex={-1}` and `aria-hidden`,
   with `pointer-events-none` on its label — so there is exactly one focusable, announced control
   per row and a click cannot toggle twice.

### Why the hook's `onSelect` is not used

`useKeyboardNavigation` also accepts an `onSelect(activeIndex)` callback for Enter/Space. Wiring
it here would mean maintaining a second copy of the `menuNavItems` order inside the component and
would double-fire alongside the row's own `onKeyDown`: the hook listens on the menu container in
the capture phase and does not stop propagation, so React's bubble-phase handler still runs. The
row-level handler alone matches what the tool rows do and keeps the ordering logic in one place.

## Tests

`tests/unit/client/chat-actions-menu-websearch-keyboard.test.jsx` covers the role and
`aria-checked` state, Space and Enter activation, single activation on click, the roving
`tabIndex`, and the switch staying out of the tab order and the accessibility tree. All seven
assertions fail against the unfixed component.

jsdom reports every element as zero-sized, so the hook's visibility filter finds no items there
and its arrow-key handling cannot be exercised in a unit test; arrow-key movement was verified
manually against the same pattern the tool rows use.

## Known follow-ups (out of scope here)

- The **Transcription** switch and the embedded-host **Message context** switches ("Include page"
  in the browser extension) are still built from the pre-fix markup and have the same defect.
- `menuNavItems` unconditionally includes the Quick Actions buttons, which are `md:hidden`. On
  desktop the hook's DOM-derived list is shorter than `menuNavItems`, so the two indexes disagree.
  Focus still lands correctly because the hook sets `tabindex` imperatively and React does not
  rewrite an unchanged prop, but the mapping is fragile.
