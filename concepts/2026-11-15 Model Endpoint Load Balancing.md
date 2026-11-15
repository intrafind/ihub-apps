# Model Endpoint Load Balancing

Status: proposal (2026-11-15). Related: sizing guide (`docs/sizing.md`), #3631.

## Why

A model in iHub has one `url`. One GPU with Qwen3.6-35B-A3B serves about 30 busy users (load
tests, RC10), so 1,000 employees need several GPUs, 5,000 need more than fifteen. Today an
operator has to run a load balancer (Kubernetes Service, LiteLLM, vLLM router) in front of the
GPUs and register its address. A plain round-robin balancer also scatters one chat's calls over
all GPUs, so vLLM's prefix cache rarely holds the chat's history.

iHub already sends every chat call through one place (`LLMClient._connect`, inside the model's
throttle slot), so it can pick the endpoint itself.

## Goals

- One model, several endpoints serving the same weights. iHub spreads the calls.
- Calls of one chat stay on one endpoint while it is healthy and not full, so the prefix cache
  keeps its history and system prompt.
- A dead or failing endpoint is skipped within seconds, and the failed call is retried on another
  endpoint.
- Each endpoint has its own concurrency limit (GPUs differ).
- The evidence record and telemetry name the endpoint that answered.

## Non-goals

- Active health probes. Failures of real calls are enough to mark an endpoint down.
- Weights, latency-based routing, or spreading one call's tokens.
- Several endpoints for transcription, TTS and realtime models (they keep `url`). Can follow.
- Different models behind one id (that is model fallback, a separate topic).

## Design

### Config

```jsonc
{
  "id": "qwen3-6-35b",
  "provider": "openai",
  "modelId": "Qwen-Qwen3.6-35B-A3B-FP8",
  "concurrency": 30,                      // per endpoint, unless the endpoint sets its own
  "endpoints": [
    { "url": "https://gpu-01.example/v1/chat/completions" },
    { "url": "https://gpu-02.example/v1/chat/completions", "concurrency": 20, "apiKey": "…" }
  ]
}
```

- `endpoints` is optional and additive; a model has either `url` or `endpoints` (schema refine).
  No migration.
- `apiKey` per endpoint is optional and falls back to the model's key. It is encrypted like the
  model key.
- `${ENV}` references work as in `url`.

### Choosing an endpoint (per call, in `LLMClient`)

1. **Affinity:** rank the healthy endpoints by rendezvous hash of the chat id (the run id for
   calls without a chat). The first is the chat's endpoint. Adding or removing an endpoint moves
   only the chats of that endpoint.
2. **Bounded load:** if the chat's endpoint has all its slots taken and another has a free one,
   take the next free endpoint in the chat's ranking. A popular project is then cached on more
   than one GPU instead of queueing on one.
3. **Health:** a connection error, connect timeout, 5xx or 429 marks the endpoint down for 30 s,
   doubling up to 5 minutes while it keeps failing; a successful call clears it. If every endpoint
   is down, the least recently failed one is tried.
4. **Failover:** a call that failed before the first token is retried on the next endpoint in the
   ranking without spending the transient retry budget (once per endpoint). A failure after the
   first token is not retried elsewhere; it follows today's rules.

The throttle id becomes `<modelId>@<index>`, so the cluster-wide throttle in the primary counts
slots per endpoint. Health state is per worker.

> ponytail: health is per worker; each worker learns of a dead GPU from its own first failure
> (one failed-over call per worker). Share it over the cluster bus if that shows up in practice.

### Visible changes

- Admin model editor: a list of endpoints (URL, optional key and concurrency); "Test" checks each.
- `request/header` in the journal and `calls[].endpoint` in the evidence record: endpoint index
  and host.
- Telemetry: `server.address` per endpoint; metrics for calls, failures and down marks per
  endpoint.
- Model discovery and gateway drift use the first endpoint.

## Plan

1. Schema (`endpoints`, refine), endpoint picker module with tests (affinity, bounded load,
   cooldown, all down), `LLMClient` integration with failover, per-endpoint throttle ids.
2. Journal, evidence, telemetry fields; admin editor; docs (`docs/models.md`, `docs/sizing.md`);
   release note.
3. Load test with two GPUs: capacity vs one GPU, and prefix-cache hit rate with affinity vs
   round robin.

## Acceptance criteria

- With two endpoints, 60 test users get the time-to-first-word one endpoint gives 30.
- Stopping one endpoint during a run: answers in flight on it fail as today, new calls go to the
  other within one failed call per worker, and nothing is lost after the endpoint comes back.
- All calls of one chat go to one endpoint while it is healthy and not full.
- A model with `url` behaves exactly as before.
