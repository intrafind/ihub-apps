# Features — Unreleased

## Prompts: For Any App, or for One

The prompt editor now asks, right below the description, whether a prompt is for **Any app** or
for **A specific app**. A prompt for any app opens in your default app from the Prompts page; a
prompt for one app opens in that app and comes first in its `/` search.

- **Save as prompt** on a chat message starts with the chat's app selected; switch to **Any app**
  to use the message everywhere.

## Chat: Sources Entry Above the Answer, Cited Sources at Its End

The **Searched for …** / **N sources** entry that opens the Sources panel now sits above the
answer, so it is in view while the answer streams. An answer that cites web pages, documents or
records also lists them again at its end, numbered like its citation badges. Sources that were
only considered stay in the Sources panel.

- A source's title opens it; its number opens the Sources panel at that source, with its passages
  and actions.
- Hovering a source highlights where the answer cites it. Long lists show five sources and fold
  the rest.

## Translator: Only the Text to Translate Is in the Message

The Translator's task and target language are now part of its system prompt. The message sent to
the model contains only what the user sent — the text, email or document to translate — instead
of a long instruction followed by the text.

- Existing installations are updated automatically as long as the Translator's system prompt and
  prompt template are still the shipped ones. A Translator an admin has customized is left as it
  is.

## Voxtral Transcription Hosted by Mistral

A new transcription model, **Voxtral Mini Transcribe Realtime (Mistral)**
(`voxtral-mini-transcribe-realtime-2602`), ships next to the self-hosted Voxtral model on vLLM.
It streams the transcript while the audio is still arriving, without a GPU of your own.

- It uses the Mistral API key the Mistral chat models already use (`MISTRAL_API_KEY`, the
  `mistral` provider entry, or a key on the model).
- It ships disabled, because enabling it sends user audio to Mistral. Enable it under
  **Admin → Models**, then choose it under **Admin → Voice Input** or in an app's transcription
  settings.

## Model Import: Create a Provider Without Importing Models

When **Import from URL** creates a new provider, the provider can now be created without picking
a model: with nothing selected, the button reads **Create provider without models**. The provider
keeps the endpoint's base URL and API key, so its models can be imported later — also when the
endpoint does not list any models yet.

## Read Aloud with Google Gemini TTS

Read aloud can now speak with Google's Gemini text-to-speech models: **Gemini 3.8 Flash TTS** and
the faster, cheaper **Gemini 3.8 Flash-Lite TTS**. Their 30 voices speak every language, which
Gemini detects from the text.

- Both models ship disabled, because enabling one sends the message text to Google. Enable one
  under **Admin → Models**, then choose it under **Admin → Voice Input → Read aloud**.
- They use the Google API key the Gemini chat models already use.


## Voice Input with Any Transcription Model

The microphone button in a chat can now use any transcription model: self-hosted Voxtral on
vLLM, Voxtral on Mistral, Gemini Transcribe Live or Gemini Transcribe, next to the browser and
Azure Speech. **Admin → Voice Input** now has one choice each for voice input, transcription and
read aloud.

- Pick the model as the platform default under **Admin → Voice Input → Voice input**, or per app
  under **Speech Recognition Service** in the app editor. Both list every enabled transcription
  model.
- Streaming models show the text while the user speaks. Gemini Transcribe inserts it when the
  user stops.
- An endpoint and its key are set once, on the model in **Admin → Models**. The same model can
  take voice input, recordings and uploads.
- Users need access to the model through their groups. If the default model is disabled, apps
  that follow the default use the browser until it is back.
- The **Test** action in **Admin → Models** now checks transcription models too, also disabled
  ones. It starts a session with the endpoint, or sends one second of silence to Gemini
  Transcribe.

## Whisper Transcription on T-Systems LLM Hub and Other OpenAI-Compatible Servers

Whisper can now transcribe in iHub: `whisper-large-v3` and `whisper-large-v3-turbo` on T-Systems
LLM Hub, OpenAI's `whisper-1` and `gpt-4o-transcribe`, or Whisper on your own vLLM server. Like
every transcription model, it can take voice input, recordings and audio/video uploads.

- **Admin → Models → Import from URL** lists such models as **Transcription** and imports them as
  transcription models, using the provider's stored key.
- A model set up by hand uses the provider **OpenAI** or **Local** with the model type
  **Transcription** and the endpoint's `/audio/transcriptions` URL.
- The transcript arrives in one piece when the user stops. Recordings longer than ten minutes are
  sent in parts, each cut at a pause, to stay within the usual upload limit.
- Before enabling the model for users, check it with **Test** in **Admin → Models**.

## Local Sign-In: Lockout After Failed Attempts, and a Warning for Demo Passwords

Local sign-in now locks an account for a while after repeated failed attempts, and the admin area
warns while the login page still offers the demo accounts with the passwords they ship with.

- After 5 failed sign-ins within 15 minutes, the account is locked for 15 minutes. While it is
  locked, sign-in is refused with "Too many failed sign-in attempts. Try again in … minutes."
  without checking the password. A successful sign-in, or a new password set under
  **Admin → Users**, clears the count.
- The limits are under **Admin → Authentication → Local Authentication Settings** (`localAuth.lockout` in
  `platform.json`), where the lockout can also be turned off. The upgrade adds the default
  settings.
- While **Show Demo Accounts in Login Form** is on and the `admin` or `user` demo account still has
  its shipped password, every admin page shows a warning with links to turn the option off or to
  change the passwords.

## EU AI Act: AI Disclosure, Content Marking and Detection

iHub now implements the transparency duties of Article 50 of the EU AI Act. People see that they
are talking to an AI before their first message, generated images and exports carry signed,
machine-readable marks, and every installation can detect its own marks. A new page,
**Admin → EU AI Act**, shows whether the installation conforms and where to fix it. The feature
flag **EU AI Act Transparency** is on by default. See [EU AI Act Transparency](../../eu-ai-act.md).

- **Disclosure:** a notice in the empty chat, an "AI" badge at the input, an "AI generated" chip
  on every answer with model, time and marking status, reminders in apps marked as sensitive, and
  a system-prompt rule that the model always says it is an AI when asked. Jira comments written
  by the Jira tool, Outlook inserts, workflow HTTP requests and shared chats carry an AI label.
  Only admins can switch the disclosure off for an app, with a reason that is kept in the app and
  the audit log.
- **Images:** every generated image gets a signed C2PA manifest, an invisible TrustMark watermark
  and XMP metadata before it is shown, stored or downloaded. Google SynthID is kept.
- **Exports:** all exports are now made on the server — PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown,
  HTML, JSON, JSONL. Users choose the messages to export; files carry a visible AI label, an
  optional "AI" icon and signed provenance metadata. The browser print dialog is gone.
- **Signing certificate:** each installation creates its own CA and signing certificate on first
  start. Admins can install their own certificate (PEM or PKCS#12), generate a CSR, rotate and
  switch back; old certificates keep verifying.
- **Models:** each model declares how it marks its output. Models that do not mark text are
  flagged "Not marked" and stay non-conforming; switching one on asks for a justification.
  Self-hosted vLLM models can be watermarked with iHub-managed keys that several installations
  can share through an encrypted key bundle.
- **Detection:** `/verify` (and `POST /api/provenance/verify`) checks files and text, names the
  technique that found the mark and offers a signed report. Nothing submitted is stored. The iHub
  binary verifies files offline with `ihub verify <file>`. `/.well-known/ai-provenance` tells
  verifiers which detector to use.
- **Provenance:** a record per answer (hash, model, time — never the content), also without chat
  persistence; API and MCP responses carry `ihub_provenance` / `_meta.provenance`.
- **Oversight:** admins see a start-page banner when something does not conform; model and
  certificate warnings can be dismissed with a justification without changing the status. The
  page exports a signed compliance report and runs a marking robustness self-test.
