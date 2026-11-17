# 2026-11-17 · Resume the stored call after a connect (#3752)

**Status:** Design agreed (this document), implementation in the PR that links #3752 · Part of [Unified Integrations](README.md) · Follows [One connect flow and connect card](2026-11-02%20One%20connect%20flow%20and%20connect%20card.md) (#2917) · Builds on [Tool approval](2026-11-02%20Tool%20approval.md)

After a connect, the **server** runs the call that stopped on a missing connection, once, with the same arguments, and the chat continues from its result. The client no longer sends a message on the user's behalf.

## 1. What the code check found (main @ 8d3346e)

| Question | Finding |
|---|---|
| How is a call that failed with `INTEGRATION_AUTH_REQUIRED` represented? | As a normal, completed tool result. The model carries on **in the same turn** (it explains "please connect") and the turn ends. The stored answer keeps `integrationAuthRequired: [{ integration, name, reason, action?, scopes? }]`: no call id, no tool id, **no arguments**. Tool-call and tool-result messages are never stored in the chat transcript. |
| Can the approval mechanism resume it? | **No, not as it is.** Approval (#2945) pauses the turn at the call, keeps `toolApproval.pending = { interactionId, runId, call, transcript, question, basis }` on the chat document and continues on the next POST (`approvalResponse`). It is bound to an `approval` interaction, and the auth-required call neither pauses nor stores anything. |
| What can be reused? | `AgentLoop` `request.resume` (runs a stored call **through the seams**, so the approval gate and scope binding apply again, and puts the result where the placeholder is); the bounded transcript helpers; the take-once compare-and-set on the chat document (`ChatRepository.takeToolApproval`); the continuation pattern of `ChatService.runTurn`. |
| What is missing? | The record (what to run), the trigger (a connect, not an approval), and a continuation that does not store a user message. |
| What does the client do today? | `useConnectRetry` sends "I connected X. Please try again." as a typed user message once the chat is ready (guards in `sessionStorage`). #3750 only added waits for the model, scopes and chat settings. |
| Headless runs | Scheduled tasks and workflows end the run with a reason (`runSeams.js`, `taskExecution.js`); no card, nothing waiting on a human. |
| Do adapters return the code after reaching the vendor? | Jira (`jiraAuthFailure`) and per-user MCP return it for "no connection", "refresh refused" and a vendor `401` (credentials rejected, the call was not executed). So the contract is: **the code means the vendor did not run the call**. Written into `integrationAuthRequired.js`. |

## 2. Design (direction B)

Keep today's turn. **Additionally**, store a server-side record of the failed calls and resume it once after the connect.

1. **Record.** In `chatTurnSeam` (where `authRequiredOf` is non-null) the call is collected from the loop's own call object: id, name, tool id, arguments (never from the tool result text; integration from the tool definition). When the turn ends and the chat is stored, `ChatService` writes `pendingConnect` on the chat document: `{ id, runId, integrations[], calls[≤5], transcript, question, basis, createdAt, expiresAt }`. The transcript is the turn's messages up to the end of the step that made the calls (later steps are discarded: the model decides again after the real results). **Fail closed:** no record when an argument was truncated, the transcript is over its bound, there are more than 5 calls, the chat is not stored, the owner is anonymous, or the caller is not a chat turn (scheduled task, workflow, agent, `/v1`).
2. **Trigger.** The chat POST accepts `connectResume: { id }` as the only content of a message, mirroring `approvalResponse`. The client sends it after the return from the connect (`integration_connected=<id>` for the integration of the record) and nothing else: no tool id, no arguments. `integration_connected` only makes the client ask; it authorizes nothing.
3. **Checks, in this order, before anything runs.** Signed in and not anonymous → chat owner is the user (a share viewer or fork never resumes; the record is not copied by a fork) → record exists, same app, not expired (`410`), not taken (`409`) → the **acting user's** connection for the record's integration is usable now (else `409 CONNECT_RESUME_NOT_CONNECTED`, record kept, the card stays) → the app and the tool are still allowed for the user and the integration is still enabled in the chat; the chat scope is recomputed from the chat as it stands. Foreign chats answer `404`.
4. **Take once.** `takePendingConnect` (compare-and-set under the chat lock, same as `takeToolApproval`) clears the record in the write that hands it out: double click, second tab, reload of the return URL or two workers run it once. Restored only if the turn is refused **before** the loop starts; **never** after (at most once beats at least once, a write may have happened).
5. **Run.** The continuation turn loads the history **without** the "please connect" answer of that run, appends the stored transcript with the failed results as placeholders, and calls `AgentLoop` with `resume.toolCalls` (the loop's `resume` is extended from one call to a list). The calls run in order through the seams with **no** `approvedCall`: a call that needs approval raises a normal approval and pauses. A call that fails again (including `INTEGRATION_AUTH_REQUIRED`) is not resumed again (it gets a new card; a new record only because it is a new turn result, which needs the user to connect again).
6. **No user message.** `settleUserTurn` takes `silent: true`: the chat is claimed for the run, but no user message is appended and none is written to the ledger. The answer is appended as a **new assistant message**; the earlier "please connect" answer stays (decision D2).
7. **Supersede.** Any other message to the chat, the chat being deleted or cleared, the TTL, or the take removes the record (same rule as approvals). `publicChatView` exposes only `{ id, integrations, callIds, expiresAt }`; the transcript never leaves the server and is excluded from shares, forks and exports.
8. **Client.** `useConnectRetry.js`, `connectRetry.js`, their tests and `integrations.connect.retryMessage` are deleted. `useConnectResume.js` keeps the readiness gates of #3750 and calls the new submit in `useAppChat` (no user bubble), strips `integration_connected` after use, and the Connect card shows a status line while the call continues (live region via the existing announcer). No retry button after a failed resumed call.

REST: no new route. This is a typed field on the existing chat POST (it inherits auth, app and model access, rate limits, owner check and run logging, the one pipeline to keep right), a documented use of the `approvalResponse` precedent. New registry codes: `CONNECT_RESUME_NOT_PENDING` (409), `CONNECT_RESUME_EXPIRED` (410), `CONNECT_RESUME_NOT_CONNECTED` (409), `INVALID_CONNECT_RESUME` (400). Per-user limit on resumes in addition to the chat POST's.

No new outbound connection (the resume runs the same adapter call through the same seams, which use `httpFetch` / `getTlsBypassOptions`); the connection check reads the connection service's local state and does **not** probe the vendor. No config knob and no migration: `pendingConnect` is a new optional field on the chat document.

## 3. Consolidated decisions

| # | Decision | Made by | Reversal cost |
|---|---|---|---|
| D1 | Direction B (keep the turn, store a record) over A (pause at the call) | all seven | High (A changes the stream contract and the stored shape) |
| D2 | Continuation is a **new assistant message**; the "please connect" answer stays. **Overrides the product manager's "replace"**: replacing rewrites stored history that the evidence record cites, and a failed continuation would leave nothing | UX, UI, admin, QA vs PM; lead | Medium |
| D3 | TTL **15 minutes**, a code constant (security 15, QA 15, PM 30, admin 30, UX 24 h). The safer failure mode: stored arguments are user data, and after expiry the card stays and the user asks again | lead | One constant |
| D4 | Typed field on the chat POST, not an `_action` route (security: one pipeline). `_action` is for **new** routes; this adds none | security, lead | Medium |
| D5 | One record per turn with the failed calls (≤ 5) of the **step**; resume runs the calls of the connected integration; a turn that failed on two integrations resumes the one connected and the other card stays (the user asks again) | lead | Low |
| D6 | Calls resume in order, sequentially, through the seams; the approval policy applies; a write is **not** made stricter than policy | UX asked, lead decided | None |
| D7 | No resume for scheduled tasks, workflows, agents, `/v1`, anonymous or guest owners, temporary chats, shared viewers | PM, admin, security | New design |
| D8 | Cards stored before the upgrade have no record: connecting works, nothing re-runs, no synthetic fallback (clean break, **no shim**); stated in the release note | PM, admin, QA | New design |
| D9 | No explicit "Not now" route; the TTL and the supersede rule remove the record | lead (security preferred delete-on-decline) | One route |
| D10 | `integration_connected` is display state only; nothing in the callback or `returnUrl` changes | security | None |
| D11 | Claim before run: at most once, even if the run then dies (the user asks again) | QA, security | Semantic |
| D12 | Release note: extend the existing "One Connect card" entry (the flow was never in a tag); drop the `useConnectRetry` paragraph of `fixes.md` | writer | Trivial |
| D13 | Subpath e2e: the connect spec gets a `BASE` prefix and the subpath config a `testMatch` entry (a small test-config extension the issue excluded) | QA, lead | Trivial |
| D14 | Wording: "continue", never "retry"; focus moves to the status line once after the return from a card-started connect | UX | Copy |

## 4. Consolidated pre-mortem (ranked) and mitigations

1. **A resumed call runs twice or after a cancel.** Compare-and-set before running, restore only before the loop, concurrent-request test, `integration_connected` stripped after use.
2. **"I connected and nothing happened."** Typed outcomes with a visible state for each (`expired`, `already taken`, `still not connected`, `superseded`); a log line per resume outcome; the card never silently stays in "ask".
3. **Cross-user or shared-chat resume.** Owner-only, the connection looked up for the acting user, no fork copy, `404` for foreign records, unguessable id.
4. **Stale, truncated or unauthorized call.** Refuse truncated arguments, re-authorize app, tool, integration and scope at resume, TTL.
5. **A side-effecting call re-run.** Only own-installation integration actions, only the structured result, contract documented ("never after the vendor ran the call").
6. **Approval or scope bypass.** The resume goes through the seams with no `approvedCall`; the scope is recomputed.
7. **Secrets at rest or in logs.** Record excluded from the public view, shares, forks, exports; deleted on take, supersede, TTL, chat delete; logs hold ids and outcomes only.
8. **Duplicate-looking answer / flash of the card state.** The card shows one continuous status line; the continuation is a clearly separate message.
9. **Worker or pod mismatch.** The record lives on the chat document (the only state all workers share); the take is under the chat lock.

## 5. Questions nobody could answer from the repo (decided conservatively)

- Product owner: replace or append (D2), the TTL (D3), whether a write call should always ask (D6), whether old cards should resume (D8).
- Audit trail for connections: logger lines now; an audit entry only if `AuditLogService` takes it without a new event type.
- Teams connector / Outlook add-in / browser extension have no return page: they get the card and no resume (they never send `connectResume`).
- Voice mode and compare view: the resume waits while they are busy and is skipped for them.

## 6. Out of scope

Settings → Integrations (#2922), the picker (#2923), scopes UI (#3050), resuming headless runs, automatic re-run of adapter or transport failures, an explicit decline route, a CSRF token scheme for cookie-auth POSTs (separate issue), any change to OAuth callback URLs or token storage keys.
