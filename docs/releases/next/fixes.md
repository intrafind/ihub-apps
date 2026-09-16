# Fixes — Unreleased

## Outlook Add-in: starter prompts no longer discard a typed note

Clicking a starter prompt such as "Generate a reply" while text was already in the chat input
replaced that text with the prompt's message and dropped it silently — on the start page as well
as inside a chat. The typed note now goes out together with the prompt's message, and the chat
shows exactly what was sent.

## Outlook Add-in: switching emails no longer shows the previous email's attachments as failed

Right after switching to another email, Outlook can still hand out the previous email's attachment
list while the new email's body is already served. The pane then listed the old attachments, each
marked "Failed", next to the new email — also on the start page. The add-in now recognises this
torn read (every attachment fetch failing with "attachment identifier does not exist") and reads
the email again after a short pause.

## Dollar signs inside message text are no longer altered

Text inserted into an app's prompt template — an email body, a pasted document — could change on
the way to the model: `$&`, `$'`, `` $` `` and `$$` were treated as replacement patterns when
`{{content}}` was filled in, so an email quoting "$$" arrived with a single dollar sign. The
inserted text now reaches the model exactly as written; only the template's own placeholders are
expanded.
