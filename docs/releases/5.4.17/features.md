# Features — 5.4.17

## Gemini Apps No Longer Corrupt Parallel Tool Calls

Fixed a bug where Gemini (Google) models calling more than one tool in the same turn could
silently lose one of the calls. When two tool calls arrived in separate streaming chunks, the
second one collided with the first instead of being tracked separately, corrupting its arguments
into invalid JSON and dropping the call entirely — with no error shown to the user.

- Apps and agent workflows on Gemini models that trigger multiple tools per turn (a common pattern
  for tool-using agents) now execute every tool call correctly.

## Health Probes and the Login Screen No Longer Lock Themselves Out With 429s

The brute-force limiter that protects login was applied to the whole `/api/auth` namespace,
including read-only endpoints nothing can avoid calling. Polling `/api/auth/status` — the call the
web app makes on every page load, and a natural choice for a container health probe — exhausted the
window (30 requests per 15 minutes in the shipped configuration) on its own, after which every
caller including the probe received
`429 Too Many Requests` until the window reset. The platform looked completely wedged.

- The strict limiter now covers only endpoints that actually verify credentials
  (`/api/auth/local/login`, the LDAP/NTLM logins, and the Teams token exchange). Brute-force
  protection is unchanged for those.
- Read-only endpoints — `/api/auth/status`, `/api/auth/user`, the provider-discovery endpoints, the
  OIDC sign-in and callback redirects, and `/api/auth/logout` — are covered by the generous public
  API limiter instead. A single exhausted window can no longer block SSO sign-ins or logouts for
  everyone.
- Health probes are best pointed at `/api/health`, which has never been rate limited.

## New `trustProxy` Setting for Deployments Behind More Than One Proxy

`platform.json` now takes a `trustProxy` value: the number of proxy hops in front of iHub (it also
accepts `true`/`false` or a list of trusted addresses and subnets). It decides what iHub sees as the
client address, which is both the rate-limit key and the address recorded in the audit log.

- The default is `1`, matching the previous hard-coded behaviour — nothing changes on upgrade.
- Raise it if iHub sits behind more than one hop, e.g. an ingress plus an internal load balancer.
  With a value that is too low, every caller behind the inner proxy is seen as the *same* client, so
  they all share one rate-limit counter and one busy client can exhaust the auth or OAuth window for
  the whole deployment. Audit entries also record the proxy rather than the user's address.

```json
{
  "trustProxy": 2
}
```

## MCP Gateway `405` Responses Are Now Diagnosable

A `GET /mcp` rejected with `405` was returned without a log line, so the three very different causes
were indistinguishable from the server side. Each rejection is now logged under the `McpGateway`
component with the request's method, user, user agent, and whether an `Mcp-Session-Id` header
arrived.

- Most `405`s are harmless: a Streamable HTTP client probing for the optional server-initiated SSE
  stream. Tools still list and run — nothing to fix.
- A `405` a client cannot recover from means it is configured for the legacy SSE transport but
  pointed at `/mcp`; the error message now names `/mcp/sse` explicitly.
- A `405` with no session header *after* a successful handshake means a reverse proxy is stripping
  the `Mcp-Session-Id` header — allow it (and `MCP-Protocol-Version`) through.

## Clustering Now Warns When Sticky Routing Collapses Onto One Worker

With `WORKERS` greater than 1, the primary process hands each connection to a worker chosen from the
TCP peer address. Behind a reverse proxy that address is identical for every request, so all traffic
lands on a single worker while the others stay idle — and a saturated worker looks like a dead
server, health probes included.

- The primary now logs this once at startup instead of leaving it to be discovered under load.
- To actually use several workers, either expose iHub directly, or run `WORKERS=1` with multiple
  replicas behind proxy-level session stickiness.

## Clustered Deployments Now Use Every Worker Behind a Proxy

Worker processes no longer need each client pinned to one of them. Chat streaming state that lands
on a different worker than the one holding the browser's connection is relayed internally, so
connections are distributed evenly instead of hashed by network address.

- Previously, routing hashed the client's TCP address. Behind a reverse proxy or Kubernetes ingress
  every request carries the proxy's address, so a single worker served all traffic while the rest
  sat idle — a `WORKERS=4` deployment had the capacity of one process, and the saturated worker
  looked like a dead server because health probes queued behind real requests.
- No configuration change is needed to get the fix. Deployments already setting `WORKERS` see all
  workers used from the first restart.
- Chat streaming, stop/cancel, workflow cancellation and workflow progress replay all work
  regardless of which worker a given request reaches.
- Set `STICKY_SESSIONS=true` to restore the old address-hashing behaviour if some part of your
  deployment depends on connection affinity. It is not needed for chat.

Note two per-worker limits that now spread differently, since one user's requests can reach several
workers: rate-limit counters and realtime-voice connection caps are counted per worker, so the
effective ceiling is up to `WORKERS ×` the configured value. Size them accordingly or enforce limits
at your ingress.

Running more than one **replica** still requires cookie-based session affinity at the ingress — the
relay works between workers in a pod, not between pods. See
[Scaling with Multiple Workers](../../scaling.md) for Kubernetes examples.
