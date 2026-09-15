# Features — 5.4.11

## Answer-Source Badge Fixed When a Tool-Enabled App Answers an Upload Directly

Uploading a document or image to an app that has tools enabled, then getting an answer straight
away — the common "summarise this file" case where the model replies without calling a tool — now
shows the correct "Based on uploaded file" badge instead of "Based on AI knowledge". The badge was
attached on later tool-loop turns but not on this first, direct reply, so tool-enabled assistants
kept mislabeling upload-based answers.

- Covers document uploads, image uploads, and email context in tool-enabled apps.
- The detected source is also cleared when a turn instead pauses for a clarification question or
  ends in an error, so it can't carry over to the next message.
