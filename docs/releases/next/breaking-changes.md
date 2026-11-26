# Breaking Changes — Unreleased

## Projects Keep the Original of an Uploaded File

A file uploaded to a project is now kept next to its extracted text, encrypted the same way, so it
can be downloaded again and handed to an app as the file it was. Until now a project kept only the
text. Projects follow the setting chat uploads already use, **Admin → Chat history → Uploaded
files → What the server keeps** (`platform.uploads.storageMode`), which is `original_and_text` by
default.

- Project storage grows by the size of the uploaded files from now on. Documents uploaded before the
  upgrade stay text only.
- An app's own upload setting does not apply to projects; only the installation's does.
- A project keeps an original as long as the document. `originalRetentionDays` applies to chats only.
- Editing a document's text removes its original.

**Before upgrading:** if your installation must keep no original files (for example because your
compliance statement says so), set **What the server keeps** to "Only the text" (`server_text_only`).
That applies to chat uploads too.
