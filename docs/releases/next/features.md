# Features — Unreleased

## Uploads: Teams Transcripts (.vtt) and Any Text File

Users can now attach WebVTT files (`.vtt`) — the format Microsoft Teams exports meeting transcripts
in — to chats in any app that accepts plain text files. Admins can also allow "Any text file" for
an app, so logs, YAML, subtitle files and other plain-text formats can be uploaded without listing
each one.

- Existing apps that accept `.txt` accept `.vtt` automatically after the upgrade.
- "Any text file" is off by default. Enable it under **Admin → Apps → Upload → Supported File
  Formats**. The file picker then shows all files; binary files are rejected on upload, and formats
  such as PDF or Word are only extracted when they are selected explicitly.
