# Fixes — Unreleased

## Opening a Running Scheduled Run No Longer Risks Cancelling It

A scheduled run could end as "cancelled" after someone opened its chat while it was still
running and waited for it. The browser sent a stop request on its own — when it re-attached to the
run, replaced its connection, timed out or sent a follow-up — and that request ends a stored run.

- The browser no longer stops a chat turn by itself: only the Stop button (and "Clear chat", and
  the compare view's stop) does
- Leaving or reloading a chat leaves a stored run going; a chat that is not stored still ends
  when its connection closes

## Markdown Chat Export Converts HTML Replies Properly

Exporting a chat as Markdown left replies that arrive as HTML (for example from an app with an HTML
output format) half-converted: links, bullet and numbered lists and headings stayed as raw HTML
tags in the `.md` file, because only bold, italic, inline code and paragraph breaks were
converted. They now come out as regular Markdown links, lists and headings. Replies that are
already Markdown or plain text are exported unchanged, and so are HTML replies that contain a table,
an SVG drawing or MathML, because Markdown cannot hold those.

- No admin action is required — the fix takes effect automatically on upgrade.

## HTML Chat Export Shows App Name and Chat Settings as Text

Exporting a chat as HTML wrote the app name and the chat settings (model, style, output format and
the values typed into the chat's start form) into the file as markup instead of text. A value such
as `<b>x</b>` therefore showed up formatted, and a crafted value could run script when the
exported file was opened. These values are now escaped, so they appear exactly as entered, and
names containing `&` display correctly.

- No admin action is required — the fix takes effect automatically on upgrade.

## Audio Attachments Reach vLLM Models That Support Audio

Audio attached to a chat with a vLLM model that has **Supports Audio** enabled was silently
dropped: the model only saw the text of the message. vLLM models now receive the audio the same
way OpenAI models do. Models without the flag are unaffected.

## Long Videos Can Be Transcribed

Transcribing an uploaded video failed for long recordings: the audio was extracted and shown as a
`.wav` attachment, but sending it ended with "Could not decode this audio in your browser".

- The audio extracted from a video is now a 16 kHz mono WAV, the format transcription streams
  anyway. It is about six times smaller than before (1.9 MB instead of 11.5 MB per minute). For
  videos longer than about 35 minutes the old attachment was more than the browser can hold and
  arrived empty
- A video whose audio is still too long to attach is refused when it is uploaded, not when it is
  sent
- A failed transcription now says why: the message of the transcription service ("Transcription
  failed: …") instead of "Transcription failed. Please try again.". A model the user may not use
  and a session that reached its maximum duration have their own messages
- The extracted audio is 16 kHz mono also when it goes to a chat model that accepts audio instead
  of being transcribed. That is plenty for speech, but music loses its high frequencies

## M4A Audio Files Can Be Uploaded

Audio exported from QuickTime ("Export As → Audio Only") is an `.m4a` file. Uploading it was
refused with "Unsupported file format. Please use: …, MP4", although MP4 audio is supported:
Chrome and Safari on macOS report such files as `audio/x-m4a` instead of `audio/mp4`, and the
upload only recognised the exact type.

- `.m4a` files are accepted wherever `audio/mp4` is allowed and reach the model as `audio/mp4`.
  The same goes for `.wav` and `.flac` files that browsers label `audio/x-wav` or `audio/x-flac`.
- Cloud storage pickers list `.m4a` files as well.
- The hint with the supported formats names M4A, and the audio formats the app editor preselects
  include `audio/mp4` like the server default does.

## PDF Uploads Work in Browsers Without the Newest JavaScript Features

Some PDF uploads failed in browsers that do not yet support the JavaScript method
`Map.prototype.getOrInsertComputed`, with the error "getOrInsertComputed is not a function".
Encrypted PDFs could not be read at all, and scanned PDFs and the source preview could not draw
their pages. The browser now loads the compatibility build of the PDF engine (pdf.js), which
works in these browsers as well.

- Nothing to configure: the PDF engine is still served by iHub itself, so installations without
  internet access are unaffected
- The PDF engine loads on demand, as before; its download grows by about 36 KB compressed

## Backup & Restore: Importing a Configuration Works in Docker and Kubernetes

Importing a configuration ZIP under **Platform → Backup & Restore** failed with "Internal server
error" in every Docker and Kubernetes installation. The import tried to move the whole `contents`
folder aside, which is not possible when that folder is a mounted volume. The import now replaces
the configuration inside the folder, so it works with the standard volume setup.

- The configuration an import replaces is kept in `contents/.backups/<date and time>/` on the same
  volume (previously a `contents-backup-…` folder next to `contents`). The three newest are kept.
- If any step fails, the previous configuration is restored completely, as before.
- A failed import says why — missing write permission, not enough disk space, or a folder inside
  `contents` mounted separately — instead of "Internal server error".
- `.backups` is never included in an export and never restored from an archive.
- Only one import runs at a time; a second one started meanwhile is refused and can be retried.
