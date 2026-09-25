# Features — 5.5.23

## Outlook Add-in: Install Dev and Production Side by Side

Every iHub installation used to serve the Outlook manifest with the same add-in ID and version,
so Outlook saw a second server as the add-in it already had: a dev instance could not be
installed next to production, and a re-deployed manifest was ignored.

- **Admin → Office Integration → Office Manifest** shows the add-in ID and a **Generate new ID**
  button. A new ID makes this server a separate add-in in Outlook; users of the old one must
  install the new manifest.
- Installations that never generate an ID keep the current one, so deployed add-ins keep working.
- The manifest version now follows the iHub release, so Outlook picks up a re-deployed manifest
  after every upgrade.
