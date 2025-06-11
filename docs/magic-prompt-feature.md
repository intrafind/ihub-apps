# Magic Prompt Feature Documentation

## Overview

The magic prompt feature refines the user's input by sending it to an LLM with a configurable system prompt. The returned text replaces the current input so that users can easily start with a high quality prompt. A convenient undo option lets them revert back to their original text.

## Configuration

Enable and configure the feature for an app by adding a `magicPrompt` object under the `features` section:

```json
"features": {
  "magicPrompt": {
    "enabled": true,
    "model": "gpt-3.5-turbo",
    "prompt": "Rewrite the user input into a concise high quality prompt and respond only with the new prompt."
  }
}
```

If no model or prompt is specified in the configuration the server falls back to the environment variables
`MAGIC_PROMPT_MODEL` and `MAGIC_PROMPT_PROMPT`.

## Usage

When enabled a sparkles icon appears next to the chat input. Clicking it
triggers generation and the button shows a spinning animation while the request
is processed. Once the text has been replaced, the sparkles button turns into a
back arrow allowing the user to restore the original input. Submitting the
message automatically resets the button back to the sparkles icon for the next
prompt.
