# Gemini Thought Signatures over the OpenAI-Compatible Inference API

**Date:** 2026-08-27
**Status:** Implemented
**Supersedes (in part):** `concepts/2026-01-28 gemini-thought-signature-fix.md`, which covers the
in-product chat path only and predates the rules verified here.

## Problem

An external application calling `/api/inference/v1/chat/completions` with a Google model and
tools received the first tool call correctly, then failed as soon as it posted the tool result:

```
HTTP 400: {"error":"Error: providerError","details":"{ "error": { "code": 400,
  "message": "Function call is missing a thought_signature in functionCall parts. ..."
```

The in-product chat path, workflows and agents were unaffected.

## Root cause

The generic tool-calling layer stores a Gemini function call's `thoughtSignature` in
`metadata.thoughtSignature`, and `GoogleAdapter.formatMessages` reads it back from there. That
works for internal callers, which pass our own tool-call objects around untouched.

The inference API converts to OpenAI shape on the way out, and
`convertGenericToolCallsToOpenAI` built a fresh object from `id` / `type` / `function` only. The
signature was dropped there, so an external caller had nothing to echo, and the continuation
request reached Gemini with a bare `functionCall` part.

## The actual Gemini rules

Verified against
[ai.google.dev/gemini-api/docs/generate-content/thought-signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).
Several of these contradict the intuitive reading, and one contradicts the earlier concept doc:

| Rule | Detail |
| --- | --- |
| Placement | Gemini 3 puts the signature on the **first `functionCall` part** of a response. Parallel calls after it carry none. |
| Gemini 2.5 | Puts it on the first part **whatever the type** — so a text part can hold it — and treats replay as optional. |
| No function calls | The signature lands on the **last** part of the response. |
| Validation scope | **Current turn only.** The turn opens at the most recent user message with standard content; a `functionResponse` is not a turn boundary. Earlier turns are not validated. |
| Exact placement | The signature must return in the same part it was issued on. |
| Ordering | Parallel calls must come back as `FC1+sig, FC2, FR1, FR2` — interleaving as `FC1, FR1, FC2, FR2` is a 400. |
| Missing signature | Gemini 3 fails the request. Two documented sentinel values skip validation instead. |

## Design

### 1. Carry the signature across the OpenAI boundary

Emitted as `extra_content.google.thought_signature` on the tool call — Google's own
OpenAI-compatibility location, per the doc's "Signatures for OpenAI compatibility" section,
where the client-sent examples annotate it `Required and Validated`.

This is not merely a convention to be polite about. [Hermes
Agent](https://github.com/NousResearch/hermes-agent) — the client that surfaced the bug, which
sees iHub as a plain OpenAI URL and does not know the model is Google-backed — already
implements it in `agent/transports/chat_completions.py`:

- `normalize_response` reads `tc.extra_content`, falling back to the OpenAI SDK's
  `model_extra["extra_content"]` bag, and stores it on `ToolCall.provider_data`.
- `convert_messages` replays it, gated on `_model_consumes_thought_signature(model)` — which is
  simply `"gemini" in m or "gemma" in m` against the **model name**.

A provider-neutral field name was considered and rejected: their `normalize_response` extracts
only `id` / `name` / `arguments` plus `extra_content`, so an alias would be silently discarded.

**Consequence for operators:** clients pattern-match the *model name*, because on a generic
OpenAI endpoint that is the only signal available. A Gemini-backed model published under an id
without `gemini`/`gemma` will have its signature dropped client-side.

### 2. Accept it back from wherever the caller put it

`extractThoughtSignature()` (`server/adapters/toolCalling/thoughtSignatures.js`) checks, in
order: our own `metadata.thoughtSignature`; `extra_content.google.thought_signature` and its
camelCase variant; a flat `thought_signature` / `thoughtSignature` on the call or its `function`.

### 3. Degrade instead of failing

When the first `functionCall` part of a current-turn model message has no signature, substitute
`skip_thought_signature_validator` and log a warning. Deliberate properties:

- **Scoped to the current turn**, matching Gemini's own validation scope, so previous turns go
  back byte-identical to what the model produced.
- **Keyed on the first `functionCall` part specifically**, not "any part of the message". A
  Gemini 2.5 text-part signature does not satisfy Gemini 3's validation, so treating it as
  sufficient would leave the function call unsigned and still 400. (Caught in review; the first
  implementation had this wrong.)
- **Never applied to parallel calls after the first**, which correctly carry no signature.

The tradeoff is explicit: the turn loses its preserved reasoning context, which can weaken
multi-step tool use. It exists so a non-cooperative client gets a working conversation rather
than a hard failure. Preserving the real signature stays strictly better.

### 4. Guard the reverse direction

Emitting `extra_content` makes iHub a *source* of it, which creates a failure mode that did not
exist before: strict OpenAI-compatible providers reject a request that carries the field. Hermes'
own docstring records the exact rejection —
`Extra inputs are not permitted, field: 'messages[N].tool_calls[M].extra_content'` from Fireworks
and Mistral.

The `openai`, `mistral` and `vllm` adapters forwarded `message.tool_calls` by reference, so they
now strip `extra_content` unless `modelConsumesThoughtSignature(model)` holds. That mirrors
Hermes' matching (`gemini`/`gemma` in `id`/`modelId`) and additionally treats a `googleapis.com`
URL as conclusive, so the `openai` adapter pointed at Gemini's compatible endpoint keeps the
field. `formatMessages(messages, model)` takes the model optionally; omitting it strips, which is
the safe default.

## Rejected alternative: server-side signature cache

Caching `tool_call_id → signature` server-side would preserve the real signature even for clients
that drop the field, since the OpenAI protocol requires `tool_call_id` to be echoed. Not taken:
it adds cross-worker mutable state to an otherwise stateless endpoint, to serve a case that
documentation and model naming largely cover — and the reporting client round-trips the field
correctly. Tracked in intrafind/ihub-apps#2241.

## Files

| File | Role |
| --- | --- |
| `server/adapters/toolCalling/thoughtSignatures.js` | Extraction, wire shape, turn detection, strip helper, sentinel |
| `server/adapters/toolCalling/OpenAIConverter.js` | Emit `extra_content`; read it back into generic metadata |
| `server/adapters/toolCalling/GoogleConverter.js` | Preserve the signature on every Google conversion path |
| `server/adapters/google.js` | Place signatures on `functionCall` parts; current-turn sentinel fallback |
| `server/adapters/{openai,mistral,vllm}.js` | Strip `extra_content` for non-Gemini targets |
| `tests/unit/server/gemini-thought-signature-roundtrip.test.js` | CI-covered round-trip and guard coverage |
| `server/tests/gemini-thought-signature.test.js` | Detailed adapter-level suite |

## References

- [Gemini API — Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — `agent/transports/chat_completions.py`
- `docs/openai-compatible-api.md` — user-facing contract and troubleshooting
