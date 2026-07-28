# Scaling with Multiple Workers

iHub Apps runs a Node.js cluster so a single host can use multiple CPU cores
without breaking the streaming chat experience. The default is **4 workers**;
this page explains how it works, how to tune it, and what the trade-offs are.

## TL;DR

- **Default:** `WORKERS=4` in production, connections balanced round-robin.
- **No stickiness required.** Chat state that lands on the "wrong" worker is
  relayed to the right one over the cluster bus, so it is safe behind any load
  balancer — including a Kubernetes ingress with no session affinity.
- **Dev scripts (`npm run dev`, `npm run server`):** pinned to `WORKERS=1` for
  fast reloads and straightforward debugging.
- **Override:** set the `WORKERS` (or `NUM_WORKERS`) environment variable
  before starting the server.

```bash
# Start with 8 workers on port 8080
PORT=8080 WORKERS=8 npm run start:prod

# Disable clustering entirely
WORKERS=1 npm run start:prod
```

> **Changed in this release.** Earlier versions pinned each client to one
> worker by hashing its TCP peer address. Behind a reverse proxy that address is
> the same for everyone, so one worker served all traffic while the rest idled.
> Routing is now round-robin by default and the old behaviour is opt-in via
> `STICKY_SESSIONS=true` — see [Connection routing](#connection-routing).

## Why clustering

Node.js runs a single JavaScript thread per process. A chat request that ties
up the event loop (large tool-call fan-out, JSON parsing of a big response,
CPU-heavy middleware) blocks every concurrent request handled by that
process. On a multi-core host this leaves CPUs idle while latency climbs.
Cluster mode runs `N` worker processes behind one listening socket, so each
core can make progress independently.

## The cross-worker problem

Chat streaming state is in-memory per worker:

- `server/sse.js` holds two `Map`s (`clients`, `activeRequests`) keyed by
  `chatId`.
- `server/actionTracker.js` is a `Node.js EventEmitter` whose events only
  reach listeners in the same process.

A browser opens an SSE stream on `GET /api/apps/:appId/chat/:chatId` and then
POSTs prompts to the same URL. Those are two separate connections, so with any
balanced scheduler they routinely land on different workers. If the GET is on
worker A and the POST on worker B, worker B has no `clients` entry for that
chat — tokens never reach the browser and cancellations silently drop.

There are two ways to fix that: guarantee the connections land together, or
stop requiring it. iHub used to do the first and now does the second.

### The cluster bus

[`server/clusterBus.js`](../server/clusterBus.js) gives workers two primitives,
both no-ops outside cluster mode:

- **Pub/sub.** A worker publishes a message and the primary forwards it. The
  primary never interprets payloads; it is a repeater.
- **Presence.** `clients`, `activeRequests` and `activeWorkflowExecutions` are
  `Map`s that announce their membership. The primary mirrors the resulting
  `chatId → worker` table into every worker, so any worker can answer "who holds
  this chat?" synchronously, without a round trip.

With that in place, `sse.js` delivers an event locally when it owns the stream
and relays it to the owning worker when it does not. The primary knows the
owner, so relayed events are addressed to that single worker rather than
broadcast. The same mechanism carries the three control paths that used to
assume co-location: aborting the LLM call when the browser disconnects or hits
stop, cancelling a chat-triggered workflow, and replaying workflow progress on
reconnect.

Affinity therefore becomes a performance detail rather than a correctness
precondition.

### Connection routing

Because the bus removes the affinity requirement, connections are distributed
by Node's own round-robin cluster scheduler: workers share the listening socket
and each new connection goes to the next worker. The primary holds only the
bus.

`STICKY_SESSIONS=true` restores the previous router, in which the primary owns
the TCP socket and hands each connection to `sha256(remoteAddress) %
workerCount`. That is only meaningful when clients reach iHub directly — see
[Limitations](#limitations) — and chat no longer needs it. Reach for it only if
something outside the chat path in your deployment depends on connection
affinity.

Relevant code: [`server/clusterBus.js`](../server/clusterBus.js),
[`server/clusterSticky.js`](../server/clusterSticky.js) and the primary/worker
branches in [`server/server.js`](../server/server.js).

## Configuration

| Variable          | Default | Description                                                            |
| ----------------- | ------- | ---------------------------------------------------------------------- |
| `WORKERS`         | `4`     | Number of worker processes. `1` = no cluster.                          |
| `NUM_WORKERS`     | `4`     | Alias of `WORKERS` (accepted for backwards-compat).                    |
| `STICKY_SESSIONS` | `false` | Pin each client to one worker by hashing its TCP peer address.         |

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

With `WORKERS > 1` the primary logs its routing mode, and each worker logs once
when it has bound the shared socket:

```
Primary process 1234 starting 4 workers { workerCount: 4, routing: 'round-robin' }
Cluster using round-robin connection scheduling; workers bind the port directly
Server is listening on all interfaces { port: 3000 }   x4, one per worker
```

With `STICKY_SESSIONS=true` the primary owns the socket instead, and you see the
old pair of messages plus the peer-address caveat:

```
Sticky cluster primary listening { host: '0.0.0.0', port: 3000, workerCount: 4 }
Worker ready for sticky connections { pid: 1245, workerIndex: '0' }
```

With `WORKERS=1` the server runs as a plain single process; it binds the port
itself, the cluster bus stays inactive, and you see the usual
`Server is listening on all interfaces` log.

### Crash recovery

If a worker exits (crash, OOM, signal), the primary logs a warning with the
exit code, forks a replacement into the same slot, and resumes routing to it.
It also retracts every presence entry the dead worker held, so the survivors
stop relaying events into a process that no longer exists. The replacement
pulls a snapshot of the current presence table on startup rather than beginning
blind.

Clients whose SSE stream was held by the dead worker lose the connection and
need to reconnect — the browser's reconnect logic handles this, but any
mid-stream tokens are dropped. Note that the reconnect can now land on any
worker; the pending-workflow backfill is mirrored cluster-wide so a finished
workflow still fills in the chat bubble wherever the browser comes back.

### Shutdown

`SIGTERM` / `SIGINT` on the primary forwards the signal to all workers and
then exits after a 5-second grace period. Use a process supervisor
(systemd, Docker, PM2, Kubernetes) to orchestrate rolling restarts.

## Limitations

### Uneven load with STICKY_SESSIONS behind NAT / proxies

This is the failure the default routing exists to avoid. It applies only when
you set `STICKY_SESSIONS=true`.

Sticky routing hashes the **TCP peer address** — the only client identity
available before any HTTP byte is parsed. Everyone arriving through the same hop
therefore lands on the same worker:

- **Behind a reverse proxy or ingress — i.e. most production deployments — that
  is all traffic.** One worker serves every request while the other `WORKERS - 1`
  processes stay idle, so the effective capacity is a single process no matter
  what `WORKERS` says. A saturated worker then looks like a dead server: requests
  queue, and health probes queue with them.
- Behind corporate NAT or a shared VPN egress it is every user on that egress IP.

`X-Forwarded-For` does not help: the sticky router runs at the TCP layer, in the
primary process, before any HTTP parsing. Neither would a JWT or a cookie — the
router has no HTTP bytes to read them from, HTTP keep-alive means one upstream
connection can carry requests from several different users, and anonymous
traffic carries no identity at all.

The primary logs the caveat once at startup whenever sticky routing is on with
`WORKERS > 1`. **The fix is to unset `STICKY_SESSIONS`**: chat no longer needs
affinity, and round-robin uses every worker regardless of what the peer address
looks like.

### Cross-worker relay cost

Relayed events cross the process boundary twice (producer → primary → owner) and
are JSON-serialised each way. Chat chunks are small, delivery is addressed
rather than broadcast, and in round-robin mode the primary has no other work —
but token traffic for cross-worker chats does pass through a single process.
With `WORKERS=N`, roughly `(N-1)/N` of chats are cross-worker.

If that becomes the bottleneck, the answer is more replicas rather than more
workers per replica: each replica's bus is independent.

### Worker-local state

The bus covers the chat path (SSE delivery, abort, workflow cancel and replay,
pending-finish backfill). Other worker-local state is unchanged, and round-robin
routing means requests from one user now spread across workers rather than
landing on one:

- **Rate-limit counters are per worker.** With `WORKERS=N` the effective limit
  for a given key is up to `N ×` the configured value. Size limits accordingly,
  or enforce them at the ingress. See [rate limiting](rate-limiting.md).
- **Voice connection caps are per worker** — see
  [below](#realtime-voice-websocket-and-workers).
- **Workflow engine state** is file-persisted with an in-process cache, so a
  read from a worker that is not running the execution can be stale. The chat
  paths route around this by asking the owning worker to act; direct admin reads
  of a running execution can lag.

Any new feature needing cross-worker visibility should either use the bus
(`publish`/`subscribe` plus a presence map), persist to the shared `contents/`
directory, or stay strictly per-request.

### Session failover

A chat's SSE stream lives on one worker for its lifetime. If that worker
crashes, the stream drops and the browser must reconnect (and the assistant
response in progress is lost). The reconnect can land on any worker and will
pick up correctly, but the in-flight response is gone. For true mid-response
failover you would need to externalise the SSE fan-out and the generation
itself; that is not planned.

### Cross-pod, not cross-worker

Everything on this page is scoped to workers **inside one process tree**. The
bus rides `node:cluster` IPC, so it does not span Kubernetes pods or hosts. Two
replicas still need session affinity at the ingress, or the SSE GET and the chat
POST can land on different pods with nothing to relay between them. See
[Kubernetes](#kubernetes) below and
[multi-server deployment](multi-server-deployment.md).

Making the bus cross-pod is a matter of backing `publish`/`subscribe` with Redis
instead of `process.send`; the interface was kept narrow for that reason. It is
not implemented.

## Kubernetes

Two working configurations, depending on whether you scale up or out.

**Single replica, several workers.** Nothing special: set `WORKERS` to the pod's
CPU limit and leave routing alone. This is the case that used to collapse onto
one worker behind the ingress and no longer does.

```yaml
env:
  - name: WORKERS
    value: '4' # match the CPU limit, not the node's core count
resources:
  limits:
    cpu: '4'
```

**Several replicas.** The bus does not span pods, so the ingress has to keep a
chat on one pod. Cookie affinity at L7 is the mechanism — `sessionAffinity:
ClientIP` on the Service is **not** a substitute, since it keys on the ingress
controller's address and sends everything to one pod, reproducing the original
bug one layer up.

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/affinity: 'cookie'
    nginx.ingress.kubernetes.io/session-cookie-name: 'ihub-affinity'
    nginx.ingress.kubernetes.io/affinity-mode: 'persistent'
    # SSE needs an unbuffered, long-lived upstream connection
    nginx.ingress.kubernetes.io/proxy-buffering: 'off'
    nginx.ingress.kubernetes.io/proxy-read-timeout: '3600'
```

Multiple replicas also require a shared `contents/` volume and identical
secrets across pods — read
[multi-server deployment](multi-server-deployment.md) before enabling it.

Set `trustProxy` to the real hop count so `req.ip` is the client rather than the
ingress; this fixes rate-limit and audit-log attribution — see
[rate limiting](rate-limiting.md#proxy-hops-and-the-rate-limit-key).

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
| **Round-robin + cluster IPC bus (this page)** | **Shipping** | Even load behind any proxy; no new deps; relays per-chat events between workers.         |
| Plain round-robin, no bus                     | Rejected     | Breaks SSE streaming (per-worker in-memory state).                                       |
| Sticky IP-hash router                         | Opt-in       | `STICKY_SESSIONS=true`. Collapses onto one worker behind a proxy.                        |
| Sticky routing on a JWT or cookie             | Rejected     | The router sees no HTTP bytes; keep-alive multiplexes users onto one upstream connection; anonymous traffic has no token. |
| Redis pub/sub fan-out                         | Deferred     | Would extend the same bus interface across pods, plus clean failover. Adds Redis.        |
| PM2 cluster mode                              | Rejected     | PM2's built-in LB is round-robin — same SSE problem.                                     |
| Multi-instance + nginx cookie stickiness      | Compatible   | Works; recommended when fronting multiple boxes. Orthogonal to this feature.             |

## Realtime voice WebSocket and workers

The realtime voice endpoint (`/api/voice/realtime`, used by dictation and
transcription — see [Realtime Voice & Transcription](voice-transcription.md))
attaches per worker. A WebSocket rides a single TCP connection for its whole
lifetime, so whichever worker accepts the upgrade handles the entire session —
no routing coordination is needed under either scheduling mode. Two things to
remember when tuning:

- The voice connection caps (`platform.speech.realtime.maxConnections`,
  default 50, and `maxConnectionsPerUser`, default 3) are enforced **per
  worker process**. With `WORKERS=4` the instance-wide ceiling is 4 x 50
  concurrent voice sessions. Size `maxConnections` as *per-GPU budget /
  worker count*.
