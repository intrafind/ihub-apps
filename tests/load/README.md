# iHub load test and sizing harness

Simulates real users. They chat with a real or fake LLM, upload documents into chats, build projects (upload, ingestion, website crawl) and run multi-turn chats inside projects. Alongside that, the harness samples the server's CPU, memory, event loop and disk, the LLM server's queue (vLLM metrics) and, optionally, GPU and pod metrics from Prometheus. The output is a report that answers:

- How many concurrent users one worker carries.
- Where the load breaks it, and which resource gives out first.
- How many workers, vCPU and how much RAM a target needs.
- Whether the rate limits fit real usage.

The test plan, the sizing method and what we expect to find are in [`concepts/2026-11-12 Load Test and Sizing Plan.md`](../../concepts/2026-11-12%20Load%20Test%20and%20Sizing%20Plan.md).

The harness is plain Node 20+ with no dependencies. It runs the same way on a laptop and as a Kubernetes Job.

| File                        | What it is                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.mjs`                 | Prepares an instance (idempotent): preflight checks, the `userProjects` flag, models `loadtest-gpu` / `loadtest-stub`, users `lt-0001…`, and "LT-chat" projects with documents                                                                        |
| `run.mjs`                   | The load generator: one shard per process                                                                                                                                                                                                             |
| `report.mjs`                | Merges shard results and writes `report.md`, `summary.json` and `timeline.csv`                                                                                                                                                                        |
| `teardown.mjs`              | Deletes test chats and projects (with `--delete-users`, also the users)                                                                                                                                                                               |
| `stub/server.mjs`           | Paced fake LLM (OpenAI-compatible, with vLLM-style `/metrics`) and a synthetic website for crawls. Calls a tool when a message asks for it (`lib/stubTools.mjs`)                                                                                      |
| `local-smoke.mjs`           | A load smoke on one machine with a verdict: starts the fake LLM and an iHub server, runs `smoke` and `agentic`, fails when a scenario did not work (`npm run loadtest:smoke`)                                                                         |
| `compare.mjs`               | Time to first token of two commits back to back on one machine against the fake LLM: five repetitions each, alternating order, medians; fails when the head is more than 10 % slower, reports a release gate when the base runs spread more than 10 % |
| `tools/generate-corpus.mjs` | Generates 42 realistic Word, PowerPoint, Excel and PDF files (`npm run loadtest:corpus`)                                                                                                                                                              |
| `profiles/*.json`           | One per experiment: `smoke`, `agentic`, `capacity-stub`, `company`, `capacity-gpu`, `ingest`, `ratelimits`, `soak`, `spike`                                                                                                                           |
| `docker-compose.yml`        | Local sizing lab: iHub with a fixed CPU/RAM budget, plus the stubs                                                                                                                                                                                    |
| `k8s/`                      | Stubs, optional iHub under test and snapshot pod, setup Job, Indexed runner Job, `run.sh` (one run end to end), `collect.sh`                                                                                                                          |

## What a virtual user does

A VU is one **concurrently active** user. It loops over sessions, picked by the profile's `mix`. It waits `thinkTimeSec` between turns and `sessionPauseSec` between sessions.

| Scenario       | Flow                                                                                                                                             | Main load                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `chat`         | SSE `GET /api/apps/{app}/chat/{id}` held open, then 2–5 × `POST` one message                                                                     | LLM, SSE relay, chat persistence                                                   |
| `chatFile`     | `POST /api/chats/{id}/files` (multipart), then a turn with `fileIds`, then follow-ups                                                            | text extraction, file store, larger prompts                                        |
| `projectChat`  | 3–6 turns with `projectId` in an own or shared LT-chat project                                                                                   | project text injection (BM25/whole corpus), knowledge tools, decryption            |
| `projectBuild` | create a project → upload 3–8 files → poll until `ready` → crawl a site → add 10 pages as URL items → 2 chat turns → delete                      | ingestion queue, CPU-bound extraction, outbound fetches                            |
| `browse`       | app list, chat history, project list                                                                                                             | non-LLM API latency                                                                |
| page load      | before 30% of sessions: auth status, configs, translations, styles, apps, models, prompts, AI notice                                             | the per-user request rate a browser produces (rate limits)                         |
| `inference`    | `/api/inference/v1/chat/completions`, streamed                                                                                                   | pure LLM path (off by default)                                                     |
| `agentTurn`    | 2–4 turns in the app `loadtest-agent`, each with 1–3 tool rounds: the model calls `list_scheduled_tasks`, iHub runs it and calls the model again | several model calls and tool calls per message (off by default; profile `agentic`) |

### Workload mixes

| Profile         | chat | projectChat | chatFile | projectBuild | browse | Project chats                                                       |
| --------------- | ---: | ----------: | -------: | -----------: | -----: | ------------------------------------------------------------------- |
| `capacity-stub` |  45% |         30% |      15% |           5% |     5% | half in the user's own project, half spread over 20 shared projects |
| `company`       |  55% |         25% |      10% |           2% |     8% | 80% shared, and 60% of those in one project (`shared-1`)            |

`capacity-stub` is a heavy, project-centric workload: every third session reads a project and one in twenty builds one. `company` is closer to a typical installation: most people chat, a few upload a document, very few build projects, and most project questions go to one popular project such as a website chatbot or the company handbook. The mix is per session, not per user, so 10% `chatFile` means one session in ten uploads a file.

Measured per turn:

- **TTFT**: time to the first visible answer token after the POST.
- **First token**: time to the first token of any kind, thinking included (Qwen3 thinks first).
- **Turn duration.**
- **Answer speed.**
- **Prompt tokens**: shows how much project context was injected.
- **Tool calls.**
- **Stream misses**: a POST that reached a replica without the SSE stream, which means the ingress lacks affinity.
- **Error codes.**

Resource samples come from `GET /api/admin/system/resources` every 5 s. They cover CPU %, RSS, heap and event-loop delay for every worker and for the primary, plus host CPU/RAM and the data volume.

Every request is also classified by the rate limiter it counts against, and counted per user and per runner IP per minute. That feeds the report's rate-limit section.

### Turns with tool rounds

A message to an agent is not one model call. The model asks for a tool, iHub runs it and calls the model again with the result, and this repeats until the model answers. The `agentTurn` scenario produces that load, and the profile `agentic` runs nothing else:

```bash
LT_BASE_URL=http://localhost:3000 LT_STUB_MODEL_URL=http://loadtest-stubs:8979 \
node tests/load/setup.mjs --profile agentic
LT_BASE_URL=http://localhost:3000 node tests/load/run.mjs --profile agentic
```

- Setup registers what the scenario needs, and only when `agentTurn` is in the mix: the fake LLM a second time as the model `loadtest-stub-agent`, which is offered tools, and the app `loadtest-agent`, which binds iHub's own tools. `loadtest-stub` stays a model without tools, so every other scenario remains one model call per turn.
- The tool is `list_scheduled_tasks`: it only reads and needs no network.
- The message carries a marker, `lt-tool:<name>:<rounds>`. The fake LLM answers with a call of that tool until it got that many results, and then with text. It calls a tool only when the request offers it.
- A turn that ran fewer tool calls than its message asked for fails (`TOOL_ROUNDS_SHORT`): the app does not offer the tool, or the model was registered without tools. With a real model set `scenarios.agentTurn.requireToolRounds` to `false` in the profile; a real model decides for itself whether to call a tool.
- The report gets a section "Turns with tool rounds": turns, the duration of a whole turn, and tool calls per turn. An agent turn does not count for the TTFT numbers and their SLO: its first answer token comes after several model calls.

### A smoke run with a verdict

`run.mjs` always ends with exit code 0 once it wrote its results; people read a capacity report. To check that the harness and the server still fit together, use:

```bash
npm run loadtest:smoke                                     # smoke, then agentic
node tests/load/local-smoke.mjs --profiles agentic         # one profile
```

It starts the fake LLM and an iHub server on a contents directory of its own (`contents-e2e-load`, removed afterwards), prepares the server, runs the profiles and ends with exit code 1 when a scenario of a profile ended no session or a session of it failed, when a chat scenario ended no turn, when a turn failed (`--max-error-pct`, default 0, for sessions and for turns), or when an agent turn was short of its tool rounds. A `--max-error-pct` that is not a number from 0 to 100 ends it with exit code 2 before anything is started. It takes about five minutes and measures nothing. The nightly workflow runs it.

The tests of the harness itself run with `node --test "tests/load/**/*.test.mjs"`.

## Documents

```bash
npm run loadtest:corpus
```

This writes 42 files (80 MB) to `tests/load/fixtures/corpus/`, which is git-ignored. It uses the server's own `docx`, `pptxgenjs`, `xlsx` and `pdf-lib` libraries, so run `npm run install:all` once first.

- **Word:** policies and 40-page handbooks with tables and images.
- **PowerPoint:** decks of 16–40 slides with images and speaker notes.
- **Excel:** registers, a budget, and a 30,000-row inventory with formulas.
- **PDF:** 12- to 250-page documents with drawn tables and images, plus one scanned PDF without a text layer. The scan goes only into chat uploads, where iHub renders it with pdfium; projects can't use it.

iHub extracts these files in 50 ms to 1.6 s each, on the event loop. That is the cost the corpus exists to reproduce.

`run.mjs` and `setup.mjs` use the corpus automatically, plus small generated Markdown, HTML, CSV and JSON files. Without it they fall back to simple generated files and say so. `LT_FIXTURES_DIR=/path` uses your own documents instead.

## Observability during a run

- **vLLM:** for runs with `loadtest-gpu`, the runner scrapes `<LT_LLM_URL>/metrics`, vLLM's own endpoint on its API port. It reports running and waiting requests, KV-cache use, prompt and generation tokens/s, and preemptions. Waiting requests and a full KV cache are the evidence that the GPU, not iHub, is the limit. The stub publishes the same metric names. Override the address with `LT_VLLM_METRICS_URL`; for a private CA, start the runner with `NODE_EXTRA_CA_CERTS=/path/ca.pem`.
- **Prometheus or Grafana (optional):** set `LT_PROM_URL` to Prometheus, or to Grafana's datasource proxy (`https://grafana…/api/datasources/proxy/uid/<prometheus-uid>`), with `LT_PROM_TOKEN` (a Grafana service-account token with Viewer access). The runner then records:
  - GPU utilisation and memory (DCGM exporter; select the GPU host with `LT_PROM_GPU_SELECTOR`, e.g. `Hostname="gpu-a"`);
  - CPU cores, **CPU throttling**, memory and ready pods of the iHub pod (cAdvisor and kube-state-metrics; `LT_PROM_IHUB_NAMESPACE`, `LT_PROM_IHUB_POD_REGEX`).

  The queries are in `lib/observers.mjs`; override them per profile under `sampling.prometheus.queries`. Throttling above about 20% means the pod's CPU limit is below what `WORKERS` uses.

- **Waits inside iHub (always on):** every process in `GET /api/admin/system/resources` carries `diagnostics`, cumulative counters of cluster-bus traffic per message type, cross-worker requests / gathers / presence lookups (latency, timeouts), lock waits per lock-name prefix, request-throttle slots and storage operations (`server/telemetry/waitDiagnostics.js`). Shard 0 keeps the first and last snapshot per stage; the report's "Waits and cluster bus" section shows the per-stage difference (`lib/waits.mjs`). Use it when event-loop delay climbs but CPU does not explain it.

## On your machine

### 1. Start a target

Use an existing instance, or the sizing lab. The lab gives you a fixed CPU budget, which is what makes "users per worker" meaningful:

```bash
IHUB_CPUS=2 IHUB_WORKERS=2 docker compose -f tests/load/docker-compose.yml up -d
```

The compose file already lifts the per-IP rate limits. The AI-use acknowledgement stays enforced, as shipped: `run.mjs` confirms it for each user before the clock starts and logs how many chat turns still got a 428 (that must be 0). `IHUB_AI_ACK_ENFORCE=false` turns it off for a comparison run. The compose file allows the stub host for crawling. It whitelists no TLS host: for a GPU behind a private CA set `IHUB_SSL_DOMAIN_WHITELIST='["gpu-a.example.com"]'` with your GPU's host.

### 2. Prepare it

```bash
LT_BASE_URL=http://localhost:3000 \
LT_STUB_MODEL_URL=http://loadtest-stubs:8979 \
node tests/load/setup.mjs --profile capacity-stub
```

- `LT_STUB_MODEL_URL` is the stub as **iHub** reaches it: `http://localhost:8979` when iHub runs on the host.
- Setup asks iHub to list the GPU's models, which proves iHub can reach the GPU. It registers the first model as `loadtest-gpu`. Set `LT_LLM_MODEL_NAME` to choose a different one; set `LT_LLM_URL=none` to skip the GPU.
- `--check` runs the preflight only. It prints every setting that would distort the run, each with the environment variable that fixes it.

### 3. Smoke test, then the real runs

The capacity profiles are **open-ended**: they keep stepping up (to 2,000 VUs with the stub, 300 with the GPU) and stop after the first level that breaks an SLO. The level before it is the capacity. Set `LT_STOP_ON_FAILURE=false` to run every stage anyway.

```bash
LT_BASE_URL=http://localhost:3000 LT_MODEL_ID=loadtest-stub LT_EXPECTED_LLM_TTFT_MS=700 \
LT_CRAWL_URL=http://loadtest-stubs:8980/docs/ LT_STUB_STATS_URL=http://localhost:8979/__stats \
node tests/load/run.mjs --profile smoke
```

```bash
LT_BASE_URL=http://localhost:3000 LT_CRAWL_URL=http://loadtest-stubs:8980/docs/ \
LT_STUB_STATS_URL=http://localhost:8979/__stats LT_TARGET_CONCURRENT_USERS=500 \
node tests/load/run.mjs --profile capacity-stub
```

```bash
LT_BASE_URL=http://localhost:3000 node tests/load/run.mjs --profile capacity-gpu
```

```bash
LT_BASE_URL=http://localhost:3000 LT_THINKING=off node tests/load/run.mjs --profile capacity-gpu
```

#### Several GPUs

iHub has no load balancing across models yet (#3692), so a multi-GPU run registers each GPU as its own model and splits the users: `LT_LLM_URLS` lists the GPUs, setup registers them as `loadtest-gpu`, `loadtest-gpu-2`, `loadtest-gpu-3` (served name and context window discovered per GPU), and with `LT_MODEL_ID=loadtest-gpu` (the `capacity-gpu` default) or `loadtest-gpu-*` every VU takes `gpuModelIds[vu % n]` for all its turns, as a user who picked a model would. Set the same `LT_LLM_URLS` for setup **and** run; a profile can list them as `setup.gpus` instead.

```bash
export LT_BASE_URL=http://localhost:3000
export LT_LLM_URLS=https://gpu-a.example.com,https://gpu-b.example.com,https://gpu-c.example.com
node tests/load/setup.mjs --profile capacity-gpu
node tests/load/run.mjs --profile capacity-gpu
```

The runner scrapes `/metrics` of every GPU, and the report adds a "Per model / GPU" table: turns, share, answer TTFT p50/p95 and the vLLM gauges per GPU and stage. Mind that the stages count users across all GPUs, and that the slowest GPU sets the shared TTFT p95 the SLO judges.

The rate-limit run goes against an instance with the **shipped limits**, where only `authApi` is lifted so the runner can log its users in:

```bash
LT_BASE_URL=http://localhost:3000 LT_STUB_STATS_URL=http://localhost:8979/__stats LT_USERS_PER_IP=300 \
node tests/load/run.mjs --profile ratelimits
```

The report lands in `tests/load/results/<runId>/report.md`. A laptop runner manages roughly 300–500 VUs. The report's "Load generator health" section tells you when the runner itself was the limit. Beyond that, run more shards: `LT_SHARD_COUNT=2 LT_SHARD_INDEX=0|1`, same `LT_RUN_ID`, then `node tests/load/report.mjs tests/load/results/<runId>`.

CPU profiles of the workers: add `-f tests/load/docker-compose.prof.yml` to `up` (see the file for where the `.cpuprofile` files land). Any other Node flag goes through `IHUB_NODE_OPTIONS`.

### 4. Clean up

```bash
node tests/load/teardown.mjs --profile capacity-stub --projects --delete-users
```

Or reset the lab completely:

```bash
docker compose -f tests/load/docker-compose.yml down -v
```

## In the cluster

Run the runners **in the cluster, against the iHub Service**. A laptop runner over VPN and an ingress collapses beyond a few hundred connections and then measures the VPN, not iHub.

### Notes before the first run

- **Images for amd64.** An image built on an Apple-silicon laptop is arm64 and does not start on amd64 nodes. Build with `docker buildx build --platform linux/amd64 …` (the runner below, and an iHub build under test).
- **kube-downscaler.** `k8s/namespace.yaml` carries `downscaler/exclude: 'true'`, so a downscaler does not scale the stubs or iHub to 0 mid-run.
- **Volumes.** `k8s/ihub-under-test.yaml` asks for a 10Gi `local-path` volume, an example of a cluster policy that caps claims at 10Gi. One 1,500-user run writes about 2.8 GB.
- **CPU.** One Kubernetes CPU is one hyperthread, not a physical core. Set `requests` = `limits` so the pod gets a guaranteed budget and cannot burst into idle node CPU.
- **Memory.** Kubernetes has no swap: the memory limit is a hard ceiling, and the pod is OOM-killed at it. Docker's default swap is twice the memory limit, which made the local lab's memory results optimistic; `docker-compose.yml` now sets `memswap_limit` equal to `mem_limit`.
- **Node pinning and hostnames** in the manifests are commented examples. Pin iHub to an otherwise idle node if your cluster has one.

### 1. Build and push the runner image

Generate the corpus first, so the image carries it (it is generated, never committed):

```bash
npm run loadtest:corpus
```

```bash
docker buildx build --platform linux/amd64 -t ghcr.io/intrafind/ihub-apps:loadtest-runner --push tests/load
```

If you push elsewhere, change the image in `k8s/kustomization.yaml` (stubs), `k8s/setup-job.yaml` and `k8s/run-job.yaml`, or pass `RUNNER_IMAGE` to `k8s/run.sh`.

### 2. Stubs, config and the iHub under test

Edit `k8s/loadtest.env` (shared by setup and runs). `LT_BASE_URL` defaults to the Service `http://ihub.ihub-loadtest.svc:3000`, which measures iHub alone. An ingress URL measures what users get.

```bash
kubectl apply -k tests/load/k8s
```

```bash
kubectl -n ihub-loadtest create secret generic loadtest-secrets \
  --from-literal=LT_ADMIN_USER=admin --from-literal=LT_ADMIN_PASSWORD='…' \
  --from-literal=LT_USER_PASSWORD='LoadTest-2026!' --from-literal=LT_LLM_API_KEY=''
```

To test a fresh iHub with a fixed budget, apply `k8s/ihub-under-test.yaml` (PVC, Deployment, Service; the Ingress is only for a runner outside the cluster). Set its image to the build you measure. To test an existing deployment instead, merge `k8s/ihub-env.example.yaml` into its env and restart it.

```bash
kubectl -n ihub-loadtest apply -f tests/load/k8s/ihub-under-test.yaml
```

```bash
kubectl -n ihub-loadtest rollout status deploy/ihub
```

### 3. Setup

Setup creates the users `lt-0001…`. Create as many as the largest run needs: `run.mjs` stops before the clock starts when a shard's last user cannot log in, and prints the `LT_USER_COUNT` to use.

```bash
kubectl -n ihub-loadtest apply -f tests/load/k8s/setup-job.yaml
```

```bash
kubectl -n ihub-loadtest logs -f job/loadtest-setup
```

Optional: keep the prepared state as a snapshot, so every run starts from the same `contents/` without setup. Stop iHub first, so the files are consistent:

```bash
kubectl -n ihub-loadtest apply -f tests/load/k8s/seed.yaml
```

```bash
kubectl -n ihub-loadtest scale deploy/ihub --replicas=0
```

```bash
kubectl -n ihub-loadtest exec seed -- tar czf /seed/prepared.tgz -C /contents .
```

`k8s/setup.sh` does both in one call and takes `LT_*` overrides for this setup, e.g. more users on top of an existing snapshot, or the GPU model before a `capacity-gpu` run (its header lists the settings):

```bash
SEED_SNAPSHOT=prepared.tgz SAVE_SNAPSHOT=prepared-4000.tgz \
LT_USER_COUNT=4000 LT_TARGET_CONCURRENT_USERS=4000 tests/load/k8s/setup.sh
```

```bash
LT_PROFILE=capacity-gpu LT_LLM_URL=https://gpu-a.example.com tests/load/k8s/setup.sh
```

`run.sh` with `SEED_SNAPSHOT` scales iHub back up; without it, run `kubectl -n ihub-loadtest scale deploy/ihub --replicas=1`. A snapshot made elsewhere can be copied in with `kubectl cp prepared.tgz ihub-loadtest/seed:/seed/`.

### 4. Run

`k8s/run.sh` does one run end to end: it restores the snapshot (`SEED_SNAPSHOT`), gives iHub its budget (`IHUB_CPU`, `IHUB_MEMORY`, `IHUB_WORKERS`, `IHUB_NODE_OPTIONS`; `kubectl set` restarts it), starts the Indexed Job with `SHARDS` pods, and collects the results. Every `LT_*` variable you set overrides `loadtest.env` for this run. The header of `run.sh` lists all settings.

```bash
KUBECTL="kubectl --context lab" SHARDS=4 \
LT_RUN_ID=company-1500-w6 LT_PROFILE=company LT_STAGES=1500:180:420 LT_STOP_ON_FAILURE=false \
LT_TARGET_CONCURRENT_USERS=1500 \
IHUB_CPU=7 IHUB_MEMORY=8Gi IHUB_WORKERS=6 SEED_SNAPSHOT=prepared.tgz \
tests/load/k8s/run.sh
```

It ends with the report path and iHub's memory peak and restart count (a restart during the run is an OOM kill or a crash: the run is not valid).

By hand, without `run.sh`: keep `completions`/`parallelism` in `run-job.yaml` equal to `LT_SHARD_COUNT`, delete a leftover `loadtest-run-overrides` ConfigMap, and change `LT_RUN_ID` per run.

```bash
kubectl -n ihub-loadtest apply -f tests/load/k8s/run-job.yaml
```

```bash
tests/load/k8s/collect.sh
```

### 5. How the results get out

Each runner pod writes `results/<runId>/shard-<n>.json`, touches `results/DONE` and then sleeps for an hour. `k8s/collect.sh` waits for `DONE` in every pod, copies the shard files out with `kubectl cp` into `tests/load/results/<runId>/`, and runs `report.mjs` on that directory. **This is the reliable path.**

The shard result also goes to stdout as `##LT-RESULT##` lines (`LT_RESULT_TO_STDOUT=1`), and `collect.sh` falls back to them when no runner pod is left. `kubectl logs` can split very long lines, so a larger result may arrive incomplete ("incomplete result for …"); rerun the collection while the pods are still up.

`run.sh` deletes the Job after collecting. When you collect by hand, delete it yourself, or the runner pods hold their CPU for the hour:

```bash
kubectl -n ihub-loadtest delete job loadtest-run
```

### Scaling runs

The test target is **one iHub replica scaled by `WORKERS`**. Set the pod's CPU limit to `WORKERS` + 1 (the primary relays SSE between workers), and repeat `capacity-stub` for `WORKERS` 1, 2, 4, 8 and 12. Comparing users per worker across those runs shows where more workers stop helping. Keep `STICKY_SESSIONS` off: it routes by client address and would pin all VUs of a runner to one worker.

## Settings (environment)

| Variable                                                                   | Default                            | Meaning                                                                                                                        |
| -------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `LT_BASE_URL`                                                              | `http://localhost:3000`            | iHub base URL, including a subpath such as `/ihub`                                                                             |
| `LT_PROFILE`                                                               | `smoke`                            | Name in `profiles/` or a path to a JSON file                                                                                   |
| `LT_MODEL_ID`                                                              | profile                            | `loadtest-stub`, `loadtest-gpu` (all GPUs), `loadtest-gpu-2`, any other                                                        |
| `LT_APP_ID`                                                                | `chat`                             | App the chats use                                                                                                              |
| `LT_STAGES`                                                                | profile                            | Override, e.g. `10:60:300,20:60:300` (VUs:ramp s:hold s, …)                                                                    |
| `LT_VU_SCALE`                                                              | 1                                  | Multiplies every stage's VUs                                                                                                   |
| `LT_MIX`                                                                   | profile                            | e.g. `chat=50,projectChat=50` (others become 0)                                                                                |
| `LT_USER_COUNT` / `--users`                                                | max VUs                            | Users to create and use (`lt-0001`…)                                                                                           |
| `LT_USER_PASSWORD`, `LT_ADMIN_USER`, `LT_ADMIN_PASSWORD`                   | see `lib/config.mjs`               | Credentials                                                                                                                    |
| `LT_LLM_URL`                                                               | none                               | GPU base URL for `loadtest-gpu`; `none` skips it                                                                               |
| `LT_LLM_URLS`                                                              | –                                  | Several GPUs, comma-separated: `loadtest-gpu`, `loadtest-gpu-2`, …                                                             |
| `LT_LLM_MODEL_NAME`, `LT_LLM_API_KEY`                                      | discovered / none                  | Served model name, key                                                                                                         |
| `LT_LLM_SUPPORTS_TOOLS`                                                    | `auto`                             | vLLM with `--enable-auto-tool-choice` supports tools; `none` makes every turn a single LLM call                                |
| `LT_LLM_CONCURRENCY`                                                       | 100                                | iHub's queue limit for the model (1–100)                                                                                       |
| `LT_STUB_MODEL_URL`                                                        | –                                  | Stub as iHub reaches it; registers `loadtest-stub`                                                                             |
| `LT_EXPECTED_LLM_TTFT_MS`                                                  | profile                            | Stub TTFT; the report subtracts it as "iHub overhead"                                                                          |
| `LT_CRAWL_URL`                                                             | `http://loadtest-stubs:8980/docs/` | Site for `projectBuild` crawls; the default is the stub site's name on the compose network, set a URL iHub can reach otherwise |
| `LT_CRAWL_MAX_CONCURRENT`                                                  | 2                                  | Concurrent crawls per shard (protects a real website)                                                                          |
| `LT_FIXTURES_DIR`                                                          | corpus if generated                | Folder of your own PDF/DOCX/PPTX/XLSX… to upload instead                                                                       |
| `LT_SHARD_COUNT`, `LT_SHARD_INDEX`                                         | 1, 0                               | Sharding (`JOB_COMPLETION_INDEX` in Kubernetes)                                                                                |
| `LT_RUN_ID`                                                                | profile + time                     | Same value on every shard of one run                                                                                           |
| `LT_TARGET_CONCURRENT_USERS`                                               | –                                  | Adds a workers / vCPU / RAM recommendation to the report                                                                       |
| `LT_SERVER_WORKERS`                                                        | sampled                            | Worker count when the sampler cannot see it                                                                                    |
| `LT_STUB_STATS_URL`                                                        | –                                  | `…:8979/__stats` for stub in-flight and prompt sizes                                                                           |
| `LT_RESULTS_DIR`, `LT_RESULT_TO_STDOUT`                                    | `tests/load/results`, off          | Output                                                                                                                         |
| `LT_STOP_ON_FAILURE`                                                       | profile                            | End the ramp after the first level that breaks an SLO                                                                          |
| `LT_THINKING`                                                              | model default                      | `on` / `off`: sends `thinkingEnabled` (e.g. Qwen3)                                                                             |
| `LT_LLM_CONTEXT_WINDOW`                                                    | discovered (173184)                | Context window registered for the test models                                                                                  |
| `LT_OWN_PROJECTS_MAX`, `LT_SHARED_PROJECTS`, `LT_DOCS_PER_PROJECT`         | 200, profile, 6                    | Projects setup prepares for `projectChat`                                                                                      |
| `LT_PREFER_SHARED`, `LT_HOT_SHARE`                                         | 0.5, 0 (`company`: 0.8, 0.6)       | Share of project chats in shared projects; share of those in `shared-1`                                                        |
| `LT_USERS_PER_IP`                                                          | target or capacity                 | Users assumed behind one IP for the rate-limit recommendation                                                                  |
| `LT_VLLM_METRICS_URL`                                                      | auto                               | vLLM `/metrics`; `none` disables it                                                                                            |
| `LT_PROM_URL`, `LT_PROM_TOKEN`                                             | –                                  | Prometheus or Grafana datasource proxy, bearer token                                                                           |
| `LT_PROM_IHUB_NAMESPACE`, `LT_PROM_IHUB_POD_REGEX`, `LT_PROM_GPU_SELECTOR` | `ihub`, `ihub.*`, empty            | Label selectors for the PromQL queries                                                                                         |
| `LT_POST_STREAM`                                                           | off                                | `1`: each chat turn streams on its own POST (`Accept: text/event-stream`), no GET; needs server support                        |

Stub tuning (`stub/server.mjs`): `STUB_TTFT_MS` (700), `STUB_TOKENS` (250), `STUB_TOKENS_PER_SEC` (40), `STUB_JITTER` (0.25), `STUB_SITE_PAGES` (300), `STUB_SITE_LATENCY_MS` (80).

## Tests of the harness

```bash
node --test tests/load/
```

## Things that silently distort results

`setup.mjs --check` flags these:

- **Per-IP rate limits.** All VUs of one runner share an IP; the limits are per worker. `HTTP_429` in the report means the run measured the limiter, not iHub.
- **The LLM throttle.** `requestConcurrency` (default 5) applies per model unless the model sets `concurrency`. Setup gives both test models 100.
- **`userProjects` off.** A `projectId` on the chat is then ignored without an error. Setup turns the flag on.
- **No session affinity across replicas** (only if you ever run more than one). The report shows "stream misses" (the turn ran, but nothing of it reached the open stream).
- **The stub model's context window.** iHub injects up to 40% of it as project context. Setup copies the GPU model's discovered window (e.g. 173k) to the stub, so stub runs send the same 50–60k-token project prompts.
- **The crawl target.** The default is the stub site. A real website (`LT_CRAWL_URL=https://…`) measures that site as well: keep `LT_CRAWL_MAX_CONCURRENT` low and only crawl sites you may load.
- **The GPU is shared.** Tell the other users of the GPU before a `capacity-gpu` run. Its numbers are the GPU's limit, not iHub's.
