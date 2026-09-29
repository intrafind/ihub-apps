# Fixes — Unreleased

## vLLM models respect "Show reasoning" being turned off

On vLLM models (`provider: "local"`), turning off "Show reasoning" in the model settings, or
"Show thinking process" in an app or chat, had no effect: the model's reasoning was still shown.
The model still reasons, but its reasoning text is no longer returned or shown.

- The model setting is the default; an app's thinking settings and the user's toggle override it.
- Needs a vLLM version that supports `include_reasoning`. Older servers ignore it and keep
  showing the reasoning.

## Outlook Add-in: Edit Message Form Stays Inside the Message Bubble

In the Outlook add-in task pane, choosing Edit on one of your messages showed the edit box sticking
out past the right edge of the message bubble instead of sitting inside it. The edit box and its
Cancel and Send buttons now stay inside the bubble at every pane width.

- The browser extension and Nextcloud integration use the same styling and get the same fix.
- The main web app was not affected.
