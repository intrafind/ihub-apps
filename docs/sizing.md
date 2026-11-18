---
description: "How much CPU, memory, storage and GPU an installation needs."
audience: admin
type: reference
---

# Sizing

How much CPU, memory, storage and GPU an iHub installation needs, from the load tests of November
2026, with the [evidence record](chat-evidence.md) on. The iHub numbers were measured on Kubernetes
(one pod on a Xeon node) with the release that contains the performance work of #3794–#3795; the
first measurements of 5.7.0-RC12 on a laptop are kept below for comparison. The numbers come from
`tests/load` (see its README) and can be re-measured with your own mix.

## Short answer

For a company of **1,000 employees** with the usage described below:

- **iHub:** one pod with 8 vCPU, 12 GiB RAM and `WORKERS=6` carries the expected peak with room
  to spare. Use a second pod for availability.
- **10,000 employees:** one pod with 15 vCPU, 24 GiB RAM and `WORKERS=14` carries about 2,000 test
  users, twice the expected peak of 1,000. Two such pods for availability.
- **Storage:** about 50 GB per month of chats, uploads, run records and evidence records, before
  retention.
- **GPU:** the GPU is the real limit. One GPU with Qwen3.6-35B-A3B (FP8, vLLM) serves about **30
  busy users at once without thinking**, and far fewer with thinking. 1,000 employees need **2–4
  such GPUs** without thinking, plus one spare.

The rest of this page explains where these numbers come from and how to adjust them.

## What a test user does

A test user (a "VU", virtual user) is one person who has iHub open and is actively working with it.
It never stops: it runs a session, pauses 10–40 s, and starts the next one. Inside a session it waits
20–60 s between messages, about the time it takes to read an answer and type the next question. One
VU sends **about 1.35 messages per minute** (measured). That is a busy user, not an average one.

Each session is one of these:

| Session          | Share | What happens                                                                                                                        | What it costs iHub                                                  |
| ---------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Chat             |   55% | Opens a chat, asks 2–5 questions, with follow-ups such as "make it shorter"                                                          | Streaming the answer, saving the chat                               |
| Project question |   25% | Asks 3–6 questions in a project with 6 documents                                                                                    | Searching the project, ~13,000 prompt tokens of excerpts per answer |
| File in chat     |   10% | Uploads one document (Word, Excel, PowerPoint, PDF up to 10 MB, also scans) and asks 2–4 questions about it                         | Reading the file, larger prompts                                    |
| Browse           |    8% | Opens the app list, the chat history and the project list                                                                           | Plain API requests                                                  |
| Project build    |    2% | Creates a project, uploads 3–8 documents, waits until they are ready, crawls a website (30 pages), adds 10 pages, asks 2 questions | Reading files, fetching web pages                                   |

In addition, 3 of 10 sessions start with a full page load, as when someone opens iHub in a new tab.

**Shared projects.** 80% of the project questions go to projects shared with everyone, and 60% of
those to one popular project, as with a website chatbot or the company handbook. The rest go to the
user's own projects. One popular project costs iHub less than the same questions spread over many
projects, because its search index stays in memory. With the questions spread over all 220
projects, one pod with 4 workers passed 500 instead of 800 test users (the 650 step failed by
3 ms).

The model in the iHub runs is a stub that answers like a real model: first token after 0.7 s, 250
tokens at 40 tokens/s, about 7 s per answer. The iHub runs therefore measure iHub, not a GPU. The GPU
runs use a real model.

## From employees to test users

A company does not have all its employees in iHub at the same moment. What counts is the **busiest
quarter of an hour**. Two ways to get the number of test users to plan for:

- **From logs (preferred):** test users = chat messages per minute at the busiest time ÷ 1.35.
  Count `POST /api/apps/*/chat/*` requests per minute in the access log or at the ingress.
- **Rule of thumb:** test users = **10% of the employees who have access**. This assumes that one
  in ten is active at the peak and counts each of them as a busy test user. Most real users send
  fewer messages than a test user, so the rule leaves headroom.

| Employees with access | Test users at the peak (10%) |
| --------------------: | ---------------------------: |
|                   500 |                           50 |
|                 1,000 |                          100 |
|                 5,000 |                          500 |
|                20,000 |                        2,000 |

## iHub server

### Measured capacity on Kubernetes

One pod on a dedicated Kubernetes node (Intel Xeon Gold 6242R; one vCPU = one hyperthread, no
swap), the `company` mix, stub model, chat turns streamed on their own POST (the `chatPostStream`
feature on), load generators in the same cluster. Same service levels as below.

| Workers | vCPU | Memory (limit) | Test users | Result | Worker CPU | Event loop p95 | Extra latency p95 |
| ------: | ---: | -------------: | ---------: | ------ | ---------: | -------------: | ----------------: |
|       6 |    7 |         12 GiB |      1,500 | CPU full | 100% | 252 ms | 1.0 s |
|      14 |   15 |         24 GiB |      2,000 | passes (2 of 3 runs; the third 1.52 s / 153 ms) | 62–64% | 51–153 ms | 0.7–1.5 s |
|      14 |   15 |         24 GiB |      2,500 | extra latency too high | 76% | 123–136 ms | 1.8–1.9 s |
|      14 |   15 |         24 GiB |      3,000 | CPU nearly full | 86% | 255 ms | 8.7 s |

- **Capacity of one 15-vCPU pod: about 2,000 test users.** Up to 2,500 the event loop stays within
  150 ms; what fails first is the time iHub adds before the first token. Most of it is counting the
  transcript's tokens before every model call, which is the next thing to improve.
- **No errors** at any of these levels: no failed turn, no lock timeout, no restart.
- **A Xeon hyperthread does less than a laptop core.** The same 7-vCPU setup that carried 1,500 on
  an Apple M2 laptop was CPU-bound at 1,500 here. Measure on your own hardware before planning
  close to these numbers.
- **The POST stream matters.** In the laptop lab, streaming turns on their own POST cut worker CPU by
  about 20 points at 1,500 users. With the feature off, plan more CPU.
- **Memory:** a worker uses 1.5–1.7 GB under load, most of it outside the main heap (extraction
  and search threads, buffers). 14 workers in 18 GiB and in 14 GiB were killed for lack of memory
  (Kubernetes has no swap). Plan **1.7 GiB per worker plus 1 GiB** for the pod; iHub warns at
  startup when `WORKERS` does not fit the memory limit.

### First measurements: one pod on a laptop (5.7.0-RC12)

One pod, the `company` mix above, stub model, data written during the runs (no old history).
Capacity is the largest number of test users at which **every** service level held:

- extra latency from iHub (time to first token minus the model's own) p95 ≤ 1.5 s;
- API p95 ≤ 500 ms;
- errors ≤ 1%;
- average worker CPU ≤ 80%;
- event-loop delay peak p95 ≤ 150 ms.

| Workers | vCPU | Memory (limit) | Capacity (test users) | First failing step       | Worker CPU at capacity | Memory per worker |  RC10 |
| ------: | ---: | -------------: | --------------------: | ------------------------ | ---------------------: | ----------------: | ----: |
|       2 |    3 |          4 GiB |                ≥ 650¹ | none up to 650           |                    63% |            1.4 GB |   300 |
|       4 |    5 |          6 GiB |                  800² | 1,000: event loop 182 ms |                    52% |            1.3 GB |   800 |
|       6 |    7 |          8 GiB |                 1,000 | 1,250: event loop 168 ms |                    58% |            1.3 GB |   800 |
|       8 |    9 |         10 GiB |                  650³ | 1,000: event loop 164 ms |                    28% |            1.1 GB | 1,000 |

¹ Every step passed (event loop 107 ms at 650); the limit is higher but was not measured.
² With project questions spread over all projects (RC10): 500.
³ Lab limit, not an iHub limit: with 8 workers, iHub, the load generator and the stubs crowd the
laptop's 12 cores. With the evidence record off, 8 workers carried 1,000.

- The event loop, not the CPU, sets the limit: it crossed 150 ms at 50–70% average CPU. Up to the
  capacity, iHub added at most 0.3 s (p95) to the model's time to first token, and no request
  failed up to 1,250 test users.
- At 2,000 test users with 8 workers the CPU was full, and answers took 7–8 s longer to start.
- With 48 GB of old history, 8 workers carried 500 (800: event loop 156 ms).

### Evidence record

The [evidence record](chat-evidence.md) stores what went into and came out of every answer. Measured
on and off with the same data:

- **CPU:** 5–14% more worker CPU per message, the more the higher the load. With 4 and 8 workers
  the pod carried one step less (800 instead of 1,000 test users).
- **Storage:** about 40 MB more per 1,000 messages (about 40 KB per answer). Project answers store
  their excerpts, so the share is larger where many questions go to projects.

Turn it off (`chats.evidence.enabled`) only if no one needs to prove what an answer was based on.

### Recommended setups

Plan for 70% of the measured capacity, so a peak or a slow day still fits. Measured on the Xeon node
above; the small and medium sizes are scaled down from it, not measured on their own:

| Setup  | Workers | vCPU | Memory | Test users | Employees (10% rule) |
| ------ | ------: | ---: | -----: | ---------: | -------------------: |
| Small  |       2 |    3 |  5 GiB |       ~250 |        up to 2,500 |
| Medium |       6 |    7 | 12 GiB |       ~700 |        up to 7,000 |
| Large  |      14 |   15 | 24 GiB |      1,400 |       up to 14,000 |

- **vCPU = workers + 1.** The primary process needs its own core. It relays answers between
  workers, and its load grows with the number of workers.
- **Memory:** a worker uses 1.5–1.7 GB at load (measured on Kubernetes; the laptop measured less
  because Docker Desktop let it swap). Give the pod 1.7 GiB per worker plus 1 GiB. Leave the rest for
  the file cache: chats, projects and indexes are read from disk, and an installation whose data no
  longer fits into the cache is slower.
- **Set `WORKERS` explicitly** to vCPU − 1. Without it, the server derives the number from the memory
  limit (see [Scaling with Multiple Workers](scaling.md)).
- **Beyond one pod:** above about 1,400 test users, run several pods behind a load balancer
  ([Multi-Server Deployment](multi-server-deployment.md)) with routing by chat id, so Stop and
  re-attaching to a running answer reach the pod that runs it. Several pods were not measured. Two
  pods also make sense for availability below that size.

### Storage

The `company` mix wrote **about 200–220 MB per 1,000 messages**: chats, uploaded files, project
documents, the run records and the evidence records (about 40 MB of it; without them 155–180 MB). Uploads and project documents make up most of it, so an installation where few people
upload files needs less.

Example: 1,000 employees × 10 messages per working day × 21 days ≈ 210,000 messages per month ≈ **45–50
GB per month**. Chats and their files are kept for `chats.retentionDays` (default 90 days), so this
installation levels off at about 150 GB. Use a volume with room to grow; the admin overview warns at
80% and 90% full.

## GPU

The GPU runs used one GPU (`gpu-01`) with **Qwen3.6-35B-A3B FP8** on vLLM: 173k context, prefix
caching on, 85% of GPU memory. Same `company` mix as above, with real answers, tool calls and
project context (12–15k prompt tokens p95). The service level here is the time until the answer's
first visible word: p95 ≤ 6 s.

| Test users | Thinking off: first word p95 | Thinking on: first visible word p95 | vLLM waiting (avg) | KV cache max |
| ---------: | ---------------------------: | ----------------------------------: | -----------------: | -----------: |
|          5 |                       8.7 s¹ |                              24.3 s |                  0 |   48% / 25% |
|         10 |                        4.1 s |                              37.4 s |            0.1 / 0 |   97% / 95% |
|         20 |                        3.0 s |                              81.9 s |          1 / 0.2 |  98% / 100% |
|         30 |                    **2.4 s** |                              88.0 s |          0.1 / 3.4 |  60% / 100% |
|         40 |                       17.5 s |                    128 s, 6% errors |          2.6 / 10 | 100% / 100% |
|         60 |                       28.2 s |                   148 s, 16% errors |          9.1 / 24 | 100% / 100% |

¹ A single slow start; 10–30 test users stayed below 6 s.

- **Thinking off:** one GPU serves about **30 test users** at once. At 40 the KV cache is full,
  requests queue, and the first word takes 17 s.
- **Thinking on:** the model thinks for 20–30 s before the first visible word, even with 5 users.
  No step met 6 s. If thinking is required, plan for answers that start after half a minute, and
  for about 5–10 test users per GPU. Turn thinking on only for the apps that need it.
- **Planning:** GPUs = test users at the peak ÷ 30 (thinking off), rounded up, plus one for
  availability. A pod with 4 workers carries as many users as about 15 such GPUs; the GPU is by far
  the larger cost.
- **Several GPUs need a load balancer.** A model in iHub has one URL. Put the vLLM instances behind
  one endpoint (a Kubernetes Service, or a router such as LiteLLM or vLLM's router) and register
  that. With prefix caching, route by session or prompt prefix, so a popular project's prompt stays
  cached on one GPU.

GPU model of `gpu-01`: to be added.

## Examples

| Employees | Test users at the peak | iHub                                               | GPUs (thinking off) | Storage per month |
| --------: | ---------------------: | -------------------------------------------------- | ------------------: | ----------------: |
|       500 |                     50 | 1 pod: 2 workers, 3 vCPU, 4 GiB                    |                 2–3 |             25 GB |
|     1,000 |                    100 | 1 pod: 2 workers, 3 vCPU, 4 GiB                    |                 4–5 |             50 GB |
|     5,000 |                    500 | 1 pod: 6 workers, 7 vCPU, 10 GiB, or 2 × small     |               17–18 |            250 GB |
|    20,000 |                  2,000 | 4 pods: 6 workers, 7 vCPU, 10 GiB each             |                 ~67 |              1 TB |

GPU numbers use the 10% rule and count every active user as a busy test user. Measured message
rates usually bring them down by half: a real user who is active sends one message every one to
two minutes, not 1.35 per minute.

## Limits for large installations

The shipped rate limits and the model concurrency fit a company of **10,000 employees**: about
1,000 busy users at the peak, possibly all behind one corporate NAT address.

**Demand per user** (load test, `company` mix, page loads included): 2 requests per minute at the
median, 18 at the 99th percentile, at most 50. 1,000 users from one address made at most 2,025
requests per minute on the general API.

**Measured** (1,000 test users from two addresses, 6 workers, stub model with 7 s answers):

| Run                                         | Chat turns/min | First word p50 / p95 | Failed turns | HTTP errors | 429s   |
| ------------------------------------------- | -------------: | -------------------: | -----------: | ----------: | -----: |
| Lab without limits (reference)              |          1,359 |       0.8 s / 1.1 s |           0% |          0% |      0 |
| Old defaults: 500 per IP                    |            961 |       1.0 s / 3.4 s |      **38%** |     **45%** | 20,387 |
| Old default: 5 calls at once per model      |            426 |      **96 s / 100 s** |           0% |          0% |      0 |
| New defaults: 300 per user, 25 per model    |          1,359 |       0.8 s / 1.4 s |           0% |          0% |      0 |

- With the old per-address limit, about 115 users per address and worker fit before the first
  429; behind one NAT address most of the company is refused.
- With 5 calls at once, every call waits for a slot: the server is idle (19% CPU) while the first
  word takes a minute and a half.
- With the new defaults, the busiest user made 48 requests per minute against a limit of 300.

| Setting                                  | Default                       | Counts per                         | Why                                                                                       |
| ---------------------------------------- | ----------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `rateLimit.publicApi` / `adminApi` / `inferenceApi` `.limit` | 300 per minute | signed-in user (`keyBy: "user"`) | 6× the busiest measured user; NAT does not matter any more                              |
| `…anonymousLimit`                        | 500 per minute                | IP address                         | requests without a sign-in                                                                |
| `rateLimit.authApi.limit`                | 30 per 15 minutes             | IP address and username            | one person's retries; the account lockout stops guessing after 5 failures                 |
| `rateLimit.authApi.perIpLimit`           | 5,000 per 15 minutes          | IP address                         | a login wave of 30% of 10,000 employees in 15 minutes is 3,000 sign-ins from one address |
| `requestConcurrency`                     | 25                            | model, unless it sets `concurrency` | one GPU served about 30 busy users at once (see [GPU](#gpu)); a small backend or a rate-limited cloud key needs its own lower `concurrency` |

- **Per-user limits count per worker,** so with `WORKERS=6` a user can make up to 6 × 300 requests
  per minute. The sign-in limits count across all workers.
- **Model concurrency counts across all workers** and is per model. Behind one model URL with
  several GPUs (a load balancer), raise the model's own `concurrency` to about 30 × GPUs.
- **Waiting for a slot is logged.** When calls wait 2 seconds or more for a free slot, the server
  logs `Request throttle: calls waited for a free slot` (at most once a minute per model). Raise the
  model's `concurrency` if the backend can take more.
- **`trustProxy`** still matters for anonymous requests and for sign-in: set it to the real number
  of proxy hops ([Rate limiting](rate-limiting.md#proxy-hops-and-the-rate-limit-key)).

Installations updated from an earlier release get these values where they still had the old
shipped ones (migration `V254`); values an admin set stay.

## Limits of these measurements

- The Kubernetes measurements ran one pod on a node it shared with the stubs and the load
  generators (CPU limits kept them apart). The first measurements ran on a laptop (Apple silicon,
  Docker Desktop with 12 CPUs, swap allowed), where iHub, the load generator and the stubs shared the
  same cores.
- A real model streams differently from the stub (token rate, thinking); the stub sends 40 tokens
  per second for every answer.
- One pod only. Several pods, an ingress, and a long soak (memory over days) were not measured.
- One GPU and one model. Other GPUs, models, quantizations and vLLM settings change the GPU numbers
  more than anything on the iHub side.
- The 10% rule and the message rate are assumptions. Replace them with your own numbers from logs.

## Re-measuring

```bash
# iHub with the stub model, the company mix
node tests/load/run.mjs --profile company

# the same against a real GPU
LT_LLM_URL=https://your-gpu node tests/load/run.mjs --profile capacity-gpu
```

`LT_PREFER_SHARED` and `LT_HOT_SHARE` change how many project questions go to shared projects and
to the one popular project. See `tests/load/README.md` for the whole setup.
