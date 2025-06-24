# Prompts Database

Reusable prompt snippets can be managed in `prompts.json`. Each entry defines metadata and a text fragment that can be inserted into the user's message.

Example entry:

```json
{
  "id": "summarize",
  "name": { "en": "Summarize Text" },
  "description": { "en": "Quickly summarize a block of text." },
  "icon": "sparkles",
  "prompt": { "en": "Summarize the following text: [content]" }
}
```

The server exposes the prompts via `GET /api/prompts`. The client UI shows them in the prompts library where users can search and insert them into the chat input.
