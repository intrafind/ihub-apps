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

## Outlook Add-in: Edit Message Form Stays Inside the Message Bubble

In the Outlook add-in task pane, choosing Edit on one of your messages showed the edit box sticking
out past the right edge of the message bubble instead of sitting inside it. The edit box and its
Cancel and Send buttons now stay inside the bubble at every pane width.

- The browser extension and Nextcloud integration use the same styling and get the same fix.
- The main web app was not affected.

## iAssistant Documents Come Back When a Chat Is Reopened

The **Documents** panel under an iAssistant answer disappeared when a stored chat was reopened from
the chat history. The documents are now stored with the answer and the panel comes back with it.
When an iAssistant conversation is resumed without chat history, its documents get the same
document access as during the live answer, so **Preview**, **Download** and **Add to email** work
there too.

- Documents are still fetched with the signed-in user's own iFinder permissions.
- Shared links do not include the Documents panel: its documents were found with the owner's
  iFinder permissions, and a viewer may not be allowed to see them.
