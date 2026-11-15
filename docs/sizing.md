# Sizing

How much CPU, memory, storage and GPU an iHub installation needs, from the load tests of
5.7.0-RC10 (November 2026). The numbers come from `tests/load` (see its README) and can be
re-measured with your own mix.

## Short answer

For a company of **1,000 employees** with the usage described below:

- **iHub:** one pod, `WORKERS=2`, 3 vCPU, 4 GiB RAM. It carries about twice the expected peak.
  Use `WORKERS=4`, 5 vCPU, 8 GiB if you want room for growth or a second pod for availability.
- **Storage:** about 50 GB per month of chats, uploads and run records, before retention.
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

### Measured capacity of one pod

One pod, the `company` mix above, stub model, data written during the runs (no old history).
Capacity is the largest number of test users at which **every** service level held:

- extra latency from iHub (time to first token minus the model's own) p95 ≤ 1.5 s;
- API p95 ≤ 500 ms;
- errors ≤ 1%;
- average worker CPU ≤ 80%;
- event-loop delay peak p95 ≤ 150 ms.

| Workers | vCPU | Memory (limit) | Capacity (test users) | First failing step                        | Worker CPU at capacity | Memory per worker |
| ------: | ---: | -------------: | --------------------: | ----------------------------------------- | ---------------------: | ----------------: |
|       2 |    3 |          4 GiB |                   300 | 500: event loop 160 ms                    |                    34% |          1.4 GB |
|       4 |    5 |          6 GiB |       800 (500–800)¹ | 1,000: event loop 161 ms                  |                    48% |          1.4 GB |
|       6 |    7 |          8 GiB |                   800 | 1,000: event loop 158 ms                  |                    41% |          1.3 GB |
|       8 |    9 |         10 GiB |                 1,000 | 1,250: event loop 223 ms; overload 2,000 |                    47% |          1.2 GB |

¹ With project questions spread over all projects: 500.

- The event loop, not the CPU, sets the limit: it crossed 150 ms at 40–60% average CPU. Up to the
  capacity, iHub added at most 0.3 s (p95) to the model's time to first token, and no request
  failed up to 1,500 test users.
- At 2,000 test users with 8 workers the CPU was full, and answers took 9 s longer to start.
- Changes merged after RC10 (#3684 ledger, #3685 usage limits, #3686 storage) lowered the event-loop
  peak at 800 test users and 8 workers from 153 to 116 ms with fresh data, and from 184 to 130 ms
  with 48 GB of old history. The capacities above are therefore conservative for releases that
  contain them.

### Recommended setups

Plan for 70% of the measured capacity, so a peak or a slow day still fits:

| Setup  | Workers | vCPU | Memory | Test users | Employees (10% rule) |
| ------ | ------: | ---: | -----: | ---------: | -------------------: |
| Small  |       2 |    3 |  4 GiB |        200 |        up to 2,000 |
| Medium |       4 |    5 |  8 GiB |        400 |        up to 4,000 |
| Large  |       6 |    7 | 10 GiB |        550 |        up to 5,500 |
| XL     |       8 |    9 | 12 GiB |        700 |        up to 7,000 |

- **vCPU = workers + 1.** The primary process needs its own core. It relays answers between
  workers, and its load grows with the number of workers.
- **Memory:** a worker uses 1.2–1.45 GB at load. Give the pod at least 1.5 GiB per worker plus 1–2
  GiB. Leave the rest for the file cache: chats, projects and indexes are read from disk, and an
  installation whose data no longer fits into the cache is slower.
- **Set `WORKERS` explicitly** to vCPU − 1. Without it, the server derives the number from the memory
  limit (see [Scaling with Multiple Workers](scaling.md)).
- **Beyond one pod:** above about 700 test users, run several pods with 6 workers each behind a load
  balancer ([Multi-Server Deployment](multi-server-deployment.md)). Several pods were not measured
  in this lab. Two pods also make sense for availability below that size.

### Storage

The `company` mix wrote **about 230 MB per 1,000 messages**: chats, uploaded files, project
documents and the run records. With the run-ledger change (#3684) it was 170–230 MB, before it
290–320 MB. Uploads and project documents make up most of it, so an installation where few people
upload files needs less.

Example: 1,000 employees × 10 messages per working day × 21 days ≈ 210,000 messages per month ≈ **50
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
|     1,000 |                    100 | 1 pod: 2 workers, 3 vCPU, 4 GiB (or 4 / 5 / 8 GiB) |                 4–5 |             50 GB |
|     5,000 |                    500 | 1 pod: 8 workers, 9 vCPU, 12 GiB, or 2 × medium    |               17–18 |            250 GB |
|    20,000 |                  2,000 | 4 pods: 6 workers, 7 vCPU, 10 GiB each             |                 ~67 |              1 TB |

GPU numbers use the 10% rule and count every active user as a busy test user. Measured message
rates usually bring them down by half: a real user who is active sends one message every one to
two minutes, not 1.35 per minute.

## Limits of these measurements

- The lab was a laptop (Apple silicon, Docker Desktop with 12 CPUs): iHub, the load generator and the
  stubs shared the same cores. With 8 workers that crowding showed: the event loop was already
  slower at low load than with 4 or 6 workers. Dedicated nodes will do at least as well.
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
