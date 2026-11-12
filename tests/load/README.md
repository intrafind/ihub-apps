# iHub load test and sizing harness

Simulates real users. They chat with a real or fake LLM, upload documents into chats, build projects (upload, ingestion, website crawl) and run multi-turn chats inside projects. Alongside that, the harness samples the server's CPU, memory, event loop and disk. The output is a report that answers: **how many concurrent users can one worker carry, and how many workers, vCPU and how much RAM a target needs.**

The test plan, the sizing method and what we expect to find are in [`concepts/2026-11-12 Load Test and Sizing Plan.md`](../../concepts/2026-11-12%20Load%20Test%20and%20Sizing%20Plan.md).

The harness is plain Node 20+ with no dependencies. It runs the same way on a laptop and as a Kubernetes Job.

| File                 | What it is                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setup.mjs`          | Prepares an instance (idempotent): preflight checks, the `userProjects` flag, models `loadtest-gpu` / `loadtest-stub`, users `lt-0001…`, and "LT-chat" projects with documents |
| `run.mjs`            | The load generator: one shard per process                                                                                                                                      |
| `report.mjs`         | Merges shard results and writes `report.md`, `summary.json` and `timeline.csv`                                                                                                 |
| `teardown.mjs`       | Deletes test chats and projects (with `--delete-users`, also the users)                                                                                                        |
| `stub/server.mjs`    | Paced fake LLM (OpenAI-compatible) and a synthetic website for crawls                                                                                                          |
| `profiles/*.json`    | One per experiment: `smoke`, `capacity-stub`, `capacity-gpu`, `ingest`, `soak`, `spike`                                                                                        |
| `docker-compose.yml` | Local sizing lab: iHub with a fixed CPU/RAM budget, plus the stubs                                                                                                             |
| `k8s/`               | Stubs Deployment, setup Job, Indexed runner Job, `collect.sh`                                                                                                                  |

## What a virtual user does

A VU is one **concurrently active** user. It loops over sessions, picked by the profile's `mix`. It waits `thinkTimeSec` between turns and `sessionPauseSec` between sessions.

| Scenario       | Flow                                                                                                                        | Main load                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `chat`         | SSE `GET /api/apps/{app}/chat/{id}` held open, then 2–5 × `POST` one message                                                | LLM, SSE relay, chat persistence                                        |
| `chatFile`     | `POST /api/chats/{id}/files` (multipart), then a turn with `fileIds`, then follow-ups                                       | text extraction, file store, larger prompts                             |
| `projectChat`  | 3–6 turns with `projectId` in an own or shared LT-chat project                                                              | project text injection (BM25/whole corpus), knowledge tools, decryption |
| `projectBuild` | create a project → upload 3–8 files → poll until `ready` → crawl a site → add 10 pages as URL items → 2 chat turns → delete | ingestion queue, CPU-bound extraction, outbound fetches                 |
| `browse`       | app list, chat history, project list                                                                                        | non-LLM API latency                                                     |
| `inference`    | `/api/inference/v1/chat/completions`, streamed                                                                              | pure LLM path (off by default)                                          |

Measured per turn:

- **TTFT**: time to the first text token after the POST.
- **Turn duration.**
- **Answer speed.**
- **Prompt tokens**: shows how much project context was injected.
- **Tool calls.**
- **Stream misses**: a POST that reached a replica without the SSE stream, which means the ingress lacks affinity.
- **Error codes.**

Resource samples come from `GET /api/admin/system/resources` every 5 s. They cover CPU %, RSS, heap and event-loop delay for every worker and for the primary, plus host CPU/RAM and the data volume.

## On your machine

### 1. Start a target

Use an existing instance, or the sizing lab. The lab gives you a fixed CPU budget, which is what makes "users per worker" meaningful:

```bash
IHUB_CPUS=2 IHUB_WORKERS=2 docker compose -f tests/load/docker-compose.yml up -d
```

The compose file already lifts the per-IP rate limits and turns off the AI-use acknowledgement. It allows the stub host for crawling and whitelists `gpu-01.local.intrafind.io` for TLS. **You need the VPN** for the GPU.

### 2. Prepare it

```bash
LT_BASE_URL=http://localhost:3000 \
LT_STUB_MODEL_URL=http://loadtest-stubs:8979 \
LT_LLM_URL=https://gpu-01.local.intrafind.io \
node tests/load/setup.mjs --profile capacity-stub
```

- `LT_STUB_MODEL_URL` is the stub as **iHub** reaches it: `http://localhost:8979` when iHub runs on the host.
- Setup asks iHub to list the GPU's models, which proves iHub can reach the GPU. It registers the first model as `loadtest-gpu`. Set `LT_LLM_MODEL_NAME` to choose a different one; set `LT_LLM_URL=none` to skip the GPU.
- `--check` runs the preflight only. It prints every setting that would distort the run, each with the environment variable that fixes it.

### 3. Smoke test, then the real runs

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

The report lands in `tests/load/results/<runId>/report.md`. A laptop runner manages roughly 300–500 VUs. The report's "Load generator health" section tells you when the runner itself was the limit. Beyond that, run more shards: `LT_SHARD_COUNT=2 LT_SHARD_INDEX=0|1`, same `LT_RUN_ID`, then `node tests/load/report.mjs tests/load/results/<runId>`.

### 4. Clean up

```bash
node tests/load/teardown.mjs --profile capacity-stub --projects --delete-users
```

Or reset the lab completely:

```bash
docker compose -f tests/load/docker-compose.yml down -v
```

## In the cluster

1. Build the runner image and push it:

   ```bash
   docker build -t ghcr.io/intrafind/ihub-loadtest:latest tests/load
   ```

   ```bash
   docker push ghcr.io/intrafind/ihub-loadtest:latest
   ```

   Adjust the image name in `k8s/kustomization.yaml` and the Job files if you push elsewhere.

2. Configure the iHub under test with the environment in `k8s/ihub-env.example.yaml`, then restart it.
3. Edit `k8s/loadtest.env`:
   - `LT_BASE_URL`: the ingress URL measures what users get; `http://ihub.<ns>.svc:3000` measures iHub alone.
   - `LT_PROFILE`, a new `LT_RUN_ID` per run, and `LT_SHARD_COUNT`, which must equal `completions` in `run-job.yaml`.
4. Create the Secret:

   ```bash
   kubectl create namespace ihub-loadtest
   ```

   ```bash
   kubectl -n ihub-loadtest create secret generic loadtest-secrets \
     --from-literal=LT_ADMIN_USER=admin --from-literal=LT_ADMIN_PASSWORD='…' \
     --from-literal=LT_USER_PASSWORD='LoadTest-2026!' --from-literal=LT_LLM_API_KEY=''
   ```

5. Apply the stubs and config, run setup, then run the test:

   ```bash
   kubectl apply -k tests/load/k8s
   ```

   ```bash
   kubectl -n ihub-loadtest apply -f tests/load/k8s/setup-job.yaml
   ```

   ```bash
   kubectl -n ihub-loadtest logs -f job/loadtest-setup
   ```

   ```bash
   kubectl -n ihub-loadtest apply -f tests/load/k8s/run-job.yaml
   ```

6. Collect and merge. This writes `tests/load/results/<runId>/report.md`:

   ```bash
   tests/load/k8s/collect.sh
   ```

7. Before the next run, delete the old Job and change `LT_RUN_ID`:

   ```bash
   kubectl -n ihub-loadtest delete job loadtest-run
   ```

With several iHub replicas, the resource sampler sees only the replica that answered. Use the Prometheus metrics (telemetry on, port 9464) or `kubectl top pods` for all of them.

## Settings (environment)

| Variable                                                 | Default                             | Meaning                                                                 |
| -------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `LT_BASE_URL`                                            | `http://localhost:3000`             | iHub base URL, including a subpath such as `/ihub`                      |
| `LT_PROFILE`                                             | `smoke`                             | Name in `profiles/` or a path to a JSON file                            |
| `LT_MODEL_ID`                                            | profile                             | Model for the chats: `loadtest-stub`, `loadtest-gpu` or an existing one |
| `LT_APP_ID`                                              | `chat`                              | App the chats use                                                       |
| `LT_STAGES`                                              | profile                             | Override, e.g. `10:60:300,20:60:300` (VUs:ramp s:hold s, …)             |
| `LT_VU_SCALE`                                            | 1                                   | Multiplies every stage's VUs                                            |
| `LT_MIX`                                                 | profile                             | e.g. `chat=50,projectChat=50` (others become 0)                         |
| `LT_USER_COUNT` / `--users`                              | max VUs                             | Users to create and use (`lt-0001`…)                                    |
| `LT_USER_PASSWORD`, `LT_ADMIN_USER`, `LT_ADMIN_PASSWORD` | see `lib/config.mjs`                | Credentials                                                             |
| `LT_LLM_URL`                                             | `https://gpu-01.local.intrafind.io` | GPU base URL for `loadtest-gpu`; `none` skips it                        |
| `LT_LLM_MODEL_NAME`, `LT_LLM_API_KEY`                    | discovered / none                   | Served model name, key                                                  |
| `LT_LLM_SUPPORTS_TOOLS`                                  | `auto`                              | `none` if vLLM runs without `--enable-auto-tool-choice`                 |
| `LT_LLM_CONCURRENCY`                                     | 100                                 | iHub's queue limit for the model (1–100)                                |
| `LT_STUB_MODEL_URL`                                      | –                                   | Stub as iHub reaches it; registers `loadtest-stub`                      |
| `LT_EXPECTED_LLM_TTFT_MS`                                | profile                             | Stub TTFT; the report subtracts it as "iHub overhead"                   |
| `LT_CRAWL_URL`                                           | `https://intrafind.com/de`          | Site for `projectBuild` crawls                                          |
| `LT_CRAWL_MAX_CONCURRENT`                                | 2                                   | Concurrent crawls per shard (protects a real website)                   |
| `LT_FIXTURES_DIR`                                        | generated                           | Folder of real PDF/DOCX/PPTX/XLSX… to upload instead                    |
| `LT_SHARD_COUNT`, `LT_SHARD_INDEX`                       | 1, 0                                | Sharding (`JOB_COMPLETION_INDEX` in Kubernetes)                         |
| `LT_RUN_ID`                                              | profile + time                      | Same value on every shard of one run                                    |
| `LT_TARGET_CONCURRENT_USERS`                             | –                                   | Adds a workers / vCPU / RAM recommendation to the report                |
| `LT_SERVER_WORKERS`                                      | sampled                             | Worker count when the sampler cannot see it                             |
| `LT_STUB_STATS_URL`                                      | –                                   | `…:8979/__stats` for stub in-flight and prompt sizes                    |
| `LT_RESULTS_DIR`, `LT_RESULT_TO_STDOUT`                  | `tests/load/results`, off           | Output                                                                  |

Stub tuning (`stub/server.mjs`): `STUB_TTFT_MS` (700), `STUB_TOKENS` (250), `STUB_TOKENS_PER_SEC` (40), `STUB_JITTER` (0.25), `STUB_SITE_PAGES` (300), `STUB_SITE_LATENCY_MS` (80).

## Things that silently distort results

`setup.mjs --check` flags these:

- **Per-IP rate limits.** All VUs of one runner share an IP; the limits are per worker. `HTTP_429` in the report means the run measured the limiter, not iHub.
- **The LLM throttle.** `requestConcurrency` (default 5) applies per model unless the model sets `concurrency`. Setup gives both test models 100.
- **`userProjects` off.** A `projectId` on the chat is then ignored without an error. Setup turns the flag on.
- **No session affinity across replicas.** The report shows "stream misses" (the POST was answered without streaming).
- **The crawl target.** intrafind.com is our production website: one Apache/Drupal server, about 0.6 s per page. Keep `LT_CRAWL_MAX_CONCURRENT` low, run outside business hours, and use the stub site (`LT_CRAWL_URL=http://loadtest-stubs…:8980/docs/`) for repeated or ingestion-heavy runs.
- **The GPU is shared.** Tell the people using gpu-01 before a `capacity-gpu` run. Its numbers are the GPU's limit, not iHub's.
