# Connect a model provider (W1)

Status: implemented on branch `worktree-agent-a20ed7efabf6d457c` (not merged). Source: admin review
report, W1 (section 8), recommendation 6 (section 11), findings AI-UX2, AI-PM6, AI-PM7.

## Problem

Connecting an endpoint and making one model usable took about 15 steps (task 1 of the review):
create a provider, return to the list, find it, import, retype the URL on a model, guess the API
model ID, enable, then test from a row menu. Azure, Bedrock and OpenRouter were missing from the
first-run tiles, and a new model could silently become the default.

## What was built

A guided page at **`/admin/providers/connect`** (a sub-route of `/admin`, so `KNOWN_ROUTES` and
`client/index.html` need no change). `?vendor=<tile id>` starts at step 2 of that tile.

| Step | What the admin does | What runs |
|---|---|---|
| 1 Service | Picks a tile | nothing |
| 2 Connection | Name/ID (new provider), URL with an example, key; the env var that can hold the key is named | nothing is saved |
| 3 Test | Sees host, model count and API type, or a cause with a fix | `POST /api/admin/models/_discover` (stores nothing) |
| 4 Models | Picks models in the shared list (context, vision, tools, iHub ID, Azure deployment) | nothing |
| 5 Default | Picks the default explicitly, or keeps the current one | nothing |
| 6 Access | Everyone who signs in (`authenticated` group) or picked groups | nothing |
| Done | Smoke test, "Create an app", "Open the provider", "Go to models" | provider, models, groups are written here |

Tiles (only what the adapters support): OpenAI, Azure OpenAI, Anthropic, Google Gemini, Mistral,
AWS Bedrock (only while the shipped `bedrock` provider exists), OpenRouter, OpenAI-compatible
gateway, Self-hosted (vLLM / LM Studio / Ollama), iFinder Model Gateway.

Bedrock has no model listing iHub can read: its flow is Service → Connection (key) → Done, and Done
links to the Marketplace for Bedrock model configs.

## Where the code is

- `client/src/features/admin/utils/providerConnect.js`: all step rules, pure functions (tiles,
  step order, form updates, target resolution, discovery body, error classification, provider
  write, model configs, group plan, `runConnectPlan`). Start here.
- `client/src/features/admin/components/provider-connect/useProviderConnect.js`: state and API
  calls; loads providers, models and groups.
- `client/src/features/admin/components/provider-connect/*Step.jsx`: one component per step,
  render only.
- `client/src/features/admin/pages/AdminProviderConnectPage.jsx`: the page.
- `client/src/features/admin/components/ModelPickList.jsx`: the model table, extracted from
  `ModelImportDialog` so both use one list. It also shows a "Tools" badge now.

## Decisions

- **No new server endpoint.** The flow composes existing endpoints in the order the import dialog
  already uses: provider write, then each model, then group grants. If the provider write fails,
  nothing else is created. A failed model or group is reported on the Done step; every created
  piece is a valid configuration on its own. An atomic endpoint can be added later if partial
  outcomes turn out to matter.
- **Shipped vendor providers are reused** (`openai`, `anthropic`, `google`, `mistral`, `openrouter`,
  `bedrock`): the key is PUT on the existing entry (the server encrypts it). If a key is already
  stored and the provider is enabled, nothing is written. Other tiles create a new provider.
- **Models inherit the key** (AI-PM6): they carry `providerId` (custom provider) or the API type
  (shipped provider) and no `apiKey`. Their URL is built from the endpoint the test resolved.
  Real runtime inheritance of the URL from the provider's `baseUrl` would need adapter changes;
  that was not done.
- **Keyless self-hosted servers:** a self-hosted provider created without a key gets
  `requiresApiKey: false`, and `allowsMissingApiKey` in `shared/llmProviders.js` now honours it.
  Without that, an LM Studio/Ollama model (OpenAI API type, linked to a custom provider) failed
  with "missing key".
- **Error causes:** `classifyConnectionError` maps the `details.messageKey` from the shared
  discovery mapping to `unreachable`, `tls`, `auth`, `path` or `other`. TLS is also detected from
  the certificate text in `details.remediation`, so it works whichever key the shared mapping uses.
  TLS links to `/admin/security` (SSL section). The shared mapping itself
  (`server/services/ModelEndpointDiscovery.js`, `translateDiscoveryError`) was not changed.
- **Access step is minimal on purpose.** Groups holding `models: ["*"]` are named because they see
  the new models anyway. Access legibility is another work item.

## Entry points

- Models setup strip, step 1 button ("Connect a model provider")
- Models empty state, when there is no model at all
- Providers tab "Add provider" (step 1 links to the old form `/admin/providers/new`)
- Cmd+K entry "Connect a model provider"
- Overview setup checklist, provider step
- First-run `/setup`, "Add your models" (continues in the matching tile)

## Tests

- `tests/unit/client/provider-connect-utils.test.jsx`: the rules
- `tests/unit/client/admin-provider-connect-page.test.jsx`: the flow against a mocked API
- `server/tests/api-key-resolution.test.js`: `requiresApiKey: false`

## Open ends

- Unsaved-changes guard: leaving the page mid-flow loses what was typed (nothing is saved yet).
- The `/setup` tiles are still their own list; they could read the tile catalog of
  `providerConnect.js`.
- "Create an app with this model" opens `/admin/apps/new` without preselecting the model (the
  create page has no parameter for it). The new default is used anyway.
- Test buttons on the model editor and provider page (AI-ADMIN1) are not part of this.
