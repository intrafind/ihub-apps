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
