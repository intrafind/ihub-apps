# ask_user Tool Documentation

The `ask_user` tool enables AI apps to ask users clarifying questions mid-conversation through structured UI elements.

## Overview

When an LLM needs more information to complete a task, it can call the `ask_user` tool to present a question to the user with:
- **Choice-based options** (chips or dropdown)
- **Free text input**
- **Date/number inputs**

The conversation pauses until the user responds, then continues with the enriched context.

## Enabling the Tool

Add `"ask_user"` to your app's tools array:

```json
{
  "id": "my-app",
  "name": { "en": "My App" },
  "tools": ["ask_user"],
  "system": {
    "en": "You are a helpful assistant. When you need clarification, use the ask_user tool."
  }
}
```

## Tool Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `question` | string | Yes | - | The question to ask (max 500 chars) |
| `input_type` | string | No | `"text"` | Input type (see below) |
| `options` | array | No | `[]` | Options for select types (max 20) |
| `allow_other` | boolean | No | `false` | Show "Other" free text option |
| `allow_skip` | boolean | No | `false` | Allow user to skip |
| `placeholder` | string | No | - | Placeholder text for inputs |
| `context` | string | No | - | Additional context (max 500 chars) |
| `validation` | object | No | - | Validation rules |

### Input Types

| Type | UI Component | Best For |
|------|--------------|----------|
| `single_select` | Chips (≤4) or Dropdown (>4) | Choose one option |
| `multi_select` | Chips with checkmarks | Choose multiple options |
| `text` | Textarea | Open-ended responses |
| `number` | Number input | Numeric values |
| `date` | Date picker | Single date |
| `date_range` | Two date pickers | Date range |

## System Prompt Best Practices

Include these guidelines in your app's system prompt:

```
When you need to ask the user a clarifying question, use the ask_user tool.

Guidelines for ask_user:
1. Keep questions SHORT and DIRECT - don't repeat user input
2. When there are common choices, ALWAYS provide options
3. Use input_type "single_select" or "multi_select" with options for choices
4. Use input_type "text" only for truly open-ended questions
5. Set allow_other: true if the user might have an option not listed
6. Use context to explain WHY you're asking (optional)

IMPORTANT: Provide options whenever possible - it's faster for users!
```

## Examples

### Example 1: Translation App

**System Prompt:**
```
You are a translator. When the target language is not specified, ask the user.

When asking for language:
- Use single_select with common language options
- Set allow_other: true for less common languages
- Keep the question simple: "Which language?"
```

**Good Tool Call:**
```json
{
  "name": "ask_user",
  "arguments": {
    "question": "Which language?",
    "input_type": "single_select",
    "options": [
      { "label": "English", "value": "en" },
      { "label": "French", "value": "fr" },
      { "label": "Spanish", "value": "es" },
      { "label": "Italian", "value": "it" },
      { "label": "Portuguese", "value": "pt" }
    ],
    "allow_other": true,
    "context": "Select target language for translation"
  }
}
```

**Bad Tool Call (avoid this):**
```json
{
  "name": "ask_user",
  "arguments": {
    "question": "Into which language would you like me to translate 'Ich liebe dich!'?",
    "input_type": "text"
  }
}
```

### Example 2: Meeting Planner

**System Prompt:**
```
You help schedule meetings. Always ask for:
1. Meeting type (use options)
2. Attendees (multi_select if known, otherwise text)
3. Preferred date (date input)
```

**Tool Calls:**
```json
{
  "name": "ask_user",
  "arguments": {
    "question": "What type of meeting?",
    "input_type": "single_select",
    "options": [
      { "label": "Team Sync", "value": "sync" },
      { "label": "1:1", "value": "one_on_one" },
      { "label": "Project Review", "value": "review" },
      { "label": "Brainstorm", "value": "brainstorm" }
    ],
    "allow_other": true
  }
}
```

```json
{
  "name": "ask_user",
  "arguments": {
    "question": "When should we schedule it?",
    "input_type": "date",
    "context": "Select your preferred date"
  }
}
```

### Example 3: Concept Writer / Product Spec

**System Prompt:**
```
You help product managers write detailed specifications.

When gathering requirements, ask clarifying questions:
- Use multi_select for features, audiences, platforms
- Use single_select for priority, timeline, complexity
- Use text only for open-ended descriptions

Keep questions focused and provide relevant options based on context.
```

**Tool Calls:**
```json
{
  "name": "ask_user",
  "arguments": {
    "question": "Who is the target audience?",
    "input_type": "multi_select",
    "options": [
      { "label": "Developers", "value": "developers" },
      { "label": "Product Managers", "value": "pm" },
      { "label": "End Users", "value": "end_users" },
      { "label": "Admins", "value": "admins" }
    ],
    "allow_other": true,
    "context": "Select all that apply"
  }
}
```

```json
{
  "name": "ask_user",
  "arguments": {
    "question": "What's the priority?",
    "input_type": "single_select",
    "options": [
      { "label": "Critical - Must have", "value": "p0" },
      { "label": "High - Should have", "value": "p1" },
      { "label": "Medium - Nice to have", "value": "p2" },
      { "label": "Low - Future consideration", "value": "p3" }
    ]
  }
}
```

### Example 4: Search Clarification

**System Prompt:**
```
When a search query is ambiguous (e.g., abbreviations, multiple meanings),
ask the user to clarify using text input.
```

**Tool Call:**
```json
{
  "name": "ask_user",
  "arguments": {
    "question": "What does 'DM' refer to?",
    "input_type": "text",
    "placeholder": "e.g., Direct Message, Data Manager, Daniel Manzke...",
    "context": "The abbreviation 'DM' has multiple meanings"
  }
}
```

## Rate Limiting

- Maximum **10 clarifications per conversation**
- If exceeded, the LLM receives an error instructing it to proceed with available information
- This prevents infinite question loops

## UI Behavior

| Options Count | UI Component |
|---------------|--------------|
| 1-4 options | Chips (inline buttons) |
| 5+ options | Searchable dropdown |

- **Blocking**: Chat input is disabled until user responds
- **Skip**: Optional skip button (when `allow_skip: true`)
- **Other**: Free text option (when `allow_other: true`)

## Response Format

When the user responds, the LLM receives:

```json
{
  "status": "user_responded",
  "question": "Which language?",
  "answer": "fr",
  "display_text": "French"
}
```

## Tips for App Developers

1. **Be specific in your system prompt** - Tell the LLM exactly how to use ask_user
2. **Provide example tool calls** - Show the LLM the format you expect
3. **Use options liberally** - Clicking is faster than typing
4. **Set `allow_other: true`** - Users often have unexpected answers
5. **Keep questions short** - Don't repeat user input in questions
6. **Use context sparingly** - Only when the question needs explanation
7. **Test with different models** - Tool calling quality varies by model
