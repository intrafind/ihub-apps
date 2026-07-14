# Follow-Up Suggestions Feature Documentation

## Overview

The follow-up suggestions feature reduces the "blank box" problem after an assistant
response by proposing 2-3 short, contextual follow-up questions the user might ask
next. Suggestions render as clickable chips below the completed assistant message;
clicking one sends its text as the next user message.

## Platform Configuration

The feature is registered in the feature registry as `followUpSuggestions` (category
`ai`, enabled by default). Toggle it platform-wide from Admin → Platform → Features.

## App Configuration

Override the feature per app by adding a `followUpSuggestions` object under the
`features` section:

```json
"features": {
  "followUpSuggestions": {
    "enabled": true,
    "model": "gpt-4o-mini"
  }
}
```

`followUpSuggestions` is opt-out at the app level, like `compareMode`: if the object
is present but `enabled` is omitted, the feature is treated as enabled. Both the
platform-level and app-level flags must be enabled for chips to appear. If `model`
is omitted, the platform's default model is used.

## API Endpoint

**POST /api/apps/{appId}/chat/{chatId}/followup-suggestions**

Request body:

| Field      | Type   | Required | Description                                                          |
| ---------- | ------ | -------- | ---------------------------------------------------------------------- |
| `messages` | array  | Yes      | Recent conversation turns (`{ role: 'user' \| 'assistant', content }`) |
| `language` | string | No       | BCP 47 language code for the generated suggestions                     |

Response body:

```json
{
  "suggestions": ["Can you give an example?", "What are the tradeoffs?"]
}
```

The endpoint never returns an error status for generation failures — it responds with
`{ "suggestions": [] }` instead, since this is a non-critical UX enhancement that
should never surface as a visible chat error. It returns `404` only when the app
itself does not exist.

## Client Flow

1. When the latest assistant message finishes streaming (and isn't an error or an
   in-progress clarification), the client fires a single request to the
   `followup-suggestions` endpoint with the last user/assistant exchange as context.
2. On a non-empty response, the suggestions are attached to that message and rendered
   as chips (`FollowUpChips`) below it.
3. Chips are only shown on the most recent assistant message and disappear once the
   user sends the next message (a new "latest assistant message" takes over).
4. Clicking a chip sends its text through the normal chat pipeline, using the
   currently selected model/style/temperature and other active chat parameters.

Not currently supported in Compare Mode (multiple response panels have no single
"latest message" to attach chips to).

## Suggestion Generation

The server prompts the configured model to return a bare JSON array of 2-3 short
follow-up questions (each under 60 characters), using only the last exchange as
context. Since not every model/provider reliably honors structured-output
instructions, the response is parsed defensively: a JSON array is extracted from the
completion if present, falling back to a line-by-line split (stripping bullets and
numbering) if the model didn't return valid JSON. At most 3 suggestions are returned.
