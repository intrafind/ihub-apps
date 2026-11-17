# Local Browser Bridge — Device Tools for the Cloud Agent

**Date:** 2026-11-17
**Status:** Draft / Idea
**Owners:** TBD
**Builds on:** [`2026-04-28 Browser Extension Plan.md`](./2026-04-28%20Browser%20Extension%20Plan.md)
(this is the design doc its "Phase 3 — Authorized actions" asks for),
the agent loop and its approval gate (`server/services/loop/`,
`server/services/loop/seams/approvalSeam.js`), the MCP adapter
(`server/services/integrations/protocols/mcp/`).

---

## 1. Problem

Local agents can drive the user's own browser: open a page, click, read what
is behind a login. A web-based chat cannot. In iHub the agent loop runs on the
server; the browser worth driving — the one that holds the user's sessions —
runs on the user's machine. Nothing connects the two.

The trigger for this concept was [anomalyco/browse](https://github.com/anomalyco/browse),
a tool that gives a _local_ agent a browser. The question is how a _cloud_
agent gets the same reach. The tool itself was not evaluated for this document;
the design below does not depend on it.

## 2. Goal

A signed-in user can let an iHub chat or agent act in their own browser:
navigate, read, click, type, take a screenshot — with their logins, on sites
they approved, and with every action visible and stoppable.

The more general goal behind it: iHub gets one way to run a tool **on a device
the user connected** rather than on the server. The browser is the first such
device; a local helper that exposes local MCP servers is the second.

## 3. Non-goals

- Unattended automation. A scheduled or headless run does not drive a person's
  browser (see §8).
- A server-side headless browser. That is a different feature (no user
  sessions, no local install) and can coexist.
- Replacing the read-only side panel. The extension keeps working as it does
  today for users who never grant automation.
- Controlling the desktop outside the browser.

## 4. Options considered

Something on the user's machine has to execute the tool call and return the
result. There are four places to put it.

| Option                                           | Local install       | Tab must stay open | Reaches                 | Verdict                           |
| ------------------------------------------------ | ------------------- | ------------------ | ----------------------- | --------------------------------- |
| A. Web page calls a local MCP server             | MCP server + proxy  | Yes                | Whatever the server has | Fragile; keep as a fallback idea  |
| B. Local helper dials out to iHub                | A binary            | No                 | Anything local          | Second device, after the browser  |
| C. Browser extension dials out to iHub           | Extension (exists)  | No                 | The user's real browser | **Recommended first device**      |
| D. Electron / Tauri shell around the cloud UI    | A desktop app       | —                  | Anything local          | Option B plus a UI to maintain    |

**A. Web page → localhost.** An HTTPS page may call `http://127.0.0.1:<port>`,
so a browser-side MCP client can talk to a local MCP server if that server
speaks HTTP (a stdio server needs a proxy in front), sends CORS headers, and
the user accepts the browser's local-network prompt. The chat tab relays: tool
call down the SSE stream, result back by POST. Weak points: behaviour differs
per browser and changes with browser releases, the tab must stay open, and any
other website can try the same port, so the local server needs an origin
allowlist and a pairing token anyway.

**B. Local helper.** A small daemon opens an outbound WebSocket to iHub and
executes tool calls sent down it. No CORS, works through firewalls and with
the tab closed. Costs a binary to distribute, sign and update.

**C. Browser extension.** `browser-extension/` already signs in against iHub
with OAuth + PKCE and holds `scripting` and `<all_urls>`. Extended with a
connection to the server, it is option B without a binary, and it is in the
right place: the user's real browser profile. Enterprise policy can roll it
out. Because the extension connects to the iHub URL the user configured, it
needs no per-customer domain list in its manifest.

**D. Electron / Tauri.** Fully capable — the main process can spawn stdio MCP
servers and drive a browser while the UI still loads from the cloud. It solves
the same problem as B and adds a desktop app to ship.

**What does not help:** a PWA has the same sandbox as a tab. WASM has no
privileges beyond the page; it can run tools _inside_ the tab (parsing, code
execution) but cannot reach another tab, the browser, or a local process.

## 5. Proposed design

### 5.1 Device tools

A new kind of tool executor on the server: the call is not run in-process and
not sent to a configured remote endpoint, but routed to a **device** the
calling user connected.

```
┌────────────┐  tool call   ┌──────────────┐  device channel  ┌─────────────────┐
│ Agent loop │ ───────────▶ │ Device router│ ───────────────▶ │ Extension       │
│ (server)   │ ◀─────────── │ (server)     │ ◀─────────────── │ (user's browser)│
└────────────┘  tool result └──────────────┘   result / error └─────────────────┘
       │
       │ tool/started, tool/ended (unchanged)
       ▼
   Chat client — renders, does not relay
```

- The chat client is not part of the path. The run continues if the chat tab
  reloads; it only needs the device.
- The model sees ordinary tool definitions. Whether a tool runs on the server
  or on a device is an executor detail, like native vs. MCP vs. OpenAPI today.
- A device registers the tools it offers when it connects. The server offers
  them to the model only in runs of the user who owns the device, and only
  where the app or agent allows device tools.

### 5.2 Device channel

- **Transport:** WebSocket from device to server, authenticated with the
  device's OAuth access token. The server already terminates WebSockets for
  realtime transcription, so proxy and subpath handling have a precedent.
- **Messages:** `hello` (device id, kind, tool list), `call` (call id, tool,
  arguments), `result` / `error`, `cancel`, heartbeat. Whether the payload
  format should simply be MCP over WebSocket is an open question (§10).
- **Manifest V3 lifetime:** an extension service worker is suspended when
  idle. An open WebSocket with regular traffic keeps it alive; the design must
  still survive a suspension — the device reconnects and the server either
  re-sends an unanswered call or fails it with a clear tool error.
- **Cluster:** the worker that runs the loop is not necessarily the one that
  holds the socket. Calls and results travel over the cluster bus that
  interactions already use.
- **Offline device:** the tool result is an error the model can act on
  ("the user's browser is not connected"), not a hung run. Timeouts per call.

### 5.3 Pairing

No new mechanism. The extension is already an OAuth client pinned to allowed
groups. Connecting the device channel is one more use of that token, behind a
new scope (for example `device:browser`) so that a read-only installation
cannot be turned into an automation target by a server-side change alone.
Users see their connected devices in their profile and can disconnect one.

### 5.4 Browser tools (first set)

| Tool            | Does                                             | Side effect |
| --------------- | ------------------------------------------------ | ----------- |
| `browser_tabs`  | List the tabs the agent may see                  | none        |
| `browser_open`  | Open a URL in a new tab in the agent's tab group | navigation  |
| `browser_read`  | Page text / accessibility tree of an agent tab   | none        |
| `browser_shot`  | Screenshot of an agent tab                       | none        |
| `browser_click` | Click an element                                 | **write**   |
| `browser_type`  | Type into a field                                | **write**   |

The agent works in tabs it opened, grouped and visibly marked. Acting on a tab
the user already had open requires the user to hand that tab over.

Implementation choice inside the extension: `chrome.scripting` covers reading
and simple clicks with the permissions the extension already has;
`chrome.debugger` gives reliable input and screenshots but shows a browser
warning bar and needs a new permission. Start with `scripting` plus
`tabs.captureVisibleTab`, add `debugger` only if real sites force it.

### 5.5 Activity and labelling

Unchanged rule: the server decides what a call was and how it is labelled
(`server/utils/toolDisplay.js`), the client renders. Device tools get their
display from the server-side tool definition, not from what the device claims.
If the existing `activityKind` / `activityOrigin` values cannot express "in
your browser", that is a new server-sent value, not client inference.

## 6. Security model

This is the hard part; the plumbing is not.

1. **The page is hostile input.** Everything `browser_read` returns can
   contain instructions aimed at the model. It is wrapped as untrusted content
   as page text is today, and — more important — the controls below do not
   depend on the model resisting it.
2. **Per-site approval, deny by default.** A site is usable only after the
   user approved it for this chat (or permanently). Admins can set an
   allowlist and a blocklist; the blocklist wins.
3. **Write actions go through the approval gate.** `browser_click` and
   `browser_type` are tools with a write side effect, so the existing approval
   seam applies: the turn pauses until the user approves, with per-chat grants
   for sites the user trusts.
4. **Sensitive sites stay manual.** Banking, password managers, identity
   providers, admin consoles: blocked by default, admin-extendable.
5. **Data flow is the real exfiltration risk.** An agent that reads an
   internal page and may then open an arbitrary URL can leak the page in the
   URL. Navigation to a site not yet approved therefore needs approval too,
   and the prompt shows the full URL.
6. **Visible and stoppable.** A marker on agent tabs, a running indicator in
   the extension, and one stop control that cancels the run and closes the
   channel.
7. **Server-side enforcement.** Site policy is checked on the server before a
   call is routed and again in the extension. Neither side trusts the other
   alone.
8. **Audit.** Device tool calls are in the run log like any other tool call:
   who, which device, which site, which action.

## 7. Admin and configuration

- A switch for device tools as a whole and one per device kind, off by
  default, on the existing browser-extension admin page.
- Group restriction, as for the extension itself.
- Site allowlist / blocklist (already foreseen in the extension plan, §12).
- Per app / agent: whether device tools may be offered. An app that never asks
  for them never sees them.

Changing existing config files for this needs a migration
(`server/migrations/`); new files do not.

## 8. Limits

- **Needs a person.** No user at the browser means no approvals and nobody to
  stop it. Headless surfaces (scheduled runs, inference API, app-as-tool) do
  not get device tools in the first version.
- **Browser support.** Chrome and Edge first. Firefox differs in side panel
  and debugger APIs; Safari is out of scope.
- **Store review.** `debugger` and broad automation make a public store
  listing harder. Private / policy distribution is the realistic route for
  enterprise customers.
- **Latency.** Every step is a round trip through the model. This suits
  "look this up behind my login" better than long click sequences.

## 9. Phases

**Phase 0 — Spike (about a week).** Hard-coded channel, `browser_open` and
`browser_read` only, one developer's machine. Answers: does the service worker
stay reachable, what does a round trip cost, does the cluster path work.

**Phase 1 — Read-only device tools.** Device router, channel, pairing scope,
`browser_tabs` / `browser_open` / `browser_read` / `browser_shot`, per-site
approval, admin switch, activity labelling, audit. No write actions.

**Phase 2 — Write actions.** `browser_click` / `browser_type` behind the
approval gate, sensitive-site list, tab hand-over, stop control.

**Phase 3 — Local helper.** A second device kind that exposes local MCP
servers through the same channel. Only if Phase 1–2 show demand.

## 10. Open questions

1. **Wire format.** Own small protocol, or MCP over WebSocket so that a local
   helper is "just" an MCP gateway? The second reuses the MCP adapter's tool
   handling but ties the channel to MCP's session model.
2. **Which tab representation does the model get** — text, accessibility tree,
   screenshot, or a mix? Decides token cost and how well clicks land.
3. **Several devices per user** (work laptop and home PC both connected):
   which one gets the call? Likely "the one the chat was opened from", which
   the server must then know.
4. **Grant lifetime.** Per chat, per day, permanent per site?
5. **Does the main web UI need to know the extension is there** (to offer
   "use my browser" in a chat), and how — a server-side "device connected"
   flag is simpler than page-to-extension messaging.
6. **Chrome's own direction.** Browser vendors are adding native agent hooks.
   Worth a check before Phase 2 whether one of them replaces the `debugger`
   path.

## 11. Success criteria

- A user asks a chat for something that lives behind their login, approves the
  site once, and gets an answer grounded in that page — without copying text
  or leaving the chat.
- No device tool call reaches a site the user or admin did not allow; this is
  covered by tests on the server and in the extension.
- Disconnecting the device, or closing the browser, ends in a clear tool error
  within the call timeout, never in a hung run.
