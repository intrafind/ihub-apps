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
