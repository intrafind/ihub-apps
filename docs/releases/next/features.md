# Features — Unreleased

## Usage Guide for Apps

Apps can now carry a pre-written "How do I use this app?" guide. Users open it from a button in
the chat and get the answer instantly — no model is called, and the guide is not sent to the
model with later messages, so it costs nothing and leaves the context window free.

- The button appears in the middle of the start screen (also for apps without starter prompts)
  and, once a chat has started, as a "Usage guide" link next to the chat input.
- Admins write the guide in the app editor's new **Usage Guide** section, or generate it once
  with the default model and then edit it. It can be regenerated per language or deleted.
- The guide is stored in the app itself, so it is included when the app is exported, backed up
  or installed from the marketplace.

