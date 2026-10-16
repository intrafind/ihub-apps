# Breaking Changes — Unreleased

## Transcription Models Are Chosen in the Model Selector

Audio now always goes to the model selected in the chat. Transcription models — live (Gemini 3.5
Transcribe Live, Voxtral realtime, Mistral) and whole-file (Gemini 3.5 Transcribe, Whisper) — are
listed in the chat's model selector next to the chat models, marked "Transcription · live" or
"Transcription · whole file". The per-app transcription switch and its hidden routing of audio to a
separate model are gone.

- With a transcription model selected, the text box is disabled: users upload an audio or video
  file or press record. Each file is a turn of its own, the transcript is the answer, and it is
  stored in the chat, so a chat model selected next can summarize or answer questions about it.
- The microphone is dictation into the input field, through the configured dictation service,
  whatever model is selected. The dictation model pickers in Admin → Voice Input and in the app
  editor now offer only live transcription models.
- Record with a chat model that takes audio (such as Gemini Flash) attaches the recording and sends
  it with what is typed. Chat models without audio support offer neither record nor audio upload.
- The app setting `transcription` and the platform setting `speech.transcription.defaultModelId`
  are removed. The upgrade removes them, and an app that restricts its models gets the
  transcription model it used added to its allowed models.

**Before upgrading:** Users need permission for the transcription models they should use (group
permissions, like chat models). An app that should open on a transcription model can set it as its
preferred model.
