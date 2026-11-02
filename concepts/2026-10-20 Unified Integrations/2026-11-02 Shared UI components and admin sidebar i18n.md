# Shared UI components and admin sidebar i18n (#2925)

Implementation notes for issue #2925 (Phase 2 of #2911). Branch
`claude/exciting-feynman-2aju98-shared-ui`, based on `main` at `701cba81`.

## What exists now

Four components in `client/src/shared/components/`, each with JSDoc that describes every prop:

| Component | File | API in one line |
| --- | --- | --- |
| `Switch` | `Switch.jsx` | `checked`, `onChange(next, event)`, `disabled`, `size` (`sm`/`md`), `id`, `label`, `description`, `labelPosition` (`start`/`end`), `aria-label` / `aria-labelledby` / `aria-describedby`, other props go to the button |
| `Badge` | `Badge.jsx` | `tone` (`neutral`, `info`, `success`, `warning`, `danger`, `accent`, `highlight`), `variant` (`soft`/`outline`), `size` (`sm`/`md`), `shape` (`pill`/`rounded`), `icon` |
| `StatusDot` | `StatusDot.jsx` | `status` (`ok`, `warn`, `degraded`, `error`, `off`), `label`, `showLabel`, `size` |
| `Drawer` | `Drawer.jsx` | `isOpen`, `onClose`, `title`, `icon`, `description`, `subheader`, `footer`, `size` (`sm`/`md`/`lg`), `closeLabel`, `initialFocusRef`, `closeOnEscape`, `closeOnBackdropClick`, `bodyClassName` |

Developer guidance with examples: `docs/accessibility.md`, section "Shared Components".

`getFocusableElements` in `client/src/shared/hooks/useFocusTrap.js` is now exported; the Drawer
uses it to bring focus back when the focused element disappears.

## Screens moved onto the components

Switches (`role="switch"` now appears only in `Switch.jsx`):

- `features/admin/pages/AdminFeaturesPage.jsx` (also its "Preview" pill is a `Badge`)
- `features/admin/pages/AdminMcpGatewayPage.jsx` (its local `Toggle` row keeps the layout and
  renders a `Switch`)
- `features/admin/pages/AdminOAuthServerPage.jsx` (labels now `htmlFor` the switch)
- `features/admin/pages/AdminFeedbackPage.jsx`
- `features/admin/pages/AdminWorkflowEditPage.jsx`
- `features/admin/pages/AdminWorkflowExecutionsPage.jsx`
- `features/admin/components/StartPageCustomization.jsx`
- `features/admin/components/PwaCustomization.jsx`
- `features/admin/components/WorkflowChatIntegrationSection.jsx`
- `features/tasks/pages/TasksPage.jsx`

Drawer: `features/admin/components/ChangeHistoryDrawer.jsx`. Its rollback confirmation is now an
`alertdialog` rendered into `document.body` with its own focus trap and Escape, because the
drawer's focus trap would otherwise keep the keyboard out of it.

## Decisions worth knowing

- **One accent.** The switches on the MCP gateway and OAuth pages were blue; they are indigo now,
  like every other switch (the concept's design tokens).
- **Focus ring on keyboard focus only** (`focus-visible`), not after a mouse click.
- **Workflow "Enabled" switch** is named by the state text next to it ("Enabled"/"Disabled"), so
  the accessible name matches what is visible. It now sets the value it shows: a workflow without
  `enabled` showed "on" and the first click set `enabled: true`, i.e. did nothing.
- **Drawer stays mounted while closed** (rendered into `document.body`, `inert`, `aria-hidden`,
  `invisible` after the 300 ms slide-out). A parent that mounts it only while open still gets the
  slide-in through Tailwind's `starting:` variant (`@starting-style`).
- **Stacked dialogs.** The Drawer ignores Escape and Tab when the event comes from inside another
  `[aria-modal="true"]` element, so a confirmation on top of it handles its own keys.

## i18n

30 keys added to `shared/i18n/en.json` and `de.json`: `admin.sidebar.sections.*` (7) and
`admin.nav.*` (23), appended at the end of their existing blocks so they merge cleanly with the
integrations PR stack. 5 more for the `StatusDot` labels under `components.statusDot.*`.
`tests/unit/client/admin-sidebar-i18n.test.jsx` builds the sidebar with a recording `t` and fails
for any label missing in either language, so new sidebar entries need both translations.

## Tests

`tests/unit/client/shared-switch.test.jsx`, `shared-badge-status-dot.test.jsx`,
`shared-drawer.test.jsx`, `change-history-drawer-dialog.test.jsx`, `admin-sidebar-i18n.test.jsx`.
The drawer test gives elements a layout box (`offsetWidth`, `offsetHeight`, `offsetParent`),
because jsdom has none and the focus trap skips elements without one.

## Follow-ups done (second PR, branch `claude/modest-turing-had15v-ui-2925`)

All three follow-ups below are done. What changed and why:

- **Marketplace detail on `Drawer`.** `MarketplaceItemDetail.jsx` renders `<Drawer isOpen size="lg">`
  (the parent still mounts it only while an item is selected). Title = display name, `description`
  = author (`admin.marketplace.byAuthor`, new key in en/de), `subheader` = the type / version /
  installed badges (`data-testid="marketplace-detail-badges"`). Only the outer container and the
  header changed: the body (action bar, dialogs, tabs, tab content) sits unchanged inside a
  `flex min-h-0 flex-1 flex-col` wrapper with `bodyClassName="flex flex-col"`, so the bars stay and
  the tab content scrolls as before. This keeps the diff away from the body, which PR #2924 extends.
- **No `sr-only peer` toggle left.** Converted to `Switch`: `SSLConfig`, `CorsConfig` (ids
  unchanged, so their existing `<label htmlFor>` names them), `AdminUsersPage` (size `sm`, same
  `aria-label`, `event.stopPropagation()` in `onChange` like the old label's `onClick`),
  `IAssistantSection` and the six switches of `WebSearchSection` (their orphan `<label>`s got
  `htmlFor`, the help texts an id for `aria-describedby`), `TechnicalDetailsToggle` (the visible
  text is the `<label htmlFor>`, id from `useId`).
- **Chat `+` menu (`ChatInputActionsMenu.jsx`).** Its on/off rows are `role="menuitemcheckbox"`
  items of a `role="menu"`; a `Switch` inside would be a nested interactive control (invalid ARIA).
  So the rows keep their semantics and draw the new `SwitchIndicator` (named export of
  `Switch.jsx`, visual only, `aria-hidden`, `data-state="on|off"`). The tool and MCP-server rows
  lost their focusable hidden checkbox (an extra unnamed Tab stop). The host-context rows
  (browser extension "Include page") were a bare, unnamed checkbox inside the menu; they are now
  `menuitemcheckbox` rows like web search, registered in `menuNavItems` as `host-<key>` so the
  roving tab index and arrow keys reach them; Space and Enter toggle.
- **Integration badges.** `Pill` is gone from `IntegrationPills.jsx`; `InstallationStatusPills`,
  `MigrationStatusPill`, `CatalogTile`, `MigrationParts` and `AdminInstallationPage` use `Badge`.
  Tone mapping: green → `success`, blue → `info`, red → `danger`, gray → `neutral`, yellow, amber
  and orange → `warning` (orange "Update available" is a call to act, not information).
  `migrationStatusTone` still returns `red`/`amber` because `InstallationMigrationPanel` uses it
  for its frame colour; `IntegrationPills` maps it to the Badge tone. The live status is a Badge
  with a `StatusDot` inside (`ok` connected / per-user, `error` unreachable, `off` otherwise);
  `data-testid="live-status"` is on the `StatusDot`, whose text is the full label.
- **`StatusDot` got `labelClassName`** (default unchanged); `''` makes the visible text inherit the
  badge's style.

Tests: `marketplace-item-detail-drawer.test.jsx`, `admin-toggles-shared-switch.test.jsx`,
`chat-actions-menu-switch-rows.test.jsx`, `integration-status-badges.test.jsx`, new cases in
`shared-switch.test.jsx` and `shared-badge-status-dot.test.jsx`; the web search keyboard test now
asserts the `SwitchIndicator` instead of the hidden checkbox.

Still open (not part of this issue): `AdminUsersPage` shows "Active"/"Inactive" and its empty
states as hard-coded English, and its toggle sends `active: !user.active`, which for a user
without an `active` field (shown as active) sends `true`, so the first click does nothing.

## Follow-ups (as written for the first PR, now done)

- `features/admin/components/marketplace/MarketplaceItemDetail.jsx` builds its own drawer. It is
  changed by the open integrations stack (#3098 → #3107), so it moves onto `Drawer` after the
  stack merges. Its header (badges above the title, author below) fits `title` + `subheader`;
  use `size="lg"` for its current `max-w-2xl`.
- The status pills of the integration pages (`AdminIntegrations*`, `components/integrations/*`)
  move to `Badge` / `StatusDot` after the stack merges.
- Checkbox-based "peer" toggles remain in `SSLConfig.jsx`, `CorsConfig.jsx`,
  `AdminUsersPage.jsx`, `app-form/WebSearchSection.jsx`, `app-form/IAssistantSection.jsx`,
  `workflows/components/TechnicalDetailsToggle.jsx` and `chat/components/ChatInputActionsMenu.jsx`
  (`WebSearchSection`, `IAssistantSection` and `ChatInputActionsMenu` are in the stack too). They are accessible checkboxes, but look like switches;
  moving them to `Switch` changes their role from checkbox to switch, so tests that query them
  by role need updating.
