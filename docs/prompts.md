# Prompts Library

The prompt library holds reusable prompts that users browse on `/prompts`, find with `/` in an empty chat input, and insert into a chat. It has two kinds of prompts:

- **Global prompts** are curated by admins. They are JSON files in `contents/prompts/` and are visible to the groups whose `prompts` permission includes them. This page describes their format first.
- **User prompts** are written by signed-in users. They are private by default and can be shared with specific users, groups, or everyone signed in. See [User Prompts](#user-prompts).

Both kinds can use `{{variables}}`. When a user picks a prompt with variables, a short form asks for the values before the text goes into the chat input. See [Variables](#variables-in-prompt-text).

## File Structure

Each prompt is a standalone JSON file named after the prompt's `id`:

```
contents/prompts/
├── summarize.json
├── translate-de.json
├── faq-question.json
└── app-generator.json
```

The server loads all `*.json` files from that directory automatically. No central index file is needed. New prompts are available immediately after the file is saved because the configuration is reloaded from cache.

## Full Schema

The schema is enforced by `server/validators/promptConfigSchema.js` using Zod. All fields marked **required** must be present and non-empty.

### Top-level Fields

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `id` | string | Yes | Unique identifier. Lowercase letters, numbers, hyphens, underscores, and dots only. |
| `name` | object | Yes | Localized display name. See Localized String below. |
| `description` | object | Yes | Localized short description shown in the library card. |
| `prompt` | object | Yes | Localized prompt text inserted into the chat input. |
| `icon` | string | No | Icon identifier (e.g., `sparkles`, `globe`, `cog`). |
| `enabled` | boolean | No | Whether the prompt is visible to users. Defaults to `true`. |
| `order` | integer | No | Display order (ascending). Prompts without an order appear after ordered ones. |
| `category` | string | No | Category ID for filtering. Must match a category defined in `ui.json` > `promptsList.categories`. |
| `appId` | string | No | If set, this prompt is only offered when the user is in the specified app. |
| `variables` | array | No | Input variable definitions. See Variables below. |
| `actions` | array | No | Action buttons shown alongside the prompt. See Actions below. |
| `outputSchema` | object | No | JSON Schema object describing the expected structured output. |

### Localized String

All localized fields (e.g., `name`, `description`, `prompt`) are plain objects whose keys are BCP 47 language codes (`"en"`, `"de"`, `"en-US"`) and whose values are non-empty strings:

```json
"name": {
  "en": "Summarize Text",
  "de": "Text zusammenfassen"
}
```

### Variables

The `variables` array optionally describes the `{{placeholders}}` in the prompt text (see [Variables in prompt text](#variables-in-prompt-text)). A placeholder without an entry here is still asked for, as a required free-text field. Each entry has:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `name` | string | Yes | The placeholder it describes: `tone` describes `{{tone}}`. Must start with a letter or underscore. |
| `label` | object | No | Localized label shown above the input field. Defaults to the name, e.g. `due_date` → "Due date". |
| `description` | object | No | Localized help text shown under the field. |
| `type` | enum | No | Input type. One of `string`, `number`, `boolean`, `select`, `textarea`. Defaults to `string`. |
| `required` | boolean | No | Whether the field must be filled before sending. Defaults to `false`. |
| `defaultValue` | string \| number \| boolean | No | Pre-filled value. |
| `predefinedValues` | array | No | For `select` type: list of `{ label, value }` options. |

Variable types at a glance:

- **string** — single-line text input
- **textarea** — multi-line text input
- **number** — numeric input
- **boolean** — checkbox
- **select** — dropdown with `predefinedValues`

### Actions

The `actions` array defines extra action buttons shown in the prompt card:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `id` | string | Yes | Unique action identifier. |
| `label` | object | Yes | Localized button label. |
| `description` | object | No | Localized tooltip or description. |

### Output Schema

Use `outputSchema` to request structured JSON output from the LLM. The schema follows the JSON Schema specification:

```json
"outputSchema": {
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "keywords": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["summary"]
}
```

## Examples

### Minimal Prompt — Summarize

```json
{
  "id": "summarize",
  "category": "summarization",
  "name": { "en": "Summarize Text", "de": "Text zusammenfassen" },
  "description": {
    "en": "Quickly summarize a block of text.",
    "de": "Einen Textabschnitt schnell zusammenfassen."
  },
  "icon": "sparkles",
  "prompt": {
    "en": "Summarize the following text: {{content}}",
    "de": "Fasse den folgenden Text zusammen: {{content}}"
  }
}
```

### Translation Prompt

```json
{
  "id": "translate-de",
  "category": "translation",
  "name": { "en": "Translate to German", "de": "Ins Deutsche übersetzen" },
  "description": { "en": "Translate text into German.", "de": "Text ins Deutsche übersetzen." },
  "icon": "globe",
  "prompt": {
    "en": "Translate the following into German: {{content}}",
    "de": "Übersetze Folgendes ins Deutsche: {{content}}"
  }
}
```

### App-Scoped Prompt — FAQ Bot

This prompt is only available when the user is inside the `faq-bot` app:

```json
{
  "id": "faq-question",
  "category": "qa",
  "name": { "en": "Ask FAQ", "de": "FAQ fragen" },
  "description": {
    "en": "Answer questions using the FAQ bot.",
    "de": "Fragen mit dem FAQ-Bot beantworten."
  },
  "icon": "question-mark-circle",
  "prompt": {
    "en": "Answer using our FAQ: {{content}}",
    "de": "Beantworte mithilfe unserer FAQ: {{content}}"
  },
  "appId": "faq-bot"
}
```

## Variables in Prompt Text

Prompt text uses one placeholder syntax, `{{name}}` — the same as app system prompts and the global prompt variables. For example:

```text
Write a {{tone}} email to {{recipient}} about {{topic}}.
```

When a user picks this prompt (from the library, from `/` in the chat, or with **Use in chat** in the details), a dialog asks for **tone**, **recipient**, and **topic**, checks required fields, and shows a live preview of the final text. The final text is **inserted into the chat input, not sent**, so the user can still edit it. **Copy** uses the same dialog and copies the final text instead.

Placeholders fall into three groups:

| Placeholder | What happens |
| ----------- | ------------ |
| `{{user_name}}`, `{{user_email}}`, `{{date}}`, `{{date_iso}}`, `{{time}}`, `{{day_of_week}}`, `{{year}}`, `{{month}}`, `{{timezone}}`, `{{locale}}`, `{{location}}`, `{{model_name}}`, `{{platform_context}}`, and the custom variables from **Admin → Prompts → Variables** | Filled in automatically with the server's values for the user. Never asked for. |
| `{{content}}` | Marks where the user's own text goes. It is removed on insert, and the cursor is placed there. |
| Anything else, for example `{{tone}}` or `{{recipient}}` | Asked for in the dialog. |

A variable listed in `variables` is always asked for, even if its name would otherwise fill in automatically. This is how an author makes `{{content}}` a text area in the dialog, for example. `{{tone}}` is asked for because the chat's style setting that fills it is usually unset.

If a prompt has an `appId` and declares variables that its text does not use, the dialog asks for those too and passes them to the app as `var_*` parameters, as before. That needs an app the user can open: a shared prompt can name an app its author may open and the recipient may not, and then it opens in the default app and those variables are not asked for.

What the user types into a field goes into the text as typed; one field's value is never filled in by another. The final text is an ordinary chat message, though, so when it is sent the server fills in the automatic variables in it, as it does in anything typed into the chat. A value that contains `{{date}}` is sent with the date.

> **Upgrading:** Prompts used `[content]` before. Migration `V136` rewrites every `[content]` in `contents/prompts/*.json` (and in a legacy `config/prompts.json`) to `{{content}}`. `[content]` is no longer recognized.

## User Prompts

Any signed-in user can create prompts on `/prompts` (**New prompt**) or from a chat: hovering a message you sent shows **Save as prompt**, which opens the editor with that text.

The editor has a name, description, icon, category, the app the prompt opens in (or the default app), and the prompt text. **Insert variable** adds a `{{name}}` at the cursor. Variables are detected from the text as you type, and each can be configured with a label, help text, type (`string`, `textarea`, `number`, `boolean`, `select`), default value, required flag, and select options.

### Scopes and permissions

| Scope | Created by | Visible to | Editable by |
| ----- | ---------- | ---------- | ----------- |
| **Global** | Admins and content admins | Groups granted through the `prompts` permission | Admins |
| **User** (Mine / Shared) | Any signed-in user | The owner and everyone it is shared with | The owner, anyone shared with *can edit*, and admins |

- A prompt can be shared with **specific users**, **groups** (group inheritance is resolved, so a share with `users` also reaches a group that inherits `users`), or **everyone signed in**.
- Each share is *can use* (see, insert, copy, duplicate) or *can edit* (also change the text and variables, and share it further).
- Only the owner and admins can delete a prompt or hand it to another user.
- Changes take effect right away. Removing a share removes the prompt from that person's list and from `/` search.
- Anonymous users can use the global prompts their group allows. They cannot create user prompts, and nobody can share with them.
- When the owner's account is deleted or deactivated, the prompt stays usable for everyone it is shared with, but becomes read-only. Only admins can still change or delete it.
- Anyone who can see a prompt can **duplicate** it into their own prompts to customize it. Global prompts are copied in the current language.
- Every prompt shows who created it and who changed it last.

All ownership and share checks run on the server. The client only uses the `permissions` the server returns to show or hide actions.

### Versions

Every save of a user prompt is kept as a version. Those who can edit a prompt can open **History**, compare versions, and restore one. A restore is saved as a new version, so nothing is lost. The number of versions kept per prompt is set in the admin settings (default 50).

### Favorites and recents

Favorites and recently used prompts are stored on the server for each signed-in user, so they follow the user across browsers and devices. The first time, favorites and recents this browser stored earlier are moved to the server. Anonymous users keep them in the browser.

### Finding prompts

- `/prompts` has filters for **All**, **My prompts**, **Shared with me**, **Global**, and **Favorites**, in addition to the category filter and search. Each card shows its scope (Global / Mine / Shared) and, for shared prompts, the owner. Clicking a card opens a chat in the prompt's app, or in the default app, with the final text in the input.
- `/` in an empty chat input lists favorites, recent prompts, My prompts, Shared with me, and Global prompts, in that order. Typing searches all of them.

### Storage

User prompts, their versions, share markers, and each user's favorites and recents are runtime data. They are stored through the storage provider (`contents/data/` with the default filesystem provider) in the namespaces `user-prompts`, `user-prompt-versions`, `user-prompt-shares`, and `prompt-preferences`, not in `contents/prompts/`. If the storage provider is unavailable, users cannot create prompts, and global prompts keep working.

## Admin

**Admin → Prompts** has three tabs:

- **Prompts** manages the global prompts, as before. Saving a prompt records `createdBy`, `createdAt`, `updatedBy`, and `updatedAt`. The editor lists the placeholders detected in the text; **Describe** adds an entry for one to `variables`.
- **User prompts** lists the user prompts shared with a group or with everyone. Private prompts and prompts shared only with named users are not listed. Admins can view, edit, re-share, view the history of, delete, and **promote** these prompts. Promoting copies the prompt into `contents/prompts/` as a global prompt in the platform's default language, keeps the original author as `createdBy`, and records `sourcePromptId`. Who sees the new global prompt is decided by the groups' `prompts` permission, like every other global prompt.
- **Variables** manages the global prompt variables.

Every create, update, share change, delete, restore, and promote is written to the audit log.

### Settings

The settings for user prompts are under **Admin → Prompts → User prompts → Settings for user prompts** (full admins only) and are stored in `platform.json`:

```json
"userPrompts": {
  "enabled": true,
  "maxPromptsPerUser": 0,
  "maxVersions": 50,
  "sharing": {
    "allowUsers": true,
    "allowGroups": true,
    "allowEveryone": true,
    "restrictToGroups": []
  }
}
```

| Setting | Description |
| ------- | ----------- |
| `enabled` | Whether users can create their own prompts. Global prompts are not affected. While it is off, users do not see or change their prompts, and prompt admins can still review, unshare, hand over and delete the ones that exist. |
| `maxPromptsPerUser` | Most prompts one user can own, whether created, duplicated or handed over to them. `0` means no limit. |
| `maxVersions` | Versions kept per prompt. Older ones are removed. |
| `sharing.allowUsers` / `allowGroups` / `allowEveryone` | Which audiences users can share with. These are checked when a share is added, so existing shares keep working. |
| `sharing.restrictToGroups` | When it lists groups, only their members can share with groups or with everyone. Sharing with specific users is not affected. |

The whole prompt library, including user prompts, is switched on and off with the **Prompts Library** feature flag.

## API

There is one API for both kinds of prompts. Every call except the list and single-prompt reads requires a signed-in user.

| Method and path | Description |
| --------------- | ----------- |
| `GET /api/prompts?scope=all\|global\|mine\|shared\|favorites` | The global prompts the caller may see, plus their own and shared user prompts. Each entry has `scope`, `owner`, and `permissions` (`canEdit`, `canShare`, `canDelete`, `canTransfer`, `canDuplicate`). |
| `GET /api/prompts/:id` | One prompt, global or user. User prompt ids start with `upr_`. |
| `POST /api/prompts` | Create a user prompt: `{ name, description?, prompt, icon?, category?, appId?, variables? }`. |
| `PUT /api/prompts/:id` | Save a new version. Pass `expectedRevision` to get `409` if someone else saved in between. |
| `DELETE /api/prompts/:id` | Delete a user prompt (owner or admin). |
| `PUT /api/prompts/:id/shares` | Replace the share list: `{ shares: [{ type: "user"\|"group"\|"everyone", id?, permission: "use"\|"edit" }] }`. |
| `PUT /api/prompts/:id/owner` | Hand the prompt to another user: `{ ownerId }` (owner or admin). |
| `POST /api/prompts/:id/duplicate` | Copy a global or shared prompt into the caller's prompts: `{ name?, language? }`. |
| `GET /api/prompts/:id/versions` | Saved versions, newest first (for those who can edit). |
| `POST /api/prompts/:id/versions/:revision/restore` | Restore a version as a new one. |
| `GET /api/prompts/share-targets?q=` | Users and groups the caller may share with. |
| `GET /api/prompts/variables` | The values of the automatic variables for the caller. |
| `GET` / `PUT /api/prompts/preferences` | The caller's favorites and recents. |
| `POST /api/prompts/:id/usage` | Record a use, for "recently used". |
| `GET /api/admin/prompts?scope=user` | Admin: user prompts shared with groups or everyone. |
| `POST /api/admin/prompts/:id/promote` | Admin: promote a user prompt to a global prompt: `{ id?, enabled? }`. |
| `GET` / `PUT /api/admin/prompts/user-settings` | Admin: the `userPrompts` settings. |

## Adding a New Prompt

1. Create a new file in `contents/prompts/` named `<id>.json`.
2. Fill in the required fields: `id`, `name`, `description`, `prompt`.
3. Optionally set `category`, `icon`, `variables`, and other fields.
4. Save the file. No server restart is needed — the new prompt appears immediately.

## Managing Prompts via Admin UI

Global prompts can also be created and edited in **Admin → Prompts**. Changes made there are written directly to the corresponding file in `contents/prompts/`.
