# Admin UI Guide

The iHub Apps admin UI is the primary interface for managing your platform. This guide covers navigation, all major sections, and productivity features like keyboard shortcuts and the command palette.

> **Tip:** You do not need to edit JSON files directly to configure iHub Apps. Everything described in this guide can be done through the admin UI at `/admin`.

## Accessing the Admin UI

Navigate to `/admin` in your browser. You must be logged in as a user with admin permissions (member of the `admin` group).

---

## Navigation

The admin UI uses a **collapsible left-rail sidebar** with seven sections. Click any section header to expand or collapse it.

| Section | What's inside |
|---------|--------------|
| **Overview** | Dashboard, What's New |
| **AI Workspace** | Apps, Models, Prompts, Sources, Providers, Tools, Skills, Workflows |
| **Access & Identity** | Users, Groups, Authentication, OAuth |
| **Integrations** | All third-party integrations (Office 365, Google Drive, Jira, etc.) |
| **Customization** | Pages, UI configuration, Short Links, Marketplace |
| **Observability** | Audit Log, Workflow Executions, Agent Runs, Changelog |
| **Platform** | Security, Backup & Restore, Updates, Advanced |

**Collapsing the sidebar:** Click the chevron at the bottom of the sidebar to collapse it to icon-only mode. Hover over any icon to see its label. The collapse state is remembered across sessions.

**Mobile:** On small screens the sidebar is hidden by default. Tap the hamburger menu (☰) in the top bar to open the sidebar as a drawer.

---

## Keyboard Shortcuts

The admin UI supports keyboard shortcuts so you can navigate without reaching for the mouse.

### Navigation shortcuts

Press `g` followed by a letter within 300ms:

| Shortcut | Destination |
|----------|-------------|
| `g` `a` | Apps |
| `g` `m` | Models |
| `g` `p` | Prompts |
| `g` `u` | Users |
| `g` `g` | Groups |
| `g` `s` | Sources |
| `g` `l` | Audit Log |

### Other shortcuts

| Shortcut | Action |
|----------|--------|
| `n` | Create new item (on any list page) |
| `?` | Show the full shortcut cheatsheet |
| `Cmd+K` / `Ctrl+K` | Open the command palette |

> Shortcuts do not fire when focus is in a text input or textarea.

---

## Command Palette (Cmd+K)

Press `Cmd+K` (Mac) or `Ctrl+K` (Windows/Linux) from anywhere in the admin UI to open the command palette.

The palette lets you:
- **Navigate** to any admin page by name
- **Search entities** — type an app name, model ID, user, prompt, or source to jump directly to its edit page
- **Run actions** — "New App", "Run Backup", "Check for Updates", "View Audit Log"
- **See recent pages** — the last 5 pages you visited appear at the top

Results update as you type. Press `Enter` to navigate to the highlighted result, `Esc` to close.

---

## Overview Dashboard

The dashboard (`/admin`) gives a real-time snapshot of your platform.

**Stat cards:**
- **Apps** — total configured apps
- **Users** — registered users (with active sessions in the last 30 days shown as subtitle)
- **Conversations** — total chat sessions recorded
- **Version** — current iHub Apps version; shows an update badge if a newer version is available

**Platform status panel:** Shows enabled/total counts for providers, models, sources, and tools, plus active authentication methods and OAuth server status.

**Quick actions:** One-click shortcuts to the most common admin tasks.

**Setup checklist:** Shown on fresh installations to guide initial configuration. Disappears once the checklist steps are complete.

---

## Managing Apps

Apps are the AI-powered tools your users interact with. Each app has its own system prompt, model preference, variables, and permissions.

**To create an app:** Go to **AI Workspace → Apps** and click **New App**. You can start from a blank form, use a template, or upload a JSON file.

**To edit an app:** Click the app name in the list, or use `Cmd+K` to search for it directly.

**Key fields:**
- **ID** — unique identifier, used in URLs. Cannot be changed after creation.
- **Name / Description** — localized; enter values for each language you support.
- **System prompt** — the instruction given to the AI model before the user's message.
- **Preferred model** — override the platform default for this app.
- **Token limit** — maximum tokens per request.
- **Variables** — user-facing input fields shown before the chat starts (text, date, select, etc.).
- **Permissions** — which groups can access this app.

**Enabling/disabling:** Use the toggle in the app list or the Enabled field on the edit page.

**Change history:** Every edit page has a **History** button. Click it to see a before/after diff of every saved change, including who made the change and when.

---

## Managing Models

Models define which AI providers and specific model versions are available on your platform.

**To add a model:** Go to **AI Workspace → Models** and click **New Model** or upload a JSON file.

**Key fields:**
- **Provider** — the API provider (OpenAI, Anthropic, Google, Mistral, or a custom OpenAI-compatible endpoint).
- **Model ID** — the provider's model identifier (e.g. `gpt-4o`, `claude-opus-4-6`).
- **Token limit** — the maximum context window for this model.
- **Supports tools** — enable if the model supports function calling / tool use.

**Testing a model:** Use the **Test** button on the model list page to verify connectivity and authentication.

---

## Managing Prompts

Prompts are reusable system prompt templates that can be referenced by apps or used standalone.

Go to **AI Workspace → Prompts**. Prompts and Global Variables are organized as tabs.

**Global Variables** are key-value pairs injected into any system prompt that references `{{variableName}}`. They allow you to maintain shared values (company name, product names, URLs) in one place.

---

## Managing Users

Go to **Access & Identity → Users** to view, edit, and manage user accounts.

**Filtering:** Use the search box and filter dropdowns (auth method, group, status, last active) to find users. Filters are saved in the URL and persist across navigation.

**Editing a user:** Click the user's name to open their profile. You can change their groups, disable their account, and view their authentication methods and last active date.

**Bulk operations:** Select multiple users with the checkboxes to perform bulk actions (enable, disable, change group).

---

## Managing Groups

Groups control what users can access. Go to **Access & Identity → Groups**.

**Group inheritance:** Groups can inherit permissions from parent groups. For example, the built-in `users` group inherits from `authenticated`, which inherits from `anonymous`. A user's effective permissions are the union of their group's permissions and all inherited parent groups.

**Permissions:** Each group can be configured with:
- Which apps, prompts, and models are accessible
- Whether admin access is granted (`adminAccess: true`)
- External group mappings (for OIDC/LDAP — maps an external group name to this internal group)

---

## Audit Log

Go to **Observability → Audit Log** to see a complete record of all admin actions.

**Filtering:** Filter by date range, admin user, resource type (app, model, user, etc.), and action type (create, update, delete, toggle).

**Expanding rows:** Click any row to expand it and see the full event details. If a diff is available, it shows exactly what changed.

**URL-persisted filters:** All filter state is stored in the URL. You can bookmark a filtered view (e.g. all `delete` actions on `app` resources) or share it with a colleague.

---

## Change History

Every entity edit page (apps, models, prompts, sources, tools, providers, groups, users) has a **History** button in the page header.

Opening the history drawer shows:
- A list of every saved change, with timestamp and the admin who made it
- A before/after diff for each change — only the fields that changed are shown
- Both form edits and raw JSON editor changes are recorded

---

## Unsaved Changes

If you navigate away from an edit page with unsaved changes, a confirmation dialog will appear asking if you want to leave or stay. This prevents accidental data loss.

The warning also appears if you try to close or refresh the browser tab while a form is dirty.

---

## Backup & Restore

Go to **Platform → Backup & Restore** to export and import the full platform configuration.

**Export:** Downloads a ZIP file containing all configuration JSON files from `contents/`. The filename includes the current timestamp.

**Import:** Upload a previously exported ZIP. The current configuration is automatically backed up before the import is applied. After import, the server applies any pending configuration migrations automatically.

---

## Security Settings

Go to **Platform → Security** to manage:
- **SSL certificates** — upload a custom TLS certificate and key
- **CORS** — configure allowed origins for cross-origin API requests
- **Cookie settings** — SameSite policy, Secure flag, and session expiry
- **Value encryption** — encrypt a plaintext secret for use in configuration files

---

## Updates

Go to **Platform → Updates** to:
- See the current installed version
- Check for available updates
- Apply an update (binary installations only)
- Roll back to the previous version if needed

---

## Keyboard Shortcut Reference

| Shortcut | Action |
|----------|--------|
| `g` `a` | Go to Apps |
| `g` `m` | Go to Models |
| `g` `p` | Go to Prompts |
| `g` `u` | Go to Users |
| `g` `g` | Go to Groups |
| `g` `s` | Go to Sources |
| `g` `l` | Go to Audit Log |
| `n` | New item on current list page |
| `?` | Show shortcut cheatsheet |
| `Cmd+K` / `Ctrl+K` | Open command palette |
