# Fixes — Unreleased

## Outlook Add-in: Switching Emails in the Pinned Pane Refreshes Once

Clicking another email with the iHub pane pinned refreshed the pane twice, showing the previous
email again in between, so every switch felt like a full reload. Outlook for Mac reports the
selection change before the email change, and the pane treated both as a reload.

- The pane now refreshes once per switch, straight to the new email. Re-selecting the open email
  or a refresh of the message list no longer changes anything on screen.
- Where Outlook lets add-ins read the selected message directly (Mailbox 1.15 and full mailbox
  access), the pane reads it even when Outlook has not reported the email change yet, and Reply,
  Reply all and Forward act on that email.
- Outlook versions that do not allow this, such as Outlook for Mac 16.x, are no longer asked, so
  the pane stops logging "not available" and "elevated permission" errors on every click.
