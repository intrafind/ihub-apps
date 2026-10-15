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
