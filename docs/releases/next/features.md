# Features — Unreleased

## Stopped Chats and Scheduled Runs Say Who Stopped Them

A chat answer or scheduled run that ends early now says why, who stopped it and when, instead of
only "The run was stopped".

- Scheduled runs show, for example, "Stopped from the chat (you)", "Cancelled by the owner",
  "Disabled by an administrator", "The run lost its execution lease to another worker" or
  "Replaced by a newer message in the same chat"
- A stopped answer reopened from the chat history reads "Generation cancelled: …" with the same
  reason
- People see "you" for their own stops; administrators also see which user it was
- The run ledger records the cause on `run/end`, and the server log has one line per stop with
  the user, the control (Stop button, compare view, Office add-in) and the worker that decided

## Chat Export: Faster First Page Load

The libraries that create Word, PowerPoint and Excel exports are no longer downloaded when the
app first opens. They load only when someone exports a chat to one of those formats.

- About 870 KB less JavaScript is fetched on the first page load, which helps most on slow or
  proxied networks.
- Exporting to DOCX, PPTX or XLSX downloads the needed library once, the first time it is used,
  so that first export can take a moment longer. The exported files are unchanged.

## Progress and Stop While Attachments Are Processed

Extracting the audio of a video can take minutes. Nothing showed that it was working, and the page
froze for moments on the way. Now a panel above the message box shows what is going on and lets
users stop it.

- The panel names the file and the step ("Extracting audio…", "Converting audio…", …) and shows a
  progress bar. Decoding the video's audio has no measurable progress, so the bar is animated
  during that step and fills in afterwards
- **Stop** cancels the processing: nothing is attached for that file, no error is shown, and files
  attached before stay. When several files are added at once, the ones already done stay as well
- The panel appears for any attachment that takes more than a moment, such as audio, video or
  large documents; instant ones never flash it
- Messages cannot be sent while an attachment is still being processed. Before, the message went
  without the file, which then joined the next message
- The extraction is lighter on the page: for a 40-minute video the longest freeze drops from about
  0.6 s to about 0.3 s, the decoded audio takes 290 MB of memory instead of 810 MB, and the
  extraction is about 30% quicker

## Save the Audio Extracted from a Video

When a video is attached to a chat, its audio is extracted and shown as a `.wav` attachment. That
file now has a **Save audio** button in the attachment list, so the audio can be kept locally.

- The audio is saved as `<video name>.wav`: `lecture.mp4` becomes `lecture.wav`
- It is the same 16 kHz mono WAV that is transcribed or sent to the model
- Audio files that users upload themselves have no such button, they already have the file
- In an app with transcription the audio is replaced by its transcript once the message is sent,
  so save it before sending

## Upload Videos up to 50 GB and Transcribe an Hour by Default

Half an hour of video is often 10 GB and more. A browser cannot read more than about 2 GB of a
file into memory, so the video limit of 2000 MB could never be reached: larger videos failed
however it was set. An MP4 or MOV is now read for its audio only. The index and the audio track
are read from the file and the picture is skipped, so the size of the video no longer matters.

- The video limit (`upload.videoUpload.maxFileSizeMB`) can now be set up to 51200 MB (50 GB) in the
  app editor and in the app configuration. The default stays 50 MB
- MP4 and MOV videos with AAC audio (including HE-AAC) or uncompressed PCM audio work at any size
  up to the limit. Small ones are extracted faster too, and the memory used follows the audio (30
  minutes of AAC take about 30 MB), not the video
- Other containers (WebM, MKV, AVI, …), MP4 and MOV videos with other audio (Opus, AC-3, ALAC, …)
  and fragmented MP4 files work up to 2 GB as before. Above that, users get a message that says
  which formats work: videos larger than 2 GB are supported as MP4 or MOV with AAC or PCM audio
- A video that is sent to the model as it is (audio extraction off) is limited to 2 GB as well
- Apps with transcription now take 60 minutes of audio by default, so a video of half an hour
  transcribes out of the box. `transcription.maxDurationSeconds` was 900 seconds; the maximum stays
  7200. Apps that already set the value keep it, apps that never did get the new default
- For transcription models that return the transcript in one piece, such as
  `gemini-3.5-transcribe`, the server now buffers up to 128 MiB of audio per connection (about 70
  minutes, before 32 MiB) and 512 MiB in all (before 256 MiB). Installations that set
  `speech.realtime.maxBufferedAudioBytes` or `maxBufferedAudioBytesTotal` keep their values
- A live recording of the full hour no longer runs into the server's session limit. The session
  cap (`speech.realtime.maxSessionSeconds`) was 3600 seconds from the connection, as long as the
  longest recording, so it could end a session before the automatic stop or while the transcript
  was still being made, and the recording was lost. The default is now 4200 seconds (the hour plus
  10 minutes). Installations that set `maxSessionSeconds` keep their value and have to keep it
  larger than the longest `transcription.maxDurationSeconds` of their apps plus a margin
- An MP4 or MOV is checked before its audio is read. An index that points outside of the file or
  asks for more audio than the file holds is refused at once, where it could freeze the tab. The
  video's edit list is followed: a recording that was trimmed (for example in QuickTime) is
  transcribed as trimmed, not with the audio around the cut, and the encoder's delay at the start
  of AAC audio is dropped. Fragmented MP4 files are no longer read from their index alone, which
  cut the audio off, and uncompressed audio that is unsigned and wider than 8 bits is no longer
  read as signed. Such files are decoded from the whole file as before (up to 2 GB) and fail with
  the message for videos larger than 2 GB above that
