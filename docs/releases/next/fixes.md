# Fixes — Unreleased

## Outlook Add-in: Switching emails shows the new email once, and always

Clicking a different email made the task pane refresh twice: first with the previously open email,
then with the new one. Sometimes it stopped at an empty "Email context" header with no email text.
Outlook reports a change in the message list before it opens the new email, and can keep naming the
previous email for a moment after it has switched, so a read at the wrong moment returned the old
email or nothing. The pane now decides from what it actually read: a selection change is read in the
background and only replaces the shown email when the read really returned a different one, and a
read that still returned the previous email, or no email, is checked once more shortly after.
Re-selecting the open email or a refresh of the message list changes nothing on screen.
