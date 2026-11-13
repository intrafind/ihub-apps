# Load Test and Sizing Plan

**Status:** first run done in a laptop lab (2026-11-12/13); results in section 12 and in [#3631](https://github.com/intrafind/ihub-apps/issues/3631#issuecomment-6847499731). E1 and E2 repeated on 5.7.0-RC9 with the event-loop fixes (2026-11-13), section 13. Cluster runs are open. The harness is in `tests/load/`; see its README for how to run it.

## 1. What we want to know

1. **Where it breaks.** The highest number of concurrently active users that iHub (one replica, scaled by workers) and gpu-01 carry while every SLO holds. The capacity runs keep raising the load until an SLO breaks, so there is no fixed upper bound.
2. **Users per worker, and where adding workers stops helping.** One replica scales by `WORKERS`. The primary process relays the SSE tokens of every chat whose stream sits on another worker, so at some worker count more workers add nothing.
3. **Sizing.** Workers, vCPU, RAM and disk for one pod, plus GPU capacity, for growing user counts. How that maps to named users.
4. **First bottleneck.** CPU, the event loop (document extraction), filesystem storage, the primary's relay, or the GPU.
5. **GPU capacity.** Concurrent users on gpu-01 (Qwen3.6-35B-A3B-FP8) before TTFT degrades: real tool calls, thinking tokens, and up to 50k tokens of project context per turn.
6. **Ingestion.** Documents per minute per worker for realistic Office/PDF files, crawl duration, and how ingestion slows chats running at the same time.
7. **Rate limits.** Do the shipped limits fit real usage, especially many users behind one corporate IP? Which values should change?
8. **Stability.** Memory and disk growth over hours, spike behaviour and recovery.

## 2. Terms

- **Named user:** has an account.
- **Concurrent active user (= one VU):** has iHub open and interacts. With the default think time (20–60 s between turns, 10–40 s between sessions) a VU sends about one chat turn per minute.
- **Concurrency ratio:** concurrent active users divided by named users at peak. We assume 10% (the usual range is 5–15%). **Calibrate it** from production usage (`ihub_active_users`, Admin → Usage): peak concurrent users and turns per user per hour. Then adjust `thinkTimeSec` until turns/min per VU match production.
- **Worker:** one Node process of the iHub cluster (`WORKERS`), about 1 vCPU. The pod's CPU limit is `WORKERS` + 1, because the primary needs a core of its own.

## 3. Facts that shape the test

These come from the code and from the target environment.

| Fact | Consequence for the test / sizing | Where |
| --- | --- | --- |
| **One replica, scaled by workers.** Workers are a Node cluster with round-robin connections. A chat's SSE stream and its POST can land on different workers; with N workers, about (N−1)/N of all tokens are relayed through the **primary** over IPC. | The primary is a single-core ceiling for the whole pod. The worker sweep (E1) finds the worker count where capacity stops growing. Primary CPU is reported separately. | `docs/scaling.md`, `server/clusterBus.js` |
| `STICKY_SESSIONS=true` switches to routing by client address. | Keep it off during tests: every VU of a runner shares one IP and would be pinned to one worker. | `server/server.js` |
| Persistence is **filesystem only**. Every turn writes chat, messages, a run ledger and a run summary. Locks wait 5 s, then return `503 LOCK_TIMEOUT`. | Disk latency is a capacity factor. Run on the **same storage class as production**. | `docs/storage.md` |
| LLM calls queue at `requestConcurrency` = **5 per model**, cluster-wide, unless the model sets `concurrency`. | Left unchanged, iHub itself would be the "GPU limit". Setup gives the test models 100. | `server/requestThrottler.js` |
| **gpu-01** serves `Qwen/Qwen3.6-35B-A3B-FP8` on vLLM with a 173,184-token context window. Tool calling is on. It is a thinking model. | The first token may be thinking, so the report shows both the first token and the first visible answer text. `LT_THINKING=on/off` compares the two modes. Setup gives the model 4,096 output tokens so thinking does not cut answers short. | discovery via `/v1/models` |
| A project chat injects up to min(`loadAllMaxTokens` = 50k, **40% of the context window** = 69k) tokens and offers the `knowledge_*` tools. | With gpu-01's window, a project chat sends **~50–60k prompt tokens per turn**. GPU prefill, not decoding, will decide GPU capacity. The stub model uses the same window, so stub runs see the same prompts. | `KnowledgeScopePlanner.js` |
| Project ingestion runs **2 per worker**, with text extraction **on the event loop**. The corpus index (LRU of 32 per process) rebuilds in about 1–1.5 s per 10 MB, also blocking. | Ingestion stalls every chat on that worker. The report shows event-loop peaks; E2 measures them with realistic documents. | `ProjectIngestService.js`, `LocalKnowledgeProvider.js` |
| A crawl is **synchronous** (≤ 25 s, 4 fetches, one per user per process). Pages are then added as URL items one by one. | Outbound load on the crawled site, capped per runner shard. | `siteCrawler.js` |
| Rate limits count **per client IP**. `publicApi`, `adminApi` and `inferenceApi` count per worker; `authApi` (credential POSTs only, OIDC exempt) and `oauthApi` count cluster-wide. Behind a proxy that `trustProxy` does not cover, every user shares the proxy's counter. | Lifted for capacity runs. E5 measures real demand against the shipped values. | `server/middleware/rateLimiting.js`, `docs/rate-limiting.md` |
| The AI-use acknowledgement answers 428 until confirmed. `userProjects` is a preview flag, off by default; while off, a `projectId` on a chat is **ignored without an error**. | Setup confirms or disables the first and enables the second. | `featureRegistry.js` |

## 4. Workload model

| Scenario | Share | What one session does |
| --- | ---: | --- |
| `chat` | 45% | 2–5 turns of general questions. Answers are capped at "about 120 words". |
| `projectChat` | 30% | 3–6 questions in a project: the user's own project (first 200 users) or one of 20 projects shared with the users group, 6 documents each. |
| `chatFile` | 15% | Upload a document (up to 10 MB, scans included) into the chat, then 2–4 questions about it. |
| `projectBuild` | 5% | Create a project, upload 3–8 documents (up to 12 MB), wait for ingestion, crawl 30 pages, add 10 as URL items, 2 turns, delete the project. |
| `browse` | 5% | App list, chat history, projects. |

Additionally, 30% of sessions start with a **page load**: auth status, configs, translations, styles, apps, models, prompts and the AI notice, as the SPA fetches them. This keeps the per-user request rate close to a browser's, which the rate-limit analysis depends on.

The mix is a starting assumption. Replace it with production ratios once usage reporting provides them; `LT_MIX` overrides it per run.

**Documents.** `npm run loadtest:corpus` generates 42 realistic files (80 MB) with the server's own libraries:

- Word files: handbooks of 40 pages with tables and images.
- PowerPoint decks of 16–40 slides with images and speaker notes.
- Excel workbooks with up to 30,000 rows and formulas.
- PDFs of 12–250 pages with drawn tables and images.
- One scanned PDF without a text layer.

iHub extracts each of them in 50 ms to 1.6 s, synchronously on the event loop. `LT_FIXTURES_DIR` replaces the corpus with customer documents if we get some.

**LLM.**

- *Stub* (`loadtest-stub`): 700 ms TTFT, 250 tokens at 40 tokens/s, so streams last about 7 s like a real model. It has the same context window as gpu-01. Use it whenever the question is about **iHub**.
- *gpu-01* (`loadtest-gpu`): use it for end-to-end checks and for the GPU's own capacity. Its vLLM metrics (running and waiting requests, KV cache, tokens/s, preemptions) are sampled during the run.

## 5. Experiments (run in this order)

| # | Experiment | Profile / settings | Answers | Duration |
| --- | --- | --- | --- | --- |
| E0 | Smoke | `smoke` on every new environment | Setup, auth, SSE, uploads, ingestion, crawl and project chats work. 0 errors. | 5 min |
| E1 | **iHub capacity per worker, worker sweep** | `capacity-stub` (open-ended, 25 → 2,000 VUs, stops at the first failing level); the iHub pod with `WORKERS` = **1, 2, 4, 8, 12** and CPU limit = WORKERS + 1 | Users per worker at each worker count; the worker count where capacity stops growing (primary relay); RSS per worker | 5 × up to 85 min |
| E2 | Ingestion | `ingest` with the corpus; `projects.ingest.concurrency` 2 vs 4; crawl against the stub site | Documents/min/worker; ingest p95; chat TTFT and event-loop peaks while ingesting | 2 × 25 min |
| E3 | **GPU capacity** | `capacity-gpu` (open-ended, 5 → 300 VUs), iHub at a generous worker count. Variants: `LT_THINKING=off`; `LT_MIX=projectChat=100`; `IHUB_PLATFORM__PROJECTS__LOAD_ALL_MAX_TOKENS=16000` | Concurrent users on gpu-01 at TTFT p95 < 6 s; the cost of thinking and of project context (prefill); whether capping injected context buys capacity | 4 × up to 60 min |
| E4 | End-to-end acceptance | `capacity-gpu` with `LT_STAGES` = 70% of min(E1, E3), through the **ingress**, 30 min | The planned setup meets the SLOs with real answers | 30 min |
| E5 | **Rate limits** | `ratelimits` against the **shipped default limits** (only `authApi` lifted so the runner can log in), from one runner IP | Per-user demand per limiter at realistic think times; the user count behind one IP where 429s start; recommended values | 25 min |
| E6 | Soak | `soak` at 70% of E1 capacity | RSS slope (leaks), MB per 1,000 turns, retention sweeps, session expiry | 4 h |
| E7 | Spike | `spike` (20 → 200 in 30 s) | Queueing and errors at the peak, recovery time | 15 min |

That is about two days of run time. E1 and E3 are independent and can run on different days.

## 6. SLOs (a load level passes when all hold during its hold phase)

| SLO | Stub runs | GPU runs | Why |
| --- | --- | --- | --- |
| iHub overhead on TTFT, p95 (TTFT minus stub TTFT) | ≤ 1,500 ms | – | What iHub adds before the first token |
| Answer TTFT p95 | – | ≤ 6,000 ms | User-perceived wait with the real model |
| Non-LLM API p95 (`browse`) | ≤ 500 ms | ≤ 500 ms | UI responsiveness |
| Failed turns | ≤ 1% | ≤ 2% | |
| HTTP errors | ≤ 2% | ≤ 2% | |
| Worker CPU, average | ≤ 80% | ≤ 80% | Headroom for GC and peaks |
| Event-loop delay, p95 of per-interval peaks | ≤ 150 ms | ≤ 150 ms | Stalls hit every user on that worker |
| Document ready (ingestion), p95 | ≤ 180 s | ≤ 180 s | |

The capacity of a run is the **largest level before the first failing one**. Open-ended runs stop there. The report names the failed SLO and a likely bottleneck:

| Symptom | Likely bottleneck |
| --- | --- |
| Workers CPU-bound | Too few workers |
| CPU throttling | Pod CPU limit below `WORKERS` |
| Event-loop stalls at low CPU | Blocking work, e.g. extraction |
| Primary near 100% | The primary's relay; more workers will not help |
| 503 errors | Storage |
| vLLM waiting or KV cache near 100% | The GPU |
| 429 errors | Rate limits |

If no level fails, the report gives a CPU-extrapolated estimate and labels it as unmeasured.

## 7. Sizing method (one replica)

From E1, E3 and E6:

- `u(W)` = capacity at W workers / W: **concurrent users per worker** at that worker count.
- `W_max` = the largest worker count where `u(W)` stays within about 80% of `u(1)`. Above it, the primary's relay caps the pod.
- workers = ⌈T / (u × 0.7)⌉ for T concurrent users (70% target utilisation), as long as that is ≤ `W_max`. Beyond `W_max`, one replica cannot carry T, and a second replica would need a shared RWX `contents/` volume and cookie affinity.
- vCPU = workers + 1. RAM = workers × RSS p95 per worker × 1.3 + primary + 1 GiB.
- disk = MB per 1,000 turns (E6) × turns per day × retention days, plus project blobs.
- GPUs = ⌈T / G⌉, where G = concurrent users per gpu-01 from E3 at the planned project-chat share and thinking setting.

`report.mjs --target T` computes the iHub part. The final deliverable fills this table up to the limits found:

| Concurrent users | Named users (at 10%) | WORKERS | vCPU | RAM | gpu-01-class GPUs | Disk / month | Fits one replica? |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 1,000 | | | | | | |
| 250 | 2,500 | | | | | | |
| 500 | 5,000 | | | | | | |
| 1,000 | 10,000 | | | | | | |
| 2,000 | 20,000 | | | | | | |
| *max found* | | | | | | | |

**Rate limits (E5)** produce their own table: demand per user per limiter, users per IP before a 429, and the recommended `limit` per limiter. They also check that `trustProxy` matches the ingress hops, without which every user shares one counter.

## 8. First observations from validating the harness (not sizing data)

The harness was checked end to end in a sandbox: 2 workers on 4 shared vCPU, the stub LLM, up to 30 VUs with aggressive 2–6 s think times, 2 runner shards merged from their logs, and fake vLLM and Prometheus endpoints. All scenarios, open-ended stopping and the rate-limit accounting worked.

- iHub's TTFT overhead was about 120–250 ms p95.
- **Project-chat prompts reached about 51–61k tokens with gpu-01's 173k window** (about 7k with a 32k window). Project chats will dominate GPU prefill; E3's variant with `loadAllMaxTokens` = 16k shows how much capacity a lower cap buys.
- Extraction of a single realistic file blocks a worker for 50 ms to 1.6 s (largest spreadsheet 1.6 s, 250-page PDF 1.1 s, 40-page Word handbook 0.4–0.8 s). Event-loop peaks of 0.2–0.8 s appeared as soon as uploads were in the mix. This is the most likely early bottleneck after CPU; E2 quantifies it.
- With a deliberately low `publicApi` limit (200/min), 30 users from one IP were throttled (761 × 429). The report correctly flagged it and recommended a higher value.

## 9. Risks and how we handle them

- **intrafind.com is our production website.** It is a single Apache/Drupal server, and pages are served uncached in about 0.6 s. Mitigations:
  - At most 2 concurrent crawls per runner shard (`LT_CRAWL_MAX_CONCURRENT`), 30 pages each.
  - Inform the web team and run outside business hours.
  - E2 and repeated runs use the stub site.
- **gpu-01 is shared.** Agree a time window with its users. E3 numbers describe the GPU, not iHub.
- **The runner can be the bottleneck.** Runner CPU and event-loop delay are sampled and the report flags saturation. In the cluster, run 8 shards spread over nodes for runs up to 2,000 VUs.
- **Measuring through the ingress or the Service.** The Service measures iHub alone (E1, E2). The ingress measures what users get, including TLS and buffering (E4, E5).
- **Data pollution.** Use a dedicated instance or namespace with its own contents volume. `teardown.mjs` removes chats, projects and users.
- **Session expiry in long runs.** The runner logs in again on 401 (session lifetime 8 h).

## 10. Preparation checklist

- [ ] Dedicated iHub instance (one replica) in the cluster: production-like storage class, CPU limit = `WORKERS` + 1, environment from `tests/load/k8s/ihub-env.example.yaml`.
- [ ] gpu-01 reachable from the iHub pod (TLS whitelist); `setup.mjs` discovery succeeds (`Qwen/Qwen3.6-35B-A3B-FP8`, 173k).
- [ ] `npm run loadtest:corpus`, then the runner image built and pushed (`tests/load/Dockerfile`). Namespace `ihub-loadtest` and Secret created.
- [ ] Grafana/Prometheus: the Prometheus datasource proxy URL plus a Viewer service-account token (`LT_PROM_URL`, `LT_PROM_TOKEN`), the iHub namespace and pod name pattern, and the DCGM label that selects gpu-01 (`LT_PROM_GPU_SELECTOR`).
- [ ] Web team (intrafind.com) and GPU users informed; time windows agreed.
- [ ] Production usage numbers for calibration: peak concurrent users, turns per user per hour, uploads per day, project usage share, and requests per user per minute from the access log (rate limits).

## 11. Open questions

1. Does the DCGM exporter run on the gpu-01 node, and under which label? Without it the GPU section shows vLLM's view only (queueing, KV cache, tokens/s), which is enough to find the GPU limit, but not GPU utilisation.
2. Is `trustProxy` set to the number of proxy hops in front of iHub? If not, every user shares one rate-limit counter today, regardless of the limit values.

## 12. Results of the first lab run (2026-11-12/13)

**Lab:** Docker Desktop on a laptop (8 CPUs; iHub ≤ 5 vCPU and 4 GiB), with the stub LLM for E1, E2, E5 and E7, and gpu-01 for E3. E4 and E6 were not run. The full write-up, every report and the run log are in [#3631](https://github.com/intrafind/ihub-apps/issues/3631#issuecomment-6847499731).

| Experiment | Result |
| --- | --- |
| E1 worker sweep | 100 / 150 / 150 users at W = 1 / 2 / 4. Every run broke on the event-loop SLO at 16–48 % worker CPU. The primary's relay is not the limit (≤ 8 % CPU). W_max = 1 by the 80 % rule, but the cause is blocking work, not the relay |
| E2 ingestion | Never queued (ready in 3.4 s at p95, up to 87 files/min/worker offered), but extraction breaks the event-loop SLO from 5 users. Concurrency 2 vs 4: no difference |
| E3 GPU | Default mix: 10 users; project chats only: 30 (50k and 16k cap alike). Large prompts are prefill-bound at ~8.4k prompt tok/s. The KV cache holds 174k tokens. Thinking: 18–41 s to the first answer token; queueing from 10–20 users |
| E5 rate limits | `publicApi` 500/min counts per worker: no 429 for 300 users behind one IP at W=4, but only ~90 at W=1 |
| E7 spike | 20 → 200 → 20 users with no errors and immediate recovery (a mix without project builds) |

**What we learned beyond the plan:**

- **Section 3 overestimated two things.** The primary's relay never became the limit. Project-chat prompts stayed at ~14k tokens, because every test project exceeds the 50k load-all budget and falls back to excerpts.
- **The first bottleneck is synchronous work on the event loop.** Excel extraction (up to ~1 s), Word extraction, scanned-PDF rendering and index rebuilds all block it. Follow-ups: [Event-Loop Blocking and Project Index Caching](2026-11-12%20Event-Loop%20Blocking%20and%20Project%20Index%20Caching.md), #3648–#3652.
- **The harness's GPU model needed `thinking.enabled`** for `LT_THINKING` to have any effect; fixed in `setup.mjs`.

**Next:** repeat E1–E3 in the cluster on the production storage class with a concurrency-tuned vLLM, then E4 and E6. Repeat E1 after the event-loop fixes.

## 13. Re-run on 5.7.0-RC9: did the event-loop fixes help? (2026-11-13)

RC9 contains #3653 (metrics), #3654 (Excel row limit), #3655 (configurable caches), #3656 (extraction in a worker thread) and #3660/#3661 (jsdom replaced). The one-index-per-pod change, #3651, is still open. Same lab, mix, SLOs, data volume and runner as section 12. The image was built locally from tag `v5.7.0-RC9`, because GHCR publishes amd64 only. Two changes to the setup:

- **Docker Desktop at 12 CPUs** (was 8), so W=6 and W=8 fit. Every iHub container stays capped at W+1 vCPU, so W=1–4 compare with section 12.
- **Stop-on-failure off.** Every stage is recorded, so the capacity can be read at the plan's 150 ms event-loop SLO and at 200 ms.

E3 (GPU), E5 (rate limits) and E7 (spike) were not repeated; RC9 does not change them.

### Event-loop stalls per file (host, Node 26)

| Format | RC8, on the event loop | RC9 code, on the event loop | RC9 default, in the thread |
| --- | ---: | ---: | ---: |
| Excel, 30k rows | 728 ms | 192 ms | 1 ms |
| Excel, 2k rows | 106–135 ms | 92–139 ms | ≤ 1 ms |
| Word, 40 pages | 71–110 ms | 39–65 ms | ≤ 1 ms |
| PowerPoint | 9–30 ms | 8–26 ms | ≤ 3 ms |
| PDF (pdf.js) | 3–17 ms | 2–14 ms | ≤ 1 ms |

Index rebuilds (48 ms average, up to 201 ms) still run on the event loop. At W=1, the 32-entry index cache hit only 52 % of lookups across 220 projects.

### E1: worker scaling (stub LLM, `capacity-stub`)

| W | vCPU | Memory | RC8 capacity | RC9 at 150 ms | RC9 at 200 ms | Breaks on | Worker CPU avg at capacity | RSS per worker |
| ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | 4 GiB | 100 | **150** | ≥ 200¹ | event loop 180 ms at 200 | 41 % | 1.7 GB |
| 2 | 3 | 4 GiB | 150 | **~500**² | ~500 | CPU 98 % at 650 | 52 % | 1.45 GB |
| 4 | 5 | 4 GiB | 150 | **650** | 800 | event loop 186 ms at 800 | 41 % | 1.07 GB |
| 6 | 7 | 10 GiB | – | **800** | 800 | event loop 206 ms, overhead 485 ms at 1,000 | 48 % | 1.49 GB |
| 8 | 9 | 10 GiB | – | 500 | 650 | event loop 186 ms at 650; collapse at 1,250 | 28 % | 1.31 GB |

¹ The W=1 run still stopped at its first break.
² Warm, stepped load passed 500 users with an event-loop peak of 84 ms. A cold jump from 0 to 500 users in 4 minutes failed at 206 ms.

- **Capacity scales with workers again, up to W=6.** At W=2–4 the same pod carries 3–4× the users of RC8. Answers did not slow down: TTFT p95 was 0.90–0.97 s and overhead p95 195–275 ms in every passing stage, as at RC8's 100 users. API p95 stayed ≤ 61 ms. There were 0 errors up to 1,000 users.
- **The limit is now CPU, then the event loop.** At W=2, CPU ran out at 650 users. At W=4 and W=6, the event-loop peak crossed 150 ms at 41–48 % average worker CPU. That is index rebuilds and garbage collection, not extraction.
- **W=8 is worse than W=6 in this lab.** 9 vCPU for iHub, 8 extraction threads, 2 runner shards and the stubs shared 12 host cores. The event-loop peak was already 95 ms at 100 users, against 72 ms at W=4. The primary used 22 % CPU at 500 users, against ~4 % at W=4. Whether W=8 helps on dedicated nodes is open.
- **Memory:** about 1.0–1.1 GB of RSS per worker in a 4 GiB pod, and 1.3–1.5 GB with more room. Only ~350–460 MB of that is JS heap; the rest is mostly the extraction thread. At W=4, the 4 GiB pod ran at 3.95 GiB from 300 users up, without being killed. #3673.
- **Stream misses** (answers delivered without streaming) appear above ~500 users and grow with workers: W=6 had 38 at 800 users (0.7 %), W=8 had 16 at 500 users and 463 at 1,250 (6.5 %). RC8 never ran above 200 users, so it is not known whether this is new. #3674.

### E2: ingestion (`ingest` mix: 70 % project build, 30 % chat upload)

| Setup | RC8 capacity (event loop ≤ 300 ms) | RC9 capacity | First failure | Overhead p95 at 20 users | Ingest ready p95 at 20 users |
| --- | ---: | ---: | --- | ---: | ---: |
| W=4, 5 vCPU, `ingest.concurrency` 2 | 2 | **20** | CPU 91 % at 40 | 276 ms (RC8: 548) | 2.8 s |
| W=4, 5 vCPU, `ingest.concurrency` 4 | 2 | **20** | CPU 93 % at 40 | 304 ms (RC8: 550) | 2.9 s |
| W=4, 8 vCPU, 1 extraction thread per worker | – | **40**³ | CPU 143 % at 80 | 281 ms | 2.8 s |
| W=4, 8 vCPU, 2 extraction threads per worker | – | **20** | CPU 114 %, event loop 264 ms at 40 | 353 ms | 2.9 s |

³ At 80 users the only failing check was per-worker CPU (143 % ≈ 5.7 of 8 cores). That check counts the extraction thread against one core (#3675). The event loop (242 ms) and overhead (666 ms) passed.

- **10× the ingestion load** before an SLO breaks, and the failure is now CPU, the real cost of reading files, instead of event-loop stalls.
- **`ingest.concurrency` 2 vs 4 changes nothing:** both queue in front of the same thread.
- **A second thread per worker is worse:** ingestion is no faster (ready p95 at 40 users 3.6 s, against 2.9 s), while the event-loop peak, TTFT overhead and RSS (+150–480 MB per worker) all rise. Both settings were therefore removed: every process reads one file at a time, and more workers read more (#3671).
- **Chat uploads** wait for the same thread: p95 0.7 s at 20 users, 1.7–3.4 s at 80.

### Sizing update (replaces the iHub rows of section 7's table from this lab)

- **Per replica:** 70 % of the measured capacity, so ≈ 450 concurrent users at W=4 / 5 vCPU / 4 GiB, and ≈ 560 at W=6 / 7 vCPU. Section 12 gave ≈ 105. More than ~500 users per replica still needs more than one replica, or the cluster sweep to confirm W=6–8 on dedicated nodes.
- **RAM:** plan **1.1 GB per worker + 0.2 GB primary + 1 GiB headroom**: 6 GiB for W=4, 8–9 GiB for W=6. Not the 768 MB that worker sizing assumes today (#3673).
- **GPU:** unchanged from section 12. At 10 users per gpu-01 in the mixed workload, the GPU, not iHub, is the limit by a factor of ~50.

### Open

1. #3651: one project index per pod. Index rebuilds are now the largest remaining event-loop stalls.
2. #3673: worker sizing does not count the extraction thread's memory.
3. #3674: stream misses with more workers.
4. #3675: the load test's CPU SLO counts the extraction thread against one core.
5. Cluster runs: E1 at W=4/6/8/12 on dedicated nodes, then E3 with a tuned vLLM, E4 through the ingress and the E6 soak.
