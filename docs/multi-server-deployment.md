# Multi-Server Deployment

This page describes how to run iHub Apps across **multiple hosts** behind a
load balancer (HA, geographic spread, blue/green, rolling upgrades) and which
features degrade or stop working when the platform is no longer a single
process.

> If you only need to use multiple CPU cores on **one host**, use the built-in
> sticky cluster (`WORKERS=N`) — see [Scaling with Multiple
> Workers](scaling.md). Multi-host deployment is a different problem with
> different trade-offs.

## TL;DR

iHub Apps was designed as a single-instance application that holds most of
its runtime state in memory and persists everything else to a shared
`contents/` directory. You **can** run it on multiple hosts, but you have to
respect three hard rules and accept four degradations.

**Hard rules**

1. **Sticky load balancer by client.** Chat streams (SSE) must always come
   back to the same host that started them.
2. **Shared `contents/` volume.** Every host mounts the **same**
   `contents/` directory (NFS, EFS, CIFS, S3-FUSE, …).
3. **Identical secrets and config.** Same encryption key, same JWT/token
   secret, same `platform.json`, same OIDC client credentials on every host.

**Configuration model**

- Treat `contents/` as **deploy-time configuration**, not as a runtime control
  panel.
- All config changes are made in a **central system of record** (Git
  repository, configuration management, staging instance).
- Production hosts receive config via a **sync step** (CI/CD, rsync, GitOps,
  shared volume snapshot) — **not** by editing the live filesystem and
  **not** by using the Admin UI on a production node.

**What you lose**

- Per-host **rate limit** counters (a user can hit each host's limit
  separately).
- Split **usage / stats** when buffers don't share state cleanly across
  hosts.
- Cross-host **cache coherency** for config edits (5-minute lag at best).
- Cross-host **chat failover** — if a host dies mid-stream, the SSE
  connection drops.

The rest of this page explains why and how to operate around it.

## Architecture

```
                    ┌────────────────────────────────────┐
                    │   Load balancer (sticky sessions)  │
                    │   - by source IP, cookie, or       │
                    │     chatId path segment            │
                    └──────────┬───────────────┬─────────┘
                               │               │
                ┌──────────────┴──┐         ┌──┴──────────────┐
                │  Host A         │         │  Host B         │
                │  (sticky        │         │  (sticky        │
                │   cluster, 4 w) │   ...   │   cluster, 4 w) │
                │  in-mem caches  │         │  in-mem caches  │
                │  in-mem SSE     │         │  in-mem SSE     │
                └──────────────┬──┘         └──┬──────────────┘
                               │               │
                               └───────┬───────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │   Shared contents/ volume (read-write)      │
                │   - config/*.json, apps/, models/, …        │
                │   - data/usage.json, data/feedback.jsonl    │
                │   - data/shortlinks.json                    │
                │   - .encryption-key, .migration-history     │
                └─────────────────────────────────────────────┘

                ┌─────────────────────────────────────────────┐
                │   Source of truth (Git / config repo)       │
                │   pushed to contents/ at deploy time        │
                └─────────────────────────────────────────────┘
```

## The three hard rules

### 1. Sticky load balancer

Chat streaming relies on **per-process in-memory state**. The same client
must keep landing on the same host (and within that host, on the same
worker — handled by the sticky cluster, see [scaling.md](scaling.md)).

Why: `server/sse.js` keeps the live `clients` and `activeRequests` maps in
the worker that opened the SSE GET. The follow-up POST that submits the
prompt has to reach the same map, otherwise the tokens stream nowhere.
`server/actionTracker.js` is a `Node.js EventEmitter` whose events do not
cross processes. There is no Redis or message-bus fan-out in the current
build.

Configure stickiness on whatever fronts your hosts. Examples:

**nginx**

```nginx
upstream ihub_backend {
    ip_hash;                  # cheap option
    # or, for better distribution behind NAT:
    # hash $cookie_ihub_session consistent;
    server host-a:3000;
    server host-b:3000;
}
```

**HAProxy**

```haproxy
backend ihub
    balance source
    # or cookie-based:
    # cookie SERVERID insert indirect nocache
    server hostA host-a:3000 check cookie A
    server hostB host-b:3000 check cookie B
```

**Kubernetes Service / Ingress**

```yaml
# Service
spec:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
```

For NGINX Ingress, set `nginx.ingress.kubernetes.io/affinity: cookie`.

> If your load balancer balances by raw round-robin, **chat will appear to
> hang** for users — the SSE GET succeeds but no tokens arrive after the
> POST. This is the most common deployment mistake.

### 2. Shared `contents/` volume

Every host must read **and write** the same `contents/` directory. The
following are written at runtime and must therefore be on shared storage:

| Path                              | Written by                                | Notes                                                |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `contents/config/*.json`          | Admin UI saves                            | App, model, group, platform configs                  |
| `contents/apps/*.json`            | Admin UI saves                            | Individual app configs                               |
| `contents/data/usage.json`        | `usageTracker.js` (every ~10 s flush)     | Aggregate counters per app/model                     |
| `contents/data/feedback.jsonl`    | `feedbackStorage.js` (every ~10 s flush)  | Append-only feedback log                             |
| `contents/data/shortlinks.json`   | `shortLinkManager.js`                     | Shared chat / short link entries                     |
| `contents/data/workflow-state/`   | Workflow `StateManager`                   | Optional persistence for in-flight workflow runs     |
| `contents/uploads/assets/`        | Admin UI asset upload                     | Logos, icons referenced from the UI                  |
| `contents/.encryption-key`        | First-time setup                          | AES key for `ENC[...]` secrets — must be identical   |
| `contents/.migration-history.json`| Migration runner on startup               | Tracks applied versions                              |
| `contents/.migration-lock`        | Migration runner on startup               | Filesystem advisory lock so only one host migrates   |

Use a real shared filesystem (NFSv4, EFS, FSx, CIFS). **Do not** copy the
directory onto each host independently — the runtime files will diverge and
admin edits on one host will not be visible on the others.

> Concurrent writes from multiple admins on different hosts are not
> coordinated beyond filesystem-level atomic writes. Treat the Admin UI in
> production as read-only (see [Configuration sync](#configuration-sync)).

### 3. Identical secrets and config

The following must be the **same byte-for-byte** on every host:

| Thing                                  | Why                                                        |
| -------------------------------------- | ---------------------------------------------------------- |
| `contents/.encryption-key`             | Decrypts `ENC[...]` secrets in `platform.json`             |
| `TOKEN_ENCRYPTION_KEY` env var         | Alternative source for the encryption key                  |
| JWT signing secret (`contents/.jwt-secret`) | A token issued by host A must validate on host B      |
| `contents/config/platform.json`        | Auth modes, OIDC clients, CORS, ports — must agree         |
| OIDC `clientId` / `clientSecret`       | Same client registration on every host                     |
| LDAP / NTLM / Jira credentials         | Encrypted with the shared key, read identically            |

If keys differ, JWTs minted on host A are rejected on host B and the user
sees random "session expired" errors. If `platform.json` differs, behaviour
depends on which host the request happens to land on — extremely hard to
debug.

The clean way to guarantee this is to keep secrets in a secret manager
(Vault, AWS Secrets Manager, sealed config repo) and inject them at host
boot, rather than relying on the shared volume alone.

## Configuration sync

> **Rule of thumb: production hosts read configuration. They do not author
> it.**

iHub stores configuration as JSON files in `contents/`. The Admin UI is
convenient for development and staging — in a multi-host production setup
it is a foot-gun, because:

- Cache invalidation is per-process (5-minute TTL in production), so a save
  on host A only becomes visible on host B after up to 5 minutes — **and
  only if** they share the same `contents/` directory.
- Concurrent edits by different admins on different hosts can lose data
  (last write wins; no ETag/optimistic-locking layer).
- Changes made directly in production are not in source control, so they
  cannot be reproduced, audited, or rolled back.

The recommended pattern:

1. **Source of truth = Git.** Keep `contents/config/`, `contents/apps/`,
   `contents/models/`, `contents/sources/`, etc. under version control.
2. **Author in staging.** Run a single staging instance that mirrors prod.
   Admins use the Admin UI there.
3. **Promote via PR.** Diffs from staging are committed and reviewed.
4. **Deploy by sync.** CI deploys `contents/` to the shared production
   volume (atomic rename or rsync). All hosts pick up the change within
   one cache TTL, or immediately after a rolling restart.
5. **Production Admin UI is effectively read-only.** Either disable
   `adminAccess` for production groups, mount `contents/config/` read-only,
   or use a stricter group policy on prod.

If you do allow ad-hoc Admin UI edits in production:

- Restrict it to a **single designated host** (admin operations bypass other
  hosts' caches only after their next refresh).
- Be aware that `contents/data/` (usage, feedback) still needs to be
  read-write on every host.
- Plan for stale reads on the other hosts for up to 5 minutes.

## What you lose vs. a single-instance deployment

The features below either degrade silently or behave per-host. None of them
are blockers, but you need to know about them up front.

### Per-host rate limits

`server/middleware/rateLimiting.js` uses an in-memory store keyed by IP.
Counters are **per process**, so:

- Across two hosts, a user can hit roughly **2× the configured limit**.
- The cluster on each host already pins a given IP to one worker, so within
  a host the count is correct.

If global rate limiting matters, swap the in-memory store for a shared
backend (Redis, Memcached) — this is a code change in the rate limiter
middleware. See [rate-limiting.md](rate-limiting.md).

### Split usage and stats

`server/usageTracker.js` keeps an in-memory snapshot of `usage.json` and
flushes to disk every ~10 seconds. With a shared `contents/` volume:

- Each host loads the file at startup, then mutates **its own copy** in
  memory.
- On flush, each host writes the **whole file** with its view of the
  counters. The last writer wins.
- Usage from the loser host is lost on every flush boundary.

What this means in practice:

- The Admin **Usage** dashboard is unreliable as a global view across
  multiple hosts.
- Per-day totals will undercount.
- Per-app and per-model breakdowns are still directionally correct but
  not authoritative.

If accurate usage matters, treat the JSON file as a per-host artefact
(don't share it) and aggregate externally — for example by pointing
telemetry / OpenTelemetry exports at a central collector
(see [telemetry.md](telemetry.md)) and computing usage from those events
instead of from `usage.json`.

### Feedback may be lost on crash

`server/feedbackStorage.js` queues feedback in memory and appends to
`contents/data/feedback.jsonl` every ~10 seconds. If a host crashes between
flushes, the in-flight feedback for that worker is lost. Cross-host this
is unchanged, but with more hosts you have proportionally more risk.

### Short links / shared chats

`server/shortLinkManager.js` loads `shortlinks.json` once at startup and
periodically rewrites it. A user creating a short link on host A may not
see it resolve on host B until host B reloads or the next cache TTL
boundary. With sticky sessions this is rarely user-visible (the creator
keeps landing on the same host), but link sharing across users may surface
the lag.

### SSE failover

A chat is pinned to one worker on one host for its lifetime. If that host
dies, the SSE stream drops; the browser reconnects and the user has to
resend. There is no cross-host fan-out (Redis pub/sub for SSE was
considered but is not in the current build — see
[scaling.md](scaling.md#alternatives-considered)).

Practical implications:

- **Rolling restart** during a deploy will drop in-flight assistant
  responses for users currently streaming. The browser reconnects on the
  next host.
- **Long-running tool calls** (>30 s) survive only if their host survives.
- **Workflow runs** are partially persisted to
  `contents/data/workflow-state/{id}.json` but the live in-memory state in
  `StateManager` is per-host. If a workflow run's host dies mid-execution,
  recovery on a different host is **not guaranteed** — the user sees a
  failed run and has to retry.

If you need true session failover, plan for SSE/state to move to a shared
broker. That is a larger refactor and outside the scope of this guide.

### Cache coherency lag

`server/configCache.js` refreshes from disk every **5 minutes** in
production (`NODE_ENV=production`). If you change a config file directly on
the shared volume:

- Hosts pick it up at the next refresh tick — could be anywhere from
  immediately to 5 minutes later.
- Admin UI saves only invalidate the cache **on the host that handled the
  save**. Other hosts see the stale view until their TTL expires.

For deterministic propagation, do a **rolling restart** after a config sync.

### Marketplace installs

`server/services/marketplace/` writes to `contents/config/installations.json`
and `contents/config/registries.json`. Concurrent installs from the Admin UI
on different hosts can conflict (last writer wins). Restrict marketplace
operations to a single admin host or a single CI pipeline.

## Operations

### Deploy / rolling restart

A safe rolling restart looks like this:

1. Sync the new `contents/` snapshot to the shared volume (atomic
   directory swap is best).
2. Drain host A from the load balancer (let in-flight chats finish, e.g.
   30–60 s grace).
3. Restart host A. It re-runs migrations (the file lock prevents others
   from doing the same simultaneously) and reloads all caches.
4. Re-add host A to the LB and wait for health checks.
5. Repeat for host B, etc.

`SIGTERM` to the primary process forwards to all workers and exits after a
5 s grace period — pair that with the LB drain so users in mid-stream get a
chance to finish.

### Migrations

`server/migrations/runner.js` uses `contents/.migration-lock` (filesystem
advisory lock with a 5 minute timeout) so only one host actually runs
migrations on startup. The others wait for the lock, observe the updated
`contents/.migration-history.json`, and continue.

This works **only** if all hosts share the same `contents/` directory. With
per-host copies, every host runs every migration on its own copy and they
will diverge.

### Health checks

Use `GET /api/health` for liveness/readiness on each host. The endpoint is
stateless; it does not require sticky routing.

### Logs

`server/telemetry/` and `server/telemetry.js` write to local files by
default. Aggregate them with whatever you already use for stdout/stderr
collection (Loki, ELK, CloudWatch, Datadog). Do not share log files across
hosts on the volume — append from multiple writers is not safe.

### Encryption key bootstrap

On first boot the server generates `contents/.encryption-key` if missing.
**For multi-host setups, generate the key once and provision it before the
first host starts** — either by writing the file to the shared volume in
advance, or by setting `TOKEN_ENCRYPTION_KEY` in the environment.

If you let two hosts race to generate the key, one of them silently wins
and the other sees its `ENC[...]` reads fail — depending on filesystem
ordering. The symptom is auth integrations breaking apparently at random.
See [encryption-key-management.md](encryption-key-management.md).

### CORS and base URLs

If hosts sit behind a single user-facing domain, CORS / `ALLOWED_ORIGINS`
should reference **the public domain**, not individual host names. See
[production-reverse-proxy-guide.md](production-reverse-proxy-guide.md).

## Decision matrix

| Concern                              | Acceptable?              | Mitigation if not                                              |
| ------------------------------------ | ------------------------ | -------------------------------------------------------------- |
| Per-host rate limit counters         | Usually yes              | Implement Redis-backed rate-limit store                        |
| Stats undercount / split             | For directional metrics  | Aggregate from telemetry events instead                        |
| Up-to-5-min config propagation lag   | For non-urgent configs   | Rolling restart after sync; keep config flow in CI             |
| SSE drop on host crash               | Unavoidable (current)    | Auto-reconnect on the client; expect retry                     |
| No Admin UI edits in prod            | Strongly recommended     | Read-only mount for `contents/config/`; lock down `adminAccess`|
| Single-host marketplace operations   | Recommended              | Pin install/update operations to one host or a CI job          |

## When **not** to go multi-host

If you have any of the following, single-host with the sticky cluster is
likely the better answer:

- Fewer than ~500 concurrent chat users.
- Strict requirement for accurate, real-time global stats.
- No appetite for shared filesystem operations.
- No ops capability to maintain a sticky load balancer in production.

Vertical scaling (more cores, more RAM, larger `WORKERS=N`) gets you a long
way before multi-host is worth the operational cost.

## Related

- [Scaling with Multiple Workers](scaling.md) — single-host clustering
- [Production Reverse Proxy Guide](production-reverse-proxy-guide.md) — TLS,
  subpath, headers
- [Rate Limiting](rate-limiting.md) — current per-process behaviour
- [Encryption Key Management](encryption-key-management.md) — bootstrapping
  the shared key
- [Configuration Migrations](configuration-migrations.md) — how startup
  migrations behave
- [Telemetry & Observability](telemetry.md) — central event collection
