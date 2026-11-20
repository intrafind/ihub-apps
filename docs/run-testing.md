---
description: "The test tools for runs: runner tiers and quarantine, the scripted model, the fake clock, the golden harness with its recorded surfaces, the frozen legacy workflow path, the difference list, and the fault tier with its kill points."
audience: developer
type: reference
---

# Testing Runs

A run is one piece of model work: a chat turn, a scheduled task, an app called as a tool. This page describes the tools that test runs without a model key and without waiting on real time. Use it when you write a test for code in `server/services/chat/`, `server/services/loop/` or `server/services/scheduler/`, when a golden test fails, when you change behaviour that a golden pins, or when you test what a run does after its server died.

For the browser suite and its model stub see [Developer Onboarding](developer-onboarding.md#agents-end-to-end-suite).

## Commands

Use the Node version of `.nvmrc`. All commands run from the repository root.

```bash
node scripts/run-server-tests.js                     # every server test of the pr tier (npm run test:server)
node scripts/run-server-tests.js golden              # only files whose path contains "golden"
node scripts/run-server-tests.js --list              # how many files each runner and each tier has
node scripts/run-server-tests.js --tier=nightly      # the whole nightly tier (npm run test:nightly)
node scripts/run-server-tests.js --tier=nightly faults   # only its fault tests (npm run test:faults)
npm run test:faults -- legacy                        # the fault tests whose path contains "legacy"
npm run test:faults:smoke                            # the fault tests tagged smoke by their file name
node scripts/run-server-tests.js --check-quarantine  # fails when a quarantined test passes
UPDATE_GOLDENS=1 node --test server/tests/golden/golden.test.js   # record the goldens again
node server/tests/golden/record.mjs --out-dir /tmp/records chat/plain   # record one case into a directory of your own
node --test server/tests/workflow-legacy-frozen.test.js   # the frozen files of the legacy workflow path
```

Do not run the server tests at the same time as an end-to-end suite. Together they can exhaust the memory of the machine, and the failure looks like a failing test. The same holds for the fault tier: it starts its own servers, so run it alone.

## Runner tiers and the quarantine

`scripts/run-server-tests.js` runs every `*.test.js` under `server/tests/`. A file belongs to one tier:

| Tier | Files | Runs |
|---|---|---|
| `pr` | every file that is not in the nightly tier | on every pull request, as part of `npm run test:quick` |
| `nightly` | everything under `server/tests/faults/`, and every `*.nightly.test.js` | only with `--tier=nightly` (`npm run test:nightly`), one file at a time |

Put a test into the nightly tier when it starts real server processes or runs for minutes. Name it `*.nightly.test.js`, or put it under `server/tests/faults/`. `--tier=all` runs both tiers.

`npm run test:nightly` runs the whole tier. `npm run test:faults` runs only the files whose path contains `faults`; it does not run a `*.nightly.test.js` outside `server/tests/faults/`. The nightly workflow (`.github/workflows/nightly.yml`) runs `npm run test:faults` every night, and on a pull request that carries the label `run-faults`; see [Developer Onboarding](developer-onboarding.md#the-nightly-run) for the workflow and for who acts when it is red.

The files of the nightly tier run one after the other. Each starts real servers, and side by side on a small machine a start can take longer than a test waits for it.

A word after the options filters by path. Several words narrow further: `npm run test:faults -- resume` runs the fault tests whose path also contains `resume`.

The runner starts jest with `--workerIdleMemoryLimit=1GB`. A jest process that holds more than that after a test file is replaced before the next file. Without the limit one heavy file can make a later, unrelated file fail with "Jest worker ran out of memory".

`QUARANTINED` in the runner lists the tests that fail today, each with its reason. A quarantined file is run by no tier. The rules:

- Do not add a file to the list to get a build green. Fix the test or the code.
- When you fix a quarantined test, remove its line in the same pull request.
- `--check-quarantine` runs every quarantined file on its own. It fails when one passes, and when a line names a file that no longer exists. A stale line would keep a working test out of the build. Each file gets an empty contents directory, as on a fresh checkout: some listed tests read `contents/` and pass on a machine where the server has run.
- A file passes when its process exits with code 0, in the quarantine check as in every run. A plain script that logs a failed check and exits 0 passes. When `--check-quarantine` reports such a file, do not remove its line: make the script exit non-zero when a check fails. `toolCallingIntegration.test.js` was such a script.

## The scripted model

`server/tests/helpers/scriptedModel.js` answers the model calls of a test from a script. The test writes one turn per model call:

```js
import { makeClient } from './loop/helpers/llmFixtures.js';
import { scriptedModel, turn } from './helpers/scriptedModel.js';

const model = scriptedModel([
  turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }]),
  turn.text('Record A-1 is open.')
]);
const { client } = makeClient({ transport: model.transport });
// ... run the code under test with this client ...
model.assertDone();
```

| Turn | The model call |
|---|---|
| `turn.text(text, { usage, finishReason })` | answers with text; pass an array to send it in several deltas |
| `turn.toolCalls([{ name, args, id }], { content, usage })` | calls one or more tools |
| `turn.error(status, body)` | fails with an HTTP error of the provider |
| `turn.hang()` | never answers; it ends when the caller aborts |
| `turn.slow(deltas, { clock, intervalMs })` | sends one delta per interval of a [fake clock](#the-fake-clock) |
| `turn.when(predicate, turn, label)` | checks the request first; a request that does not match fails the test |
| an array of events, or a function `(request, ctx) => Response` | for a detail of the wire format the turns above do not produce |

The turns speak the OpenAI streaming format. `model.requests` holds a frozen copy of every request, `model.calls` and `model.remaining` count, and `model.waitForCall(n)` resolves when the n-th call has arrived, so a test of `turn.hang()` needs no sleep.

A model call that the script has no turn for fails the test. The transport throws, and the helper reports the call to the test runner, which fails the test afterwards. So the test also fails when the code under test caught the error and answered with an error message. `model.assertDone()` fails in addition when turns are left over.

Import the helper at the top of the test file. Under `node --test` the helper fails the test through a hook, and a hook that is registered while a test or a `before` hook runs is never run. With a lazy `await import()` of the helper the unscripted call therefore fails the test file as a whole when its process ends, not the single test. Under jest the test that made the call fails wherever the helper was imported.

`scriptedChatService` of `helpers/scheduledTaskHarness.js` is built on the same helper with `strict: false`: there the transport throws and the test decides. Use the strict default in new tests.

## The fake clock

`server/tests/helpers/fakeClock.js` is a clock that the test moves:

```js
import { createFakeClock } from './helpers/fakeClock.js';

const clock = createFakeClock();
const id = clock.setTimer(() => expire(), 15_000);
clock.advance(15_000);   // fires every timer that is due, in order
clock.now();             // milliseconds since the epoch, like Date.now()
```

`advance(ms)` fires timers by due time; timers due at the same time fire in the order they were set. `advanceAsync(ms)` also lets awaiting code continue between two timers. It calls a timer's function and does not wait for what the function returns, as real timers do. So an async function that waits on a later timer of the same clock, such as a tick that renews a lease and then waits for its backoff, continues inside the same call when that timer is due in it. When such a function rejects, `advanceAsync` rejects with its error after every due timer has fired. `setRepeatingTimer`, `clearTimer`, `runDue`, `jumpTo` and `pending` complete the set.

The clock only helps code that takes its time source as a parameter. Write new code that reads time that way: `{ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }`, or one `clock` object. For existing code that calls `setTimeout` or `Date.now` itself, use the fake timers of the test runner (`mock.timers` of `node:test`, `jest.useFakeTimers()`). `server/tests/appToolsGateway.characterization.test.js` shows this for the 3-minute limit of an app call.

No test of these tools waits on real time. `server/tests/no-real-time-waits.test.js` searches `server/tests/golden/`, the directories of the test tools and the test files that came with them for sleeps and for timers with a literal delay of one second or more, and fails on a hit. When you add a test file for runs at the top level of `server/tests/`, add it to the list `SEARCHED` in that test.

## The golden harness

A golden test answers one question: does a run still do what it did when the golden was recorded? The harness in `server/tests/golden/` runs an input through the server on a scripted model, writes down what the server did, and compares that record with a JSON file.

Nothing of the server is replaced. The harness starts real storage in a temporary directory, fills the config cache, and changes one thing: the process-wide model client answers from the script. A recording also gets an empty contents directory of its own, so it never reads or writes your `contents/`.

### What a record holds

| Part | Content |
|---|---|
| `envelopes` | every event the run sent to a client, with the stream it was sent to (`streamId`) |
| `ledger` | every event of the [run ledger](run-ledger.md) |
| `offeredToolIds` | the tool ids offered to each model call |
| `modelRequests`, `toolSchemas` | a projection of each model request: the sequence of roles, a hash of the system prompt, the tool names with their parameter schemas, and the model options |
| `toolCalls` | each tool call with its arguments and its outcome |
| `approvals` | the interactions raised and answered |
| `usageRecords` | the usage records written |
| `result`, `storedMessage`, `evidence`, `httpResponse` | what the case read back from its surface |

A surface that is recorded through its HTTP route puts every request with its status, headers and body or stream into `httpResponse`. A chat case also reads the chat back from storage: `storedMessage` holds the chat document and its messages, `evidence` the evidence record of each answer.

All parts are compared. The full request bodies are not part of a golden: a prompt edit would change every file. Set `GOLDEN_REPORT_DIR=<dir>` to have them written to `<dir>/<surface>/<case>.requests.json`, and compare two such directories when you need to see the wording.

### Normalisation

Some values differ between two runs and say nothing about behaviour. `normalise.js` replaces them. Each rule has a test in `normalise.test.js`.

| Rule | Example |
|---|---|
| Ids are numbered by first appearance, so the same id in two places stays the same id | `chat-<id:1>` |
| Timestamps and durations are replaced, also the time a paused run waited | `<ts>`, `<ms>` |
| The date in the date sentence of the system prompt is replaced | `The current date is <date>.` |
| `seq` and `rseq` are dropped, after a check that they increase: `seq` within one stream, `rseq` within one run | |
| Consecutive `step/delta` events of one step are merged, because the cut of a text into deltas depends on timing | |
| Events of one `parallelGroup` are ordered by call id, because tools that run side by side finish in any order | |
| Temporary paths, the product version and hashes over dated content are replaced | `<tmp>`, `<version>`, `<hash>` |
| `heartbeat` and `stream/connected` frames are dropped | |

A case can name more id patterns, volatile keys and text rules in its config (`idPatterns`, `volatileKeys`, `textRules`). A text rule replaces a date that is written in a form of its own, such as the title of the chat of a scheduled run. Write such a rule in `surfaces/textRules.js` and test it there against the function of the product that writes the text, over every month and in both languages: the short name of a month is not three letters long in every month (`Sept` in en-GB). `surfaces/fixtures.js` holds the patterns the surfaces share. Add a rule only for a value that cannot matter. A value that could matter belongs in the golden.

Two things are left out of a golden because they cannot be equal on two runs, and each surface says so where it does it:

- The system prompt of the surfaces holds no date sentence. The evidence of an answer holds a hash of every message sent to the model, and with the date in the prompt that hash would differ every day. The date rule has its own cases in `harnessCases.js`.
- Where the server mints the id of the chat for a run (a turn of the inference API, an app call, a scheduled run), the hash over the options of a model call differs from run to run and is replaced. For a scheduled run the prompt also holds the time of the run, so the evidence is recorded without its content hashes.

### Tests in the directory

| File | Checks |
|---|---|
| `golden.test.js` | every case equals its golden, and every file under `__goldens__/` belongs to a case |
| `determinism.test.js` | every case gives the same bytes twice in one process and once in a second process that runs 400 days later |
| `goldenChange.test.js` | a changed prompt order and a changed tool schema fail the golden |
| `differenceList.test.js` | every changed golden is named by a row of the difference list |
| `differenceRows.test.js` | every row names a golden that exists and parts a record has; a signed row names an owner |
| `differenceSignatures.test.js` | the signature check, on a scratch repository |
| `harness.test.js` | a recording that cannot start leaves nothing behind for the next one |
| `normalise.test.js`, `sideBySide.test.js` | the rules and the comparison tool |

When you add cases, run the determinism test several times before you commit the goldens:

```bash
for i in $(seq 20); do node --test server/tests/golden/determinism.test.js || break; done
```

### Add a case

A case is a `defineCase({ surface, name, title, config, script, run })`. `config` fills the config cache, `script` returns the model's turns, and `run(env)` drives the surface and returns what it read back. `harnessCases.js` holds two small cases that drive a chat turn in-process; they exist so the harness itself is tested. The cases of a surface live in `surfaces/<file>.js` and are listed in `cases.js`. Take the apps, the model and the fixture tools from `surfaces/fixtures.js` (`surfaceConfig`), and `surfaces/http.js` for a surface that is driven through its route.

Drive a surface through the entry point the product uses: a route, a service call, a tool call. Wait for an event (a frame on the stream, an event of the run ledger, a model call that has arrived), never for a timer.

Then record and commit:

```bash
UPDATE_GOLDENS=1 node --test server/tests/golden/golden.test.js
git add server/tests/golden/__goldens__
```

`UPDATE_GOLDENS` is refused in CI. A new golden needs no row in the difference list; a changed one does.

A golden file without a case fails `golden.test.js`. When you remove or rename a case, delete its golden file in the same pull request. A deleted golden is a changed one: it needs a row with the part `(deleted)`. This keeps a case from being dropped quietly while its golden stays in the directory and is never compared again.

## The recorded surfaces

The goldens under `server/tests/golden/__goldens__/` were recorded before the first change of the run service work, with no production code in the same pull request. They are what "behaves as before" is measured against.

| Surface | Cases | Driven through |
|---|---|---|
| `chat` | plain, one tool, two tools, approval approved, approval refused, approval paused and continued with "allow for this chat", connect resume, question paused and resumed, structured output, compaction, model error, user stop, temporary chat, superseded turn | the HTTP routes `POST` and `GET /api/apps/{appId}/chat/{chatId}` and `POST .../stop` |
| `scheduled-task` | plain, tool, notes in the prompt, notes composer, owner who is an admin, approval refused by the owner | the task service and `executeTaskRun` |
| `completions` | non-stream, stream, a tool of the caller, unknown model, provider error, client disconnect | the HTTP route `POST /api/inference/v1/chat/completions` on a model |
| `inference-app` | an app turn through `/chat/completions` (non-stream, stream, tools refused) and through `/responses` (non-stream, stream, a plain model, unknown app) | the HTTP routes of the inference API with `model: "app:<id>"` |
| `app-as-tool` | from a chat turn, the 3-minute limit, depth 1, approval refused, question refused, a caller without resolved permissions, a user who may not open the app | a chat turn of the calling app, and `invokeAppTool` |
| `mcp` | `tools/call` of an app, with a file, with a provider error, with a tool that needs approval | an MCP client of the SDK on the server iHub builds for the caller |
| `a2a` | `message/send`, `message/stream`, a provider error | `dispatchA2A`, the function behind `POST /a2a` |
| `legacy-workflow` | see [The legacy workflow path](#the-legacy-workflow-path) | the workflow runner, the trigger manager, the resume sweep, and for one case the chat route and `GET /api/chats/{chatId}` |

Every chat case is recorded twice, once for each position of the feature **Chat answers on one connection** (`chatPostStream`). The server does not read that flag; it tells the browser how to ask. With the flag off the browser holds a `GET` stream and the `POST` answers with JSON (`chat/<case>.json`). With the flag on the browser posts with `Accept: text/event-stream` and the frames arrive on that response (`chat/<case>-post-stream.json`). The two files of a case differ from each other, in the requests and in where the frames arrive. A change to the chat route has to leave both files unchanged.

The routes are mounted in an Express app with the error handler of the product. One thing stands in front of them that the product does not have: a middleware that signs the request in as the user of the case. For `mcp` and `a2a` the bearer token check (`mcpAuth`) is not part of the recording for the same reason; the caller is built with the scopes of a token.

Two cases are named after a known weakness and pin it: `app-as-tool/user-without-permissions` (a caller without a permissions object may call any app) and `scheduled-task/admin-owner` (the run of a task whose owner is an admin). A row of the difference list names each.

## The legacy workflow path

The engine that runs the old node types stays as it is while a new engine is built beside it. Two things hold it in place.

**The frozen files.** `server/tests/workflow-legacy-frozen.test.js` holds a sha256 of each of these files and fails when one changes, when a file is added to a frozen directory, and when one is removed:

- `server/services/workflow/WorkflowEngine.js`, `DAGScheduler.js`, `StateManager.js`, `checkpointResume.js`
- everything under `server/services/workflow/executors/`
- `server/tools/agentTools.js`
- everything under `server/agents/memory/`, `server/agents/inbox/` and `server/agents/runtime/`
- `server/validators/agentProfileSchema.js` and `agentInboxSchema.js`

Only a security fix changes a frozen file. It updates the hash in the same pull request and says that it is one. `node server/tests/workflow-legacy-frozen.test.js --print` prints the table for the files as they are. Everything else belongs in the new engine.

**The goldens.** `surfaces/legacyWorkflow.js` records six runs of the legacy path:

| Case | What it pins |
|---|---|
| `law-consultation-upload` | the shipped workflow `stellungnahmen-review-v2` on six synthetic statements: one model call per readable document, the records and the report |
| `law-consultation-ifinder` | the shipped workflow `stellungnahmen-review-ifinder-v2` on a synthetic iFinder result set: the search plan from the notes of the agent, two rounds of search, every request iHub sends to iFinder, one model call per document that could be loaded, the records and the report |
| `paused-and-resumed` | the shipped workflow `approval-workflow` pauses on its question to a person and continues with the answer |
| `resumed-after-restart` | an execution that was interrupted in a step is found by the sweep of a new engine and continued from its checkpoint, as the system user |
| `delivered-after-restart` | a workflow started from a chat with `@approval-workflow` waits for a person when its server dies. The next read of the chat closes the turn with "waiting for your input", the person answers, and the read after that puts the result into the chat in the place of the waiting answer (`deliverResumedWorkflows`) |
| `trigger-started` | a workflow started by its webhook trigger |

The statements are files under `tests/fixtures/stellungnahmen/`: a PDF, a DOCX, a scan without a text layer, a PDF of 40 pages, an empty text file, and a DOCX with umlauts and a table. Everything in them is invented. They are read by the same code that reads an upload, so the golden also holds what happens to the scan (it reaches the model as a note that no text could be read) and to the empty file (it is refused before the workflow starts). `server/tests/golden/surfaces/buildStatementFixtures.mjs` is how the files were made; run it only to change a fixture, and record the goldens again afterwards.

**The iFinder result set.** `tests/fixtures/stellungnahmen/ifinder/result-set.json` holds what an iFinder answers for the law consultation: the search profiles of the user, six documents and the hits of each query. It has the shape of the iFinder retrieval API as iHub reads it. It is synthetic: no iFinder installation was asked for it, and everything in it is invented. Among the documents are one that is longer than the workflow reads, one without text and one that cannot be loaded (404), which the workflow skips.

`surfaces/ifinderStandIn.js` serves the result set from a real HTTP server on the loopback interface. Nothing of iHub is replaced: the iFinder installation points at the stand-in, and `iFinderService` builds, signs and sends its requests as it does to a real installation. The stand-in writes down every request with the claims of its token and whether the token was signed with the key of the installation, and the golden holds that list under `result.ifinder.requests`. The key pair is made when the recording starts; no key is in the repository. Use the stand-in and the result set for any test that needs an iFinder.

**What the restart cases are.** A restart is played inside the recording process. The engine is replaced by a new one, and for `delivered-after-restart` the state a dead process takes with it is dropped by hand: the bridge between the workflow and its chat, the run the ledger held open, and the engine with its executions (`processDied` in `surfaces/legacyWorkflow.js`). No process is killed there. The same story with a real server that is killed and started again is the fault test `server/tests/faults/legacy-workflow-restart.fault.test.js` (see [The fault tier](#the-fault-tier)). Two limits of the goldens follow:

- The sweep of a starting server is called with the options `server/startup/worker.js` gives it for a plain workflow, written again in the test, because that file does not export them. A change to the options there does not show in these goldens.
- A case that lets its server die calls `env.processRestarted()`. The check that `seq` increases within a run then runs on each side of the restart on its own.

`delivered-after-restart` pins one behaviour that is a defect: when an answer continues an execution that the answering process did not start, the engine does not take up the sequence of the run ledger, and the run counts its events again from 1 (`result.ledgerSequence` in the golden: last before the restart 7, first after it 1). The ledger of such a run holds two events for each of these numbers. The file that decides this, `WorkflowEngine.js`, is frozen. Whoever fixes it changes the golden and adds a row.

These goldens compare nothing with a rebuilt workflow. For that see [Side by side](#side-by-side).

## The difference list

A golden never changes without a decision. The decisions are rows in `server/tests/golden/differences.json`.

The list starts with the differences that are known before any code moves. Each row is `proposed` and has a default decision: unify to one behaviour, keep an option, or add a field.

| Row | What will differ |
|---|---|
| `fail-open-removal` | an app call by a caller without resolved permissions is refused |
| `unattended-admin-rights` | an unattended run of an admin no longer carries admin rights |
| `tool-result-truncation` | one rule for how a long tool result is cut |
| `headless-approval-policy` | one policy for a call that needs approval where nobody can approve |
| `tool-error-text` | the text a model gets for a failed or refused tool call |
| `compaction-trigger` | when a long tool loop condenses its context |
| `maximum-rounds` | one limit for the rounds of a tool loop |
| `abort-cause` | a stopped run says why it stopped |
| `usage-origin-agent-id` | a usage record names the origin of its run and the agent |
| `evidence-actor` | an evidence record names the actor of the run |
| `run-started-additive-fields` | `run/started` gains fields |
| `app-as-tool-display-fields` | the tool row of an app call gets the display fields of a sub-agent: the name of the app alone as its title (today `App: <name>`) and the activity kind of a sub-agent (today `tool`) |

A proposed row accepts nothing yet. The pull request that makes the change edits the row (it says what was decided in the end and names the goldens and parts that really changed), records the goldens again, and gets the row signed.

### When a golden test fails

1. Read the paths in the failure message. They name the parts of the record that differ.
2. Decide what it is. A regression is fixed in the code. A change that is wanted needs a row.
3. For a wanted change, add a row and record the golden again with `UPDATE_GOLDENS=1`.

Never record a golden again to make a test pass without a row. `differenceList.test.js` fails the pull request when a golden changed and no row names it.

### A row

The example is not a row of the list.

```json
{
  "rows": [
    {
      "id": "example-row",
      "title": "The text of a tool error names the tool",
      "decision": "Accepted: every surface now sends the same text.",
      "goldens": ["chat/one-tool.json"],
      "parts": ["envelopes", "ledger"],
      "pr": "example-pull-request",
      "state": "proposed",
      "signedBy": null,
      "signedOn": null
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | lower-case and unique |
| `title` | what differs, in one sentence |
| `decision` | what was decided, and why |
| `goldens` | the golden files the row is about, relative to `__goldens__/` |
| `parts` | the parts of the record the row accepts as changed; `(deleted)` for a golden that is removed |
| `pr` | the pull request that changes the goldens |
| `state`, `signedBy`, `signedOn` | `proposed` with both `null`, or `signed` with the login of the signer and the day |

A row counts for a changed golden when it names the golden, lists every part that changed, and is new or changed in the same pull request. A row that was accepted for an earlier change does not cover a later one. A change in what the model is sent shows in `modelRequests` or `toolSchemas` and needs those parts in a row like any other.

### How a row is signed

The author of a change writes the row with `state: "proposed"`. An owner of the difference list signs it: `state: "signed"`, `signedBy` with that owner's GitHub login, `signedOn` with the day. `.github/CODEOWNERS` names two owners, `manzked` and `Intradmin`.

In practice:

1. The author opens the pull request with the row still `proposed` and the goldens recorded again.
2. An owner reads the row, the decision and the diff of the goldens, and approves the pull request.
3. The author (or the owner) sets `state`, `signedBy` and `signedOn` in a commit that changes nothing else in the list or the goldens, and the owner approves again, because an approval covers only the commit it was given for.
4. Re-run the job **Golden difference list**.

A pull request never signs its own row without that approval: the check below fails.

The signature is valid only with the owner's approving review of the pull request that adds it. `scripts/check-difference-signatures.js` checks this:

- The owner is the one `.github/CODEOWNERS` names for `differences.json` on the target branch. A pull request cannot name its own signer. There is one exception: the pull request that introduces the difference list on a target branch that has neither the list nor an owner for it. There the check uses the owner that the pull request adds to `CODEOWNERS`, and prints that it did.
- The owner's latest review must be an approval, given for a commit whose difference list and whose goldens (`server/tests/golden/__goldens__/`) equal those of the head commit. An approval covers neither a row nor a golden pushed after it. A row names a golden file and its parts, not the content, so the content that the owner saw is part of the approval. When a golden is recorded again after the approval, the owner approves again.
- Editing or removing a signed row needs the same approval.
- A pull request that touches no signature passes without a review.
- Every row needs an `id` of its own. The check stops with exit code 2 when a row has no `id` or two rows share one, because it could not tell which row a signature belongs to.

The check and the difference list test run in the job **Golden difference list** of the end-to-end workflow (`.github/workflows/e2e.yml`), because they need the history of the target branch. In `npm run test:quick` on a shallow checkout the repository part of `differenceList.test.js` is skipped and says so.

After the owner approved, re-run the job **Golden difference list**. A review does not start the workflow by itself.

GitHub does not let the author of a pull request approve it. This is why there are two owners: a pull request that one owner opened is approved, and with that signed, by the other. The approval of either owner satisfies the check; `signedBy` names an owner, and the approving review is the proof.

To run the check by hand, save the reviews of the pull request and pass them:

```bash
gh api repos/<owner>/<repo>/pulls/<number>/reviews > reviews.json
node scripts/check-difference-signatures.js --base origin/main --reviews reviews.json
```

### What the gate needs from the repository settings

The job runs on `pull_request`. GitHub then runs the pull request's own copy of the workflow, of `scripts/check-difference-signatures.js` and of `differenceList.test.js`. A pull request could change one of them and switch the gate off for itself. `.github/CODEOWNERS` therefore names the product owner for these files:

- `server/tests/golden/differences.json` and `.github/CODEOWNERS`
- `scripts/check-difference-signatures.js` and `scripts/check-test-only-diff.js`
- `.github/workflows/e2e.yml`
- `server/tests/golden/differenceList.js` and `server/tests/golden/differenceList.test.js`

`CODEOWNERS` alone only asks the owner for a review. The gate holds only with these two settings in the branch protection of the target branch:

- **Require review from Code Owners**. This is a precondition of the gate, not an addition to it. Without it a pull request can change the workflow or a check and merge without the owner.
- The job **Golden difference list** as a required status check.

Without these settings the check still catches the honest mistake, a signature that nobody approved. It does not stop a pull request that edits the check.

### A test-only pull request that records goldens changes no production code

A golden is worth something only when it was recorded before the code it pins was changed. The same job therefore runs `scripts/check-test-only-diff.js`. It checks a pull request when both of these hold:

- its title has the type `test`, `docs` or `ci`, and
- its diff adds, changes or deletes a file under `server/tests/golden/__goldens__/`.

Such a pull request may not change production code: a file under `server/` outside `server/tests/`, under `shared/` or under `client/`. A file there fails the job and is named. Everything else passes: tests, fixtures, docs, concepts, scripts, workflows, `package.json`.

Not checked:

- A pull request of another type (`feat`, `fix`, `refactor`, ...). It may change production code, and a golden it changes needs a row.
- A `test`, `docs` or `ci` pull request that touches no golden, for example a concept under `concepts/` or a test harness that brings an inert hook in the server with it. Nothing is recorded in it.

The script reads the title from GitHub when it runs (`PR_NUMBER`, `GITHUB_REPOSITORY`, the token in `GH_TOKEN`). It does not use the title of the event that started the workflow, because a job that is run again gets the same event again, with the title the pull request had when the workflow started. When the title cannot be read, the job fails with exit code 2 and checks nothing.

Changing the title does not start the workflow. After you change it, re-run the job **Golden difference list**: the re-run judges the new title.

By hand, without a pull request, the title comes from `PR_TITLE`:

```bash
PR_TITLE="test: more goldens" node scripts/check-test-only-diff.js --base origin/main
```

## Side by side

`server/tests/golden/sideBySide.mjs` runs two implementations on the same input and writes their reports and records next to each other. It is made for comparing a legacy workflow with its rebuild.

```bash
node server/tests/golden/sideBySide.mjs \
  --left <module> --right <module> --input <dir> --out <dir> \
  --left-label legacy --right-label rebuilt
```

A side is a module that exports `run({ input, files, label })` and returns `{ report, record }`: the Markdown the implementation produced for the user, and a record of what it did. A side can also be a golden case, written as `case:<surface>/<case>`.

The tool writes `<label>.report.md` and `<label>.record.json` for each side, and a `README.md` that lists the input files and the parts of the two records that differ. It asserts nothing: the two sides are expected to differ, and people decide which differences are fine. It exits with 1 only when a side could not run.

## The fault tier

A fault test answers a question no test in one process can: what does a run do when its server dies in the middle? The fault harness (`server/tests/faults/harness.mjs`) starts a real server, kills it, starts another one on the same contents directory, and looks at what is left: the chat, the events of the run, and how often a write ran.

```bash
npm run test:faults        # the whole fault tier, about a minute
```

The tier starts its own servers on free ports and its own contents directories (`contents-e2e-faults-<random>`, removed afterwards). It needs no model key and no network. Do not run it together with `npm run test:quick` or an end-to-end suite.

### What a fault test looks like

```js
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CASE_TIMEOUT_MS, COUNTER_WRITE, SETUP_TIMEOUT_MS, TOOLS_APP, startStack } from './harness.mjs';

let stack;
before(async () => { stack = await startStack(); }, { timeout: SETUP_TIMEOUT_MS });
after(() => stack?.stop());

test('the server dies with a write in flight', { timeout: CASE_TIMEOUT_MS }, async () => {
  await stack.restart({ killPoint: 'e2e-counter-after-write' });
  const api = await stack.api();
  const turn = api.chatTurn(TOOLS_APP, `e2e-tool:${COUNTER_WRITE}:{"key":"order-1"}`);

  await stack.waitKilledAt('e2e-counter-after-write');   // the server is gone
  assert.equal(stack.counter.count('order-1'), 1);        // the write happened

  await stack.restart();                                  // same contents, no kill point
  assert.equal(stack.counter.count('order-1'), 1);        // and was not repeated
});
```

Name the file `<what>.fault.test.js` and put it under `server/tests/faults/`. Give every test `{ timeout: CASE_TIMEOUT_MS }` (90 seconds).

| The stack | |
|---|---|
| `startStack({ workers, killPoint, seed, stub, env, contents })` | seeds a contents directory and starts a server on it; `workers: 2` starts a primary with two workers. `contents` names a directory another stack left: the stack starts on it as it is and does not remove it |
| `stack.restart({ killPoint, signal, env, clockAheadMs })` | stops the server if it runs (`SIGKILL` unless told otherwise) and starts one on the same contents directory |
| `stack.kill(signal)` | `SIGKILL` or `SIGTERM` and waits until the server is gone; `SIGSTOP` and `SIGCONT` freeze and thaw it |
| `stack.waitKilledAt(name)` | waits until the server reached its kill point |
| `stack.api(credentials)` | an HTTP client that is signed in (the default admin unless told otherwise): `get`, `post`, `put`, `delete`, `stream`, `chatTurn` |
| `stack.readChat(chatId)`, `stack.readLedger(runId)`, `stack.evidence(runId)` | what the server answers for a chat, the events of a run and its evidence record |
| `stack.stored(namespace, key)`, `stack.journal(runId)` | what is on disk right now: a stored document, the events of a run. A running server can know more than its disk |
| `stack.counter` | the counter of the write tool: `count(key)`, `read(key)`, `snapshot()`, `reset()` |
| `stack.stub` | the model stub: `requests(marker)`, `stats()`, `hanging(key)`, `release(key)` |
| `stack.stop()` | stops everything and removes the contents directory the stack made |

`seed` adds to the contents directory before the first start: `features` and `platform` are laid over the two config files, `apps` are written as app files, and `workflows` lays fields over a shipped workflow. The contents directory already holds the two stub models, the users and the app `e2e-tools` of the [agents suite](developer-onboarding.md#agents-end-to-end-suite), and the test tools.

Three rules keep the tier from becoming flaky:

- **Never read a log line to find out where the server is.** Use a kill point and `waitKilledAt`, or wait for something the server stored (`stack.stored`, `stack.journal`) or sent (a frame of a stream).
- **Never sleep.** Every wait of the harness is for a condition, with a limit. `server/tests/no-real-time-waits.test.js` searches the directory for sleeps and for timers of a second or more.
- **Kill only once the disk says what you rely on.** A server writes its records a moment after it sends an event. `legacy-workflow-restart.fault.test.js` waits until the stored execution says `paused` before it kills. A test that kills earlier tests a different thing: what happens to a write that was still on its way.

The harness signals only the process groups it started. It never looks a process up by name or port.

Set `KEEP_FAULT_CONTENTS=1` to keep the contents directories with the log of each server (`faults-server.log`) after a run. Without it nothing is left behind, also when you interrupt the run.

### Kill points

A kill point is a place in the code where a fault test can end the process:

```js
import { killPoint } from '../utils/killPoint.js';

killPoint('after-tool-start');
```

In every installation this call does nothing. A kill point is armed only in a process that was started with **both** `NODE_ENV=test` and `IHUB_TEST_KILLPOINT=<name>`. The two are read once, when the module is imported; setting them in a running server arms nothing. With `NODE_ENV=production` the module is inert whatever else is set. `server/tests/killPoint.test.js` proves each of these with real processes.

When an armed process reaches its kill point, it appends the name to the file in `IHUB_TEST_KILLPOINT_FILE` and kills itself with SIGKILL: no handler runs, no buffer is flushed, as when a machine loses power. The harness reads the file. That is how `waitKilledAt` knows that the place was reached.

- `IHUB_TEST_KILLPOINT=<name>@<n>` kills at the n-th time the place is reached, counted per process.
- A kill point fires once per start of a stack. With two workers the worker that reaches it dies, the primary starts another, and neither the new worker nor the one beside it dies at the same place again.
- `startStack` and `restart` set the variables. Never set them yourself, and never in an installation.

To add a kill point:

1. Call `killPoint('<name>')` at the place, with the name as a plain string: lower-case words joined by hyphens.
2. Add a row to `server/tests/faults/KILLPOINTS.md`.

`server/tests/killPoint-inventory.test.js` fails when the code and the list differ. It also fails when a name is not a plain string, when a file other than `server/utils/killPoint.js` names the variable, and when a kill point is placed in a file of the [frozen legacy workflow path](#the-legacy-workflow-path).

The first two kill points are in the test tool `e2e_counter_write`, before and after its write. They give a test a write that is in flight when the server dies, without a kill point in the code that runs tools. The kill points of a feature come with the feature.

### The counter tools

A test of "this write ran exactly once" needs a write whose effect a killed server cannot take along and cannot hide. A server that is started with `NODE_ENV=test` and `IHUB_TEST_TOOLS=1` has two tools for that (`server/services/integrations/protocols/native/connectors/testTools.js`):

| Tool | |
|---|---|
| `e2e_counter_write` | adds one to the counter of a `key`; a write, never read-only |
| `e2e_counter_read` | returns the count and the values written for a `key`; a read, marked as content from outside iHub (`untrustedInput`) |

The counter itself (`tests/config/test-counter.mjs`) lives in the process of the test. The tools reach it through `httpFetch`, at the address in `IHUB_TEST_COUNTER_URL`. Every write counts, so two writes for one tool call show as 2.

No installation has these tools. The connector is registered only with both variables set, and it logs one warning line when it is. iHub ships no definition that names the connector: the definition and the installation are written into the contents directory of the test (`tests/config/test-tools-contents.mjs`). The agents browser suite uses the same tools on the same counter.

### The self-test of the harness

`harness.fault.test.js` tests the harness before any feature relies on it.

**Can it see a double write?** A harness that always reports one write proves nothing. The self-test runs a small server with a journal (`fixtures/journalServer.mjs`): a job writes "write started", writes to the counter, writes "write done". The server is killed between the write and "write done", and started again:

| The fixture is started | The counter shows |
|---|---|
| with its protection: an interrupted write is not repeated, the job needs attention | 1 |
| with `FIXTURE_WRITE_GUARD=off`: an interrupted write is repeated | **2** |

The switch is in the fixture, so the server of the product has no switch that turns a protection off.

**Does it work on the real server?** A real server is killed at a kill point with a write in flight, killed with a model call open, stopped with SIGTERM, and each time started again on the same contents directory. A second stack is started on the contents directory the first one left. `two-workers.fault.test.js` kills one worker of a primary with two workers, and then all of them.

These tests say nothing about what a run should do after a kill. A killed turn leaves its chat as it was, and the cases that pin "needs attention" and "run again" come with the features that build them.

### A legacy workflow that waits for a person

`legacy-workflow-restart.fault.test.js` is the story of the golden `legacy-workflow/delivered-after-restart` with real processes. A server runs the shipped workflow `approval-workflow` from a chat until it asks its question and is killed. A second server is started on the same contents directory. The chat says that it waits, the person answers, and the next read of the chat holds the result in the place of the waiting answer. Each step asked the model once.

Two things in it are worth knowing for your own tests:

- **The clock.** A chat whose turn claimed it less than two minutes ago is presumed alive, and is closed as interrupted only after that. The test does not sleep for two minutes: it starts the second server with its clock three minutes ahead, `stack.restart({ clockAheadMs })`. This is "the person came back later". Only `Date.now()` and `new Date()` are moved; timers keep their pace.
- **The pinned defect.** When an answer continues an execution that the answering server did not start, the legacy engine counts the events of the run from 1 again (#3875). The test pins this: the ledger of the run holds two events with the number 1. Whoever fixes it changes the assertion in the same pull request.

### Smoke cases on a pull request

The whole fault tier is too slow for every pull request. A fault test whose file name ends in `.smoke.fault.test.js` also runs on every pull request, in the job **Fault tests (smoke)** of `e2e.yml` (`npm run test:faults:smoke`). Give the tag only to the few cases that guard against the worst regressions. No file carries it yet.

### A load smoke with tool rounds

The nightly workflow also runs a load smoke: `npm run loadtest:smoke` starts the fake LLM of the load harness and a server of its own, runs the profiles `smoke` and `agentic`, and fails when a scenario made no turn or a turn failed. The profile `agentic` makes every turn a turn with one to three tool rounds. It measures nothing at three users; it keeps the load harness working. See [`tests/load/README.md`](../tests/load/README.md).

## App as tool

`server/tests/appToolsGateway.characterization.test.js` pins what happens today when one app calls another as the tool `app__<id>`: the shape of the result, the run of kind `subagent` and its link to the caller, the usage record, the 3-minute limit, the depth of one, the refused approval and the refused question. It runs the real pipeline on a scripted model.

Two of its tests are named `FAIL-OPEN, current behaviour`. They pin a known weakness: a caller without resolved permissions may call any app. Change them only together with the row of the difference list that removes the weakness.
