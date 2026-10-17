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


## Voice Mode (Preview)

Users can now talk to an app and hear it answer. A waveform button next to Send opens a spoken
conversation in the same chat: speak, pause, and the app answers out loud, and speaking while it
answers interrupts it. Captions show both sides, and the conversation stays in the chat history.
Audio is never stored; it goes only to the speech service the app already uses for voice input
(a transcription model, Azure Speech or the browser).

- Admins switch it on in two steps: enable the **Voice Mode** preview feature under **Admin →
  Features**, then turn it on under **Admin → Voice Input → Voice mode**. The same section sets
  the text-to-speech model, hands-free or push-to-talk listening, how long a pause ends a turn,
  interrupting, the reasoning effort for spoken answers, the longest session and an optional
  voice style instruction per language. **Try it** starts a session with the unsaved settings.
- Each app decides for itself: the app editor's **Input Mode & Microphone** section has a
  **Voice mode** control (platform default, on or off) with optional listening style, text-to-speech
  model and voice. By default voice mode is opt-in per app.
- Answers are spoken sentence by sentence, so speech starts while the answer is still being
  written. Voice mode needs read aloud to be set up, because it speaks with a text-to-speech model.
