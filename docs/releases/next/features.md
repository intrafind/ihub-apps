# Features — Unreleased

## Outlook Add-in: the model sees who wrote the email and what you told it to do

The task pane now sends the open email as one structured block — sender, recipients, date,
subject, the signed-in mailbox user and the body — followed by the note you typed in a separate
`<user_instruction>` block. Until now the note was glued in front of the raw email text with no
label, so models regularly read it as one more quoted paragraph and answered the thread instead of
following the note — for example committing you to a task you had just assigned to a colleague.

- Sender, To, Cc, date and subject are read from Outlook and included even when the body is
  excluded; the greeting no longer has to be guessed from the quoted thread.
- Your note always comes last, right where the app's prompt continues.
- Collected emails and calendar items use the same tagged shape; the browser extension sends the
  page as `<current_page>` with its title and URL.
- A fixed `<context_rules>` note marks the blocks as quoted material, and the add-in's own tag
  names inside email text are escaped, so an email cannot close a block early or smuggle in a fake
  `<user_instruction>`.

## New app: Outlook – Reply Directly

A reply-drafting app built for the Outlook task pane ships as a default app (`outlook-reply`). It
produces only the insertable reply body, answers in the language of the email, signs with the
user's profile name and treats the note typed into the chat as the content of the reply — a request
in the email is never confirmed unless the user says so.

- Starter prompts: Generate a reply, Say thanks briefly, Politely decline
- Works with a typed note alone, a starter prompt alone, or both together
- Knows today's date and the signed-in user, so it can tell whether a deadline in the email has
  passed and which messages in the thread are the user's own
- Recommended as the default chat app of the task pane's start page
