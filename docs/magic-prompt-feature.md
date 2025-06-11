# Magic Prompt Feature Documentation

## Overview

The magic prompt feature refines the user's input by sending it to an LLM with a configurable system prompt. The returned text replaces the current input so that users can easily start with a high quality prompt. A convenient undo option lets them revert back to their original text.

## Configuration

Enable the feature for an app by adding `"magicPrompt": true` under the `features` section of its configuration:

```json
"features": {
  "magicPrompt": true
}
```

Two environment variables control the behaviour of the generator:

- `MAGIC_PROMPT_MODEL` – model id used for generation (default `gpt-3.5-turbo`)
- `MAGIC_PROMPT_PROMPT` – system prompt sent along with the user input

## Usage

When enabled a sparkles icon appears next to the chat input. Clicking it replaces the current text with the generated prompt. A second button allows undoing this replacement.
