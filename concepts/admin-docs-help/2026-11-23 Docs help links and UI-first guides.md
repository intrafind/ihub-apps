# Docs help links and UI-first guides

Status: implemented on 2026-11-23. Source: the admin review of apps, models and prompts (findings
AI-B25, AI-TW1, AI-TW2, recommendation 7).

## What was done

- **Wrong docs fixed.** The provider base URL only lists and imports models; chat requests use each
  model's own API URL (`models.md`, `admin-ui.md`). Stale names were replaced: "Import from URL" is
  now **Import models**, the provider form has no category, the model hint card is **User Hint**,
  the prompts page has three tabs. `admin-provider-new.png` was retaken.
- **UI-first guides.**
  - `docs/models.md#set-up-models-in-the-admin-ui`: connect a provider, import models, test,
    choose the default, troubleshoot a failed test. `GETTING_STARTED.md` links to it.
  - `docs/app-quickstart.md` already was UI-first and current; it now links to the access guide.
  - `docs/access-control.md` (new): how groups, inheritance and `*` decide access, and how to limit
    an app or a model to some groups.
- **Help links.** `client/src/features/admin/components/DocsLink.jsx` renders a "?" link beside a
  page title. It opens Admin → Documentation at a section. Placed on the Models, Providers, Apps and
  Prompts pages.

## How to add a help link to another page

1. Add a topic to `DOCS_HELP_TOPICS` in `client/src/features/admin/utils/docsHelpTopics.js`:
   the page (relative to `docs/`) and the heading anchor (lower case, spaces become `-`,
   punctuation is dropped; `### Connect a provider` becomes `connect-a-provider`).
2. Add the topic's name to `topicLabels()` in `DocsLink.jsx` and the key
   `admin.docs.helpTopics.<topic>` to `shared/i18n/en.json` and `de.json`.
3. Render `<DocsLink topic="<topic>" />` beside the page's `<h1>`.
4. Run `tests/unit/client/docs-help-link.test.jsx`. It fails when an anchor does not exist.

The link is hidden for content admins, because the documentation API is for full admins only.
The topic `access` (`access-control.md`) exists but is not placed yet; it is meant for the
**Group access** cards.

## Open TODO markers in the docs

These HTML comments mark where flows that other work is building will be described. Search for
`TODO(` in `docs/`:

| Marker | File | Replace with |
| --- | --- | --- |
| `TODO(connect-provider-wizard)` | `models.md` | The "Connect a provider" wizard, as the first way in |
| `TODO(model-access-card)` | `models.md`, `access-control.md` | The model's **Group access** card instead of the group editor steps |
| `TODO(connection-error-messages)` | `models.md` (When a test fails) | The new error headlines (status, host, TLS) |
| `TODO(restrict-access-helper)` | `access-control.md`, `app-quickstart.md` | The "Restrict access" helper instead of the manual wildcard steps |
| `TODO(access-check)` | `access-control.md` (checklist) | The access check as the first step |
