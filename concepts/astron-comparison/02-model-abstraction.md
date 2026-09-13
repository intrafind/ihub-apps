# Model Abstraction & MaaS — astron-agent vs ihub-apps

Research conducted 2026-05-13 against `iflytek/astron-agent` (main branch) and the local
`ihub-apps` working tree at `/home/user/ihub-apps`. References to astron-agent files cite
the `main` branch path; references to ihub-apps cite `path:line`.

## 1. astron-agent

### Architecture at a glance

Astron is a polyglot microservices platform. The model layer is split across two main
runtimes:

- **`console/backend`** (Java / Spring Boot 3, MyBatis-Plus, MySQL) — the *control plane*.
  Manages model metadata, validation, encrypted API keys, model marketplace ("shelf"),
  and the MaaS deployment lifecycle. Source: `console/backend/toolkit/src/main/java/com/iflytek/astron/console/toolkit/`.
- **`core/agent`** + **`core/workflow`** (Python / FastAPI, httpx) — the *data plane*.
  Hosts `BaseLLMModel` and provider-specific subclasses (`AnthropicLLMModel`,
  `GoogleLLMModel`) plus per-workflow-node LLM execution (`core/workflow/engine/nodes/llm/spark_llm_node.py`).
- **`console/backend/hub`** — a Java module dedicated to the iFLYTEK Spark chat path
  (`SparkChatService.java`, uses the proprietary `cn.xfyun.api.SparkChatClient`).

### Provider adapters

The Python data plane has three concrete adapters in `core/agent/domain/models/base.py`:

| Adapter | Endpoint family | HTTP client | Streaming |
| --- | --- | --- | --- |
| `BaseLLMModel` (the OpenAI client) | OpenAI Chat Completions | `openai` SDK | yes, `ChatCompletionChunk` |
| `AnthropicLLMModel` | `/v1/messages` | `httpx.AsyncClient` | SSE |
| `GoogleLLMModel` | `generateContent` (Gemini) | `httpx.AsyncClient` | SSE |

The Java control plane in `service/model/LLMService.java` declares mappings for a much
broader registry — OpenAI, Anthropic, Google, DeepSeek, Minimax, Zhipu, Qwen, Moonshot,
Doubao, ChatGPT — but those are *configuration entries*, not runtime adapters; they are
all served through the OpenAI-compatible base adapter at inference time.

For iFLYTEK Spark, Astron carries a separate Java-only path through
`console/backend/hub/service/SparkChatService.java` which uses the proprietary
`SparkChatClient`, SDK enum `SparkModel` (e.g. `SPARK_X1`, `SPARK_4_0_ULTRA`), and
signature-based HTTP authentication, returning a Spring `SseEmitter`.

### Model registry & metadata

Model metadata lives in MySQL tables, exposed through the Spring controller
`controller/model/ModelController.java`. Endpoints (all under `/api/model`):

- `POST /api/model` — create/update a model definition (validates via reflection of the
  remote provider before persisting).
- `GET /api/model/delete` — soft-delete a model (with workflow cleanup via `ShelfModelService`).
- `POST /api/model/list` — paginated browse.
- `GET /api/model/detail` — fetch one entity.
- `GET /api/model/rsa/public-key` — fetch the RSA public key used by the client to
  encrypt API keys before they are sent to the server.
- `GET /api/model/check-model-base` — ownership/permission check.
- `GET /api/model/category-tree` — category hierarchy used by the model marketplace UI.
- `GET /api/model/{option}` — toggle a model on/off.
- `GET /api/model/off-model` — remove from "shelf" and unwire from dependent workflows.
- `POST /api/model/local-model` — register a local model definition.
- `GET /api/model/local-model/list` — enumerate local model files.

Permissions are enforced via `@SpacePreAuth` annotations.

### MaaS lifecycle (deploy / start / stop / status)

The MaaS control plane is `handler/LocalModelHandler.java`:

- `deployModel(ModelDeployVo)` — POST a new deployment, returns `serviceId`.
- `deployModelUpdate(ModelDeployVo, serviceId)` — PUT changes to a running service.
- `checkDeployStatus(serviceId)` — GET status, returns `{status, endpoint, updateTime}`.
  States: `running | pending | failed | initializing | terminating`.
- `deleteModel(serviceId)` — DELETE the service.
- `getLocalModelList()` — list deployable files.

The deployment request shape (`entity/vo/model/ModelDeployVo.java`) is intentionally
minimal — Astron delegates to a separate, opaque "MaaS service" microservice via HTTP:

```java
@Data public class ModelDeployVo {
  private String modelName;
  private ResourceRequirements resourceRequirements; // { acceleratorCount }
  private Integer replicaCount;
  private Integer contextLength;
}
```

Astron itself does **not** ship the underlying k8s/Helm operator — the
`README` only mentions "one-click deployment" and the `MAAS_*` env vars in
`docs/CONFIGURATION_zh.md` show that all MaaS API URLs default to an external
iFLYTEK Xingchen endpoint (`https://xingchen-api.xf-yun.com`) with credential triples
(`MAAS_APP_ID/API_KEY/API_SECRET`, `MAAS_CONSUMER_*`). Local self-hosted MaaS plugs in by
swapping the `ApiUrl` config. The status enum and minimal VO suggest the platform
expects a Kubernetes-backed inference operator (replicas + GPU count + context window).

### API key management

API keys are encrypted client-side with RSA — the public key is fetched via
`GET /api/model/rsa/public-key`, encrypted, sent to the server, persisted in the model
row, and decrypted at request time by `ModelService.decryptApiKey()`. SSRF protection is
applied via `SsrfParamGuard` with IP blacklisting before any outbound call.

### Streaming

All adapters stream:
- OpenAI: native `openai` SDK chunk iterator.
- Anthropic / Google: manual SSE parsing inside `BaseLLMModel` subclasses.
- Spark (Java path): `SseEmitter` driven by `cn.xfyun.api.SparkChatClient`.
- The workflow engine surfaces the stream as `AgentResponse` chunks; the runner
  (`core/agent/engine/nodes/chat/chat_runner.py`) calls `self.model_general_stream()`
  which yields normalized `delta` + `usage` chunks.

### Multimodal, tool calling, prompt caching, fine-tune

- **Multimodal**: Spark LLM node has explicit `input_to_filetype_map` for image / audio /
  video and a "xaipersonality" domain. Other adapters inherit OpenAI-style content arrays.
- **Tool calling**: surfaced via MCP (Model Context Protocol) — MCP servers are stored
  in the `tool_base` MySQL table. Tool integration is *plugin-based* (`service/plugin/mcp.py`,
  `skill.py`, `knowledge.py`, `link.py`, `workflow.py`), not per-adapter normalization.
- **Prompt caching**: not surfaced in any model-layer code observed.
- **Fine-tune hooks**: `LLMService.switchFinetuneModel()` exists, plus an
  `entity/finetune` package — the platform tracks finetuned model state in Redis,
  but the actual fine-tuning job is delegated to the external Xingchen platform.

### Per-model rate limits / billing

No per-model concurrency or rate-limit field surfaced in any adapter — billing and rate
limits are delegated to the upstream provider (iFLYTEK enforces them at the Xingchen
gateway via the `MAAS_CONSUMER_*` credentials).

### Sources

- README + `docs/CONFIGURATION.md` + `docs/PROJECT_MODULES.md` on <https://github.com/iflytek/astron-agent>
- `console/backend/hub/.../service/SparkChatService.java`,
  `console/backend/toolkit/.../service/model/` (`LLMService`, `ModelService`, `ShelfModelService`,
  `ModelCommonService`), `.../handler/LocalModelHandler.java`,
  `.../controller/model/ModelController.java`, `.../entity/vo/model/ModelDeployVo.java`
- `core/agent/domain/models/base.py`, `core/agent/engine/nodes/chat/chat_runner.py`,
  `core/workflow/engine/nodes/llm/spark_llm_node.py`
- <https://deepwiki.com/iflytek/astron-agent/1-astron-agent-platform-overview>

## 2. ihub-apps

### Adapter registry

The runtime is single-process Node.js (Express). All adapters live in
`/home/user/ihub-apps/server/adapters/` and are registered as a flat object in
`adapters/index.js:12-21`:

| Key | Module | Notes |
| --- | --- | --- |
| `openai` | `openai.js` | Chat Completions, images + audio multipart |
| `openai-responses` | `openai-responses.js` | GPT-5 Responses API, reasoning + verbosity |
| `anthropic` | `anthropic.js` | `/v1/messages`, tool_use, image tool results |
| `google` | `google.js` | `streamGenerateContent` + thinking + image generation |
| `mistral` | `mistral.js` | La Plateforme, JSON schema strict mode |
| `local` | `vllm.js` | vLLM, schema sanitization, autoDiscovery |
| `bedrock` | `bedrock.js` | Converse + EventStream + cross-region profiles |
| `iassistant-conversation` | `iassistant-conversation.js` | iFinder Conversation API, JWT, citations |

All adapters extend `BaseAdapter` (`server/adapters/BaseAdapter.js:9`) which provides
shared SSE parsing (`parseSseStream`), line-delimited SSE parsing
(`parseLineDelimitedSseStream`), debug logging, base64 cleaning, and tool-response
normalization.

### Generic tool-calling layer

A separate, non-trivial subsystem in `server/adapters/toolCalling/` (cited counts):

- `ToolCallingConverter.js:1` (330 lines) — cross-provider routing.
- `GenericToolCalling.js:1` (281 lines) — normalized tool/tool-call/streaming shapes.
- Provider converters: `OpenAIConverter.js` (502), `OpenAIResponsesConverter.js` (580),
  `AnthropicConverter.js` (416), `GoogleConverter.js` (524), `MistralConverter.js` (302),
  `BedrockConverter.js` (224), `VLLMConverter.js` (504).
- Public surface in `toolCalling/index.js:24-39` exports `convertToolsToGeneric`,
  `convertToolsFromGeneric`, `convertResponseToGeneric`, etc.

This converter layer is **richer than astron-agent's** — astron normalizes only at the
agent-runner level (`AgentResponse`), whereas ihub-apps round-trips every provider's
streaming chunk into a single intermediate shape, enabling the OpenAI-compatible
inference proxy (`server/routes/openaiProxy.js:1`).

### Model registry & metadata

`contents/models/*.json` (one file per model). Defaults shipped in
`server/defaults/models/` (17 files, including Claude 4 Opus/Sonnet, Gemini 3.x, GPT-5,
Mistral Large/Medium/Small, GPT-OSS vLLM, iAssistant Conversation, Local vLLM).
Loading goes through `server/modelsLoader.js:45-51` (uses a generic
`createResourceLoader` factory) with `ensureOneDefaultModel` post-processing.

Schema is enforced by Zod in `server/validators/modelConfigSchema.js:41-127`. Fields
include `id`, `modelId`, localized `name`/`description`, `url`, `provider` (closed enum
of 8 values, `:62-78`), `tokenLimit`, `default`, `supportsTools`, `concurrency`,
`requestDelayMs`, `thinking`, multimodal flags (`supportsImages`, `supportsVision`,
`supportsAudio`), `supportsStructuredOutput`, `supportsImageGeneration`,
`imageGeneration`, free-form `config` (provider-specific), `hint` (UI banner),
encrypted `apiKey`, `autoDiscovery`.

Provider-level metadata lives in a separate `config/providers.json`
(`server/defaults/config/providers.json:1`) with `enabled`, localized name/description,
and `category`. Bedrock declares a `providerConfigSchema` in `bedrock.js:25-59` consumed
by the admin Model Form Editor.

### Runtime selection

`server/routes/modelRoutes.js:75-113` exposes `GET /api/models` with permission filtering
(`configCache.getModelsForUser`) and ETag-based caching. The chat flow goes through
`server/services/chat/RequestBuilder.js:79` (`filterModelsForApp`) which picks the
model from app `preferredModel`/`allowedModels`/user preference, then
`server/adapters/index.js:42-44` dispatches via `getAdapter(model.provider)`. The
streaming pipeline is `ChatService → RequestBuilder → StreamingHandler → adapter SSE
parser` (`server/services/chat/ChatService.js:97-120`).

### OpenAI-compatible inference proxy

`server/routes/openaiProxy.js:21` mounts a parallel `/api/inference/v1/{models,chat/completions}`
that translates inbound OpenAI requests to the generic format, dispatches via the
provider-specific adapter, then re-encodes the response back to OpenAI format using
`convertResponseFromGeneric`. This makes ihub-apps usable as a drop-in OpenAI proxy for
external clients (handles permissions, client-disconnect abort, telemetry, tool
conversion). No equivalent surfaces in astron-agent.

### Model auto-discovery

`server/services/ModelDiscoveryService.js:1` — calls the `/v1/models` endpoint on
OpenAI-compatible providers (vLLM, LM Studio, Jan.ai), 5-minute cache TTL,
deduped concurrent fetches, falls back to configured `modelId`. Triggered when
`autoDiscovery: true` (`modelConfigSchema.js:122-124`).

### Multimodal, thinking, structured output

- **Images** in every adapter; multi-image arrays supported, per-provider media-type
  handling (`anthropic.js:39-62`, `google.js:194-218`, `openai.js:58-79`, `bedrock.js:227-249`).
- **Audio**: OpenAI multipart input_audio (`openai.js:83-105`), Gemini inlineData.
- **Documents**: Bedrock-only document blocks (`bedrock.js:251-262`, 5-doc cap enforced).
- **Thinking**: Gemini thinkingConfig (`google.js:353-372`), GPT-5 Responses reasoning
  effort (`openai-responses.js:143-167`), Bedrock reasoningContent stream (`bedrock.js:423-425`).
- **Structured output**: per-provider JSON-schema strict modes
  (`openai.js:142-176`, `anthropic.js:172-180` via tool, `google.js:319-345`,
  `mistral.js:73-83`).
- **Image generation**: Gemini with aspect-ratio table (`google.js:13-64`, `:374-421`).
- **Grounding metadata**: Gemini Search grounding (`google.js:518-521`).

### API key management

Per-model encrypted `apiKey` field (`modelConfigSchema.js:120`) — stored in the model
JSON, decrypted at request time by `TokenStorageService` (AES-256-GCM, key in
`contents/.encryption-key`). Provider-level fallback through env vars
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) handled by `getApiKeyForModel`.

### Streaming, throttling

- SSE through `BaseAdapter.parseSseStream` (`BaseAdapter.js:155-188`).
- Bedrock binary EventStream parsed by `bedrockEventStream.js`.
- iAssistant uses line-delimited multi-event blocks (`BaseAdapter.js:201-249`).
- Per-model concurrency + delay enforced by `server/requestThrottler.js:25,37,43`
  using `concurrency` and `requestDelayMs` from the model schema.

### Fine-tune, prompt caching, MaaS, billing

- **Fine-tune**: none.
- **Prompt caching**: not exposed (Anthropic `cache_control`, Gemini implicit, OpenAI
  Responses cache — none surfaced; `grep` confirms zero occurrences).
- **MaaS / model deployment lifecycle**: none — ihub-apps assumes models are pre-deployed
  and consumed by URL. Local LLM is supported via vLLM as a configured upstream.
- **Billing / credits**: not implemented at the model layer (telemetry counts tokens
  via the adapter `usage` field but no quota / billing enforcement).

## 3. Gap matrix

| Capability | astron-agent | ihub-apps | Gap severity | Notes |
| --- | --- | --- | --- | --- |
| Provider count (runtime adapters) | 3 generic + 1 Spark | 8 (incl. Bedrock, vLLM, GPT-5 Responses, iAssistant) | astron lags | ihub-apps is ahead |
| iFLYTEK Spark adapter | dedicated `SparkChatService` | none | medium (only if Spark targeted) | needs `SparkChatClient` Java→Node port or REST translation |
| Tool-calling normalization | implicit (AgentResponse chunks) | dedicated 8-converter generic layer | astron lags | ihub-apps is ahead |
| OpenAI-compatible inference proxy | none | `/api/inference/v1/*` | astron lags | ihub-apps is ahead |
| Model registry CRUD UI | full Spring CRUD with categories & shelf | admin model edit + provider config | medium | ihub-apps lacks category tree, shelf, model marketplace |
| Model categorization / "shelf" / marketplace | yes | partial (hint + enabled flag) | medium | useful for tenants browsing |
| RSA-encrypted client-side key submission | yes (`/rsa/public-key` flow) | server-side AES-256-GCM at rest | low | different threat model; ihub's is good but key never crosses transport unencrypted only via HTTPS |
| **MaaS deployment lifecycle (deploy/update/status/delete)** | **yes (`LocalModelHandler`)** | **none** | **HIGH** | core differentiator of astron's pitch |
| GPU / replica / context-length sizing | yes (`ModelDeployVo`) | none | high | requires k8s operator backend |
| Local model file management | `/local-model/list`, `LocalModelDto` | partial (vLLM auto-discovery only) | medium | upload + register from disk path |
| Workflow cleanup on model removal | yes (`ShelfModelService.offShelfModel`) | manual | medium | when admin deletes a model, ihub leaves dangling refs |
| SSRF guard on outbound provider URLs | yes (`SsrfParamGuard`) | none documented | medium | risk surface in admin-supplied URLs |
| Connection validation before save | yes (`ModelService.validateModel` reflects to provider) | client/server-side smoke test only | medium | low-effort win |
| Per-model rate limits / quotas | none (delegated upstream) | `concurrency` + `requestDelayMs` | astron lags | ihub-apps is ahead |
| Fine-tune state management | yes (`switchFinetuneModel`, Redis) | none | low | likely not relevant to ihub's deployment story |
| Prompt caching | none | none | n/a | both lack |
| Multi-tenancy at model level | yes (`space` ownership in MyBatis) | groups-based ACL via `permissions.models` | low | semantically equivalent for most use cases |
| Multimodal (image/audio/video/doc) | partial (Spark domain mapping) | extensive (Bedrock docs, OpenAI audio, Gemini image gen) | astron lags | ihub-apps is ahead |
| Streaming + cancellation | yes (SSE) | yes + client-disconnect abort | comparable | ihub slightly better |
| Auto-discovery from `/v1/models` | none | yes | astron lags | ihub-apps is ahead |
| Cost / usage telemetry per model | none (delegated) | OTEL token metrics | astron lags | ihub-apps is ahead |
| MCP servers in model selection UI | yes (via `tool_base`) | tools admin UI | comparable | different surface |

## 4. What we should reimplement (ranked)

Ranked by user value × differentiation × tractability.

1. **Connection validation on model save (validateConnection endpoint)** — S, low risk.
   Astron's `ModelService.validateModel()` reflects a probe request against the provider
   before persisting. Adding this to ihub-apps' admin model save closes a common foot-gun
   ("admin saves wrong URL, users get 502"). Already partially there client-side but no
   server-side reflection.

2. **Model categorization / marketplace ("shelf") + category tree** — M, low risk.
   `ModelCategoryService.getTree()` powers a hierarchical model picker in astron's UI.
   Maps neatly onto an optional `category` field plus a `config/model-categories.json`
   in ihub. Useful as iHub grows past 20 models. Pairs with admin polish.

3. **MaaS deployment lifecycle abstraction** — XL, high risk, high reward.
   This is astron's headline feature. The right scope for ihub-apps depends on the
   deployment story we want to commit to (see open questions). Concretely: an admin
   surface that, given a vLLM/Ollama/TGI/LMStudio backend URL or a Kubernetes-aware
   operator URL, lets users `deploy/update/status/delete` model serving instances. The
   minimal viable shape mirrors `LocalModelHandler`: HTTP delegation to an external
   "inference operator" — ihub becomes the control plane, the operator is pluggable.

4. **Workflow / app integrity cleanup on model removal** — S, low risk.
   Today `DELETE` of a model leaves `preferredModel` references dangling in
   `contents/apps/*.json`. Port `ShelfModelService.offShelfModel` logic: when a model is
   disabled/deleted, sweep apps + workflows and either auto-disable or surface a warning.

5. **iFLYTEK Spark provider adapter** — M, medium risk.
   Astron is iFLYTEK's flagship product; if we want to compete on Chinese-market parity,
   a `spark.js` adapter that speaks the OpenAI-compatible Spark v3.x HTTP API (X1 /
   4.0 Ultra) is straightforward. The non-compatible WebSocket flow (`wss://spark-openapi.cn-huabei-1.xf-yun.com`)
   would only be necessary for legacy Spark v2.x and is not recommended.

6. **SSRF guard for admin-supplied model URLs** — S, low risk.
   Astron's `SsrfParamGuard` blacklists internal IPs before any outbound model call.
   ihub-apps currently trusts admin-entered URLs implicitly — a meaningful hardening
   given the admin Model Form Editor accepts arbitrary URLs.

7. **Prompt caching primitives** — M, low risk.
   Neither system has it, but Anthropic `cache_control`, Gemini implicit caching, and
   OpenAI Responses caching are all becoming standard. Adding `supportsPromptCaching`
   + per-message `cacheable: true` would put ihub-apps ahead.

8. **Per-provider declarative metadata (capability matrix)** — S, low risk.
   Astron carries this in `LLMService`'s provider mappings (auth header style, endpoint
   path). ihub-apps' equivalent is scattered across adapter files. Centralizing into
   `server/adapters/capabilities.js` would simplify documentation and unblock #2 and #3.

## 5. Implementation outline (top 3)

### 5.1 Connection validation on model save

**Files**

- New: `server/services/ModelValidationService.js` — exports `validateModelConnection(model, apiKey)`
  which builds a tiny probe request via the matching adapter (e.g. one-token completion
  with the model's `system` ping) and returns `{ok, latencyMs, errorCode, errorMessage}`.
- Edit: `server/routes/admin/models.js` — add `POST /api/admin/models/validate` that calls
  the service against a draft model object (without persisting).
- Edit: `client/src/features/admin/models/ModelEditor.jsx` (or equivalent) — add "Test
  connection" button before Save.

**Schema delta**: none required. Optional: persist `lastValidatedAt` + `lastValidationStatus`
on the model row for the admin list view.

**Migration**: not required for the feature itself. If we persist validation status,
create `server/migrations/V{NNN}__add_model_validation_status.js` to set defaults.

**Tests**: unit tests against mocked `fetch` per provider; integration test against the
admin endpoint with a deliberately bad URL → expects `502/timeout` classification.

### 5.2 MaaS deployment lifecycle (pluggable inference operator)

**Decision required** (Open Q1): commit to one of —
(a) thin proxy to an external operator (mirror astron's `LocalModelHandler` design),
(b) bundle our own k8s operator,
(c) Docker-Compose local-only (good enough for self-hosters).

Assuming (a) — the lowest-risk, highest-leverage choice.

**Files**

- New: `server/services/maas/MaasOperatorClient.js` — HTTP client to the configured
  operator endpoint with `deploy/update/status/delete/list` methods. URL & creds in
  `platform.json` → `maas` section.
- New: `server/services/maas/MaasDeploymentRegistry.js` — persists `serviceId` ↔ model
  config rows in `contents/maas-deployments.json`. Includes background poller that
  refreshes status every 30s.
- New: `server/routes/admin/maas.js` — `POST /api/admin/maas/deployments`,
  `PUT /api/admin/maas/deployments/:id`, `DELETE`, `GET /api/admin/maas/deployments`,
  `GET /api/admin/maas/files`.
- New: `server/validators/maasDeploymentSchema.js` — Zod schema mirroring astron's
  `ModelDeployVo` plus `image`, `env`, `ports`, `healthCheck` for operator flexibility.
- Edit: `server/defaults/config/platform.json` — add encrypted `maas.{baseUrl, apiKey, kind}`.
- New: `client/src/features/admin/maas/` — list view + deploy wizard + status badges
  driven by the polling endpoint.
- Edit: `client/src/utils/runtimeBasePath.js` — add `/admin/maas` to `knownRoutes`.

**Config schema delta** (platform.json):

```jsonc
{
  "maas": {
    "enabled": false,
    "operator": {
      "baseUrl": "${MAAS_OPERATOR_URL}",
      "apiKey": "${MAAS_OPERATOR_API_KEY}",  // encrypted at rest
      "kind": "generic" // "generic" | "kserve" | "ollama" | "vllm-operator"
    },
    "defaults": { "replicaCount": 1, "contextLength": 8192, "acceleratorCount": 1 }
  }
}
```

**Migration**: `server/migrations/V{NNN}__add_maas_platform_section.js` that
`ctx.setDefault(platform, 'maas.enabled', false)` and writes the operator shell.
Secrets handled by the existing `encryptPlatformSecrets` path
(add `maas.operator.apiKey` to the encrypted-fields list in `server/routes/admin/configs.js`).

**UI hooks**: on successful `deploy`, materialize a model entry in `contents/models/`
pointing at the operator-returned endpoint URL, with `provider: "openai"` (or "local")
and `enabled: false` until status is `running`. Auto-flip to enabled on first healthy
status poll.

**Tests**:

- Unit: `MaasOperatorClient` against a mock HTTP server covering all 5 verbs + error mapping.
- Integration: full deploy → poll → auto-enable → chat → delete cycle using a fake operator.
- E2E: admin UI flow with Playwright.

**Risk callouts**: this is a control-plane feature without a data plane shipped — be
explicit in docs that ihub-apps requires an external operator. Reference implementations
(KServe, Ollama, vLLM-operator) should be documented but not bundled.

### 5.3 Workflow / app integrity cleanup on model removal

**Files**

- Edit: `server/routes/admin/models.js` — wrap `DELETE /api/admin/models/:id` and
  `PUT` (when `enabled: false`) with `await modelIntegrityService.cleanupReferences(modelId)`.
- New: `server/services/ModelIntegrityService.js` —
  - Scan `contents/apps/*.json` for `preferredModel`, `allowedModels` matches.
  - Scan `contents/workflows/**/*.json` for embedded LLM-node model refs.
  - Strategy per the request: `?strategy=warn` (default — return blocking diagnostics)
    or `?strategy=cascade` (auto-unwire, write a back-up to
    `contents/.deleted-model-backups/{modelId}/{timestamp}.json`).
- Edit: client admin model delete dialog — show affected resources, choose strategy.

**Schema delta**: none (operations are filesystem mutations on existing JSON).

**Migration**: not needed.

**Tests**: snapshot tests on a synthetic apps/workflows fixture; verify both warn and
cascade strategies.

## 6. Open questions

- **Q1 (blocking for §5.2)**: Does the ihub-apps product want to own MaaS, or stay
  control-plane only? Astron's pitch is "one-click on-prem MaaS"; ihub's current pitch is
  app/agent surface over hosted models. Building a real k8s operator is XL effort; a
  thin proxy to an existing operator (KServe, Ollama, vLLM-operator) is M effort and
  arguably more in keeping with ihub's "we don't try to be infra" stance.
- **Q2**: How real is the Spark / Chinese-market user demand? If non-trivial, a Node
  port of `cn.xfyun.api.SparkChatClient` is doable; if not, an HTTP-only OpenAI-compatible
  Spark X1 adapter (`spark.js`) is enough.
- **Q3**: Encryption-in-transit for admin-submitted API keys. Astron's RSA-public-key
  pattern protects against an HTTPS-terminating reverse proxy logging request bodies
  with keys. ihub-apps relies on TLS + AES-at-rest. Worth adopting for compliance
  scenarios (the public key endpoint is one extra route).
- **Q4**: How does astron's `LocalModelHandler` HTTP API actually look on the wire? The
  Java code calls it through `ApiUrl` config but we couldn't find the wire contract or
  the operator implementation in the public repo — likely a separate iFLYTEK internal
  service. We may need to define our own contract (and document operator compliance).
- **Q5**: Should ihub-apps' future MaaS controller surface live in `server/routes/admin/`
  alongside model routes, or as a sibling top-level admin area (`/admin/infra/`)? The
  former keeps related concerns close; the latter scales better if we add embeddings /
  reranker / TTS deployments.
- **Q6**: Does the `BaseAdapter` design need rework before adding a real adapter count?
  Currently every adapter manually re-implements `formatMessages`, `createCompletionRequest`,
  `processResponseBuffer` — adding Spark + a refactor for prompt caching together might
  be more efficient than two passes. Suggest doing #8 (capability matrix) before #5
  (Spark) and #7 (caching).
