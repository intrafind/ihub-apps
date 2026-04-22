# Scaling with Multiple Workers

iHub Apps ships with a sticky-session Node.js cluster so a single host can use
multiple CPU cores without breaking the streaming chat experience. The default
is **4 workers**; this page explains how it works, how to tune it, and what
the trade-offs are.

## TL;DR

- **Default:** `WORKERS=4` in production.
- **Dev scripts (`npm run dev`, `npm run server`):** pinned to `WORKERS=1` for
  fast reloads and straightforward debugging.
- **Override:** set the `WORKERS` (or `NUM_WORKERS`) environment variable
  before starting the server.
- **Do not** put the worker count behind a reverse proxy load balancer without
  stickiness — see the [Limitations](#limitations) section.

```bash
# Start with 8 workers on port 8080
PORT=8080 WORKERS=8 npm run start:prod

# Disable clustering entirely
WORKERS=1 npm run start:prod
```

## Why clustering

Node.js runs a single JavaScript thread per process. A chat request that ties
up the event loop (large tool-call fan-out, JSON parsing of a big response,
CPU-heavy middleware) blocks every concurrent request handled by that
process. On a multi-core host this leaves CPUs idle while latency climbs.
Cluster mode runs `N` worker processes behind one listening socket, so each
core can make progress independently.

## Why sticky sessions

The standard `node:cluster` scheduler distributes connections round-robin.
That breaks iHub's chat flow because streaming state is in-memory per worker:

- `server/sse.js` holds two `Map`s (`clients`, `activeRequests`) keyed by
  `chatId`.
- `server/actionTracker.js` is a `Node.js EventEmitter` whose events only
  reach listeners in the same process.

A browser opens an SSE stream on `GET /api/apps/:appId/chat/:chatId` and then
POSTs prompts to the same URL. If the GET lands on worker A but the POST
lands on worker B, worker B has no `clients` entry for that chat, so tokens
never reach the browser and cancellations silently drop.

To keep chats consistent, every connection from a given client must route to
the same worker. iHub does this by running a small sticky router in the
primary process:

1. The primary owns the real TCP listening socket (`net.createServer` with
   `pauseOnConnect: true`).
2. On each incoming connection it hashes the client's remote address
   (`sha256(remoteAddress) % workerCount`) to pick a worker.
3. The paused socket handle is forwarded to the chosen worker via IPC.
4. The worker re-emits the connection on its HTTP server and resumes it.

All in-memory per-chat state therefore stays in one process, without any
cross-worker coordination or external broker.

Relevant code: [`server/clusterSticky.js`](../server/clusterSticky.js) and
the primary/worker branches in [`server/server.js`](../server/server.js).

## Configuration

| Variable      | Default | Description                                           |
| ------------- | ------- | ----------------------------------------------------- |
| `WORKERS`     | `4`     | Number of worker processes. `1` = no cluster.         |
| `NUM_WORKERS` | `4`     | Alias of `WORKERS` (accepted for backwards-compat).   |

`WORKERS` is read **once at process start** by `server/config.js`. Changing
it at runtime has no effect — see [Why it is not in the Admin UI](#why-it-is-not-in-the-admin-ui).

### Picking a value

- **Small dev box / single-user:** `1`.
- **Production host:** start with `min(cpuCores, 4)`. Profile and go higher
  only if CPU utilisation on all workers is sustained above ~70%.
- **Docker / Kubernetes:** match `WORKERS` to the CPU limit assigned to the
  container, not to the host's physical cores. A 2-core container running
  `WORKERS=8` will thrash the scheduler.
- **Memory budget:** each worker holds its own copy of the config cache,
  loaded adapters, and in-flight state. Budget roughly 200–400 MB per worker.

## Startup behaviour

With `WORKERS > 1` the primary logs:

```
Primary process 1234 starting 4 workers
Sticky cluster primary listening { host: '0.0.0.0', port: 3000, workerCount: 4 }
```

Each worker logs exactly once when it is ready to receive forwarded
connections:

```
Worker ready for sticky connections { pid: 1245, workerIndex: '0' }
Worker ready for sticky connections { pid: 1246, workerIndex: '1' }
...
```

With `WORKERS=1` the server runs as a plain single process; it binds the port
itself and you see the usual `Server is listening on all interfaces` log.

### Crash recovery

If a worker exits (crash, OOM, signal), the primary logs a warning with the
exit code, forks a replacement into the same slot, and resumes routing to it.
Clients whose chat was pinned to the dead worker lose their SSE connection
and need to reconnect — the browser's reconnect logic handles this, but any
mid-stream tokens are dropped.

### Shutdown

`SIGTERM` / `SIGINT` on the primary forwards the signal to all workers and
then exits after a 5-second grace period. Use a process supervisor
(systemd, Docker, PM2, Kubernetes) to orchestrate rolling restarts.

## Limitations

### Uneven load behind NAT / proxies

Routing is hashed on source IP. If many users share one source IP (corporate
NAT, shared VPN egress, a fronting reverse proxy that does not preserve
client IPs), they all pile onto the same worker.

**Mitigations:**

- Put a stickiness-aware reverse proxy (nginx `hash $cookie_chatid consistent;`,
  HAProxy `balance uri` / cookie-based stickiness) in front of **multiple
  separate iHub instances**, each with its own port — then iHub's own
  cluster scales per-instance.
- Ensure upstream proxies forward `X-Forwarded-For` and that iHub sees the
  real client address. (Current build routes on `connection.remoteAddress`
  only, not on the `X-Forwarded-For` header — that would require parsing the
  HTTP request in the primary, which is a larger change.)

### Worker-local state

Any new feature that needs cross-worker visibility (shared rate-limit
counters, in-memory caches that must be coherent, cross-session pub/sub)
will not work out of the box. Options:

- Persist to disk or a database that every worker already reads.
- Introduce Redis pub/sub and have every worker subscribe.
- Keep the feature strictly per-chat (preferred — most existing code does
  this already).

### Session failover

A chat is pinned to a single worker for its lifetime. If that worker
crashes, the stream drops and the browser must reconnect (and the assistant
response in progress is lost). For strict failover you would need to
externalise the SSE fan-out to Redis; the trade-off is latency + operational
complexity, and it is not planned.

## Why it is not in the Admin UI

Worker count is an infrastructure setting, not a runtime setting, for two
reasons:

1. **No hot-apply path.** `cluster.fork()` happens once at startup. To change
   the count live you either (a) require a process restart — in which case an
   env var is simpler and more transparent, or (b) fork/kill workers on the
   fly, which drops every SSE stream and in-flight tool call on the affected
   worker mid-response. That is a poor experience.
2. **Scope mismatch.** Platform-level process concerns belong next to
   `PORT`, `HOST`, and SSL certificates — the deployment owner's domain. The
   Admin UI manages *content* (apps, prompts, models, groups), not the
   process topology.

If you want visibility without the foot-guns, add a read-only display in a
future "Server info" panel showing `WORKERS` alongside `PORT`, `HOST`, and
the Node version.

## Alternatives considered

| Option                                        | Status       | Notes                                                                                    |
| --------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| Default round-robin cluster                   | Rejected     | Breaks SSE streaming (per-worker in-memory state).                                       |
| **Sticky session cluster (this page)**        | **Shipping** | Simple; IP-hashed routing; no new deps; handles the common case.                         |
| Redis pub/sub fan-out                         | Deferred     | Enables true cross-worker delivery and clean failover. Adds Redis + ~a week of refactor. |
| PM2 cluster mode                              | Rejected     | PM2's built-in LB is round-robin — same SSE problem.                                     |
| Multi-instance + nginx cookie stickiness      | Compatible   | Works; recommended when fronting multiple boxes. Orthogonal to this feature.             |
