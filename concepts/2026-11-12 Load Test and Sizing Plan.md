# Load Test and Sizing Plan

**Status:** prepared, ready to run. The harness is in `tests/load/`; see its README for how to run it.

## 1. What we want to know

1. **Users per worker.** How many concurrently active users one iHub worker process (≈ 1 vCPU) carries while every SLO still holds.
2. **Sizing.** How many workers, vCPU, how much RAM and disk, and how many replicas, for 50, 200, 500 and 1,000 concurrent users. How that maps to named users.
3. **First bottleneck.** CPU, the event loop, filesystem storage, the cross-worker SSE relay, or the LLM.
4. **GPU capacity.** How many concurrent users gpu-01 serves before time to first token (TTFT) degrades, including project chats with large injected context and tool calls.
5. **Ingestion.** Documents per minute per worker, crawl duration, and how much ingestion slows chats running at the same time.
6. **Stability.** Memory and disk growth over hours, spike behaviour and recovery.

## 2. Terms

- **Named user:** has an account.
- **Concurrent active user (= one VU):** has iHub open and interacts. With the default think time (20–60 s between turns, 10–40 s between sessions) a VU sends about one chat turn per minute.
- **Concurrency ratio:** concurrent active users divided by named users at peak. We assume 10% (the usual range is 5–15%). **Calibrate it** from production usage reports (`ihub_active_users`, Admin → Usage): peak concurrent users and turns per user per hour. Then adjust `thinkTimeSec` until turns/min per VU match production.
- **Worker:** one Node process of the iHub cluster (`WORKERS`). Size it at 1 vCPU and 200–400 MB (`docs/scaling.md`).

## 3. Architecture facts that shape the test

These come from reading the code, and the scenarios are built around them.

| Fact | Consequence for the test / sizing | Where |
| --- | --- | --- |
| Workers are a Node cluster with round-robin connections. A chat's SSE stream and its POST can land on different workers; tokens are then relayed through the **primary** over IPC. | The primary can become a single-core bottleneck. Primary CPU is sampled and reported separately. | `docs/scaling.md`, `server/clusterBus.js` |
| Several replicas need **cookie session affinity** and a **shared read-write `contents/` volume**. There is no Redis. | E5 checks "stream misses" (must be 0) and the latency of the shared volume. | `docs/scaling.md` §multi-host |
| Persistence is **filesystem only**. Every turn writes chat, messages, a run ledger and a run summary. Locks wait 5 s, then return `503 LOCK_TIMEOUT`. | Disk/NFS latency is a capacity factor. Run sizing on the **same storage class as production**. | `docs/storage.md` |
| LLM calls queue at `requestConcurrency` = **5 per model**, cluster-wide, unless the model sets `concurrency`. | Left unchanged, iHub itself would be the "GPU limit". Setup gives the test models 100. | `server/requestThrottler.js` |
| Project ingestion runs **2 per worker**, with text extraction on the event loop (no worker threads). The corpus index is an LRU of 32 per process; a rebuild takes about 1–1.5 s per 10 MB and **blocks the event loop**. | Ingestion stalls chats on the same worker. The test checks event-loop peaks, `ingest` (E2) and the number of distinct projects. | `ProjectIngestService.js`, `LocalKnowledgeProvider.js` |
| A project chat injects up to min(50k tokens, **40% of the context window**) and offers the `knowledge_*` tools. | Much bigger prompts (GPU prefill) and extra LLM round trips. The report's "prompt tokens" column measures it. | `KnowledgeScopePlanner.js` |
| A crawl is **synchronous** (≤ 25 s, 4 fetches, one per user per process). Pages are then added as URL items one by one. | Outbound load on the crawled site. It is capped per runner shard. | `siteCrawler.js` |
| Rate limits count per IP **and per worker**. Logins allow 30 per 15 min. The AI-use acknowledgement answers 428 until confirmed. | Must be lifted in the test environment, or the run measures the limiter. `setup.mjs --check` lists them. | `docs/rate-limiting.md` |
| `userProjects` is a preview flag, off by default. When off, a `projectId` on a chat is **ignored without an error**. | Setup enables it. Without it, project chats would be plain chats. | `featureRegistry.js` |

## 4. Workload model

| Scenario | Share | What one session does |
| --- | ---: | --- |
| `chat` | 45% | 2–5 turns of general questions. Answers are capped at "about 120 words". |
| `projectChat` | 30% | 3–6 questions in a project: half the user's own, half shared with the users group (5 shared projects, 6 documents each). |
| `chatFile` | 15% | Upload a document (up to 2.5 MB) into the chat, then 2–4 questions about it. |
| `projectBuild` | 5% | Create a project, upload 3–8 documents, wait for ingestion, crawl 30 pages (depth 2), add 10 as URL items, 2 turns, delete the project. |
| `browse` | 5% | App list, chat history, projects. |

The mix is a starting assumption. Replace it with production ratios once usage reporting provides them; `LT_MIX` overrides it per run.

**Documents.** The generated set covers Markdown, text, HTML, CSV, JSON and real multi-page PDFs, around 12 KB to 2 MB. For E2 and the final sizing runs, use **20–50 typical customer documents** (PDF, DOCX, PPTX, XLSX) via `LT_FIXTURES_DIR`, because Office/PDF extraction dominates ingestion CPU.

**LLM.**

- *Stub* (`loadtest-stub`): 700 ms TTFT, 250 tokens at 40 tokens/s, so streams last about 7 s like a real model. Use it whenever the question is about **iHub**.
- *gpu-01* (`loadtest-gpu`): use it for end-to-end checks and for the GPU's own capacity.
- The stub model is registered with the same context window as the GPU model (32k), so project-context injection is the same size.

## 5. Experiments (run in this order)

| # | Experiment | Profile / settings | Answers | Duration |
| --- | --- | --- | --- | --- |
| E0 | Smoke | `smoke` on every new environment | Setup, auth, SSE, uploads, ingestion, crawl and project chats work. 0 errors. | 5 min |
| E1 | **iHub capacity per worker** | `capacity-stub`; one iHub pod with `WORKERS` = CPU limit = **1, 2, 4** (docker lab: `IHUB_CPUS`/`IHUB_WORKERS`) | Users/worker; scaling efficiency `C(4) / (4 × C(1))`; RSS/worker; primary relay load | 3 × 55 min |
| E2 | Ingestion | `ingest` with real documents; `projects.ingest.concurrency` 2 vs 4; crawl against the stub site | Documents/min/worker; ingest p95; chat TTFT and event-loop peaks while ingesting | 2 × 25 min |
| E3 | **GPU capacity** | `capacity-gpu` (iHub generously sized, e.g. 4 workers); repeat with `LT_MIX=projectChat=100` | Concurrent users per GPU at TTFT p95 < 6 s; prompt-size (prefill) impact; tool-call behaviour | 2 × 40 min |
| E4 | End-to-end acceptance | `capacity-gpu` with `LT_STAGES` = 70% of min(E1, E3), through the **ingress**, 30 min | The planned setup meets the SLOs with real answers | 30 min |
| E5 | Horizontal scaling | 2 replicas × 4 workers, cookie affinity, RWX volume, `capacity-stub` | Linear scaling? Stream misses = 0? Shared-volume lock latency | 55 min |
| E6 | Soak | `soak` at 70% of E1 capacity | RSS slope (leaks), MB per 1,000 turns, retention sweeps, session expiry | 4 h |
| E7 | Spike | `spike` (20 → 200 in 30 s) | Queueing and errors at the peak, recovery time | 15 min |

That is about 1.5 days of run time. E1 and E3 are independent and can run on different days.

## 6. SLOs (a load level passes when all hold during its hold phase)

| SLO | Stub runs | GPU runs | Why |
| --- | --- | --- | --- |
| iHub overhead on TTFT, p95 (TTFT minus stub TTFT) | ≤ 1,500 ms | – | What iHub adds before the first token |
| TTFT p95 | – | ≤ 6,000 ms | User-perceived wait with the real model |
| Non-LLM API p95 (`browse`) | ≤ 500 ms | ≤ 500 ms | UI responsiveness |
| Failed turns | ≤ 1% | ≤ 2% | |
| HTTP errors | ≤ 2% | ≤ 2% | |
| Worker CPU, average | ≤ 80% | ≤ 80% | Headroom for GC and peaks |
| Event-loop delay, p95 of per-interval peaks | ≤ 150 ms | ≤ 150 ms | Stalls hit every user on that worker |
| Document ready (ingestion), p95 | ≤ 180 s | ≤ 180 s | |

The capacity of a run is the **largest level before the first failing one**. The report names the failed SLO and a likely bottleneck, for example: CPU-bound → more workers; event-loop stalls at low CPU → blocking work; 503 → storage; primary near 100% → more replicas with fewer workers; TTFT rising at low CPU → LLM queue or upstream. If no level fails, the report gives a CPU-extrapolated estimate and labels it as unmeasured.

## 7. Sizing method

From E1 (at the planned pod shape, normally 4 workers), E3 and E6:

- `u` = capacity / workers: **concurrent users per worker**.
- workers = ⌈T / (u × 0.7)⌉ for T concurrent users (70% target utilisation).
- vCPU per pod = workers per pod, +1 for the primary/relay and the OS when there are more than 4 workers.
- RAM per pod = workers × RSS p95 per worker × 1.3 + primary + 1 GiB.
- replicas = ⌈workers / workers per pod⌉, at least 2 for availability. That requires affinity and an RWX volume, so validate it with E5.
- disk = MB per 1,000 turns (E6) × turns per day × retention days, plus project blobs (size of uploaded text).
- GPUs = ⌈T / G⌉, where G = concurrent users per GPU from E3 at the planned project-chat share.

`report.mjs --target T` computes the iHub part. The final deliverable is this table:

| Concurrent users | Named users (at 10%) | iHub workers | vCPU | RAM | Replicas | GPUs (gpu-01 class) | Disk / month |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 500 | | | | | | |
| 200 | 2,000 | | | | | | |
| 500 | 5,000 | | | | | | |
| 1,000 | 10,000 | | | | | | |

## 8. First observations from validating the harness (not sizing data)

The harness was checked end to end in a small sandbox: 2 workers on 4 shared vCPU, the stub LLM, up to 16 VUs with aggressive 2–5 s think times, and 2 runner shards merged from their logs. All scenarios passed with no errors.

- iHub's TTFT overhead was about 120–200 ms p95.
- Project-chat prompts were about 7.3k tokens with a 32k context window. They were about 61k tokens when the model declared 128k, so **the context window of the GPU model directly drives GPU prefill load in project chats**.
- Event-loop peaks reached about 0.8 s while projects were being built, consistent with extraction on the event loop. E2 should quantify this.

## 9. Risks and how we handle them

- **intrafind.com is our production website.** It is a single Apache/Drupal server, and pages are served uncached in about 0.6 s. Mitigations:
  - At most 2 concurrent crawls per runner shard (`LT_CRAWL_MAX_CONCURRENT`), 30 pages each.
  - Inform the web team and run outside business hours.
  - E2 and repeated runs use the stub site.
  - Note that iHub's page cache is per process, so it does not shield the website.
- **gpu-01 is shared.** Agree a time window with its users. E3 numbers describe the GPU, not iHub. Confirm the served model, its context window and whether vLLM runs with `--enable-auto-tool-choice`; otherwise set `LT_LLM_SUPPORTS_TOOLS=none`.
- **The runner can be the bottleneck.** Runner CPU and event-loop delay are sampled and the report flags saturation. In the cluster, run 4+ shards spread over nodes.
- **Measuring through the ingress or the Service.** The Service measures iHub alone (E1, E2). The ingress measures what users get, including TLS, affinity and buffering (E4, E5).
- **Data pollution.** Use a dedicated instance or namespace with its own contents volume. `teardown.mjs` removes chats, projects and users.
- **Session expiry in long runs.** The runner logs in again on 401 (session lifetime 8 h).

## 10. Preparation checklist

- [ ] Dedicated iHub instance in the cluster: production-like storage class, CPU limit = `WORKERS`, environment from `tests/load/k8s/ihub-env.example.yaml`.
- [ ] gpu-01 reachable from the iHub pods (TLS whitelist). Model name, context window and tool calling confirmed; `setup.mjs` discovery succeeds.
- [ ] Runner image built and pushed (`tests/load/Dockerfile`). Namespace `ihub-loadtest` and Secret created.
- [ ] Optional: Prometheus scraping iHub on :9464 (telemetry on), for per-replica numbers in E5.
- [ ] 20–50 representative customer documents for `LT_FIXTURES_DIR`.
- [ ] Web team (intrafind.com) and GPU users informed; time windows agreed.
- [ ] Production usage numbers for calibration: peak concurrent users, turns per user per hour, uploads per day, project usage share.

## 11. Open questions

1. Which user numbers should the sizing table target (named and concurrent), and which pod shape do we prefer (workers per replica)?
2. Which model and context window does gpu-01 serve, and how many GPUs of that class can we plan with?
3. Which storage class backs `contents/` in the cluster (local disk vs NFS/RWX)? It decides whether multi-replica is viable.
