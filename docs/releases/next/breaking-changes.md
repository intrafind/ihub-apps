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

## License: Branding Protection and Enterprise License

The iHub Apps license now protects the IntraFind and iHub branding. Rebranding iHub Apps — removing
or replacing the IntraFind and iHub names and logos, or offering the software or a product or
service built on it under another name — requires IntraFind's prior written permission or an
Enterprise License.

- Organizations running iHub Apps for their own employees may still change logos, colors, titles
  and header and footer texts in the UI settings, as long as "Powered by IntraFind –
  https://intrafind.com/" stays visible, at least in the footer or on an about page.
- White-labeling, reselling, embedding, or hosting iHub Apps for customers is covered by the new
  Enterprise License, which can also include support, SLAs and warranties.
- Contributions now fall under the Contributor License Agreement.

**Before upgrading:** If you provide iHub Apps to customers or the public under your own name or
branding, contact sales@intrafind.com for permission or an Enterprise License. Installations that
changed the footer should make sure the "Powered by IntraFind" attribution is visible.
