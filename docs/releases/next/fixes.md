# Fixes — Unreleased

## Windows Installations Before 5.6.2 Can Update in Place Again

On Windows, `--update` and **Admin → Updates** of installations older than 5.6.2 reported "No
binary available for platform: windows" and then "No download URL available for this platform",
although a newer release existed. Their updater looks for a `-windows.tar.gz` archive, and the
release only had `-win.zip`.

- Every release now also carries `ihub-apps-v<version>-windows.tar.gz`, with the same files as
  `-win.zip`. It is listed in the signed `checksums.sha256` like the other archives.
- Before updating such an installation, back up `contents\`: the updater of those versions takes
  no configuration snapshot and does not check signatures. It also leaves out files added after
  it was written, such as `browser-extension\`, which stay missing until the next update, made
  with 5.6.2 or later.
- From 5.6.2 on, an installation updates from `-win.zip` and does not use the extra archive.

## "Edit App" in the Chat Opens the Right Editor for Personal Apps

In the chat of a personal app, **Edit App** opened the admin editor, which answered "Not found:
app …" because it does not know personal apps. A person who is not an administrator did not
get the button at all.

- The button opens the personal editor (`/apps/<id>/edit`) for the owner of a personal app and
  for everyone it is shared with as "Can edit", administrator or not.
- Someone who may only use a personal app, or an administrator who has no edit right on it,
  sees no button.
- For an app of the company, nothing changes: administrators land in the admin editor.

## PDFs Print the Title Once

A PDF could show its title twice: on the cover page and again as the first heading of the text, or
as the title and again as a first heading with a few more words ("Quarterly Report" and "Quarterly
Report 2026").

- A first heading that repeats the title is left out of the text when the title is on a cover page,
  as it already was when the title sits above the text.
- A first heading that only adds or drops words at the start or end of the title counts as the
  title. When the heading is the longer one, its wording is printed once as the title.
- A different first heading, and a heading further down, stay.


## Windows: Startup No Longer Stops When a Virus Scanner Holds a Configuration File

On Windows, startup could stop during the configuration migrations, most often on a fresh install,
with an error like this:

> Migration V233 (web_chat_inline_citations) failed: EPERM: operation not permitted, rename
> '…\contents\.tmp_…' -> '…\contents\.migration-history.json'

A virus scanner such as Microsoft Defender, the search indexer or a backup agent held the file
open for a moment while iHub replaced it.

- iHub now tries again for about a second when Windows reports a file as locked. This covers
  every configuration and data file iHub saves, not only the migration history.
- When a migration ran but the history file cannot be written, the error now says so, and the
  history no longer lists that migration as failed.
