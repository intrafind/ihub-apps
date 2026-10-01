# Features — Unreleased

## Prompts: For Any App, or for One

The prompt editor now asks, right below the description, whether a prompt is for **Any app** or
for **A specific app**. A prompt for any app opens in your default app from the Prompts page; a
prompt for one app opens in that app and comes first in its `/` search.

- **Save as prompt** on a chat message starts with the chat's app selected; switch to **Any app**
  to use the message everywhere.

## Chat: Cited Sources Listed at the End of the Answer

An answer that cites web pages, documents or records lists them again at its end, numbered like
its citation badges, above the **Sources** entry. Sources that were only considered stay in the
Sources panel.

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
