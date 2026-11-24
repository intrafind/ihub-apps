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
