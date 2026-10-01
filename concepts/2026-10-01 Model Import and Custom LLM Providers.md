# Model Import and Custom LLM Providers

## Problem

Gateways such as T-Systems AI Foundation Services (LLM Hub), vLLM servers and the OpenAI or
Mistral APIs list their models at `GET <base>/models`. Adding them to iHub meant typing every model
config by hand and pasting the same API key into each one. The only provider-level keys were the
built-in entries (`openai`, `anthropic`, …), so a second OpenAI-compatible gateway had no place
for its own key.

## Decisions

### A model's `provider` stays its API type

`model.provider` selects the adapter and is read in about 170 places at runtime. Making it point
at a provider entry instead would have changed all of them. A new optional field, `providerId`,
names the provider entry that holds the key. Without it, the entry named after the API type is
used, so existing models are unchanged.

- A custom LLM provider declares the API its endpoint speaks in `apiType`. Saving a linked model
  sets its `provider` to that `apiType`, and changing a provider's `apiType` rewrites its linked
  models. The two cannot drift apart.
- A link to a built-in entry is dropped on save; the model reaches it through its API type
  anyway. A link to a custom entry is always kept.
- API-type names (`openai`, `openai-responses`, …) cannot be the ID of a new provider entry. An
  unlinked model falls back to the entry named after its API type, so such an entry would collect
  those models silently.
- A provider that still has linked models cannot be deleted (409).

### Keys never fall back across providers

A linked model takes its key from the model itself, the provider entry, `<MODEL_ID>_API_KEY`, or
the provider's own variable (`LLMHUB_API_KEY` for ID `llmhub`), in that order. It never falls
back to the variable of its API type: an LLM Hub model that speaks the OpenAI API must not be sent
`OPENAI_API_KEY`.

### Discovery stores nothing

`POST /api/admin/models/_discover` only reads and normalizes the listing. The import itself uses
the regular `POST /api/admin/providers` and `POST /api/admin/models`, so validation, key
encryption and audit logging are the existing ones. With `providerId`, discovery uses the stored
key on the server, so it never travels back to the browser.

- The URL may be the API base, the `/models` listing or an inference URL; a bare host means
  `/v1` (`/v1beta` for Google).
- Listings of OpenAI-compatible servers, Mistral, LLM Hub (`meta_data`), Anthropic and Google are
  normalized into one entry shape. Only what the endpoint reports is used: context window, output
  limit (dropped when it is not below the window, which vLLM would reject), image input, tool
  support, end of life, and the model type, so that embedding, audio, image and moderation models
  can be marked.
- The call goes through `httpFetch`, so proxy and SSL settings apply. Private hosts are allowed
  on purpose (self-hosted vLLM); the route is admin-only. Redirects are not followed, so a key
  only reaches the host the admin entered. The body is capped at 10 MB while it streams.
- A failure on the endpoint's side answers 502 with a `messageKey`, never 401, which would end the
  admin session.

### Provider names are plain text

Provider name and description were per-language objects. Provider names are product names and do
not get translated, so the Providers pages edit them as one string, and migration V141 converts
existing entries, keeping the text in the platform's default language.

## Code locations

| Area | File |
| ---- | ---- |
| Shared provider rules (API types, built-ins, links, env names) | `shared/llmProviders.js` |
| Provider key decryption and resolution | `server/services/llmProviders.js` |
| Model key lookup | `server/utils.js` (`getApiKeyForModel`) |
| Discovery and normalization | `server/services/ModelEndpointDiscovery.js` |
| Discovery route, link sync on model save | `server/routes/admin/models.js` |
| Provider CRUD, API type sync, delete guard | `server/routes/admin/providers.js` |
| Migration | `server/migrations/V141__provider_plain_names.js` |
| Import dialog and helpers | `client/src/features/admin/components/ModelImportDialog.jsx`, `client/src/features/admin/utils/modelImport.js` |
| Provider pages | `client/src/features/admin/pages/AdminProvider*.jsx`, `client/src/features/admin/components/ProviderFormFields.jsx` |
| Admin documentation | `docs/models.md` (Custom LLM Providers, Importing Models from an Endpoint) |
