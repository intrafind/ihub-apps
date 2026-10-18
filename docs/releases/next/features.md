# Features — Unreleased

## Voice Mode (Preview)

Users can now talk to an app and hear it answer. A waveform button next to Send opens a spoken
conversation in the same chat: speak, pause, and the app answers out loud, and speaking while it
answers interrupts it. Captions show both sides, the answer's text marks how far it has been spoken, and the conversation stays in the chat history.
Audio is never stored; it goes only to the speech service the app already uses for voice input
(a transcription model, Azure Speech or the browser).

- Admins switch it on in two steps: enable the **Voice Mode** preview feature under **Admin →
  Features**, then turn it on under **Admin → Voice Input → Voice mode**. The same section sets
  the text-to-speech model, hands-free or push-to-talk listening, how long a pause ends a turn,
  interrupting, the reasoning effort for spoken answers, the longest session and an optional
  voice style instruction per language. **Try it** starts a session with the settings in the form
  before they are saved (with a transcription model the voice mode switch must be saved once).
- Each app decides for itself: the app editor's **Input Mode & Microphone** section has a
  **Voice mode** control (platform default, on or off) with optional listening style, text-to-speech
  model and voice. By default voice mode is opt-in per app.
- Answers are spoken sentence by sentence, so speech starts while the answer is still being
  written. Voice mode speaks with a text-to-speech model: the one chosen for voice mode, else the
  read-aloud default. Read aloud itself does not have to be switched on.

## Usage Guide Opens in a Dialog

An app's usage guide is now one "Usage guide" control that opens the guide in a dialog, in every
state of the chat. It no longer appears as a question and answer in the chat, so the starter
prompts and the chat input stay as they are and the guide is available while an answer is being
written.

- The control sits bottom left under the chat input — on the start screen, in a running chat and
  in compare mode — and bottom left in the action row of an app's start form. Apps with starter
  prompts also show a "New here? Usage guide" link under the starter prompts' subtitle.
- The centered button below the starter prompts is gone, so the guide no longer looks like one
  more prompt.
- In the app editor's **Usage Guide** section, the former "Button text / question" field is now
  the **Dialog heading**. The control itself is always labelled "Usage guide".
