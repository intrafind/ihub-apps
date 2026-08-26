# Fixes — 5.5.0

## The Admin Dashboard No Longer Waits for the GitHub Update Check

On installations without outbound internet access, the admin start page showed nothing but grey
loading placeholders. The dashboard was waiting for the update check against `api.github.com`, which
never answered — where a firewall drops packets instead of refusing them, the request hung until the
operating system's TCP timeout, minutes later. The update check now runs on its own and the page
renders immediately.

- The check aborts after 1 second. Set `VERSION_CHECK_TIMEOUT_MS` (or
  `IHUB_VERSION_CHECK_TIMEOUT_MS`) to change that, for example on slow links or through a strict
  proxy.
- Results and failures are both cached for 5 minutes, so opening the dashboard no longer triggers a
  fresh request to GitHub every time. The admin endpoint answers from that cache and refreshes in
  the background, so it never blocks on the network.
- If the check fails or times out, the dashboard and the **Updates** page render fully — only the
  "new version available" badge is missing. The **Updates** page shows the version cards regardless.
- To stop the server contacting GitHub at all, `NO_VERSION_CHECK=true` still applies and skips the
  request entirely.

## MCP Tools Now Advertise Their Inputs Again

External MCP clients (Claude, IDE agents, and other integrations) could connect to the iHub MCP
gateway and list its apps and workflows, but every tool showed up with no input fields. Any call
then failed with `Missing required argument: 'message'`, because the client had no schema telling it
to send a message in the first place. The gateway now advertises the correct inputs for each tool.

- App tools expose `message` (required) plus any variables the app defines.
- Workflow tools expose `input` (required) plus the workflow's start-node variables.
- Native tools expose their full parameter set, including choices and nested fields.
- No configuration change is needed — reconnect the MCP client and the fields appear.

## Integration Tools Like iFinder Now Work Through the MCP Gateway

Native integration tools (iFinder document search, Entra people search, Jira, and others) run on
behalf of the signed-in user and previously failed over MCP with "iFinder access requires
authenticated user". The gateway now passes the connected caller's identity to every native tool
call, so these tools work end-to-end from an MCP client.

- Each iFinder function — `search`, `getContent`, `getMetadata`, `discover` — is exposed as its own
  MCP tool with the correct arguments.
- A tool only appears if it is reachable through an app the caller can access, `mcpServer.expose.tools`
  is enabled, and the client's token carries the `mcp:tools:read` / `mcp:tools:call` scopes.
- Callers cannot impersonate another user through tool arguments — the gateway always uses the
  authenticated identity.

## Choose a Model When Invoking an App Over MCP

App tools exposed over MCP now accept an optional `modelId` argument, so a client can run an app with
a specific model instead of only the app's preferred one.

- Apps that restrict their models advertise the allowed ids as a fixed choice list.
- Apps configured to hide model selection do not expose the option.
- An unknown or incompatible model falls back to the app's preferred model rather than failing.

## Audit Log Filters Now Actually Filter

Selecting a resource, action, result or source on **Observability → Audit Log** left the table
unchanged and the dropdown snapped straight back to "All". The page changed two URL parameters at
once — the filter and the page number — and the second change silently discarded the first, so the
filter never reached the server. Filters now apply on the first click, and a shared or bookmarked
filter link opens the view it describes.

- Changing the rows-per-page value on the audit log had the same problem and reverted to 50. It now
  sticks.
- The resource list no longer offers `provider`, which nothing ever writes, and no longer omits
  `tool`, `credential`, `integrations`, `uiConfig` and the other types that do occur. The options
  are read from the log itself, so nothing can go missing.
- The actor list covers every actor in the selected date range, not just the ones on the page you
  happen to be looking at.
- `mcp` is gone from the source filter. No code path writes it, so selecting it could only ever
  return an empty table.
- The audit log page is now translated. The German UI previously showed it entirely in English.
- CSV export uses the same filters as the table, including the new ones, so an export always matches
  what is on screen.
  
## Crashes in Error Handlers Fixed

A group of error handlers referenced a variable name that did not exist in that scope, so whenever
the original problem occurred the handler itself threw a `ReferenceError` instead of logging the
cause. The real failure was lost, and in a few places a clean failure turned into a hard crash.

- Proxy authentication now logs and recovers from JWKS fetch and JWT verification failures instead of
  throwing inside the handler.
- Short link redirects, admin config saves, prompt/skill/style loading, marketplace skill installs,
  usage rollups, SharePoint drive listing, and workflow execution recovery all log the actual error
  again.
- Workflow registry recovery re-throws the original error instead of a `ReferenceError`, so unexpected
  filesystem problems surface with their real message.
- An SSE chat connection that fails during setup now reports the error against the right chat id
  rather than crashing the handler a second time.
- The tool-calling entry point (`createConverter`, `ToolCallPatterns.*`) threw on every call because
  the helpers it uses were re-exported but never imported locally. They now work.

Lint now enforces `no-undef`, so this class of bug fails the build rather than shipping.

## Rotated Identity Provider Signing Keys Are Picked Up Without a Restart

Proxy authentication cached each provider's JWKS document forever. When an identity provider rotated
its signing keys, every token signed with a new key failed verification — users were locked out until
the iHub process was restarted. The cache now expires.

- A JWKS document is re-fetched after 10 hours, or immediately when a token arrives with a key id the
  cached document does not contain (at most once every 5 minutes per provider, so unknown key ids
  cannot be used to hammer the provider).
- If a refresh fails, the previously cached keys keep working instead of rejecting every request while
  the provider's JWKS endpoint is briefly unreachable.
- The JWKS request still goes through the platform's configured HTTP proxy and TLS settings.
- No configuration change is needed.

## Crashes Outside a Request Are Logged Instead of Disappearing

An exception or rejected promise raised outside Express's request handling — in a background job, a
timer, or a streaming callback — terminated the process with nothing written to the application log,
leaving no trace of what failed.

- Unhandled promise rejections are logged with their message and stack, and the server keeps running.
- Uncaught exceptions are logged and the process then exits deliberately. With `WORKERS` above 1 the
  affected worker is respawned automatically, as it already was for any other worker exit.
- The standalone binary already behaved this way; the regular server now matches it.

## Streaming Works Behind HTTP/2 Reverse Proxies

Chat responses and long-running tool jobs stopped mid-stream — or never started — for users behind a
reverse proxy that serves iHub over HTTP/2, typically shown in the browser as
`ERR_HTTP2_PROTOCOL_ERROR`. iHub sent a `Connection: keep-alive` header on its event-stream
responses; that header is forbidden in HTTP/2, so a proxy that forwards it instead of removing it
produces a stream strict clients reject outright.

- The header is no longer sent on chat streaming or job progress responses. HTTP/1.1 keeps
  connections alive on its own, so nothing changes for deployments served over HTTP/1.1.
- The same header is no longer sent on outbound calls either — to the iAssistant conversation API and
  when fetching web pages for URL sources and the web content extractor — so those requests survive
  an intermediary that converts them to HTTP/2.
- No configuration change is needed.

## New workflows could not be saved

Creating a workflow from **Admin → Workflows → Create New Workflow** started from an empty
definition, which the workflow schema always rejected: it requires at least a Start and an End step,
plus a non-empty name and description. Saving therefore failed no matter what was entered, and the
visual editor could never be opened for the new workflow.

- New workflows now start from a valid template that already contains a **Start** and an **End**
  step, connected, along with a pre-filled name and description that can be edited afterwards.
- The visual editor's own "new workflow" canvas uses the same template, so both entry points behave
  identically and a new workflow can be saved immediately and then arranged on the canvas.
