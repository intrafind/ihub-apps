# Fixes — Unreleased

## Outlook Add-in: The Task Pane Follows the Selected Email on Mac

On Outlook for Mac, the pinned iHub pane stayed on the email it was opened on. Clicking another
email refreshed the pane but showed the same email again, and only closing and reopening the pane
picked up the new one. Outlook for Mac does not update the add-in's current email when the
selection changes, so the pane now reads the selected email itself.

- The email context, "Add email(s)" and the token estimate follow every email you click, so you
  can switch between emails and collect several without reopening the pane.
- Reply, Reply all and Forward act on the selected email, not the one the pane was opened on.
- If the pane is opened with no email selected, it picks up the first email you click.
