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
