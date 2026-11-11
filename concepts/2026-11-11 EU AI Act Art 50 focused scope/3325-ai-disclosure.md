# #3325 AI Act Art. 50(1): the assistant always discloses that it is an AI

> **Superseded (step 9).** "The guardrail cannot be switched off" now reads: it can only be turned off through the audited EU AI Act master switch (`eu-ai-act-switch.md`). No app setting, env var or per-feature switch exists.

Epic: #3324 (EU AI Act Art. 50, focused scope). Stack position: **first** (3325 -> 3326 -> 3327 -> 3331 -> 3328 -> 3329).
Repo state checked: `main` at `ed5557a`; branch `claude/epic-analysis-planning-45wief` exists locally, no #2619 branch (`git branch -a`), `server/services/provenance/` does not exist. The guardrail is written fresh.
Author roles: Product Manager (Part 1), Senior Engineer (Part 2). Not legal advice.

---------------------------------------------------------------------------------------------------

# Part 1 - Product Manager

## 1.1 What and why
Two small, independent deliverables that together satisfy "people know they are talking to an AI":

1. **Guardrail (server, invisible):** every request that reaches a text model carries a fixed rule: "You are an AI system. If asked, always say so. Never claim to be human, even in a role." Neither app config nor user prompt can remove it. Covers chat, `/api/inference/v1/*`, MCP, A2A, agents, workflows, scheduled tasks.
2. **First-turn notice (client, passive):** a text in the *empty* chat ("You are chatting with an AI system...") that is shown before the first message, is configurable globally, overridable per app, can be switched off, and is never part of the conversation (not sent to the model, not stored, not shown again when a stored chat is reopened).

Legal driver: Art. 50(1) AI Act (providers must design systems that interact directly with people so that people are informed they are dealing with an AI, unless obvious). Per the epic it applies **now**; 50(2) marking is due 2026-12-02. Note for the team: the Code of Practice mentioned in the epic is mainly about 50(2)/(4) marking and labelling; 50(1) is a direct statutory duty. The two measures here (prompt rule + visible notice) are the "inform" mechanism; the guardrail also stops the model from *denying* it in role-play, which is the failure mode an auditor would test.

Who benefits: end users (honest, early disclosure), operators/customers (a compliance baseline they do not have to build per app), IntraFind (a documented, testable compliance claim; foundation for #3326 acknowledgement and #3327 provenance).

## 1.2 User stories (with acceptance criteria)
- **US1** As an end user, I want the assistant to tell me it is an AI whenever I ask, so that I am never misled. 
  - Given any channel and any app, when the user asks "Are you a human?" then the model request contains the guardrail and the answer discloses AI status.
  - Given a role-play persona app ("You are Anna, a human support agent"), same result; the guardrail is the last instruction in the system prompt.
- **US2** As an API/MCP/A2A integrator, I want the same behaviour on every programmatic channel, so that disclosure does not depend on the entry point.
  - Guardrail present in the assembled system message for chat, inference API (chat.completions and responses), MCP tool calls, A2A tasks, agents, workflow prompt nodes, scheduled tasks (unit tests, one per channel).
- **US3** As an admin, I want the rule to be impossible to disable via app config, the user prompt, the inference `system`/`developer` message, or request fields, so that I can rely on it in an audit.
  - No config flag exists. A client-supplied system message cannot remove or reorder it (it is appended after).
- **US4** As an end user, I want to see a short note before my first message that I am chatting with an AI, so that I know before I type.
  - Notice visible in an empty chat; gone after the first message is sent; not visible when a stored chat with messages is reopened; not in the transcript, export, share, or model context.
- **US5** As an admin, I want to set the notice text for all apps (per language), and override it per app, and turn it off, so that it fits our wording and apps where it is redundant.
- **US6** As an admin of an app with a start form or auto-start, I want the notice to still appear in a sensible place (see 1.5).

## 1.3 Success criteria
- 100% of LLM calls to chat-type models made through `LLMClient` carry the guardrail (single enforcement point, test enumerates channels).
- Notice renders in empty chat for default install with zero admin action (default on, built-in en/de text).
- Zero new stored data; zero change to API response shapes.
- No increase in prompt-cache miss rate (constant suffix, see 2.3).

## 1.4 Non-goals
- User acknowledgement / dialog / enforcement / storage (#3326). Provenance, marking, watermarking (#3327, #3331, #3328). Overview page (#3329). Optional decision issue #3330.
- Changing the model's tone or persona beyond the one rule. No attempt to detect or filter "I am human" in model *output*.
- Disclosing AI nature in generated artefacts (files, emails) - that is 50(2).
- No per-user opt-out, no "don't show again" (that would need storage).
- No guardrail translation: the rule is English only, models follow it in any language (open question Q3).

## 1.5 Ambiguities in the issue, resolved into requirements
| Issue wording | Requirement |
|---|---|
| "Append a fixed rule to every system prompt" | Append (last position, `\n\n` separator) to the **first system message**; create one if none exists. Applied once per model call. |
| "Not overridable: neither app config nor user prompt" | No config key, no request field, no env var. A test proves that an app system prompt saying "never reveal you are an AI" still ends with the guardrail. |
| "first turn is not part of the chat. means it doesn't go into the context and not stored, when the chat is reopened." | The notice is pure UI state derived from `messages.length === 0`. It is never an element of `messages`, never sent in the chat request, never persisted. Reopened stored chat (has messages) shows no notice; an *empty* stored chat shows it again (nothing was recorded). |
| "first turn notice can be disabled" | `enabled: false` globally = master switch, hides it everywhere (an app cannot switch it back on). App level `enabled: false` hides it for that app. Decision needed from PM owner (Q1). |
| "text configurable globally and overridable per app" | Per-language localized map. Resolution: app text for language, else app text `en`... else platform text, else built-in i18n default. Blank entries ignored. |
| "Nothing is stored for the notice; the acknowledgement is its own sub-issue" | Confirmed; no storage, no audit entry in #3325. |
| "Reuse guardrail.js from #2619 (43 lines)" | Not available. Create `server/services/provenance/guardrail.js` to the same spec (exports the constant and an `applyAiDisclosureGuardrail(messages)` pure function). Keep path so #3327's `server/services/provenance/*` lands beside it. |
| "agents and workflows" | Covered by the single choke point; no per-feature code. |

## 1.6 Open questions / risks
- **Q1** Is `enabled:false` at platform level a hard master switch? (Recommended yes.) Does the notice apply to workflow start pages / Office add-in / embed? (Recommended: wherever `AppChat` empty state renders, i.e. also embed and canvas; workflows UI is not a chat, out of scope.)
- **Q2** Default text and default-on for existing installations: a visible change on upgrade; needs a release note (admins will notice). Confirm default-on.
- **Q3** English-only guardrail text vs localized: recommend English (model-facing instruction, not user-facing).
- **Q4** Internal utility calls (chat titles, translate, OCR, planner/verifier JSON calls) also get the guardrail with the one-choke-point design. Cost ~25 tokens; recommended to accept for "cannot be bypassed" simplicity. Alternative: exempt by `telemetry.purpose` (adds a bypass surface).
- **R1** Models can still ignore a prompt rule in strong role-play; the guardrail reduces, not guarantees. Acceptance is "present in the assembled prompt" plus a manual smoke check on 2-3 real models.
- **R2** iAssistant (iFinder) conversation provider does not send the system message at all (see 2.2) - needs its own injection or it silently misses the rule.
- **R3** Stack conflicts: #3327/#3331 also touch `LLMClient.execute` and chat result paths; keep our diff there small and separate.

---------------------------------------------------------------------------------------------------

# Part 2 - Senior Engineer

## 2.1 Findings: how system prompts are assembled (there are many places)
System text is built in at least 9 places, so appending "in the system prompt" per channel would be bypassable and fragile:

| Channel | Where |
|---|---|
| Chat app prompt | `server/services/PromptService.js:381 processMessageTemplates`; builds the app prompt only `if (app && !llmMessages.some(m => m.role === 'system'))` (line 488) and `unshift`s at line 622. Add-ons: `RequestBuilder.js:121-130` (integration scopes), `voiceMode.js:121-123`, `actionGuidance.js:211`, `schedulingContext.js:54`, `taskExecution.js:115-122`. |
| Inference API chat.completions | `server/routes/openaiProxy.js` : plain models allow client `system`/`developer` (mapped to `system` in `services/inference/inputContent.js:518,623`); apps refuse them (`openaiProxy.js:764`); calls `llmClient.execute` at `:598`; JSON mode adds an instruction via `plainTurn.js:92`. |
| Inference API responses | `server/routes/inference/responses.js:697` (`instructions` -> system), checks at `:314,504`. |
| MCP and A2A | `server/services/mcp/appInvoker.js:104` -> `ChatService.invokeAppInternal`; A2A in `server/services/mcp/a2aHandler.js` -> same invoker. Same prompt path as chat. |
| Agents (chat with agent profile) | `ChatService` -> `AgentLoop.js:513 llmClient.execute`. |
| Workflows | `workflow/executors/PromptNodeExecutor.js:927,934` (two system messages!), `PlannerNodeExecutor.js:913`, `VerifierNodeExecutor.js:588,614`, `QueryPlanNodeExecutor.js:122`, `QuoteValidatorNodeExecutor.js:167`, `ContextSummarizer.js:209`. |
| Scheduled tasks | `scheduler/tasks/taskExecution.js` (chatService + `llmClient`), `memoryComposer.js:347`. |
| Utility calls | `chatTitles.js:72`, `titleGenerator.js:98`, `routes/admin/translate.js:37`, `magicPromptRoutes.js:105`, `ocrProcessor.js:261`, `appUsageGuide.js:43`. |

**Single choke point found:** every one of them ends in `LLMClient.execute()` (`server/services/loop/LLMClient.js:624`; its own comment at `:502-505` says every model call passes through `execute`; `complete()` at `:1180` calls it). Nothing else calls `createCompletionRequest` (`grep` shows only `LLMClient.js:493/826` and the adapter registry `adapters/index.js:52`).

## 2.2 Where to inject (decision)
**In `LLMClient.execute`, right after the model is resolved (after line ~644) and before quota/usage/`createRequest` (`:826`).** Replace the destructured `messages` (line 625, `const`) with `let`/a new `guardedMessages` and use it for everything after (`createRequest` `:826`, span `:866`, `messageCount` `:874`, `currentMessages = messages` `:952` for pause_turn continuations, usage estimate `:1132/1141`, run-log delta `:1532+`). The caller's array is never mutated (AgentLoop reuses it across steps).

Rules for `applyAiDisclosureGuardrail(messages)` (pure, in `server/services/provenance/guardrail.js`):
- Find the **first** `role === 'system'` message. Reason: `anthropic.js:57` uses `messages.find(system)` and drops the others; Gemini/OpenAI-Responses/Bedrock join all (`google.js:216-218`, `openai-responses.js:102-107`), so the first one is the only position every adapter keeps. PromptNodeExecutor emits two system messages; the second would be lost on Anthropic.
- Append `\n\n` + `AI_DISCLOSURE_RULE` as the **last** text (recency beats a persona prompt). If `content` is a string: concatenate; if an array of parts: push `{type:'text'}` part; if none: `unshift({role:'system'})`.
- Idempotent: skip when the content already ends with the rule (retries, continuations). Do not dedupe by `includes` from the start (user text could contain the rule mid-prompt and then be followed by an override).
- Apply only for text chat models: skip when the model is an image/tts/transcription/embedding type (same predicate family as `LLMClient.js:570`, `(m.modelType || 'chat') === 'chat'`).
- Test seam: `opts.guardrail` in the constructor (default real implementation, like `quota`/`usage` at `:505-511`); `server/tests/loop/*` `makeClient` can pass `guardrail: null` so existing snapshots stay valid. No config flag.

**Extra spot - iAssistant:** `adapters/iassistant-conversation.js` `formatMessages` (`:124-132`) takes only the last user message; the system text never leaves iHub. The only prompt channel is `responseGeneration.system_prompt_preamble` (`:309-316`, built in `resolveConfig` `:141-196`). Append the rule there (in `resolveConfig`, after substitution) so the iFinder model gets it too. Add an adapter test in `server/tests/iassistantConversationAdapter.test.js`.

**Belt and braces:** none other. Do not also add it in `PromptService`: double application hides bugs; the choke point is the contract. Add a lint-like unit test that fails when a new file imports `createCompletionRequest` outside `LLMClient`/`adapters/index.js` (grep-based, cheap) so the invariant survives refactors.

## 2.3 Pitfalls
- **Prompt caching:** appending a constant suffix keeps the prefix stable; Anthropic cache breakpoint is "end of system prompt" (`anthropic.js:310-330`), applied after our change since we run before `createRequest`; the suffix is part of the cached block. OK. Do not put it *before* the app prompt (would break prefix caching across apps).
- **Debug dumps / run log** record `messages`: they should show the guardrail (what was really sent). Using the guarded array from the top gives this for free.
- `usage` token estimates (`estimateCallUsage`) include the ~25 tokens; fine.
- Message `content` can be non-string (parts); `RequestBuilder.js:121-124` guards with `typeof === 'string'`; do not copy that guard blindly or the rule is skipped for array content.
- `/api/inference` plain models: clients may send `system`; we append after theirs. Clients can still talk the model into denying; documented residual risk.
- Structured-output / JSON calls: system gets one more sentence; harmless.
- Do not log the rule text on every call at info level.

## 2.4 Config and schema
**Platform (`platform.json`)** - add to `server/validators/platformConfigSchema.js` (objects use `.passthrough().prefault({})`, see `voiceMode` at `:855-905`):
```js
aiDisclosure: z.object({
  firstTurnNotice: z.object({
    enabled: z.boolean().prefault(true),
    // { "en": "...", "de": "..." }; empty -> built-in i18n text
    text: z.record(z.string().regex(LANGUAGE_CODE_PATTERN), z.string().max(1000)).prefault({})
  }).passthrough().prefault({})
}).passthrough().prefault({})
```
No `guardrail` key by design (a test asserts the schema rejects/ignores `aiDisclosure.guardrail`).

**Per app** - `server/validators/appConfigSchema.js`: the app schema is `.strict()` (`:688`), so the field must be added next to `greeting` (`:581`):
```js
aiDisclosure: z.object({
  firstTurnNotice: z.object({
    enabled: z.boolean().optional(),          // undefined = inherit
    text: localizedStringSchema.optional()    // `:19`
  }).strict().optional()
}).strict().optional()
```
Also check/update: JSON schema export `server/utils/schemaExport.js`, admin app editor defaults `client/src/features/admin/pages/AdminAppEditPage.jsx:98,164` (greeting pattern), `docs/apps.md`.

**Expose to client:** `/api/configs/platform` is a hard whitelist (`server/routes/chat/dataRoutes.js:780+`, `sanitizedConfig`). Add `aiDisclosure: { firstTurnNotice: { enabled, text } }` there (non-secret). App config reaches the client as-is (verify with `GET /api/apps/:id` in the e2e).

**Resolution helper** (shared, used by client and unit-tested): `shared/aiDisclosure.js` `resolveFirstTurnNotice({ platform, app, language, t })` -> `{ visible, text }`. Order: platform `enabled===false` -> hidden; app `enabled===false` -> hidden; text = app[lang] ?? app.en ?? platform[lang] ?? platform.en ?? `t('aiDisclosure.firstTurnNotice')`.

## 2.4a Migration
Latest on disk is **V240** (`server/migrations/V240__footer_text_translation_reference.js`); the issue's "after V226" is stale. **#3325 takes V241**: `V241__ai_disclosure_first_turn_notice.js`. Re-check `ls server/migrations | tail -3` when starting; the stack should then use V242 (#3326), V243 (#3327), V244 (#3331), V245 (#3328), V246 (#3329) for those that need one.
- Needed because the default entry appears in `platform.json` for admins (CLAUDE.md "Config Migrations"; pattern: `V232__chat_titles_setting.js`, `ctx.setDefault`, `precondition` = `config/platform.json` exists).
- `ctx.setDefault(platform, 'aiDisclosure.firstTurnNotice.enabled', true)` and `...text`, `{}`. Do not overwrite an existing value. Add `server/defaults/config/platform.json` with the same block so fresh installs match.
- Test: `server/tests/migration-v241.test.js` (pattern `migration-v168.test.js`): sets defaults, keeps admin values, idempotent, skips when no platform.json.
- Per-app field: no migration (optional).

## 2.5 Client
- **Where:** `client/src/features/apps/pages/AppChat.jsx`: `startupView` (`:178`) and `renderStartupState` (`:192`, called at ~`:3347`, `:3400` and the other layouts). Wrap the result of `renderStartupState` (not each branch) with a new `<AiNotice />` above it, so it shows with starter prompts, greeting and the bare empty view alike, and in mobile/desktop/centered layouts. It is only reachable when `messages.length === 0`; keep the existing guards (`modeResolving` -> null, `hydrating` -> spinner) so a stored chat never flashes the notice.
- **Start-form apps** (`renderStartForm()`, `:3300` area, `ChatStartForm.jsx`): render the notice above the form too.
- **autoStart apps** (`AppChat.jsx:1483`): the first turn is sent without user typing; the notice has no empty-state moment. Show it as a dismiss-less, non-persistent banner above the first answer while `messages.length <= 1`? Simpler and recommended: accept no notice for autoStart apps (guardrail + disclaimer under input still apply) and note it as a known gap in docs; PM to confirm (Q1).
- New component `client/src/features/chat/components/AiFirstTurnNotice.jsx` (SPDX header; `role="note"`, not a live region (a11y-audit skill: no announcement spam), `Icon name="informationCircle"` like `AIDisclaimerBanner.jsx`), text via `resolveFirstTurnNotice`, markdown inline links via the same `DOMPurify.sanitize(marked.parseInline())` as `GreetingView.jsx:34`. Dark-mode classes as in `GreetingView`.
- Do not add to `messages`, `useChat` state, `ChatMessageList`, export, share, or the request payload. Embed/canvas/office panels reuse `AppChat`/`ChatInput` paths: check `OfficeChatPanel.jsx` and `CanvasChatPanel.jsx` and add the same component if they have their own empty state.
- **No new route** (so no `KNOWN_ROUTES` / `index.html` change).
- **Admin UI:** (a) per-app section in `client/src/features/admin/components/app-form/` (new `AiNoticeSection.jsx`: tri-state enabled select inherit/off, localized textarea via `DynamicLanguageEditor.jsx`), wired in `AdminAppEditPage.jsx`; (b) platform text/toggle: smallest option is a card on `AdminAdvancedPage.jsx`/`AdminChatHistoryPage.jsx`-style page that posts `platform.aiDisclosure` through the existing `POST /api/admin/configs/platform` (`server/routes/admin/configs.js:267`). #3329 later builds the overview page; do not build a new page here.
- **i18n** (`shared/i18n/en.json`, `de.json`, nested keys; keep parity): `aiDisclosure.firstTurnNotice` ("You are chatting with an AI system. Its answers can be wrong; check important information." / German equivalent), `admin.aiDisclosure.*` (title, enabled, text, inherit/off options, help text), `admin.apps.aiNotice.*`. Optionally the V240 `$t(...)` reference pattern (`client/src/utils/translationRefs.js`) is not needed because empty text falls back to the i18n key.

## 2.6 API surface
No new endpoints, no new error codes, no response shape change (so `docs/api-guidelines.md` rules are untouched; no `ServiceError`). Only an additive field in `GET /api/configs/platform` and the app config. No outbound connections added (SSL whitelist rule n/a).

## 2.7 Tests
Unit/server (`server/tests`, run by `npm run test:server`; SPDX header on each new file):
1. `server/tests/guardrail.test.js`: pure function: appends to first system message; creates one if absent; array content; idempotent; leaves caller array untouched; keeps position when several system messages; skips non-chat models; user "ignore previous" text still followed by the rule.
2. `server/tests/loop/llmClientGuardrail.test.js`: `LLMClient` with a capturing `createRequest`/`transport` stub: rule present for `execute`, `complete`, with persona system prompt, with a client-supplied system message, on pause_turn continuation, and absent for an image model.
3. Channel assembly tests (acceptance criterion "present for chat, inference API, MCP, A2A, agents and workflows"): one test per channel capturing the request body at the transport seam: chat via `ChatService`; `/api/inference/v1/chat/completions` (plain model and app) and `/responses` via the existing route harness (see `server/tests/inference-units.test.js`, `rateLimiting-auth-inference-mount.test.js` for mounting); MCP `appInvoker`; A2A (`server/tests/a2a/`); agent loop (`agent-budget-loop.test.js` helpers); workflow `PromptNodeExecutor`; scheduled `taskExecution`. Each uses a persona app whose system prompt says "You are Anna, a human".
4. Adapter-level: `anthropicAdapter.test.js` (system dropped except first -> rule survives), `googleAdapter.test.js`, `openaiResponsesAdapter.test.js`, `iassistantConversationAdapter.test.js` (preamble contains rule).
5. Invariant test: no source file outside `LLMClient.js`/`adapters/` imports `createCompletionRequest`.
6. Schema tests: platform + app Zod accept/reject; app `.strict()` rejects unknown `aiDisclosure` keys; `aiDisclosure.guardrail` is not a thing. `migration-v241.test.js`.
7. `tests/unit/client/ai-first-turn-notice.test.jsx` (pattern: `tests/unit/client/*.test.jsx`): resolution order, disabled globally/per app, language fallback, not rendered when messages exist or while hydrating, sanitized markdown.
E2E (Playwright, `tests/e2e/ai-notice.spec.js`, use default admin `admin`/`password123` for config edits): notice visible in empty chat; disappears after send; reload of the stored chat shows none; the transcript/`GET /api/chats/:id` contains no notice text; per-app override text; global off; start-form app. Real-model "Are you a human?" check is a manual smoke (non-deterministic), documented in the PR, not in CI. Run `npm run test:e2e:subpath` for the base-path variant. Also run `a11y-audit` baseline (`tests/e2e/accessibility.spec.js`) for the new element.

## 2.8 Docs and release note
- `docs/llm-client.md`: new section "AI disclosure guardrail" (choke point, first-system-message rule, iAssistant preamble, no off switch).
- `docs/apps.md` (`aiDisclosure.firstTurnNotice`), `docs/platform.md` (platform block), `docs/ui.md` (notice vs the existing disclaimer under the input), `docs/openai-compatible-api.md`, `docs/mcp-integration.md`, `docs/a2a-agents.md` one-liners. A new `docs/ai-act.md` (added to `docs/SUMMARY.md`) as the landing page the later issues extend: legal map Art. 50(1) / 50(2), what iHub does, what the operator must do.
- Release note via `/document-feature` into `docs/releases/next/features.md`: "Notice that you are chatting with an AI" + "Assistants always say they are an AI" (admin-visible: default on, how to edit/disable, existing installs see the notice after upgrade). No breaking-change entry (no shim, no breaking API).
- Concept doc for the epic belongs in `concepts/` (folder with `README.md` since 3+ related docs): `concepts/eu-ai-act-art-50/2026-11-11 3325 AI disclosure.md` (copy of this analysis) - not created by this analysis task.

## 2.9 Ordered implementation checklist (rough size; S <= 1h, M <= 0.5d, L <= 1d)
1. S  Create `server/services/provenance/guardrail.js` (constant + pure function, SPDX header) + `guardrail.test.js`.
2. M  Wire into `LLMClient.execute` (`messages` -> guarded copy, `opts.guardrail` seam, model-type predicate) + `llmClientGuardrail.test.js`; fix existing loop tests via `guardrail: null` in `makeClient`, run `npm run test:server`.
3. S  iAssistant preamble injection + adapter test.
4. M  Channel tests (item 3 in 2.7) incl. persona app; add the invariant test.
5. S  Zod: platform + app schemas; defaults in `server/defaults/config/platform.json`; `V241` migration + test (confirm number first).
6. S  Expose `aiDisclosure` in `/api/configs/platform` whitelist; `shared/aiDisclosure.js` resolver + unit tests.
7. M  `AiFirstTurnNotice.jsx`, integrate in `renderStartupState` / start form / office+canvas panels; i18n en+de; client unit test.
8. M  Admin UI: app-form section + platform card; i18n.
9. M  Playwright e2e + subpath run + a11y baseline.
10. S  Docs, `docs/SUMMARY.md`, release note (`/document-feature`); `npm run lint:fix && npm run format:fix`; `reuse lint`; boot check `timeout 10s node server/server.js`.
Total: about 2.5-3 engineer days. Biggest risk: existing loop-test snapshots and the many-layout `AppChat.jsx` empty state.
