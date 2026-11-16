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
3. Keep the shared `contents/` volume as the only shared state (§8 covers the case without one), and verify the file locks and
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
| C. Redis or NATS behind the bus | one service | not required | Least code. One more thing to run, secure and monitor at every customer. Worked out in §9. |
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
- **TLS:** mandatory. Links are `wss://` only, and a pod refuses a plaintext link; there is no
  setting to turn this off. The handshake authenticates the peer but does not encrypt the link,
  and a reconnect to a running turn can carry chat content. Every pod therefore needs a
  certificate the other pods trust; the client side merges `getWebSocketTlsOptions(url)` so a
  private CA works (`server/utils/httpConfig.js`).
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
- **A pod that cannot reach a live leader** (§4.9) refuses logins until the link is back. It
  does not fall back to its own counters, so the lockout limit cannot be exceeded across a
  partition. Sessions that already exist keep working. Rate limits and throttling count locally
  until the link is back.

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
| A pod loses its link to a live leader (phase 2) | That pod refuses new logins until the link is back; existing sessions keep working. Rate limits and throttling count locally. |

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
2. Is "limit × pods" acceptable for login lockout until phase 5?
3. Should a pod with `WORKERS=1` be allowed in a mesh, or does a mesh require a primary?
4. How do clients without cookies (MCP, API keys, Office add-in, browser extension) behave behind
   cookie affinity today? If they already break, phase 2 is more urgent than the sizing numbers
   suggest.
5. Does the PostgreSQL plan (storage design §10) stay, with the mesh as the transport for
   installations without a database, or does the mesh replace the LISTEN/NOTIFY transport?
6. If a customer cannot provide a shared volume: is the reason that the cluster only offers
   single-node volumes, or that nothing shared is allowed at all? And is S3-compatible object
   storage available there? See §8.
7. Is a broker (NATS, Redis or Valkey) acceptable as a required component for installations with
   several pods? Do customers already run one? See §9.
8. Without a shared volume and with configuration replicated from the leader pod (§8): how long
   may a pod keep serving after it loses the link to the leader, before it reports not ready?

## 7. Documentation to fix independently of this proposal

`docs/multi-server-deployment.md` is out of date: it recommends `sessionAffinity: ClientIP`, which
`docs/scaling.md` describes as sending all traffic to one pod, and it still describes the sticky
cluster and a `MemoryStore`-era rate limiter.

## 8. Without a shared volume

Everything above assumes one `contents/` directory that all pods read and write. The mesh moves
live traffic between pods; it does not store anything. Without the volume, four kinds of state
need another home:

| State | Size and write rate | Today |
| --- | --- | --- |
| Configuration (apps, models, groups, platform) | small, written by admins | files, cached per worker |
| Keys and secrets | tiny, written once | files, or environment variables |
| Runtime data: chats, run ledger, uploads, project documents and indexes | about 50 GB per month for 1,000 employees (`docs/sizing.md`), written on every turn | storage provider on the filesystem |
| Coordination: locks, leases, the scheduler owner, the leader pod (§4.6), peer discovery by lease files (§4.3) | tiny, written often | lease files |

### Options

| Option | New code in iHub | What it costs |
| --- | --- | --- |
| A. Build the shared volume inside the cluster: an NFS server pod on a single-node volume, or a storage layer such as Longhorn or Rook-CephFS | none | One more thing to run. A single NFS pod is a single point of failure for all iHub pods. The tests of §4.7 apply unchanged. |
| B. Object storage (S3-compatible) as the storage provider | a new provider | Not a file system and not a database. See below. |
| C. One volume per pod, replicated over the bus | a replication layer | This is building a replicated database: ordering of writes, conflicts, bringing a new pod up to date (copying 150 GB), and electing a leader without a shared lease. Not proposed for runtime data. |
| D. One volume per pod, each user pinned to a pod | routing by user at the ingress | No availability gain: a lost pod takes its users' chats offline. Shared projects would live on one pod only. Not proposed. |
| E. A database (the PostgreSQL plan, storage design §10) | planned there | Outside the goal of this document. Uploads and artifacts still need a shared volume or object storage in that plan. |

### B in more detail

The storage provider is already split into facets (`server/storage/`), and they map to an object
store to different degrees:

- **Blobs** (`BlobStore`) were designed with an S3-compatible backend in mind: put, get, delete,
  list.
- **Documents** (`DocumentStore`) become one object each. The etag-guarded writes need conditional
  writes in the object store; whether the stores customers use support them must be checked per
  store.
- **Locks** (`LockManager`) need a create-if-absent with expiry, again built on conditional writes.
- **Append logs** (`AppendLog`, the run ledger) are the poor fit, and the reason the storage design
  dropped S3: an object cannot be appended to. With the mesh, live events travel over the bus, so
  the ledger could be written as batched segment objects; a pod that dies loses the events of its
  last unwritten batch.
- **Change notifications** ride the bus (§4.7 item 4).
- **Search indexes of projects** are files read into memory today; they would be downloaded to a
  local cache per pod.

The provider conformance suite is the acceptance gate, as for every other provider. Latency per
read is higher than on a local volume, so the load test of phase 4 has to be repeated on it.

### What changes in the mesh proposal

- Peer discovery works by DNS only (§4.3, source 1).
- The leader pod (§4.6) and the scheduler owner need a lease that is not a file on the volume: a
  conditional write in the object store, or the Kubernetes Lease API.
- Keys and secrets come from environment variables on every pod, as `docs/scaling.md` already
  requires for several replicas.
- Configuration is small and has few writers, so it is the one state where option C is realistic
  on its own: the leader pod is the only writer and the others receive each change over the bus.
  With option B it is simply another namespace in the object store. Option C for configuration
  needs these rules, because without a shared volume there is no file to re-read and the TTL
  refresh of §4.9 has nothing to fall back on:
  - Every change carries a version number that only grows. A pod that receives a version it does
    not expect next knows it missed one.
  - The snapshot of §4.4 does not include configuration. A pod that starts, reconnects or detects
    a gap asks the leader for the whole configuration and its version, and applies it before it
    takes requests again.
  - A pod that is not current reports itself as not ready, so the ingress stops sending it
    requests. That covers a pod that has no link to the leader: it cannot know whether groups or
    permissions changed, so it does not keep serving with the copy it has. How long a pod may
    keep serving after it loses the link, before it reports not ready, is open question 8.

### Recommendation

1. Find out why there is no shared volume (open question 6). If the cluster only offers
   single-node volumes, option A works today with no change to iHub.
2. As the product answer, option B. It is a substantial provider, and it removes the dependence
   on NFS behaviour that §4.7 lists as the main risk.
3. If nothing shared is allowed, neither a volume nor object storage, there is no way to run
   several pods without a database short of building one (option C). The choice is then between
   option E and one pod.

## 9. With a broker: NATS or Redis

Option C of §3. It gives up the goal of adding no new component, and in return removes most of
the custom protocol of §4: no links between pods, no peer discovery, no replicated presence and
no leader pod. This section describes what it would look like, so the two routes can be compared.
Nothing here was built or measured, and the features named for each broker need checking against
the version that would be shipped.

### 9.1 Topology

```
   Pod A                         Pod B
 worker  worker                worker  worker
    \      |                     |      /
     \     |                     |     /
      ──────┴──── broker ────────┴─────
              (3 nodes for availability)
```

- **Every worker connects to the broker itself.** The primary no longer relays anything. The rule
  "vCPU = workers + 1" (`docs/sizing.md`) and the single-core ceiling of the primary go away.
- **Pods are interchangeable.** The ingress needs no affinity, and scaling means adding pods, also
  small ones with one or two workers.
- **The bus interface stays.** The modules of §2 keep calling `publish`, `subscribe`, `request`
  and the presence maps of `server/clusterBus.js`. The IPC transport stays as well, for one pod
  without a broker: development, the binary build, small installations.

### 9.2 What the broker replaces

| Bus function today | NATS | Redis |
| --- | --- | --- |
| Publish to all other workers | subject | Pub/Sub channel |
| Message to the worker that holds a chat or run | one subject per chat or run; the holder is subscribed, nobody needs to know who it is | one channel per chat or run |
| Presence maps (who holds what) | mostly unnecessary; a request to a subject nobody listens on is answered at once with "no responders" | keys with an expiry |
| Request/reply and gather | built in | built on Pub/Sub with reply channels, as the bus does today |
| Counters held by the primary (§4.6) | key-value store with compare-and-set | atomic increment with expiry; the simplest fit |
| Scheduler owner and other "only one pod does this" leases | key-value entry created only if absent, with a time-to-live | `SET` with "only if absent" and an expiry |
| Locks that guard writes to stored data | stay with the storage provider, see §9.5 | stay with the storage provider, see §9.5 |
| Config invalidation | subject, or a watch on a key-value bucket | channel |
| Live events of a run, and replay after a reconnect | JetStream stream, read from a sequence number | Redis Stream, read from an entry id |
| Links between pods: discovery, handshake, snapshot (§4.2–4.4) | not needed | not needed |
| Leader pod (§4.6) | not needed | not needed |

The ids of §4.5 must still be unique across pods.

### 9.3 Who streams, and how

1. The worker that runs the turn publishes each event to the subject or stream of that run.
2. The worker that holds the browser's connection reads it and writes the SSE response. With
   [Chat Streaming on the POST Response](./2026-10-05%20Chat%20Streaming%20on%20the%20POST%20Response.md)
   these are the same worker: it writes to the response directly and publishes only so that the
   events are kept and other readers can follow.
3. After a reload, in a second tab, or when a pod was lost, any pod reads the run from the last
   sequence the client has seen: first the events it missed, then the live ones.

This is what the run ledger does today with files and a per-run sequence
(`GET /api/runs/:id/events?after=<seq>`). Delivery then survives the loss of a pod. The generation
itself still ends with the worker that runs it.

Load: one pod at its planned capacity (700 test users × 1.35 messages per minute, 250 tokens per
answer in the load test) produces about 4,000 events per second if every token is one event. That
is small for either broker, but publishing with a write acknowledgement per event is not free;
batching, or live events without acknowledgement plus a batched durable copy, needs measuring.

### 9.4 NATS or Redis

| | NATS with JetStream | Redis (or Valkey) |
| --- | --- | --- |
| Where data lives | on disk, on each broker node's own volume | in memory, with snapshots or an append-only file; the data has to fit into memory |
| Availability | three nodes with a quorum; an acknowledged write survives the loss of one node | Sentinel or Cluster with asynchronous replication; a failover can lose writes that were already acknowledged |
| Run ledger | can hold the whole ledger with a retention time | only the live window, capped by length or age; the ledger stays on the storage provider |
| Documents and files | has a key-value store and an object store, so it could replace the shared volume of §8 — and would then be the database | not suitable |
| Counters | compare-and-set loop | native atomic increment |
| Request/reply | native | to be built |
| At customers | less common; usually a new service for them | common, often already running, available as a managed service |
| Licence | Apache-2.0 | changed in 2024 and 2025; Valkey is the BSD-licensed fork. To be checked before anything is bundled. |

Either client is a new outbound connection and must honour the SSL whitelist: its TLS options
take `getTlsBypassOptions(url)` from `server/utils/httpConfig.js`, with a test for a whitelisted
and a non-whitelisted host. TLS to the broker is mandatory, as for the links of §4.2.

### 9.5 What a broker does not solve

- **Storage.** Chats, uploads, project documents and configuration still need a home all pods
  reach: the shared volume (§4.7), object storage, or a database (§8). Putting documents and
  files into NATS as well removes the shared volume, but makes NATS the system of record for
  about 50 GB per month, with listing by owner built on key names.
- **Locks on stored data.** A lock that guards a read-modify-write of stored data belongs to the
  storage provider's `LockManager`, not to the broker: lease files on a shared volume, conditional
  writes on object storage. There is one lock system per installation, never two side by side,
  because a file lease and a broker lock do not exclude each other. On a shared volume this means
  item 2 of §4.7 (lease files) stays and must pass its tests; item 3 (the scheduler lock) can
  move to the broker; item 1 (attribute caching) stays.
- **Availability of the broker.** It becomes the one thing every pod depends on. When it is
  unreachable:
  - Writes to stored data stay safe, because their locks are not on the broker. Turns a pod runs
    and streams itself keep working and are stored.
  - Stop and steering from another pod fail, and a reconnect on another pod cannot follow a
    running turn until the broker is back.
  - Config changes arrive with the TTL refresh from the shared storage.
  - Nothing that needs a broker lease runs: no scheduled tasks until the broker is back.
  - By the decision of §4.6, new logins are refused.

  If an installation has no storage with usable locks, locks would have to live on the broker.
  Then every write that needs a lock waits for the broker and fails when the wait times out, as
  `withLock` does today (`LockTimeoutError`; the guarded code never runs without the lock), and
  turns that need such a write fail during an outage.
- **POST-response streaming** is still worth doing first: it takes the token traffic of ordinary
  turns off the broker's critical path.

### 9.6 Mesh or broker

| | Mesh of primaries (§4) | Broker |
| --- | --- | --- |
| New component at the customer | none | one, three nodes for availability |
| Code in iHub | transport, discovery, handshake, replicated presence, leader pod | a transport behind the bus interface; counters and leases on the broker |
| Primary as relay | stays, also between pods | gone |
| Counters across pods | leader pod, with the partition cases of §4.6 | one shared counter |
| Mid-run reconnect on another pod | relay from the pod that runs the turn, or the ledger on the volume | read the run's stream from a sequence |
| Number of pods | full mesh, meant for a handful | not limited by the bus |

Recommendation:

1. Build one of the two, not both. Two cross-pod transports double the failure cases to test.
2. If a required broker is acceptable (open question 7), prefer it over the mesh: less protocol
   of our own to get right, and it removes the primary's ceiling.
3. NATS if the broker should also carry the run ledger and must not lose acknowledged events when
   a node fails. Redis or Valkey if customers already run it and the bus, counters and locks are
   enough, with the ledger staying on the storage provider.
4. If no new component is acceptable, the mesh of §4 remains the proposal.

Phases with a broker, replacing rows 2 and 5 of §5: a transport interface in `clusterBus.js` with
the IPC and the broker implementation and the ids of §4.5; then counters and leases on the broker;
then the load test with 2 and 4 pods; optionally the run ledger on JetStream.
