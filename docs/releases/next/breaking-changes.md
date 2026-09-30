# Breaking Changes — Unreleased

## Prompt Library: `[content]` Is Now `{{content}}`

Prompts in the prompt library mark where the user's own text goes with `{{content}}`, the same
`{{name}}` syntax as every other placeholder on the platform. `[content]` is no longer
recognized: a prompt that still contains it inserts `[content]` literally.

- The upgrade rewrites `[content]` to `{{content}}` in every prompt in `contents/prompts/` (and
  in a legacy `config/prompts.json`), so prompts on the server need no change.
- Any other `{{name}}` in a prompt text is now asked for when the prompt is used.

**Before upgrading:** prompt files kept outside the installation — backups, files you upload
under **Admin → Prompts**, provisioning scripts — must use `{{content}}` instead of `[content]`.

## Transcription: Audio Becomes the User's Message

In apps with transcription enabled, transcribed audio is now the user's input, and the selected
chat model answers it. Before, a recording or an uploaded audio or video file became an assistant
message holding the transcript, and no chat model was asked.

- **Recording:** while the user speaks, their message grows with the transcript. Stopping sends
  it to the chat model. Text already typed in the input field leads the message, and attachments
  go along.
- **Audio and video uploads:** the typed text is followed by `Transcript of <file>:` and the
  transcript, which streams into the message and is sent when complete, with any other
  attachments. Answers to it are labelled "Based on audio recording".
- Nothing is sent when the audio holds no speech, or the transcription fails or is cancelled. The
  input field gets its text and files back.

**Before upgrading:** an app that should return the transcript itself, rather than answer it,
needs a system prompt that says so, for example "Return the transcript, cleaned up, without
comment." Every transcription is now followed by a chat model call.
