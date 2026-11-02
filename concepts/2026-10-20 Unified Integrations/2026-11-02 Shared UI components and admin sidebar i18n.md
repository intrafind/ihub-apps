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

## Follow-ups (not done here)

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
