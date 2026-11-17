# Local Browser Bridge — Browser Tools for the Cloud Agent

**Date:** 2026-11-17
**Status:** Draft / Idea
**Owners:** TBD
**Epic:** [#3148](https://github.com/intrafind/ihub-apps/issues/3148), sub-issue [#3766](https://github.com/intrafind/ihub-apps/issues/3766)
**Builds on:**

- [`2026-04-28 Browser Extension Plan.md`](./2026-04-28%20Browser%20Extension%20Plan.md) —
  this is the design doc its "Phase 3 — Authorized actions" asks for.
- [`../office-hosts-and-tools/01-client-executed-tools.md`](../office-hosts-and-tools/01-client-executed-tools.md)
  and [`02-chat-approval-gate.md`](../office-hosts-and-tools/02-chat-approval-gate.md) —
  the mechanism this concept reuses (tracked in intrafind/ihub-apps#3176, not
  implemented yet).

---

## 1. Problem

Local agents can drive the user's own browser: open a page, click, read what
is behind a login. A web-based chat cannot. In iHub the agent loop runs on the
server; the browser worth driving — the one that holds the user's sessions —
runs on the user's machine.

The trigger for this concept was [anomalyco/browse](https://github.com/anomalyco/browse),
a tool that gives a _local_ agent a browser. The question is how a _cloud_
agent gets the same reach. The tool itself was not evaluated for this document;
the design below does not depend on it.

## 2. Goal

A signed-in user can let an iHub chat or agent act in their own browser:
navigate, read, click, type, take a screenshot — with their logins, on sites
they approved, and with every action visible and stoppable.

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

| Option                                        | Local install      | Reaches                 | Verdict                             |
| --------------------------------------------- | ------------------ | ----------------------- | ----------------------------------- |
| A. Web page calls a local MCP server          | MCP server + proxy | Whatever the server has | Fragile; not pursued                |
| B. Local helper dials out to iHub             | A binary           | Anything local          | Later, only on demand (§5.7)        |
| C. Browser extension executes the tools       | Extension (exists) | The user's real browser | **Recommended**                     |
| D. Electron / Tauri shell around the cloud UI | A desktop app      | Anything local          | Option B plus a desktop app to ship |

**A. Web page → localhost.** An HTTPS page may call `http://127.0.0.1:<port>`,
so a browser-side MCP client can talk to a local MCP server if that server
speaks HTTP (a stdio server needs a proxy in front), sends CORS headers, and
the user accepts the browser's local-network prompt. Weak points: behaviour
differs per browser and changes with browser releases, and any other website
can try the same port, so the local server needs an origin allowlist and a
pairing token anyway.

**B. Local helper.** A small daemon opens an outbound WebSocket to iHub and
executes tool calls sent down it. No CORS, works through firewalls. Costs a
binary to distribute, sign and update.

**C. Browser extension.** `browser-extension/` already signs in against iHub
with OAuth + PKCE, runs iHub chats in its side panel, and holds `scripting`
and `<all_urls>`. It is in the right place: the user's real browser profile.
Enterprise policy can roll it out.

**D. Electron / Tauri.** Fully capable — the main process can spawn stdio MCP
servers and drive a browser while the UI still loads from the cloud. It solves
the same problem as B and adds a desktop app to ship.

**What does not help:** a PWA has the same sandbox as a tab. WASM has no
privileges beyond the page; it can run tools _inside_ the tab (parsing, code
execution) but cannot reach another tab, the browser, or a local process.

## 5. Proposed design

### 5.1 The browser is one more client-tool host

iHub already has a design for tools the **client** executes: the Office task
pane runs Office.js calls that the server's agent loop hands to it and waits
for, in the same run
([client-executed tools](../office-hosts-and-tools/01-client-executed-tools.md)).
The extension's side panel is the same kind of client. This concept adds no
second mechanism; it adds a host.

```
model ──tool_call──▶ agent loop (server)
                       ├─ approval gate
                       └─ client tool executor: raise `client_tool`, wait in the run
side panel ◀──SSE── interaction/raised + interaction/live (full arguments)
side panel ── executes in the browser (chrome.scripting, chrome.tabs)
side panel ──POST …/interactions/:id/answer──▶ run continues
```

What comes with that design and does not need to be designed again:

- One run across several tool calls; the model keeps its working state.
- Every failure is a tool error the model sees: side panel closed, timeout,
  stop pressed. Nothing hangs.
- Cluster: the answer may arrive on another worker.
- **Tool results are never stored.** Page text read behind the user's login
  goes to the model and nowhere else — not the run ledger, not the logs.
- Headless turns never get client tools.

### 5.2 Declaring and offering

- A built-in native integration for the host, for example
  `com.intrafind__browser`, next to the Outlook one. Its actions carry
  `executor: "client"`, `host: "browser"`, `sideEffect` and `approval`.
  Schemas, titles and descriptions live on the server only.
- The side panel advertises what it can execute with each chat POST:
  `clientTools: { host: "browser", target: { tabId, origin }, tools: [...] }`.
- The server offers the intersection of the app's tools, the admin allowlist
  and what the client advertised. An app that never asks for browser tools
  never sees them.
- **Browser permissions are opt-in.** The extension declares what automation
  needs beyond today's manifest (`tabs`, `webNavigation`, request blocking) as
  optional permissions and asks for them when the user first turns automation
  on. A read-only installation cannot be turned into an automation target by a
  server-side change alone; without the grant it advertises no tools.

### 5.3 Browser tools (first set)

| Tool            | Does                                             | Side effect | Phase |
| --------------- | ------------------------------------------------ | ----------- | ----- |
| `browser_tabs`  | List the agent's tabs                            | none        | 1     |
| `browser_open`  | Open a URL in a new tab in the agent's tab group | navigation  | 1     |
| `browser_read`  | Page text / accessibility tree of an agent tab   | none        | 1     |
| `browser_shot`  | Screenshot of an agent tab                       | none        | 1     |
| `browser_click` | Click an element                                 | **write**   | 2     |
| `browser_type`  | Type into a field                                | **write**   | 2     |

The agent works in tabs it opened, grouped and visibly marked. Acting on a tab
the user already had open requires the user to hand that tab over.

Implementation choice inside the extension: `chrome.scripting` covers reading
and simple clicks with the permissions the extension already has;
`chrome.debugger` gives reliable input and screenshots but shows a browser
warning bar and needs a new permission. Start with `scripting` plus
`tabs.captureVisibleTab`, add `debugger` only if real sites force it.

### 5.4 Target check

As in the Office design, a call names its target and the executor checks it
before acting: the tab still exists, belongs to the agent's group, and is
still on the origin the call was approved for. A mismatch answers
`TargetChanged` and changes nothing. This matters most between an approval and
the click it approved — the page may have navigated in the meantime.

### 5.5 Lost answers and writes

The client-tool design ends a call whose request or answer got lost with
`ClientTimeout`, and "the model may call the tool again". That is fine for a
read and wrong for a write: a click can complete in the browser while its
answer is lost, and a repeated call would click twice.

- **No transport-level replay.** Neither side re-sends a call on its own.
- **A write whose outcome is unknown says so.** For tools with a write side
  effect, a timeout is reported as an unknown-outcome error that tells the
  model the action may have happened and to read the page before deciding
  anything. A repeated write is a new call and passes the approval gate again.
- **The extension remembers the call ids it executed** for the run and refuses
  a second execution of the same id, so a duplicated delivery cannot act twice.

### 5.6 Activity and labelling

Unchanged rule: the server decides what a call was and how it is labelled
(`server/utils/toolDisplay.js`), the client renders. Browser tools get their
display from the server-side definition. If the existing `activityKind` /
`activityOrigin` values cannot express "in your browser", that is a new
server-sent value, not client inference.

### 5.7 Beyond the side panel (later)

Client tools reach the client that runs the chat. Two wishes go beyond that
and are deliberately not in the first phases:

- **A chat in the main web UI drives the browser.** The web UI tab is not the
  extension. Either the extension bridges into the iHub page (a content script
  on the configured iHub origin that hands `client_tool` calls to the
  extension), or the extension holds its own channel to the server and answers
  the same interactions. The first needs no new transport but makes the iHub
  page a caller the extension must not trust blindly; the second is new
  infrastructure. Open question (§10).
- **A local helper for local MCP servers** (option B). Needs the same
  "a client other than the chat's own answers the interaction" capability.

## 6. Security model

This is the hard part; the plumbing is not.

1. **The page is hostile input.** Everything `browser_read` returns can
   contain instructions aimed at the model. It is wrapped as untrusted content
   as page text is today, and — more important — the controls below do not
   depend on the model resisting it.
2. **Per-site approval, deny by default.** A site is usable only after the
   user approved it for this chat (or permanently). Admins can set an
   allowlist and a blocklist; the blocklist wins.
3. **Policy applies to every navigation, not only to the call.** An approved
   URL can redirect, and a page can navigate itself. The extension enforces
   the site policy on the agent's tabs for every main-frame request,
   redirects included, and blocks a request to a blocked or unapproved site
   before it is sent. The tool call then fails with the blocked destination,
   and the user can approve that site and retry. Checking the URL in the tool
   call alone — on the server or in the extension — is not sufficient.
   Whether tab-scoped request blocking does this reliably is a spike question
   (§9).
4. **Sensitive sites stay manual.** Banking, password managers, identity
   providers, admin consoles: a default blocklist that ships with the first
   phase that can read pages, admin-extendable. A blocked site cannot be
   approved from the chat.
5. **Write actions go through the approval gate.** `browser_click` and
   `browser_type` have a write side effect, so the
   [chat approval gate](../office-hosts-and-tools/02-chat-approval-gate.md)
   applies: the call does not run before the user allows it.
6. **Data flow is the real exfiltration risk, and a site grant does not cover
   it.** An agent that has read a page can leak it in the URL of the next
   navigation — also to a site the user approved earlier for an unrelated
   reason. A site grant therefore permits _reading_ that site. Once a run has
   read page content, every navigation to a **different** site needs approval
   with the full URL shown, whether or not that site is approved; so does
   typing into a page on a different site than the content came from.
   Navigation within the site that was read stays free.
7. **Visible and stoppable from the first phase.** A marker on agent tabs, a
   running indicator in the side panel, and a stop control that cancels the
   run. Closing the side panel also ends the agent's reach: the next call
   times out.
8. **Enforcement on both sides.** The server refuses a call whose arguments
   violate the site policy; the extension enforces the same policy on what
   actually happens in the tab. Neither trusts the other alone.
9. **Audit without content.** The run log records who, which site and which
   action. Structural arguments (URL, element reference) are stored; page
   content and typed text are marked as content and are not.

## 7. Admin and configuration

- A switch for browser tools, off by default, on the existing
  browser-extension admin page, with the tool allowlist the client-tool design
  foresees per host.
- Group restriction, as for the extension itself.
- Site allowlist / blocklist (already foreseen in the extension plan, §12) and
  the sensitive-site default list.
- Per app / agent: browser tools are offered only where the app grants them.

Changing existing config files for this needs a migration
(`server/migrations/`); new files do not.

## 8. Limits

- **Needs a person and an open side panel.** No user at the browser means no
  approvals and nobody to stop it. Headless surfaces (scheduled runs,
  inference API, app-as-tool) do not get browser tools.
- **Depends on client-executed tools.** That mechanism is designed but not
  built; this concept cannot start before its first phase lands.
- **Browser support.** Chrome and Edge first. Firefox differs in side panel
  and debugger APIs; Safari is out of scope.
- **Store review.** `debugger` and broad automation make a public store
  listing harder. Private / policy distribution is the realistic route for
  enterprise customers.
- **Latency.** Every step is a round trip through the model. This suits
  "look this up behind my login" better than long click sequences.

## 9. Phases

**Phase 0 — Spike.** After client-executed tools exist: `browser_open` and
`browser_read` from the side panel on one developer's machine. Answers: what
does a round trip cost, can the extension block a redirect to an unapproved
site before the request is sent, which page representation works.

**Phase 1 — Read-only browser tools.** The `browser` host, `browser_tabs` /
`browser_open` / `browser_read` / `browser_shot`, opt-in browser permissions,
per-site approval, the sensitive-site default blocklist, navigation
enforcement including redirects, the data-flow rule for navigation, tab
marker and stop control, admin switch, activity labelling, audit. No write
actions.

**Phase 2 — Write actions.** `browser_click` / `browser_type` behind the
approval gate, unknown-outcome handling for writes, the data-flow rule for
typing, tab hand-over.

**Phase 3 — Beyond the side panel.** Driving the browser from a chat in the
main web UI, and a local helper for local MCP servers (§5.7). Only if
Phase 1–2 show demand.

## 10. Open questions

1. **How does a chat in the main web UI reach the extension** (§5.7) — page
   bridge or an own channel? Decides whether Phase 3 is a small step or new
   infrastructure.
2. **Which tab representation does the model get** — text, accessibility tree,
   screenshot, or a mix? Decides token cost and how well clicks land.
3. **What is "a site"** for grants and the data-flow rule — origin,
   registrable domain, or an admin-defined group (all hosts of one intranet)?
4. **Grant lifetime.** Per chat, per day, permanent per site?
5. **Is the 60 s client-tool timeout enough** for a slow page load, or does
   `browser_open` need its own?
6. **Chrome's own direction.** Browser vendors are adding native agent hooks.
   Worth a check before Phase 2 whether one of them replaces the `debugger`
   path.

## 11. Success criteria

- A user asks a chat for something that lives behind their login, approves the
  site once, and gets an answer grounded in that page — without copying text
  or leaving the side panel.
- No browser tool call reaches a site the user or admin did not allow, also
  not through a redirect; this is covered by tests on the server and in the
  extension.
- Page content read through a browser tool appears in no ledger, log or
  stored interaction.
- Closing the side panel, or the browser, ends in a clear tool error within
  the call timeout, never in a hung run.
