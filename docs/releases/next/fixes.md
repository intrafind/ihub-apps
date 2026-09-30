# Fixes — Unreleased

## Audio Answers No Longer Say "Based on AI Knowledge"

A transcript of a recording or an uploaded audio or video file was labelled "Based on AI knowledge"
— although the text comes straight from the user's own audio. The badge under the answer now reads
"Based on audio recording".

- Applies to transcripts from the transcription model (upload, video and microphone recording),
  including a partial transcript kept after a cancelled or interrupted run.
- Also applies when audio is sent directly to a chat model that accepts it, such as the
  **Audio Transcription** app.
- A failed transcription still shows the error message without a badge.

## Admins' Own Chats Clear Their "New" Badge When Opened

For admins, a chat answered while they were away kept its "new" dot in **Recents** and the chat
list even after they opened it. The server treated an admin reading their own chat like an admin
reading somebody else's, which deliberately leaves the badge alone. It now checks ownership first.
Opening another user's chat as an admin still leaves that user's badge untouched.
