# Scaling Beyond One Pod Without a Database

**Date:** 2026-11-16
**Status:** Proposal, not implemented. Based on reading the code and docs; nothing here was built or measured.
**Related:**
[`docs/scaling.md`](../docs/scaling.md),
[`docs/multi-server-deployment.md`](../docs/multi-server-deployment.md),
[`docs/sizing.md`](../docs/sizing.md),
[2026-07-28 Round-Robin Worker-Local State Audit](./2026-07-28%20Round-Robin%20Worker-Local%20State%20Audit.md),
[2026-10-05 Chat Streaming on the POST Response](./2026-10-05%20Chat%20Streaming%20on%20the%20POST%20Response.md),
[Storage Provider and Durable Chats Design](./persistence-layer/2026-09-09%20Storage%20Provider%20and%20Durable%20Chats%20Design.md) (§10 plans multi-instance on PostgreSQL)

## 1. Summary

iHub scales inside one pod by adding workers. The load tests put the ceiling of one pod at about
700 test users (planned at 70% of measured capacity, see `docs/sizing.md`), and one pod is also one
point of failure. Several pods are documented but need cookie affinity at the ingress, lose
cross-pod config invalidation, and were never load-tested.

The storage design plans multi-instance on PostgreSQL. This document describes a way to get there
**without a database and without Redis**:

1. Extend the cluster bus so the primaries of all pods talk to each other directly.
2. Move the chat stream onto the POST response, so little traffic has to cross pods.
3. Keep the shared `contents/` volume as the only shared state, and verify the file locks and
   cache re-validation on the volume type customers use.

What stays required: a shared read-write-many `contents/` volume, and the same secrets on every
pod.

## 2. Where we are

### Inside one pod

Workers share nothing in memory. `server/clusterBus.js` connects them through the primary with
four primitives: publish/subscribe, presence maps (who holds this chat stream, this run, this
session), request/reply, and gather. About 30 modules use it:

| Area | What crosses workers | Module |
| --- | --- | --- |
| Chat | stream events, abort, close, durable-turn marks | `server/sse.js` |
| Runs | ledger appends, stream relay, steering, interactions | `services/loop/RunLog.js`, `actionTracker.js`, `steering.js`, `InteractionService.js` |
| Workflows | cancel, replay, pending results | `tools/workflowRunner.js`, `services/workflow/WorkflowEngine.js`, `chatBridge.js` |
| Config | invalidation and apply-and-wait | `server/configSync.js` |
| Gateways | MCP sessions, A2A task cancel, tool jobs | `routes/mcpServer.js`, `services/mcp/a2aTaskStore.js`, `routes/toolsService/jobStore.js` |
| OAuth | single-use authorization codes | `utils/authorizationCodeStore.js` |
| Counters held by the primary | auth rate limits, login lockout, provider throttling, quota | `utils/clusterRateLimitStore.js`, `utils/loginLockout.js`, `requestThrottler.js`, `services/quota/QuotaLedger.js` |
| Diagnostics | system resources, update status, version check | `services/systemResources.js`, `updateService.js`, `versionCheckService.js` |

Everything else that must be shared is a file under `contents/`, guarded by lease files
(`utils/fileLock.js`), locked read-modify-write (`utils/sharedJsonFile.js`) or the storage
provider (`server/storage/`).

### Between pods

The bus rides `node:cluster` IPC and stops at the process tree. With two pods today:

| Symptom | Cause |
| --- | --- |
| Chat hangs unless the ingress pins a browser to one pod | The stream (GET) and the turn (POST) are two requests; nothing relays between pods. |
| Clients that do not return the affinity cookie land on any pod | Affinity is a cookie. MCP and API clients need checking; the MCP gateway has `stateless: true` for this. |
| An admin save reaches the other pods after up to 5 minutes | `configSync` announces over the bus; other pods only have the cache TTL. |
| Auth rate limits, login lockout and provider throttling count per pod | The counters live in each pod's primary. |
| Stop, cancel and steering only work on the pod that runs the turn | Routed by presence, which is per pod. |

The filesystem storage provider says the same about itself: `multiInstance: false`,
`notifications: 'in-process'`, `locking: 'advisory-single-machine'`
(`FilesystemStorageProvider.getCapabilities()`).

## 3. Options

| Option | New component | Sticky ingress | Verdict |
| --- | --- | --- | --- |
| A. Cookie affinity (documented today) | none | required | Works for browser chat. Leaves every symptom in the table above except the first. Not load-tested. |
| **B. Bus over a mesh of primaries** | none | not required | **Proposed.** Reuses the interface every module already speaks. |
| C. Redis or NATS behind the bus | one service | not required | Least code. One more thing to run, secure and monitor at every customer. |
| D. Bus over the shared volume (polled log) | none | not required | Too slow for tokens and for stop. Usable as a fallback for config invalidation. |
| E. PostgreSQL provider with LISTEN/NOTIFY (storage design §10) | a database | not required | Still the plan for customers who want a database. B does not block it: both sit behind the same bus interface. |

## 4. Proposal

### 4.1 Topology

```
            Pod A                                   Pod B
 ┌────────────────────────┐              ┌────────────────────────┐
 │ worker  worker  worker │              │ worker  worker  worker │
 │     \     |     /      │              │     \     |     /      │
 │      primary (hub) ◀───┼── bus link ──┼───▶ primary (hub)      │
 └───────────┬────────────┘              └───────────┬────────────┘
             └────────── shared contents/ ───────────┘
```

A worker already talks only to its primary. The primaries connect to each other; workers and the
modules that use the bus do not change. A pod with `WORKERS=1` has no primary today, so the single
process would have to join the mesh itself.

### 4.2 Transport

- One WebSocket between each pair of primaries (`ws` is already a dependency), on a separate
  internal port that the ingress does not expose. With n pods that is n(n−1)/2 links; fine for
  the pod counts in `docs/sizing.md` (up to 4).
- **Authentication:** challenge and response in both directions. Each side sends a random,
  single-use challenge for this connection; the other side answers with an HMAC over that
  challenge and both pod ids, keyed with a key derived from the JWT secret, which all pods must
  share anyway. A captured handshake is therefore useless on another connection. A link without
  a valid answer is closed, and no bus message is accepted before both sides have answered.
- **TLS:** `wss://` by default; the client side merges `getWebSocketTlsOptions(url)` so a private
  CA works (`server/utils/httpConfig.js`). The handshake authenticates the peer but does not
  encrypt the link, and a reconnect to a running turn can carry chat content. Whether plaintext
  may be allowed by an explicit setting, for clusters whose network already encrypts pod traffic,
  is open question 6.
- **Framing:** the JSON envelopes the IPC channel already carries.

### 4.3 Finding the other pods

Two sources, the first that is configured wins:

1. **A DNS name that resolves to all pods** (`BUS_PEERS_DNS`, a Kubernetes headless Service).
   Re-resolved every few seconds.
2. **Lease files on the shared volume** (`contents/data/bus-peers/<podId>.json` with address and a
   heartbeat). Needs no Kubernetes, so it also covers several hosts or Docker Compose.

`podId` is a random id generated at start. To avoid two links per pair, the pod with the smaller
id dials.

### 4.4 Presence

- The owner of an entry becomes `(podId, workerId)`. Each primary keeps its own table as today and
  mirrors the tables of its peers.
- On connect, each side takes its snapshot and starts forwarding changes in the same event-loop
  turn, so no set or delete can fall between the two. The link carries the snapshot first, then
  every later change in order.
- A link that closes retracts everything that pod held, the same way `cluster.on('exit')` does for
  a dead worker.
- A routed message whose owner is in another pod goes to that pod's primary, which delivers it to
  the worker. An unknown owner falls back to a broadcast to all pods, as today inside one pod.
- `lookupRemote()` asks the local primary, which now knows the other pods' entries as well.

Presence between pods lags by one more hop than inside a pod. The cases where a stale "no" loses
something (`sse.js`, #3674) need the same care: on a miss the primary asks its peers before
answering no.

### 4.5 Ids that are only unique inside one pod

In a container the primary is usually PID 1 and workers get the same small PIDs in every pod.
These must carry the `podId`:

| Where | Today | Effect across pods |
| --- | --- | --- |
| `clusterBus.js` `newRequestId()` | `${process.pid}:${n}` | A reply could settle another pod's pending request. |
| `configSync.js` | `origin: process.pid` | A pod could mistake another pod's announcement for its own. |
| `InteractionService.js` | `pid` in bus messages and in claims | Own-message filter and claim ownership could match the wrong process. |

Every other use of `process.pid` as an identity in `server/` needs the same review.

### 4.6 Counters held by the primary

`respondInPrimary` and `primaryOnly` mean "one process counts for everyone". With several pods
there are several primaries.

- **Phase 1:** leave them per pod and document it: auth rate limits, login lockout and provider
  throttling are "limit × pods". Quota is already correct across pods, because each primary merges
  into one shared file.
- **Phase 2:** elect one leader pod with a lease from the storage provider's `LockManager`, and
  route `primaryOnly` questions to the leader. When the leader dies, counters restart at zero on
  the next leader; for rate limits and throttling that is acceptable, for login lockout it needs a
  decision.
- **A pod that cannot reach a live leader** (§4.9) must not silently fall back to its own
  counters for login lockout, or the limit can be exceeded across the partition. Rate limits and
  throttling may count locally until the link is back. For login lockout the choice is between
  refusing logins on that pod and a local limit that is safe on its own (the configured limit
  divided by the number of pods); see open question 2.

### 4.7 Storage on a shared volume

No database means the volume carries all shared state. Open points, in order of risk:

1. **Attribute caching on NFS.** `sharedJsonFile.js` re-validates its cache by inode, mtime and
   size. An NFS client may answer `stat` from its attribute cache for seconds, so a pod could keep
   a stale copy and write it back. Needs a test on NFSv4, CephFS and Azure Files. Mount options
   that turn attribute caching off (`actimeo=0` or similar) are the control. A bus message that
   tells the other pods a file changed is not a substitute: it does not clear the attribute cache,
   and a pod that misses it stays stale. It could only help as an addition, by making the pod
   re-open and re-read the file without trusting `stat`, which relies on NFS close-to-open
   consistency and needs the same tests.
2. **Lease files.** `fileLock.js` builds on exclusive create (`O_EXCL`), which is atomic on NFSv4.
   The takeover of an expired lease and the fencing tokens need a run of the provider conformance
   suite with two hosts on one volume.
3. **Scheduler lock.** `schedulerLock.js` is written for replicas (TTL plus hostname), but it
   reads, decides and then writes. Two pods taking over an expired lock in the same moment needs
   checking.
4. **Change notifications.** The filesystem notifier is in-process. Bridging it onto the bus gives
   every pod the events; the provider can then declare `notifications: 'push'`.
5. **Capabilities.** After 1–4 hold, the filesystem provider declares `multiInstance: true` only
   when the bus mesh is active.

### 4.8 What crosses pods, and why POST-response streaming comes first

A chat turn uses a GET for the stream and a POST for the message. With p pods and no affinity,
about (p−1)/p of all turns would send every token worker → primary → primary → worker. The primary
is already the single-core ceiling inside a pod (`docs/sizing.md`: vCPU = workers + 1).

[Chat Streaming on the POST Response](./2026-10-05%20Chat%20Streaming%20on%20the%20POST%20Response.md)
puts the stream on the request that runs the turn. The bus then carries only:

- stop, cancel and steering for a turn on another pod,
- config invalidation,
- presence,
- a reconnect to a running turn (reload, second tab), which can also be served from the run ledger
  on the shared volume.

That is a few messages per turn, not one per token. The mesh works without it, but the load test
in phase 3 should not be run before it.

### 4.9 Failure behaviour

| Event | Result |
| --- | --- |
| A pod dies | Its streams drop. Peers retract its presence. A signed-in user reconnects on another pod and gets the stored chat; a turn that was running is lost, as with a dead worker today. |
| A bus link breaks, both pods alive | Each pod serves what it holds. Stop and steering for turns on the other pod fail until the link is back; config changes arrive with the TTL refresh. Links reconnect with backoff and exchange a new snapshot. |
| Rolling update | Pods join and leave the mesh one at a time. The envelope needs a version field from the first release, so two versions can run side by side. |
| Leader pod dies (phase 2) | The lease expires, another pod takes over, counters restart. |
| A pod loses its link to a live leader (phase 2) | Rate limits and throttling count locally until the link is back. Login lockout follows the policy chosen in §4.6. |

## 5. Phases

| # | Step | Depends on | Result |
| --- | --- | --- | --- |
| 1 | Chat streaming on the POST response | — | Less primary load inside one pod as well; little traffic left to cross pods. |
| 2 | Bus mesh: transport, discovery, presence with `podId`, unique ids | — | Stop, config changes, MCP sessions, tool jobs and run streams work across pods. No sticky ingress. |
| 3 | Storage on a shared volume: tests on real volume types, notifier on the bus | 2 | The filesystem provider may declare multi-instance. |
| 4 | Load test with 2 and 4 pods (`tests/load`), then update `docs/sizing.md` | 1–3 | Measured capacity for several pods. |
| 5 | Leader pod for the counters | 2 | Rate limits and throttling count once for the installation. |

Until step 4 is done, cookie affinity stays the documented setup for several pods.

## 6. Open questions

1. Which volume types do customers use for `contents/`? The answer decides how much of §4.7 is
   testing and how much is new code.
2. Is "limit × pods" acceptable for login lockout until phase 5? And from phase 5 on, what does a
   pod do for login lockout when it cannot reach the leader: refuse logins, or apply a reduced
   local limit?
3. Should a pod with `WORKERS=1` be allowed in a mesh, or does a mesh require a primary?
4. How do clients without cookies (MCP, API keys, Office add-in, browser extension) behave behind
   cookie affinity today? If they already break, phase 2 is more urgent than the sizing numbers
   suggest.
5. Does the PostgreSQL plan (storage design §10) stay, with the mesh as the transport for
   installations without a database, or does the mesh replace the LISTEN/NOTIFY transport?
6. Is TLS on the bus links mandatory, or may an installation turn it off when the cluster network
   already encrypts pod traffic (a service mesh, an encrypting CNI)? Mandatory TLS means every pod
   needs a certificate the other pods trust.

## 7. Documentation to fix independently of this proposal

`docs/multi-server-deployment.md` is out of date: it recommends `sessionAffinity: ClientIP`, which
`docs/scaling.md` describes as sending all traffic to one pod, and it still describes the sticky
cluster and a `MemoryStore`-era rate limiter.
