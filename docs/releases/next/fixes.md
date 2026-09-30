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

## Azure Speech Dictation Works Again

Dictation with Azure Speech put no text into the chat input. The subscription key set under
**Admin → Voice Input** was also never used: an app without a host of its own failed with "Azure
subscription key is not configured".

- The recognized text is delivered to the input again, in both manual and automatic mode.
- The subscription key stored on the server is used (as a short-lived token), and apps without
  a host of their own fall back to the host set under **Admin → Voice Input**, as documented.
- A "no speech detected" error no longer leaves the microphone in the listening state.

## Admin → Voice Input Confirms a Save

Saving on **Admin → Voice Input** showed no confirmation, and the page briefly went blank while
reloading. It now stays in place and shows "Voice input settings saved."
