# Features — Unreleased

## Chat Header: One Share Button for the Conversation and the App

The chat header now has a single **Share** button in place of the two that sat side by side —
**Share**, which made a short link to the app, and **Share chat**, which made a read-only link to
the conversation. Users could not tell them apart, and the app link looked like it shared the
chat. The dialog now asks what to share and says what each link carries.

- **This conversation** creates the read-only link to the stored chat, as before. It is
  preselected once the chat has a message; before that the tab says to send one first.
- **Link to the app** opens the app for a new chat, optionally with the current model, style and
  input values, and states that the conversation is not part of it. One click creates the link
  with a generated code; a custom code and an expiry are under **More options**.
- Each option appears only where it is available: the conversation needs **Chat Sharing** and a
  durable chat, the app link needs **Short Links**. With just one of them, the dialog shows only
  that one. The canvas view offers the app link.
- Short links copied from the dialog now include the base path on installations served under a
  subpath (for example `/ihub/s/<code>`). Before, the copied link was missing it and did not open.
