# Fixes — Unreleased

## Outlook Add-in: Switching emails shows the new email straight away

Clicking a different email made the task pane refresh twice: first with the previously open email,
then with the new one. Sometimes it stopped at an empty "Email context" header with no email text.
Outlook reports a change in the message list before it opens the new email, and the pane read the
email at that moment. It now waits until Outlook has opened the new email and reads it once.
Selecting the open email again or a refresh of the message list no longer reloads it at all.
