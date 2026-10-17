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

## Babelfish App for Two-Person Conversations

The new **Babelfish** app interprets a conversation between two people who share one device. Both
pick their language, then take turns typing or speaking into the same input — each reply is what
the speaker said, in the other person's language.

- The app detects which of the two languages a message is in and translates into the other one;
  questions and instructions are translated, never answered.
- Earlier turns are used as context, so names, terms and the form of address stay consistent.
- The microphone stops after each utterance. For two spoken languages, use a transcription model
  as the voice input service — the browser's speech recognition only listens in the UI language.
- The app is enabled after the upgrade; disable it under **Admin → Apps** if it is not wanted.
