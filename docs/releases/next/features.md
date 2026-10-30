# Features — Unreleased

## Chat: Artifacts Panel With Preview and ZIP Download

A new **Artifacts** panel lists every file a chat produced: generated pictures, PDF, Word and
PowerPoint documents, code and data files, and ZIP archives. Open it from the chat header once an
answer created a picture or a file.

- **Preview** pictures, rendered Markdown, formatted JSON and code without downloading them.
- **Download or copy** a single file.
- **Download several files, or all of them, as one ZIP**: tick the files and choose
  **Download selected (.zip)**, or **Download all (.zip)**. The archive keeps folders such as
  `src/index.js`, and the limits in `platform.json → artifacts.maxZipFiles` / `maxZipBytes` apply.
- **Shared chats** offer the same panel for the files the share contains.
- Keyboard and screen-reader friendly: the panel is a dialog that keeps focus inside, closes with
  Escape and returns focus to where it was opened.

See [User guide → The chat header](../../user-guide.md#the-chat-header) and
[Artifacts](../../artifacts.md#the-artifacts-panel).
