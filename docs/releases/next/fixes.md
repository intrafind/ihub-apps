# Fixes — Unreleased

## Local and Self-Hosted Models Work Without an API Key

Chat with a model on a local server (provider **Local**: vLLM, LM Studio, Jan.ai, Ollama) failed
with `API_KEY_ERROR` unless some key was set — even though the setup guide says no key is needed.
The only way out was to type a dummy value, such as spaces, into the model's API key field.

- A **Local** model without a key now runs; the request goes out without an `Authorization` header
  instead of a meaningless `Bearer` value.
- The same applies to an OpenAI-compatible server reached through the **OpenAI** API type at your
  own URL (not `api.openai.com`) that is not linked to a custom provider. A key that is
  configured is still sent.
- OpenAI's own endpoint, and models linked to a custom provider, still need a key.
- OCR with a keyless local model no longer stops with "No API key configured".
- The start-up check for missing keys and the chat request now agree on which models need one.

Models that carry a blank key (spaces) keep working as before.
