# Prompts Library

Reusable prompt snippets are defined as individual JSON files inside the `contents/prompts/` directory. Each file represents one prompt that users can browse, search, and insert into the chat input from the prompts library.

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

The `variables` array defines form fields that appear before the prompt is sent. Each variable has:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `name` | string | Yes | Variable name used as the placeholder key in the prompt template (e.g., `content`). Must start with a letter or underscore. |
| `label` | object | Yes | Localized label shown above the input field. |
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
    "en": "Summarize the following text: [content]",
    "de": "Fasse den folgenden Text zusammen: [content]"
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
    "en": "Translate the following into German: [content]",
    "de": "Übersetze Folgendes ins Deutsche: [content]"
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
    "en": "Answer using our FAQ: [content]",
    "de": "Beantworte mithilfe unserer FAQ: [content]"
  },
  "appId": "faq-bot"
}
```

## API

The server exposes prompts through the following endpoint:

- `GET /api/prompts` — Returns all enabled prompts, filtered by the current user's permissions and the active app context.

The client UI shows prompts in the prompts library where users can search, filter by category, and click to insert the prompt text into the chat input.

## Adding a New Prompt

1. Create a new file in `contents/prompts/` named `<id>.json`.
2. Fill in the required fields: `id`, `name`, `description`, `prompt`.
3. Optionally set `category`, `icon`, `variables`, and other fields.
4. Save the file. No server restart is needed — the new prompt appears immediately.

## Managing Prompts via Admin UI

Prompts can also be created and edited through the admin panel at `/admin/prompts`. Changes made through the admin panel write directly to the corresponding file in `contents/prompts/`.
