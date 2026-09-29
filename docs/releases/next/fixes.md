# Fixes — Unreleased

## vLLM models respect "Show reasoning" being turned off

On vLLM models (`provider: "local"`), turning off "Show reasoning" in the model settings, or
"Show thinking process" in an app or chat, had no effect: the model's reasoning was still shown.
The model still reasons, but its reasoning text is no longer returned or shown.

- The model setting is the default; an app's thinking settings and the user's toggle override it.
- Needs a vLLM version that supports `include_reasoning`. Older servers ignore it and keep
  showing the reasoning.

## Outlook Add-in: copy options menu no longer opens off-screen

In the narrow Outlook task pane, the copy options menu under an assistant answer ("as Text",
"as Markdown", "as HTML") opened to the left of the pane and was cut off, so the copy formats could
not be reached. The menu now opens to the right, inside the pane.

- Applies to every chat view that shows assistant messages, not just the Outlook add-in.
- Menus under your own messages still open to the left, as those are right-aligned.
