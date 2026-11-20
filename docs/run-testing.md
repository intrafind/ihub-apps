---
description: "The test tools for runs: runner tiers and quarantine, the scripted model, the fake clock, the golden harness and the difference list."
audience: developer
type: reference
---

# Testing Runs

A run is one piece of model work: a chat turn, a scheduled task, an app called as a tool. This page describes the tools that test runs without a model key and without waiting on real time. Use it when you write a test for code in `server/services/chat/`, `server/services/loop/` or `server/services/scheduler/`, when a golden test fails, or when you change behaviour that a golden pins.

For the browser suite and its model stub see [Developer Onboarding](developer-onboarding.md#agents-end-to-end-suite).

## Commands

Use the Node version of `.nvmrc`. All commands run from the repository root.

```bash
node scripts/run-server-tests.js                     # every server test of the pr tier (npm run test:server)
node scripts/run-server-tests.js golden              # only files whose path contains "golden"
node scripts/run-server-tests.js --list              # how many files each runner and each tier has
node scripts/run-server-tests.js --tier=nightly      # the whole nightly tier (npm run test:nightly)
node scripts/run-server-tests.js --tier=nightly faults   # only its fault tests (npm run test:faults)
node scripts/run-server-tests.js --check-quarantine  # fails when a quarantined test passes
UPDATE_GOLDENS=1 node --test server/tests/golden/golden.test.js   # record the goldens again
```

Do not run the server tests at the same time as an end-to-end suite. Together they can exhaust the memory of the machine, and the failure looks like a failing test.

## Runner tiers and the quarantine

`scripts/run-server-tests.js` runs every `*.test.js` under `server/tests/`. A file belongs to one tier:

| Tier | Files | Runs |
|---|---|---|
| `pr` | every file that is not in the nightly tier | on every pull request, as part of `npm run test:quick` |
| `nightly` | everything under `server/tests/faults/`, and every `*.nightly.test.js` | only with `--tier=nightly` (`npm run test:nightly`) |

Put a test into the nightly tier when it starts real server processes or runs for minutes. Name it `*.nightly.test.js`, or put it under `server/tests/faults/`. `--tier=all` runs both tiers.

No workflow runs the nightly tier yet, so a test in it is run only by hand. `npm run test:nightly` runs the whole tier. `npm run test:faults` runs only the files whose path contains `faults`; it does not run a `*.nightly.test.js` outside `server/tests/faults/`.

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

All parts are compared. The full request bodies are not part of a golden: a prompt edit would change every file. Set `GOLDEN_REPORT_DIR=<dir>` to have them written to `<dir>/<surface>/<case>.requests.json`, and compare two such directories when you need to see the wording.

### Normalisation

Some values differ between two runs and say nothing about behaviour. `normalise.js` replaces them. Each rule has a test in `normalise.test.js`.

| Rule | Example |
|---|---|
| Ids are numbered by first appearance, so the same id in two places stays the same id | `chat-<id:1>` |
| Timestamps and durations are replaced | `<ts>`, `<ms>` |
| The date in the date sentence of the system prompt is replaced | `The current date is <date>.` |
| `seq` and `rseq` are dropped, after a check that they increase: `seq` within one stream, `rseq` within one run | |
| Consecutive `step/delta` events of one step are merged, because the cut of a text into deltas depends on timing | |
| Events of one `parallelGroup` are ordered by call id, because tools that run side by side finish in any order | |
| Temporary paths, the product version and hashes over dated content are replaced | `<tmp>`, `<version>`, `<hash>` |
| `heartbeat` and `stream/connected` frames are dropped | |

A case can name more id patterns and volatile keys in its config (`idPatterns`, `volatileKeys`). Add a rule only for a value that cannot matter. A value that could matter belongs in the golden.

### Tests in the directory

| File | Checks |
|---|---|
| `golden.test.js` | every case equals its golden, and every file under `__goldens__/` belongs to a case |
| `determinism.test.js` | every case gives the same bytes twice in one process and once in a second process that runs 400 days later |
| `goldenChange.test.js` | a changed prompt order and a changed tool schema fail the golden |
| `differenceList.test.js` | every changed golden is named by a row of the difference list |
| `differenceSignatures.test.js` | the signature check, on a scratch repository |
| `harness.test.js` | a recording that cannot start leaves nothing behind for the next one |
| `normalise.test.js`, `sideBySide.test.js` | the rules and the comparison tool |

When you add cases, run the determinism test several times before you commit the goldens:

```bash
for i in $(seq 20); do node --test server/tests/golden/determinism.test.js || break; done
```

### Add a case

A case is a `defineCase({ surface, name, title, config, script, run })`. `config` fills the config cache, `script` returns the model's turns, and `run(env)` drives the surface and returns what it read back. `harnessCases.js` holds two small cases that drive a chat turn in-process; they exist so the harness itself is tested. Add the cases of a surface as `surfaces/<surface>.js` and list them in `cases.js`.

Then record and commit:

```bash
UPDATE_GOLDENS=1 node --test server/tests/golden/golden.test.js
git add server/tests/golden/__goldens__
```

`UPDATE_GOLDENS` is refused in CI. A new golden needs no row in the difference list; a changed one does.

A golden file without a case fails `golden.test.js`. When you remove or rename a case, delete its golden file in the same pull request. A deleted golden is a changed one: it needs a row with the part `(deleted)`. This keeps a case from being dropped quietly while its golden stays in the directory and is never compared again.

## The difference list

A golden never changes without a decision. The decisions are rows in `server/tests/golden/differences.json`; the file is created with its first row.

### When a golden test fails

1. Read the paths in the failure message. They name the parts of the record that differ.
2. Decide what it is. A regression is fixed in the code. A change that is wanted needs a row.
3. For a wanted change, add a row and record the golden again with `UPDATE_GOLDENS=1`.

Never record a golden again to make a test pass without a row. `differenceList.test.js` fails the pull request when a golden changed and no row names it.

### A row

```json
{
  "rows": [
    {
      "id": "tool-error-text",
      "title": "The text of a tool error names the tool",
      "decision": "Accepted: every surface now sends the same text.",
      "goldens": ["chat/one-tool.json"],
      "parts": ["envelopes", "ledger"],
      "pr": "tool-runner",
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
- `scripts/check-difference-signatures.js`
- `.github/workflows/e2e.yml`
- `server/tests/golden/differenceList.js` and `server/tests/golden/differenceList.test.js`

`CODEOWNERS` alone only asks the owner for a review. The gate holds only with these two settings in the branch protection of the target branch:

- **Require review from Code Owners**. This is a precondition of the gate, not an addition to it. Without it a pull request can change the workflow or a check and merge without the owner.
- The job **Golden difference list** as a required status check.

Without these settings the check still catches the honest mistake, a signature that nobody approved. It does not stop a pull request that edits the check.

## Side by side

`server/tests/golden/sideBySide.mjs` runs two implementations on the same input and writes their reports and records next to each other. It is made for comparing a legacy workflow with its rebuild.

```bash
node server/tests/golden/sideBySide.mjs \
  --left <module> --right <module> --input <dir> --out <dir> \
  --left-label legacy --right-label rebuilt
```

A side is a module that exports `run({ input, files, label })` and returns `{ report, record }`: the Markdown the implementation produced for the user, and a record of what it did. A side can also be a golden case, written as `case:<surface>/<case>`.

The tool writes `<label>.report.md` and `<label>.record.json` for each side, and a `README.md` that lists the input files and the parts of the two records that differ. It asserts nothing: the two sides are expected to differ, and people decide which differences are fine. It exits with 1 only when a side could not run.

## App as tool

`server/tests/appToolsGateway.characterization.test.js` pins what happens today when one app calls another as the tool `app__<id>`: the shape of the result, the run of kind `subagent` and its link to the caller, the usage record, the 3-minute limit, the depth of one, the refused approval and the refused question. It runs the real pipeline on a scripted model.

Two of its tests are named `FAIL-OPEN, current behaviour`. They pin a known weakness: a caller without resolved permissions may call any app. Change them only together with the row of the difference list that removes the weakness.
