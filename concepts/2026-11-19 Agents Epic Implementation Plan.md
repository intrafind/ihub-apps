# Agents, Sub-Agents and Workflow Steps: Implementation Plan

Date: 2026-11-19, revised 2026-11-20 after three adversarial reviews (sections 11 and 12). Epic: #3771. Code state: main at dd586bb (v5.7.2).
Product design: `concepts/2026-11-17 Agents, Sub-Agents and Workflow Steps — Target Model.md` and the product owner decisions on the epic. This document plans the implementation only. It is added to the repository as `concepts/2026-11-19 Agents Epic Implementation Plan.md` by the first pull request of the stack.

## 1. Goal

Build the epic as one ordered stack of 78 pull requests. Each pull request is one feature or one behaviour-neutral refactor, can be reviewed alone, leaves the product releasable, and carries its tests, its docs, a release entry where an admin or user sees a change, and one end-to-end check that runs without a model key.

The stack follows the release slices the product owner decided:

| Slice | Issues | What a user or admin gets |
|---|---|---|
| A | #3786, #2712, #3191, #2485 | Test tooling and goldens first; proof that long answers are not cut off; a message to a running answer; read-only tool calls side by side |
| B | #3772, #3781, #3777, #3782, #3787 | Answers continue after a server restart; one admin page for all runs with pause before an upgrade; an Activity page |
| C | #3196 (blocking), #3785, #3780 | A chat hands parts of its work to sub-agents |
| D | #3197, #3196 (background), #3785 | A chat comes back by itself: follow-ups and background sub-agents |
| E | #3780, #3773, #3783, #3787, #3785 | Personal and provided agents; 'Scheduled'; consent |
| F | #3788 (PRs 0 to 6), #3774, #3784 | Workflows from ten steps on a new engine; the law consultation rebuilt; legacy notice |
| G | #3788 (PRs 7 to 11), #3775 | Agents in fixed and in planned mode |

#3198 (browser push) is deferred and has no pull request.

The plan has more pull requests than the 25 to 40 one might expect. The sub-issues' own pull request lists add up to more than 60, three of the pull requests they define are too large to review (`ChatService.runTurn` and `_finishTurn` are 1,200 lines together, #3777 PR 4 covers flush, resume and the unknown-outcome flow, the workflow editor is two surfaces), and the review of the first plan split seven more. Merging further would produce pull requests above 1,500 changed lines.
## 2. Method

### 2.1 Order and merging

- The order is linear: PR n+1 branches off PR n. The branch name is the epic prefix plus the suffix in the table.
- The first five pull requests are test tooling (PR 1 to PR 5). Each is merged to main as soon as it is approved, ahead of slice A: they have no production diff except the inert kill point module and the gated test tools, the goldens must be recorded before the first production change, and the scheduled nightly needs its workflow file on the default branch.
- After that, the end of each slice is a merge point. When the last pull request of a slice is approved, the slice is merged bottom-up and the next slice starts from that state. The order stays the same either way.
- Evidence from the fault tier on a branch that is not on main comes from the label `run-faults` on the pull request (PR 5), never from the cron schedule.
- A move-only pull request never changes behaviour, and a pull request that changes behaviour never moves large blocks.
- A switch kept 'for one release' is removed in the first release after the slice that introduced it shipped.
- The last pull request of slices B, E and F compares the admin surfaces of its slice with the state of the admin rework (#3739, #3742) and notes the result in the named issue.

### 2.2 What every pull request contains

1. Code, with the SPDX header on new files.
2. Tests named in its section. A pull request that adds a quarantine entry, or changes a golden file without a signed row in `server/tests/golden/differences.json`, is not mergeable. A signature is valid only when the product owner approved the pull request that adds it (`.github/CODEOWNERS` and the signature check of PR 3).
3. Docs in the same pull request; new pages are added to `docs/SUMMARY.md`; glossary rows for the terms it ships. Docs describe only what an admin or user can find in the product at that pull request.
4. A line in the PR body: 'release entry: new <title> / extended <title> / none because <reason>'. Entries go to `docs/releases/next/` through the `/document-feature` skill. One capability has one entry; a fix to behaviour that has not shipped gets none.
5. EN and DE strings for every new key; German uses the formal 'Sie'; the retired-words lint is green.
6. Route changes: a new top-level client route is added to `client/src/App.jsx`, `KNOWN_ROUTES` in `client/src/utils/runtimeBasePath.js` and the inline list in `client/index.html`; a page that is added, removed or redirected changes `CLEAN_PAGES` in `tests/e2e/accessibility.spec.js` in the same commit; the URL is loaded directly at the root and under a subpath.
7. API changes follow `docs/api-guidelines.md`: errors are thrown as `ServiceError` with a code from `shared/apiErrors.js`, lists are `{ items, nextCursor }`, non-CRUD operations are `_action` segments, new routes get a `@swagger` block. From PR 7 on, every new route under `/api/runs` or `/api/chats` gets its row in `server/tests/routeInventory.table.js`; the inventory test fails without it.
8. Outbound calls use `httpFetch()` or `getTlsBypassOptions()`; a test covers a whitelisted and a non-whitelisted host.
9. The end-to-end check of its section, with the tail of each command's output pasted into the PR body. A browser check that needs a write counter, a job in a given state or outside content uses the agents helper (`GET /__counter`, `POST /__seed-job`, the tool `e2e_counter_read`), never a hand-made fixture.
10. Size: when a pull request passes 1,500 changed lines outside tests, fixtures, goldens and locale files, the implementer stops and splits it along the line its section names (or by file group when none is named) and records the split in the PR body. Move-only pull requests are exempt and say so.

### 2.3 Commands (verified in the build environment)

```bash
export PATH=/opt/node24/bin:$PATH            # the default Node is 22; the repository needs 24
node scripts/run-server-tests.js > baseline.log   # record the baseline before the first commit
npm run lint && npx prettier --check <changed files>
node scripts/run-server-tests.js <substring>      # fast loop
npm run test:quick                                 # full gate; never together with the e2e stack
npm run test:boot
npm run check:response-shapes                      # when a response changed
npx jest --config tests/config/jest.config.js tests/unit/client/<file>
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e:agents -- <spec>   # from PR 1 on
npm run test:faults                                # from PR 5 on; starts its own servers
reuse lint
```

Manual stack without a model key (until PR 1 provides `agents-server.mjs`): start `tests/config/e2e-server.mjs` with its own ports and a fresh contents directory, sign in with `admin` / `password123` through `POST /api/auth/local/login`, and send a chat turn with `Accept: text/event-stream` to `/api/apps/chat/chat/<uuid>` using the model `e2e-stub`. The stub's `/__last-request` shows what reached the model. If a jest worker reports 'ran out of memory', re-run that file alone before investigating.

The pull request job runs the specs tagged `@gate` plus the specs mapped to the changed paths, inside a 10-minute budget. The full suite, the transport matrix (`@matrix`, one server start per platform overlay) and `@slow` specs are one job of `e2e.yml` that is started by hand ('Run workflow') and before each slice merge; no workflow runs it on a schedule until PR 5 adds the nightly workflow, which calls it every night from then on. Performance gates compare the base commit and the head commit back to back in one job (five repetitions each, medians); when the spread of the base runs is above 10 % the numbers are reported and the gate becomes a release gate measured by a person.

### 2.4 Flags and switches

| Key | Kind | Default | Added in | Notes |
|---|---|---|---|---|
| `chatPostStream` | feature (exists) | off | - | Every chat change is tested with it off and on |
| `parallelToolCalls` | feature, preview | off | PR 8 | Plus the model field `parallelToolCalls: false` |
| `steering` | feature, preview | off | PR 10 | The owner-only rules of PR 7 are not behind it |
| `platform.runs.chatOnRunService` | internal switch | true | PR 17 | Kill switch, not in Admin, Features; false implies `chatJobs` false; removed one release later |
| `platform.runs.chatJobs` | platform switch | false, true from PR 32 | PR 23 | Rollback: set it to false. The route `POST /api/chats/{chatId}/messages` exists in both positions |
| `activity` | feature, preview | off | PR 31 | |
| `subAgents` | feature, preview | off | PR 33 | Carried over from an admin-set `appAsTool: true`; also governs the `app__` tools of the MCP gateway |
| `delegation` | definition setting | `normal` | app: PR 33; agent: PR 44; workflow: PR 58 | off, normal, extensive |
| `platform.runs.subAgents.background` | config | false | PR 42 | Needs `subAgents` and the permission `scheduledTasks` |
| `followUps` | feature, preview | off | PR 40 | Needs the permission `scheduledTasks` ('Unattended work') |
| `agents` | feature, preview | off | PR 43 | Permissions `agents`, `publishAgents` |
| `workflows` | feature (exists), preview | off | - | Gates the new steps too |
| `agentPlannedMode` | feature, preview | off | PR 75 | |
| `agentFactory`, `appAsTool` | removed | - | PR 13, PR 33 | Stored keys removed by V261; no alias |

Tested chat combinations in slice B: `chatPostStream` off and on, each with `chatJobs` off and on. `chatOnRunService: false` always runs with `chatJobs` off, because the server resolves it that way and logs it; a test boots with only the kill switch set and asserts the v5.7.2 chat path. `chatJobs` on with the run ledger off gives jobs that are not resumable, with a boot warning.

### 2.5 Migrations

Numbers assume nothing else lands first; they are assigned at merge, because CI checks them against each pull request's base. No pull request extends the migration of an earlier one.

| Migration | PR | What it does |
|---|---|---|
| V260 `move_task_concurrency_to_platform_runs` | 19 | Copies two keys to `platform.runs.unattended` where absent and removes the old keys |
| V261 `sub_agents_flag` | 33 | Removes `agentFactory` and `appAsTool` from `features.json`; carries `appAsTool: true` to `subAgents` |
| V262 `agent_permissions` | 43 | Writes `permissions.agents` and `publishAgents` for built-in groups where absent |
| V263 `add_rebuilt_law_consultation` | 65 | Adds the two rebuilt law consultation workflows; changes no existing file |
| V264 `add_rebuilt_corpus_analysis` | 70 | Adds `corpus-analysis` |
| V265 `add_rebuilt_iterative_research` | 71 | Adds `iterative-research` |
| V266 `add_rebuilt_approval_example` | 72 | Adds `approval-example` |
| V267 `add_default_planned_agent` | 78 | Adds the default planned agent |

The declaration of tool side effects (PR 8) needs no migration: `contents/tools/` is no longer read (V199, V202, V211). No migration ever overwrites a value an admin set; a default whose id already exists in the installation is skipped and logged. New namespaces need no migration: `run-jobs`, `run-claims`, `run-admission`, `run-pools`, `deleted-principals` (PR 21), `chat-run-claims` (23), `chat-events`, `chat-event-claims` (38), `user-agents`, `agent-versions` (44), `agent-chats` (45), `agent-user-settings` (52), `trigger-nonces` (56), `workflow-definitions` (59), `workflow-definition-revisions` (74). Each comes with a row in the erasure table of PR 20 and a row in `docs/pii-data-handling.md`: a user-deletion step, or, for `run-pools` and `trigger-nonces`, which hold no owner id, an exemption with that reason. The boot records of PR 22 (`contents/data/run-boots/`) are files beside the store and hold a pid and a host name only.

### 2.6 Wording

The glossary of PR 2 is binding. Words reserved for later pull requests:

| English | German | First used in |
|---|---|---|
| Stop answer / Send after this answer | Antwort stoppen / Nach dieser Antwort senden | PR 12 |
| Runs (admin page) | Läufe | PR 30 |
| Activity; Needs you; Running; Scheduled | Aktivität; Wartet auf Sie; Läuft; Geplant | PR 31, 41 |
| Done; Blocked; Needs attention; No change | Erledigt; Blockiert; Aktion erforderlich; Keine Änderung | PR 11, 27, 46 |
| Run again / Leave as is | Erneut ausführen / So belassen | PR 27 |
| Sub-agent; report | Sub-Agent; Bericht | PR 34, 37 |
| Follow-up | Wiedervorlage | PR 41 |
| Unattended work; Use agents; Publish agents | Unbeaufsichtigte Ausführung; Agenten nutzen; Agenten bereitstellen | PR 40, 43 |
| Agent; personal agent; provided agent | Agent; Persönlicher Agent; Bereitgestellter Agent | PR 48, 52 |
| Runs as you / as its own identity | Läuft als Sie / als eigene Identität | PR 47, 53 |
| Scheduled (navigation); scheduled run; Notes (of a scheduled task) | Geplant; geplanter Lauf; Notizen | PR 50 |
| Handoff | Übergabe | PR 55 |
| Step; Start, Agent step, Find documents, Extract data, For each, Check, Ask a person, Branch, Action, Write result | Schritt; Start, Agentenschritt, Dokumente finden, Daten extrahieren, Für jedes Element, Prüfen, Person fragen, Verzweigung, Aktion, Ergebnis schreiben | PR 58, 68 |
| Legacy workflow | Alt-Workflow | PR 67 |
| Mode: Free, Planned, Fixed | Frei, Mit Plan, Fester Ablauf | PR 73, 75 |
| Plan; plan revision; open points | Plan; Planänderung; Offene Punkte | PR 77 |

Never in UI text or user and admin docs: thread, steer, helper, sub-task, job, lease, worker, automation (as a product noun), workflow instance, service account (for an agent's own identity), 'Geplanter Agent'. 'Queued' alone is the run state only, never a chip text.

### 2.7 Default and marketplace workflows: proposed disposition

Product owner decision A6 says each existing workflow is challenged. `server/defaults/workflows/` holds 18 files; the marketplace lists 6. The table is the proposed answer to the blocking question of PRs 70 to 72. No existing file is changed or deleted in this epic; every legacy file keeps running and carries the legacy label from PR 67 on.

| Legacy file | Disposition | New file | PR |
|---|---|---|---|
| `stellungnahmen-review-v2` | rebuilt | `law-consultation-upload` | 65 |
| `stellungnahmen-review-ifinder-v2` | rebuilt | `law-consultation-ifinder` | 65 |
| `stellungnahmen-review`, `stellungnahmen-review-ifinder` | superseded by their v2; not rebuilt | - | 72 (table only) |
| `corpus-analysis-direct`, `corpus-analysis-direct-v2`, `corpus-analysis-decomposed`, `corpus-analysis-decomposed-v2` | rebuilt as one workflow with inputs for parallelism and refine rounds | `corpus-analysis` | 70 |
| `iterative-research-human` | rebuilt, without the 'results so far' display | `iterative-research` | 71 |
| `iterative-research-auto`, `iterative-research-auto-v2`, `topic-deep-dive`, `research-assistant` | not rebuilt; a free-running research loop is an agent in planned mode (slice G) | - | 71 (release entry) |
| `approval-workflow` | rebuilt as the small example of the editor docs | `approval-example` | 72 |
| `knowledge-qa`, `document-analysis` | not rebuilt; two prompts in a row, replaced by an app | - | 72 |
| `claude-style-agent`, `claude-style-agent-phased` | unchanged and disabled; the default planned agent takes their place | default agent | 78 |

Marketplace (`ihub-marketplace/workflows/`, pull requests in that repository): `approval-workflow` and `iterative-research-human` get a version 2 file behind the version gate; `knowledge-qa`, `document-analysis`, `research-assistant` and `iterative-research-auto` get an upper bound in `compatibility.ihub` and a note that names the replacement.
### 2.8 Exclusive claims: claim by create

Where two workers must not both win (who runs a job, which run a chat has, which answer a run has, who consumes an event, which plan revision is number n, whether a nonce was seen), the winner is decided by one create-only write and by nothing else. Later sections refer to this rule as 'claim by create'.

- **What the storage enforces.** `documents.put` with `etag: null` ends in an exclusive create of the file and throws `EtagMismatchError` when the key exists (`server/storage/providers/filesystem/FilesystemDocumentStore.js:496-533`, `server/utils/atomicWrite.js:179-207`). That holds against a writer that stalled, because the file system decides at the write and not a read made earlier. `put` with an etag string does not hold against it: the provider compares the etag under an advisory lease on the key (`FilesystemDocumentStore.js:450-469`, `:844-849`), a lease that was not renewed for 15 s is taken over (`server/utils/fileLock.js:819-895`), and the section is not told and checks nothing before its rename (`FilesystemDocumentStore.js:562-564`), so a writer that passed the compare and then stalled replaces whatever the next writer stored. `delete` takes no condition. `LockManager.withLock` has the same gap by contract (`server/storage/LockManager.js:84-88`); its fencing token and `lease.isCurrent()` are a snapshot (`:123-126`) that narrows the gap to the time between the check and the write and does not close it.
- **Claim by create.** A claim is a document created with `etag: null` under a key that names the thing and, where the thing can be claimed more than once, its epoch: `<id>__<epoch>` (zero-padded; the next epoch is the highest listed plus one). Whoever created the key holds the claim. `EtagMismatchError` means that another worker holds it, and the loser reads the winner's document. The epoch is the fencing token.
- **Rules.** (1) State that successive holders change lives in the document of the epoch, which only its creator writes. Nobody writes into another holder's epoch and a reader takes the highest epoch, so the late write of a stale holder lands where nobody reads any more. A worker that wants to change something it does not hold claims the next epoch first. (2) A claim key is not deleted while the thing can still be claimed, because a delete reopens the key. The record that makes a thing claimable (job head, event) is deleted first, and a claimer reads it again after its create; a claim without it is void. (3) After its create a claimer lists the prefix again and gives up when a higher epoch exists. (4) A holder checks that its epoch is still the highest right before an effect it cannot take back (`assertHolder`, PR 28), and only after the intended effect was stored durably with its epoch.
- **What stays possible.** Rule 4 is a read. A holder can stall between the check and the effect, be taken over, and perform the effect afterwards. The effect is then performed once and late, never twice by the system: the new holder finds the stored call without a result and stops under the unknown-outcome rule (PR 27) instead of repeating it. Read-only work and model calls can run twice; that costs tokens and changes nothing.
- **Proof that a holder ended.** A worker acts on a job that another `workerId` holds as `running` (settle it, pick it up, free its quota entry or its pool slot) only on a ground that makes this safe. Until PR 28 there is one ground, `exited`, the confirmed end of the holder's process: (a) the cluster primary saw the `exit` of that worker process (`cluster.on('exit')`, `server/startup/primary.js:97`; the bus retracts a dead worker's presence from the same event, `server/clusterBus.js:520-549`), or (b) the epoch carries the boot id of an earlier start of this installation and the boot record of PR 22 shows that the process is gone. One worker (`WORKERS` = 1) is case (b). A heartbeat that stands still proves nothing about a process: a worker that was stopped by the system, swapped out or blocked in a long synchronous call sends none and continues later. Before PR 28 a silent holder is therefore left alone, its job stays `running` and its pool slot stays taken. From PR 28 on a heartbeat sequence that stood still for `takeoverMs` is the second ground, `silent`, and it is safe only through what that pull request adds: `assertHolder` at the chokepoints, the start of a model call and of a step among them, the flush before the effect and the unknown-outcome end (rule 4).
- **Allowed without a claim.** `put` with an etag string and `withLock` stay for writes where a lost or repeated write is harmless (an index entry rebuilt from its source, a cached copy, a field with one writer) and for keeping honest writers in line. A pull request that uses them says why loss of exclusivity is harmless there. Existing code that rests on them (the chat document under the chat lock, `ScheduledTaskRepository.mutateTask`) is not rewritten by this stack; where a new pull request builds exclusivity on such code, its section names the guard.
- **Tests.** Every claim has a stalled-writer case: a pause injected into one worker between its read and its write, longer than the takeover of the lease in question (15 s for the file lease of a `put`, `takeoverMs` for a job; fake clock, or SIGSTOP in the fault tier), with the other worker acting in the pause. The helper `server/tests/helpers/stalledWriter.js` comes with PR 21. From PR 21 on a grep test fails on a `put` with an etag other than `null` under `server/services/run/jobs/`, `server/services/run/events/` and `server/services/workflow/v2/`, apart from an allow-list in which every entry gives its reason.

## 3. The stack

| # | Branch suffix | Title | Slice | Issues | Size | Flag or switch | Migration |
|---|---|---|---|---|---|---|---|
| 1 | `e2e-stub-and-gate` | test(e2e): scripted model stub, agents e2e suite and pull request gate | A | #3786 | M | none | none |
| 2 | `glossary-wording-lint` | docs: glossary, retired-words lint and a when-to-use-which section | A | #3771 | S | none | none |
| 3 | `test-foundations` | test: quarantine clean-up, runner tiers, scripted model, fake clock and golden harness | A | #3786 | L | none | none |
| 4 | `goldens-difference-list` | test: characterization goldens for seven surfaces and the legacy workflow path, and the difference list | A | #3772, #3786, #3784, #3788 | L | none | none |
| 5 | `fault-harness-nightly` | test: fault harness with kill points, counter tool and a nightly workflow | A | #3786 | L | none (env `IHUB_TEST_KILLPOINT`, `IHUB_TEST_TOOLS`, only under `NODE_ENV=test`) | none |
| 6 | `long-turn-proof` | fix(chat): prove and harden turns that outlast the POST timeout | A | #2712, #3786 | S | none (tested with `chatPostStream` off and on) | none |
| 7 | `run-access-intents` | feat(runs): run and interaction access by intent; only the owner steers a run or answers its approvals | A | #3785, #3191 | M | none (security rule, not behind a flag) | none |
| 8 | `tool-side-effects-parallel-calls` | feat(chat): declared tool side effects and parallel read-only tool calls | A | #2485, #3785 | L | `parallelToolCalls` (preview, off); model field `parallelToolCalls: false` as opt-out | none |
| 9 | `chat-turn-start` | refactor(chat): move the start of a chat turn out of the route | A | #3191, #3777, #3197 | L | none | none |
| 10 | `steer-contract` | feat(runs): steering contract: id, cancel, events, pending list, leftover and send afterwards | A | #3191 | L | `steering` (preview, off) is registered here; it gates `maySteer` in the chat read model | none |
| 11 | `run-ui-parts` | feat(ui): shared run UI parts: state badge, pending strip, announcer, focus policy and toast host | A | #3191, #3196, #3197, #3782 | M | none | none |
| 12 | `steer-composer` | feat(chat): message while iHub is working: composer, chips and send afterwards | A | #3191 | L | `steering` (preview, off) | none |
| 13 | `agent-factory-removal` | feat!: remove the Agent Factory routes, pages and flag | B | #3773, #3782, #3784 | L | removes `agentFactory` from the registry (the stored key is removed by V261) | none |
| 14 | `tool-runner` | refactor(run): one tool runner for chat, app-as-tool, MCP and A2A tool calls | B | #3772 | M | none | none |
| 15 | `run-service-headless` | refactor(run): run service and headless host; app-as-tool, MCP and A2A run on it; app calls fail closed | B | #3772, #3780 | L | none | none |
| 16 | `chat-host-move` | refactor(run): move the body of the chat turn into ChatHost (move plus receiver rename) | B | #3772 | L | none | none |
| 17 | `chat-on-run-service` | refactor(run): chat, scheduled runs and /v1 run through the run service; architecture guard tests | B | #3772 | L | `platform.runs.chatOnRunService` (internal kill switch, default true, not in Admin, Features; removed one release later) | none |
| 18 | `run-envelope-taint-usage` | feat(run): origin envelope, taint bit and usage dimensions | B | #3785, #3781, #3772 | M | none | none |
| 19 | `run-limits` | feat(admin): one limits block platform.runs and a 60-minute ceiling for watched answers | B | #3781, #3777, #3783 | L | none | V260 `move_task_concurrency_to_platform_runs` |
| 20 | `erasure-coverage` | fix(privacy): user deletion covers every store filed under a user and retries failed steps | B | #3787, #3785 | M | none | none |
| 21 | `job-store` | feat(runs): sealed job store with a create-only claim per epoch and re-authorisation at claim | B | #3777, #3787 | L | none (dark: no caller yet) | none |
| 22 | `run-executor-scheduled` | feat(runs): run executor; scheduled runs execute as jobs | B | #3777, #3783, #3781 | L | none | none |
| 23 | `chat-jobs-route` | feat(runs): chat turns as jobs and POST /api/chats/{chatId}/messages | B | #3777, #2712 | L | `platform.runs.chatJobs` (false in this PR) | none |
| 24 | `chat-jobs-busy-client` | feat(chat): busy modes, run state in lists, and the web client on the messages route | B | #3777, #3191 | M | `platform.runs.chatJobs` (unchanged, false) | none |
| 25 | `durable-flush` | feat(runs): flush the ledger before a write and use one resume shape in the loop | B | #3777 | M | none | none |
| 26 | `resume-after-restart` | feat(runs): pick up and resume jobs after a restart | B | #3777, #3782 | L | applies to every job; chat turns are jobs only with `chatJobs` on | none |
| 27 | `unknown-outcome-run-again` | feat(runs): needs attention after a write with unknown outcome, and Run again | B | #3777, #3782, #3783 | M | none | none |
| 28 | `worker-takeover` | feat(runs): takeover across workers on one host with fencing | B | #3777, #3782 | L | none | none |
| 29 | `admin-runs-api` | feat(admin): admin runs API with audited stop, pause and drain | B | #3782, #3785 | M | none | none |
| 30 | `admin-runs-page` | feat(admin): Runs page | B | #3782 | L | none (admin page) | none |
| 31 | `activity-page` | feat(ui): Activity page with Needs you and Running | B | #3782 | M | `activity` (preview, off) | none |
| 32 | `chat-jobs-default-on` | feat(chat): answers continue after a server restart by default | B | #3777 | S | `platform.runs.chatJobs` default becomes true; an admin-set value is kept | none |
| 33 | `sub-agents-flag-hidden-chats` | feat(config): subAgents flag, delegation setting and hidden sub-agent chats | C | #3780, #3787, #3196 | M | adds `subAgents` (preview, off); removes `appAsTool` | V261 `sub_agents_flag` |
| 34 | `delegate-blocking` | feat(runs): delegate tool for blocking sub-agents without an app | C | #3196, #3781, #3785, #3787 | L | `subAgents`; offered only when the definition's `delegation` is not `off` | none |
| 35 | `app-as-sub-agent` | feat!: an app used as a tool runs as a sub-agent | C | #3196 | M | `subAgents` | none |
| 36 | `sub-agent-interactions` | feat(chat): sub-agent questions and approvals appear in the parent chat | C | #3196, #3785 | L | `subAgents` | none |
| 37 | `sub-agent-ui` | feat(chat): sub-agent rows, reports and Activity rows | C | #3196, #3782 | L | `subAgents` | none |
| 38 | `chat-event-queue` | feat(runs): per-chat event queue; queued messages survive a restart | D | #3197, #3191, #3787 | L | none (the first user is steering, behind `steering`) | none |
| 39 | `taint-gate` | feat(security): hold external writes in unattended runs that read untrusted content | D | #3785, #3782 | M | none; active for origins followup, child_report, handoff and webhook (scheduled runs attached to an agent join in PR `unattended-consent`) | none |
| 40 | `follow-ups-server` | feat(chat): follow-ups in the same chat and notify_user (server) | D | #3197, #3780, #3781, #3782 | L | adds `followUps` (preview, off); needs group permission `scheduledTasks`, now labelled 'Unattended work' | none |
| 41 | `follow-ups-ui` | feat(chat): follow-up chips, wake lines and toasts | D | #3197, #3782 | M | `followUps` | none |
| 42 | `background-sub-agents` | feat(runs): background sub-agents and wake of the parent chat | D | #3196, #3781, #3785, #3782 | L | `subAgents`, `platform.runs.subAgents.background` (false), permission `scheduledTasks` | none |
| 43 | `agent-permissions-flag` | feat(auth): permissions and feature flag for agents | E | #3780 | M | adds `agents` (preview, off) | V262 `agent_permissions` |
| 44 | `agent-definition-api` | feat(agents): agent definition, versions and API | E | #3773, #3787 | L | `agents`, permission `agents` | none |
| 45 | `agent-chats-assembly` | feat(agents): chats of an agent, per-wake assembly and their retention class | E | #3773, #3787 | L | `agents` | none |
| 46 | `agent-run-log-search` | feat(agents): end-of-run log and search over an agent's chats | E | #3773 | M | `agents` | none |
| 47 | `agent-chat-page` | feat(agents): chat page for a chat with an agent | E | #3773 | L | `agents`, permission `agents` | none |
| 48 | `agents-ui` | feat(agents): Agents pages | E | #3773 | L | `agents`, permission `agents` | none |
| 49 | `scheduled-api-rename` | feat!: scheduled work API moves to /api/schedules | E | #3783 | L | existing `scheduledTasks` flag and permission | none |
| 50 | `scheduled-ui-rename` | feat(ui): Scheduled: new name and routes | E | #3783, #3773 | M | existing `scheduledTasks` flag and permission | none |
| 51 | `agent-scheduled-link` | feat(agents): attach a scheduled run to an agent | E | #3783, #3773, #3787 | M | `agents` | none |
| 52 | `provided-agents` | feat(agents): provided agents that run as the user | E | #3773, #3780, #3787 | L | `agents`, permission `publishAgents` | none |
| 53 | `agent-own-identity` | feat(agents): own identity, quota and chat access for provided agents | E | #3773, #3780, #3781, #3787 | L | `agents`; the two fields need `adminAccess` | none |
| 54 | `unattended-consent` | feat(agents): consent to run without approval; attached scheduled runs hold external writes after reading outside content | E | #3785, #3773, #3783 | M | `agents` (the consent and the gate for attached scheduled runs) | none |
| 55 | `agent-handoff` | feat(agents): hand a chat over to an agent | E | #3773, #3785, #3787 | L | `agents` | none |
| 56 | `agent-webhook-triggers` | feat(agents): webhook triggers for provided agents with their own identity | E | #3773, #3785, #3787, #3780 | M | `agents`; needs `adminAccess` | none |
| 57 | `workflow-engine-dispatch` | feat(workflows): engine dispatch by schema version and the feasibility check | F | #3788, #3784 | M | existing `workflows` (preview, off) | none |
| 58 | `workflow-step-schema` | feat(workflows): schemaVersion 2 with exactly ten step kinds | F | #3774, #3784 | M | `workflows` | none |
| 59 | `workflow-engine-loop` | feat(workflows): definition per run and the new engine loop | F | #3788 | L | `workflows` | none |
| 60 | `workflow-ready-set-durable-steps` | feat(workflows): derived step order and durable step start | F | #3788, #3777 | L | `workflows` | none |
| 61 | `workflow-steps-basic` | feat(workflows): steps Start, Find documents and Write result | F | #3774 | M | `workflows` | none |
| 62 | `workflow-step-action` | feat(workflows): Action step with integration actions and an admin-only free URL | F | #3774, #3785 | L | `workflows` | none |
| 63 | `workflow-steps-model` | feat(workflows): Extract and Agent step on the run service | F | #3774, #3772 | L | `workflows` | none |
| 64 | `workflow-for-each` | feat(workflows): For each with per-item state | F | #3788, #3774 | L | `workflows` | none |
| 65 | `law-consultation-rebuilt` | feat(workflows): law consultation rebuilt on the new steps | F | #3774, #3786 | M | `workflows` | V263 `add_rebuilt_law_consultation` |
| 66 | `workflow-check-branch-ask` | feat(workflows): Check, Branch, Ask a person and repeat mode | F | #3774, #3788 | L | `workflows` | none |
| 67 | `legacy-workflow-notice` | feat(workflows): legacy inventory, removal notice and marketplace version gate | F | #3784, #3782 | M | none (admin information) | none |
| 68 | `workflow-run-view` | feat(workflows): outline and run view for the new steps | F | #3774 | L | `workflows` | none |
| 69 | `workflow-step-editor` | feat(workflows): editor for the ten steps | F | #3774, #3784 | L | `workflows` | none |
| 70 | `rebuilt-corpus-analysis` | feat(workflows): corpus analysis rebuilt on the new steps | F | #3774 | M | `workflows` | V264 `add_rebuilt_corpus_analysis` |
| 71 | `rebuilt-iterative-research` | feat(workflows): iterative research with review rebuilt on the new steps | F | #3774 | M | `workflows` | V265 `add_rebuilt_iterative_research` |
| 72 | `default-workflows-disposition` | feat(workflows): approval example rebuilt; disposition of every other default and marketplace workflow | F | #3774, #3784 | M | `workflows` | V266 `add_rebuilt_approval_example` |
| 73 | `agent-fixed-mode` | feat(agents): fixed mode and finishing rules | G | #3775, #3788 | L | `agents`, `workflows` | none |
| 74 | `plan-revisions-amend` | feat(workflows): plan revisions and amend | G | #3788, #3787 | L | none (no surface yet) | none |
| 75 | `planned-mode` | feat(agents): planned mode with plan tools and plan approval | G | #3775, #3788 | L | adds `agentPlannedMode` (preview, off) | none |
| 76 | `plan-loops-approval` | feat(agents): loops and branches in model-written plans with one approval per loop | G | #3788, #3785, #3775 | L | `agentPlannedMode` | none |
| 77 | `plan-view` | feat(chat): plan card, plan pane and revision history | G | #3775 | L | `agentPlannedMode` | none |
| 78 | `planned-default-agent` | feat(agents): default planned agent, legacy-reach guard and release protocol | G | #3775, #3788, #3784 | M | `agentPlannedMode` | V267 `add_default_planned_agent` |

## 4. Pull requests

### Slice A: test tooling and goldens first; correct a running answer; faster tool rounds

#### PR 1: `e2e-stub-and-gate`

**test(e2e): scripted model stub, agents e2e suite and pull request gate**

Issues: #3786. Size: M. Stacks on: main.

- **Scope.** Extend `tests/config/e2e-llm-stub.mjs` with marker scripts matched on the last user message: `e2e-slow:<ms>:<n>`, `e2e-hang:<key>` (released by `POST /__release/<key>`, auto-release after 120 s), `e2e-tool:<name>:<json-args>`, `e2e-tools-parallel:<a>,<b>`, `e2e-script:<name>` (named multi-turn scripts in new `tests/config/e2e-scripts.mjs`; the turn is chosen by the number of assistant messages in the request, never by a call counter). Add `GET /__requests?marker=` and `GET /__stats` (aborted upstream calls). Default replies stay byte-identical. Add a second stub model `e2e-stub-tools` (`supportsTools: 'auto'`) in `tests/config/e2e-contents.mjs`; the default model keeps `'none'`. New `tests/config/playwright.agents.config.js` (Chromium only, workers 1, retries 0, own ports, contents dir `contents-e2e-agents`, honours `PW_CHROMIUM_PATH`) with `tests/config/agents-server.mjs` (seeds users `e2e-user` and `e2e-other`, can restart the server on the same contents). Specs live in `tests/e2e-agents/`. Script `test:e2e:agents`. `PW_CHROMIUM_PATH` support in `tests/config/playwright.config.js`. New `.github/workflows/e2e.yml`: on pull_request, Node 24, agents suite plus `tests/e2e/chat.spec.js` on Chromium, 10-minute budget. A grep test forbids `page.route` fulfilment of `/api` in `tests/e2e-agents`. Specs carry the tags `@gate`, `@matrix` or `@slow`: the pull request job runs `@gate` plus the specs mapped to the changed paths (`tests/config/agents-spec-map.json`); the full suite and the transport matrix are a separate job (`workflow_dispatch` and `workflow_call`) that is started by hand and before each slice merge; nothing runs it on a schedule until PR `fault-harness-nightly` adds the nightly workflow. Platform config is not reloaded at runtime, so `agents-server.mjs` takes a `platform` overlay and `@matrix` specs are grouped by overlay (one server start per overlay). This plan is added as `concepts/2026-11-19 Agents Epic Implementation Plan.md`.
- **Out of scope.** scriptedModel, golden harness and fault harness (later PRs); any production code.
- **Files.** tests/config/e2e-llm-stub.mjs, e2e-scripts.mjs, e2e-contents.mjs, playwright.agents.config.js, agents-server.mjs, playwright.config.js; tests/e2e-agents/smoke.spec.js; server/tests/e2e-llm-stub.test.js; package.json; .github/workflows/e2e.yml ; tests/config/agents-spec-map.json; concepts/2026-11-19 Agents Epic Implementation Plan.md
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** none (test tooling only)
- **Acceptance.**
  - `tests/e2e/chat.spec.js` and the injection suite pass unchanged.
  - `smoke.spec.js`: login as admin, a slow stream renders progressively, a tool row renders with `e2e-tool`.
  - The stub self-test covers slow, hang and release, script selection by assistant count, and the fallback for an unknown marker.
  - `e2e.yml` runs on this pull request and is green in under 10 minutes.
  - The gate job runs only `@gate` specs and the specs mapped to changed paths; the full suite is a separate job, started by hand and before a slice merge, and called by the nightly from PR 5 on.
- **Tests.** server/tests/e2e-llm-stub.test.js (node:test, injected timer); tests/e2e-agents/smoke.spec.js; grep test for API mocks.
- **Docs and release entry.** docs/developer-onboarding.md: section on the agents e2e suite with the local commands (Node 24, `PW_CHROMIUM_PATH`). Release entry: none (test only). The plan file under `concepts/`.
- **End-to-end check.** `export PATH=/opt/node24/bin:$PATH; PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e:agents` is green; a curl chat turn with the message `e2e-slow:200:5` shows five deltas.
- **Risk.** A stub change breaks existing specs. Guard: the default path is byte-identical and asserted.

#### PR 2: `glossary-wording-lint`

**docs: glossary, retired-words lint and a when-to-use-which section**

Issues: #3771. Size: S. Stacks on: PR 1.

- **Scope.** New `docs/glossary.md` (audience admin, type reference, listed in `docs/SUMMARY.md` after Core Concepts). Table 1 holds only terms that ship today (chat, run, app, workflow, scheduled task) with EN and DE; later PRs add their rows. Table 2 lists the words iHub does not use (thread, steer, helper, sub-task, job, lease, worker, automation, workflow instance, Geplanter Agent, ...) and is complete from the start. New `shared/i18n/retired-words.json` (`word, lang, use, scopes, allowKeys`) and `tests/unit/client/retired-words.test.jsx`: checks every leaf value of `shared/i18n/en.json` and `de.json`, `name` and `description` in `server/featureRegistry.js`, and docs prose for words with scope `docs` (not `docs/releases/**`, not the glossary); word-boundary matching; a baseline file that may only shrink; an assertion that the JSON and glossary table 2 are identical. `docs/concepts.md`: section 'App, workflow or scheduled task: when to use which' with shipped rows only. Extend `tests/unit/server/docsContent.test.js`: a page's `adminPage` must match an admin route in `client/src/App.jsx`. New `tests/unit/client/clean-pages-routes.test.jsx`: every `CLEAN_PAGES` path in `tests/e2e/accessibility.spec.js` matches a route in `App.jsx`.
- **Out of scope.** Terms of features that have not shipped; model-facing tool descriptions (reviewed in the PR that adds each tool).
- **Files.** docs/glossary.md, docs/SUMMARY.md, docs/concepts.md; shared/i18n/retired-words.json; tests/unit/client/retired-words.test.jsx, retired-words-baseline.json, clean-pages-routes.test.jsx; tests/unit/server/docsContent.test.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** none
- **Acceptance.**
  - A new UI string that contains 'thread', 'job', 'lease', 'steer' or 'helper' fails the lint; 'job title' style hits can be allow-listed by key.
  - The baseline lists today's hits (for example `abortCauses.lease_lost`) and the test fails when the baseline grows.
  - The glossary describes no feature an admin cannot find in the product.
  - A docs page whose `adminPage` names a missing route fails the docs test.
- **Tests.** retired-words.test.jsx, clean-pages-routes.test.jsx, docsContent.test.js.
- **Docs and release entry.** This PR is documentation. Release entry: none.
- **End-to-end check.** `npx jest --config tests/config/jest.config.js tests/unit/client/retired-words.test.jsx tests/unit/server/docsContent.test.js`; start the stack, sign in as admin, open Admin, Documentation, Glossary: the page renders.
- **Risk.** The lint is noisy and gets deleted. Guard: word boundaries, per-word allow-list, shrink-only baseline.

#### PR 3: `test-foundations`

**test: quarantine clean-up, runner tiers, scripted model, fake clock and golden harness**

Issues: #3786. Size: L. Stacks on: PR 2.

- **Scope.** `scripts/run-server-tests.js`: take `appToolsGateway.test.js` (add `disablesModelInvocation` to its skillLoader mock), `mcpToolUserContext.test.js` (passes today) and `CorpusSearchNodeExecutor.pagination.test.js` (import `executors/index.js` first in the test; frozen code untouched) out of `QUARANTINED`; add `--check-quarantine` (fails when a quarantined file passes); add a tier rule (`server/tests/faults/**` and `*.nightly.test.js` run only with `--tier=nightly`), the script `test:faults`, and a jest worker memory limit. `appToolsGateway.test.js` gains the app-as-tool characterization: 3-minute clock with fake timers, depth 1, approval denied, question refused, result shape, `kind: 'subagent'` ledger link, usage attribution, and the fail-open pinned as current behaviour. `server/tests/helpers/scriptedModel.js`, extracted from `scheduledTaskHarness.scriptedChatService` (`turn.text`, `turn.toolCalls`, `turn.error`, `turn.hang`, `turn.slow`, `turn.when`; `assertDone()`; an extra call throws). `server/tests/helpers/fakeClock.js`. `server/tests/golden/`: `harness.js`, `normalise.js`, `assertGolden.js` (plain JSON files, not jest snapshots), `differenceList.test.js`, `determinism.test.js`, `sideBySide.mjs`. Record: envelopes, offered tool ids, model requests as a normalised projection that is asserted (role sequence, hash of the system prompt after the date rule, tool names and parameter schemas, model options), with the full bodies reported beside it, tool calls, approvals, ledger, stored message, evidence, usage records, HTTP response. Each normalisation rule has a unit test (ids by first appearance, timestamps, durations, merged `step/delta`, order inside a `parallelGroup`, the date sentence of the system prompt). A grep test forbids sleeps and literal timers of 1 s or more in the new test directories. `differenceList.test.js` wants a row for every changed golden, the request projection included. New `.github/CODEOWNERS` names the product owner for `server/tests/golden/differences.json`; `scripts/check-difference-signatures.js`, run in `e2e.yml`, fails when a row's `signedBy` was added or changed in a pull request that the named owner has not approved.
- **Out of scope.** The goldens themselves (next PR); the fault harness; `planner-maxtokens` and `WebhookTrigger` tests, which stay quarantined with an issue number.
- **Files.** scripts/run-server-tests.js; server/tests/appToolsGateway.test.js; server/tests/helpers/scriptedModel.js, fakeClock.js, scheduledTaskHarness.js; server/tests/golden/**; package.json; docs/run-testing.md ; .github/CODEOWNERS; scripts/check-difference-signatures.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** none (no production code)
- **Acceptance.**
  - The three tests run in `test:quick`; `--list` shows the tiers.
  - `scriptedModel` fails a test when the model is called more often than scripted.
  - The determinism test records each case twice in one process and once in a second process, byte-equal, 20 local runs in a row.
  - No production path is in the diff.
  - A change in prompt order or in an offered tool schema fails the golden until a row names it.
  - A `signedBy` added in a pull request without the owner's approval fails the signature check (shown on a scratch branch).
- **Tests.** Self-tests of scriptedModel, fakeClock, normaliser, determinism; the 17 scheduled-task test files stay green on the thin wrapper.
- **Docs and release entry.** New docs/run-testing.md (developer, reference, in SUMMARY); docs/developer-onboarding.md CI tiers. Release entry: none.
- **End-to-end check.** `node scripts/run-server-tests.js golden`, `node scripts/run-server-tests.js --check-quarantine`, then `npm run test:quick` compared with the recorded baseline.
- **Risk.** Goldens flake on timing. Guard: normaliser rules with tests and the determinism test.

#### PR 4: `goldens-difference-list`

**test: characterization goldens for seven surfaces and the legacy workflow path, and the difference list**

Issues: #3772, #3786, #3784, #3788. Size: L. Stacks on: PR 3.

- **Scope.** Goldens in `server/tests/golden/__goldens__/<surface>/<case>.json`, recorded on main (dd586bb plus the test-only pull requests before this one), before any production change of this stack: chat (plain, one tool, two tools, approval approve, approval deny, approval pause and continue, connect resume, question pause and resume, structured output, compaction, model error, user stop, temporary chat, superseded turn), scheduled task (plain, tool, notes injection, memory composer, approval denied headless), `/v1/chat/completions` (stream, non-stream, tool, OpenAI error body, disconnect), the inference app turn including `/v1/responses`, app-as-tool (ok, 3-minute clock, depth 1, approval denied, question refused, user without permissions), MCP `tools/call` (ok, file lift, error mapping) and A2A, the last two through the real loop instead of the `invokeAppInternal` mocks. The chat cases are recorded through the HTTP route for both `chatPostStream` positions (request, status, body or stream), so they pin the 850-line handler that PR 9 restructures. No golden for an `app__` call from a legacy prompt node: that path needs an Agent Factory principal and becomes unreachable in PR 13. Legacy workflow path: `server/tests/workflow-legacy-frozen.test.js` holds a sha256 of every frozen file (`WorkflowEngine.js`, `DAGScheduler.js`, `StateManager.js`, `checkpointResume.js`, `executors/**`, `tools/agentTools.js`, `server/agents/{memory,inbox,runtime}`, `validators/agentProfileSchema.js`, `agentInboxSchema.js`). `server/tests/golden/surfaces/legacyWorkflow.js` records `stellungnahmen-review-v2` and `stellungnahmen-review-ifinder-v2` on a scripted model with synthetic statements from `tests/fixtures/stellungnahmen/` (PDF, DOCX, one scan, one very long, one empty, one with umlauts and tables) and a recorded iFinder result set, one legacy run paused on a question and resumed, one resumed after a restart with delivery into the chat (`deliverResumedWorkflows`), and one started by a trigger. These pin the steps and output of the legacy path as it is; they compare nothing with a rebuild and need no set of real documents. `server/tests/golden/differences.json` with rows in state `proposed`, each with a default disposition: fail-open removal, admin rights stripped in unattended runs of an admin, tool-result truncation, headless approval policy, tool error text, compaction trigger, maximum rounds, abort cause, usage origin and agent id, evidence actor, additive `run/started` fields, display fields on app-as-tool events. A CI check fails the PR when the diff has a path outside `server/tests`, `tests`, `docs`, `scripts`, `.github`. The product owner's approval of this PR signs the rows; `signedBy` and `signedOn` are set before PR `tool-runner` merges.
- **Out of scope.** A comparison of the legacy law consultation with its rebuild (PR 65); goldens for single legacy node executors.
- **Files.** server/tests/golden/surfaces/*.js, __goldens__/**, differences.json ; server/tests/golden/surfaces/legacyWorkflow.js; server/tests/workflow-legacy-frozen.test.js; tests/fixtures/stellungnahmen/**
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** none (no production code)
- **Acceptance.**
  - The goldens are green on main and identical on two runs for each of the seven surfaces and for the legacy workflow cases.
  - A changed golden without a row in `differences.json` that names it and the PR fails `differenceList.test.js`.
  - The diff contains no production path.
  - The rows are signed before the first refactor PR merges.
  - Both legacy law consultation variants, the paused and resumed run, the run resumed after a restart and the trigger-started run are recorded.
  - The frozen-files test is green and fails when one byte of a frozen file changes (shown in the PR).
- **Tests.** The goldens and their determinism run.
- **Docs and release entry.** docs/run-testing.md: the difference list and how a row is signed. Release entry: none.
- **End-to-end check.** `node scripts/run-server-tests.js golden`; curl `/v1/chat/completions` on the stack returns the stub answer, and a bad model id returns the OpenAI error body.
- **Risk.** Goldens are recorded after a refactor or refreshed inside one. Guard: this PR sits before every production change of the stack; the no-production-diff check; the row rule.

#### PR 5: `fault-harness-nightly`

**test: fault harness with kill points, counter tool and a nightly workflow**

Issues: #3786. Size: L. Stacks on: PR 4.

- **Scope.** `server/utils/killPoint.js` `killPoint(name)`: armed only when `NODE_ENV === 'test'` and `IHUB_TEST_KILLPOINT` is set, evaluated once at import; it appends the name to `IHUB_TEST_KILLPOINT_FILE` before SIGKILL and supports `name@n`. An inventory test compares the call sites with `server/tests/faults/KILLPOINTS.md`; a build check allows the variable name only in `killPoint.js`. `server/tests/faults/harness.mjs`: `startStack({ workers: 1 | 2, contents, stub })` spawns `node server/server.js` with `NODE_ENV=test`; the stub and the side-effect counter live in the harness process; `stack.kill`, `restart`, `waitKilledAt`, `api`, `readChat`, `readLedger`, `evidence`. Test-only tools `e2e_counter_write` (not read-only, posts to the harness counter through `httpFetch`) and `e2e_counter_read`, registered only with `NODE_ENV=test` and `IHUB_TEST_TOOLS=1`; a boot warning line when armed. Files are `*.fault.test.js` (nightly tier, 90 s each, no sleeps). The 'protection off' self-test runs on a fixture server inside the harness, so production code gets no disable switch. `.github/workflows/nightly.yml` (cron `17 2 * * *`, `workflow_dispatch`, and `pull_request` with the label `run-faults`, so the fault tier can run on a branch of the stack that is not on main yet): `test:faults`, `--check-quarantine`, Playwright on three browsers, the `full` job of `e2e.yml` (the agents suite and the transport matrix, called through `workflow_call`; started by hand until now), a load smoke on the stub; a failure opens or updates a `nightly-red` issue. `tests/load/stub/server.mjs` can emit tool calls; new `tests/load/scenarios/agentTurn.mjs` (profile `agentic`). `e2e.yml` gets the job `faults-smoke`, which runs the cases tagged `smoke` (none yet; 'write in flight' and 'mid model stream' from PR 25 on). `tests/config/agents-server.mjs` now starts the server with `NODE_ENV=test` and `IHUB_TEST_TOOLS=1` (never `IHUB_TEST_KILLPOINT`; the server has no other switch on `NODE_ENV=test`), hosts the counter endpoint and exposes `GET /__counter` and `POST /__counter/reset`; `e2e_counter_read` is declared `untrustedInput: true` and is the offline 'outside content' tool of every browser check (`read_url` against localhost is stopped by the SSRF guard). The first five pull requests of the stack are test tooling: each is merged to main when it is approved, so the scheduled nightly runs from the default branch from then on.
- **Out of scope.** The fault cases of each feature (they ship with the feature); `POST /__seed-job` (PR 21, which adds the store).
- **Files.** server/utils/killPoint.js; server/tests/faults/harness.mjs, KILLPOINTS.md, *.fault.test.js; test-only tool registration; .github/workflows/nightly.yml; tests/load/** ; tests/config/agents-server.mjs; .github/workflows/e2e.yml
- **Flags.** none (env `IHUB_TEST_KILLPOINT`, `IHUB_TEST_TOOLS`, only under `NODE_ENV=test`)
- **Migrations.** none
- **Behaviour change.** none; one inert hook module in production code
- **Acceptance.**
  - The module is inert under `NODE_ENV=production` even with the variable set.
  - `npm run test:faults` is green five times in a row locally; the fault tier ran once from this pull request through the label `run-faults` and is green; after the merge to main one scheduled run is green.
  - The self-test shows a counter of 2 with protection off, proving that the harness can see a double write.
  - An undocumented kill point fails the inventory test.
  - The agents e2e stack runs under `NODE_ENV=test` with the test tools and without kill points; `smoke.spec.js` and `tests/e2e/chat.spec.js` stay green under it.
  - `GET /__counter` on the agents helper reports a write of `e2e_counter_write` made from a browser spec.
- **Tests.** server/tests/killPoint.test.js, killPoint-inventory.test.js, harness self-tests.
- **Docs and release entry.** docs/run-testing.md: fault tier and kill points. Release entry: none. docs/developer-onboarding.md: who acts on a red nightly (the `nightly-red` issue goes to the person the product owner names, until then to the author of the last merged pull request of the stack).
- **End-to-end check.** `npm run test:faults` (starts its own servers; do not run it together with the e2e stack or `test:quick`).
- **Risk.** The nightly goes red and is ignored. Guard: reached-file instead of log scraping, no sleeps, auto-issue, release-candidate gate.

#### PR 6: `long-turn-proof`

**fix(chat): prove and harden turns that outlast the POST timeout**

Issues: #2712, #3786. Size: S. Stacks on: PR 5.

- **Scope.** The visible bug of #2712 was fixed in v5.7.1: `sendPendingMessage` (`client/src/features/chat/hooks/useAppChat.js:529-541`) keeps listening when the POST reply is lost. This PR proves it and hardens the client; the issue stays open until PR 23 answers the POST early. Proof: `tests/e2e-agents/long-turn.spec.js` sends `e2e-hang:k1`, shortens the client timeout through a dev-only override (`window.__ihubStreamTimeoutMs`, read in `client/src/api/endpoints/apps.js` only when `import.meta.env.DEV`), waits past it, releases, and asserts: the answer completes, no 'Request timed out' text, no `POST .../stop` was sent, the stub's aborted count is 0. It runs for `chatPostStream` off and on (on: `e2e-slow` past the idle watchdog interval). Hardening: when the `/status` check itself fails, retry three times (1 s, 2 s, 4 s) before `handleSendError`; move the hard-coded English timeout text in `client/src/api/utils/apiErrors.js:38` into `shared/i18n` (en, de). No server change: the POST answers early only with the job route in PR `chat-jobs-route`; the 60-minute ceiling comes with PR `run-limits`.
- **Out of scope.** Answering the JSON POST early; switching `chatPostStream` on by default; the ceiling.
- **Files.** client/src/features/chat/hooks/useAppChat.js; client/src/api/endpoints/apps.js; client/src/api/utils/apiErrors.js; shared/i18n/en.json, de.json; tests/e2e-agents/long-turn.spec.js; tests/unit/client/chat-post-timeout.test.jsx
- **Flags.** none (tested with `chatPostStream` off and on)
- **Migrations.** none
- **Behaviour change.** A lost status check is retried before an error is shown.
- **Acceptance.**
  - The spec fails when the lost-reply branch of v5.7.1 is removed (shown in the PR body) and passes on the branch, for both transports.
  - A lost reply never stops the turn on the server.
  - A failed status check is retried; a request that really failed still shows the error, in en and de.
- **Tests.** tests/unit/client/chat-post-timeout.test.jsx (fake timers); chat-post-stream.test.jsx extended; long-turn.spec.js. No test waits five real minutes.
- **Docs and release entry.** docs/troubleshooting.md and docs/chat-persistence.md: short notes. Release entry: `fixes.md` only for the retry ('A long answer also survives a failed status check'); it does not repeat the v5.7.1 entry.
- **End-to-end check.** `npm run test:e2e:agents -- long-turn.spec.js` on Chromium, both flag positions.
- **Risk.** An agent follows the stale issue text and changes the POST contract. Guard: the ticket is updated first; this PR has no server diff.

#### PR 7: `run-access-intents`

**feat(runs): run and interaction access by intent; only the owner steers a run or answers its approvals**

Issues: #3785, #3191. Size: M. Stacks on: PR 6.

- **Scope.** `server/services/loop/runAccess.js`: `authorizeRun(runId, user, { intent })` with a mandatory intent `read | stop | steer | feedback | answer | rerun`; a call without an intent throws. `steer` and `rerun`: the caller must be the run's principal, resolved through `refs.chatId` and `authorizeChat(..., { intent: 'write' })`; the admin bypass is off. `read` stays as today. `stop`: owner; an admin keeps stop on this route until PR `admin-runs-api` adds the audited admin route, and every admin stop is written to the audit log from now on. Anonymous runs: `steer` and `stop` need the guest cookie whose `guestOwnerId` equals the chat's `ownerId`. `server/routes/runs.js` human-events switches on `kind`; a steer is refused with `RUN_NOT_ACTIVE` while the run is paused on an approval; a per-user rate limit (30 per minute, `createRateLimiter`) answers 429. New code `RUN_STEER_FORBIDDEN` (403) in `shared/apiErrors.js` with en and de text. `authorizeInteraction(interaction, user, { intent })` gets a mandatory intent `read | answer | cancel` in the same PR: `answer` is for the owner of the run only (an admin no longer answers an owner-bound approval or question and may cancel it); for an anonymous run `answer` needs the guest cookie whose `guestOwnerId` equals the chat's `ownerId` (today `source.anonymous === true` lets every caller through, `runAccess.js:219`). Route inventory `server/tests/routeInventory.test.js`: it enumerates the Express router (every route under `/api/runs`, `/api/chats`, the interaction routes and `/api/apps/:appId/chat`); each route needs a row in `server/tests/routeInventory.table.js` (intent and expected status for owner, other user, admin, guest with cookie, holder of the id only), and a route without a row fails the test, so every later PR that adds a run or chat route adds its row.
- **Out of scope.** Steer id, cancel and events (PR `steer-contract`); the audited admin cancel route (PR `admin-runs-api`).
- **Files.** server/services/loop/runAccess.js; server/routes/runs.js; shared/apiErrors.js; shared/i18n/en.json, de.json; server/tests/runAccessIntent.test.js, steerApproval.test.js ; the interaction routes; server/tests/routeInventory.test.js, routeInventory.table.js
- **Flags.** none (security rule, not behind a flag)
- **Migrations.** none
- **Behaviour change.** Admins can no longer steer another user's run. A holder of an anonymous run id without the session cookie can no longer steer or stop it. An admin can no longer answer another user's approval or question (cancel stays). An anonymous interaction is answered only with the matching session cookie.
- **Acceptance.**
  - Matrix test: {owner, other user, admin, anonymous with cookie, anonymous without cookie, holder of the id only} x {read, stop, steer, feedback} gives the documented status.
  - A steer with the text 'I approve' while the run waits for an approval leaves the approval pending.
  - The 31st steer in a minute answers 429 as problem+json.
  - An admin stop is in the audit log.
  - An admin who answers another user's approval gets 403 and can cancel it; an anonymous interaction is answered only with the matching guest cookie.
  - A scratch route added under `/api/runs` without a table row fails the inventory test (shown in the PR).
- **Tests.** runAccessIntent.test.js, steerApproval.test.js, route test for human-events.
- **Docs and release entry.** docs/run-ledger.md 'Human events' (owner only), docs/error-responses.md. Release entry: `breaking-changes.md` 'Only the Chat Owner Can Send a Message to a Running Answer or Answer Its Approvals'.
- **End-to-end check.** Start a turn with `e2e-hang:a1` as `e2e-user`; `POST /api/runs/{runId}/human-events` with `kind: 'steer'` as admin answers 403 `RUN_STEER_FORBIDDEN`, as `e2e-user` 200; release the hang. An admin answer to `e2e-user`'s pending approval answers 403.
- **Risk.** A later route reuses the old check. Guard: no default intent; the route inventory of this PR fails for a route without a row.

#### PR 8: `tool-side-effects-parallel-calls`

**feat(chat): declared tool side effects and parallel read-only tool calls**

Issues: #2485, #3785. Size: L. Stacks on: PR 7. Closes: #2485.

- **Scope.** Classification: in `server/utils/toolApproval.js` add `isTrustedReadOnly(toolDef, installation)` (true only when `sideEffect` is `read`, the source is `admin`, `definition` or `tool`, and the tool declares it; an MCP annotation and the internal-tool default never count) and `resolveUntrustedInput(toolDef)` (true for `dataFlow: 'external'`, web and document search, file and page reads, every remote MCP tool; an admin can add the flag, not remove it). Declare `sideEffect` in all 23 files of `server/defaults/tools/` (one declares it today; `chat_artifacts`, `chat_files` and `chat_sources` carry `readOnly: true`, which the declaration replaces) and on every internal tool. No migration: #2485 assumed that installations hold tool files in `contents/tools/`, but that directory is no longer read. The shipped definitions are read in place (`services/tools/shippedToolDefinitions.js`; V199 and V202 removed the copies), web search is an installed integration since V195, and V211 turned every admin-created tool file into a custom integration whose actions carry `sideEffect`. An action without a declaration resolves to `unknown` and is never batched; an admin declares it on the action in Admin, Integrations. #2485 asks for a stored flag `readOnly: true`; no second flag is stored: the planner's `readOnly` (`segmentPlanner.js:73`) is filled from `isTrustedReadOnly` where the tool list is built. `services/integrations/integrationTools.js:125` sets `readOnly` from the bare side effect today, so an MCP annotation counts; that line switches to the helper. The value survives the building of the tool list (`services/tools/appTools.js`, the web search resolver, localisation). Parallel calls: `server/services/loop/segmentPlanner.js` gets `parallelMode: 'readOnly'`, which batches only calls whose tools are all trusted read-only, at most 4 per batch; one write in the round forces serial order. `ChatService.js:1070` and `:2042` pass it when the feature is on and the model does not opt out (new optional model schema field). Results are appended in call order. Client: `shared/run/runReducer.js` orders rows of one `parallelGroup` by start; the announcer coalesces ('3 searches running'). `maxParallel` stays 4. The per-tool throttle of `server/requestThrottler.js` (for example `braveSearch` with `concurrency: 1`) still applies inside a batch. Interactive and passthrough tools stay alone in their batch.
- **Out of scope.** The taint bit (PR `run-envelope-taint-usage`); parallel calls for writes with disjoint targets, which the planner supports and chat must not use.
- **Files.** server/utils/toolApproval.js; server/defaults/tools/*.json; server/services/tools/appTools.js; server/services/loop/segmentPlanner.js; server/services/chat/ChatService.js; server/featureRegistry.js; model schema; shared/run/runReducer.js; server/services/integrations/integrationTools.js
- **Flags.** `parallelToolCalls` (preview, off); model field `parallelToolCalls: false` as opt-out
- **Migrations.** none
- **Behaviour change.** With the flag on, read-only tool calls of one round run side by side.
- **Acceptance.**
  - Flag off: model request bodies and event order are identical to today (asserted on the stub's `/__requests`).
  - Flag on: two read-only calls overlap (latch test); a write, an MCP tool that is 'read' only by annotation, or a tool without a declaration is never run in parallel.
  - The classification test fails for any shipped or internal tool without a declared `sideEffect`.
  - Abort cancels both calls; a model with `parallelToolCalls: false` gets serial calls.
  - Three search calls in one model response run in one batch; the wall time is about the longest call, not the sum, subject to the tool throttle (latch test).
  - Planner unit tests for the new mode: all read-only gives one batch; a mix isolates each changing call in order; interactive and passthrough calls stay alone; `maxParallel` is respected.
  - The rows of a parallel batch show in call order live and after a reload of the stored run.
  - An action of a custom integration without a declared side effect, and an MCP tool that is read-only by annotation only, are never batched; the same action with `sideEffect: read` set by an admin is. No file under `contents/` is written by this pull request.
- **Tests.** server/tests/toolClassification.test.js; server/tests/loop/segmentPlanner.readOnly.test.js; latch test in the agent loop tests; integration action test (declared read, undeclared, read by MCP annotation only, admin override); client reducer test; tests/e2e-agents/parallel-tools.spec.js.
- **Docs and release entry.** docs/tool-calling.md, docs/agent-loop.md, docs/tool-approval.md (declared side effect), docs/models.md (opt-out). Release entry: `features.md` 'Read-Only Tool Calls Run Side by Side (Preview)'. docs/tool-calling.md and docs/integrations.md document `sideEffect` and what makes a tool or an integration action read-only.
- **End-to-end check.** With the flag on, a message `e2e-tools-parallel:<a>,<b>` (two shipped read-only tools on the `e2e-stub-tools` model) shows two rows running at once, then both done; with the flag off the rows run one after the other.
- **Risk.** A mislabelled write runs in parallel. Guard: fail-closed helper plus the classification test.

#### PR 9: `chat-turn-start`

**refactor(chat): move the start of a chat turn out of the route**

Issues: #3191, #3777, #3197. Size: L. Stacks on: PR 8.

- **Scope.** Today a turn is assembled inside the route: `processChatRequest` is a closure at `server/routes/chat/sessionRoutes.js:804`, called from an 850-line handler (`:988-1840`) that reads request-only inputs. Leftover steers, job recipes and wakes all need to start a turn without an HTTP request. New `server/services/chat/chatTurnStart.js`: `prepareTurn(turnRequest)` returns a `PreparedTurn` or a refusal (everything up to the commit point), `runPreparedTurn(prepared, { sink })` runs it. `TurnRequest` is plain data: `{ chatId, appId, principalRef, messageId, message, files[], modelId, style, outputFormat, integrationScopes, clientTimezone, toolApprovalCapable, language, origin }`. The route keeps HTTP parsing, Accept negotiation and the POST stream handle and calls the two functions. No behaviour change and no change to the signature of `ChatService.runTurn`. This is a restructuring, not a move: request-coupled closure code becomes functions over plain data. Its guard is the chat goldens recorded through the HTTP route in PR 4.
- **Out of scope.** Any new caller of `runPreparedTurn`; the run service.
- **Files.** server/services/chat/chatTurnStart.js (new); server/routes/chat/sessionRoutes.js; server/tests/chatTurnStart.test.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** none (goldens byte-equal)
- **Acceptance.**
  - Every chat golden recorded through the HTTP route is byte-equal for both `chatPostStream` positions (plain, tool, approval pause and continue, connect resume, superseded turn); no row is added to `differences.json`.
  - `chat-post-stream.test.js`, `chatTurn.test.js` and `chat-persistence-protocol.test.js` pass unchanged; `npm run check:response-shapes` passes.
  - A unit test starts a turn from a `TurnRequest` with an upload and an integration scope, without an Express request.
- **Tests.** server/tests/chatTurnStart.test.js; existing chat tests.
- **Docs and release entry.** docs/architecture.md: one paragraph. Release entry: none (refactor).
- **End-to-end check.** `npm run test:e2e:agents` and `tests/e2e/chat.spec.js` on Chromium, for `chatPostStream` off and on.
- **Risk.** An input that only the request carried is lost. Guard: `TurnRequest` lists every input; the unit test covers files and scopes.

#### PR 10: `steer-contract`

**feat(runs): steering contract: id, cancel, events, pending list, leftover and send afterwards**

Issues: #3191. Size: L. Stacks on: PR 9.

- **Scope.** `server/services/loop/steering.js`: the id is minted in the route and carried in the relayed bus message; `cancelSteer(runId, id)` is answered through `clusterBus.request`; `pendingSteers(runId)`. Origin is metadata (`_origin: 'person'`) and real steers get their own field `_steerId` (not `_steer`, which `questionPause.js:198` reuses for workflow answers). The literal `[steer]` marker is neutralised in tool results, reports and file text. `AgentLoop.js:581` emits `steer/applied { id, step }`; further frames `steer/queued` and `steer/dropped { id, reason }` (lifetime expired, restart, run ended in a temporary chat). `server/routes/runs.js`: the POST returns `{ id, effect }` and accepts `mode: 'afterwards'`; new `DELETE /api/runs/{runId}/human-events/{id}` answers 204 or 409 `STEER_ALREADY_APPLIED`. Stored form: a user message inside the turn with `steer: true, runId, appliedAtStep`, plus a server-sent activity item (`activityKind: 'user_message'`, step index) from `server/utils/toolDisplay.js`. The chat read model gains `pending[] { id, kind: 'steer' | 'send_after', text, labelKey, actions[] }` and `maySteer`. Leftover: when the run ends with a queued steer or a send-afterwards message, the server consumes it under the chat lock against `activeRunId` and starts the next turn through `runPreparedTurn`; in a temporary or guest chat it is dropped with `steer/dropped` so the client can put the text back. The evidence record lists the steer with sender and step.
- **Out of scope.** The composer (PR `steer-composer`); persistence across a restart (PR `chat-event-queue`); steering a sub-agent.
- **Files.** server/services/loop/steering.js, AgentLoop.js; server/routes/runs.js; server/services/chat/chatTurnStart.js; chat read model in server/routes/chats.js; server/utils/toolDisplay.js; shared/apiErrors.js; server/featureRegistry.js
- **Flags.** `steering` (preview, off) is registered here; it gates `maySteer` in the chat read model
- **Migrations.** none
- **Behaviour change.** Additive API. A queued message that the run did not read becomes the next turn on the server.
- **Acceptance.**
  - A removed message is never applied; an applied one answers 409 `STEER_ALREADY_APPLIED`.
  - A steer sent just before the last model call is applied or becomes the next turn, exactly once, and the stream says which.
  - A re-attached client rebuilds its state from `pending[]` alone.
  - Tool output that contains the marker text produces no steer; a workflow question answer is not reported as a steer.
  - Cancel works when the request reaches a worker that does not run the turn (forked-worker test).
  - The steer is in the evidence record with sender and step.
  - Another user and an admin get 403 on `DELETE /api/runs/{runId}/human-events/{id}`; the route has its row in the route inventory.
- **Tests.** server/tests/loop/steering.test.js (race, cancel against apply, lifetime with injected `now`); steerCluster.test.js (forked workers, pattern of chatResumeCluster.test.js); stored-form and evidence tests; response-shapes contract.
- **Docs and release entry.** docs/agent-loop.md (steering), docs/run-ledger.md, docs/streaming-events.md, docs/chat-evidence.md; `@swagger` for the DELETE. Release entry: none, because the surface ships with PR `steer-composer`.
- **End-to-end check.** curl on the agents stack: hang a turn, POST a steer and read the id; `GET` the chat shows `pending[1]`; `DELETE` answers 204; POST again and release: the SSE stream carries `steer/applied`; a steer sent after the last model call starts a second run.
- **Risk.** The leftover is sent twice after a reload. Guard: it is consumed on the server under the chat lock; the client never re-sends.

#### PR 11: `run-ui-parts`

**feat(ui): shared run UI parts: state badge, pending strip, announcer, focus policy and toast host**

Issues: #3191, #3196, #3197, #3782. Size: M. Stacks on: PR 10.

- **Scope.** `client/src/shared/components/RunStateBadge.jsx` on `Badge.jsx`: a fixed state enum (queued, running, waiting, scheduled, done, no_change, blocked, needs_attention, failed, stopped, interrupted, stalled, paused), one static `t('runState.<state>')` call per state, icon plus text, `motion-reduce`. `client/src/features/chat/components/PendingWorkStrip.jsx`: a pure function of the server's `pending[]`; a `<ul>` of chips, each with a text button and a separate 24 px action button; its own disclosure 'N pending - Show' after two rows (not `ChipOverflow`, whose '+N' is not interactive); `collapsed` for embeds. `client/src/shared/announce/AnnouncerProvider.jsx` with `useAnnounce()` and one `role=status` region in `Layout.jsx`; `RunAnnouncer` and `ScheduledTaskNotifier` speak through it. `client/src/shared/utils/focusPolicy.js` `mayTakeFocus()` is false while focus or text is in `[data-composer]`; `ApprovalCard.jsx` and `ClarificationCard.jsx` use it; `ClarificationCard` becomes `role=group` without `aria-modal` and without the document-level Tab trap. `client/src/shared/components/ToastHost.jsx`, generalised from the task notifier (at most 3, 24 px close target, a toast for something that needs the user stays until closed). i18n namespaces `runState.*` and `chat.pending.*` in en and de.
- **Out of scope.** Any use of the strip in the composer (next PR); the Activity page.
- **Files.** client/src/shared/components/RunStateBadge.jsx, ToastHost.jsx; client/src/shared/announce/AnnouncerProvider.jsx; client/src/shared/utils/focusPolicy.js; client/src/features/chat/components/PendingWorkStrip.jsx, ApprovalCard.jsx, ClarificationCard.jsx, RunAnnouncer.jsx; client/src/features/tasks/components/ScheduledTaskNotifier.jsx; Layout.jsx; shared/i18n
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** Approval and question cards no longer take the keyboard focus while the user types.
- **Acceptance.**
  - The badge test renders every state in en and de from the real locale files.
  - A ratchet test fails on a new `aria-live` or `role=status` outside the provider and the toast host.
  - While the user types, an approval that appears does not take focus and Enter does not approve.
  - With four pending items the fourth can be removed by keyboard; at 320 px in German nothing scrolls sideways.
- **Tests.** tests/unit/client/run-state-badge.test.jsx, pending-work-strip.test.jsx, announcer.test.jsx, focus-policy.test.jsx, live-region-ratchet.test.jsx; tests/e2e-agents/focus-policy.spec.js.
- **Docs and release entry.** No docs page. Release entry: `fixes.md` 'A Question or Approval Card No Longer Takes the Focus While You Type'.
- **End-to-end check.** `npm run test:e2e:agents -- focus-policy.spec.js`: type in the composer, the stub raises `ask_user` through `e2e-tool`, focus and text stay, Enter does not answer the card.
- **Risk.** Screen-reader users hear things twice. Guard: one region, the ratchet test, a manual NVDA and VoiceOver pass at the end of the slice.

#### PR 12: `steer-composer`

**feat(chat): message while iHub is working: composer, chips and send afterwards**

Issues: #3191. Size: L. Stacks on: PR 11.

- **Scope.** `ChatInput.jsx` gets an opt-in prop `whileRunning = { enabled, blockedReason, onSteer, onSendAfter }`, set only in `AppChat.jsx` when the server says `maySteer`. Office, Canvas, the starter and the browser extension keep the single toggle button. With it: the textarea stays enabled (read-only with `aria-disabled` and the placeholder 'Answer the question above first' while a question or approval is pending). Buttons in DOM and visual order: Stop, Send, menu. Send keeps its old place; Stop sits to its left with the name 'Stop answer' / 'Antwort stoppen'; the menu 'More ways to send' has one item 'Send after this answer' (Alt+Enter). Enter never stops a run. Chips in `PendingWorkStrip` come from `pending[]`: 'Will be read at the next step: ...', 'Will be sent as the next message: ...'; Remove calls the DELETE; a 409 shows the toast 'Already read by iHub'. The applied steer is rendered from the server's activity item at its step, by one component live and from the stored turn, with the caption 'Sent while iHub was working'. A dropped steer leaves an inline notice with 'Copy to input'. A hint appears when 20 messages wait. `useAppChat.js` and `shared/run/runReducer.js` handle the `steer/*` frames; all announcements go through `useAnnounce`. Disabled attach, model and voice controls state the reason. Strings `chat.steer.*` in en and de; the word 'Queued' is not used for a chip.
- **Out of scope.** Outlook add-in and browser extension (hidden); a per-model switch.
- **Files.** client/src/features/chat/components/ChatInput.jsx, ChatMessage.jsx; client/src/features/apps/pages/AppChat.jsx; client/src/features/chat/hooks/useAppChat.js; shared/run/runReducer.js; shared/i18n; tests/e2e-agents/steer.spec.js; tests/e2e/accessibility.spec.js
- **Flags.** `steering` (preview, off)
- **Migrations.** none
- **Behaviour change.** With the flag on, the composer stays enabled during a run and has separate Stop and Send controls.
- **Acceptance.**
  - Enter with text during a run never stops it; Stop and Send are separate controls with stable names; a click on the old Stop position with an empty field does not stop the run.
  - A message typed during a run appears at the step where it was read, in the same place live and after a reload.
  - 'Send after this answer' makes the message the next turn and does not change the running answer.
  - Adding, applying and removing are announced; focus stays in the textarea; all strings exist in en and de.
  - OfficeChatPanel and CanvasChatPanel render today's single button during a run (unit test); the two embed docs say the feature is not available there.
- **Tests.** Client unit tests for the composer states and for the other callers; steer.spec.js (type, chip, release, position, reload, send afterwards, second user cannot steer); axe states; a 320 px German layout check.
- **Docs and release entry.** docs/user-guide.md 'The chat input'; docs/outlook-add-in.md, docs/browser-extension.md; glossary rows. Release entry: `features.md` 'Correct a Running Answer Without Stopping It (Preview)'.
- **End-to-end check.** `npm run test:e2e:agents -- steer.spec.js` with the flag on in the agents contents. Manual before release: one screen-reader pass and one run on a vLLM model.
- **Risk.** Users stop a run by accident. Guard: Send keeps its place, Enter never stops, the flag is off by default.

### Slice B: answers survive a restart; admins see and pause runs

#### PR 13: `agent-factory-removal`

**feat!: remove the Agent Factory routes, pages and flag**

Issues: #3773, #3782, #3784. Size: L. Stacks on: PR 12.

- **Scope.** Narrowed removal, because frozen legacy code and applied migrations import parts of the Agent Factory. Deleted: `server/routes/agents/` (index, runs, artifacts), `server/routes/admin/agents.js`, `server/routes/admin/agentInboxes.js`, the `AdminAgent*` and `AgentRun*` pages and their routes (`client/src/App.jsx:639-667`), navigation and command-palette entries, `admin.agents.*` strings, the `agentFactory` registry entry, the run kind `agent` in `usage/callRecord.js`, and the two default profiles in `server/defaults/agents/profiles/` (no longer seeded; `server/defaults/agents/` is reused for default agents in PR 78). Kept with a zero diff until the legacy path is removed (#3784): `server/validators/agentProfileSchema.js` and `agentInboxSchema.js` (imported by `MemoryNodeExecutor.js:19`, `TransformNodeExecutor.js:26`, `agents/memory/memoryFile.js:23`, `agents/inbox/inboxStore.js:30`, `resourceLoaders.js:24`), `server/agents/profile/reviewSettings.js` (imported by `startup/worker.js:481`), the agent-profile loader in `resourceLoaders.js` and `configCache.getAgentProfiles` (read by `worker.js:509`, `executionActor.js:54`, `PromptNodeExecutor.js:2289`, `HumanNodeExecutor.js:315`, `projectLinks.js`), `server/agents/memory/`, `inbox/`, `runtime/`, `server/tools/agentTools.js` and `server/agents/profile/profileWorkflowSerializer.js` (imported by `startup/worker.js` and by the applied migrations V052 to V054). An import failure is fixed by keeping a file, never by editing a frozen executor. After this PR no new run carries an Agent Factory principal: the only code that put `_agent` into the start data was `routes/agents/runs.js:234`. One change in `server/startup/worker.js`: an execution with `data._agent` that is not final is settled as cancelled with the reason `AGENT_FACTORY_REMOVED` before the legacy resume runs (product owner decision A4 accepts a break for stored executions); the agent-profile branch below it stays untouched and is listed for #3784. Without an agent principal a legacy prompt node never registers `app__` tools (`PromptNodeExecutor.js:565`); a test pins that. Stored data (`contents/agents/profiles/`, `contents/agents/memory/*.md`, `contents/data/agent-inboxes/`, `contents/data/agent-artifacts/`, agent runs in `workflow-state`) is not moved or deleted. `CLEAN_PAGES` changes in the same commit. `docs/agents.md` becomes a short 'removed' page (label, H1 and `adminPage` changed together).
- **Out of scope.** The new agents (slice E); any legacy executor; deleting stored data.
- **Files.** server/routes/agents/**, server/routes/admin/agents.js, agentInboxes.js, server/featureRegistry.js, server/startup/worker.js, server/services/usage/callRecord.js, server/defaults/agents/profiles/*.json; client/src/App.jsx and the admin agent pages; tests/e2e/accessibility.spec.js; docs/agents.md; server/tests/adminAgentsRoutesErrors.test.js and agentRunsRoutesErrors.test.js (removed with their routes)
- **Flags.** removes `agentFactory` from the registry (the stored key is removed by V261)
- **Migrations.** none
- **Behaviour change.** The Agent Factory UI, API and flag are gone; Agent Factory runs in flight at the upgrade are cancelled. Legacy workflows keep running.
- **Acceptance.**
  - A test imports every file under `server/services/workflow/executors/` and every migration module without error; the frozen-files test of PR 4 is green (zero diff in frozen files).
  - The server boots on contents that still hold Agent Factory data; the legacy goldens of both law consultation variants (one uses a memory node) are byte-equal.
  - An Agent Factory execution in flight at boot ends cancelled with `AGENT_FACTORY_REMOVED` and is not resumed.
  - A legacy prompt node with an `apps` list and no agent principal registers no `app__` tool.
  - A fresh install gets no agent profile files; an existing install that has them boots and loads them.
  - No `/api/agents` route, admin page, navigation entry or flag remains; `scripts/check-route-changes.js --strict` passes with the breaking entry.
  - The accessibility suite passes with the updated page list.
- **Tests.** server/tests/legacy-import-graph.test.js; server/tests/boot-with-agent-factory-data.test.js (boot, cancel of in-flight runs); prompt-node test without an agent principal; legacy goldens; a11y spec.
- **Docs and release entry.** docs/agents.md, docs/concepts.md:147, docs/iFinder-Integration.md. Release entry: `breaking-changes.md` 'The Agent Factory Is Removed' with the five storage locations and the statements that files stay on disk and that Agent Factory runs in flight are cancelled.
- **End-to-end check.** Boot the stack; `curl -b jar .../api/admin/agents` answers 404 problem+json; a direct load of `/admin/agents` shows the not-found page; a legacy default workflow starts from the workflow page against the stub.
- **Risk.** A kept module turns out to import a deleted one. Guard: the import-graph test, the frozen-files test and the rule that a failure is fixed by keeping the file.

#### PR 14: `tool-runner`

**refactor(run): one tool runner for chat, app-as-tool, MCP and A2A tool calls**

Issues: #3772. Size: M. Stacks on: PR 13.

- **Scope.** New `server/services/run/ToolRunner.js` `execute(call, { toolId, args, signal, toolContext })` around `server/services/tools/runTool.js`: the union of today's checks (the table for S10 is in the PR body, one test per row), the page-read gate (opt-in through `toolContext`), `app__` routing, argument injection, and `toolDisplayOf` for every caller. It replaces both `executeTool` closures in `ChatService.js`. The direct `runTool(` callers move behind it: raw MCP `tools/call` (`McpServerService.js:399`, `:496`), A2A (`a2aHandler.js:701`), `loop/seams/passthroughSeam.js:111`, `chat/chatSeams.js:951`. `ToolNodeExecutor.js` stays (legacy exception). An allow-list file for `runTool(` outside `server/services/run/` is introduced with a reason and a removal issue per entry.
- **Out of scope.** The grant re-check (next PR); the run service.
- **Files.** server/services/run/ToolRunner.js; server/services/chat/ChatService.js; server/services/mcp/McpServerService.js, a2aHandler.js; server/services/loop/seams/passthroughSeam.js; server/services/chat/chatSeams.js; server/tests/run/toolRunner.checks.test.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** none except signed difference rows
- **Acceptance.**
  - Goldens are equal except for rows named in the PR.
  - The S10 table is in the PR body with one test per row.
  - No bare `runTool(` call remains outside the run directory except entries of the allow-list.
- **Tests.** server/tests/run/toolRunner.checks.test.js (table-driven); goldens.
- **Docs and release entry.** docs/agent-loop.md: paragraph 'tool runner'. Release entry: none.
- **End-to-end check.** `npm run test:e2e:agents` (the smoke spec's `e2e-tool` row) and `tests/e2e/chat.spec.js`.
- **Risk.** Raw MCP and A2A tool calls change behaviour. Guard: their goldens from PR 4.

#### PR 15: `run-service-headless`

**refactor(run): run service and headless host; app-as-tool, MCP and A2A run on it; app calls fail closed**

Issues: #3772, #3780. Size: L. Stacks on: PR 14.

- **Scope.** `server/services/run/RunService.js` `run(spec, host)`; `RunContext.js` builds a frozen context `{ principal, principalType, actor, agentId, agentVersion, origin, unattended, parentRunId, depth, toolGrant, integrationGrant, approvalRoute, budget, taint }` (`unattended` is true for every origin other than `person` and for `principalType: 'client'`, that is an OAuth client or a personal API key, exactly what `isUnattendedCaller` in `server/utils/toolApproval.js` decides today; inbound `/v1`, MCP and A2A requests have the origin `person` and keep their admin flags as today); `principalResolver.js` generalises `scheduler/tasks/ownerPrincipal.js` and forces `isAdmin` and `adminAccess` off for every origin other than `person`; `seamProfiles.js` `build({ interactions, structuredOutput, host })` returns the ordered seams, approval first; `hosts/HeadlessHost.js`; `assemble/fromApp.js` wraps `prepareChatRequest`. `ToolRunner` re-checks `toolGrant` and `canUserAccessResource` on every call and audits a refusal. `appToolsGateway.js` and `mcp/appInvoker.js` build a `RunSpec`; `ChatService.invokeAppInternal` (`:1922-2168`) is deleted and the five test files that mocked it are rewritten against the real service. `isAppInvocationAllowed` (`appToolsGateway.js:113-116`) refuses a principal without `permissions`. No resolution of a legacy agent principal is built: since PR 13 no run carries one, so the frozen `PromptNodeExecutor` never reaches the gateway. `isUnattendedCaller` reads the context. A model's tool maximum and 'no parallel tool calls' are honoured for every caller.
- **Out of scope.** Chat, scheduled runs and `/v1` (PRs `chat-host-move`, `chat-on-run-service`); `delegate`.
- **Files.** server/services/run/RunService.js, RunContext.js, principalResolver.js, seamProfiles.js, hosts/HeadlessHost.js, assemble/fromApp.js, ToolRunner.js; server/services/chat/appToolsGateway.js, ChatService.js; server/services/mcp/appInvoker.js; server/utils/toolApproval.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** An app call by a principal without resolved permissions is refused.
- **Acceptance.**
  - `grep -rn invokeAppInternal server docs` returns nothing.
  - The context is frozen and a seam that mutates it throws in tests; the approval seam is first.
  - A headless caller gets a denial, not a pending approval; a tool outside the grant is refused and audited on app-as-tool, MCP and A2A.
  - A bare principal is refused. Parity table test over session user, personal API key, OAuth client and scheduled run: `unattended` and the admin flags equal what `isUnattendedCaller` and the principal give today, except the signed row.
  - 'Children cannot write memory' still holds; app-as-tool passes the caller's `integrationScopes` and its row shows the app's localized name.
- **Tests.** server/tests/run/runService.test.js, principalResolver.test.js; appToolsGateway.test.js cases; MCP and A2A tests through the service (no jest mock of `server/services/run/`).
- **Docs and release entry.** docs/mcp-integration.md, docs/architecture.md. Release entry: `fixes.md` 'An App Call Without Resolved Permissions Is Refused'.
- **End-to-end check.** On the stack with `appAsTool` on: a message `e2e-tool:app__<id>:{...}` shows the app row and the answer; an MCP `tools/call` for an app tool with the admin session returns the stub answer.
- **Risk.** The fail-open fix breaks a legacy workflow and is reverted. Guard: the legacy path cannot reach the gateway after PR 13 (tested there); the legacy workflow goldens stay byte-equal.

#### PR 16: `chat-host-move`

**refactor(run): move the body of the chat turn into ChatHost (move plus receiver rename)**

Issues: #3772. Size: L. Stacks on: PR 15.

- **Scope.** New `server/services/run/hosts/ChatHost.js` takes the body of `ChatService.runTurn` (`:583-1337`, 755 lines) and `_finishTurn` (`:1452-1921`, 470 lines): continuing the ledger, `settleUserTurn`, `materializeAssistantTurn`, the title, and the storage of a pending approval or connect. `runTurn` keeps its signature and delegates. Mechanism: `ChatHost` receives the `ChatService` instance as a collaborator `svc`; the only permitted edit in the moved bodies is the receiver rename `this.` to `svc.` (about 35 references: `runLog`, `logInteraction`, `_endLedgerRun`, `runTool`, `interactionService`, `agentLoop`, `_storePendingApproval`, `_storePendingConnect`, `_startLedgerRun`, `_continueLedgerRun`, `_appendUserMessageEvent`, `resolveAnswerSources`, `telemetry`). These helper methods stay on `ChatService`; only the two bodies move. Chat, scheduled runs (`taskExecution.js:594`) and both `/v1` routes (`inference/appTurn.js:230`) all call `runTurn`, so they are covered together.
- **Out of scope.** Routing through `RunService` (next PR); any behaviour change.
- **Files.** server/services/run/hosts/ChatHost.js; server/services/chat/ChatService.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** none
- **Acceptance.**
  - `git diff --color-moved --color-moved-ws=allow-indentation-change` shows the two bodies as moved; the remaining changed lines differ only in `this.` versus `svc.`.
  - `chatTurn.test.js` (49 tests) and every golden are byte-equal.
  - `npm run check:response-shapes` passes.
- **Tests.** Existing tests and goldens; the golden harness reads the stored chat, ledger, evidence and usage from storage, not from spies.
- **Docs and release entry.** None. Release entry: none.
- **End-to-end check.** `npm run test:e2e:agents`, `tests/e2e/chat.spec.js` for both `chatPostStream` positions, and `tests/e2e/scheduled-tasks.spec.js` on Chromium.
- **Risk.** A 3,000-line PR that nobody reviews. Guard: the move and the change are two PRs.

#### PR 17: `chat-on-run-service`

**refactor(run): chat, scheduled runs and /v1 run through the run service; architecture guard tests**

Issues: #3772. Size: L. Stacks on: PR 16.

- **Scope.** `ChatHost` calls `RunService.run` (frozen context, seam profile, grant re-check) instead of the loop. `chatTurnStart.js`, `scheduler/tasks/taskExecution.js` and `inference/appTurn.js` (serves `/v1/chat/completions` and `/v1/responses`) build a `RunSpec` through `assemble.fromApp`; the user-flag copies (`isInvokedViaAppAsTool`, `scheduledRun`, `isAgent`) become context fields. With the switch false, `ChatHost` calls the loop with the pre-move seam wiring. Guard tests in `server/tests/architecture/`, each with a negative fixture: no `agentLoop.run(`, `new AgentLoop(` or `runTool(` outside `server/services/run/` except the allow-list (`PromptNodeExecutor.js`, `ToolNodeExecutor.js`, each with reason and removal issue #3784); no bare `fetch(`, `https.request(` or `new WebSocket(` in `server/tools` and `server/services/run`; no `vm`, `eval` or `new Function` outside a named legacy list. Log lines and spans gain `runId`, `parentRunId`, `kind`, `principalId`, `agentId`, `chatId`, `modelId` (span names unchanged); new gauge `runs_active{kind,model}`.
- **Out of scope.** Jobs; the envelope; usage dimensions.
- **Files.** server/services/run/hosts/ChatHost.js, RunService.js; server/services/chat/chatTurnStart.js; server/services/scheduler/tasks/taskExecution.js; server/services/inference/appTurn.js; server/validators/platformConfigSchema.js; server/tests/architecture/*.test.js; docs/agent-loop.md ; tests/load/compare.mjs
- **Flags.** `platform.runs.chatOnRunService` (internal kill switch, default true, not in Admin, Features; removed one release later)
- **Migrations.** none
- **Behaviour change.** An unattended run of an admin (a scheduled task) no longer carries admin rights (signed row). Otherwise none except signed rows; additive `run/started` fields.
- **Acceptance.**
  - `chatTurn.test.js` and the chat goldens pass for both switch positions; the 17 scheduled-task test files pass untouched.
  - A tool call outside the grant is refused and audited on chat, scheduled runs and `/v1`; `/v1` keeps the OpenAI error format.
  - A `buildRunActivity` fixture test renders answers stored before the change.
  - Time to first token on `capacity-stub`: base commit and head commit are measured back to back in one job (`tests/load/compare.mjs`, five repetitions each, medians); the head median is at most 10 % above the base median and the spread of the base runs is reported. If the spread is above 10 %, the numbers are reported and the gate becomes a release gate measured by a person.
  - The guard test fails when a forbidden call is added in a scratch file (shown in the PR).
- **Tests.** server/tests/run/architecture.test.js and siblings; goldens; loadtest smoke.
- **Docs and release entry.** docs/agent-loop.md 'The run service' (request, assembly order, tool runner guarantees, callers table, limits table; the legacy engine is outside), docs/developer-onboarding.md, docs/openai-compatible-api.md, docs/telemetry.md. Release entry: `breaking-changes.md` 'Unattended Runs Never Use Admin Rights'.
- **End-to-end check.** Agents suite; curl `/v1/chat/completions` stream and error; 'Run now' on a scheduled task in `tests/e2e/scheduled-tasks.spec.js`.
- **Risk.** The host drops a collaborator call silently. Guard: both switch positions and storage-based goldens.

#### PR 18: `run-envelope-taint-usage`

**feat(run): origin envelope, taint bit and usage dimensions**

Issues: #3785, #3781, #3772. Size: M. Stacks on: PR 17.

- **Scope.** `server/services/run/events/envelope.js`: `{ id, chatId, type, origin: person | child_report | webhook | schedule | handoff | followup, by, causedBy, generation, payload, taint, createdAt }`. The route sets `origin` (`person` only in the chat POST and human-events handlers); new routes use strict schemas, so a caller-supplied `origin`, `taint` or `unattended` is ignored. `server/services/run/assemble/dataFrame.js`: only `person` becomes a `role: 'user'` message; every other origin enters as a data block in a frame with a per-run random delimiter and fixed text; `steering.js` uses it. `ctx.taint` is set once a tool with `untrustedInput` returns and is never cleared; the parking hook exists and is off. An architecture test allows the construction of `role: 'user'` only in `assemble/` and `steering.js`. Usage: `server/services/usage/callRecord.js` gains `origin` (interactive, sub-agent, scheduled, trigger, follow-up), `agentId`, `taskId`, `trigger`; a sub-agent call is marked and counted once; `/admin/usage` exports and columns carry the fields; old records still export.
- **Out of scope.** The event queue store (slice D); parking (PR `taint-gate`).
- **Files.** server/services/run/events/envelope.js, assemble/dataFrame.js, RunContext.js, ToolRunner.js; server/services/loop/steering.js; server/services/usage/callRecord.js and the usage export; admin usage page
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** Usage records and exports gain origin, agent id, scheduled task and trigger.
- **Acceptance.**
  - One test per origin; a forged frame and a forged steer line inside stored text stay data.
  - A run is tainted from the step after it read from a flagged tool.
  - Usage records carry the dimensions and survive `/admin/usage` exports.
  - Goldens change only in `usageRecords`, under the signed row.
- **Tests.** server/tests/run/originAssembly.test.js, taint.test.js; usageCapture.test.js; export test.
- **Docs and release entry.** docs/usage-reporting.md (dimensions), docs/agent-loop.md (envelope). Release entry: `features.md` 'Usage Reports Show Where a Call Came From'.
- **End-to-end check.** Run a scheduled task now and send one chat turn on the stack; the `/api/admin/usage` export shows origin `scheduled` and `interactive`.
- **Risk.** A later producer builds a user message by hand. Guard: the architecture test.

#### PR 19: `run-limits`

**feat(admin): one limits block platform.runs and a 60-minute ceiling for watched answers**

Issues: #3781, #3777, #3783. Size: L. Stacks on: PR 18.

- **Scope.** `server/validators/platformConfigSchema.js`: `runs { maxConcurrent, maxConcurrentPerUser, maxQueuedPerUser, maxWaitingPerUser: 50, maxAttempts: 2, heartbeatMs: 45000, takeoverMs: 180000, resumeMaxAgeMinutes: 30, principalMaxAgeDays: 30, maxGenerations: 3, maxWakesPerChatPerHour: 10, chatOnRunService, chatJobs, interactive { maxWallClockMinutes: 60, maxToolRounds }, unattended { maxConcurrent: 4, maxConcurrentPerUser: 1, maxConcurrentPerModel, maxWallClockMinutes: 30 }, subAgents { maxPerRun, maxConcurrentPerUser, maxToolRounds, maxWallClockMinutes, maxTokens, maxOutputChars, background: false } }`, defaults in code. `server/services/run/limits.js` `resolve(origin, principal, model)` with group overrides in `groups.json`, resolved like `usageLimits`. V260 copies `platform.scheduledTasks.maxConcurrentRuns` and `maxConcurrentRunsPerUser` to `runs.unattended.maxConcurrent` and `maxConcurrentPerUser` where the target is absent, then removes the two source keys; the schema, `taskPolicy` and the scheduled-tasks admin page drop them in this PR. `maxRunMinutes` and all other `scheduledTasks` keys stay. Ceiling: a user-started turn ends at `interactive.maxWallClockMinutes` through the normal stop path with a readable reason and 'Continue'; the partial answer is kept; it replaces `DURABLE_TURN_WALL_CLOCK_MS` for these turns. Admin UI: `RunLimitsCard` on the platform settings page, strings `admin.runLimits.*` in en and de. A test compares the schema defaults with the table in `docs/usage-limits.md`. `RunLimitsCard` is the first admin surface of the stack: it is built after the blocking question on the admin rework (#3739, #3742) is answered; on the answer to wait, the card is left out of this PR and the keys are set in the JSON view until the rework lands.
- **Out of scope.** Counting from the quota records and the quota (PR `run-executor-scheduled`); pause and drain.
- **Files.** server/validators/platformConfigSchema.js, groupConfigSchema.js; server/services/run/limits.js; server/migrations/V260__move_task_concurrency_to_platform_runs.js; scheduler task policy; client admin platform page and `RunLimitsCard.jsx`; docs/usage-limits.md
- **Flags.** none
- **Migrations.** V260 `move_task_concurrency_to_platform_runs`
- **Behaviour change.** A turn a user started ends after 60 minutes (unstored turns had no limit, stored ones 30). Two scheduled-task keys move.
- **Acceptance.**
  - The migration is idempotent, keeps every admin value, and passes on a hand-edited file; the old keys are gone from schema and UI.
  - A group override changes the caps for its members.
  - With a fake clock a user-started turn ends at the ceiling, names the limit and keeps the partial answer.
  - The docs table equals the schema defaults (test).
- **Tests.** Migration test; limits.test.js; ceiling test; `RunLimitsCard` unit test; admin class hygiene.
- **Docs and release entry.** docs/usage-limits.md (one table: key, default, range, scope, group override; lists `platform.requestConcurrency` and per-model `concurrency` too), docs/platform.md, docs/scheduled-tasks.md. Release entry: `breaking-changes.md` 'Run Limits Move to platform.runs; Watched Answers End After 60 Minutes'.
- **End-to-end check.** As admin open the platform settings, set the unattended concurrency, save and reload: the value is kept; `GET /api/admin/configs/platform` shows `runs` and no old key.
- **Risk.** An admin edits an old key and nothing happens. Guard: the keys are removed, not left unread.

#### PR 20: `erasure-coverage`

**fix(privacy): user deletion covers every store filed under a user and retries failed steps**

Issues: #3787, #3785. Size: M. Stacks on: PR 19.

- **Scope.** `server/tests/namespaceErasureCoverage.test.js` with an explicit, reviewed table `server/tests/namespaceErasure.table.js`: every runtime namespace of `server/storage/namespaces.js` is listed with the step of `USER_CLEANUP_STEPS` (`server/services/userDeletion.js:77-247`, 15 steps today) that removes it, or with an exemption and its reason. Rule: a namespace whose records are filed under an owner id cannot be exempted. New steps for stores that have none today: the access step `interactions` (pending interactions are cancelled and deleted; they are filed under `ownerId`, `InteractionService.js:372-378`, and from PR 39 they hold the content of parked writes), and content steps for the other owner-filed stores the table finds (`runs`, `artifacts`, `provenance-records`, `workflow-state`, `integration-conversations`, `user-skill-versions` and any further one the test lists). Failed steps are only logged today (`userDeletion.js:273-281`): they are persisted as `failed[]` and retried at boot. Later pull requests add only the rows and steps of their own stores.
- **Out of scope.** Stores this stack adds later; chat retention.
- **Files.** server/services/userDeletion.js; server/tests/namespaceErasureCoverage.test.js, namespaceErasure.table.js; docs/pii-data-handling.md
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** Deleting a user also removes that user's pending approvals and questions and every other store filed under the user; a failed step is retried at the next start.
- **Acceptance.**
  - The coverage test fails for a namespace that is in no step and not exempted, and for an exemption on an owner-filed namespace.
  - After a user is deleted, no record with that owner id remains in any runtime namespace, and a second user's data is untouched (scan test on seeded contents).
  - A pending approval of the deleted user is cancelled and gone, and its run ends.
  - A step that throws is stored in `failed[]` and runs again at boot; the second run is idempotent.
- **Tests.** namespaceErasureCoverage.test.js; user-deletion-cleanup.test.js extended; boot retry test.
- **Docs and release entry.** docs/pii-data-handling.md: one row per store. Release entry: `fixes.md` 'Deleting a User Removes Pending Approvals and Every Store Filed Under the User'.
- **End-to-end check.** On the agents stack: as `e2e-user` start a turn that pauses on an approval; as admin delete `e2e-user` through the admin users API; `grep -rl <userId> contents-e2e-agents/data` returns nothing.
- **Risk.** A step deletes data another user still needs. Guard: steps act on the owner key only; the scan test runs with a second user present.

#### PR 21: `job-store`

**feat(runs): sealed job store with a create-only claim per epoch and re-authorisation at claim**

Issues: #3777, #3787. Size: L. Stacks on: PR 20.

- **Scope.** Namespaces `run-jobs` (the job head, key runId, written with ownerId), `run-claims` (the epoch documents of a job, key `<runId>__<epoch>`, written with ownerId), `deleted-principals`, `run-admission` (the quota record of a principal, key `<principalId>__<seq>`, written with ownerId) and `run-pools` (the slot record of a pool and model, no owner) in `server/storage/namespaces.js`; PR 22 writes the two records, and there is no marker per run. `server/services/run/jobs/JobStore.js`: create, claim, heartbeat, transition, settle. A job is a head and its claims (claim by create, section 2.8). The head is created create-only at submit and never changed: `{ v, runId, kind, origin, recipe { source, appId?, chatId?, messageId?, taskId?, taskRunId?, eventId?, executionId?, parent? }, principalRef { type, id, authMode, provider, groups[], capturedAt }, chatId?, parentRunId?, limits, resumable, formatVersion, mac }`. An epoch document is created create-only by the worker that claims the job and is written by that worker alone afterwards: `{ v, runId, epoch, workerId, reason: start | wake | pickup | takeover | settle | recovered, state: running | waiting | released | done | failed | cancelled, attempt, heartbeatSeq, heartbeatAt, cursor, waitingOn, endState, needs[], mac }`. `workerId` names the process and not the slot: `<bootId>:<workerIndex>:<pid>`, which is the boot id that the first process of a server start draws and hands to its workers (PR 22), the worker number (`WORKER_INDEX`, `server/startup/primary.js:84-85`; 0 with one worker) and the process id. A restarted worker is therefore another owner, the primary can name the worker whose `exit` it saw, and a later start can tell which epochs belong to an earlier one. A job without an epoch document is `queued`; otherwise its state is the state of the highest epoch, and `released` reads as `queued`. Neither document holds messages, arguments or tokens. `jobSeal.js`: HMAC-SHA256 with an HKDF sub-key (info `ihub/run-job/v1`) of the encryption key; a mismatch ends the job as failed with `JOB_INTEGRITY`, audited, never retried. `lease.js` (pure, fake clock): a claim lists the prefix, reads the highest epoch n and, when the transition table allows it (no epoch yet; n is `released` or `waiting`; n is `running` under another `workerId` and the caller names a ground of section 2.8, which is `exited` from PR 22 on and `silent` from PR 28 on; never when n is final), creates `<runId>__<n+1>`; `EtagMismatchError` means the claim is lost. The epoch is fixed at the listing and handed to the create (`planClaim` returns it, `claim(runId, epoch)` creates exactly that key), so the executor can record it before the create and the sweep can create the same key as a fence (PR 22): an epoch with the reason `recovered`, in the state `released` and with the attempt unchanged. After its create the claimer reads the head and lists once more: a missing head or a higher epoch ends the claim and its document is void, and when epoch n became final in between, the claimer copies that end state and does nothing else. `attempt` is carried over from epoch n and raised by one for `pickup` and `takeover`; a wake is an epoch but not an attempt. The epoch is the fencing token of PR 28. No state of a job is changed by a `put` with an etag string: heartbeat, cursor, waiting and the end state are plain writes of the holder into its own epoch document, and a worker that does not hold the job (stopping a queued or waiting job, settling at boot, the sweep) first claims the next epoch with the reason `settle`. A stop request for a running job is a create-only marker `<runId>__stop` in `run-claims` (not an epoch), which the holder reads at every step; the bus message is only the hint. `canTakeOver` uses the heartbeat sequence seen on the observer's own clock; it has no caller before PR 28, and until then the heartbeat of another holder is only shown and logged. Retention and user deletion delete the head before its epoch documents. `claim.js`: rebuild the principal through `principalResolver`, re-authorise the recipe (owns the chat, may use app, model and integrations), check the deleted-principal tombstone (`{ principalId, deletedAt }`; only a job or event created before `deletedAt` is refused, so a user who is deleted and returns under the same external id can work again), and pause an unattended job whose `capturedAt` is older than `principalMaxAgeDays` with the reason 'sign in again'. Every transition from `waiting` to `running` is a claim with the full re-authorisation, so a run that waited for days does not continue on old rights. `server/services/userDeletion.js`: access step `runJobs` before `scheduledTasks` (cancel and delete jobs, head first and then the epoch documents, delete the principal's quota record, write the tombstone; `run-pools` holds runIds and epoch numbers only and is exempted with that reason, the sweep of PR 22 drops the runId of a deleted job); the stores get their rows in the erasure table of PR 20. `tests/config/agents-server.mjs` gains `POST /__seed-job`, which writes a job through `JobStore` so its seal is valid; browser checks that need a job in a given state use it, because a sealed record cannot be a static fixture.
- **Out of scope.** The executor; any resume.
- **Files.** server/storage/namespaces.js; server/services/run/jobs/JobStore.js, jobSeal.js, lease.js, claim.js; server/services/userDeletion.js; server/tests/run/jobs/*.test.js ; server/tests/helpers/stalledWriter.js; tests/config/agents-server.mjs
- **Flags.** none (dark: no caller yet)
- **Migrations.** none
- **Behaviour change.** none
- **Acceptance.**
  - Transition table test covers every (state, event) pair including illegal ones.
  - 100 concurrent claims in one process, and 2 forked workers x 50, give exactly one winner and one epoch document.
  - Stalled claimer (`stalledWriter`: a pause of 20 s between the listing and the create, longer than the 15 s file lease): the other worker claims in the pause, the stalled create fails with `EtagMismatchError` and the stalled worker starts nothing.
  - Stalled holder: epoch 1 is paused, epoch 2 is claimed, epoch 1 continues and writes a heartbeat and `done` into its own document; the job reads as epoch 2 says, in the store and in the admin list.
  - A `settle`, `pickup` or `takeover` claim over a `running` epoch of another `workerId` throws without a ground, whatever the age of the heartbeat (fake clock moved past `takeoverMs`); with the ground `exited` it creates the next epoch.
  - A claim created after the head was deleted is void: the claimer removes its document and starts nothing. A final job cannot be claimed.
  - A `recovered` epoch created under the key a claimer planned makes that claimer's create fail; the job reads as `queued` and the next claim takes the following epoch with the same attempt.
  - The grep test of section 2.8 is green: no `put` with an etag string under `server/services/run/jobs/`.
  - An edited `principalRef`, an edited `recipe.chatId` or a replaced key is refused.
  - Property test: no string of the request body and no API key is in the stored document.
  - An owner deactivated while the job is queued: the claim is refused and no model call happens.
  - A user is deleted and signs in again under the same id: a new job is claimed; a job queued before the deletion is refused.
  - A job that waited is re-authorised when it continues: with app access removed meanwhile it ends with a readable reason and makes no model call.
- **Tests.** server/tests/run/jobs/*.test.js; user-deletion-cleanup.test.js extended; namespaceErasureCoverage.test.js.
- **Docs and release entry.** docs/pii-data-handling.md: rows for job records and the deleted-principal record. Release entry: none (not reachable).
- **End-to-end check.** `node scripts/run-server-tests.js jobs` and `npm run test:boot` (the namespaces register on fresh contents).
- **Risk.** The seal is taken for the control. Guard: a record never grants a right; the recipe is re-authorised at claim. A second risk: a later pull request changes job state with a conditional `put`. Guard: the grep test and the one-writer rule of section 2.8.

#### PR 22: `run-executor-scheduled`

**feat(runs): run executor; scheduled runs execute as jobs**

Issues: #3777, #3783, #3781. Size: L. Stacks on: PR 21.

- **Scope.** `server/services/run/jobs/RunExecutor.js`, one per worker: submit, local claim, bus hint, 30 s sweep, heartbeat, cancel, settle. Settling an interrupted job is scoped to its owner, because `run-jobs` is shared by all workers. On SIGTERM a worker settles as failed and interrupted the jobs it holds, which are those whose highest epoch document carries its own `workerId` (PR 21), by a write into its own epoch document, and it touches no other job. The order at shutdown is fixed: the worker stops claiming, aborts the loop of each job it holds (the abort signal reaches the model call and the tools; a write tool in flight is left as flushed without a result, which is the unknown outcome of PR 27 and never a repeat), waits until that loop has returned, and writes the settle as its last act for the job. A job whose loop has not returned when the shutdown grace ends is not settled by this worker at all: its epoch stays `running`, the process exits, and the job is settled on the ground `exited`. So nothing is written that lets another worker act while this one can still execute. A job held under another `workerId` is settled only after the confirmed end of that holder's process (the ground `exited`, section 2.8); a heartbeat that stands still is no ground before PR 28. There are two confirmations. (a) Exit seen by the primary. The primary knows the `workerId` of every worker it forks (boot id, worker number and `worker.process.pid`). Its `exit` handler (`server/startup/primary.js:97-156`, which today logs and forks the replacement) adds that id to the list of ended workers of this start and announces it over the bus (`server/clusterBus.js`, a new message beside the presence retraction of `:520-549`). The announcement is only the hint: a sweep that meets a `running` epoch of another worker of its own start asks the primary for the list (request and reply over the bus) and acts only on an id that is in it. Node emits `exit` after the system reported the end of the process, so no code of that worker runs afterwards. (b) An earlier start. `processRegister.js` keeps one boot record per server start in `contents/data/run-boots/`, created create-only as `<seq>.json` (claim by create, section 2.8) with `{ bootId, pid, pidNs?, hostname, startedAt, renewSeq, ended?, forced? }` by the process that `server/server.js:93-99` starts first (the primary, or the single process), before a worker is forked; the workers get `bootId` as `BOOT_ID` beside `WORKER_INDEX` (`primary.js:84-85`). Case (b) holds only with one server per contents directory, and nothing enforces that today: the filesystem provider declares it (`multiInstance: false`, `server/storage/providers/filesystem/FilesystemStorageProvider.js:665`) and the start only logs it (`server/storage/bootstrap.js:75`), and the one lock file there is, the scheduler lock, is given up after 30 s without renewal (`server/services/workflow/triggers/schedulerLock.js:92-97`). The boot record adds the enforcement on one host. `pidNs` is the identity of the process's PID namespace: the target of the link `/proc/self/ns/pid` on Linux (`fs.readlinkSync`), the constant `host` on a platform without PID namespaces, and absent when the link cannot be read. The booting process reads the highest record before it creates its own. A pid says something only inside its namespace: two containers on one host can share the contents directory and the hostname while each server is pid 1 of its own namespace, and a probe would take the live server for the booting process itself. The probe (`process.kill(pid, 0)` as in `schedulerLock.js:42-51`) therefore decides only when the record carries the hostname and the `pidNs` of the booting process and its pid is neither 1 nor the booting process's own: a live pid refuses the start with a message that names the pid and the file, a pid that is gone lets it through. In every other case (another hostname, another `pidNs` or none on either side, pid 1, the own pid, which `schedulerLock.js:76-90` counts as ended) the record cannot be probed and the booting process observes it instead: it watches `renewSeq`, which the owner rewrites every 10 s, for 30 s on its own clock, refuses the start when it moves and goes on with a warning otherwise. A clean shutdown marks its record `ended`, so that wait happens only after a crash in a container or under a new host name. What stays undetected: an instance that is frozen as a whole (a paused container, a suspended machine) for longer than those 30 s and continues afterwards; several hosts on one contents directory are not supported (PR 28, out of scope). An operator who knows that no other server uses the directory (a start refused because the system gave the recorded pid to another program, for example) sets `IHUB_FORCE_BOOT=1`: the start then goes on whatever the probe or the observation says, logs a warning that names the record it overrode, writes an audit entry and marks its own record `forced`. It is documented as a switch for one start and not as a setting. An epoch whose `workerId` carries the boot id of an earlier record is settled by the same rule. When that record can be probed, the epoch's pid must be gone on this host or be the pid of a process of the current start. When it cannot, the observation (or the override) that let this start through stands in for the probe; that is exact for a record with pid 1, because the kernel ends every process of a PID namespace together with its pid 1, and otherwise it shares the limit just named. The boot scan and every sweep probe again, and an epoch whose pid is alive (a worker left behind by a killed primary, or a pid the system gave to another program) stays `running` and is logged; the ground `silent` of PR 28 ends that wait. With one worker (`WORKERS` = 1) there is no primary and every other `workerId` is of an earlier start, so the boot scan settles such jobs at once, as `taskSource.js:154-179` does today. A holder that is alive and silent is therefore never settled before PR 28: its job stays `running` (a warning is logged once its heartbeat is older than `takeoverMs`), its quota entry and its pool slot stay taken, a stop request is the marker of PR 21, which it reads when it continues, and when it continues it finishes its job as the only holder. A worker that was killed is handled at the next sweep, because the primary saw its exit. Nothing is started a second time (re-queue and pickup come with PR 26, after the flush rule exists). `admission.js`: a quota per principal (queued plus running; over it `RUN_QUEUE_FULL`, 429, new in `shared/apiErrors.js`), pools for interactive and unattended runs per model, a waiting run holds no slot but counts against `maxWaitingPerUser`. There is one reservation state and no lock, lease or marker beside it: a quota record per principal in `run-admission` (`{ v, seq, entries[] }`, an entry is `{ runId, state: reserved | queued | running | waiting, kind, origin, model, pool, parentRunId?, claimEpoch?, sightings }`) and a slot record per pool and model in `run-pools` (the slots that are held, each `{ runId, epoch }`, so a slot belongs to one claim and freeing it cannot free the slot of a later claim). Admission, claim, settle and sweep are compare-and-swap transitions of these records, and nothing else frees or takes a slot. The swap is the create-only write of section 2.8 (claim by create; the reasons and the code references are there), with the version number as the epoch. Unlike the other claims this chain prunes old versions, which reopens their keys; the second listing described below covers that. A record is a chain of versions with the key `<scope>__<seq>` (`seq` zero-padded; the scope is the principal id, or pool and model): `transition(scope, fn)` lists the prefix, reads the highest version n, applies `fn` to its entries and creates version n+1 create-only. A conflict means another writer created n+1: read again and retry, at most 5 times, then answer as for a full quota. A writer that stalled between its read and its write overwrites nothing, its create fails. After its create the writer lists again; a higher version means that its version was built upon, or that it wrote a sequence number already pruned after a long stall, and in both cases it reads again and decides by the entry of its runId, so every transition is idempotent per runId. It then deletes the versions below n; a record is two small documents, the principal's are deleted with the user. The provider must declare `conditionalWrites` (`server/storage/StorageProvider.js:43-46`), otherwise the executor does not start. Admission: (1) a transition refuses with `RUN_QUEUE_FULL` when the entries fill the quota and otherwise adds the runId as `reserved`; (2) the job document is created create-only; (3) a transition turns the entry into `queued`. The run is acknowledged (202) only after (3). When (2) fails, a transition removes the entry; when (3) finds the entry gone, the job document is deleted and the answer is `RUN_QUEUE_FULL`. Claim, in this order: the claimer lists the job's epochs and fixes the epoch e it is going to create (PR 21); a transition turns the entry from `queued` into `running` and records `claimEpoch: e`; a transition adds the slot `{ runId, epoch: e }` to the pool record when the pool has a free slot (with none, a transition puts the entry back to `queued`); then the job is claimed by creating `<runId>__<e>`. The entry therefore names the key before anything is taken, the slot is taken for that key only, and whoever gives the slot away closes the key first. The create of `<runId>__<e>` is the one point the storage enforces for entry, slot and job together: there is no step at which a claimer holds a slot that the entry does not announce, and wherever it pauses (after the entry, after the slot) its start depends on a create the sweep can pre-empt. A claimer whose create fails starts nothing, removes its own slot and puts the entry back to `queued` when it still names e and the document of e is `released`. A runId that is not in the principal's record is not claimable and its job is settled as failed with `RUN_QUEUE_FULL`; since a run is acknowledged only after (3) and an entry leaves the record only as described here, that happens only after a restored backup or a record deleted by hand. Settle: a transition removes the runId from both records; a run that starts to wait gives its pool slot back and its entry becomes `waiting`. Sweep (30 s, any worker, transitions only): it removes an entry whose job is final, and an entry past `reserved` whose job is missing (both are permanent: such an entry had its job before the run was acknowledged, and a runId is not used twice). An entry still `reserved`, an entry `running` whose document `<runId>__<claimEpoch>` is missing or `released`, and a pool slot whose entry is not `running` with that epoch are counted in `sightings` by the sweep's own transition and handled at the second sighting: the reservation is removed together with a job document left behind, and the pool slot without an entry is freed. A `running` entry is recovered behind a fence (claim by create, section 2.8): when the document is missing, the sweep creates `<runId>__<claimEpoch>` itself with the reason `recovered` and the state `released`; only after that create, or when the document already was `released`, it frees the slot of that epoch and puts the entry back to `queued`, both by transitions that act only on an entry and a slot still naming that epoch. A claimer that resumes after both sweeps finds its key taken: its create fails and it starts nothing, so no job starts on a slot the sweep gave to another run. When the sweep's create fails instead, the claimer arrived first and holds the job with its slot, and the sweep clears the count. A sweep that stopped between the fence and the transitions leaves a `released` document, which the next sweeps handle by the same rule. The next claim takes epoch e+1. This recovery covers the window before the claim and nothing else: the claimer has not created its epoch, the sweep's create decides against it whether it is alive or not, and no proof of its end is needed. Once the document `<runId>__<claimEpoch>` exists as `running`, entry and slot belong to a holder that may be executing: the sweep counts no sighting for them however old the heartbeat is, and they are released only by the holder's own settle or by the settle that follows the confirmed end of its process. The count is in the record, so no clock is read or compared (the workers share one host in any case). A late job cannot admit over the quota: an admitter that stalls after (1) for longer than two sweeps still creates its job, but (3) finds no entry, so it deletes the job and refuses; the slot the sweep freed was never acknowledged to anybody. A sweep that meets an admission in flight either loses the swap against (3) and reads `queued`, or wins it and (3) refuses. The records cached per worker and fed by the change notifier and the bus serve lists and a fast refusal only; they never admit a run. Lists of runs read `run-jobs` by owner. `recipes.js` turns a recipe into a `RunSpec` and a host (scheduled run now; app turn, event wake, child and engine execution later). `SchedulerService` and the scheduler lock stay as the due-finder; `taskSource.js` hands a due task to the executor. The due slot is still planned by `ScheduledTaskRepository.mutateTask`, a `put` with an etag string under the advisory scheduler lock, so after a stall two due-finders can plan the same slot. The runId of a scheduled or catch-up run is therefore derived from the task id and the slot time, and the create-only job head makes the second submit a no-op; 'Run now' keeps a random id. Deleted: `scheduler/tasks/taskRunner.js` and the task lease (`taskModel.js:54-70`, `taskExecution.js:247-355`). Switch-over: a run document left `running` or `queued` by the old runner is closed as failed and interrupted at the first boot and the next fire time is computed; nothing starts twice. A run left in `awaiting_approval` by v5.7.2 (`runSeams.js:97`, answered through `taskService.js:1255`) stays answerable: an answer after the upgrade continues it once on the executor or ends it with a readable reason. Principal age: `ownerSnapshot` (`scheduler/tasks/ownerPrincipal.js:49-63`) gains `capturedAt`; a task written by v5.7.2 has none, and the first boot after the upgrade writes the boot time, so no task pauses at the upgrade. Refresh: `server/services/run/principalRefresh.js`, called from `middleware/authRequired.js` on an authenticated request of the owner, at most once per hour per user, rewrites groups and `capturedAt` on that user's tasks; with proxy auth there is no sign-in event, so any authenticated request counts. A task paused for age resumes at the next refresh. A task paused for the snapshot age shows the reason. Legacy workflow executions get no job.
- **Out of scope.** Chat turns; resume after a restart (an interrupted scheduled run fails as today); takeover.
- **Files.** server/services/run/jobs/RunExecutor.js, admission.js, recipes.js, processRegister.js; server/server.js; server/startup/primary.js; server/clusterBus.js; server/services/scheduler/tasks/taskSource.js, taskExecution.js, taskModel.js, taskRunner.js (deleted); shared/apiErrors.js; server/tests/fixtures/contents-5.7-tasks/ ; server/services/scheduler/tasks/ownerPrincipal.js; server/services/run/principalRefresh.js; server/middleware/authRequired.js; server/tests/scheduled-tasks-scheduler.test.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** Scheduled runs of single-sign-on owners pause when the owner has not signed in for `principalMaxAgeDays` (default 30, 0 disables). A server started on a contents directory whose server still runs on the same host refuses to start; after a crash in a container the next start waits 30 s; `IHUB_FORCE_BOOT=1` overrides the refusal for one start.
- **Acceptance.**
  - Two workers on one host enforce one count; with the unattended pool full an interactive turn on the same model still starts; a waiting run holds no slot.
  - Two forked workers submit 20 runs each at the same moment for one principal with one free slot: exactly one is admitted and 39 answer `RUN_QUEUE_FULL`, and the record holds one entry; the same for the last slot of a pool.
  - Pause between read and write (`admission.test.js`, injected between the read of version n and the create of n+1 on worker A, one free slot): worker B admits in the pause; A's create fails with `EtagMismatchError`, A reads again and refuses. With the pause so long that version n+1 was pruned, A's create succeeds, the second listing shows a higher version, and A refuses all the same.
  - Two due-finders that plan the same slot (`stalledWriter` pause of 20 s inside `mutateTask` on one of them) submit one job: the counter is 1 and the task history shows one run.
  - A job document that cannot be created releases the slot: the entry is gone after the failed submit and the next submit is admitted.
  - Sweep against an admission in flight (injected pause between the reservation and the job write): one sweep in the pause leaves the entry, the job is created, the run is acknowledged and the slot is counted once. With the pause longer than two sweeps the entry is removed and may be given away; the late admitter deletes its job, answers `RUN_QUEUE_FULL` and never 202, and the principal never holds more acknowledged runs than the quota.
  - A claim for a runId that is not in the record (record seeded without it) is refused and the job ends as failed with `RUN_QUEUE_FULL`; no model call happens.
  - A lost settle (worker killed after the job became final) frees the slot at the next sweep; a claim interrupted between record and job is back to `queued` at the second sweep.
  - Claimer paused after the entry became `running` (`stalledWriter`, longer than two sweeps, the pool has one slot): the sweep creates the planned epoch as `recovered` and puts the entry back, worker B takes the slot for another run, the claimer resumes: its slot transition finds the pool full or takes a slot it gives back, its create fails with `EtagMismatchError`, it starts nothing and makes no model call.
  - Claimer paused after it took the pool slot: the sweep creates the planned epoch as `recovered`, frees that slot and puts the entry back, worker B takes the slot, the claimer resumes: its create fails and it starts nothing. In both cases the pool never has more running jobs than slots, the first job starts later under the next epoch, and a slot left by a claimer killed after its failed create is freed at the second sweep.
  - A claimer that creates its epoch just before the sweep's fence keeps the job and the slot; the sweep's create fails and it changes nothing.
  - Shutdown order with two workers: worker A holds a job whose model call hangs (stub `e2e-hang`) and gets SIGTERM; no settle is written before A's loop has returned, and worker B touches the job only after that write or after A's exit; with the abort blocked (injected) until the grace ends, A writes nothing, exits, and the job is settled once on the ground `exited`.
  - Owner scope with two workers: SIGTERM to worker A settles only the jobs whose highest epoch A created, and the job worker B executes stays `running` and ends as done. A worker that boots while B runs a job settles nothing of B. With `WORKERS` = 1 a job left `running` by the previous start is settled at boot.
  - Killed worker: SIGKILL to worker A while it holds a job. The primary's `exit` handler announces A's `workerId`, a surviving worker settles the job at its next sweep and the pool slot is free. With the announcement dropped (injected) the sweep gets the list from the primary and settles all the same.
  - Live worker paused past the takeover time: worker A is paused after its post-claim checks and before it starts model work (`stalledWriter` on the fake clock, SIGSTOP in the fault tier) for longer than `takeoverMs`, and the pool has one slot. No worker settles A's job, no epoch above A's exists, the slot stays A's and worker B's run for that pool stays `queued`. A continues and runs its job to `done` as the only holder (the model-call counter is 1); B's run starts after A's settle.
  - Boot record: a second server started on the same contents directory while the first runs exits with the message and writes nothing into `run-jobs`, `run-claims`, `run-admission` and `run-pools`. After `kill -9` of the first, the next start creates the next record and settles the jobs of the earlier start. An epoch of an earlier start whose pid is alive (seeded with the pid of a helper process) stays `running`, and the sweep after the helper ended settles it. A record of another host whose `renewSeq` moves within the 30 s refuses the start (fake clock). A record with the hostname and the `pidNs` of the booting process and a live pid refuses the start at once, without the wait. A record with pid 1 and another `pidNs` (two containers on one host, seeded) is not probed: with a moving `renewSeq` the start is refused, and with a standing one (the predecessor is gone) the start goes on after 30 s, creates the next record and settles the jobs of the earlier start. With `IHUB_FORCE_BOOT=1` a start that would be refused goes on, and the log, the audit entry and `forced` in its record say so.
  - Over the quota a new run is refused with `RUN_QUEUE_FULL` (429).
  - The scheduled-task harness is ported first; `server/tests/scheduled-tasks-scheduler.test.js` imports `taskRunner.js` and is the one file rewritten against the executor; the other 16 files stay untouched, and any further change is listed in the PR with its reason.
  - The switch-over test passes on task and run documents written by v5.7.2 (synthetic fixture, no customer data).
  - `taskRunner.js` and the task lease code are gone.
  - A scheduled run killed mid-run is not started again: the counter stays at 1 and the run ends failed and interrupted (nightly).
  - v5.7.2 fixture with an OIDC owner: not paused at the first boot, paused on day 31 (fake clock), resumed after the owner's next authenticated request; the same for a proxy-auth owner.
  - A fixture run in `awaiting_approval` written by v5.7.2 is answered after the upgrade and continues exactly once.
- **Tests.** executor.test.js, admission.test.js, switchOver.test.js; the scheduled-task suite; nightly fault case 'kill during a scheduled run'.
- **Docs and release entry.** docs/scheduled-tasks.md, docs/usage-limits.md, docs/multi-server-deployment.md (one server per contents directory; a second start on the same host is refused, also from a second container; what the check cannot see; `IHUB_FORCE_BOOT`). Release entry: `breaking-changes.md` 'Scheduled Runs of Single-Sign-On Users Pause After 30 Days Without Sign-In' and 'A Second Server on the Same Contents Directory Refuses to Start'.
- **End-to-end check.** `tests/e2e/scheduled-tasks.spec.js` on Chromium: create a task on the stub model, 'Run now', the history shows the run as done.
- **Risk.** A task runs twice or never at the upgrade. Guard: the switch-over rule and its fixture test.

#### PR 23: `chat-jobs-route`

**feat(runs): chat turns as jobs and POST /api/chats/{chatId}/messages**

Issues: #3777, #2712. Size: L. Stacks on: PR 22. Closes: #2712.

- **Scope.** `chatTurnStart.js` stores the user message together with a turn snapshot and submits a job with the recipe `{ source: 'app', appId, chatId, messageId }`; the executor rebuilds the turn through `prepareTurn(recipe)` and `runPreparedTurn`. Turn snapshot: the non-secret inputs a rebuild needs and that `settleUserTurn` (`chatMaterializer.js:365-420`) does not store today (model id, style, output format, language, client time zone, approval capability, selected integration ids, file ids), written on the user message under the chat lock. Integration tokens are never stored; they are resolved again from the principal at claim. New route `POST /api/chats/{chatId}/messages` (`authorizeChat` write), registered whatever the switch says: `Accept: application/json` answers 202 `{ runId }` with `Location: /api/runs/{runId}`; `Accept: text/event-stream` streams the turn on the response (the transport of #3793) with `runId` on the first frame; a message while a run is active answers 409 `CHAT_BUSY` (modes in the next PR). With `platform.runs.chatJobs` false both routes run the turn as an in-memory job with `resumable: false` and no stored record; with it true a stored chat gets a stored job. Always in memory: temporary, guest and anonymous chats, `/v1`, MCP and A2A inbound, and a turn that started a legacy `workflow_*` tool. `resumable` is also false when the run ledger is off (feature `runLog` off or `platform.runLog.enabled: false`, `RunLog.js:258-262`). The existing `POST /api/apps/:appId/chat/:chatId` keeps its contract (answer at the end or stream; a second message supersedes) and submits the same job. One run per chat is a claim by create with an epoch per chat (section 2.8) and not `chat.activeRunId` under the chat lock: that lock is advisory, and a post that stalled after `lease.isCurrent()` would start a second run. Namespace `chat-run-claims`, key `<chatId>__<seq>` (zero-padded), written with the chat owner's id: `{ v, chatId, seq, runId, workerId, origin, inMemory?, at, ended? }`, without message text. A post draws its runId, lists the prefix and reads the highest claim n. When n is not ended the chat is busy (409 `CHAT_BUSY`; modes in the next PR). Otherwise the post creates `<chatId>__<n+1>` create-only and lists again: `EtagMismatchError`, or a higher seq in the second listing (the post then removes its document), is `CHAT_BUSY`, and such a post stores no message and submits no job. Only the creator of the highest claim stores the user message, passes admission and creates the job head under the claimed runId; nobody acts under a claim that another process created. When a claim is ended: (a) a job head exists under its runId: when that job is final; the settle adds the mark `ended` (a plain write that only adds the mark) and a reader that finds the job final adds it too. (b) No head exists (an in-memory job, a refused admission, a stop before the head was created): the creating process writes `ended` itself, at the settle of an in-memory job or when admission refuses, and another worker writes it only on the ground `exited` for the claim's `workerId` (section 2.8), never for its age; this is safe because only the creator could have created that head. A post that is alive and stalled between its claim and its job keeps the chat busy until it continues. The creator of seq n+1 deletes the claims below n, so a chat keeps two small documents; that reopens their keys, which the second listing covers, as in the admission chain of PR 22. Every run that starts a turn in a stored chat takes this claim before anything else, whatever its origin: a post on either route, the leftover of PR 10, and later the turns started by an event (PR 38, 40, 42, 55, 56), which name the runId derived from their event. The old route's supersede aborts the running turn, waits until its claim is ended and then claims like a post; when another post took the seq first, or the turn does not end within the time the route waits for the abort, it answers `CHAT_BUSY`. A chat without a stored document (a temporary chat) lives in one process and keeps the in-process check. `chat.activeRunId` stays as a derived field for lists and the client, written with the user message and cleared at settle under the chat lock; no decision reads it. `chatRecovery.isChatRunAlive` and `chatRetention.js:55` read the highest claim and, when one exists, the job record. Deleting a chat (by its owner, by chat retention or by user deletion) deletes the chat document first and then its claims, and a post reads the chat again after its create and removes a claim whose chat is gone; the namespace gets its row in the erasure table of PR 20 and in `docs/pii-data-handling.md`. Switch rules: `chatOnRunService: false` resolves `chatJobs` to false and logs it, so the kill switch always lands on the tested v5.7.2 path; a boot warning names `chatJobs` on with the run ledger off.
- **Out of scope.** `onBusy` modes, list fields and the client switch (next PR); resume after a restart; the default flip.
- **Files.** server/services/chat/chatTurnStart.js, chatRunClaim.js, chatMaterializer.js, chatRecovery.js, chatRetention.js; server/storage/namespaces.js; server/services/userDeletion.js; server/tests/namespaceErasure.table.js; server/routes/chats.js (messages route), sessionRoutes.js; server/services/run/jobs/recipes.js; server/validators/platformConfigSchema.js; shared/apiErrors.js; server/tests/routeInventory.table.js
- **Flags.** `platform.runs.chatJobs` (false in this PR)
- **Migrations.** none
- **Behaviour change.** A new additive route. With the switch off turns behave as before; with it on a turn outlives its request.
- **Acceptance.**
  - With `e2e-hang` the JSON POST on the new route answers 202 with `Location` in under 1 s, with the switch off and on.
  - Rebuild test: `prepareTurn(recipe)` in a second process produces the same model request as the first start for a turn with an upload, an integration scope, a style and a non-default language (asserted on the stub's `/__requests`).
  - No token, key or message text is in the snapshot or in the job record (property test).
  - Concurrent posts to one chat never produce two runs: of 20 posts sent at the same moment through two forked workers one gets its run and 19 answer `CHAT_BUSY`, and one claim and one job exist; `CHAT_BUSY` and `RUN_QUEUE_FULL` are returned as problem+json.
  - A post paused after its listing (`stalledWriter`, 20 s, longer than the lifetime of the chat lock) while a second post starts a run answers `CHAT_BUSY` when it resumes, stores no message and submits no job; the same when the second run ended and a third began in the pause. With the pause so long that its key was pruned, its create succeeds, the second listing shows a higher seq, and it removes its document and answers `CHAT_BUSY` all the same.
  - A post killed between its claim and its job: the next post ends that claim on the ground `exited` and gets its run. With that process paused instead of killed, the next post answers `CHAT_BUSY` whatever the age of the claim, and the paused post gets its run when it continues. A refused admission (`RUN_QUEUE_FULL`) leaves the claim ended, and the next post is admitted.
  - Deleting a chat leaves no document under its prefix in `chat-run-claims`; the cleanup coverage test lists the store.
  - With the switch off every golden is unchanged; another user re-attaching with the run id gets 403; an anonymous user creates no stored job.
  - Booting with only `chatOnRunService: false` gives the v5.7.2 chat path and logs that `chatJobs` is off; with the run ledger off a job is not resumable and the boot log says so.
  - Time to first token: the back-to-back comparison of PR 17 stays within 10 %.
- **Tests.** chat-messages-route.test.js; chat run claim tests (two workers, stalled writer, killed creator); turn snapshot and rebuild tests; switch-resolution test; response-shapes contract; route inventory rows.
- **Docs and release entry.** docs/chat-persistence.md, docs/streaming-events.md, docs/platform.md (switch rules), docs/pii-data-handling.md (row for the run claims of a chat), `@swagger`. Release entry: none while the switch is off; the entry is written by PR `chat-jobs-default-on`.
- **End-to-end check.** Agents contents with the switch on: `curl -X POST .../api/chats/$CID/messages -H 'accept: application/json'` with `e2e-hang:k` answers 202 at once; `GET /api/runs/{id}` answers; a second POST answers 409 `CHAT_BUSY`; release, the chat holds one answer. The first call answers 202 with the switch off too.
- **Risk.** The rebuilt turn differs from the first start. Guard: the snapshot on the message and the rebuild test on the stub's request log.

#### PR 24: `chat-jobs-busy-client`

**feat(chat): busy modes, run state in lists, and the web client on the messages route**

Issues: #3777, #3191. Size: M. Stacks on: PR 23.

- **Scope.** Body option `onBusy: 'steer' | 'queue' | 'supersede'` on `POST /api/chats/{chatId}/messages`: `steer` hands the text to the running turn (contract of PR 10), `queue` stores it as send-afterwards, `supersede` aborts the running turn as the old route does; without the option a busy chat answers 409 `CHAT_BUSY`. The modes act on the chat's run claim (PR 23): `steer` and `queue` start no run and take no claim, and `supersede` is the abort, wait and claim of PR 23, so two superseding posts leave one new run. New frame `run/queued`. `GET /api/runs/{runId}` gains `state, attempt, parentRunId, needs[], endReason`. The chat list gains `activeRun { runId, state }`, read from the highest run claim and its job record. The web client (`useAppChat.js`) sends through the new route when the server advertises it; the Office add-in and the browser extension stay on the old route.
- **Out of scope.** Resume; the Activity page.
- **Files.** server/routes/chats.js, runs.js; server/services/chat/chatTurnStart.js; client/src/features/chat/hooks/useAppChat.js; client/src/api/endpoints/apps.js; shared/run/runReducer.js
- **Flags.** `platform.runs.chatJobs` (unchanged, false)
- **Migrations.** none
- **Behaviour change.** The web client sends through the new route; what the user sees is unchanged.
- **Acceptance.**
  - Each `onBusy` mode does what it names against a hung turn; without the option the answer is 409. Two `supersede` posts sent at the same moment against a hung turn leave one new run, and the other answers `CHAT_BUSY`.
  - The long-turn spec is green for `chatPostStream` off and on times `chatJobs` off and on (four overlays, tagged `@matrix`).
  - `GET /api/runs/{runId}` and the chat list carry the new fields; the response-shapes check passes.
  - The Office add-in and the extension still send through the old route (unit tests of their callers).
- **Tests.** Route tests for the modes; client unit tests; the e2e matrix; response-shapes contract.
- **Docs and release entry.** docs/chat-persistence.md, docs/streaming-events.md (`run/queued`), `@swagger`. Release entry: none; covered by PR `chat-jobs-default-on`.
- **End-to-end check.** `npm run test:e2e:agents -- long-turn.spec.js steer.spec.js` on the four overlays; curl: a POST with `onBusy: 'queue'` to a hung chat answers 202 and the chat shows the pending item.
- **Risk.** Two send paths in the client drift apart. Guard: one send function with the route chosen in one place; the matrix.

#### PR 25: `durable-flush`

**feat(runs): flush the ledger before a write and use one resume shape in the loop**

Issues: #3777. Size: M. Stacks on: PR 24.

- **Scope.** `server/services/loop/RunLog.js` gets a per-run synchronous flush (today `flush()` flushes the whole store). `AgentLoop` flushes before it runs a tool that is not trusted read-only, passes `runId:callId` to tools as an idempotency key, and persists 'approval consumed'. `killPoint()` calls are added at: mid model stream, after tool start, after result stored, approval pause (documented in `KILLPOINTS.md`); the point 'parent waiting on a child' is added by the PRs that create its call sites (PR 26 for an app called as a tool, PR 34 for `delegate`). The cases 'write in flight' and 'mid model stream' are tagged `smoke` and run in the pull request job `faults-smoke` from here on. The two resume shapes of `AgentLoop` (`:245-249`, `:522-534`) become `resume: { messages, pendingCalls[{ call, disposition, result? }] }`; approval continuation and connect resume use it. A pending approval and a pending connect stored by v5.7.2 in the old shape are still continued: the reader accepts both stored shapes and writes the new one.
- **Out of scope.** Reading the journal at boot (next PR).
- **Files.** server/services/loop/RunLog.js, AgentLoop.js, runLedgerStore.js; server/services/run/hosts/ChatHost.js; server/tests/faults/KILLPOINTS.md
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** none visible
- **Acceptance.**
  - The goldens for approval pause and continue and for connect resume are equal.
  - The ledger holds the call before a write tool executes (unit test and a fault case killed at 'after tool start').
  - The kill point inventory test passes.
  - Continuation works from a chat with a pending approval and from one with a pending connect that v5.7.2 wrote (fixture `contents-5.7-tasks`).
- **Tests.** Loop tests for the resume shape; RunLog per-run flush test; one fault case.
- **Docs and release entry.** docs/run-ledger.md: the flush rule. Release entry: none.
- **End-to-end check.** Agents suite spec with an approval-required tool through `e2e-tool`: approve, the turn continues and ends.
- **Risk.** The flush slows tool-heavy turns. Guard: only before non-read-only tools; load smoke.

#### PR 26: `resume-after-restart`

**feat(runs): pick up and resume jobs after a restart**

Issues: #3777, #3782. Size: L. Stacks on: PR 25.

- **Scope.** `server/services/run/jobs/resume.js`: rebuild the transcript from the journal, re-hydrate file references (`ledgerMessages.js` stores references, not content) and verify `messagesHash`; on a mismatch the run is settled as interrupted with a reason. Dispositions: result recorded, reuse it; trusted read-only without result, run again; not read-only without result, stop (rendered by the next PR); an app called as a tool (`app__<id>`, an in-process child run since PR 15) without result: called again when every tool of the app is trusted read-only, otherwise treated as a write without result; the kill point 'parent waiting on a child' gets this call site (`delegate` re-attaches from PR 34 on). Boot pickup: a job older than lease plus grace is settled, unless it is resumable and younger than `resumeMaxAgeMinutes`, so a restored backup starts nothing; an older `formatVersion` ends as interrupted with a readable reason; more than `maxAttempts` pickups ends as failed with `PICKUP_LIMIT`. A partly streamed assistant text is discarded; `run/resumed { attempt, reason }` tells the client to replace it; the chat shows one resume marker; the evidence record notes attempt and reason. A resumed job passes admission and the user's usage limit again. `chatRecovery.js` shrinks to non-resumable runs and exhausted attempts and is changed together with `chatRetention.js`, so exactly one module settles a run. Journals are deleted after the result is stored, never while a job awaits resume. Client: `runReducer` handles `run/resumed`; the text `chat.runInterrupted` is corrected in en and de. From this PR on, SIGTERM puts the jobs a worker holds back to `queued` with the attempt kept (the holder writes `released` into its own epoch document, in the shutdown order of PR 22: only after the loop of that job has returned, as its last act for the job; a job whose loop has not returned when the grace ends is not released, its epoch stays `running` and it is picked up after the process exit on the ground `exited`; the owner scope is that of PR 22) and a resumable job found at boot is picked up by a claim of the next epoch with the reason `pickup` (PR 21); until now such a job was settled as failed. Pickup follows the owner rule of PR 22 and section 2.8: a `released` epoch is picked up by any worker at once, and an epoch still `running` under another `workerId` is picked up only after the confirmed end of that process (the ground `exited`): at boot for an epoch of an earlier start, which with one worker is every such epoch, and with several workers at the next sweep after the primary reported the worker's exit. A killed worker's resumable job therefore continues on another worker promptly and needs no fencing, because a process that ended performs nothing more; the jobs PR 22 settled as failed in these two cases are picked up from this PR on when they are resumable. Only a holder that is alive and silent waits: its job stays `running` and is neither settled nor picked up until PR 28, whose fencing makes it safe to continue such a job. `deliverResumedWorkflows` (`chatRecovery.js:489`) is kept unchanged: it serves the legacy workflow path.
- **Out of scope.** The unknown-outcome card; takeover between live workers.
- **Files.** server/services/run/jobs/resume.js, RunExecutor.js; server/services/chat/chatRecovery.js, chatRetention.js; shared/run/runReducer.js; shared/i18n
- **Flags.** applies to every job; chat turns are jobs only with `chatJobs` on
- **Migrations.** none
- **Behaviour change.** A scheduled run interrupted by a restart continues instead of failing.
- **Acceptance.**
  - Nightly kill rows pass: mid model stream (call repeated, text not stored twice), result stored (no re-run), approval or question pause (still pending), SIGTERM, and parent waiting on an app child (exactly one result in the parent's transcript).
  - Resume works with an upload and a picture; a deleted file ends the run as interrupted.
  - A retention sweep during resume does not delete the chat; no chat shows 'interrupted' and then an answer.
  - A job is picked up at most `maxAttempts` times; a job from a restored backup does not start; an older format ends as interrupted.
  - Release order with two workers: worker A gets SIGTERM while a write tool of its resumable job is in flight (counter tool, held); `released` is written only after A's loop returned, B picks the job up afterwards, finds the flushed call without a result and ends as `needs attention` without calling the tool again; the write counter reads at most 1. With the abort blocked until the grace ends, A does not release, and B picks the job up only after the primary reported A's exit.
  - Two workers: a worker that boots while the other one executes a resumable job picks nothing up and the job runs once; SIGTERM to one worker releases only its own jobs. SIGKILL to the worker that holds a resumable job: after the primary reported the exit another worker picks the job up under the next epoch at its next sweep, and it ends as done with attempt 2.
  - A holder paused for longer than `takeoverMs` (`stalledWriter`; SIGSTOP in the fault tier) is not picked up and not settled: no further epoch exists, and when it continues it finishes the job as the only holder, with one answer in the chat.
  - The legacy golden 'resumed after a restart with delivery into the chat' is byte-equal.
- **Tests.** resume.test.js (table with scriptedModel); fault cases; client reducer test.
- **Docs and release entry.** docs/chat-persistence.md, docs/run-ledger.md (one shared status table). Release entry: none here; covered by PR `chat-jobs-default-on`.
- **End-to-end check.** `npm run test:faults -- resume` locally before merge; the agents suite stays green.
- **Risk.** The resumed turn answers from a different transcript. Guard: the hash check ends the run instead.

#### PR 27: `unknown-outcome-run-again`

**feat(runs): needs attention after a write with unknown outcome, and Run again**

Issues: #3777, #3782, #3783. Size: M. Stacks on: PR 26.

- **Scope.** A non-read-only call without a result ends the run as `needs attention` with `needs: [{ kind: 'unknown_outcome', callId, toolId, action }]`; the job record holds ids only, arguments are read from the ledger for the owner and redacted for anyone else. The server sends `{ code, labelKey, params, text (English fallback), inFlight { toolTitle, target, at }, expectedAction, actions[] { id, labelKey, style } }`; the client resolves `t(labelKey, text)`. New `POST /api/runs/{runId}/_run-again` with `{ callId }` (`authorizeRun` intent `rerun`: the chat owner, for a scheduled run its owner): it starts a new run in the same chat, the call gets a new id and passes approval again, and the evidence record links both calls. If the user writes a normal message instead, the model sees a tool result that says the outcome is unknown. Client: `client/src/features/chat/components/NeedsAttentionCard.jsx` renders server fields; 'Leave as is' comes first, 'Run again...' opens a `ConfirmDialog` that names tool, target and time; the same card is on a scheduled run's detail. Strings `needsAttention.*`; a test checks that every reason code the server can send has en and de text.
- **Out of scope.** The Activity page row (PR `activity-page`).
- **Files.** server/services/run/jobs/resume.js; server/routes/runs.js; client/src/features/chat/components/NeedsAttentionCard.jsx; client/src/features/tasks; shared/i18n; tests/e2e-agents/needs-attention.spec.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** A write in flight at a crash is never repeated by the system; the user decides.
- **Acceptance.**
  - Fault row 'write tool started, no result': the counter is 1 and the run names the call; after 'Run again' the counter is 2 and the evidence links both.
  - Only the owner can choose it (an admin gets 403); nothing is repeated without the choice.
  - A stored job document contains neither a password argument nor a bearer token from a URL.
  - The card shows action, target, reason and what the user can do, in en and de; focus starts on 'Leave as is'.
  - `POST /api/runs/{runId}/_run-again` has its row in the route inventory.
- **Tests.** Unit tests, fault cases, needs-attention.spec.js driven by a job seeded through `POST /__seed-job` of the agents helper.
- **Docs and release entry.** New docs/background-runs.md (admin, how-to, in SUMMARY): the unknown-outcome stop and 'Run again'; docs/chat-evidence.md; glossary rows. Release entry: `features.md` 'A Run Stopped During a Write Asks Before Anything Is Repeated'.
- **End-to-end check.** `npm run test:e2e:agents -- needs-attention.spec.js`.
- **Risk.** A user repeats a mail by accident. Guard: 'Run again' is never first and always confirms.

#### PR 28: `worker-takeover`

**feat(runs): takeover across workers on one host with fencing**

Issues: #3777, #3782. Size: L. Stacks on: PR 27.

- **Scope.** Until this PR a worker acts on a job another `workerId` holds as `running` only after the confirmed end of that process (section 2.8, PR 22, PR 26), so a holder that is alive and silent keeps its job and its pool slot. This PR adds the second ground: the sweep takes over a job whose `heartbeatSeq` it has seen unchanged for `takeoverMs` (3 minutes) on its own clock, by claiming the next epoch with the reason `takeover` and the ground `silent` (PR 21). A resumable job continues, any other is settled, and one transition moves the pool slot to the new epoch. A standing heartbeat does not prove that the holder ended. Acting on it is safe only through the fencing of this PR, which stops a holder that continues after the takeover at its next chokepoint, and this PR is therefore the first that takes a job from a worker that is alive. `fencing.js` `assertHolder(runId, epoch)` lists `run-claims` for the run and passes only when `epoch` is the highest one; it guards four chokepoints: the start of work (before every model call of the loop and before every step of an engine execution, so a fenced holder starts nothing on a pool slot that went to the new holder), the chat lock sections `settleUserTurn` and `materializeAssistantTurn`, the durable flush before a non-read-only tool, and job transitions; a holder that fails aborts with `abortCause('lease_lost')` and writes nothing more outside its own epoch document. The order at a non-read-only tool is fixed: the call is flushed to the ledger with its epoch, then `assertHolder`, then the tool runs. Every ledger and journal record names its epoch; the first record of a new holder is `run/resumed` with its epoch, and resume ignores a record of a lower epoch that follows it (the evidence record lists it as late). The two chat sections write messages under ids derived from the runId, so a second materialisation replaces a message and never adds one. Which answer that message holds is decided by a claim by create, because a holder paused after `assertHolder` could otherwise write its answer over the one the new holder stored. The holder that has the final answer flushes it to the ledger with its epoch, passes `assertHolder` and creates `<runId>__answer` in `run-claims` create-only (not an epoch, like the stop marker of PR 21) with `{ epoch, recordId }` and no text: it names the flushed record that is the answer of the run. `EtagMismatchError` means that the answer is decided, and the loser reads the document. `materializeAssistantTurn` takes no content from its caller: it reads the answer claim and writes the content of the claimed record under the message id. The creator, a later holder that completes the materialisation after a restart or a takeover, and a stale holder that resumes therefore all write the same content; every write is idempotent and a late one changes nothing. Because the answer is flushed before the check, a new holder finds it in the journal it resumes from and has nothing left to ask the model: it creates the claim for that record or loses the create to the old holder, and both name the same record. A holder whose flush came after the takeover fails `assertHolder` and creates nothing. `settleUserTurn` writes the message and the snapshot of the recipe, which are the same for every holder. An in-memory job has one holder and no answer claim; the claim is deleted with the job's other documents in `run-claims`, after the head. What the check cannot exclude (section 2.8): a holder that stalls for longer than `takeoverMs` between `assertHolder` and the tool call performs the write after the takeover. The system still performs it once: the new holder finds the flushed call without a result, ends as `needs attention` with `unknown_outcome` (PR 27) and repeats nothing; only the user's 'Run again' can, and the card says that the outcome is unknown. A holder that stalled before the flush fails `assertHolder` when it continues. A stale holder starts no further model call and no step, because each start is a chokepoint. It can still finish the model call or the read-only call that was under way, or just cleared, when it stalled; that costs tokens and changes nothing, and effects are covered by rule 4 of section 2.8. Stop sets `cancelRequested` and reaches the owning worker over the bus, so a run ends within one step on any worker. A job without a heartbeat is reported as `stalled`. Metrics `runs_stuck` and `runs_queued_seconds`. The text of `abortCauses.lease_lost` is reworded without 'lease' and 'worker'. What the pool limit bounds across a takeover: the pool record bounds holders, one epoch per slot, at every moment and by storage. It does not bound model calls in flight, because `assertHolder` before a model call is a check followed by an act: a holder that passed it and stalled can send its call after the takeover, next to the new holder's call. That overlap is at most one model call per superseded holder, so one per takeover and not one per job: when a job is taken over twice while both earlier holders are stalled, each of them can still send one call (every superseded holder fails `assertHolder` before its next call, step or tool), it produces no effect (its result is written only into its own epoch document and is ignored by resume, and a write tool is covered by rule 4 of section 2.8), and it costs tokens and one extra request at the model endpoint. A hard bound on calls in flight would need the model endpoint itself to check the epoch, which no provider offers; the overlap is counted in telemetry (`run.takeover.stale_call`).
- **Out of scope.** Several hosts or pods; NFS or S3-style storage.
- **Files.** server/services/run/jobs/RunExecutor.js, fencing.js, lease.js; server/services/chat (the two lock sections); telemetry; shared/i18n
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** A job whose worker stopped responding without ending is continued by another worker after 3 minutes (a job whose worker ended is continued since PR 26).
- **Acceptance.**
  - A holder frozen with SIGSTOP past the takeover time and continued fails `assertHolder` at its next chokepoint: the write counter shows only what the new holder did, and a further resume ignores the late ledger records (nightly, and run locally before merge).
  - Stall between check and effect (a pause injected after `assertHolder` and before the tool call, longer than `takeoverMs` on the fake clock): the new holder ends as `needs attention` with `unknown_outcome` and calls no tool; the old holder's write lands once; the counter is 1.
  - Stall before the flush (the model returned a write call, the pause comes before the ledger write): the new holder asks the model again and runs its call; the old holder flushes, fails `assertHolder` and aborts; the counter is 1.
  - Answer claim: the old holder is paused after `assertHolder` and before it materialises (`stalledWriter`, longer than `takeoverMs`), the new holder materialises first, the old holder resumes. The chat holds one assistant message, its content is byte-equal before and after the late write, and it is the record `<runId>__answer` names. With the pause before the create of the answer claim, the new holder creates it, the old holder's create fails with `EtagMismatchError` and the old holder writes the claimed content.
  - The pause of PR 22 and PR 26, now with takeover: worker A is paused after its post-claim checks and before it starts model work for longer than `takeoverMs`, and the pool has one slot. Worker B takes the job over and the slot names B's epoch. A continues, fails `assertHolder` at the start of work, makes no model call, starts no step, calls no tool and writes only into its own epoch document. The pool never counts more running jobs than slots, and the job ends once, as B's epoch says (`stalledWriter`; SIGSTOP in the fault tier).
  - Stall between check and model call (a pause injected after `assertHolder` and before the model request, longer than `takeoverMs`): after the takeover both holders have a model call in flight, the pool record still names one epoch per slot, the old holder fails `assertHolder` before anything further and writes only into its own epoch document, no tool runs twice, the job ends once as the new epoch says, and `run.takeover.stale_call` counts 1. With two takeovers in a row, each earlier holder paused between `assertHolder` and its model request, the counter reads 2, the pool record names the third epoch only, and neither earlier holder does anything further.
  - Two workers race 200 jobs without a double run; clock skew of 30 s either way changes nothing (fake clock).
  - After SIGTERM another worker continues within 5 s.
  - Load scenario `agentic`: no lease loss under ingestion; the takeover time is at least ten times the worst measured stall (numbers in the PR).
- **Tests.** Fake-clock lease tests; the stall cases with `stalledWriter`, the answer claim among them; fault cases for SIGSTOP, SIGTERM and the two-worker race.
- **Docs and release entry.** docs/scaling.md, docs/multi-server-deployment.md (supported: several workers on one host), docs/telemetry.md, docs/background-runs.md. Release entry: none of its own.
- **End-to-end check.** `npm run test:faults -- takeover`; manual: stack with `WORKERS=2`, hang a turn, `kill -TERM` one worker, release, the answer completes.
- **Risk.** Healthy runs are aborted after an event-loop stall. Guard: the measured margin and the observed-sequence rule.

#### PR 29: `admin-runs-api`

**feat(admin): admin runs API with audited stop, pause and drain**

Issues: #3782, #3785. Size: M. Stacks on: PR 28.

- **Scope.** `server/routes/admin/runs.js`: `GET /api/admin/runs` (`{ items, nextCursor }`; filters kind, user, state, needsAttention, from, to; metadata only), `POST /api/admin/runs/{runId}/_cancel` (audited with admin, run and principal; cancels the tree), `POST /api/admin/runs/_pause-unattended { drainMinutes }` and `/_resume` (the state is stored and survives a restart; the pause also holds legacy workflow triggers at `TriggerManager`). The existing admin list on `GET /api/runs` (`server/routes/runs.js:121-131`, `adminAuth`, body `{ items, persisted }`) leaves that path: its filters move to `/api/admin/runs`, and `/api/runs` answers 404 until PR 31 gives it to the signed-in user as their own list. The owner's stop stays `POST /api/runs/{runId}/human-events` with `kind: 'stop'`; the admin bypass on that route is removed, because the audited route exists now. Route inventory rows for the new routes.
- **Out of scope.** The admin page (next PR); the user's Activity page; listing legacy workflow runs.
- **Files.** server/routes/admin/runs.js; server/routes/runs.js; server/services/loop/runAccess.js; server/services/workflow/triggers/TriggerManager.js; server/services/run/jobs/admission.js; server/tests/routeInventory.table.js
- **Flags.** none
- **Migrations.** none
- **Behaviour change.** Admins stop runs through an audited route. The admin run list moves from `GET /api/runs` to `GET /api/admin/runs` with the list shape `{ items, nextCursor }`.
- **Acceptance.**
  - The list returns every job with state, worker, claim age, attempts, principal, model and last activity, and no message text or argument.
  - An admin stop is in the audit log with admin, run and principal; an admin stop through human-events answers 403.
  - With unattended runs paused no new one starts, chat still works, the pause survives a restart, a legacy trigger is held, and resume starts the held runs.
  - `scripts/check-route-changes.js --strict` passes with the breaking entry for `GET /api/runs`.
- **Tests.** Route tests; pause and drain tests with a restart; route inventory; audit test.
- **Docs and release entry.** docs/background-runs.md (stop, pause, drain, 'Upgrading'), docs/telemetry.md, `@swagger`. Release entry: `breaking-changes.md` 'The Admin Run List Moves to /api/admin/runs'.
- **End-to-end check.** curl as admin on the agents stack: a hung turn of `e2e-user` is in `GET /api/admin/runs`; `POST .../_cancel` ends it and the audit API shows the entry; after `POST /api/admin/runs/_pause-unattended` a 'Run now' of a scheduled task stays queued until `/_resume`; `GET /api/runs` answers 404.
- **Risk.** The pause is forgotten after an upgrade and nothing unattended runs. Guard: the paused state is in the list response and in the boot log, and the page of the next PR shows it as a card.

#### PR 30: `admin-runs-page`

**feat(admin): Runs page**

Issues: #3782. Size: L. Stacks on: PR 29.

- **Scope.** `client/src/features/admin/pages/AdminRunsPage.jsx` on the DataTable kit (User, Chat or task, Kind, State, Started, Elapsed, Last activity, Actions), `RunDetailDrawer` (Picked up by, Reserved until, Times started, Runs as, Model), `UnattendedPauseCard`, filters in the query string, `ConfirmDialog` for stop and pause, a link to the Workflow Executions page labelled legacy. The run table leaves `AdminScheduledTasksPage` (a link remains). Route in `App.jsx`, `CLEAN_PAGES`, command palette, strings `admin.runs.*` in en and de. The page reads only the API of PR 29.
- **Out of scope.** The API; listing legacy workflow runs.
- **Files.** client/src/features/admin/pages/AdminRunsPage.jsx and components/runs/**; AdminScheduledTasksPage.jsx; client/src/App.jsx; tests/e2e/accessibility.spec.js; shared/i18n
- **Flags.** none (admin page)
- **Migrations.** none
- **Behaviour change.** A new admin page 'Runs'; the run table on the scheduled-tasks admin page becomes a link.
- **Acceptance.**
  - The page lists every job with state, attempts, principal, model and last activity; the drawer shows the claim fields in plain words.
  - Stop and pause ask for confirmation and work by keyboard; the paused state shows as a card after a reload.
  - The page passes axe in light and dark, is in `CLEAN_PAGES`, and loads by direct URL at the root and under a subpath.
  - No string contains 'job', 'lease' or 'worker' (wording lint).
- **Tests.** Client unit tests; a11y spec; tests/e2e-agents/admin-runs.spec.js.
- **Docs and release entry.** docs/background-runs.md (`adminPage: /admin/runs`), docs/admin-ui.md. Release entry: `features.md` 'Admin: One Page for All Running Work, with Pause Before an Upgrade'.
- **End-to-end check.** admin-runs.spec.js: a hung turn of `e2e-user` appears as a row; the admin stops it with the confirmation; with the pause on, 'Run now' of a scheduled task is held until resume.
- **Risk.** Developer words reach the page. Guard: the wording lint covers `admin.runs.*`.

#### PR 31: `activity-page`

**feat(ui): Activity page with Needs you and Running**

Issues: #3782. Size: M. Stacks on: PR 30.

- **Scope.** `GET /api/runs` becomes the signed-in user's own list (no `mine` parameter and no way to ask for another user's runs; the admin list is `/api/admin/runs`; the server filters by principal; `{ items, nextCursor }`; a row carries kind and `kindLabelKey`, title, chatId, state, runsAs, startedAt, lastActivityAt, the reason fields, `actions[]`, `childCount`). `client/src/features/activity/` with `ActivityPage.jsx`, `ActivityRow.jsx`, `useMyActivity.js`: sections 'Needs you' (pending interactions and needs-attention runs) and 'Running', each an `<h2>` with a count. A row links to the card in its chat; the page never answers an approval. Stop button with a `ConfirmDialog` only when the server reports children. A stalled row offers Retry and Stop. Polling: 10 s on the page, 60 s for the badge, paused while the tab is hidden. Sidebar entry 'Activity' / 'Aktivität' (icon `inbox`) in the rail and the expanded navigation; the badge counts 'Needs you' only, a spinner glyph shows running work. Route `activity` in `client/src/App.jsx`, `KNOWN_ROUTES` (`client/src/utils/runtimeBasePath.js`) and the inline list in `client/index.html`. Hidden for anonymous users and in embeds.
- **Out of scope.** The 'Scheduled' section and sub-agent rows (slices C and D).
- **Files.** server/routes/runs.js; client/src/features/activity/**; client/src/shared/components/AppSidebar.jsx; client/src/App.jsx; client/src/utils/runtimeBasePath.js; client/index.html; server/featureRegistry.js; shared/i18n
- **Flags.** `activity` (preview, off)
- **Migrations.** none
- **Behaviour change.** With the flag on, a new sidebar entry and page.
- **Acceptance.**
  - The page lists the user's running and waiting runs across chats and scheduled work with a count; a second user sees none of them.
  - Every needs-attention row states its reason and the action the user can take.
  - Stop works by keyboard; a run without a heartbeat shows as stalled within one poll.
  - `/activity` and `/ihub/activity` load cold; the page passes axe and fits 320 px in German.
  - `GET /api/runs` as user B never returns a run of user A, whatever query parameters are sent (route inventory row).
- **Tests.** Route test; client unit tests; known-routes-sync; a11y; tests/e2e-agents/activity.spec.js and the subpath config.
- **Docs and release entry.** docs/user-guide.md 'Activity'; glossary rows. Release entry: `features.md` 'Activity: See What Is Running and What Needs You (Preview)'.
- **End-to-end check.** activity.spec.js: hang a turn in one chat, open `/activity`, the row is under 'Running'; stop it from the page; a seeded needs-attention row links to the card.
- **Risk.** The badge always shows a number and is ignored. Guard: it counts 'Needs you' only.

#### PR 32: `chat-jobs-default-on`

**feat(chat): answers continue after a server restart by default**

Issues: #3777. Size: S. Stacks on: PR 31.

- **Scope.** Flip the default of `platform.runs.chatJobs` to true. Entry condition, recorded in the PR body: three consecutive green runs of the fault tier on the head of PR 31 (label `run-faults`, on three different days or commits, run URLs in the body) with every kill-table row of #3777, the back-to-back time-to-first-token comparison, and the long-turn spec green on all four transport combinations. Complete `docs/background-runs.md`: what continues and what does not (legacy workflows, guest and temporary chats, `/v1`, MCP and A2A callers do not), limits with keys, storage requirements, troubleshooting, and one 'Upgrading' procedure (pause, drain, upgrade, resume) that every breaking entry links to. Rollback is one step, `platform.runs.chatJobs: false`; the kill switch `chatOnRunService: false` implies it. As the last pull request of the slice it carries the re-check of the admin surfaces of slice B (`RunLimitsCard`, the Runs page) against the state of the admin rework (#3739, #3742), with the result noted in #3782.
- **Out of scope.** Switching the `activity` flag on by default.
- **Files.** server/validators/platformConfigSchema.js; docs/background-runs.md; docs/releases/next/features.md
- **Flags.** `platform.runs.chatJobs` default becomes true; an admin-set value is kept
- **Migrations.** none
- **Behaviour change.** A chat answer in a stored chat continues after a server restart.
- **Acceptance.**
  - On a fresh install, `kill -9` of the server in the middle of a slow turn and a restart give one complete answer with one resume marker and no 'interrupted'.
  - With the switch set to false the behaviour equals v5.7.2.
  - The docs state the supported topology and the supported switch combinations.
  - Booting with only `chatOnRunService: false` gives the v5.7.2 chat path with the new default too.
- **Tests.** Fault case 'chat resume' in the nightly tier; the e2e matrix.
- **Docs and release entry.** docs/background-runs.md, docs/chat-persistence.md. Release entry: `features.md` 'Answers Continue After a Server Restart'.
- **End-to-end check.** `npm run test:faults -- chat-resume`; manual: hang a turn on the stack, kill the server process, restart it on the same contents, release, the answer completes.
- **Risk.** The flip ships on thin evidence. Guard: the entry condition is part of the PR.

### Slice C: blocking sub-agents

#### PR 33: `sub-agents-flag-hidden-chats`

**feat(config): subAgents flag, delegation setting and hidden sub-agent chats**

Issues: #3780, #3787, #3196. Size: M. Stacks on: PR 32.

- **Scope.** `server/featureRegistry.js`: add `subAgents` with EN and DE texts, remove `appAsTool`. V261: in `features.json` remove `agentFactory` and `appAsTool`; where `appAsTool` was `true` set `subAgents: true` if absent; idempotent. `appConfigSchema.js`: `delegation: 'off' | 'normal' | 'extensive'` (default `normal`), mapped to the number of parallel sub-agents and the budget in `platform.runs.subAgents`; `AppFormEditor.jsx` shows the field. The non-frozen readers of the old flag switch to `subAgents` (`inference/modelIdentifier.js:107`, `tools/appTools.js:314`, `chat/RequestBuilder.js:363`, `appToolsGateway.js:255`, `scripts/check-response-shapes.js:320`, `StepDetails.jsx:113`). The frozen `PromptNodeExecutor.js:571` still names `appAsTool`, but that line sits behind an Agent Factory principal and is unreachable since PR 13; no alias is built. After V261 the flag `subAgents` governs every place that offers an app as a tool, the tool list of the MCP gateway included. Hidden chats: chat field `kind: 'delegate'` with `parentChatId`; one predicate `isListableChat` used by every listing call site (lists, search, export, admin statistics, the `maxChatsPerUser` count, eviction); a hidden chat is deleted with its parent and by user deletion.
- **Out of scope.** The `delegate` tool.
- **Files.** server/featureRegistry.js; server/migrations/V261__sub_agents_flag.js; server/validators/appConfigSchema.js; the listed flag readers; server/services/chat (listing call sites); client AppFormEditor.jsx
- **Flags.** adds `subAgents` (preview, off); removes `appAsTool`
- **Migrations.** V261 `sub_agents_flag`
- **Behaviour change.** The `appAsTool` flag is renamed; an admin-set `true` is carried over.
- **Acceptance.**
  - The migration passes when run twice and on a hand-edited file; no admin value is overwritten.
  - After an upgrade with untouched config no `delegate` and no `app__` tool is offered to a model (asserted on the stub's `/__requests`).
  - A test enumerates the chat listing call sites and proves each skips hidden chats.
  - A legacy prompt node with an `apps` list registers no app tool with `subAgents` on or off; an MCP client of an installation that had `appAsTool: true` lists the same `app__` tools after V261.
- **Tests.** Migration test; isListableChat call-site test; MCP tool-list test before and after V261.
- **Docs and release entry.** docs/apps.md (delegation setting), docs/platform.md. Release entry: `breaking-changes.md` 'The App-as-Tool Flag Is Replaced by Sub-Agents' (extended by PR `app-as-sub-agent`).
- **End-to-end check.** Boot on contents whose `features.json` has `appAsTool: true`: the admin features API shows `subAgents: true` and no `appAsTool`.
- **Risk.** Hidden chats leak into a list or a count. Guard: one predicate and the call-site test.

#### PR 34: `delegate-blocking`

**feat(runs): delegate tool for blocking sub-agents without an app**

Issues: #3196, #3781, #3785, #3787. Size: L. Stacks on: PR 33.

- **Scope.** `server/services/delegation/delegateTools.js`, `childRun.js`, `report.js`; `server/defaults/tools/delegate.json`; `server/services/run/assemble/fromBrief.js`. `delegate({ task, context, files? })`: the child runs as a job in a hidden chat with the parent's model, a focused system prompt and a fresh context; a restart re-attaches it by `(runId, callId)`: the child's runId is derived from the two and its job head is created create-only, so a second start finds the key taken and attaches (section 2.8). `RunService.spawnChild(parentCtx, ...)`: `toolGrant = parent.toolGrant ∩ requested ∩ trusted read-only`, the same for integrations and sources; the parent's principal and `integrationScopes`; `depth = parent.depth + 1`, depth 2 is refused with `DELEGATION_DEPTH_EXCEEDED` (400) even against a forged tool list. Always denied to a child: non-read-only tools, memory and notes writers, `delegate`, follow-up and notify tools, outbound messaging; a child run refuses steers. The child's budget is subtracted from the parent's. Over `maxPerRun` or `maxConcurrentPerUser` (counted from the entries of the principal's quota record, PR 22, which carry kind and `parentRunId`) the tool returns `DELEGATION_LIMIT_REACHED` as a result the model can read; nothing is queued. Report: an artifact scoped to the parent chat with the headings Findings, Evidence, Open questions, Not done, for every end state (the server writes it from the final answer if the model did not). The tool result is a summary (`maxOutputChars`) plus the artifact reference inside the data frame with origin `child_report`; a tainted child taints the parent. The parent chat holds `delegates[]`; its evidence record links each child's record. `tool/started` carries `activityKind: 'delegate'` and `child { runId, title, state }`. Child tokens are recorded under the parent's user and app with origin `sub-agent`, once. Stopping the parent cancels its children. `files` passed to `delegate` are checked against the parent principal's access at delegation time; a file the parent cannot read is refused with `DELEGATION_FILE_NOT_ALLOWED`. A brief shorter than 40 characters, or equal after normalising case and whitespace to an earlier brief of the same run, is refused with `DELEGATION_BRIEF_REJECTED`; both are results the model can read. Each child runs under the per-sub-agent limits of `platform.runs.subAgents` (`maxToolRounds`, `maxWallClockMinutes`, `maxTokens`, `maxOutputChars`). The kill point 'parent waiting on a child' gets its `delegate` call site and the resume disposition for `delegate` is re-attach by `(runId, callId)`.
- **Out of scope.** `appId`, background mode, child questions (next PRs); writing sub-agents; depth above 1.
- **Files.** server/services/delegation/**; server/defaults/tools/delegate.json; server/services/run/RunService.js, assemble/fromBrief.js; shared/apiErrors.js; server/utils/toolDisplay.js ; server/tests/faults/KILLPOINTS.md; tests/load/scenarios/agentTurn.mjs
- **Flags.** `subAgents`; offered only when the definition's `delegation` is not `off`
- **Migrations.** none
- **Behaviour change.** With the flag on, a run can hand part of its work to read-only sub-agents.
- **Acceptance.**
  - Property test with 200 seeded cases: the child's tools, integrations and scopes are always a subset of the parent's; one named test per kind.
  - Depth 2 is refused by the service; a delegation over the limit returns a readable refusal and the parent turn continues.
  - A report that contains the steer marker or 'ignore previous instructions' produces no `role: 'user'` message in the parent.
  - A report exists for a failed and for a stopped child and is complete when the summary was cut.
  - With `delegation: 'off'` the tool is not offered; usage shows a parent total and each child, counted once.
  - A file the parent cannot read is refused at delegation (row in the authz suite); a brief that is too short or repeated is refused with a readable code.
  - A child that passes its tool-round, wall-clock or token limit ends with a report that says so; the summary is cut at `maxOutputChars`, the report is not.
  - Nightly: a restart with a blocking sub-agent re-attaches it and starts no second one; the parent gets exactly one result.
  - Load (nightly, stub): the profile `agentic` with three sub-agents per turn and 100 users holds the caps; the numbers are in the PR body.
- **Tests.** server/tests/delegation/*.test.js; a new resource row in the authz suite for reports; an injection-suite scenario; nightly fault case 'parent waiting on a child'.
- **Docs and release entry.** New docs/sub-agents.md (in SUMMARY, starts with the preview note), docs/tool-approval.md, docs/usage-reporting.md, docs/chat-evidence.md, docs/pii-data-handling.md; the tool description is checked against the glossary. Release entry: none yet; written by PR `sub-agent-ui`. Also docs/sse-v2.md (the `child` field), docs/agent-loop.md and a note per model in docs/models.md.
- **End-to-end check.** Flag on, message `e2e-script:delegate-one`: the SSE stream shows `tool/started` with `activityKind: 'delegate'`, and the chat's artifacts contain the report.
- **Risk.** Token cost doubles unnoticed. Guard: the limit refusal ships in this PR and usage marks sub-agent calls.

#### PR 35: `app-as-sub-agent`

**feat!: an app used as a tool runs as a sub-agent**

Issues: #3196. Size: M. Stacks on: PR 34.

- **Scope.** A call of `app__<appId>` that has a parent run context becomes a child run through `childRun` and `assemble.fromApp`; tool id and input shape stay, so MCP gateway clients see no change. A call without a parent run stays what PR 15 made it: an inbound MCP `tools/call` (`mcp/appInvoker.js`) or an A2A call for an app is a root headless run with the caller's own grant, no hidden chat and the unattended limits. `delegate` accepts `appId`; an app outside the parent's `apps` list is refused with `DELEGATION_APP_NOT_ALLOWED` (403). Grant of an app child: parent ∩ the app's tools ∩ trusted read-only. A write tool of the app is never callable by the child, whatever its approval mode (product owner decision 8 of round 2: no writing sub-agent in the first release). The 180 s wall clock of the old path is removed; the child runs under the sub-agent limits. The app's `delegation` setting and `apps` list govern; the calling user's `apps` permission still limits which apps are reached. The flag `subAgents` governs whether `app__` tools are offered to a model and listed by the MCP gateway. Upgrade check: `server/services/delegation/upgradeCheck.js` lists the apps with an `apps` list whose targets hold tools that the caller lacks or that are not trusted read-only; `GET /api/admin/apps/_sub-agent-check` (`{ items }`) returns the list and the server logs one line per affected app at boot. The difference rows for the removed clock, the narrower rights and the loss of write tools are added to `differences.json` and signed by the product owner's approval.
- **Out of scope.** Background mode.
- **Files.** server/services/chat/appToolsGateway.js; server/services/tools/appTools.js; server/services/delegation/childRun.js; server/tests/golden/differences.json ; server/services/delegation/upgradeCheck.js; server/routes/admin/apps.js (check route)
- **Flags.** `subAgents`
- **Migrations.** none
- **Behaviour change.** An app called as a tool by a model gets only the read-only tools that both the parent and the app allow; its write tools are not available; the 3-minute cut is gone. Inbound MCP and A2A app calls are unchanged.
- **Acceptance.**
  - An app has tool T and the parent lacks T: the child's call to T is refused.
  - An app outside the parent's `apps` list is refused with `DELEGATION_APP_NOT_ALLOWED`.
  - The MCP gateway lists `app__<id>` with the same input schema (contract snapshot).
  - There is no group permission for delegation and no `delegation.allowedApps` key.
  - An app with a write tool called as `app__<id>` cannot call that tool, with the approval mode `never` and with `always`.
  - One test per caller without a parent run: an MCP `tools/call` and an A2A call for an app run as root headless runs with the grant of the caller and create no hidden chat.
  - The upgrade check lists a fixture app that loses a tool and omits one that does not; the route is admin-only.
- **Tests.** Delegation tests for app children; MCP contract snapshot; goldens with signed rows.
- **Docs and release entry.** docs/apps.md ('Apps as Tools' rewritten), docs/mcp-integration.md. Release entry: the breaking entry of PR 33 is extended (narrower rights, no write tools for an app called as a tool, no 180 s cut, and how to read the upgrade check).
- **End-to-end check.** `e2e-tool:app__<id>:{...}` with an allowed app shows the row and the answer; with an app outside the list the answer states the refusal. `curl -b jar .../api/admin/apps/_sub-agent-check` lists the fixture app.
- **Risk.** An existing concierge app loses a tool it relied on. Guard: the upgrade check and the breaking entry.

#### PR 36: `sub-agent-interactions`

**feat(chat): sub-agent questions and approvals appear in the parent chat**

Issues: #3196, #3785. Size: L. Stacks on: PR 35.

- **Scope.** A child raises interactions through `InteractionService` with its own `runId` and `source.surfaceChatId = parentChatId`. The pending approval on the chat document becomes a list (today one object; the code that stores it moved from `ChatService.js:1126-1142` to `server/services/run/hosts/ChatHost.js` in PR 16); `client/src/features/chat/runToMessage.js` and `shared/run/runReducer.js` project a list instead of the last interaction. While a child waits for a person the parent's deadline is suspended and the child holds no slot. Cards carry server-set `childRunId`, title, app, depth and 'Acts as'; text the model wrote (justification, brief) sits in a box labelled 'Written by the sub-agent'. A child cannot ask secret-entry question types. 'Allow for this chat' is not offered on a child's card and a per-chat grant is not passed to children. Client: `InteractionStack.jsx` shows all cards in arrival order with '1 of 3' headings, no 'Approve all'; a strip chip '2 approvals waiting - Show'; an 'already answered' error is treated as success and the state is re-read. Children hold read-only tools only, so a child's approval card can only come from a read tool whose resolved approval mode is `always`; no child card approves a write. A card of an anonymous run is answered only with the matching guest cookie (rule of PR 7).
- **Out of scope.** Parked writes of unattended runs (PR `taint-gate`).
- **Files.** server/services/run/hosts/ChatHost.js; server/services/chat/chatSeams.js; server/services/loop/seams/approvalSeam.js; client/src/features/chat/runToMessage.js, components/InteractionStack.jsx, ApprovalCard.jsx, ClarificationCard.jsx; shared/run/runReducer.js
- **Flags.** `subAgents`
- **Migrations.** none
- **Behaviour change.** A chat can show several question and approval cards at once.
- **Acceptance.**
  - Two sub-agents ask at once: both cards stay visible, each names its sub-agent from server fields, and an answer resumes only that sub-agent.
  - The parent chat has a per-chat grant for a read tool T in mode `always`; a child that calls T is still asked.
  - A child question of type password is refused.
  - A reload shows both cards; a stored chat with one pending approval written by v5.7.2 still opens and can be answered.
- **Tests.** Server and client unit tests; tests/e2e-agents/delegate-ask.spec.js.
- **Docs and release entry.** docs/tool-approval.md, docs/sub-agents.md. Release entry: none of its own.
- **End-to-end check.** `npm run test:e2e:agents -- delegate-ask.spec.js` (script `delegate-ask`).
- **Risk.** A card takes focus while the user types. Guard: the focus policy from PR 11 and its e2e test.

#### PR 37: `sub-agent-ui`

**feat(chat): sub-agent rows, reports and Activity rows**

Issues: #3196, #3782. Size: L. Stacks on: PR 36.

- **Scope.** `GET /api/chats/{chatId}/delegates` (`{ items, nextCursor }`). `ToolActivity.jsx`: an item with `activityKind: 'delegate'` renders `SubAgentRow` (a disclosure whose name is title plus state, `RunStateBadge`, elapsed time; steps are loaded on expand with loading, error and empty rows) under a `SubAgentGroup` headline ('3 sub-agents - 2 done - 1 running'). A finished row links 'Report', which opens the artifact in the workspace pane, and shows the count of open questions; a refusal row uses the server's title. The Stop button is named 'Stop answer and 2 sub-agents' and the confirmation says how many are stopped. The Activity page lists sub-agents under their parent. The client never branches on a tool id. Strings `chat.subAgent.*` in en and de.
- **Out of scope.** Background chips (PR `background-sub-agents`).
- **Files.** server/routes/chats.js; client/src/features/chat/components/ToolActivity.jsx, SubAgentRow.jsx; client/src/features/activity/**; shared/i18n; tests/e2e-agents/delegate.spec.js
- **Flags.** `subAgents`
- **Migrations.** none
- **Behaviour change.** Sub-agents are visible in the chat and on the Activity page.
- **Acceptance.**
  - N sub-tasks run in parallel and the cap holds across chats and workers.
  - Stopping the parent, by the user or an admin, stops its sub-agents and says how many; deleting the parent chat deletes hidden chats, reports and evidence.
  - Rows and the report can be used by keyboard; the surface passes axe and fits 320 px in German.
  - `GET /api/chats/{chatId}/delegates` has its row in the route inventory (another user gets 403).
- **Tests.** Client unit tests; delegate.spec.js; a11y states.
- **Docs and release entry.** docs/sub-agents.md, docs/user-guide.md, docs/concepts.md (row 'sub-agent'), docs/artifacts.md, glossary rows. Release entry: `features.md` 'Chats Delegate Work to Sub-Agents (Preview)'.
- **End-to-end check.** delegate.spec.js with script `delegate-two`: two rows, the headline, the report opens; stopping the parent stops both.
- **Risk.** The client fills a missing server field from a tool id. Guard: review rule and the server fields from PR 34.

### Slice D: follow-ups and background sub-agents

#### PR 38: `chat-event-queue`

**feat(runs): per-chat event queue; queued messages survive a restart**

Issues: #3197, #3191, #3787. Size: L. Stacks on: PR 37. Closes: #3191.

- **Scope.** Namespaces `chat-events` and `chat-event-claims` (key `<chatId>__<sortableId>` in both, owner is the chat owner). `server/services/run/events/EventQueue.js`: record `{ id, chatId, type: followup | steer | delegate.report | trigger | handoff, payload, dueAt?, cancelOn?, by, origin, generation, taint }`, created create-only and never changed, sealed like a job (HKDF info `ihub/run-event/v1`, the origin inside the seal). What becomes of an event is decided once, by claim by create (section 2.8): a claim document under the event's key in `chat-event-claims`, `{ outcome: apply | fire | cancel | drop, runId?, by, at, done? }`, sealed. Apply, fire, cancel and retention all create the same key, so one outcome exists and a cancel that answered 204 is never followed by a fire; the loser reads the outcome. An event without a claim is `pending`; the read model derives `claimed`, `consumed` and `cancelled` from the claim. A claim names the run that consumes the event. The consuming step records the event id in the ledger, and whoever holds that run, also a later epoch after a restart or a takeover, completes a claim whose event id is not in the ledger and skips one that is, so an event is applied once per run however many holders the run had. `done` is set afterwards by a plain write that only adds the mark. A leftover send-afterwards message starts its turn as a post does (PR 23): the worker that ended the run takes the chat's run claim with the runId derived from the event id, then claims the event with that runId, and the job is created create-only (the binding of PR 40); with an in-memory job the two claims decide. When a person's post took the seq first, the leftover stays pending and is taken when that run ends; when the event's claim is lost (the message was cancelled), the worker writes `ended` on its run claim and starts nothing. A leftover left pending in an idle chat by a stop between the two claims is found by the executor's sweep and started the same way. On deletion the event goes first, then its claim. The schema accepts all five types now. `steering.js` moves from the in-memory map to the queue: a steer reaches the owning worker through the queue, survives a restart and a takeover, and `pending[]` is read from the queue. Deleting a chat deletes its events; chat retention cancels pending events before it deletes a chat; user deletion gets the access step `pendingEvents` before chats. API: `GET /api/chats/{chatId}/events?state=pending` (`{ items, nextCursor }`) and `DELETE /api/chats/{chatId}/events/{eventId}` (204, owner only).
- **Out of scope.** Firing due events (PR `follow-ups-server`).
- **Files.** server/storage/namespaces.js; server/services/run/events/EventQueue.js; server/services/loop/steering.js; server/services/chat/chatRetention.js; server/services/userDeletion.js; server/routes/chats.js
- **Flags.** none (the first user is steering, behind `steering`)
- **Migrations.** none
- **Behaviour change.** A queued message or a send-afterwards message is no longer lost on a restart.
- **Acceptance.**
  - A stored steer is applied exactly once after a restart, and when it was sent to a worker that does not run the turn.
  - Cancel against apply with a stalled writer (`stalledWriter`, 20 s between read and create): the canceller pauses while the run applies the steer, the cancel answers 409 `STEER_ALREADY_APPLIED` and the steer is applied once; in the reverse order the cancel answers 204 and the steer is never applied.
  - Two holders of one run (takeover) apply a claimed steer once: the ledger counts one `steer/applied` for the event id.
  - A record whose origin was edited is rejected.
  - The queue accepts the types `steer`, `delegate.report`, `trigger` and `handoff` without a schema change.
  - Retention cancels pending events before it deletes a chat; the cleanup coverage test lists both stores.
  - Both event routes have their rows in the route inventory.
- **Tests.** EventQueue tests (claim, seal, stalled writer); steering tests on the queue; nightly fault case; cleanup tests.
- **Docs and release entry.** docs/agent-loop.md, docs/pii-data-handling.md, docs/user-guide.md (the 'lost on restart' note goes). Release entry: extend the steering entry if it is still in `next/`, else `features.md` 'Queued Messages Survive a Restart'.
- **End-to-end check.** steer.spec.js extended: queue a send-afterwards message, restart the server through the agents-server helper, the chip is still there and the message is sent after the answer.
- **Risk.** A steer is applied twice after takeover. Guard: the claim on the event and the fault case.

#### PR 39: `taint-gate`

**feat(security): hold external writes in unattended runs that read untrusted content**

Issues: #3785, #3782. Size: M. Stacks on: PR 38.

- **Scope.** `server/services/run/seams/taintGate.js`, registered before `approvalSeam`: in a run that is unattended and tainted, a call the table of #3785 marks as forced (mode `never`: an external write or any destructive call; modes `writes` and `always` already ask) is parked before `isGranted` is consulted, so a per-chat grant and a task's `alwaysAllow` do not apply. The parked run waits, holds no slot and appears under 'Needs you' with the reason code `parked_write`; without an answer the existing `APPROVAL_EXPIRED` result applies and the run ends `needs attention`. A run woken by an envelope with origin `child_report`, `handoff` or `webhook` starts tainted. The chat document records `taintedAt` when a tainted run writes into it; every later unattended run in that chat starts tainted. Artifacts and notes written by a tainted run carry `tainted: true` and reading them taints. Wake limits on the envelope: `generation` (parent plus one for every origin other than person, reset by a person's message), `platform.runs.maxGenerations` (3), `maxWakesPerChatPerHour` (10), one budget along the chain; over a cap the chat ends `needs attention`. The legacy workflow tool counts as side effect unknown and data flow external and is parked in a tainted run of the origins this PR covers (followup, child_report, handoff, webhook); a scheduled task that calls a workflow tool is not affected. A parked call is re-authorised when it is approved (the waiting-to-running claim of PR 21): rights removed while it waited lead to a refusal.
- **Out of scope.** The consent that lifts the forced approval (PR `unattended-consent`).
- **Files.** server/services/run/seams/taintGate.js, seamProfiles.js, events/EventQueue.js; server/services/chat/ChatRepository.js; server/services/run/ToolRunner.js
- **Flags.** none; active for origins followup, child_report, handoff and webhook (scheduled runs attached to an agent join in PR `unattended-consent`)
- **Migrations.** none
- **Behaviour change.** None reachable until follow-ups ship in the next PR.
- **Acceptance.**
  - One test per cell of the #3785 table, each run with and without a standing grant.
  - A chain report, wake, delegate, report stops at generation 3 (fake clock).
  - A tainted wake writes an answer; a later unattended run in the same chat starts tainted.
  - A tainted woken run that calls the workflow tool for a legacy workflow is parked; an untainted scheduled run that calls it runs as before.
  - Integration access is removed while a write is parked: approving it leads to a refusal and nothing is sent.
- **Tests.** server/tests/run/taintGate.test.js (table); wake-limit tests.
- **Docs and release entry.** docs/security.md: new section 'Prompt injection: what may wake or feed a run' (origin, taint, parking); docs/tool-approval.md forced-approval table. Release entry: none, not reachable yet; the follow-up entry names it.
- **End-to-end check.** `node scripts/run-server-tests.js taintGate`; the browser check is part of PR 40 (a follow-up scheduled in a tainted run parks its external write).
- **Risk.** The forced approval is skipped by a standing grant. Guard: the gate is its own seam before the approval seam.

#### PR 40: `follow-ups-server`

**feat(chat): follow-ups in the same chat and notify_user (server)**

Issues: #3197, #3780, #3781, #3782. Size: L. Stacks on: PR 39.

- **Scope.** Tools `schedule_followup({ at: '+30m' | 'tomorrow 09:00' | RFC 3339, prompt, cancelOn?: ['user_message'] })`, `cancel_followup({ id })`, `notify_user({ message })` in `server/defaults/tools/` and `server/tools/followUpTools.js`; times are read in the user's time zone. `platform.followUps { maxPendingPerUser, maxDelayDays, minDelayMinutes, maxChainLength, maxLatenessMinutes: 60 }`; codes `FOLLOWUP_LIMIT_REACHED` (429) and `FOLLOWUP_TOO_FAR` (400). Not for guests, anonymous users, temporary chats or sub-agents. A follow-up created in a tainted run needs approval and wakes tainted. A scheduler source (pattern of `taskSource.js`) finds due events; the claim on the event creates one job (recipe source `event`) in the unattended pool, so exactly one worker fires it. A fire takes the chat's run claim (PR 23) first, under the derived `runId`, so a follow-up never starts beside another turn: a busy chat leaves the event pending, and a fire that loses the event's claim writes `ended` on its run claim. The claim and the job are two writes, and a worker can stop between them, so they are bound by one key: the event's claim document (PR 38, outcome `fire`) is created create-only and holds the `runId` of the job (derived from the event id and its `generation`, so it is the same on every attempt) together with `claimedAt`; the job head is created under that `runId` through the admission of PR 22, with a create-only write and `recipe.eventId`, and a key that already exists counts as created; only after admission step (3) confirmed the reservation the claim gets its `done` mark. The same source also finds `fire` claims without the mark that are older than 60 s (the claim is a single step, it has no heartbeat): any worker completes such a claim under the stored `runId`, and the job head decides before anything else: when a head without the mark `lapsed` exists under that `runId` with a confirmed admission, only the claim's mark is set, the event ends consumed and the job runs once, however long the outage was. A head counts as existing only when its admission is confirmed (PR 22): the principal's quota entry for the `runId` is `queued` or later, or the job is final. A head created at admission step (2) whose entry is still `reserved` can be removed by the sweep of PR 22, so it proves nothing yet: the completer runs step (3) itself, which is idempotent per runId. When the sweep removed the reservation first, step (3) finds no entry and deletes the head, as PR 22 says, and the claim is in the case without a head. When the head carries `lapsed` (a completer wrote the lapse and stopped before marking the claim), the completer sets the claim's mark with the outcome cancelled, the event ends cancelled with the same visible reason and nothing is started (how old an existing job may be is a matter of the pickup rule of PR 26 and not of the lateness bound). Only when no head exists does the lateness bound apply to a stale claim: at most `maxLatenessMinutes` late, the completer takes the chat's run claim (a busy chat leaves the stale claim for its next pass) and admits the run again under a new `runId`, steps (1) to (3). A `runId` is never used twice (PR 22), and the sweep's delete of a head left behind has no condition, so a head re-created under the old key could be removed by a sweep that paused between removing the reservation and deleting the head. The admission attempts of an event are therefore numbered by claim by create: the document `<eventId>__admit__<n>` in `chat-event-claims` is created create-only and names the `runId` of attempt n, which is derived from the event id, its `generation` and n (attempt 1 is the `runId` the `fire` claim holds). Attempt n+1 may be created only when the reservation of attempt n is gone and its admission was never confirmed; whether its head still exists does not matter, because nobody was told about it and only the sweep deletes it, under its own key. Two completers that both decide to admit again meet at that create, and the loser reads the winner's attempt. The event's `done` mark names the attempt whose admission was confirmed, which is the one job the event has; later, or when the quota is full, the head is created all the same, create-only, without a reservation and with the sealed mark `lapsed` (an optional head field added here), and a lapsed job is never started: `claim.js` checks the mark first, the first claim settles the job as cancelled and the event ends cancelled with a visible reason. The create-only head is thus the one decision, so two completers that judge the lateness differently, or one that stalled after its read, cannot leave an event both fired and cancelled, and a stop at either point neither loses the follow-up nor fires it twice. The claim gets `done` only when one of these outcomes is durable: an entry that is `queued` or later (or a final job), or a `lapsed` head. So an event is never marked consumed for a job that the sweep can still remove. An event is never put back to `pending`: its claim is never deleted before the event, because a new claim would mean a second key. An event without a claim that was missed during downtime fires once at boot when it is at most `maxLatenessMinutes` late, and an older one ends cancelled with a visible reason (its claim is created with the outcome `cancel`), so a long outage or a restored backup replays no old work; an event due while a turn runs waits. Owner, app, model and integrations are checked again at fire time; if the run cannot start the event ends cancelled with a visible reason. The prompt reaches the model as data with origin `followup`. `cancelOn: user_message` is applied by the turn start as a claim with the outcome `cancel`; when the fire already holds the claim, the follow-up runs. The woken turn carries its wake reason; an end state `no_change` raises no badge. `notify_user`: plain text, length cap, a rate limit per run and per user (over it a tool error), written to `_notifications` with only the chat link the server builds. Follow-ups count against the unattended pool and the wake cap, not against `maxTasksPerUser`. Pending follow-ups are listed on `/admin/runs` with the state `scheduled`. The group editor labels `scheduledTasks` as 'Unattended work' / 'Unbeaufsichtigte Ausführung'.
- **Out of scope.** The chip and wake lines (next PR); editing a follow-up; `cancelOn: chat_read`.
- **Files.** server/tools/followUpTools.js; server/defaults/tools/schedule_followup.json, cancel_followup.json, notify_user.json; server/services/scheduler (new source); server/services/run/jobs/recipes.js, JobStore.js, claim.js; server/validators/platformConfigSchema.js; server/featureRegistry.js; shared/apiErrors.js; GroupFormEditor.jsx
- **Flags.** adds `followUps` (preview, off); needs group permission `scheduledTasks`, now labelled 'Unattended work'
- **Migrations.** none
- **Behaviour change.** With the flag on, a chat can wake itself once at a later time.
- **Acceptance.**
  - A follow-up fires once, in the same chat, with the full context, with two workers and a restart at the due time (nightly); cancel and fire never both happen, also when either side is paused for 20 s between its read and its create (`stalledWriter`).
  - Kill points after the claim on the event, after the creation of the job head and after the confirmation of its admission (nightly, all listed in `KILLPOINTS.md`): after the restart either exactly one job with that `runId` exists, ran once and the event is consumed, or the event ends cancelled with a visible reason; never neither, and the claim carries `done` only after that outcome is stored. Two workers that complete the same stale claim create one job (fake clock, create-only write).
  - Cleanup paused until after the readmission: the sweep removes the reservation of attempt 1 and is paused before it deletes the head (`stalledWriter`); the completer creates `<eventId>__admit__2`, admits and confirms attempt 2 and sets `done`; the sweep continues and deletes the head of attempt 1 only. The job of attempt 2 exists, runs once, and the event names it. Two completers at that point create one attempt 2.
  - Stop between admission steps (2) and (3): with the completer first, it confirms the reservation and the job runs once. With two sweeps first (reservation and head are gone, the claim has no `done`), the completer admits the run again as attempt 2 under a new `runId`, it runs once and the event is consumed; with the quota full by then, or past the lateness bound, the completer creates the `lapsed` head, the event ends cancelled with its reason and no model call happens.
  - Stale claim after an outage longer than `maxLatenessMinutes` (fake clock): with a job head without the mark `lapsed` and a confirmed admission under the stored `runId` the event ends consumed and the job runs once; without one the event ends cancelled with a reason and no model call happens. Two completers of which one judged the event in time and was then paused for 20 s (`stalledWriter`) leave one head and one outcome.
  - Grammar table with a fake clock, including the daylight-saving days in Europe/Berlin, a past time and each limit.
  - The prompt never becomes a user message; a follow-up scheduled in a tainted run wakes a tainted run and its external write is parked.
  - Owner deactivated, app access removed or chat deleted: the event ends cancelled with a reason.
  - With the flag off the tools are not offered.
  - After an outage longer than `maxLatenessMinutes`, and on a restored backup, a due follow-up ends cancelled with its reason and no run starts (fake clock), unless a job head without the mark `lapsed` and with a confirmed admission already exists under its `runId`: then the event ends consumed and that job runs once.
  - A completer that created a `lapsed` head and was killed before marking the claim: the next completer finds the head, ends the event cancelled with the reason and starts nothing; a claim on that head by the executor settles it cancelled.
- **Tests.** server/tests/followups/*.test.js (fake clock); nightly fault cases; route tests.
- **Docs and release entry.** docs/scheduled-tasks.md 'Follow-ups in a chat' with a comparison table, docs/usage-limits.md, docs/authentication-architecture.md (permission label), docs/pii-data-handling.md; tool descriptions checked against the glossary. Release entry: none yet; written by the next PR.
- **End-to-end check.** Agents contents with `minDelayMinutes: 0`: script `followup-soon` schedules a follow-up 3 s ahead; `GET /api/chats/{id}/events` shows it pending; a new run then appears in the chat with origin `followup` in the stub's request.
- **Risk.** Every user can now schedule unattended wakes. Guard: the flag is off and the release entry says what the permission covers.

#### PR 41: `follow-ups-ui`

**feat(chat): follow-up chips, wake lines and toasts**

Issues: #3197, #3782. Size: M. Stacks on: PR 40. Closes: #3197.

- **Scope.** `PendingWorkStrip` chip 'Follow-up today 14:30' / 'Wiedervorlage heute 14:30' with Cancel (owner only). A click opens a non-modal panel: the absolute time with zone, the exact stored prompt in a box 'Written by iHub', and 'Cancels if you write first'. `WakeLine` ('Follow-up you asked for at 12:30'), `QuietLine` for `no_change` ('Checked at 14:30, no change', folded), and a line with the reason when a follow-up could not run. `notify_user` shows through `ToastHost` as plain text with 'Open chat'. The Activity page gains the section 'Scheduled': pending follow-ups and the next run of each active scheduled task within 24 hours, with a link to all scheduled work. Strings `chat.followUp.*`, `chat.wake.*`, `toast.*` in en and de.
- **Out of scope.** Editing the time; 'Run now'.
- **Files.** client/src/features/chat/components/PendingWorkStrip.jsx, FollowUpPanel.jsx, WakeLine.jsx; client/src/features/activity/**; client/src/shared/components/ToastHost.jsx; shared/i18n
- **Flags.** `followUps`
- **Migrations.** none
- **Behaviour change.** Follow-ups are visible and can be cancelled.
- **Acceptance.**
  - The chip shows the stored prompt and the local time, survives a reload, is reachable by keyboard, and only the chat owner can cancel.
  - A woken turn shows why it started; `no change` raises no badge and leaves a folded line.
  - The text of `notify_user` is never rendered as markup.
  - Pending follow-ups are listed in one place per user; with the flag off there is no chip.
- **Tests.** Client unit tests; tests/e2e-agents/follow-up.spec.js; a11y states.
- **Docs and release entry.** docs/user-guide.md; glossary rows (follow-up / Wiedervorlage). Release entry: `features.md` 'Ask iHub to Check Again Later in the Same Chat (Preview)', which states what 'Unattended work' now covers.
- **End-to-end check.** follow-up.spec.js: the chip appears, a reload keeps it, the wake line and the answer arrive; in a second chat the chip is cancelled and nothing fires.
- **Risk.** The strip grows to four rows on a phone. Guard: two rows, then the summary control.

#### PR 42: `background-sub-agents`

**feat(runs): background sub-agents and wake of the parent chat**

Issues: #3196, #3781, #3785, #3782. Size: L. Stacks on: PR 41. Closes: #3196.

- **Scope.** `delegate` gains `background: true`: read-only only (a background child with a write tool is refused), never for guests. When the child ends, the server writes a `delegate.report` event with origin `child_report` to the parent chat's queue. An active parent run drains it at its next step; otherwise a job starts a turn in the parent chat in the unattended pool, tainted. Reports that arrive together produce one wake, and the wakes of a parent chat run one after the other. A wake is a run in the parent chat, so it uses exactly the chat's run claim of PR 23 and needs no mechanism of its own: the worker derives the runId of the wake from the oldest report without a claim and creates `<parentChatId>__<n+1>` in `chat-run-claims`, which is possible only when claim n is ended. A second worker that saw the same reports, or only the later one, fails at that create and starts nothing. Only the holder of the run claim then claims reports: every report that is unclaimed at that moment, each with the outcome `apply` and the runId of the wake, and after that the job is created. The wake is bound like a follow-up (PR 40): a stop after the report claims is completed by any worker under the stored runId, which takes the run claim again first. A report that arrives later is drained by the wake at its next step, as by any active parent run (which claims it with its own runId), or, after the wake's last step, taken by the next wake, which can be created only when this one ended. A wake turn that holds no claim ends as `no_change` without a model call. The report enters as a new data block with server-set child run id, title, app, depth and taint, never as a late tool result or a user message. Parent tools `list_sub_agents`, `check_sub_agent`, `cancel_sub_agent`. Cancelling the parent, deactivating the user and deleting the parent chat cancel all sub-agents. Client: the row settles as 'Continues in the background'; a strip chip 'Sub-agent: <title> - running 4 min - Stop'; the wake line 'Started because a sub-agent finished'; the brief is shown.
- **Out of scope.** Messaging a running sub-agent; a follow-up question to the same sub-agent.
- **Files.** server/services/delegation/**; server/services/run/events/EventQueue.js, jobs/recipes.js; client chat components and Activity page; shared/i18n
- **Flags.** `subAgents`, `platform.runs.subAgents.background` (false), permission `scheduledTasks`
- **Migrations.** none
- **Behaviour change.** With the switches on, a sub-agent can continue after the answer and bring its report back to the chat.
- **Acceptance.**
  - Three children that end in the same tick produce exactly one wake (fake clock). Two workers and two reports at the same moment, with worker A paused after its first report claim (`stalledWriter`): worker B creates no second wake, and there is one wake, one model call and both reports in it. A report that arrives after the wake's last step is taken in by exactly one further wake, which starts after the first ended; one that arrives before it is drained by the running wake. A report is taken in by one run only.
  - A background result arrives in the same chat after a reload and after a server restart (nightly).
  - A parent woken by a report with nobody present parks an external write (injection-suite spec with a supplier PDF); nothing is sent.
  - A background child with a write tool is refused; background children count against the unattended pool.
- **Tests.** Delegation tests for background mode; fault cases; injection-suite spec; tests/e2e-agents/delegate-background.spec.js.
- **Docs and release entry.** docs/sub-agents.md (background), docs/security.md, docs/tool-approval.md. Release entry: extend the sub-agents entry if still in `next/`, else `features.md` 'Sub-Agents Can Work in the Background (Preview)'.
- **End-to-end check.** delegate-background.spec.js with script `delegate-two-background`: two chips, one wake turn, both report links.
- **Risk.** A wake storm overnight. Guard: generation cap, wakes per hour and the shared budget from PR 39.

### Slice E: agents and Scheduled

#### PR 43: `agent-permissions-flag`

**feat(auth): permissions and feature flag for agents**

Issues: #3780. Size: M. Stacks on: PR 42.

- **Scope.** `server/validators/groupConfigSchema.js` and `server/defaults/config/groups.json`: `permissions.agents` ('Use agents' / 'Agenten nutzen') and `permissions.publishAgents` ('Publish agents' / 'Agenten bereitstellen'). `adminAccess` implies `publishAgents`; anonymous users and guests get none of the three. V262 writes the two keys for the built-in groups only where absent (admins, users, authenticated: `agents` true; admins: `publishAgents` true; anonymous: false); custom groups are untouched. `server/featureRegistry.js`: `agents` with EN and DE texts. `GroupFormEditor.jsx` shows the three rows. A helper in the run service checks 'use agents' when a run is built from an agent, and 'unattended work' when a run starts with no person present and at every fire; routes throw `ServiceError` with registry codes. A permission has effect only when its flag is on.
- **Out of scope.** `chatAccess` (PR `agent-own-identity`); the agent API.
- **Files.** server/validators/groupConfigSchema.js; server/defaults/config/groups.json; server/migrations/V262__agent_permissions.js; server/featureRegistry.js; server/services/run/RunService.js; client/src/features/admin/components/GroupFormEditor.jsx
- **Flags.** adds `agents` (preview, off)
- **Migrations.** V262 `agent_permissions`
- **Behaviour change.** Two new group permissions; nothing is visible to users while the flag is off.
- **Acceptance.**
  - The migration passes twice and on a hand-edited `groups.json`; no admin value changes.
  - After an upgrade with untouched config no user sees agent UI.
  - A permission-by-flag matrix test passes at the route and in the run service.
  - Workflow authoring rights are unchanged; the docs list every permission and flag with its default after an upgrade.
- **Tests.** Migration test; permission matrix test; group editor unit test.
- **Docs and release entry.** docs/authentication-architecture.md, docs/admin-ui.md, docs/platform.md. Release entry: none of its own; the Agents entry of PR `agents-ui` explains how to open agents to a pilot group.
- **End-to-end check.** As admin open a group, see the three rows in en and de, switch 'Use agents' on, save; the group API returns the key.
- **Risk.** Admins expect agents after the upgrade. Guard: one 'after upgrade' table in the docs.

#### PR 44: `agent-definition-api`

**feat(agents): agent definition, versions and API**

Issues: #3773, #3787. Size: L. Stacks on: PR 43.

- **Scope.** `server/validators/agentDefinitionSchema.js`: `id, name, goal, instructions, model, tools, skills, mode: 'free', delegation`, and for provided agents `access, identity, chatAccess, userSettableFields`; the consent field is stripped from a general save. Personal agents live in the runtime namespace `user-agents`, filed under the owner. Versions in `agent-versions` (`<agentId>__<n>`, full snapshot): every change creates one and a restore creates a new one. A loader for provided agents reads only `*.json` in the top folder of `contents/agents/`. `server/routes/agents.js`: `GET, POST /api/agents`; `GET, PATCH, DELETE /api/agents/{agentId}`; `GET .../versions`; `POST .../versions/{n}/_restore`. Lists are `{ items, nextCursor }`, create answers 201 with `Location`. Codes `AGENT_NOT_FOUND` (404) and `AGENT_LIMIT_REACHED` (429, `platform.agents.maxAgentsPerUser`). `GET` of one agent returns counts of chats, scheduled runs and memory for the delete dialog. User-deletion content steps for both stores.
- **Out of scope.** Chats of an agent; UI; provided-agent publishing routes.
- **Files.** server/validators/agentDefinitionSchema.js; server/routes/agents.js; server/services/agents/**; server/storage/namespaces.js; server/services/userDeletion.js; shared/apiErrors.js
- **Flags.** `agents`, permission `agents`
- **Migrations.** none
- **Behaviour change.** New API, reachable only with the flag on.
- **Acceptance.**
  - An agent is created with only a name and a goal; every change is a version.
  - User B cannot read, change or delete user A's agent (rows in the authz suite).
  - With the flag off or without the permission the routes answer 404 or 403 as documented.
  - The cleanup coverage test lists both stores.
- **Tests.** Route tests; schema tests; authz rows; cleanup tests.
- **Docs and release entry.** `@swagger` for the routes, docs/pii-data-handling.md; `docs/agents.md` stays the 'removed' page until PR 48 ships the pages it describes. Release entry: none yet.
- **End-to-end check.** With the flag on: `POST /api/agents` with name and goal answers 201 with `Location`; a `PATCH` makes `GET .../versions` list two versions.
- **Risk.** The old `contents/agents/` subfolders confuse the loader. Guard: top-folder `*.json` only, boot test with old data.

#### PR 45: `agent-chats-assembly`

**feat(agents): chats of an agent, per-wake assembly and their retention class**

Issues: #3773, #3787. Size: L. Stacks on: PR 44.

- **Scope.** Chat field `agent: { id, version, kind: 'conversation' | 'scheduled' | 'handoff', taskId?, sourceChatId? }`; `ownerId` stays the user. Index namespace `agent-chats` (`<agentId>__<chatId>`: title, kind, last end state, open items), written at run end and removed with the chat; the feed reads only the index. `GET, POST /api/agents/{agentId}/chats` (201 with `Location: /api/chats/{chatId}`), `GET .../feed`. `server/services/run/assemble/fromAgent.js(agent, chat, event)` builds the `RunSpec` in a fixed order for prompt caching (instructions and goal, memory, notes, open items, history, event) with shares of `contextWindow - maxOutputTokens` (memory 10 %, notes 5 %, open items 3 %); a summary never replaces the original. One memory per agent and user through `memoryComposer.js` and the existing editor. Every run records `agentVersion`. Retention: a chat with the `agent` field is skipped by the `maxChatsPerUser` count and is never evicted; `platform.agents.chatRetentionDays` (default: the value of `chats.retentionDays`) applies to conversation and handoff chats. Conversation and handoff chats appear in 'All chats', scheduled ones only on the agent page. User-deletion steps for agent chats, index entries and memory. Sending: `TurnRequest.appId` becomes optional; `chatTurnStart.prepareTurn` dispatches by the chat's `agent` field to `assemble.fromAgent` and otherwise to `assemble.fromApp`; `recipes.js` gains the source `agent` (`{ source: 'agent', agentId, chatId, messageId }`). A message to an agent chat goes through `POST /api/chats/{chatId}/messages`, which exists whatever `chatJobs` says. A golden records the model input for the event kind `conversation`; the PRs that add `scheduled`, `handoff` and `webhook` record theirs.
- **Out of scope.** The end-of-run log and search (next PR); own-identity chats.
- **Files.** server/services/run/assemble/fromAgent.js; server/services/agents/agentChats.js; server/routes/agents.js; server/services/chat/chatRetention.js and the cap count; server/validators/platformConfigSchema.js; server/services/userDeletion.js ; server/services/chat/chatTurnStart.js; server/services/run/jobs/recipes.js; server/routes/chats.js
- **Flags.** `agents`
- **Migrations.** none
- **Behaviour change.** Agent chats do not count against the user's chat cap.
- **Acceptance.**
  - 200 own chats plus agent chats: no own chat is pushed out and no agent chat is counted.
  - Concurrent posts to one agent chat never produce two runs; the assembly fits an 8k window.
  - An admin can set the retention time; evidence is deleted with its turns.
  - User A's chats and memory of an agent never reach user B.
  - A message to an agent chat runs with `chatJobs` off and on; the model input golden for a conversation event is recorded.
- **Tests.** Assembly tests (window sizes); retention and cap tests; authz rows; cleanup tests.
- **Docs and release entry.** docs/chat-persistence.md (retention table), docs/chat-evidence.md, docs/pii-data-handling.md. Release entry: `features.md` 'Agent and Scheduled-Run Chats Have Their Own Retention' (with the UI PR if unreleased).
- **End-to-end check.** `POST /api/agents/{id}/chats`, then `POST /api/chats/{chatId}/messages` with a message, once with `chatJobs` off and once on: the stub's `/__requests` shows goal and instructions in the system prompt in the fixed order.
- **Risk.** Agent chats appear in exports or statistics with wrong counts. Guard: the listing predicate from PR 33 is extended and tested.

#### PR 46: `agent-run-log-search`

**feat(agents): end-of-run log and search over an agent's chats**

Issues: #3773. Size: M. Stacks on: PR 45.

- **Scope.** Tool `finish_run({ endState: done | no_change | blocked | needs_attention, result, open[] })` with a server fallback when the model does not call it; the result is stored on the message and in the index. Every `needs_attention` carries a reason code and the action expected from the user. `no_change` raises no notification and folds in the feed; `needs_attention` and `blocked` always notify in the app. Tools `search_chats({ query, kind?, since? })` and `read_chat`, scoped to the agent and the user, on a lexical index appended at run end.
- **Out of scope.** The digest of other chats; a version-history UI.
- **Files.** server/defaults/tools/finish_run.json, search_chats.json, read_chat.json; server/services/agents/runLog.js, chatSearch.js; server/services/run/hosts/ChatHost.js
- **Flags.** `agents`
- **Migrations.** none
- **Behaviour change.** Every agent run ends in a named end state.
- **Acceptance.**
  - A user asks in one chat about work from another chat of the same agent and gets the answer.
  - `search_chats` over 2,000 chats answers in under 2 s; it never returns another user's chat.
  - `no change` raises no notification; `needs attention` shows its reason and the expected action.
- **Tests.** Tool tests with scriptedModel; index performance test; authz test.
- **Docs and release entry.** docs/run-ledger.md (end states); the Agents page is written in PR 48; glossary rows for the four end states; tool descriptions checked against the glossary. Release entry: none of its own.
- **End-to-end check.** Script `agent-search`: chat 1 stores a fact, chat 2 calls `search_chats` and cites it; the feed API shows both end states.
- **Risk.** The model never calls `finish_run`. Guard: the server fallback and its test.

#### PR 47: `agent-chat-page`

**feat(agents): chat page for a chat with an agent**

Issues: #3773. Size: L. Stacks on: PR 46.

- **Scope.** Route `/agents/:agentId/chats/:chatId` with `client/src/features/agents/pages/AgentChatPage.jsx`. `AppChat.jsx` is tied to `/apps/:appId` and to an app config, so the shared part is taken out first, in a commit of its own that changes no behaviour: `client/src/features/chat/components/ChatSurface.jsx` (message list, composer, interaction cards, pending strip, workspace pane) and a `target` argument for `useAppChat` (`{ kind: 'app', appId }` or `{ kind: 'agent', agentId }`); `AppChat.jsx` renders `ChatSurface` with the app target. The agent page renders it with the agent target, sends through `POST /api/chats/{chatId}/messages`, and shows the agent line in `ChatHeader` ('<Agent> - Conversation - Runs as you'). Controls that belong to an app (model picker, style, variables, starter prompts) are hidden unless the agent's `userSettableFields` allow them. Route `agents` in `client/src/App.jsx`, `KNOWN_ROUTES` and `client/index.html`; `CLEAN_PAGES`. Strings `agents.chat.*` in en and de. An agent chat listed in 'All chats' opens this page.
- **Out of scope.** The agents list, the editor and the agent page (next PR).
- **Files.** client/src/features/chat/components/ChatSurface.jsx; client/src/features/apps/pages/AppChat.jsx; client/src/features/chat/hooks/useAppChat.js; client/src/features/agents/pages/AgentChatPage.jsx; ChatHeader; client/src/App.jsx; client/src/utils/runtimeBasePath.js; client/index.html; tests/e2e/accessibility.spec.js; shared/i18n
- **Flags.** `agents`, permission `agents`
- **Migrations.** none
- **Behaviour change.** With the flag on, a chat with an agent has its own page. App chats are unchanged.
- **Acceptance.**
  - The extraction commit leaves `tests/e2e/chat.spec.js`, the agents suite and the AppChat unit tests green without a change to any test.
  - A chat created through `POST /api/agents/{id}/chats` opens by direct URL at the root and under a subpath; a message is sent and answered and a reload shows it, with `chatJobs` off and on.
  - The header shows 'Runs as' in text; app-only controls are absent; a message to the running answer, an approval card and Stop work as in an app chat.
  - The page passes axe and fits 320 px in German; a user without the permission gets the not-found page.
- **Tests.** Client unit tests for `ChatSurface` with both targets; known-routes-sync; a11y; tests/e2e-agents/agent-chat.spec.js and the subpath config.
- **Docs and release entry.** No docs page yet. Release entry: none; the Agents entry is written by PR `agents-ui`.
- **End-to-end check.** agent-chat.spec.js: the spec creates an agent and a chat through the API as `e2e-user`, opens `/agents/{id}/chats/{chatId}`, sends `e2e-slow:100:3`, sees the answer and the header line, and reloads.
- **Risk.** The extraction changes the app chat. Guard: it is a commit of its own with no test change; above 1,500 changed lines it becomes its own pull request in front of this one.

#### PR 48: `agents-ui`

**feat(agents): Agents pages**

Issues: #3773. Size: L. Stacks on: PR 47.

- **Scope.** `client/src/features/agents/`: `AgentsPage` (cards with name, goal, 'Runs as you', last activity, open items; empty, loading, error and limit states), `AgentEditorPage` (`/agents/new`, `/agents/:agentId/edit`; name and goal required; the fixed line 'Runs as you, with your connections.'), `AgentPage` (`/agents/:agentId`: header, a 'Needs you' region, tabs Activity, Chats, Scheduled, Memory with the tab in the URL; the composer starts a new chat and opens the chat page of PR 47), delete with typed confirmation that lists the counts. `AdminTabs` moves to `client/src/shared/components/Tabs.jsx` and is imported from there. Sidebar entry 'Agents' / 'Agenten'. The pages join the `agents` route that PR 47 registered; `CLEAN_PAGES` gets them. An approval card raised by an agent run shows the server field for whom it runs as. Strings `agents.*` in en and de; the word 'thread' appears nowhere.
- **Out of scope.** The Scheduled tab's content (PR `agent-scheduled-link`); provided agents.
- **Files.** client/src/features/agents/**; client/src/shared/components/Tabs.jsx, AppSidebar.jsx; client/src/App.jsx; client/src/utils/runtimeBasePath.js; client/index.html; tests/e2e/accessibility.spec.js; shared/i18n
- **Flags.** `agents`, permission `agents`
- **Migrations.** none
- **Behaviour change.** With the flag on, a sidebar entry 'Agents' and its pages.
- **Acceptance.**
  - A user with the permission creates an agent by keyboard, chats with it, reloads and finds the chat and the feed row.
  - Every agent chat, feed row and approval card of an agent run shows 'Runs as' in text.
  - `/agents` pages load cold at the root and under a subpath, pass axe and fit 320 px in German.
  - A user without the permission sees no agent UI; their scheduled tasks still run.
- **Tests.** Client unit tests; known-routes-sync; a11y; tests/e2e-agents/agents.spec.js and the subpath config.
- **Docs and release entry.** docs/agents.md replaced by 'Agents' (label, H1 and front matter together; user part); glossary rows 'runs as' / 'läuft als' and 'memory versus notes', docs/user-guide.md, docs/concepts.md (row 'Agent', fix line 147), glossary. Release entry: `features.md` 'Agents (Preview)', including how to open them to a pilot group after the upgrade.
- **End-to-end check.** agents.spec.js with the flag on in the agents contents.
- **Risk.** A cold load shows 'Unable to connect to the server'. Guard: three route files in one PR and the direct-load checks.

#### PR 49: `scheduled-api-rename`

**feat!: scheduled work API moves to /api/schedules**

Issues: #3783. Size: L. Stacks on: PR 48.

- **Scope.** API clean break (product owner decision 13): `/api/schedules` and `/api/admin/schedules` with the same resources, `_action` segments (`POST .../{id}/_run`), `{ items, nextCursor }` lists and a reserved `agentId` filter; the old paths `/api/scheduled-tasks` and `/api/admin/scheduled-tasks` answer 404 as problem+json; the `TASK_*` codes and `SCHEDULED_TASKS_UNAVAILABLE` keep their names. Order inside the PR: first one path constant per side (`server/services/scheduler/tasks/paths.js`, `client/src/api/endpoints/schedules.js`) with the old value, then the rename across the 19 files that carry the path (among them `middleware/setup.js`, `chatFiles/fileUploadRequest.js`, admin `auditLinks.js`, `AdminCommandPalette.jsx`), then the list shape and the `_action` segments; a grep gate for the old path. The client pages keep their URLs and names in this PR and only call the new API.
- **Out of scope.** Client routes, wording and the badge (next PR); the agent link; any change to stored tasks.
- **Files.** server/routes/scheduledTasks.js, server/routes/admin/scheduledTasks.js and the other server files with the path; client/src/api/endpoints; client/src/features/tasks/** (calls only); tests/e2e/scheduled-tasks.spec.js
- **Flags.** existing `scheduledTasks` flag and permission
- **Migrations.** none
- **Behaviour change.** `/api/scheduled-tasks` and `/api/admin/scheduled-tasks` are replaced by `/api/schedules` and `/api/admin/schedules`; lists have the shape `{ items, nextCursor }`.
- **Acceptance.**
  - Upgrade test on the v5.7 fixture: every task has the same id, schedule, owner, app, notes, files and run history and fires at its next due time; no agent was created.
  - The old API path answers 404 problem+json, the new one answers; `check-route-changes --strict` passes with the breaking entry.
  - File upload to a task, the audit links and the command palette work on the new path; the grep gate finds no old path.
  - With `agents` off and no agent permission, scheduled tasks work as before.
- **Tests.** Upgrade test; route tests; ported scheduled-task tests (each removed test named with a reason); response-shapes.
- **Docs and release entry.** docs/scheduled-tasks.md (API section), docs/api-guidelines.md examples, docs/chat-files.md. Release entry: `breaking-changes.md` 'The Scheduled-Tasks API Has a New Path' with an old and new path table for both APIs.
- **End-to-end check.** `tests/e2e/scheduled-tasks.spec.js` on Chromium (pages unchanged); curl the old path (404) and the new one (list).
- **Risk.** File upload to a task or an audit link still uses the old path. Guard: path constants and the grep gate.

#### PR 50: `scheduled-ui-rename`

**feat(ui): Scheduled: new name and routes**

Issues: #3783, #3773. Size: M. Stacks on: PR 49.

- **Scope.** UI name 'Scheduled' / 'Geplant': values change, the i18n keys `scheduledTasks.*` and `sidebar.tasks` stay so customer overrides survive. Client routes `/scheduled`, `/scheduled/new`, `/scheduled/:taskId`, `/scheduled/:taskId/edit`; `/tasks` and every `/tasks/...` path redirect with id and query kept. `scheduled` is added to `KNOWN_ROUTES` and `client/index.html`, `tasks` stays while the redirect exists; `CLEAN_PAGES` swaps `/tasks` for `/scheduled`. `RunStatusBadge` in `TaskBadges.jsx` is replaced by `RunStateBadge`. The value of `scheduledTasks.memory.title` is corrected: the dated notes of a task are called 'Notes' / 'Notizen', not 'Memory' / 'Gedächtnis' (#3773 cites the key as `tasks.memory.title`). The model-facing descriptions of the scheduled-task tools are checked against the glossary.
- **Out of scope.** The API (previous PR); the agent link.
- **Files.** client/src/features/tasks/**; client/src/App.jsx; client/src/utils/runtimeBasePath.js; client/index.html; shared/i18n; tests/e2e/scheduled-tasks.spec.js; tests/e2e/accessibility.spec.js
- **Flags.** existing `scheduledTasks` flag and permission
- **Migrations.** none
- **Behaviour change.** The pages are called 'Scheduled' and live under `/scheduled`; `/tasks` redirects.
- **Acceptance.**
  - `/tasks` and `/tasks/{id}` open the matching page by direct URL at the root and under a subpath.
  - A customer override of a `scheduledTasks.*` key still applies (test with an override file).
  - The German UI uses 'Geplant' for schedules only; the notes of a task are not called memory.
  - The pages pass axe; `known-routes-sync` is green.
- **Tests.** Client unit tests; known-routes-sync; a11y; tests/e2e/scheduled-tasks.spec.js on the new routes.
- **Docs and release entry.** docs/scheduled-tasks.md rewritten (file name kept, H1 'Scheduled'), docs/user-guide.md, docs/admin-ui.md, the screenshot, glossary rows. Release entry: `features.md` 'Scheduled Tasks Are Now Called Scheduled'.
- **End-to-end check.** `tests/e2e/scheduled-tasks.spec.js` on `/scheduled`; a direct load of `/tasks/<id>` lands on `/scheduled/<id>` at the root and under `/ihub`.
- **Risk.** German users read 'Geplant' for three things. Guard: 'Geplant' only for schedules, 'Mit Plan' for the mode; the wording lint.

#### PR 51: `agent-scheduled-link`

**feat(agents): attach a scheduled run to an agent**

Issues: #3783, #3773, #3787. Size: M. Stacks on: PR 50.

- **Scope.** A task gains the optional field `agentId` (missing means none; stored tasks are not rewritten), set and cleared through `PATCH /api/schedules/{id}` by the task owner, only to an agent they own or may use. `appId` stays stored, so detaching restores the old behaviour. Attached: each run starts a fresh agent chat of kind `scheduled`; the agent's instructions, model, tools and memory replace the app's; the task's instruction is the event (origin `schedule`, as data); the task's notes are the run's notes; the run knows the last run's result and end state; `finish_run` is stored on the task's `lastRun`; the newest `maxRunChatsPerTask` (20) chats are kept. With `agents` off an attached task does not run and shows as paused with the reason. Deleting an agent detaches and pauses its tasks, and the dialog says so. Client: an 'Agent' field on the task (None, or name with link; Attach, Detach with confirmation); the agent page's 'Scheduled' tab; the list filter `agentId`.
- **Out of scope.** Webhook triggers; consent.
- **Files.** server/routes/scheduledTasks.js; server/services/scheduler/tasks/taskExecution.js; server/services/run/jobs/recipes.js; client/src/features/tasks/**, client/src/features/agents/**
- **Flags.** `agents`
- **Migrations.** none
- **Behaviour change.** A scheduled task can run as an agent.
- **Acceptance.**
  - A task without an agent runs as before; attached, each run starts a fresh chat of that agent that knows the last result; detaching restores the old behaviour.
  - 25 runs keep the newest 20 chats, with and without an agent.
  - Only the owner can attach, and only to an agent they may use.
  - A golden records the model input for the event kind `scheduled`.
- **Tests.** Scheduled-task tests with an agent; retention test; route tests.
- **Docs and release entry.** docs/scheduled-tasks.md, docs/agents.md. Release entry: the Agents entry is extended.
- **End-to-end check.** Spec: attach a task to an agent, 'Run now', a new chat appears in the agent's Chats tab; detach, the next run uses the app.
- **Risk.** A task attached to a deleted agent runs with the app silently. Guard: detach pauses the task.

#### PR 52: `provided-agents`

**feat(agents): provided agents that run as the user**

Issues: #3773, #3780, #3787. Size: L. Stacks on: PR 51.

- **Scope.** Routes under `/api/admin/agents` (free since PR 13) for provided agents in `contents/agents/*.json`: list, create, read, update, delete, versions. A holder of `publishAgents` publishes agents that run as the user and sets the access groups (`access`); the fields `identity`, `chatAccess` and triggers are refused here for everyone (they arrive with the next PRs and need `adminAccess`). Store `agent-user-settings` for the fields a user may set (`userSettableFields`: model, skills), with its user-deletion step. A provided agent a user starts runs with that user's principal and is charged to that user. Deleting a provided agent states what goes. Admin pages `client/src/features/admin/pages/AdminAgentsPage.jsx` and `AdminAgentEditorPage.jsx` with strings `admin.agentEditor.*`; users see a provided agent on `/agents` with the label 'Provided' and the line 'Runs as you'.
- **Out of scope.** Own identity, chat access and quota (next PR); triggers; 'run as the creating admin' (not built); sharing a personal agent.
- **Files.** server/routes/admin/agentDefinitions.js; server/services/agents/**; server/storage/namespaces.js; server/services/userDeletion.js; client admin agent pages; client/src/features/agents/**; tests/e2e/accessibility.spec.js
- **Flags.** `agents`, permission `publishAgents`
- **Migrations.** none
- **Behaviour change.** Admins and publishers can provide agents to groups; users of those groups see and use them.
- **Acceptance.**
  - Route matrix {user, publisher, admin} by field: a publisher creates an agent that runs as the user and sets access groups; `identity`, `chatAccess` and triggers are refused.
  - A provided agent started by a user runs with the user's rights and connections and is charged to the user in Usage Reports.
  - A user outside the access groups does not see the agent and gets 404 on its routes; user A's settings and chats never reach user B.
  - The admin pages pass axe, are in `CLEAN_PAGES` and load by direct URL at the root and under a subpath.
- **Tests.** Route matrix; authz rows; erasure table row; client unit tests; a11y; tests/e2e-agents/provided-agent.spec.js.
- **Docs and release entry.** docs/agents.md (admin part: providing an agent), docs/admin-ui.md, docs/usage-reporting.md, glossary (provided agent / Bereitgestellter Agent). Release entry: the Agents entry is extended.
- **End-to-end check.** provided-agent.spec.js: the admin provides an agent to group `users` on `/admin/agents`; `e2e-user` sees it on `/agents` and chats; a user outside the group does not see it.
- **Risk.** A publisher sets a field that needs an admin. Guard: the field matrix test.

#### PR 53: `agent-own-identity`

**feat(agents): own identity, quota and chat access for provided agents**

Issues: #3773, #3780, #3781, #3787. Size: L. Stacks on: PR 52. Closes: #3781.

- **Scope.** `identity: 'own'` and `chatAccess` on a provided agent, both settable with `adminAccess` only. Own identity: `principalType: 'agent'` in `principalResolver`, resolved through `enhanceUserWithPermissions`, with `isAdmin`, `adminAccess` and `publishAgents` forced off; a group that carries `adminAccess` cannot be assigned (checked at save and at resolve); it never uses a user's tokens. Its quota is a default in `platform.runs` (`agents.defaultQuota`) that the admin can change per agent; it is a principal in Usage Reports; nothing is charged to the admin who created it. `chatAccess { users, groups }`: one rule inside `authorizeChat`; `authorizeRun` resolves through the run's chat for `read`, `answer` and `rerun`, so the users granted chat access may choose 'Run again' for a run of an own-identity agent (recommendation 19 of 2026-11-17). `authorizeInteraction` gets the matching rule, and it is the only exception to the owner rule of PR 7: when the run's principal is an agent identity (`principalType: 'agent'`), which can never answer itself, `answer` and `cancel` are allowed to a user named in the agent's `chatAccess`, directly or through a group, as it reads at the time of the answer; `chatAccess` does not exist on any other agent, so a run owned by a user is still answered by that user alone. Nobody else answers: not an admin outside the grant (cancel stays, as in PR 7), not the admin who created the agent, not a holder of a share link or of the interaction id. The answer is audited with the answering user as actor and the run continues with the rights of the identity, never with those of the grantee. Every change of `chatAccess` is audited with actor, agent and difference. Own-identity chats have the identity as `ownerId`, survive the deletion of any user and go with retention or the agent; grants to a deleted user are removed in an access step; an agent nobody can access is listed for admins. Users see 'Runs as its own identity' on chats, feed rows and approval cards. Identity matrix (integration test): {personal, provided started by a user, own identity} by {tool permission, integration connection, project access, artifact read}; each cell asserts principal, evidence record, audit actor and charged quota; negative rows: owner deleted or demoted before firing, snapshot too old, own identity placed in an admin group.
- **Out of scope.** Triggers (PR `agent-webhook-triggers`); 'run as the creating admin' (not built).
- **Files.** server/services/run/principalResolver.js; server/services/chat/chatAccess.js; server/services/loop/runAccess.js; server/services/agents/**; server/validators/platformConfigSchema.js; client admin agent editor; server/tests/agents/identityMatrix.test.js; server/tests/routeInventory.table.js
- **Flags.** `agents`; the two fields need `adminAccess`
- **Migrations.** none
- **Behaviour change.** An admin can let a provided agent run under its own identity and name who may read its chats.
- **Acceptance.**
  - Only an admin sets own identity and chat access (route matrix).
  - An own identity placed in the admins group by a hand-edited file has no admin right at run time.
  - A run under an own identity is charged to that identity and listed in Usage Reports; over its quota it is refused with a registered code.
  - The route inventory covers chat read, search, export, share, evidence, run events, artifacts, chat files and 'Run again' for a named user, a group member, a stranger and the creating admin.
  - A parked interaction of an own-identity run: a user granted chat access (named, and through a group) answers it with 200 and is the audit actor; a stranger and an admin outside the grant get 403; a grantee removed from `chatAccess` before answering gets 403; a grantee of one agent cannot answer for another agent or for a run owned by a user.
  - Own-identity chats survive the deletion of any user and are removed with the agent.
  - Every cell and every negative row of the identity matrix passes.
- **Tests.** Identity matrix; principal resolver tests; route inventory extended; cleanup tests.
- **Docs and release entry.** docs/agents.md (identity, chat access), docs/usage-reporting.md, docs/authentication-architecture.md, docs/usage-limits.md; glossary rows ('runs as its own identity' / 'läuft als eigene Identität'; 'service account' / 'Dienstkonto' as a word iHub does not use for it). Release entry: the Agents entry is extended.
- **End-to-end check.** The admin gives a provided agent its own identity, attaches a scheduled task to it, runs it now and grants `e2e-user` chat access: the chat is readable by `e2e-user` and answers 403 for `e2e-other` (curl); the usage export shows the identity as principal.
- **Risk.** Chat access is added to one read path only. Guard: one decision function and the route inventory.

#### PR 54: `unattended-consent`

**feat(agents): consent to run without approval; attached scheduled runs hold external writes after reading outside content**

Issues: #3785, #3773, #3783. Size: M. Stacks on: PR 53. Closes: #3783.

- **Scope.** `PUT` and `DELETE /api/agents/{agentId}/unattended-consent`: the owner for a personal agent, an admin for a provided one. Stored with actor, time and `scopeHash = sha256(sorted tool ids + integration installation ids + identity)`; a mismatch at run time means no consent, so it is asked again when a tool or connected system is added and kept when instructions change. It is read at every parked call, audited, never lowers a configured approval mode and is not settable through the general save. `taintGate` now also covers the origin `schedule` for a scheduled run that is attached to an agent: when tainted it parks external writes unless the agent carries the consent. A scheduled task without an agent keeps today's behaviour (its `alwaysAllow` list applies): #3783 promises that scheduled tasks work as before while `agents` is off, and the consent exists only on an agent; `docs/security.md` states this and recommends attaching such a task to an agent. Whether plain tasks get the gate too is the blocking question of this PR. If the product owner chooses that, this PR also adds `PUT` and `DELETE /api/schedules/{id}/unattended-consent` (task owner only, the same scope hash and audit, independent of the `agents` flag), the gate for every scheduled run, and a breaking entry that names the remedy. A note written in a tainted run is marked and left out of the memory review input. Client: `UnattendedConsentCard` (off by default, a `ConfirmDialog` with typed confirmation and a plain warning, 'Allowed by <name> on <date>'); for a provided agent the consent is shown on the agent page and when a scheduled run is attached.
- **Out of scope.** Loop approval (slice G).
- **Files.** server/services/agents/consent.js; server/routes/agents.js; server/services/run/seams/taintGate.js; scheduled-task notes; client/src/features/agents/components/UnattendedConsentCard.jsx
- **Flags.** `agents` (the consent and the gate for attached scheduled runs)
- **Migrations.** none
- **Behaviour change.** A scheduled run attached to an agent that read untrusted content performs no external write without an approval or the consent of the agent. Scheduled tasks without an agent are unchanged.
- **Acceptance.**
  - In a tainted unattended run under default settings an external write is parked and the owner is asked; with the consent the same run proceeds.
  - Consent given, then a tool added: parked again. Withdrawn mid-run: the next call is parked. A general `PATCH` with a consent field is ignored.
  - Only the owner (personal) or an admin (provided) can give it; giving and withdrawing are audited.
  - A note written in a tainted run is absent from the memory review input.
  - Upgrade test on the v5.7 fixture with `agents` off: a task with `alwaysAllow`, a flagged read and an external write completes as before.
- **Tests.** Consent tests; taint gate table extended with origin `schedule`, with and without an agent; the upgrade test; route tests.
- **Docs and release entry.** docs/security.md (consent), docs/tool-approval.md, docs/scheduled-tasks.md. Release entry: the Agents entry is extended (consent); no breaking entry under the assumed answer. Under the other answer: `breaking-changes.md` 'Scheduled Runs Hold External Writes After Reading Outside Content' with the remedy.
- **End-to-end check.** unattended-consent.spec.js: a scheduled task attached to an agent calls `e2e_counter_read` (declared `untrustedInput`) and then `e2e_counter_write`: the run waits under 'Needs you' and `GET /__counter` on the agents helper is 0; give the consent and run again: it proceeds and the counter is 1.
- **Risk.** A consent given for a harmless agent covers a mail integration added later. Guard: the scope hash.

#### PR 55: `agent-handoff`

**feat(agents): hand a chat over to an agent**

Issues: #3773, #3785, #3787. Size: L. Stacks on: PR 54.

- **Scope.** `POST /api/chats/{chatId}/_handoff { agentId, scope }`: the source transcript is frozen with the share code (`chat-share-messages`), stored as an artifact and exposed through the tool `read_handoff`, never inline. It enters the agent as data with origin `handoff`, starts tainted, and creates an agent chat of kind `handoff` as a linked root run; no turn of the source chat's own model starts. Code `HANDOFF_NOT_ALLOWED` (403). `@agent` parsing sits beside `server/services/workflow/mentionWorkflow.js` with one picker, plus an entry in the '+' menu. `HandoffConsentSheet` shows counts and scope before sending; Cancel sends nothing; `HandoffCard` reaches a final state after a restart. A golden records the model input for the event kind `handoff`.
- **Out of scope.** Handoff to an agent the user may not use; webhook triggers (next PR).
- **Files.** server/routes/chats.js; server/services/agents/handoff.js, mentionAgent.js; server/defaults/tools/read_handoff.json; client/src/features/agents/components/HandoffConsentSheet.jsx, HandoffCard.jsx; server/tests/routeInventory.table.js
- **Flags.** `agents`
- **Migrations.** none
- **Behaviour change.** A user can mention an agent to hand a chat over.
- **Acceptance.**
  - A handoff shows counts and scope before sending, works by keyboard and from the '+' menu, and Cancel sends nothing; the card reaches a final state after a restart.
  - The transcript never becomes a user message in the agent's chat; the run starts tainted.
  - A handoff to an agent the user may not use answers 403 `HANDOFF_NOT_ALLOWED`; the route has its inventory row.
- **Tests.** Handoff tests; model input golden; tests/e2e-agents/handoff.spec.js; a11y states.
- **Docs and release entry.** docs/agents.md (handoff), docs/security.md, docs/sse-v2.md, glossary (handoff / Übergabe). Release entry: the Agents entry is extended.
- **End-to-end check.** handoff.spec.js: mention an agent in an app chat, confirm the sheet, the agent chat opens with the handoff card; the stub's `/__requests` shows the transcript only behind `read_handoff`.
- **Risk.** The transcript leaks into the prompt. Guard: it is an artifact behind a tool; the golden.

#### PR 56: `agent-webhook-triggers`

**feat(agents): webhook triggers for provided agents with their own identity**

Issues: #3773, #3785, #3787, #3780. Size: M. Stacks on: PR 55. Closes: #3773, #3780.

- **Scope.** Webhook triggers in `server/routes/agents/triggers.js`: created by admins only, for provided agents with `identity: 'own'` only; a trigger on an agent that runs as the user answers 400 `TRIGGER_NEEDS_OWN_IDENTITY`, because no user is present whose rights the run could use. The call: HMAC-SHA256 over `<timestamp>.<nonce>.<raw body>` (the two header values as sent, then the raw bytes), compared in constant time, so neither header can be changed without the secret; a timestamp header at most 5 minutes old and at most 30 seconds ahead of the server clock (outside of that 401); a nonce (a replay answers 409), stored only after the signature was accepted and kept until its timestamp plus 5 minutes, counted from the timestamp and not from the receipt, so a nonce never expires while its timestamp is still accepted; a 1 MB cap, a rate limit per trigger (429), a rotatable secret stored encrypted with `TokenStorageService`. Nonces and the rate limit count across the workers of the host. The limiter uses `createRateLimiter(..., { shared: true })` (`server/middleware/rateLimiting.js`); a count lost there costs a few calls. A nonce is not kept there: that store is the memory of the primary process, it is empty after a restart, and a worker counts on its own when the primary does not answer within 500 ms (`server/utils/clusterRateLimitStore.js`). A nonce is a create-only document in the namespace `trigger-nonces` (key `<triggerId>__<sha256 of the nonce>`, claim by create, section 2.8), and it is bound to its event by one key, as a follow-up is to its job (PR 40). The id of the trigger event is derived from the trigger id, the signed timestamp and the nonce hash, so it sorts by time and is the same on every delivery of the call. The order is fixed: signature and timestamp are checked; the nonce document is created create-only and holds that event id; the event is created create-only under that id, and a key that already exists counts as created; then the nonce document gets its `done` mark (a plain write that only adds the mark) and the call answers 202. `EtagMismatchError` at the nonce means that the call was seen before, and the document decides. With `done` it is the replay (409). Without `done` the first delivery stopped between the two writes or is still under way: this request completes it (creates the event, sets `done`) and answers 202 as the first delivery would. A retry therefore never gets 409 while no event exists, and a call gives one event however often it is delivered. A sweep deletes the document after its timestamp plus 5 minutes, when the timestamp alone refuses the call, and logs one that is still without `done`. The namespace holds hashes and event ids derived from them, no owner id, and is exempted in the erasure table with that reason. The body enters as data with origin `webhook` (queue type `trigger`); the run starts tainted and unattended under the quota of the identity. A parked write of such a run is offered under 'Needs you' to the users and groups named in the agent's `chatAccess` (recommendation 67 of 2026-11-17); without a grantee the run ends `needs attention` and is listed for admins. The admin sees and revokes triggers in the agent editor. A user-deletion access step stops triggers, webhooks and follow-ups first. A golden records the model input for the event kind `webhook`. As the last pull request of the slice it carries the re-check of the admin surfaces of slice E (group editor rows, admin agent pages) against the state of the admin rework (#3739, #3742), with the result noted in #3780.
- **Out of scope.** Triggers for personal agents and for agents that run as the user.
- **Files.** server/routes/agents/triggers.js; server/services/agents/triggers.js; server/storage/namespaces.js; server/services/userDeletion.js; client admin agent editor (trigger list); shared/apiErrors.js
- **Flags.** `agents`; needs `adminAccess`
- **Migrations.** none
- **Behaviour change.** Admins can start a provided agent that has its own identity by webhook.
- **Acceptance.**
  - A replayed webhook answers 409, a stale timestamp 401 and the 61st call in a minute 429, also when the calls reach two different workers (forked-worker test). The same signed call sent to two workers at the same moment starts one run, and a replay after a server restart inside the 5 minutes answers 409.
  - Kill point between the nonce document and the event (nightly, listed in `KILLPOINTS.md`): the retry of the same signed call answers 202, and exactly one event and one run exist; a kill between the event and `done` gives the same. A replay after the completion answers 409.
  - A captured call sent again with a changed timestamp header, and one with a changed nonce header, each answer 401 (the signature no longer matches) and store no nonce; a signature over the body alone is refused.
  - A signed call dated 20 seconds ahead is accepted, and its replay answers 409 until the timestamp is 5 minutes old and 401 after that (fake clock; never a second run); a call dated 31 seconds ahead answers 401 and stores no nonce.
  - A trigger on an agent that runs as the user, and a trigger created by a non-admin, are refused.
  - A parked write of a triggered run appears under 'Needs you' for a user with chat access and for nobody else; that user can approve it.
  - Each of S1 to S9 of #3773 has a passing test; deleting a user stops that user's triggers, webhooks and follow-ups before any content is removed.
- **Tests.** Trigger route tests; two-worker replay and rate tests; the fault case for the stop between nonce and event; cleanup order test; model input golden.
- **Docs and release entry.** docs/agents.md (triggers), docs/security.md, docs/sse-v2.md, docs/run-ledger.md. Release entry: the Agents entry is extended.
- **End-to-end check.** curl a webhook with a valid signature (202, and a tainted run in `GET /api/admin/runs`), then replay it (409); a trigger on an agent that runs as the user answers 400.
- **Risk.** A webhook floods the unattended pool. Guard: the shared rate limit, the pool cap and the wake limits.

### Slice F: workflow steps and the new engine

#### PR 57: `workflow-engine-dispatch`

**feat(workflows): engine dispatch by schema version and the feasibility check**

Issues: #3788, #3784. Size: M. Stacks on: PR 56.

- **Scope.** One function `startWorkflow()` used by every start site: `routes/workflow/workflowRoutes.js:891`, `tools/workflowRunner.js:370`, `triggers/TriggerManager.js:269` (missing from the issue's list), and the resume and cancel sites (`workflowRoutes.js:1162`, `:1250`, `startup/worker.js`, `chat/chatRecovery.js:109`, `routes/runs.js:94`). It routes by the stored `schemaVersion` or the execution's `engine` field, never by a request or model output; only call sites change. An empty new engine in `server/services/workflow/v2/` accepts `schemaVersion: 2` and ends at once. `workflowConfigSchema.js` is strict (`:645`), so it gains the optional key `schemaVersion` (absent means legacy; 2 is accepted with an empty step list until the next PR defines the steps). The frozen-files test exists since PR 4 and stays green; a guard test forbids `engine.start(` outside `startWorkflow`. The PR body records pass or fail for criteria (a) to (e) of #3788 PR 0. On a fail the fallback of #3784 applies and PRs 58 to 66 are re-planned before work continues.
- **Out of scope.** Any step; any change inside a frozen file.
- **Files.** server/services/workflow/startWorkflow.js, v2/engine.js; the listed call sites; server/validators/workflowConfigSchema.js
- **Flags.** existing `workflows` (preview, off)
- **Migrations.** none
- **Behaviour change.** none for legacy workflows
- **Acceptance.**
  - Each pass criterion is recorded; the frozen files have a zero diff.
  - The legacy goldens of both law consultation variants (recorded in PR 4) are byte-equal: same steps and same output.
  - The legacy goldens for a run paused on a question, a run resumed after a restart and a trigger-started run are byte-equal.
  - Executions of both engines coexist: retention, orphan sweep, cancel and the execution page act on each correctly.
- **Tests.** Frozen-files test; dispatch tests per call site; legacy pause and restart tests.
- **Docs and release entry.** docs/workflows.md: which engine runs what. Release entry: none.
- **End-to-end check.** Start a legacy default workflow from the workflow page against the stub; save a minimal `schemaVersion: 2` workflow through the admin API and start it: it ends as done; the execution page lists both.
- **Risk.** A criterion needs a change in a frozen file. Guard: this PR is the gate and names the fallback.

#### PR 58: `workflow-step-schema`

**feat(workflows): schemaVersion 2 with exactly ten step kinds**

Issues: #3774, #3784. Size: M. Stacks on: PR 57.

- **Scope.** `server/validators/workflowStepSchemaV2.js`, imported by `workflowConfigSchema.js`: a Zod discriminated union over Start, Agent step, Find documents, Extract data, For each, Check, Ask a person, Branch, Action, Write result. No credential fields; model and limits per step; a For each body is stored as flat child steps with `parent`; no edges and no `assign` are stored, the order follows from references. A file without `schemaVersion` is legacy and the two kinds cannot be mixed. Step registry `server/services/workflow/v2/steps/index.js`, separate from `executors/index.js`. Reference resolver (`steps.<id>.output...`), a comparison grammar for conditions (no raw expressions), named results. A definition with an unknown step kind is refused at load and at install with `WORKFLOW_FORMAT_UNSUPPORTED` (400). A version 2 workflow has a top-level `delegation: 'off' | 'normal' | 'extensive'` (default `normal`), as apps and agents have. Legacy files stay fully editable, old node types included, until the step editor exists; PR 69 carries the rule that no old node type can be added.
- **Out of scope.** Step executors; the editor.
- **Files.** server/validators/workflowStepSchemaV2.js, workflowConfigSchema.js; server/services/workflow/v2/steps/index.js, references.js, conditions.js; shared/apiErrors.js
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** A new workflow format can be saved. Nothing changes for legacy workflows.
- **Acceptance.**
  - The registry exports exactly ten kinds; a mixed file is refused; a raw expression is refused.
  - No `vm`, `eval` or `new Function` in the new code (guard test).
  - A legacy workflow can still be saved with an added old node; a version 2 file accepts exactly the ten kinds.
- **Tests.** Schema, resolver and grammar tests.
- **Docs and release entry.** New docs/workflow-steps.md (reference, preview note; started here), docs/error-responses.md. Release entry: none yet.
- **End-to-end check.** curl the admin workflow API: a definition with mixed kinds answers 400 `WORKFLOW_FORMAT_UNSUPPORTED`; a valid version 2 file is saved.
- **Risk.** The schema allows what a model-written plan must not. Guard: the plan subset is a separate, stricter check in slice G.

#### PR 59: `workflow-engine-loop`

**feat(workflows): definition per run and the new engine loop**

Issues: #3788. Size: L. Stacks on: PR 58.

- **Scope.** #3788 PRs 1 and 2. Namespace `workflow-definitions`; `v2/DefinitionStore.js` stores the definition an execution started with, by hash; additive steps in `workflowRetention.js` and user deletion. The engine loop reads the store: start, per-step state `steps[id]`, resume, restart; `WORKFLOW_DEFINITION_MISSING` (409). A run finishes on the definition it started with after an admin edit, a pause and a restart; the evidence record names the hash. `GET /api/runs/{runId}/plan`. New-engine branches in `worker.js`, `workflowRoutes.js` and `routes/runs.js`; `WorkflowExecutionPage.jsx` shows the plan beside the legacy rendering. Minimal Start and Write result executors so a two-step workflow runs end to end. The controlling run is created here: every new-engine execution has one run id, one ledger and one job link from its first event (`RunService.startControllerRun(executionId, principal)`), so the plan route, 'run again' and the claim rules of the later PRs have a run to address; PR 63 adds model segments to it. A grep test forbids `_workflowDefinition` under `server/services/workflow/v2/`.
- **Out of scope.** Derived order, durable step start, other steps.
- **Files.** server/services/workflow/v2/DefinitionStore.js, engine.js; server/storage/namespaces.js; server/routes/runs.js; client/src/features/workflows/pages/WorkflowExecutionPage.jsx ; server/services/run/RunService.js
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** A version 2 workflow runs on the new engine.
- **Acceptance.**
  - A version 2 workflow runs on the new engine, any other on the legacy engine, and every later operation reaches the engine that started the execution.
  - A run finishes on its starting definition after an edit, a pause and a restart; the evidence record names the hash.
  - The frozen-files test is green.
  - No code under `server/services/workflow/v2/` reads `_workflowDefinition` (grep test); a run paused on a question, edited and restarted finishes on the original definition with the start hash in the evidence record.
  - A new-engine execution has a run id from its first event and `GET /api/runs/{runId}/plan` answers for it.
- **Tests.** Engine loop tests; definition store tests; cleanup coverage.
- **Docs and release entry.** docs/workflows.md, docs/chat-evidence.md, docs/pii-data-handling.md. Release entry: none yet.
- **End-to-end check.** Start a two-step version 2 workflow through the API, open the execution page; edit the definition while the run is paused: the run finishes on the original and the page shows the hash.
- **Risk.** Retention or the orphan sweep treats new executions like legacy ones. Guard: the coexistence test from PR 57 is extended.

#### PR 60: `workflow-ready-set-durable-steps`

**feat(workflows): derived step order and durable step start**

Issues: #3788, #3777. Size: L. Stacks on: PR 59. Closes: #3777.

- **Scope.** #3788 PRs 3 and 4. New scheduler in `v2/`: `readySteps`, `skipped`, dependencies derived from references (`DAGScheduler.js` untouched). Durable step start: checkpoint and flush before a write step, then `assertHolder` (PR 28), then the step, in that order, `readOnly` per step kind, `needs[]`, and the 'run again' choice for a step under the rule of the run executor, keyed by the id of the controlling run and the call id of the step. A new-engine execution is created as a job (recipe with `executionId`) and restarts through the executor. The engine keeps its step state per epoch of that job (key `<executionId>__<epoch>`, section 2.8): a holder writes only the document of its epoch and a new holder starts from a copy of the one before, so a stale holder cannot turn a finished step back into an unfinished one. Kill points for steps are added to the inventory.
- **Out of scope.** For each; Check rounds.
- **Files.** server/services/workflow/v2/scheduler.js, engine.js, stepState.js; server/services/run/jobs/recipes.js; server/tests/faults
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** A write step in flight at a crash is not run again.
- **Acceptance.**
  - The order of steps is derived from references; the stored definition has no edges and no `assign`.
  - Killed at a write step: the step is not run again, the run is `needs attention`, and 'run again' executes it exactly once more.
  - Stalled at a write step (a pause after `assertHolder`, longer than `takeoverMs` on the fake clock): the new holder ends as `needs attention`, the step counter is 1, and the late state write of the old holder changes nothing the new holder reads.
  - A new-engine execution is a job and restarts after a server restart.
- **Tests.** Scheduler tests; step state tests; nightly fault cases.
- **Docs and release entry.** docs/workflows.md, docs/background-runs.md (new-engine workflows continue; legacy ones do not). Release entry: none yet.
- **End-to-end check.** `npm run test:faults -- workflow-step`; in the browser an execution seeded in `needs attention` through `POST /__seed-job` shows the card.
- **Risk.** Two recovery systems act on one execution. Guard: legacy executions never get a job.

#### PR 61: `workflow-steps-basic`

**feat(workflows): steps Start, Find documents and Write result**

Issues: #3774. Size: M. Stacks on: PR 60.

- **Scope.** `v2/steps/StartStep.js`, `FindDocumentsStep.js`, `WriteResultStep.js`, reusing library logic of the old executors without changing them. Find documents with `refine` rounds (each an activity event and an evidence entry), pagination, a bound on the rounds, results in first-seen order without duplicates and a `coverage` output; it searches with the rights of the principal. Write result takes delivery targets from step config only and returns several named results to API, MCP and A2A callers. Step events carry `title` and `stepType` from the server. A triggered workflow runs with the rebuilt principal of the trigger owner. The shared contract suite `server/tests/steps/contract.js` (inputs, outputs, options, cancel, resume after a pause) starts here and is applied to every kind.
- **Out of scope.** Action (next PR); model steps; loops.
- **Files.** server/services/workflow/v2/steps/StartStep.js, FindDocumentsStep.js, WriteResultStep.js; server/validators/workflowStepSchemaV2.js; server/tests/steps/contract.js
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** Three of the ten steps work.
- **Acceptance.**
  - A user without access to an iFinder document gets no record for it.
  - Find documents pages through a result set larger than one page, stops at its round bound, and returns records in first-seen order.
  - A workflow returns several named results to API, MCP and A2A callers.
  - The contract suite passes for the three kinds.
- **Tests.** Contract suite; Find documents tests on the recorded iFinder result set.
- **Docs and release entry.** docs/workflow-steps.md. Release entry: none yet.
- **End-to-end check.** A workflow Start, Find documents (the recorded iFinder set served by the agents helper), Write result runs on the stack through the API; the result lists the documents in first-seen order.
- **Risk.** Find documents returns a document the user may not see. Guard: the search runs with the rights of the principal; the access test.

#### PR 62: `workflow-step-action`

**feat(workflows): Action step with integration actions and an admin-only free URL**

Issues: #3774, #3785. Size: L. Stacks on: PR 61.

- **Scope.** `v2/steps/ActionStep.js`. Shape 1: an action of an installed integration; the URL is that of the action, the step supplies parameters, auth comes from stored credentials, tool approval applies; includes `memory.read-section` (empty text when no memory exists). Shape 2, free URL: saved only through the admin route by a principal with `adminAccess` (recorded as `authoredBy`, audited; any permitted user may run it); scheme, userinfo, host and port are literals (validation rejects a template there); the final URL is rebuilt with `new URL()` and its origin must equal the configured origin; `assertPublicTarget`, pinned lookup, `redirect: 'manual'`, and `httpFetch()` so the proxy and the SSL whitelist apply; a private target is allowed only on `ssrf.allowedHosts` or as the base URL of an installed integration, not merely because it is on `ssl.domainWhitelist`.
- **Out of scope.** Model steps; loops; a free URL in a model-written plan (never allowed).
- **Files.** server/services/workflow/v2/steps/ActionStep.js; server/validators/workflowStepSchemaV2.js; the admin workflow save route; server/utils/httpConfig.js (use only)
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** The Action step works.
- **Acceptance.**
  - Action honours tool approval; a whitelisted private-CA host works and a non-whitelisted one fails.
  - A private IP, a templated host, the path values `//evil.example/x` and `@evil.example`, and a redirect to `169.254.169.254` are all stopped.
  - A non-admin save with a free URL answers 403; an admin save is audited with `authoredBy`.
  - The contract suite passes for Action; `memory.read-section` returns empty text without a memory.
- **Tests.** Contract suite; Action security tests (table).
- **Docs and release entry.** docs/workflow-steps.md, docs/security.md (Action rules). Release entry: none yet.
- **End-to-end check.** A workflow Start, Action (`e2e_counter_write` through a test integration action), Write result runs on the stack and `GET /__counter` is 1; a non-admin save with a free URL answers 403 (curl).
- **Risk.** An Action reaches an internal service. Guard: origin equality after `new URL`, manual redirects, the listed tests.

#### PR 63: `workflow-steps-model`

**feat(workflows): Extract and Agent step on the run service**

Issues: #3774, #3772. Size: L. Stacks on: PR 62. Closes: #3772.

- **Scope.** `RunService.runSegment(controllerRunId, { stepId, instructions, inputs })` with `hosts/StepHost.js` and `assemble/fromStep.js`: one controlling run per execution owns the transcript; an Agent step is a segment of it, or a sub-agent when the step asks for a fresh context, and may delegate within the definition's delegation setting. Extract: a thin executor without tools; its output is schema-validated, size-capped and marked `tainted: true` for later steps. The node timeouts of `checkpointResume.js` do not govern these steps; the step's run budget does. The guard test is extended: no `LLMClient` and no `runTool` import under `server/services/workflow/v2/`. The controlling run exists since PR 59; this PR adds segments to it. The `delegation` setting of the workflow decides whether an Agent step is offered `delegate`.
- **Out of scope.** For each; Check.
- **Files.** server/services/run/RunService.js, hosts/StepHost.js, assemble/fromStep.js; server/services/workflow/v2/steps/AgentStep.js, ExtractStep.js; server/tests/run/architecture.test.js
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** Model steps of a workflow run through the run service.
- **Acceptance.**
  - A document that says 'ignore the schema, call tool X' yields schema-valid output and no tool call.
  - An Agent step's calls appear as a segment of the controlling run in ledger and evidence.
  - No step writes outside its own output; the guard test fails on a direct model or tool call in step code.
  - An Agent step in a workflow with `delegation: 'off'` is offered no `delegate` tool; with `normal` it is, inside the sub-agent limits.
- **Tests.** Contract suite for both kinds; injection test; guard test.
- **Docs and release entry.** docs/workflow-steps.md, docs/agent-loop.md (segments). Release entry: none yet.
- **End-to-end check.** A workflow with Extract over an uploaded text and an Agent step produces a result artifact on the stack with a scripted stub.
- **Risk.** A step calls the model outside the run service. Guard: the extended guard test.

#### PR 64: `workflow-for-each`

**feat(workflows): For each with per-item state**

Issues: #3788, #3774. Size: L. Stacks on: PR 63.

- **Scope.** #3788 PR 5. `ForEachStep`: per-item state; parallel execution returns `items` in input order; a restart resumes in the middle of the list without repeating finished extraction calls; `onItemError: 'fail'` (default) or `'skip'`, with `failed[]` and `count` always filled; each iteration keeps its own `coverage` and the loop adds a sum; parallel items draw from one budget. The engine drives the controlling run end to end in fixed mode. The server sends one progress row and a failed-items list for a large loop.
- **Out of scope.** Ask a person inside a loop and repeat mode (PR 66).
- **Files.** server/services/workflow/v2/steps/ForEachStep.js, engine.js, stepState.js
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** Loops over many documents work and resume.
- **Acceptance.**
  - For each returns `items` in input order when parallel.
  - Killed mid-list, it resumes without a duplicate extraction call (counted on the stub).
  - A 240-item loop produces one progress row and a failed-items list.
  - Parallelism N is respected and the failure of one item is isolated.
  - Load (nightly, stub): For each over 200 documents with parallelism 4 keeps event-loop delay and memory flat (numbers in the PR body).
- **Tests.** Contract suite; ordering and resume tests; nightly fault case.
- **Docs and release entry.** docs/workflow-steps.md. Release entry: none yet.
- **End-to-end check.** A workflow with For each over five uploaded texts and Extract runs on the stack; the stub's `/__requests` shows five extraction calls.
- **Risk.** A loop of 200 items makes 200 jobs. Guard: a step is not a job; the execution is.

#### PR 65: `law-consultation-rebuilt`

**feat(workflows): law consultation rebuilt on the new steps**

Issues: #3774, #3786. Size: M. Stacks on: PR 64. Closes: #3786.

- **Scope.** Two new files in `server/defaults/workflows/` with new ids (`law-consultation-upload`, `law-consultation-ifinder`), built with the step contract only, shipped next to `stellungnahmen-review-v2` and `stellungnahmen-review-ifinder-v2`. V263 adds them to existing installations and changes no existing file. The iFinder variant runs with an empty corpus map until an agent's memory provides one. The synthetic fixtures and the recorded iFinder result set of PR 4 are reused; scripted models for both rebuilt variants are added. `server/tests/golden/sideBySide.mjs` writes the legacy and the rebuilt report and record next to each other; only the five accepted differences remain. The product owner's sign-off is a release gate with a dated note in #3774, not a merge gate.
- **Out of scope.** A fixed document set; deleting the old files.
- **Files.** server/defaults/workflows/law-consultation-upload.json, law-consultation-ifinder.json; server/migrations/V263__add_rebuilt_law_consultation.js; tests/fixtures/stellungnahmen/**
- **Flags.** `workflows`
- **Migrations.** V263 `add_rebuilt_law_consultation`
- **Behaviour change.** Two new default workflows next to the old ones.
- **Acceptance.**
  - Both variants use only the ten steps and run green in CI on the scripted model.
  - The side-by-side tool writes both reports and records for the fixtures.
  - The old workflows still run unchanged.
- **Tests.** CI run of both variants; migration test.
- **Docs and release entry.** docs/workflows.md. Release entry: `features.md` 'Workflows Are Built from Ten Steps (Preview)' is started here.
- **End-to-end check.** `node server/tests/golden/sideBySide.mjs --legacy stellungnahmen-review-v2 --rebuilt law-consultation-upload --input tests/fixtures/stellungnahmen`; start the rebuilt workflow in the browser with the fixture files.
- **Risk.** The comparison is never run with a person. Guard: the release gate has a date and an owner.

#### PR 66: `workflow-check-branch-ask`

**feat(workflows): Check, Branch, Ask a person and repeat mode**

Issues: #3774, #3788. Size: L. Stacks on: PR 65.

- **Scope.** Check: a model call without tools that returns `verdict` and `criteria` and can route a Branch; check rounds (#3788 PR 6): a revise segment and `steps[checkId].rounds`, a setting from 0 to 2 with a ceiling of 2 in code. Branch on the comparison grammar. Ask a person (the chat owner only) pauses and resumes inside For each and inside repeat mode without redoing finished items; when one item of a parallel loop asks, the others continue. Repeat mode of For each. `VerifierNodeExecutor.js` is untouched.
- **Out of scope.** Done criteria on an agent (slice G).
- **Files.** server/services/workflow/v2/steps/CheckStep.js, BranchStep.js, AskPersonStep.js, ForEachStep.js
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** The remaining steps work.
- **Acceptance.**
  - Check returns `verdict` and `criteria` and routes a Branch.
  - Ask a person pauses and resumes inside For each and repeat mode; finished items are not redone.
  - No scripted case exceeds two check rounds.
- **Tests.** Contract suite; loop pause tests; round tests with exact model call counts.
- **Docs and release entry.** docs/workflow-steps.md. Release entry: none yet.
- **End-to-end check.** A workflow with For each and Ask a person: the question appears for item 2, the answer continues at item 2 (browser spec).
- **Risk.** A pause inside a loop restarts the loop. Guard: per-item state from PR 64 and the pause tests.

#### PR 67: `legacy-workflow-notice`

**feat(workflows): legacy inventory, removal notice and marketplace version gate**

Issues: #3784, #3782. Size: M. Stacks on: PR 66. Closes: #3782.

- **Scope.** An inventory lists every legacy file in `contents/workflows/` by id and name with its old node types, defaults and self-built alike, and what points at it (schedules, app tools, `chatIntegration`, mentions). The admin overview shows the notice 'legacy, will be removed'; legacy workflows and runs carry a label sent by the server; the startup log names them; the Workflow Executions page labels legacy runs. Marketplace: workflow items carry `compatibility.ihub`; the server refuses install and update outside the range with a clear message and tolerates a missing field for now; the install page shows the actions and data flows a workflow uses, and installing never grants an integration. A second pull request in the `ihub-marketplace` repository, outside this stack: `scripts/validate.js` fails on a workflow item without the field and checks version 2 files; old-format items get an upper bound; README. The removal plan and its preconditions are recorded in #3784.
- **Out of scope.** Removing the legacy path; a converter.
- **Files.** server/services/workflow/legacyInventory.js; server/routes/admin (inventory route); marketplace install service; client workflow admin pages; /workspace/ihub-marketplace/scripts/validate.js, README.md
- **Flags.** none (admin information)
- **Migrations.** none
- **Behaviour change.** Legacy workflows are labelled; the marketplace refuses incompatible workflow items.
- **Acceptance.**
  - After the upgrade every existing workflow opens and runs as before.
  - The inventory lists the legacy files and what points at them, on a fixture directory with a default legacy, a self-built legacy, a new and a broken file.
  - A server outside the range refuses install and update; `npm run validate` in the marketplace fails on an item without the field.
  - The release entry announces the removal and says what the admin must do.
- **Tests.** Inventory tests on the fixture directory; install tests; marketplace `npm test` and `npm run validate`.
- **Docs and release entry.** docs/workflows.md 'Legacy workflows', docs/marketplace.md, marketplace README. Release entry: `breaking-changes.md` 'Workflows on the Old Node Types Are Legacy and Will Be Removed'. PR 69 adds to the breaking entry that old node types can no longer be added.
- **End-to-end check.** The admin workflows overview shows the notice and the labels on the stack; in `/workspace/ihub-marketplace` run `npm test && npm run validate`.
- **Risk.** The marketplace PR is forgotten. Guard: this PR links it and the server check ships first.

#### PR 68: `workflow-run-view`

**feat(workflows): outline and run view for the new steps**

Issues: #3774. Size: L. Stacks on: PR 67.

- **Scope.** In `client/src/features/workflows/`: a read-only outline of a version 2 workflow and a run view fed by `GET /api/runs/{runId}/plan`, with `ForEachRunRow` (one progress row and a failed-items list). Step labels and options in `workflows.steps.*`, en and de. `WorkflowStepIndicator.jsx` filters by the server's `chatVisible` field, not by node type. The legacy rendering stays for legacy runs with the label.
- **Out of scope.** Editing.
- **Files.** client/src/features/workflows/**; client/src/features/chat/components/WorkflowStepIndicator.jsx; shared/i18n
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** New-engine runs have a readable run view.
- **Acceptance.**
  - The run view of a 240-document For each shows one progress row and a failed-items list.
  - Every step label and option exists in en and de.
  - The view passes axe and can be read by keyboard.
- **Tests.** Client unit tests; a11y; browser spec.
- **Docs and release entry.** docs/workflows.md (run view). Release entry: none yet.
- **End-to-end check.** Browser spec: run the five-item workflow of PR 64 and read the progress row and the result.
- **Risk.** The view hides steps by node type. Guard: the server field decides.

#### PR 69: `workflow-step-editor`

**feat(workflows): editor for the ten steps**

Issues: #3774, #3784. Size: L. Stacks on: PR 68.

- **Scope.** Step forms per kind, `StepResultPicker` (no typed reference), `ForEachStepsList` as a keyboard list for nesting. The canvas stays; a legacy workflow keeps its old forms, but no old node can be added and the two kinds cannot be mixed. The editor and the model-facing schema offer exactly the ten steps. A workflow can be built, connected and nested by keyboard alone, without JSON editing. A manual NVDA pass is a release gate. From this PR on no old node type can be added: the palette offers only the ten steps, and the admin save route refuses a legacy file whose set of old-type nodes grew compared with the stored file (`WORKFLOW_LEGACY_NODE_ADD`, 400); editing and removing existing legacy nodes stays possible. The editor has the `delegation` field of the workflow.
- **Out of scope.** An outline-first editor; a graph editor for model-written plans.
- **Files.** client/src/features/workflows/editor/**; shared/i18n ; the admin workflow save route; shared/apiErrors.js; docs/architecture.md
- **Flags.** `workflows`
- **Migrations.** none
- **Behaviour change.** Admins can build workflows from the ten steps. Old node types can no longer be added to a legacy workflow.
- **Acceptance.**
  - The editor offers exactly the ten steps; an old node type cannot be added.
  - A three-step workflow is built, connected and nested by keyboard alone and runs.
  - Every label exists in en and de; the editor passes axe.
  - A save through the admin API that adds an old node to a legacy workflow answers 400; a save that edits or removes one succeeds.
- **Tests.** Client unit tests; tests/e2e-agents/workflow-editor.spec.js; a11y.
- **Docs and release entry.** docs/workflows.md rewritten for the new steps; docs/architecture.md 'Node Types'; screenshots. The breaking entry of PR 67 gains the sentence that old node types can no longer be added. Release entry: the 'Ten Steps' entry is completed.
- **End-to-end check.** workflow-editor.spec.js: build a three-step workflow by keyboard and run it against the stub.
- **Risk.** The editor PR grows too large. Guard: the run view shipped first; split by step family if it passes 1,500 lines.

#### PR 70: `rebuilt-corpus-analysis`

**feat(workflows): corpus analysis rebuilt on the new steps**

Issues: #3774. Size: M. Stacks on: PR 69.

- **Scope.** One new default workflow `corpus-analysis` (`schemaVersion: 2`) replaces four legacy files for new use: `corpus-analysis-direct`, `corpus-analysis-direct-v2`, `corpus-analysis-decomposed` and `corpus-analysis-decomposed-v2`. Steps: Start, Find documents with refine rounds (replaces `query-plan` and `corpus-search`), For each over the found documents with Extract data (replaces `structured-record` and the `transform` mapping), Check (replaces `quote-validator`), Agent step for the synthesis, Write result (replaces `template-render`). The 'direct' variant is the same workflow with the parallelism and the number of refine rounds as inputs, not a second file. V264 adds the file to existing installations and changes no existing file; the four legacy files stay and carry the legacy label. CI runs the workflow on a scripted model with the recorded iFinder result set of PR 4.
- **Out of scope.** Deleting the legacy files; a comparison on real documents.
- **Files.** server/defaults/workflows/corpus-analysis.json; server/migrations/V264__add_rebuilt_corpus_analysis.js; server/tests/workflows/rebuiltDefaults.test.js
- **Flags.** `workflows`
- **Migrations.** V264 `add_rebuilt_corpus_analysis`
- **Behaviour change.** One new default workflow next to the old ones.
- **Acceptance.**
  - The workflow uses only the ten steps and runs green in CI on the scripted model.
  - The migration passes twice, and on an installation that already has a workflow with the id `corpus-analysis` the default is skipped and logged.
  - No existing file is changed (frozen-files test and a diff check on `server/defaults/workflows`).
- **Tests.** CI run on the scripted model; migration test.
- **Docs and release entry.** docs/workflows.md (table of default workflows). Release entry: the 'Ten Steps' entry lists the rebuilt workflow and the four legacy files it replaces.
- **End-to-end check.** Start `corpus-analysis` on the stack against the scripted stub with the recorded iFinder set; the result artifact appears.
- **Risk.** The rebuilt workflow answers worse than the legacy one. Guard: the legacy files stay; a check with the product owner is a release gate.

#### PR 71: `rebuilt-iterative-research`

**feat(workflows): iterative research with review rebuilt on the new steps**

Issues: #3774. Size: M. Stacks on: PR 70.

- **Scope.** One new default workflow `iterative-research` (`schemaVersion: 2`) for research with a person in the loop, rebuilt from `iterative-research-human`: Start, For each in repeat mode around an Agent step (one research round) and Ask a person (continue, refine or finish), then Write result. The 'results so far' display inside the loop is dropped (recommendation 83 of 2026-11-17). The autonomous variants `iterative-research-auto`, `iterative-research-auto-v2`, `topic-deep-dive` and `research-assistant` are not rebuilt: a free-running research loop is what an agent in planned mode does (slice G); they stay as legacy files with the label. V265 adds the new file. The marketplace item `iterative-research-human` gets a version 2 file behind the version gate (pull request in `ihub-marketplace`).
- **Out of scope.** Rebuilding the autonomous variants; deleting legacy files.
- **Files.** server/defaults/workflows/iterative-research.json; server/migrations/V265__add_rebuilt_iterative_research.js; ihub-marketplace/workflows (separate pull request)
- **Flags.** `workflows`
- **Migrations.** V265 `add_rebuilt_iterative_research`
- **Behaviour change.** One new default workflow next to the old ones.
- **Acceptance.**
  - The workflow uses only the ten steps and runs green in CI on the scripted model, with a pause on Ask a person and a resume.
  - The migration passes twice and never overwrites an existing file.
  - The release entry names the four autonomous workflows that are not rebuilt and points to planned mode.
- **Tests.** CI run on the scripted model; migration test; marketplace `npm test` and `npm run validate`.
- **Docs and release entry.** docs/workflows.md, docs/marketplace.md. Release entry: the 'Ten Steps' entry is extended.
- **End-to-end check.** Start `iterative-research` in the browser against the scripted stub: the question appears after round 1 and 'finish' ends the run with the result.
- **Risk.** Users of the autonomous variants find no replacement before slice G. Guard: the legacy files keep running and the release entry says so.

#### PR 72: `default-workflows-disposition`

**feat(workflows): approval example rebuilt; disposition of every other default and marketplace workflow**

Issues: #3774, #3784. Size: M. Stacks on: PR 71. Closes: #3774.

- **Scope.** The last rebuilt default: `approval-example` (`schemaVersion: 2`; Start, Agent step, Ask a person, Branch, Write result), rebuilt from `approval-workflow` as the small example the editor docs use; V266 adds it. Not rebuilt, because each is two or three prompts in a row and an app does the same with less: `knowledge-qa` and `document-analysis`; they stay as legacy files with the label and the release entry names the app to use instead. Not rebuilt because superseded: `stellungnahmen-review` and `stellungnahmen-review-ifinder` (their v2 successors were rebuilt as the law consultation workflows). Unchanged and disabled: both `claude-style-agent` files. `docs/workflows.md` gets the table of all 18 legacy default files with the disposition of each (section 2.7 of the plan). Marketplace (pull request in `ihub-marketplace`): `approval-workflow` gets a version 2 file behind the version gate; `knowledge-qa`, `document-analysis`, `research-assistant` and `iterative-research-auto` get an upper bound in `compatibility.ihub` and a note. As the last pull request of the slice it carries the re-check of the admin surfaces of slice F (workflow overview, inventory, editor) against the state of the admin rework (#3739, #3742), with the result noted in #3784.
- **Out of scope.** Deleting old default files; both `claude-style-agent` workflows.
- **Files.** server/defaults/workflows/approval-example.json; server/migrations/V266__add_rebuilt_approval_example.js; docs/workflows.md; ihub-marketplace catalog and workflows (separate pull request)
- **Flags.** `workflows`
- **Migrations.** V266 `add_rebuilt_approval_example`
- **Behaviour change.** One more rebuilt default; every legacy default has a stated future.
- **Acceptance.**
  - `approval-example` runs green in CI on the scripted model with a pause and a resume.
  - The docs table lists all 18 legacy default files and the 6 marketplace workflows with a disposition; a test compares its file list with `server/defaults/workflows`.
  - `npm test && npm run validate` pass in the marketplace repository.
  - No existing default file is changed.
- **Tests.** CI run on the scripted model; migration test; docs table test; marketplace tests.
- **Docs and release entry.** docs/workflows.md, docs/marketplace.md. Release entry: the 'Ten Steps' entry lists rebuilt, replaced-by-an-app and not-rebuilt workflows.
- **End-to-end check.** Start `approval-example` in the browser against the scripted stub: approve, the run ends done; reject, it ends on the other branch. In `/workspace/ihub-marketplace`: `npm test && npm run validate`.
- **Risk.** Nobody decides the list. Guard: the disposition table is a blocking question with a proposed answer per file.

### Slice G: fixed and planned mode

#### PR 73: `agent-fixed-mode`

**feat(agents): fixed mode and finishing rules**

Issues: #3775, #3788. Size: L. Stacks on: PR 72.

- **Scope.** Agent definition `mode: 'fixed'` names a `schemaVersion: 2` workflow (provided agents only; a legacy workflow is refused). The run's definition record has `source.locked: true`. Plan tools and amend do not exist yet: PR 74 makes an amend on a locked definition answer `PLAN_LOCKED`, and PR 75 proves that a fixed-mode run is offered no plan tool and refuses a forged call. The workflow version hash is recorded per run; an admin edit is a new audited version for new runs only. Agent steps use the agent's instructions and memory. Finishing rules: the Check step grades the result against `doneCriteria`; on `revise` the producing step continues its stored transcript with only the gaps, keeps the `runId` and versions the result artifact; after round two with gaps the run ends `needs attention` with `needs: [{ kind: 'open_point', criterion, text }]`, and Write result lists the open points before the result text. Every run ends in a named end state, also on a limit, a cancel and a model error. The criteria are visible in the chat before the first work step; the Check row names each criterion with its outcome. `ModeRadio` in the agent editor ('Frei', 'Fester Ablauf').
- **Out of scope.** Planned mode.
- **Files.** server/validators/agentDefinitionSchema.js; server/services/run/assemble/fromAgent.js; server/services/workflow/v2/**; client/src/features/agents/components/ModeRadio.jsx
- **Flags.** `agents`, `workflows`
- **Migrations.** none
- **Behaviour change.** A provided agent can follow a locked workflow and ends with a stated result.
- **Acceptance.**
  - Fixed mode records `source.locked` and the workflow version per run; two runs with the same scripted model show the same steps in the same order (golden).
  - No scripted scenario exceeds two check rounds; the run then lists the open criteria before the result and says what the agent needs.
  - A revise round sends only the gaps, keeps the `runId` and versions the artifact.
  - Every run ends in a named end state.
  - The Check input contains exactly the criteria (golden); a pass at the first check causes no revise.
- **Tests.** Engine and agent tests with exact model call counts from scriptedModel; step-sequence golden.
- **Docs and release entry.** docs/agents.md 'Modes' (fixed), docs/workflows.md. Release entry: `features.md`, extend the Agents entry.
- **End-to-end check.** A fixed-mode agent with a three-step workflow whose Check is scripted to fail twice ends as `needs attention` and lists the open criteria (browser spec).
- **Risk.** 'Delivered with open points' is shown as done. Guard: the end state is `needs attention` by decision 21.

#### PR 74: `plan-revisions-amend`

**feat(workflows): plan revisions and amend**

Issues: #3788, #3787. Size: L. Stacks on: PR 73. Closes: #3787.

- **Scope.** #3788 PRs 7 and 8. Namespace `workflow-definition-revisions`; revision 1 at start; `GET /api/runs/{runId}/plan/revisions` and `/{n}`; evidence fields. `amend`: validation, mutex, atomic order, routing. A revision is a create-only document `<executionId>__<n>` (claim by create, section 2.8): the create decides who wrote revision n, `EtagMismatchError` is answered as `VERSION_CONFLICT`, and the mutex only keeps honest callers in line. The definition is rebuilt from the revisions, so writing it twice is harmless. Every amend produces one revision that names the causing call; a repeated call returns the same revision; an invalid amend stores nothing. Codes `PLAN_LOCKED` (409), `PLAN_LIMIT_REACHED`, `PLAN_STEP_IMMUTABLE`. Limits in `platform.workflows.plan { maxSteps: 30, maxRevisions: 20, maxOpsPerAmend: 20, maxDepth: 2, maxForEachItems: 200, maxForEachWidth: 4 }`, each with a ceiling in code. Further codes: `PLAN_INVALID` (400, `errors[]` per operation) and `VERSION_CONFLICT` (409, wrong `expectedRevision`). An amend that reaches a worker which does not own the execution is answered by the owner over the cluster bus. On resume a revision record ahead of the definition is rolled forward; the store wins over the state. No HTTP write route.
- **Out of scope.** Plan tools.
- **Files.** server/services/workflow/v2/RevisionStore.js, amend.js; server/storage/namespaces.js; server/routes/runs.js; shared/apiErrors.js; server/validators/platformConfigSchema.js
- **Flags.** none (no surface yet)
- **Migrations.** none
- **Behaviour change.** none reachable
- **Acceptance.**
  - Every amend produces one revision naming the causing call; a repeated call returns the same revision; an invalid amend stores nothing.
  - 50 parallel amends give ordered revisions or `VERSION_CONFLICT`; an amend paused for 20 s between its validation and its create (`stalledWriter`), whose number was taken in the pause, answers `VERSION_CONFLICT` and stores nothing.
  - A locked definition answers `PLAN_LOCKED`; a plan deeper than `maxDepth` answers `PLAN_LIMIT_REACHED`.
  - An amend on a worker that does not own the execution is answered by the owner (forked-worker test).
  - Killed between the revision record and the definition write, the restart rolls the revision forward; a restart after revision 3 continues on revision 3 (nightly).
  - An amend on the locked definition of a fixed-mode run answers `PLAN_LOCKED`.
  - Each of the six limits refuses at its value and cannot be configured above its ceiling.
- **Tests.** Amend and revision tests; cleanup coverage; nightly restart after revision 3.
- **Docs and release entry.** docs/workflows.md, docs/platform.md (`platform.workflows.plan`), docs/pii-data-handling.md. Release entry: none.
- **End-to-end check.** `node scripts/run-server-tests.js amend`; curl the revisions route on a seeded run.
- **Risk.** A crash between store and state leaves half a revision. Guard: the atomic order and the restart test.

#### PR 75: `planned-mode`

**feat(agents): planned mode with plan tools and plan approval**

Issues: #3775, #3788. Size: L. Stacks on: PR 74.

- **Scope.** #3788 PR 9. Tools `plan_set({ doneCriteria, steps })`, `plan_add_step`, `plan_update_step`, `plan_close_step` with schema-constrained arguments; a malformed call returns a tool error with `code` and `detail`; after two failed repairs the run falls back to free mode and the record says so. The plan schema is a strict subset, validated on every revision: step kinds from an allowlist, every tool inside `ctx.toolGrant`, no triggers, no free-URL Action, no raw expression, no approver groups, no identity field, no delivery outside the chat. Criteria are validated at `plan_set`, fixed at approval (or at the first revision), and a later removal is rejected or stored as a flagged revision. Nested plans under `parent`; a step with a fresh context is a sub-agent with its own plan; depth is capped. Plan approval: an approval interaction with origin `plan` after `plan_set` and before the first step; the agent setting `{ required, coversLaterChanges }` is saved with the agent (default off for personal agents, on for provided agents that can write) and enforced on every amendment; it grants no tool call. `mode: 'planned'` on the definition; `ModeRadio` gains 'Mit Plan'. The `_taskQueue` tools in `agentTools.js` stay. A fixed-mode run is offered no plan tool, and a forged plan tool call is refused by `ToolRunner` with `PLAN_LOCKED`. Outcomes of plan approval: Approve resumes; Reject ends the run `blocked`; a timeout ends it `blocked`; 'Request changes' (a text) goes back to the model as data, and the model answers with a revised plan and a new approval card that replaces the first. The agent editor warns 'Scheduled runs will wait for you each time' when plan approval is switched on.
- **Out of scope.** Loops and branches in a model-written plan (next PR); the plan view.
- **Files.** server/defaults/tools/plan_set.json and three more; server/services/workflow/v2/planTools.js, planSchema.js; server/validators/agentDefinitionSchema.js; server/featureRegistry.js
- **Flags.** adds `agentPlannedMode` (preview, off)
- **Migrations.** none
- **Behaviour change.** With the flag on, an agent can write and follow its own plan.
- **Acceptance.**
  - An invalid plan (cycle, unknown step kind, tool outside the grant, trigger, raw expression, over a limit) is rejected before anything is stored; amending a completed step returns `PLAN_STEP_IMMUTABLE` as a readable tool error.
  - Nothing runs before Approve; the setting for later changes is saved with the agent and enforced on every amendment.
  - Removing a done criterion after the start is rejected or recorded as a flagged revision.
  - A plan may contain an Action, an Ask a person and an Agent step that plans again; nesting beyond `maxDepth` is refused.
  - Fixed mode: plan tools are absent from the tool list and a crafted call is rejected with `PLAN_LOCKED`.
  - Reject and timeout end `blocked`; 'Request changes' produces a revised card that replaces the first.
  - Truncated JSON and wrong ids produce a correctable tool error; 500 steps are rejected before anything is stored; a write call after plan approval still needs its own approval when policy says so.
- **Tests.** Plan tool tests with scriptedModel and `assertDone`; subset validation table; approval tests.
- **Docs and release entry.** docs/agents.md 'Modes' (planned). Release entry: none yet; written by PR 78.
- **End-to-end check.** A planned agent with script `plan-three-steps`: the approval card appears, Approve, the steps run, the run ends done (browser spec).
- **Risk.** A plan becomes a way to gain rights. Guard: every revision is validated against the grant; approval grants nothing.

#### PR 76: `plan-loops-approval`

**feat(agents): loops and branches in model-written plans with one approval per loop**

Issues: #3788, #3785, #3775. Size: L. Stacks on: PR 75. Closes: #3785.

- **Scope.** #3788 PR 10. For each and Branch join the plan allowlist with their limits. A write Action inside a model-written For each: the engine resolves the items first and asks once for the whole loop (product owner decision of 2026-11-17); the card lists the items and the action. When the resolved count is above `maxForEachItems` (200) the run pauses with a question to the user; nothing is split into several approvals. A model-written plan has no nested For each, and both arms of a Branch arrive in the same amend. The approval stores a hash of the items, the item ids and a hash of the argument template; an item added or changed later is parked. Ask a person works inside a model-written loop. A revision in a tainted run that adds an external write step needs approval even when plan approval is off; every revision records the causing call and the taint.
- **Out of scope.** Per-item approval.
- **Files.** server/services/workflow/v2/loopApproval.js, amend.js, planSchema.js; server/services/run/seams/taintGate.js
- **Flags.** `agentPlannedMode`
- **Migrations.** none
- **Behaviour change.** A model-written plan can loop and branch.
- **Acceptance.**
  - A write Action inside a model-written For each asks once and shows the items; an item not shown is parked.
  - A changed item text after approval is parked. With 201 resolved items the run pauses with a question and shows no approval card.
  - A tainted run that adds an external write step shows an approval card although plan approval is off.
- **Tests.** Loop approval tests; tainted revision tests.
- **Docs and release entry.** docs/security.md (loop approval), docs/tool-approval.md. Release entry: none yet.
- **End-to-end check.** Script `plan-loop-writes`: one card lists three items, Approve, the harness counter is 3 (browser spec with the counter tool).
- **Risk.** The approval covers more than was shown. Guard: the item hash and the template hash.

#### PR 77: `plan-view`

**feat(chat): plan card, plan pane and revision history**

Issues: #3775. Size: L. Stacks on: PR 76.

- **Scope.** `client/src/features/chat/components/plan/`: `PlanCard`, `PlanSummary`, `PlanPaneItem`, `PlanApprovalBar`. Exactly one plan card in the stream; the plan lives in the workspace pane. The live view reads the plan endpoints and the `plan/revised` event; the final plan and the revision list are stored with the answer, so a reopened finished chat shows them from the chat. Each revision says what changed and why in plain words. Users approve, request changes or cancel; the plan is read-only. The free-mode to-do list uses the same pane. Strings `plan.*` in en and de; the German UI shows 'Mit Plan' and 'Fester Ablauf' and no mode name contains 'geplant'. 'Request changes' has a text field and the revised card replaces the first; a plan waiting for approval is listed under 'Needs you'.
- **Out of scope.** Editing a plan; turning a plan into a workflow.
- **Files.** client/src/features/chat/components/plan/**; client/src/features/workspace/**; server chat store (final plan and revisions with the answer); shared/i18n
- **Flags.** `agentPlannedMode`
- **Migrations.** none
- **Behaviour change.** A planned run shows its plan.
- **Acceptance.**
  - A planned run shows exactly one plan card; a reopened finished chat shows the final plan and its history.
  - Each revision shows what changed and why in words a non-developer can read.
  - Plan approval works by keyboard; the views pass axe.
  - 'Request changes' sends the text and the revised card replaces the first one.
- **Tests.** Client unit tests; tests/e2e-agents/plan.spec.js; a11y.
- **Docs and release entry.** docs/agents.md, glossary rows (plan, plan revision, open points). Release entry: none yet.
- **End-to-end check.** plan.spec.js: steps and revision history are shown, also after a reload in the middle of the run.
- **Risk.** Live and stored views differ. Guard: one component for both and the reload test.

#### PR 78: `planned-default-agent`

**feat(agents): default planned agent, legacy-reach guard and release protocol**

Issues: #3775, #3788, #3784. Size: M. Stacks on: PR 77. Closes: #3775, #3788.

- **Scope.** One planned-mode agent definition in `server/defaults/agents/`, added to existing installations by V267. `claude-style-agent.json` and `claude-style-agent-phased.json` stay unchanged and disabled. #3788 PR 11: a test that no model-written plan and no new-engine code reaches a legacy executor; the list of later deletions is handed to #3784. New `docs/agent-plans.md`. A manual model protocol is a checklist in `docs/run-testing.md`, to be run and filed for the release candidate: ten fixed planned-mode tasks on two open-weight models and one hosted model, recording end state, rounds, tokens and time; bar: on the recommended vLLM model 9 of 10 tasks end in a named end state without a plan-format error; a list-view check with a screen reader is part of it.
- **Out of scope.** Any deletion of legacy code.
- **Files.** server/defaults/agents/*.json; server/migrations/V267__add_default_planned_agent.js; server/tests/run/architecture.test.js; docs/agent-plans.md
- **Flags.** `agentPlannedMode`
- **Migrations.** V267 `add_default_planned_agent`
- **Behaviour change.** One planned-mode default agent is available.
- **Acceptance.**
  - Both `claude-style-agent` workflows still run; one planned-mode default agent exists next to them.
  - The guard test fails when new-engine code imports a legacy executor.
  - The manual protocol exists as a checklist with the three models and the 9-of-10 bar; running it is a release gate.
- **Tests.** Migration test; guard test; default agent run on a scripted model.
- **Docs and release entry.** docs/agent-plans.md (new, in SUMMARY), docs/agents.md, docs/workflows.md, docs/concepts.md (final table), docs/chat-evidence.md. Release entry: `features.md` 'Agents Plan Their Work and Finish with a Stated Result (Preview)'.
- **End-to-end check.** On a fresh install with the flags on, the default planned agent answers a scripted three-step task end to end.
- **Risk.** The manual protocol is never run. Guard: it is a named release gate with an owner.

## 5. Consolidated pre-mortem

Each row assumes the work was done and went wrong.

| # | What went wrong | Why | Prevention | Raised by | Owning PR |
|---|---|---|---|---|---|
| 1 | The run-service refactor shipped green and changed behaviour nobody saw: approval continuation, connect resume or a collaborator call was lost. | Goldens covered happy paths only, were recorded after the first refactor, or were refreshed inside a refactor PR; `chatTurn.test.js` spies on collaborators the new host no longer calls. | Goldens for seven surfaces and for the legacy workflow path, with pause, continue, connect resume and superseded turns recorded through the HTTP route, are recorded in the fourth pull request of the stack, before the first production change (the route refactor of slice A included) and with no production diff; a changed golden needs a signed row in `differences.json`; goldens read storage, not spies; chat tests run for both switch positions. | quality engineer, architect, engineer | goldens-difference-list, chat-turn-start |
| 2 | After the Agent Factory removal legacy workflows failed on import, the memory service broke and an upgrade from an old version stopped at a migration. | Frozen executors, `memoryService.js`, `tools/evidence.js` and the applied migrations V053 and V054 import `server/agents/**`, and `MemoryNodeExecutor.js`, `TransformNodeExecutor.js`, `memoryFile.js` and `inboxStore.js` import the two agent validator files; #3773 part A lists these files for deletion. | Narrowed removal: routes, pages and flag only; the two validators, `reviewSettings.js` and the profile loader stay. A test imports every executor and every migration module, the frozen-files test exists before the removal, and a boot test runs with old data present. An import failure is fixed by keeping the file. | architect, engineer, product manager | agent-factory-removal |
| 3 | A write ran twice after a restart, two writes ran at once in a chat, and a background sub-agent changed data. | 'Read-only' is not trustworthy today: 1 of 23 shipped tools declares `sideEffect`, internal tools default to `read`, a remote MCP server's hint counts as `read`, and the planner also batches writes with disjoint targets. | `isTrustedReadOnly` needs a declared `read`; `unknown` and annotation values count as writes for parallel calls, resume and sub-agents; a classification test covers every shipped and internal tool; chat uses `parallelMode: 'readOnly'`. | security expert, engineer | tool-side-effects-parallel-calls |
| 4 | The forced approval never fired and the mail was sent. | The taint rule was built as a stricter mode inside `approvalSeam`; `isGranted` runs first and a per-chat grant or a task's `alwaysAllow` let the call through. | The taint gate is its own seam before the approval seam; every cell of the #3785 table is tested with and without a standing grant. | security expert | taint-gate |
| 5 | An admin steered a user's run and approved a parked write in the user's name. | `authorizeLedgerRun` and `authorizeInteraction` let every admin and every holder of an anonymous run id through; new routes reused them. | A mandatory intent without a default for runs and for interactions; admins keep read and an audited cancel; a route inventory enumerates the Express router from slice A on, so a route without a row fails; an anonymous run needs the guest cookie for steer, stop and answer. | security expert | run-access-intents, admin-runs-api |
| 6 | The fail-open fix was built around a legacy path that no longer existed: goldens, a principal resolution and a flag alias for app tools of legacy prompt nodes. | The frozen `PromptNodeExecutor` registers `app__` tools only for an Agent Factory principal (`:565`, `:2276-2287`), and the only code that starts such a run (`routes/agents/runs.js:234`) is deleted by the removal PR. | Decided once in the removal PR: no run carries an agent principal afterwards, runs in flight are cancelled at boot, and a test pins that a legacy prompt node registers no app tool. No golden, no resolution and no alias are built. | security expert, plan review | agent-factory-removal, run-service-headless, sub-agents-flag-hidden-chats |
| 7 | A job picked up after a restart could not rebuild its turn, or answered from a different transcript. | The turn is assembled in an 850-line route closure from request-only inputs; the journal stores file references, not content. | The turn start is extracted first (`TurnRequest` as plain data); resume re-hydrates files and verifies `messagesHash`, and ends the run as interrupted on a mismatch; tests with an upload, a picture and a deleted file; the inputs that are not ids are stored as a turn snapshot on the user message, and a rebuild test in a second process compares the model request with the first start. | engineer, architect | chat-turn-start, chat-jobs-route, resume-after-restart |
| 8 | A chat showed 'interrupted' and then the answer arrived, or retention deleted a chat that was being resumed. | `chatRecovery` settles runs on read from presence maps, and `chatRetention` asks it whether a run is alive, while the executor was about to resume the job. | From PR `chat-jobs-route` both read the job record; the resume PR changes both in one diff so exactly one module settles a run; a fault test runs a retention sweep during resume. | architect, engineer | resume-after-restart |
| 9 | Two workers wrote the same answer, or healthy runs were aborted with a lost lease. | Fencing was added to some writes only; an event-loop stall during ingestion delayed heartbeats. | Four named chokepoints, each with a test; the SIGSTOP case in the nightly tier; takeover at 3 minutes and at least ten times the measured worst stall; the observed-sequence rule instead of clock comparison. | architect, quality engineer | worker-takeover |
| 10 | Slice B took months and shipped nothing a user could see; with `chatPostStream` on, turns did not survive a restart; a customer ran an untested switch combination. | Refactor PRs with no visible change and the switch-on left for later; #3777 was specified one day before #3793 and knows only the JSON transport. | The slice ends with the admin Runs page, the Activity page and the default flip; the new route serves both transports; the e2e matrix covers `chatPostStream` by `chatJobs`; a boot warning names unsupported combinations; the kill switch `chatOnRunService: false` resolves `chatJobs` to false, so it always lands on a tested path. | product manager, architect | chat-jobs-route, chat-jobs-default-on |
| 11 | #2712 was fixed a second time, the POST contract changed and the Office add-in broke. | The issue text is stale: the visible bug was fixed in v5.7.1. | The ticket is corrected first; the slice A PR is a proof plus client hardening and has no server diff. | product manager | long-turn-proof |
| 12 | A leftover steer was sent twice or lost; a queued message could not be removed with two workers; answers to workflow questions showed up as steers. | The server could not start a turn by itself, so the client re-sent; steers are relayed fire-and-forget without an id; `questionPause.js` reuses the `_steer` flag. | The server consumes the leftover under the chat lock and starts the next turn; the id is minted in the route and cancel is answered over the bus; real steers get their own field; a forked-worker test. | engineer, product manager | steer-contract |
| 13 | Users stopped long runs by accident, and the Outlook pane and Canvas showed a half-working composer. | Stop moved to where Send was; the new behaviour was keyed on `isProcessing` in a component five surfaces share. | Send keeps its place, Stop sits to its left, Enter never stops; the behaviour is an opt-in prop set only in `AppChat.jsx`; a unit test per other caller; the flag is off by default. | UX designer, UI designer | steer-composer |
| 14 | A card took focus while the user typed and Enter approved a write; screen-reader users heard changes twice or not at all. | `ApprovalCard` and `ClarificationCard` focus themselves unconditionally; `RunAnnouncer` only derives speech from chat messages, so each new component added its own live region. | One focus policy and one app-wide announcer before the first visible feature; a ratchet test on live regions; an e2e test that types while a card appears. | UX designer, UI designer | run-ui-parts |
| 15 | After slice B users could not find an answer that continued without the tab; later the badge always showed a number and was ignored; one approval was answered in two places. | The issue put the tray in slices C and D; the count mixed running and waiting work; two surfaces rendered answerable cards. | A first Activity page ships in slice B; the badge counts 'Needs you' only; the page links to the card in the chat and never answers. | UX designer | activity-page |
| 16 | At the upgrade a scheduled task ran twice and another never ran again; an admin's limit was lost or an old key stayed in the UI without effect. | Tasks run on the scheduler-lock owner today and the executor claims per worker; a run started by the old runner had no job; three issues name three different key lists. | The scheduler stays the due-finder; a switch-over rule with a test on documents written by v5.7.2; one migration, owned by PR `run-limits`, that removes the two moved keys from schema and UI. | engineer, architect | run-executor-scheduled, run-limits |
| 17 | An offboarded employee's scheduled work kept running with old groups and stored tokens. | A single-sign-on owner without a `users.json` record is never seen as deleted and the group snapshot never ages. | `principalMaxAgeDays` with a snapshot time that is written at the upgrade and refreshed on any authenticated request of the owner; a deleted-principal record with the deletion time, checked at claim; re-authorisation of the recipe at every claim, also when a run continues after waiting. | security expert | job-store, run-executor-scheduled |
| 18 | Sub-agent chats appeared in chat lists, search, exports and the per-user cap; token costs doubled. | Many code paths list chats by owner; sub-agents shipped before limits and usage marking. | One `isListableChat` predicate with a test over every listing call site; the limit refusal and the usage origin ship with the `delegate` PR. | architect, product manager | sub-agents-flag-hidden-chats, delegate-blocking |
| 19 | A report woke the parent, which delegated again, all night; a tainted wake wrote a summary into the chat and the next unattended run acted on it as clean. | No chain limit and a fresh budget per wake; the taint bit lived on the run only. | A generation counter, wakes per chat per hour and one budget along the chain; `taintedAt` on the chat and a mark on artifacts and notes. | security expert | taint-gate |
| 20 | An admin enabled follow-ups for a pilot and every user could schedule unattended wakes. | 'Unattended work' is the existing key `scheduledTasks`, which is true for all users. | The flag is off by default; the release entry and the flag description say what the permission now covers; open question 5 asks for a separate key. | product manager | follow-ups-server |
| 21 | A consent given for a harmless agent covered a mail integration added later; chat access of an own-identity agent was added to one read route only. | The consent was a boolean; run events, evidence, export and files used a different check. | A scope hash over tools, integrations and identity; one decision inside `authorizeChat`; the route inventory over every read path. | security expert | unattended-consent, agent-own-identity |
| 22 | After the scheduled-tasks rename, file upload to a task and audit links were broken, customer wording overrides were gone, and German users read 'Geplant' for three different things. | 19 files carry the API path; the server drops locale overrides for unknown keys; 'Geplante Aufgaben' already names scheduled tasks and the legacy plan list. | A path constant first and a grep gate; values change, keys stay; 'Geplant' only for schedules, 'Mit Plan' for the mode; an old and new path table in the breaking entry. | engineer, technical writer, UX designer | scheduled-api-rename, scheduled-ui-rename |
| 23 | A trigger started a version 2 workflow on the legacy engine; an Action step reached an internal service; an injected agent sent data out through a legacy workflow. | `TriggerManager.js:269` is missing from the dispatch list of #3788; a templated path or a redirect changed the target; legacy runs have no taint rule. | One `startWorkflow()` and a guard test; origin equality after `new URL`, manual redirects and `ssrf.allowedHosts` only; the legacy workflow tool is parked in tainted woken runs. | engineer, security expert | workflow-engine-dispatch, workflow-step-action, taint-gate |
| 24 | The law consultation rebuild never reached 'done'; the marketplace version gate was forgotten. | No document set and a sign-off by a person inside an agent-driven PR flow; the gate lives in another repository. | The merge gate is the side-by-side tool on synthetic fixtures with the five accepted differences; the sign-off is a dated release gate; the notice PR links the marketplace PR and the server check ships first; every default and marketplace workflow has a proposed disposition (section 2.7). | product manager, quality engineer | law-consultation-rebuilt, legacy-workflow-notice, default-workflows-disposition |
| 25 | The stack could not be merged: a review fix near the bottom forced dozens of rebases, migrations were renumbered and the locale files conflicted every time. | 78 branches, hot files (`ChatService.js`, `sessionRoutes.js`, `en.json`, `de.json`, `features.md`), and a CI check of migration numbers against each PR's base. | A merge point at the end of each slice; move-only PRs separate from change PRs; eight migrations in the whole epic with numbers assigned at merge; one locale block per feature; release files are append-only; `test:quick` on every branch after a rebase. | architect, engineer, product manager, technical writer | whole stack |
| 26 | 'Verified end to end' meant unit tests; an agent reported a browser check it could not have run, or lost hours on a red baseline. | No workflow runs the e2e suite; the default Node is 22, the installed Chromium does not match Playwright and the download is disabled; `test:server` can fail from memory pressure. | The first PR adds the stub, the agents suite and the PR gate; every PR names its browser or curl check and pastes the tail of each command's output; the baseline is recorded before the first commit; the e2e stack and `test:quick` never run together. | quality engineer, product manager | e2e-stub-and-gate |
| 27 | The fault tier went red in its first week and was switched to continue-on-error; a kill point was reachable in a customer installation; the harness reported one write when two had run. | Kills raced with sleeps and log lines; the guard was evaluated lazily; the counter lived inside the killed process. | Kill points write a reached-file; no sleeps (grep test); two conditions evaluated at import and an inventory test; the counter lives in the harness process and a self-test proves a double write is seen; a red nightly opens an issue that blocks the release candidate; the five test-tooling pull requests merge to main at once so the schedule runs from the default branch, and a label runs the tier on a branch. | quality engineer | fault-harness-nightly |
| 28 | Admin, Documentation described agents months before the menus existed; one capability had two release entries; 'job', 'lease' and 'thread' reached users; a new route showed 'Unable to connect to the server' on a cold load; the accessibility check went red when pages were removed. | Docs written ahead of features; issues assign the same entry twice; column names taken from API fields; a route added in `App.jsx` only; the axe list fails on a redirect. | Glossary and concept table grow per PR; one owner per breaking entry; the retired-words lint covers UI strings and flag texts; every route PR changes `App.jsx`, `KNOWN_ROUTES`, `client/index.html` and `CLEAN_PAGES` together and loads the URL directly at the root and under a subpath. | technical writer, UI designer, UX designer | glossary-wording-lint, every UI PR |
| 29 | Secrets appeared in job records and on the admin Runs page. | `needs[]` copied call arguments; redaction by key name missed a token in a URL. | The record holds ids only; arguments are read from the ledger for the owner; a test scans a stored document. | security expert | job-store, unknown-outcome-run-again |
| 30 | The guard test was green while raw MCP and A2A tool calls ran without the grant check, and later a workflow step called the model outside the run service. | `runTool` has seven direct callers and the planned regex matched only `.runTool(`; the guard watched `AgentLoop` only. | The guard matches a bare `runTool(` with an allow-list file; raw MCP and A2A calls move behind `ToolRunner`; the guard also forbids `LLMClient` and `runTool` imports under `workflow/v2/`. | engineer, architect | tool-runner, chat-on-run-service, workflow-steps-model |
| 31 | The two pull requests that needed nightly evidence could never merge. | GitHub runs `schedule` and `workflow_dispatch` only for workflow files on the default branch, and a slice reached main only after its last pull request, which needed three green nightly runs. | The five test-tooling pull requests at the bottom of the stack merge to main as each is approved; `nightly.yml` also runs on a pull request with the label `run-faults`; the entry condition of the default flip is three green runs of the fault tier on the head of the previous pull request. | plan review | fault-harness-nightly, chat-jobs-default-on |
| 32 | Between the executor and the resume pull request a scheduled run that was re-queued after a restart repeated its writes. | Re-queue on SIGTERM shipped three pull requests before the flush rule, resume from the journal and the unknown-outcome stop. | Until the resume pull request an interrupted job is settled as failed, as today; re-queue and pickup arrive together with resume; a nightly case proves the counter stays at 1. | plan review | run-executor-scheduled, resume-after-restart |
| 33 | Agent chats could be created but not written to or opened, and the documented rollback switch broke agents. | The only send path took an `appId`; the app-free route existed only with the job switch on; no pull request owned a chat page for a chat without an app. | The messages route is registered whatever the switch says; `TurnRequest.appId` is optional and the turn start dispatches by the chat's agent field; a recipe source `agent`; the chat page is its own pull request; the path is tested with the switch off and on. | plan review | chat-jobs-route, agent-chats-assembly, agent-chat-page |
| 34 | Browser checks that needed the counter tool, a seeded job or outside content were reported green without having run. | The Playwright stack ran with `NODE_ENV=development` and had no test tools; job records carry a seal from a per-installation key, so a static fixture cannot be seeded; `read_url` against localhost is stopped by the SSRF guard. | The agents helper starts the server with `NODE_ENV=test` and the test tools but without kill points, hosts the counter with `GET /__counter`, seeds jobs through `POST /__seed-job`, and `e2e_counter_read` is the offline outside-content tool; the checks name these. | plan review | fault-harness-nightly, job-store |
| 35 | After an untouched upgrade existing scheduled automations stopped at every run, and the only remedy was to switch on a preview feature. | The taint gate was planned for every scheduled run without a flag, while the consent that lifts it exists only on an agent. | Under the assumed answer the gate covers scheduled runs attached to an agent only; a blocking question puts the alternative (a consent per task, gate always) to the product owner; an upgrade test on the v5.7 fixture runs with `agents` off. | plan review | unattended-consent, taint-gate |
| 36 | A user who had been deleted and came back could not chat: every job was refused at claim. | The deleted-principal record was permanent and keyed by user id, and external ids are stable. | The record holds the deletion time and only jobs and events created before it are refused; a test deletes a user, signs in again and sends a message. | plan review | job-store |
| 37 | At the upgrade every task of a single-sign-on user paused, or the age rule never fired. | Snapshots written by v5.7.2 have no timestamp and nothing refreshes one; with proxy auth there is no sign-in event. | A missing timestamp counts from the first boot after the upgrade; any authenticated request of the owner refreshes the snapshot, at most hourly; fixture tests for OIDC and proxy owners. | plan review | run-executor-scheduled |
| 38 | An app called as a tool kept its write tools as a sub-agent, and inbound MCP app calls failed with an empty grant. | The grant of an app child was written without the read-only term, and no rule covered an app call that has no parent run. | The grant is parent, app tools and trusted read-only, with a test for both approval modes; a call without a parent run stays a root headless run, with a test per caller. | plan review | app-as-sub-agent, sub-agent-interactions |
| 39 | 'Behaves as before' changed without anyone deciding it: the prompt order moved and an implementing agent signed its own difference row. | Model requests were recorded but not asserted, and the signature was two JSON fields any pull request can edit. | A normalised projection of every model request is asserted; `CODEOWNERS` names the product owner for the difference list and a CI check ties a signature to an approving review. | plan review | test-foundations, goldens-difference-list |
| 40 | After a user was deleted, pending approvals with the content of parked writes stayed, and twenty stores were exempted in one line. | `interactions` has no cleanup step today, and the coverage test accepted an exemption for any store. | A small pull request of its own with an explicit table; a store filed under an owner id cannot be exempted; failed steps are stored and retried. | plan review | erasure-coverage |
| 41 | A pause written by v5.7.2 hung or ran twice after the upgrade. | Three pull requests change the shape of stored pauses (scheduled runs waiting for approval, the resume shape, the pending approval list) and only one had a fixture. | The v5.7 fixture holds a run in `awaiting_approval`, a chat with a pending approval and one with a pending connect; each of the three pull requests has a test on it. | plan review | run-executor-scheduled, durable-flush, sub-agent-interactions |
| 42 | Pull requests of 3,000 lines were waved through. | Six pull requests bundled two or three reviewable units, against the plan's own limit. | Seven splits, and a stop rule: an implementer who passes 1,500 changed lines outside tests and locale files stops and splits along the line the plan names. | plan review | whole stack |
| 43 | For ten pull requests admins could build no workflow at all, and eleven default workflows had no decision. | The rule 'no old node type can be added' landed with the schema, ten pull requests before the editor; the disposition named 3 of 18 default files. | The rule moves to the editor pull request; a table gives every default and marketplace workflow a proposed disposition and is a blocking question. | plan review | workflow-step-editor, default-workflows-disposition |
| 44 | The admin pages of this epic were built twice. | The product owner decided that the admin rework goes in first; both of its issues are open and the plan treated that as an assumption. | A blocking question before the first admin surface; a named re-check against the rework in the last pull request of slices B, E and F. | plan review | run-limits, chat-jobs-default-on, agent-webhook-triggers, default-workflows-disposition |
| 45 | After a long outage every missed follow-up fired at boot, and a replayed webhook passed on the second worker. | Events had no lateness bound; nonces and the rate limit were counted per worker. | `platform.followUps.maxLatenessMinutes`; the limiter in the cluster store and each nonce as a create-only document (row 48), with a two-worker test. | plan review | follow-ups-server, agent-webhook-triggers |
| 46 | Items from the test sections of the issues were never built: load tests, the identity matrix, `VERSION_CONFLICT`, the three-model protocol. | The coverage table mapped only the acceptance checklists. | Section 9 also maps the items of each 'Tests and definition of done' section, and each sits in the acceptance list of its pull request. | plan review | whole stack |
| 47 | A migration was written for tool files that no installation reads, and parallel calls still ran a tool that is read-only only by a remote server's annotation. | #2485 predates V195 to V211: tool files left `contents/tools/`, admin tools became integration actions, and `integrationTools.js:125` sets `readOnly` from the bare side effect, annotation included. | No migration in PR `tool-side-effects-parallel-calls`; the planner flag comes from `isTrustedReadOnly` at that line; a test covers a declared read, an undeclared action, an annotation-only read and an admin override. | panel chair, second check of the plan | tool-side-effects-parallel-calls |
| 48 | A run executed twice, mail included; a cancelled follow-up fired; a replayed webhook started a second run after a restart. | Conditional writes on the filesystem store are advisory: a `put` with an etag string compares under a lease that is taken over after 15 s, so a worker that stalled after the compare still wrote. Job claims, event claims, plan revisions and nonces rested on it or on the memory of one process. | Claim by create (section 2.8): the winner is decided by a create-only write under a key with the epoch, state lives in the holder's own epoch document, `assertHolder` runs after the durable flush and before the effect, and what the check cannot exclude ends as `needs attention`. A stalled-writer test per claim and a grep test against etag-string writes. | review of pull request 1 | job-store, run-executor-scheduled, chat-jobs-route, worker-takeover, delegate-blocking, chat-event-queue, follow-ups-server, background-sub-agents, agent-webhook-triggers, workflow-ready-set-durable-steps, plan-revisions-amend |
| 49 | A run was shown as failed and then performed its write, or two runs worked on one pool slot. | A worker settled the job of a holder whose heartbeat stood still. The holder had only stalled and continued after the settle, and no fencing existed before the takeover pull request. | Until PR 28 the job of another holder is touched only after the confirmed end of its process: the `exit` the primary saw, or an earlier start whose boot record shows the process gone (section 2.8). The heartbeat ground arrives together with the fencing, which includes a chokepoint at the start of a model call and of a step. A test pauses a live holder past `takeoverMs` before and after PR 28. | review of pull request 1 | job-store, run-executor-scheduled, resume-after-restart, worker-takeover |
| 50 | A chat ran two turns at once, a late worker replaced the answer the user had already read, two reports woke a parent twice, and a retried webhook was refused although nothing had started; in a container a second server started beside a live one. | The single run of a chat rested on the advisory chat lock, the answer on a check followed by a write, the wake on the order of two report claims, and the nonce was stored without its event; a pid was probed across PID namespaces. | One claim by create per chat run (`chat-run-claims`), which the wake uses as well; an answer claim per run, materialised from the claimed record only; nonce, event and `done` in a fixed order with completion by the retry; a follow-up consumed only after its admission is confirmed; the boot record carries the PID namespace, and what cannot be probed is observed. A stalled-writer or kill-point case each. | review of pull request 1 | run-executor-scheduled, chat-jobs-route, worker-takeover, follow-ups-server, background-sub-agents, agent-webhook-triggers |

## 6. Open questions

Implementation proceeds on the assumed answer. A question marked blocking stops the named pull request until the product owner has answered.

| # | Question | Recommendation | Assumed answer | Blocking | Affects | Raised by |
|---|---|---|---|---|---|---|
| 1 | In what form does the product owner sign the difference list of #3772, and under which GitHub login? | The approval of PR `goldens-difference-list` is the signature; `.github/CODEOWNERS` names the login for `differences.json` and a CI check ties `signedBy` to an approving review. This happens in slice A now. | As recommended. PR `tool-runner` and every later pull request with a difference row wait for it; PR `chat-turn-start` needs no signature, its goldens must be byte-equal. | yes | tool-runner and every later pull request with a difference row | quality engineer, product manager |
| 2 | After the Agent Factory removal a legacy prompt node can no longer get app tools, Agent Factory runs in flight at the upgrade are cancelled, and the two default agent profiles are no longer installed. Is that accepted? | Yes. App tools of a prompt node existed only inside an Agent Factory run; decision A4 says agent profiles are not used and a break for stored executions is acceptable. No alias for the old flag is needed. | Yes. The earlier question about an alias for `appAsTool` is withdrawn. | no | agent-factory-removal, sub-agents-flag-hidden-chats | engineer, plan review |
| 3 | Does the job-based chat send get a new route, or does the existing chat POST change from 200 to 202 (recommendation 18 of 2026-11-17)? | A new additive route `POST /api/chats/{chatId}/messages` (202 in JSON mode, the #3793 stream by Accept). The old route keeps its contract and submits the same job. No breaking entry and no shim. | New route. | no | chat-jobs-route | architect, engineer, product manager |
| 4 | When a message arrives while a run is active, does it replace the running turn as today, or is it refused with `CHAT_BUSY`? | Old route: replace as today. New route: an explicit `onBusy` of steer, queue or supersede; without it 409. | As recommended. | no | chat-jobs-busy-client | architect |
| 5 | 'Unattended work' is the existing permission `scheduledTasks`, which is true for all users today. Should follow-ups and background sub-agents get a separate key? | Reuse the key as #3780 says, keep both features behind flags that are off, and state in the release entry what the permission now covers. | Reuse and relabel. | no | follow-ups-server, background-sub-agents, agent-permissions-flag | product manager, technical writer |
| 6 | May the Agent Factory removal be narrowed (routes, pages, schemas, flag) and moved to the start of slice B, although #3773 part A lists `server/agents/` and `agentTools.js` for deletion? | Yes. The kept modules are imported by frozen legacy code and by two applied migrations; they go with the legacy path (#3784). | Yes. | no | agent-factory-removal | architect, engineer, product manager |
| 7 | #2712 was fixed in v5.7.1. Is its slice A work a proof test plus client hardening, with the early POST answer left to the job route? | Yes; no server change and no second fixes entry for the same bug. This departs from recommendation 2 of 2026-11-17 (answer the POST early in slice A): the early answer arrives with PR `chat-jobs-route`, which closes the issue. | Yes. | no | long-turn-proof | product manager, architect |
| 8 | Three flags that no issue names: `steering`, `parallelToolCalls` and `activity`, all preview and off. Is that wanted, and is `activity` switched on together with the default flip of chat jobs? | Yes to the three flags (decision A5). `activity` stays off after the flip; the chat list already marks running and unseen chats. | As recommended. | no | steer-contract, tool-side-effects-parallel-calls, activity-page | product manager, UX designer, UI designer |
| 9 | Which scheduled-task keys move into `platform.runs`, and do the old keys stay readable for one release? | Only `maxConcurrentRuns` and `maxConcurrentRunsPerUser` move; `maxRunMinutes` stays. The migration removes the two old keys; they are not left unread. | As recommended. | no | run-limits | engineer, architect, technical writer |
| 10 | One stop route or two? | The owner stops through `POST /api/runs/{runId}/human-events`; admins get the audited `POST /api/admin/runs/{runId}/_cancel`. `POST /api/runs/{runId}/_cancel` from #3196 is not built. | As recommended (recommendation 25 of 2026-11-17). | no | admin-runs-api, delegate-blocking | architect, engineer, security expert |
| 11 | Which names apply for agent chats: `agent.kind`, `agent-chats`, `taskId` (#3773) or `agent.thread`, `agent-threads`, `automationId` (#3787)? | The names of #3773, with the kind value `scheduled`. | The names of #3773. | no | agent-chats-assembly | architect, engineer |
| 12 | Do unattended runs of a human admin (scheduled task, follow-up, wake) keep admin rights? | No. They are removed for every origin other than a person; the row is on the difference list. | No; signed with the difference list. | no | run-service-headless, chat-on-run-service | security expert |
| 13 | Is 30 days the right maximum age of a group snapshot? It pauses scheduled runs of single-sign-on users who have not signed in for 30 days. | 30 days, 0 disables; a breaking entry. A task written before the upgrade counts from the first boot after it, and any authenticated request of the owner refreshes the snapshot. Consider 7 days when the run can write to external systems. | 30 days, configurable. | no | job-store, run-executor-scheduled | security expert |
| 14 | May an admin approve a parked write or a tool approval of another user's run? | No. An admin may cancel or stop; the call would run with the user's rights. | No. | no | run-access-intents | security expert |
| 15 | In a tainted unattended run: do standing grants count, is the taint kept on the chat for later unattended runs, and how long may a chain of wakes run? | Grants do not count; the taint is kept on the chat; 3 generations, 10 wakes per chat per hour, one shared budget. | As recommended. | no | taint-gate | security expert |
| 16 | Does the taint gate apply to scheduled tasks that are not attached to an agent? #3783 promises that scheduled tasks work as before while `agents` is off; recommendation 55 puts the consent on an agent only; #3785 open question 3 is unanswered. | Two options. (a) The gate covers scheduled runs attached to an agent only; plain tasks keep their `alwaysAllow` behaviour until agents leave preview. (b) The gate covers every scheduled run, lifted by a consent of the task owner on the task (same scope hash and audit), with a breaking entry. The security expert recommends (b); the panel chair recommends (a) for this release, because it changes nothing for existing customers and contradicts no decision. | (a). The pull request is specified for both, so the answer changes its scope, not its design. | yes | unattended-consent, taint-gate | panel chair, security expert, plan review |
| 17 | The scheduled-tasks API break buys only a name. Is the clean break still wanted, and is `/api/schedules` the path? | Decision 13 stands: clean break to `/api/schedules` and `/api/admin/schedules`, error codes unchanged. | Clean break to `/api/schedules`. | no | scheduled-api-rename | product manager |
| 18 | May a first Activity page (Needs you, Running) ship in slice B, as a page `/activity` that links to the chat and never answers an approval? Names 'Activity' / 'Aktivität' and 'Runs' / 'Läufe'? | Yes to all. | Yes. | no | activity-page, admin-runs-page | UX designer, UI designer |
| 19 | In which language does the server send reasons and action labels? | A key, parameters and an English fallback; the client translates. State names are a fixed enum translated on the client. | As recommended. | no | unknown-outcome-run-again, activity-page | UX designer, UI designer, technical writer |
| 20 | Are the German words accepted (Aktion erforderlich, Erledigt, Blockiert, Keine Änderung, Wiedervorlage, Geplant, Bereitgestellter Agent, Unbeaufsichtigte Ausführung), and who owns German wording? | Yes; the glossary of PR 2 is binding and each UI PR gets a wording review against it. | Yes. | no | glossary-wording-lint and every UI PR | technical writer, UI designer, UX designer |
| 21 | Who owns a red nightly and the parity set, which vLLM model is the reference, who runs the manual screen-reader passes, and when is the law consultation sign-off? | The product owner names one person and one model. The agents deliver scripts and checklists. These are release gates, not merge gates. | Release gates; implementation does not wait. | no | release candidates of slices A, B, F and G | quality engineer, UI designer, product manager |
| 22 | Is one release cut per slice, and may each slice be merged to main when its last PR is approved? | Yes. The stack stays linear; the next slice starts from the merged state. Switches kept 'for one release' end with the next slice's release. | Yes. | no | whole stack | architect, product manager, engineer |
| 23 | Are test-only kill points and a test-only counter tool in production code acceptable, may `e2e.yml` be a required check, and is a nightly of up to 60 minutes acceptable? | Yes to all, with two guards on the kill points and a 10-minute budget for the PR gate. | Yes. | no | e2e-stub-and-gate, fault-harness-nightly | quality engineer |
| 24 | May the same agents open the pull request in `ihub-marketplace` for the version gate? | Yes, as a separate PR linked from PR `legacy-workflow-notice`. | Yes. | no | legacy-workflow-notice, rebuilt-iterative-research, default-workflows-disposition | product manager, engineer |
| 25 | Which runs are never resumed after a restart, and may guests use `delegate`? | Not resumed: guest, anonymous and temporary chats, `/v1`, MCP and A2A inbound, and a turn that started a legacy workflow. Guests may delegate blocking inside one turn, never in the background. An inbound MCP or A2A call for an app stays a root headless run with the caller's grant; it never becomes a child run. | As recommended. | no | chat-jobs-route, delegate-blocking, background-sub-agents | architect, security expert |
| 26 | For a free URL in an Action step: is 'admin only' checked at save, and does `ssl.domainWhitelist` still imply trust for private targets? | Checked at save, recorded and audited; only `ssrf.allowedHosts` exempts a private target for this step. | As recommended. | no | workflow-step-action | security expert |
| 27 | `WebhookTrigger.test.js` shows that `verifyRawSignature` accepts a signature over a re-serialised body. Is that a defect of the legacy webhook trigger? | File a separate bug; the test stays quarantined with the issue number. It is outside this epic. | Separate bug. | no | test-foundations | quality engineer |
| 28 | The product owner decided that the admin rework (#3739, #3742) goes in before this epic and that the epic is re-checked against it. Both issues are open; only the 'Now' phase (#3796) is on main. Do the admin surfaces of this epic wait? | No: build on main with the shared admin parts that exist (DataTable kit, `ConfirmDialog`, the config-section guard of #3796), and re-check at the end of slices B, E and F. This needs the product owner's explicit waiver of the sequencing decision. | Build on main; the re-check is a task of PRs `chat-jobs-default-on`, `agent-webhook-triggers` and `default-workflows-disposition`. On 'wait', each admin surface is left out of its pull request and follows the rework; the server parts merge as planned. | yes | run-limits (first admin surface), admin-runs-page, follow-ups-server and agent-permissions-flag (group editor), provided-agents, agent-own-identity, legacy-workflow-notice, workflow-step-editor | engineer, product manager, architect, plan review |
| 29 | Which default and marketplace workflows are rebuilt, replaced by an app or left as legacy? Decision A6 says each existing workflow is challenged; `server/defaults/workflows/` holds 18 files. | The table in section 2.7: three rebuilt workflows besides the law consultation (`corpus-analysis`, `iterative-research`, `approval-example`), two replaced by apps, the rest left as legacy files with the label. | The table in section 2.7. | yes | rebuilt-corpus-analysis, rebuilt-iterative-research, default-workflows-disposition | product manager, plan review |
| 30 | `GET /api/runs` is an admin list today (`{ items, persisted }`). It moves to `GET /api/admin/runs` and the path becomes the signed-in user's own list. Clean break, or both for one release? | Clean break with a breaking entry; no client code calls the old list and the repository rule asks before a shim is added. | Clean break. | no | admin-runs-api, activity-page | plan review |
| 31 | #2485 asks for a stored tool flag `readOnly: true` and a migration for tool files in `contents/tools/`. The plan stores no second flag, derives read-only from a declared `sideEffect: 'read'`, and writes no migration because that directory is no longer read. Accepted? | Yes; one declaration serves approvals, parallel calls, resume and sub-agents, and admin tools are custom integrations since V211. | Yes. | no | tool-side-effects-parallel-calls | plan review |
| 32 | May the five test-tooling pull requests at the bottom of the stack merge to main as each is approved, ahead of slice A? | Yes; they have no production diff except the inert kill point module and the test tool registration, and the scheduled nightly needs its workflow file on main. | Yes. | no | e2e-stub-and-gate to fault-harness-nightly | plan review |
| 33 | If the run-to-run noise of the time-to-first-token measurement in CI is above 10 %, may that gate become a release gate measured by a person? | Yes; the pull request still reports the back-to-back numbers. | Yes. | no | chat-on-run-service, chat-jobs-route, chat-jobs-default-on | plan review |
| 34 | A webhook trigger needs a provided agent with its own identity, and a parked write of a triggered run is approved by the users named in the agent's chat access. Accepted? | Yes (recommendation 67 of 2026-11-17); an agent that runs as the user has no user present at a webhook. | Yes. | no | agent-webhook-triggers | plan review |
| 35 | User deletion will also delete stores it leaves behind today (run ledger entries, artifacts, provenance records, workflow state, integration conversations, skill versions, pending approvals). Must any of them be kept for audit? | Delete all that are filed under the user; the evidence record keeps its existing rule. | Delete all. | no | erasure-coverage | plan review |
| 36 | An app called as a tool by a model loses its write tools in this release, because sub-agents are read-only. Existing concierge apps that relied on a writing app are affected. Accepted? | Yes, by decision 8 of round 2; the upgrade check lists the affected apps and the breaking entry says what to do (let the parent call the write tool itself). | Yes. | no | app-as-sub-agent | plan review |
| 37 | A parked approval or question of a run under an agent's own identity has no human owner. May the users named in the agent's `chatAccess` answer it, for every such run and not only for a webhook-triggered one (question 34)? | Yes, and nobody else: no admin outside the grant, no holder of a link. The alternative, nobody answers and the run ends `needs attention`, would make question 34 and scheduled own-identity agents with write tools unusable. | Yes; PR 53 builds the rule in `authorizeInteraction` with tests for a grantee and a stranger. | no | agent-own-identity, agent-webhook-triggers | review of pull request 1 |

## 7. Decisions the panel took on its own

| # | Decision | Reason | By | Affects |
|---|---|---|---|---|
| 1 | The stack has 78 pull requests in one linear order, with a merge point at the end of each slice. | The issues' own PR lists add up to more than 60, and three PRs the issues define are too large to review (`runTurn` plus `_finishTurn` is 1,200 lines; #3777 PR 4). Fewer PRs would mean PRs above 1,500 lines. | panel chair | whole stack |
| 2 | #2712 in slice A is a proof test plus client hardening, with no server change. | The visible bug was fixed in v5.7.1 (verified in `useAppChat.js:529-541` and `docs/releases/5.7.1/fixes.md`). | product manager, architect, panel chair | long-turn-proof |
| 3 | A refactor PR in slice A moves the start of a chat turn out of the route. | Leftover steers, job recipes and wakes all need to start a turn without an HTTP request. | engineer | chat-turn-start |
| 4 | The Agent Factory removal is narrowed to routes, pages, strings, the flag and the default profiles, and is the first pull request of slice B. The two validators, `reviewSettings.js` and the profile loader stay. | Frozen executors and kept modules import them; the removal takes a run kind, an engine start site and a `runTool` caller out before the run service is built. | architect, engineer | agent-factory-removal |
| 5 | Chat, scheduled runs and both `/v1` routes move onto the run service together: first a move-only PR into `ChatHost`, then the switch-over. | All of them call `ChatService.runTurn`; the order 'scheduled and /v1 first, chat last' of #3772 is not possible. | architect, engineer | chat-host-move, chat-on-run-service |
| 6 | Slice B has two internal switches only: `platform.runs.chatOnRunService` (kill switch, default true) and `platform.runs.chatJobs` (false, flipped by the last PR of the slice). There is no separate switch for resume. | Each further switch doubles the chat paths to test. | panel chair | chat-on-run-service, chat-jobs-route, chat-jobs-default-on |
| 7 | Security controls ride on the feature PRs, except two standalone ones in slice A: run access intents and tool classification. | Several later PRs depend on them and each is small enough to review alone. | security expert | run-access-intents, tool-side-effects-parallel-calls |
| 8 | A stored job or event record never grants a right: the principal is rebuilt and the recipe re-authorised at claim; the HMAC seal is defence in depth with HKDF sub-keys of the existing key. | The key sits on the same volume as the records. | security expert | job-store, chat-event-queue |
| 9 | The taint gate covers woken runs (follow-up, sub-agent report, handoff, webhook) from slice D, and from the consent pull request the scheduled runs that are attached to an agent. Plain scheduled tasks are not covered under the assumed answer to the blocking question. | Otherwise existing scheduled tasks would hold writes with no way to lift it while agents are a preview feature. | panel chair | taint-gate, unattended-consent |
| 10 | #3780 is spread over three slices (flag `subAgents` in C, `followUps` and the permission label in D, permissions and flag `agents` in E), and #3781 over four PRs (usage dimensions, limits block, quota in the executor, identity quota). | A flag lands with the feature it switches; the issues depend on each other in a circle. | product manager, technical writer | sub-agents-flag-hidden-chats, follow-ups-server, agent-permissions-flag, run-envelope-taint-usage, run-limits |
| 11 | Eight migrations in the whole epic (V260 to V267); numbers are assigned at merge; no pull request extends a migration of an earlier one; the tool side-effect declaration needs none. | CI checks migration numbers against each PR's base, so a stack renumbers on every unrelated merge. | engineer, panel chair | PRs 19, 33, 43, 65, 70, 71, 72, 78 |
| 12 | The limits block lands before the job store; the concurrency migration is owned by PR `run-limits` alone. | The executor reads the block from its first commit; three issues claimed the migration. | architect, engineer, panel chair | run-limits |
| 13 | Shared UI parts (state badge, pending strip, app-wide announcer, focus policy, toast host) are one PR before the steering composer; `ClarificationCard` stops being a modal dialog. | #3191 is their first user, two slices before #3196; an enabled composer and a document-level Tab trap do not fit together. | UX designer, UI designer | run-ui-parts |
| 14 | Composer: Stop sits left of Send, DOM order equals visual order, 'send afterwards' is a menu item with Alt+Enter, and the behaviour is an opt-in prop. | A click on the old position must never stop a run; Office and Canvas share the component. | UX designer, UI designer, panel chair | steer-composer |
| 15 | A first Activity page ships in slice B behind the flag `activity`; it is a page, its badge counts only what needs the user, and it never answers an approval. | From slice B a turn continues without the tab and can end as needs attention. | UX designer | activity-page |
| 16 | `/admin/runs` uses the DataTable kit with eight columns and a detail drawer. | Thirteen columns do not fit without horizontal scroll. | UI designer | admin-runs-page |
| 17 | State names are a fixed enum translated on the client; reasons, titles and actions come from the server as key, parameters and English fallback. | Labels must be overridable through `shared/i18n`; the server still decides what a thing is. | UI designer, UX designer, technical writer | run-ui-parts, unknown-outcome-run-again |
| 18 | The glossary and the concept table describe only shipped features and grow per PR; the retired-words list is complete from the first PR. Renames change i18n values and keep keys; `docs/scheduled-tasks.md` keeps its file name. | Docs ship inside the product; the server drops customer overrides for unknown keys. | technical writer | glossary-wording-lint, scheduled-ui-rename |
| 19 | One owner per upgrade entry: limits and ceiling in `run-limits`, fail-open in `run-service-headless`, admin rights of unattended runs in `chat-on-run-service`, the admin run list in `admin-runs-api`, `appAsTool` in slice C, API path in `scheduled-api-rename`, Agent Factory in its removal PR, legacy notice in `legacy-workflow-notice`. Refactor PRs and fixes to unshipped behaviour get no entry. | The issues assign four of these entries twice. | technical writer | all PRs with a release entry |
| 20 | The first five PRs of the stack are test tooling (e2e stub and Chromium gate, glossary, harnesses, goldens, fault harness) and merge to main as each is approved; agent specs live in `tests/e2e-agents/` with their own config and contents directory; goldens are plain JSON files; fault tests are a nightly tier. | No workflow runs the e2e suite today; the default Playwright config has seven browser projects and retries. | quality engineer | e2e-stub-and-gate, test-foundations, fault-harness-nightly |
| 21 | Every PR pastes the tail of its test and e2e command output into the PR body; a PR that adds a quarantine entry or changes a golden without a row is not mergeable. | The implementers are AI agents; a claim needs evidence a reviewer can read. | quality engineer | whole stack |
| 22 | The steer id is minted in the route, real steers get their own field, and cancel is answered over the bus. | The relay is fire-and-forget and `questionPause.js` reuses the `_steer` flag. | engineer | steer-contract |
| 23 | `SchedulerService` and the scheduler lock stay as the due-finder; only execution becomes a job. Legacy workflow executions never get a job. | The lock is shared with workflow triggers and goes with the legacy path. | engineer, architect | run-executor-scheduled |
| 24 | Fencing at four chokepoints (the start of a model call or step was added with decision 52), takeover by an observed heartbeat sequence, resume verified against `messagesHash`. | Fencing every write cannot be tested completely; clocks of workers are not compared; a silent transcript difference is worse than no resume. | architect | worker-takeover, resume-after-restart |
| 25 | The owner stops a run through human-events; admins use an audited route under `/api/admin`. The names of #3773 win over those of #3787. | Recommendation 25 of 2026-11-17; 'chat' and 'Scheduled' are the product owner's words. | panel chair | admin-runs-api, agent-chats-assembly |
| 26 | The flag for planned mode is the flat id `agentPlannedMode`; background delegation is the config key `platform.runs.subAgents.background`, not a feature flag. | Registry ids are flat; background mode needs `subAgents` anyway. | engineer, product manager | planned-mode, background-sub-agents |
| 27 | The rebuilt law consultation workflows get new ids; the sign-off, the manual model protocol and the screen-reader passes are release gates, not merge gates. | Recommendation 81; a person signs and no fixed document set exists. | product manager, panel chair | law-consultation-rebuilt, planned-default-agent |
| 28 | The open questions of 2026-11-17 count as accepted at their recommendation unless this plan lists them again. | The comment says none blocks and an 'ok' accepts them. | product manager, panel chair | whole stack |
| 29 | Not built in this stack: browser push (#3198), writing sub-agents, depth above 1, messaging a running sub-agent, editing a follow-up, steering in the Office add-in and the extension, a default assistant, 'run as the creating admin', sharing a personal agent, a version-history UI, legal hold, multi-pod, removal of the legacy path, an outline-first editor, user-edited plans, fixed mode on personal agents, legacy runs on `/admin/runs`. | Each is excluded by a product owner decision or by the scope section of its issue. | product manager | whole stack |
| 30 | Test foundations, goldens and the fault harness move in front of the first production change of slice A. | The first large chat refactor (the turn start) sat before the goldens; the nightly needs its workflow file on main. | panel chair after the plan review | test-foundations, goldens-difference-list, fault-harness-nightly |
| 31 | The legacy workflow path is characterised with the goldens: frozen-file hashes, both law consultation variants on synthetic input, a paused and resumed run, a run resumed after a restart, a trigger-started run. | #3788 PR 0 (b) needs them and ten pull requests touch code next to the legacy path before slice F. #3786 excludes a golden for the rebuilt report and a fixed set of real documents; neither is built. | panel chair after the plan review | goldens-difference-list, workflow-engine-dispatch |
| 32 | No alias for `appAsTool`, no resolution of a legacy agent principal, no legacy `app__` golden. Agent Factory runs in flight are cancelled at boot; the default agent profiles are no longer installed. | The path is unreachable once the Agent Factory routes are gone; decision A4 accepts the break. | panel chair after the plan review | agent-factory-removal, run-service-headless, sub-agents-flag-hidden-chats |
| 33 | Until resume exists, a scheduled run interrupted by a restart fails as today. Re-queue and pickup arrive with the resume pull request. | A second start before the flush rule would repeat writes. | panel chair after the plan review | run-executor-scheduled, resume-after-restart |
| 34 | A turn snapshot (model, style, output format, language, time zone, approval capability, integration ids, file ids) is stored on the user message; integration tokens are resolved again at claim; a job is not resumable when the run ledger is off. | A recipe of ids alone cannot rebuild a turn. | panel chair after the plan review | chat-jobs-route |
| 35 | `POST /api/chats/{chatId}/messages` exists whatever `chatJobs` says, and `chatOnRunService: false` implies `chatJobs: false`. | Agents need an app-free send path under the rollback switch too, and the kill switch must land on a tested combination. | panel chair after the plan review | chat-jobs-route, agent-chats-assembly |
| 36 | The deleted-principal record carries the deletion time; a snapshot without a time counts from the first boot after the upgrade; any authenticated request of the owner refreshes it, at most hourly. | Stable external ids; no timestamp in v5.7.2 snapshots; no sign-in event with proxy auth. | panel chair after the plan review | job-store, run-executor-scheduled |
| 37 | The mandatory intent for interactions and the route inventory are built in slice A, and the inventory enumerates the router. | Six routes are added before the admin Runs work; a per-PR test does not catch a forgotten route. | panel chair after the plan review | run-access-intents |
| 38 | User-deletion coverage is a pull request of its own in slice B; a store filed under an owner id cannot be exempted. | The job store pull request is large and dark; pending interactions hold parked writes from slice D on. | panel chair after the plan review | erasure-coverage |
| 39 | An app child gets parent, app tools and trusted read-only; an app call without a parent run stays a root headless run; the upgrade check is an admin route plus boot log lines. | Decision 8 of round 2 excludes writing sub-agents; inbound MCP and A2A have no parent grant. | panel chair after the plan review | app-as-sub-agent |
| 40 | A brief under 40 characters or equal to an earlier brief of the run is refused; files are checked against the parent's access at delegation; four per-sub-agent limits sit in `platform.runs.subAgents`. | #3196 names the rules without values. | panel chair after the plan review | delegate-blocking, run-limits |
| 41 | The existing admin list on `GET /api/runs` moves to `/api/admin/runs` as a clean break; `/api/runs` becomes the caller's own list without a `mine` parameter. | A missing filter must never return other users' runs. | panel chair after the plan review | admin-runs-api, activity-page |
| 42 | Seven pull requests are split (chat jobs, admin runs, scheduled rename, provided agents, handoff and webhooks, basic steps, default workflows), the agent chat page is its own pull request, and a 1,500-line stop rule applies to all. | Each bundled two or three reviewable units. | panel chair after the plan review | whole stack |
| 43 | The rule that no old node type can be added moves from the schema pull request to the editor pull request. | Until the editor exists the canvas is the only way to build a workflow. | panel chair after the plan review | workflow-step-schema, workflow-step-editor |
| 44 | Proposed dispositions for all 18 default workflow files and 6 marketplace workflows (section 2.7); each rebuilt workflow is its own pull request with its own migration. | Decision A6; a later pull request never extends an earlier migration. | panel chair after the plan review | rebuilt-corpus-analysis, rebuilt-iterative-research, default-workflows-disposition |
| 45 | A version 2 workflow has a top-level `delegation` setting; a webhook trigger needs an agent with its own identity; the trigger rate limit uses the cluster store and a nonce is a create-only document (decision 51); `platform.followUps.maxLatenessMinutes` is 60. | Decision 7 of round 2 names workflows; no user is present at a webhook; the supported topology has several workers; a restored backup must not replay old follow-ups. | panel chair after the plan review | workflow-step-schema, agent-webhook-triggers, follow-ups-server |
| 46 | The performance gate compares base and head back to back in one job (five repetitions, medians); e2e specs carry tags, the pull request job runs `@gate` and the mapped specs, the matrix runs nightly from PR 5 on and by hand until then. | Noise in a shared runner is above 10 %; platform switches need a server restart. | panel chair after the plan review | chat-on-run-service, e2e-stub-and-gate |
| 47 | #2485 is delivered with a declared `sideEffect` and no stored `readOnly` flag; #2712 is closed by the messages route, not by the proof; the plan file is added to `concepts/` by the first pull request. | The tool files gained `sideEffect` after #2485 was written; two of four #2712 items arrive in slice B; twenty ticket comments cite the plan file. | panel chair after the plan review | tool-side-effects-parallel-calls, long-turn-proof, chat-jobs-route, e2e-stub-and-gate |
| 48 | A loop above `maxForEachItems` pauses with a question; it is not split into several approvals. | The product owner decided one approval for the whole loop, and #3788 specifies the question. | panel chair after the plan review | plan-loops-approval |
| 49 | No migration for tool side effects. Every sub-issue is closed by the last pull request that delivers one of its items (the `Closes` note of that pull request in section 4). Two stay open: #3784, whose removal of the legacy path is a later release, and the deferred #3198; so the epic stays open too. | `contents/tools/` is no longer read (V199, V202, V211; `integrationTools.js:125` already carries the side effect of an action). A closing pull request per issue lets the board follow the stack. | panel chair, second check of the plan | tool-side-effects-parallel-calls; the closing pull request of each sub-issue |
| 50 | An interaction of a run under an agent's own identity is answered by the users named in the agent's `chatAccess` and by nobody else; an admin outside the grant keeps cancel only. Taken without the product owner (open question 37). | PR 7 lets only the owner answer, and an agent identity cannot; PR 53 already resolved `answer` on the run through the chat and PR 56 already offered the parked write to these users, but `authorizeInteraction` had no rule. The narrowest rule that keeps both was chosen. | panel chair after the review of pull request 1 | agent-own-identity, agent-webhook-triggers |
| 51 | Exclusivity is decided by a create-only write everywhere (claim by create, section 2.8): job epochs, the run of a chat, the answer of a run, event claims, plan revisions, webhook nonces, the quota records. A `put` with an etag string and `withLock` never decide a winner. | The filesystem provider enforces only the exclusive create by itself; the etag compare runs under an advisory lease that is taken over from a stalled holder, and a double claim would repeat a write. | panel chair after the review of pull request 1 | job-store, chat-jobs-route, worker-takeover, chat-event-queue, follow-ups-server, background-sub-agents, agent-webhook-triggers, workflow-ready-set-durable-steps, plan-revisions-amend |
| 52 | Until takeover with fencing exists (PR 28), a worker acts on the job of another holder only after the confirmed end of that process: the exit the cluster primary saw, or an earlier server start whose process is gone. One server per contents directory is enforced on one host by a create-only boot record. A holder that is alive and silent keeps its job and its pool slot until PR 28. | A standing heartbeat does not prove that a process ended. Settling a stalled holder lets it perform effects after its run was shown as failed and lets a second run start on its slot. A killed worker is still handled promptly, because the primary sees its exit. | panel chair after the review of pull request 1 | job-store, run-executor-scheduled, resume-after-restart, worker-takeover |
| 53 | The boot check probes a pid only inside its own PID namespace and observes the record in every other case; an operator can override a refusal for one start with `IHUB_FORCE_BOOT=1`, which is logged, audited and recorded. | Containers on one host share a hostname and each server is pid 1, so a probe across namespaces lets a second server start; a check that can refuse a start wrongly needs a way out that leaves a trace. | panel chair after the review of pull request 1 | run-executor-scheduled |
| 54 | A stored chat has one run at a time by a claim by create per chat; `chat.activeRunId` is a display field. A post that finds the chat busy, or loses the create, answers `CHAT_BUSY` and is never queued behind the claim by the server on its own. | The chat lock is advisory, and two runs in one chat write one transcript; queueing is the user's choice through `onBusy`. | panel chair after the review of pull request 1 | chat-jobs-route, chat-jobs-busy-client, chat-event-queue, background-sub-agents |

## 8. Resolved disagreements

| Topic | Positions | Resolution |
|---|---|---|
| State of #2712 | Product manager and architect: fixed in v5.7.1. Engineer and quality engineer: still open, because the JSON POST is answered only when the turn ends. | Both facts are true. The visible bug is fixed on the client; the POST is still held. Slice A proves and hardens; the early answer comes with the job route. |
| Chat POST and 202 | Architect: a new additive route. Engineer, quality engineer: the existing POST answers 202 behind a switch. Product manager: 202 in JSON mode only. | New route `POST /api/chats/{chatId}/messages`; the old route keeps its contract. Additive, no breaking entry. |
| Internal switches in slice B | Architect: no switch for the refactor, one switch for resume only. Engineer, product manager, quality engineer: a switch for the chat path and one for jobs. | Two switches (`chatOnRunService`, `chatJobs`). The move-only PR keeps the 'off' path small, which answers the architect's objection of two copies of `runTurn`. |
| When the Agent Factory goes | Architect, engineer: start of slice B. Product manager, UI and UX designers: start of slice E. | Start of slice B, narrowed. #3773 says 'at once', and it shrinks what #3772 has to characterise. |
| Flag for parallel read-only tool calls | Product manager: preview flag, off. Architect, engineer: on, with a per-model opt-out. | Flag `parallelToolCalls`, off, plus the per-model opt-out. |
| When the user's tray ships | UX designer: a first version in slice B. UI designer and #3782: slices C and D. | A first Activity page in slice B behind the flag `activity`; sub-agent rows in C, 'Scheduled' in D. |
| Cancel route | Architect: `POST /api/runs/{runId}/_cancel` for owner and admin. Engineer: human-events only. Security expert: an audited admin route. | Owner: human-events. Admin: `POST /api/admin/runs/{runId}/_cancel`. |
| Limit keys | Architect: move three keys and remove the old ones. Engineer: move two, leave the old ones unread for one release. Product manager: #3777 owns the migration. | Two keys move, `maxRunMinutes` stays, the old keys are removed in the same PR, and PR `run-limits` owns the migration. |
| Usage dimensions | Product manager, quality engineer, engineer: a small PR before the refactor. Architect: together with the envelope after it. | With the envelope, after the run service exists, because the context supplies origin and agent id; one signed difference row. |
| Announcements | UX designer: an app-wide provider. UI designer: an `events` input on `RunAnnouncer` plus a toast host. | The app-wide provider with one live region; the tray and toasts live outside the chat. |
| Composer controls | UX designer: Tab order Send, options, Stop; 'send afterwards' as a menu item. UI designer: DOM order equals visual order; a text button from `sm` up. | Stop, Send, menu, with DOM order equal to visual order; 'send afterwards' is a menu item at every width. |
| Several cards at once | UX designer: all cards visible in a list. UI designer: one card with Previous and Next. | All visible; the acceptance criterion of #3196 says both stay visible. |
| German words | UI designer: 'Braucht Ihre Aufmerksamkeit', 'Fertig', 'Laufende Arbeit'. Technical writer and UX designer: 'Aktion erforderlich', 'Erledigt', 'Aktivität'. | The technical writer's words; the glossary is binding. |
| Shape of the stack | The task asks for one stack. Architect, engineer, product manager: one stack per slice, merged before the next. | One linear order; each slice end is a merge point, so both hold. |
| Size of the risky PRs | Architect: `ChatHost` and #3777 PR 4 as one PR each. Engineer: split in two and three. | Split as the engineer proposes; the steer server contract is one PR after the owner rule was taken out. |
| Language of server-sent labels | UX designer: a key with an English fallback. UI designer: a reason code, text on the client. Technical writer: keys in `shared/i18n`. | Key, parameters and English fallback from the server; the client translates. |
| Taint gate for scheduled tasks without an agent | Security expert and two reviewers: the gate covers every scheduled run, lifted by a consent on the task. Product manager and #3783: scheduled tasks work as before while `agents` is off; recommendation 55: the consent exists only on an agent. | Assumed: attached scheduled runs only. The alternative is specified in the same pull request and the choice is a blocking question for the product owner. |
| A golden for the law consultation | #3786: no law consultation golden and no fixed document set. #3788 PR 0 (b) and two reviewers: the legacy runs must be pinned before code next to them changes. | The legacy path is characterised on synthetic input with the goldens. There is still no golden for the rebuilt report and no set of real documents; people read the side-by-side output. |
| App tools of legacy prompt nodes | Engineer: keep them through an alias for the old flag. Reviewers: the path needs an Agent Factory principal and is dead after the removal. | Dropped: no alias, no principal resolution, no golden; a test pins the path as unreachable. |
| Where the nightly evidence comes from | Reviewer 1: merge the test-only pull requests early. Reviewer 3: dispatch on the branch, or merge slice B before the flip. | Both: the five test-tooling pull requests merge at once, and a label runs the fault tier on a pull request branch. |
| Admin rework before this epic | First plan: build on main, not blocking. Reviewer: a binding sequencing decision of the product owner. | A blocking question before the first admin surface, with the assumed answer to build on main, and a re-check task at the end of slices B, E and F. |
| Number of pull requests | The task prefers 25 to 40. First plan: 68. Reviewers: six of them are still too large. | 78, with a stop rule at 1,500 changed lines; an honest split wins over a smaller count. |

## 9. "Done when" coverage per sub-issue

Every acceptance item of every sub-issue is assigned to a pull request or listed as cut with its reason.

### #2485 Chat: mark search/fetch tools read-only and run read-only tool calls in parallel

| Item | Pull request |
|---|---|
| Three searches in one response run in one batch; time is about the longest call | PR 8 `tool-side-effects-parallel-calls` |
| A mix of read-only and changing calls: the changing ones run alone and in order | PR 8 `tool-side-effects-parallel-calls` |
| Unit tests for the planner in the new mode (all read-only, mixed, interactive and passthrough, `maxParallel`) | PR 8 `tool-side-effects-parallel-calls` |
| Parallel calls are shown correctly live and after a reload | PR 8 `tool-side-effects-parallel-calls` |
| The read-only value survives the building of the tool list; the per-tool throttle still applies | PR 8 `tool-side-effects-parallel-calls` |
| Release entry and documentation of `sideEffect` for tools and integration actions | PR 8 `tool-side-effects-parallel-calls` |

Cut or moved, with reason:

- Migration for tool files in `contents/tools/` and its test: not built, because no installation reads that directory any more (V199, V202, V211). In its place a test covers integration actions: declared read, undeclared, read by annotation only, admin override.
- Raising the concurrency of `braveSearch`: not part of this pull request.
- `webContentExtractor` as a default tool: tracked in #2481.

### #2712 Chat turns longer than 5 minutes are stopped by the browser's POST timeout

| Item | Pull request |
|---|---|
| A turn the user watches is not stopped by a client timeout (shipped in v5.7.1; proven on both transports) | PR 6 `long-turn-proof` |
| A lost status check does not end the turn in an error | PR 6 `long-turn-proof` |
| The POST answers as soon as the turn has started | PR 23 `chat-jobs-route` |
| A turn ends at the configured ceiling, not at a client timeout | PR 19 `run-limits` |

### #3191 Steer a running answer

| Item | Pull request |
|---|---|
| Enter never stops; Stop and Send are separate controls | PR 12 `steer-composer` |
| Applied at the next step and shown at that step, live and after a reload | PR 10 `steer-contract`, PR 12 `steer-composer` |
| 'Send afterwards' makes the next turn | PR 10 `steer-contract`, PR 12 `steer-composer` |
| Removed chip never applied; applied one answers 409 | PR 10 `steer-contract` |
| Steer just before the last model call: applied or next turn, exactly once | PR 10 `steer-contract` |
| A reload shows queued and applied steers from the server alone | PR 10 `steer-contract`, PR 12 `steer-composer` |
| Admin or other user gets 403; stop still works and is audited | PR 7 `run-access-intents` |
| 'I approve' leaves a pending approval pending | PR 7 `run-access-intents` |
| Marker text in tool output produces no steer | PR 10 `steer-contract`, PR 18 `run-envelope-taint-usage` |
| Steer in the evidence record with sender and step | PR 10 `steer-contract` |
| Announced; focus stays; en and de | PR 11 `run-ui-parts`, PR 12 `steer-composer` |
| Hidden in the Outlook add-in and the extension; docs say so | PR 12 `steer-composer` |
| Later: a persisted steer after a restart; a steer sent to another worker | PR 38 `chat-event-queue` |
| Another user and an admin cannot remove a queued message | PR 10 `steer-contract` |
| A message to a busy chat can be handed to the running answer, queued or made to replace it | PR 24 `chat-jobs-busy-client` |

Cut or moved, with reason:

- A per-model switch for models that ignore steers: not built; decided after the manual vLLM test.
- Outlook add-in and browser extension: hidden, as the issue says.

### #3196 Delegate tasks to sub-agents

| Item | Pull request |
|---|---|
| N sub-tasks in parallel; the limit holds across chats and workers | PR 34 `delegate-blocking`, PR 37 `sub-agent-ui` |
| App has tool T, parent lacks it: refused | PR 35 `app-as-sub-agent` |
| No tool, connection or scope beyond the parent's (one test per kind) | PR 34 `delegate-blocking` |
| App outside the parent's `apps` list refused | PR 35 `app-as-sub-agent` |
| No write tool; a background sub-agent with one is refused | PR 34 `delegate-blocking`, PR 35 `app-as-sub-agent`, PR 42 `background-sub-agents` |
| Report with the steer marker yields no user message | PR 34 `delegate-blocking` |
| Woken parent with nobody present parks an external write | PR 39 `taint-gate`, PR 42 `background-sub-agents` |
| Depth 2 refused | PR 34 `delegate-blocking` |
| Over the limit: readable refusal, nothing queued | PR 34 `delegate-blocking` |
| Cards name the sub-agent; answering resumes only it; two cards stay visible | PR 36 `sub-agent-interactions` |
| Report for every end state; complete when the summary was cut | PR 34 `delegate-blocking` |
| Simultaneous completions produce one wake | PR 42 `background-sub-agents` |
| Background result arrives after a reload and a restart | PR 42 `background-sub-agents` |
| Stopping the parent stops sub-agents and says how many; deleting the parent deletes hidden chats, reports, evidence, pending events | PR 33 `sub-agents-flag-hidden-chats`, PR 34 `delegate-blocking`, PR 37 `sub-agent-ui`, PR 42 `background-sub-agents` |
| Usage: parent total and each sub-agent, once; evidence links | PR 34 `delegate-blocking` |
| Delegation off: no `delegate` offered | PR 33 `sub-agents-flag-hidden-chats`, PR 34 `delegate-blocking` |
| `features.appAsTool` gone, no admin value overwritten | PR 33 `sub-agents-flag-hidden-chats` |
| `files` are checked against the parent's access at delegation time | PR 34 `delegate-blocking` |
| A brief that is too short or repeats an earlier one is refused | PR 34 `delegate-blocking` |
| Per-sub-agent limits: tool rounds, wall clock, tokens, summary length | PR 19 `run-limits`, PR 34 `delegate-blocking` |
| An upgrade check lists the affected apps | PR 35 `app-as-sub-agent` |
| Inbound MCP and A2A app calls keep working without a parent run | PR 35 `app-as-sub-agent` |
| A restart with a blocking sub-agent re-attaches it and starts no second one | PR 34 `delegate-blocking` |
| Load: profile `agentic`, three sub-agents per turn, 100 users | PR 34 `delegate-blocking` |
| Docs: apps, tool approval, agent loop, usage, `sse-v2`, artifacts, evidence, a note per model | PR 34 `delegate-blocking`, PR 35 `app-as-sub-agent`, PR 37 `sub-agent-ui` |

Cut or moved, with reason:

- Tools to ask the same sub-agent a follow-up question or to message a running one; 'Allow for this chat' on a sub-agent's card; a writing sub-agent; depth above 1.

### #3197 Follow-ups in the same chat and a notify-me tool

| Item | Pull request |
|---|---|
| Fires once, same chat, full context, two workers and a restart | PR 40 `follow-ups-server` |
| Cancel and fire never both happen | PR 40 `follow-ups-server` |
| `cancelOn: user_message` and manual cancel | PR 40 `follow-ups-server`, PR 41 `follow-ups-ui` |
| Chip shows the stored prompt and local time, survives a reload, owner cancels | PR 41 `follow-ups-ui` |
| Prompt reaches the model as data with origin followup | PR 40 `follow-ups-server` |
| Owner deactivated, app removed or chat deleted: cancelled with a reason | PR 40 `follow-ups-server` |
| Chain length and minimum delay enforced | PR 40 `follow-ups-server` |
| Woken turn shows why it started; `no change` is quiet | PR 40 `follow-ups-server`, PR 41 `follow-ups-ui` |
| `notify_user` over its limit is a tool error; text never markup | PR 40 `follow-ups-server`, PR 41 `follow-ups-ui` |
| Pending follow-ups listed per user and for admins | PR 40 `follow-ups-server`, PR 41 `follow-ups-ui` |
| Flag off: no tools, no chip | PR 40 `follow-ups-server`, PR 41 `follow-ups-ui` |
| The queue accepts the other four types without a schema change | PR 38 `chat-event-queue` |
| A follow-up missed by more than the lateness bound is cancelled with a reason | PR 40 `follow-ups-server` |

Cut or moved, with reason:

- Editing a follow-up, 'Run now', `cancelOn: chat_read`, follow-ups in guest, anonymous and temporary chats and by sub-agents: not built, as the issue says.

### #3198 Browser push notifications (deferred)

Cut or moved, with reason:

- The whole issue: deferred.

### #3772 One run service for chat, tasks, workflow steps and sub-agents

| Item | Pull request |
|---|---|
| Goldens green on main before the first refactor; quarantined tests run | PR 3 `test-foundations`, PR 4 `goldens-difference-list` |
| Difference list signed before the first surface moves | PR 4 `goldens-difference-list` |
| Guard test on loop and `runTool` calls with the named legacy exception | PR 14 `tool-runner`, PR 17 `chat-on-run-service` |
| No legacy workflow executor changed | PR 13 `agent-factory-removal`, PR 14 `tool-runner`, PR 15 `run-service-headless`, PR 16 `chat-host-move`, PR 17 `chat-on-run-service` |
| Same events, tool ids, evidence, usage, approvals except signed rows | PR 14 `tool-runner`, PR 15 `run-service-headless`, PR 16 `chat-host-move`, PR 17 `chat-on-run-service` |
| A run built with a user lacking `permissions` is refused | PR 15 `run-service-headless` |
| Tool outside `toolGrant` refused and audited on chat, scheduled, /v1, app-as-tool | PR 15 `run-service-headless`, PR 17 `chat-on-run-service` |
| Approval seam on every run kind; a mutating seam throws | PR 15 `run-service-headless` |
| S10 table in the PR, one test per row | PR 14 `tool-runner` |
| MCP and A2A through RunService; headless gets a denial | PR 15 `run-service-headless` |
| /v1 through RunService with the OpenAI error format | PR 17 `chat-on-run-service` |
| App-as-tool passes `integrationScopes`; localized name | PR 15 `run-service-headless` |
| Children cannot write memory | PR 15 `run-service-headless` |
| Usage records carry origin and agent id and survive exports | PR 18 `run-envelope-taint-usage` |
| Model tool maximum and 'no parallel tool calls' honoured | PR 8 `tool-side-effects-parallel-calls`, PR 15 `run-service-headless` |
| Logs and spans carry the ids | PR 17 `chat-on-run-service` |
| docs/agent-loop.md tables; no `invokeAppInternal` in docs | PR 15 `run-service-headless`, PR 17 `chat-on-run-service` |
| Legacy law consultation workflows run unchanged | PR 4 `goldens-difference-list`, PR 13 `agent-factory-removal`, PR 15 `run-service-headless`, PR 57 `workflow-engine-dispatch` |
| Model request projection asserted; signatures protected | PR 3 `test-foundations`, PR 4 `goldens-difference-list` |

Cut or moved, with reason:

- Time-to-first-token and token-parity checks on a real vLLM model are release-candidate checks; the PR gate uses the stub.

### #3773 Agent definition, chats and state

| Item | Pull request |
|---|---|
| No Agent Factory route, navigation entry or flag remains | PR 13 `agent-factory-removal` |
| Server boots with old data; old node types run; breaking entry names five locations | PR 13 `agent-factory-removal` |
| Create with name and goal; answer about another chat's work; versions | PR 44 `agent-definition-api`, PR 46 `agent-run-log-search` |
| Agent chats outside the chat cap; retention configurable | PR 45 `agent-chats-assembly` |
| Scheduled task with and without an agent; detach restores | PR 51 `agent-scheduled-link` |
| `no change` quiet; `needs attention` and `blocked` notify with reason | PR 46 `agent-run-log-search` |
| 'Runs as' in text on chats, feed rows and approval cards; no 'thread' | PR 47 `agent-chat-page`, PR 48 `agents-ui`, PR 52 `provided-agents`, PR 53 `agent-own-identity` |
| Concurrent posts never two runs; 8k window; search under 2 s | PR 23 `chat-jobs-route`, PR 45 `agent-chats-assembly`, PR 46 `agent-run-log-search` |
| Unattended run woken by untrusted input parks writes unless consent | PR 39 `taint-gate`, PR 54 `unattended-consent` |
| Own identity charged to its quota; chats readable by the granted only | PR 53 `agent-own-identity` |
| S1 to S9 each tested (old snapshot pauses; replayed webhook rejected) | PR 21 `job-store`, PR 22 `run-executor-scheduled`, PR 53 `agent-own-identity`, PR 54 `unattended-consent`, PR 56 `agent-webhook-triggers` |
| Handoff shows counts and scope; keyboard; cancel sends nothing; final state after restart | PR 55 `agent-handoff` |
| User A's chats, notes and memory never reach user B | PR 45 `agent-chats-assembly`, PR 46 `agent-run-log-search`, PR 52 `provided-agents`, PR 53 `agent-own-identity` |
| Deleting a user removes agents and data; deleting an agent states what goes | PR 44 `agent-definition-api`, PR 45 `agent-chats-assembly`, PR 48 `agents-ui`, PR 52 `provided-agents`, PR 56 `agent-webhook-triggers` |
| /agents pages cold-load and pass accessibility | PR 47 `agent-chat-page`, PR 48 `agents-ui` |
| A message can be sent to an agent chat and the chat opens on its own page | PR 45 `agent-chats-assembly`, PR 47 `agent-chat-page` |
| A provided agent started by a user runs as that user | PR 52 `provided-agents` |
| Identity matrix (three run kinds by four resource kinds, with negative rows) | PR 53 `agent-own-identity` |
| A golden model input per event kind | PR 45 `agent-chats-assembly`, PR 51 `agent-scheduled-link`, PR 55 `agent-handoff`, PR 56 `agent-webhook-triggers` |
| 'Run again' for own-identity runs by the users granted chat access | PR 53 `agent-own-identity` |
| Wording: `scheduledTasks.memory.title` corrected; glossary rows 'runs as', 'memory versus notes', 'service account' | PR 50 `scheduled-ui-rename`, PR 48 `agents-ui`, PR 53 `agent-own-identity` |
| Docs: `sse-v2`, run ledger, user guide, admin UI, concepts | PR 46 `agent-run-log-search`, PR 48 `agents-ui`, PR 55 `agent-handoff`, PR 56 `agent-webhook-triggers` |

Cut or moved, with reason:

- 'No Agent Factory tool remains' and the grep for 'inbox': the legacy tool file and the legacy `inbox-*` node strings stay until the legacy path is removed; they are on the lint baseline.
- The digest of other chats, a version-history UI, 'run as the creating admin', sharing a personal agent: not built.

### #3774 Workflow steps replacing the node types

| Item | Pull request |
|---|---|
| Version 2 runs on the new engine; legacy opens and runs unchanged | PR 57 `workflow-engine-dispatch`, PR 59 `workflow-engine-loop` |
| Editor and model schema offer exactly ten steps; no old node; no mixing | PR 58 `workflow-step-schema`, PR 69 `workflow-step-editor` |
| Both law consultation variants built with the contract, next to the old | PR 65 `law-consultation-rebuilt` |
| Sign-off after a side-by-side run (release gate) | PR 65 `law-consultation-rebuilt` |
| No record for an inaccessible iFinder document | PR 61 `workflow-steps-basic` |
| No step writes outside its output; no vm, eval, new Function | PR 58 `workflow-step-schema`, PR 63 `workflow-steps-model` |
| Action honours approval and the SSL whitelist; free URL admin-only; templated host rejected | PR 62 `workflow-step-action` |
| 'Ignore the schema' document yields valid output and no tool call | PR 63 `workflow-steps-model` |
| For each: input order when parallel; resumes mid-list without duplicates | PR 64 `workflow-for-each` |
| Ask a person pauses and resumes inside For each and repeat mode | PR 66 `workflow-check-branch-ask` |
| Several named results to API, MCP and A2A | PR 61 `workflow-steps-basic` |
| Check returns verdict and criteria and routes a Branch | PR 66 `workflow-check-branch-ask` |
| Rebuilt defaults green in CI; dropped ones named | PR 70 `rebuilt-corpus-analysis`, PR 71 `rebuilt-iterative-research`, PR 72 `default-workflows-disposition` |
| Built, connected and nested by keyboard alone | PR 69 `workflow-step-editor` |
| 240-document For each: one progress row and a failed-items list | PR 64 `workflow-for-each`, PR 68 `workflow-run-view` |
| Every label and option in en and de | PR 68 `workflow-run-view`, PR 69 `workflow-step-editor` |
| Find documents: pagination, bounded rounds, first-seen order | PR 61 `workflow-steps-basic` |
| Contract test per step: inputs, outputs, options, cancel, resume after a pause | PR 61 `workflow-steps-basic`, PR 62 `workflow-step-action`, PR 63 `workflow-steps-model`, PR 64 `workflow-for-each`, PR 66 `workflow-check-branch-ask` |
| Load: For each over 200 documents with parallelism 4; event-loop delay and memory flat | PR 64 `workflow-for-each` |
| Every default and marketplace workflow has a disposition (decision A6) | PR 72 `default-workflows-disposition` |
| A `delegation` setting on the workflow | PR 58 `workflow-step-schema`, PR 63 `workflow-steps-model`, PR 69 `workflow-step-editor` |
| Docs: `docs/architecture.md` 'Node Types' | PR 69 `workflow-step-editor` |

Cut or moved, with reason:

- The product owner's sign-off of both rebuilt reports is a release gate with a dated note here, not a merge gate; the merge gate is the side-by-side tool and the five accepted differences on a scripted model.

### #3775 Plan as workflow: planned and fixed agent modes

| Item | Pull request |
|---|---|
| At most two check rounds, then needs attention with open criteria | PR 73 `agent-fixed-mode` |
| Every run ends in a named end state | PR 73 `agent-fixed-mode` |
| Revise sends only gaps, keeps the runId, versions the artifact | PR 73 `agent-fixed-mode` |
| Criteria visible before the first work step; Check row names each | PR 73 `agent-fixed-mode`, PR 77 `plan-view` |
| Each revision stored with the causing call and readable | PR 74 `plan-revisions-amend`, PR 77 `plan-view` |
| Invalid plan rejected before storage; `PLAN_STEP_IMMUTABLE` | PR 74 `plan-revisions-amend`, PR 75 `planned-mode` |
| Plan may contain Action, Ask a person, For each, planning Agent step; depth capped | PR 75 `planned-mode`, PR 76 `plan-loops-approval` |
| Removing a done criterion rejected or flagged | PR 75 `planned-mode` |
| Fixed mode: no plan tool, forged call refused, version recorded, same steps | PR 73 `agent-fixed-mode`, PR 74 `plan-revisions-amend`, PR 75 `planned-mode` |
| Plan approval: nothing runs before Approve; keyboard; setting enforced | PR 75 `planned-mode`, PR 77 `plan-view` |
| Tainted run adding an external write step shows a card | PR 76 `plan-loops-approval` |
| One plan card; reopened chat shows final plan and history | PR 77 `plan-view` |
| German 'Mit Plan' and 'Fester Ablauf' | PR 73 `agent-fixed-mode`, PR 75 `planned-mode`, PR 77 `plan-view` |
| Both claude-style-agent workflows run; one planned default agent | PR 78 `planned-default-agent` |
| Manual model protocol run and filed (release gate) | PR 78 `planned-default-agent` |
| Plan approval: reject and timeout end `blocked`; 'Request changes' gives a revised card | PR 75 `planned-mode`, PR 77 `plan-view` |
| The editor warns 'Scheduled runs will wait for you each time' | PR 75 `planned-mode` |
| The Check input contains exactly the criteria (golden) | PR 73 `agent-fixed-mode` |
| Restart after revision 3 continues on revision 3 | PR 74 `plan-revisions-amend` |
| Manual protocol: two open-weight models and one hosted model, bar 9 of 10 | PR 78 `planned-default-agent` |

Cut or moved, with reason:

- Running the manual model protocol is a release gate; the pull request delivers the checklist with the three models and the bar.
- User-edited plans, turning a plan into a workflow, fixed mode on personal agents, per-group plan approval: not built.

### #3777 Run executor

| Item | Pull request |
|---|---|
| Chat turn and scheduled run execute as jobs; a new-engine execution can be a job | PR 22 `run-executor-scheduled`, PR 23 `chat-jobs-route`, PR 60 `workflow-ready-set-durable-steps` |
| POST answers in under 1 s; the #2712 test stays green | PR 23 `chat-jobs-route`, PR 24 `chat-jobs-busy-client` |
| Restart mid-turn: one resume marker, no duplicate text | PR 26 `resume-after-restart`, PR 32 `chat-jobs-default-on` |
| Crash during a write: not repeated, needs attention, en and de | PR 27 `unknown-outcome-run-again` |
| 'Run again' once more, with approval, linked; owner only | PR 27 `unknown-outcome-run-again` |
| Interactive ceiling (60 minutes), names the limit, offers Continue | PR 19 `run-limits` |
| Every kill-table row has a nightly test | PR 25 `durable-flush`, PR 26 `resume-after-restart`, PR 27 `unknown-outcome-run-again`, PR 28 `worker-takeover`, PR 34 `delegate-blocking` |
| Exactly-once claim; a stale holder cannot write | PR 21 `job-store`, PR 28 `worker-takeover` |
| A claimer or holder stalled past the takeover never causes a second execution of a write | PR 21 `job-store`, PR 22 `run-executor-scheduled`, PR 26 `resume-after-restart`, PR 28 `worker-takeover`, PR 60 `workflow-ready-set-durable-steps` |
| At most `maxAttempts` pickups, then a visible failure | PR 26 `resume-after-restart` |
| No key, token or message text in a job document; HMAC | PR 21 `job-store`, PR 27 `unknown-outcome-run-again` |
| Owner deactivated while queued: no model call; anonymous users create no background job | PR 21 `job-store`, PR 23 `chat-jobs-route` |
| Stop within one step on any worker; stalled within one poll | PR 28 `worker-takeover`, PR 31 `activity-page` |
| No job from a restored backup starts | PR 26 `resume-after-restart` |
| Journals deleted after the result is stored | PR 26 `resume-after-restart` |
| `ScheduledTaskRunner` and the task lease deleted; chatRecovery shrinks | PR 22 `run-executor-scheduled`, PR 26 `resume-after-restart` |
| Old concurrency keys migrated one to one | PR 19 `run-limits` |
| Docs state the topology; no UI string with 'job' or 'lease' | PR 2 `glossary-wording-lint`, PR 28 `worker-takeover`, PR 32 `chat-jobs-default-on` |
| A turn is rebuilt from its recipe in a second process with the same model request | PR 23 `chat-jobs-route`, PR 26 `resume-after-restart` |
| An interrupted scheduled run is never started twice before resume exists | PR 22 `run-executor-scheduled` |
| The kill switch lands on the v5.7.2 chat path | PR 23 `chat-jobs-route`, PR 32 `chat-jobs-default-on` |
| A returning user can work again; a paused approval from v5.7.2 continues once | PR 21 `job-store`, PR 22 `run-executor-scheduled`, PR 25 `durable-flush` |
| Load: profile `agentic`; no lost claim under ingestion | PR 5 `fault-harness-nightly`, PR 28 `worker-takeover` |

Cut or moved, with reason:

- Fencing on every chat, ledger, state and artifact write is replaced by four chokepoints (the start of a model call or step, the two chat lock sections, the flush before a write, job transitions), each tested.

### #3780 Permissions and feature flags

| Item | Pull request |
|---|---|
| Schema, defaults and group editor carry the permissions in EN and DE | PR 40 `follow-ups-server`, PR 43 `agent-permissions-flag` |
| Migration sets defaults, keeps admin values, passes twice | PR 33 `sub-agents-flag-hidden-chats`, PR 43 `agent-permissions-flag` |
| After an untouched upgrade: no agent UI, no `delegate` | PR 33 `sub-agents-flag-hidden-chats`, PR 43 `agent-permissions-flag` |
| `agentFactory` and `appAsTool` gone from registry and stored config | PR 13 `agent-factory-removal`, PR 33 `sub-agents-flag-hidden-chats` |
| Without 'use agents' no agent UI; scheduled tasks still run | PR 43 `agent-permissions-flag`, PR 48 `agents-ui` |
| No group permission for delegation; the `apps` list is the allow-list | PR 33 `sub-agents-flag-hidden-chats`, PR 35 `app-as-sub-agent` |
| Permissions checked in the run service; principal without permissions refused | PR 15 `run-service-headless`, PR 43 `agent-permissions-flag` |
| An agent principal is never admin | PR 53 `agent-own-identity` |
| Anonymous users and guests: no agents, no unattended work | PR 40 `follow-ups-server`, PR 43 `agent-permissions-flag` |
| Own-identity chats readable by the granted only; changes audited | PR 53 `agent-own-identity` |
| Workflow authoring unchanged; docs list permissions and flags with defaults | PR 43 `agent-permissions-flag` |

### #3781 Run limits, quotas and usage metering

| Item | Pull request |
|---|---|
| All run limits read from `platform.runs`; keys migrated, no value lost | PR 19 `run-limits` |
| A group override changes the caps | PR 19 `run-limits` |
| Unattended pool full: an interactive turn still starts | PR 22 `run-executor-scheduled` |
| Sub-agents, scheduled runs, follow-ups count against the pool; one count on two workers | PR 22 `run-executor-scheduled`, PR 34 `delegate-blocking`, PR 40 `follow-ups-server`, PR 42 `background-sub-agents` |
| A waiting run holds no slot | PR 22 `run-executor-scheduled` |
| Interactive ceiling with a readable reason; partial answer kept | PR 19 `run-limits` |
| Over the quota: registered code, 429 | PR 22 `run-executor-scheduled` |
| Delegation over the limit: readable refusal | PR 34 `delegate-blocking` |
| Own identity counted, limited, in Usage Reports | PR 53 `agent-own-identity` |
| Provided agent started by a user charged to the user | PR 52 `provided-agents` |
| Usage dimensions in records and exports | PR 18 `run-envelope-taint-usage` |
| Child tokens counted once, marked sub-agent | PR 18 `run-envelope-taint-usage`, PR 34 `delegate-blocking` |
| Per-sub-agent limits in the limits block | PR 19 `run-limits`, PR 34 `delegate-blocking` |

### #3782 Running work: activity tray, admin Runs page, pause and drain

| Item | Pull request |
|---|---|
| Tray is a sidebar entry listing running and waiting items with a count | PR 31 `activity-page`, PR 37 `sub-agent-ui`, PR 41 `follow-ups-ui` |
| Every needs-attention row states reason and action | PR 27 `unknown-outcome-run-again`, PR 31 `activity-page` |
| Crash during a write: shows the call, offers 'Run again' | PR 27 `unknown-outcome-run-again`, PR 31 `activity-page` |
| Pending follow-ups and scheduled work under 'Scheduled' | PR 41 `follow-ups-ui` |
| Stop by keyboard; confirmation names sub-agents | PR 31 `activity-page`, PR 37 `sub-agent-ui` |
| Stalled within one poll interval | PR 28 `worker-takeover`, PR 31 `activity-page` |
| /admin/runs lists every job; admin stop audited | PR 29 `admin-runs-api`, PR 30 `admin-runs-page` |
| An admin cannot steer another user's run or answer its approvals | PR 7 `run-access-intents` |
| Agent Runs page removed; task run list points to /admin/runs; legacy runs labelled | PR 13 `agent-factory-removal`, PR 30 `admin-runs-page`, PR 67 `legacy-workflow-notice` |
| Pause: no new unattended run; chat works; resume restarts | PR 29 `admin-runs-api`, PR 30 `admin-runs-page` |
| Pickup limit with `PICKUP_LIMIT` | PR 26 `resume-after-restart` |
| Restored backup starts nothing | PR 26 `resume-after-restart` |
| Older format stamp ends as interrupted | PR 26 `resume-after-restart` |
| /admin/runs passes axe and is in CLEAN_PAGES | PR 30 `admin-runs-page` |
| The user's run list never returns another user's runs | PR 31 `activity-page` |

Cut or moved, with reason:

- Listing legacy workflow runs on `/admin/runs`: not built; a labelled link to the Workflow Executions page.

### #3783 Scheduled work

| Item | Pull request |
|---|---|
| After the upgrade every task is unchanged and fires; no agent created | PR 22 `run-executor-scheduled`, PR 49 `scheduled-api-rename` |
| Runs on the executor; `taskRunner.js` deleted; nothing lost or doubled | PR 22 `run-executor-scheduled` |
| Write in flight at a crash not re-run; 'Run again' offered | PR 27 `unknown-outcome-run-again` |
| No admin value lost; two concurrency values in `platform.runs` | PR 19 `run-limits` |
| With agents off, scheduled tasks work as before | PR 22 `run-executor-scheduled`, PR 49 `scheduled-api-rename`, PR 54 `unattended-consent` |
| UI says 'Scheduled'; /tasks redirects by direct load, root and subpath | PR 50 `scheduled-ui-rename` |
| Old API gone, new collection answers, breaking entry | PR 49 `scheduled-api-rename` |
| Attach and detach; newest 20 run chats kept | PR 51 `agent-scheduled-link` |
| Every former test ported or removed with a reason; upgrade test | PR 22 `run-executor-scheduled`, PR 49 `scheduled-api-rename` |
| A run waiting for approval at the upgrade stays answerable | PR 22 `run-executor-scheduled` |

### #3784 Legacy workflows

| Item | Pull request |
|---|---|
| After the upgrade every existing workflow opens and runs as before | PR 4 `goldens-difference-list`, PR 13 `agent-factory-removal`, PR 57 `workflow-engine-dispatch`, PR 67 `legacy-workflow-notice` |
| Inventory lists every legacy file with node types | PR 67 `legacy-workflow-notice` |
| Inventory lists what points at a legacy workflow | PR 67 `legacy-workflow-notice` |
| Notice on the admin overview; server-sent label | PR 67 `legacy-workflow-notice` |
| Startup log names the legacy workflows | PR 67 `legacy-workflow-notice` |
| No old node type can be added | PR 69 `workflow-step-editor` |
| Marketplace `compatibility.ihub`; refusal outside the range; validate fails without it | PR 67 `legacy-workflow-notice` |
| Release entry announces the removal | PR 67 `legacy-workflow-notice` |
| Removal plan recorded and referenced | PR 67 `legacy-workflow-notice`, PR 72 `default-workflows-disposition`, PR 78 `planned-default-agent` |

Cut or moved, with reason:

- The removal itself and any converter: a later release, as the issue says.

### #3785 Trust rules: event origin and taint

| Item | Pull request |
|---|---|
| No origin other than person becomes a user message (test per origin) | PR 18 `run-envelope-taint-usage` |
| Tainted after reading a flagged tool; woken parent starts tainted | PR 18 `run-envelope-taint-usage`, PR 39 `taint-gate`, PR 42 `background-sub-agents` |
| External write parked in a tainted unattended run | PR 39 `taint-gate`, PR 54 `unattended-consent` |
| With the consent the run proceeds; audited; withdrawable | PR 54 `unattended-consent` |
| Owner (personal) or admin (provided) gives the consent | PR 54 `unattended-consent` |
| Loop write approved once for the items shown | PR 76 `plan-loops-approval` |
| Follow-up scheduled in a tainted run wakes tainted | PR 40 `follow-ups-server` |
| Tainted note absent from the memory review input | PR 54 `unattended-consent` |
| Tainted plan revision with an external write shows a card | PR 76 `plan-loops-approval` |
| Only the chat owner can steer | PR 7 `run-access-intents` |
| docs/security.md prompt-injection section | PR 39 `taint-gate`, PR 54 `unattended-consent` |
| Only the owner answers an interaction; an anonymous one needs the guest cookie | PR 7 `run-access-intents` |
| A parked write is re-authorised when it is approved | PR 21 `job-store`, PR 39 `taint-gate` |

Cut or moved, with reason:

- A scheduled task without an agent is not covered by the gate under the assumed answer to the blocking question.

### #3786 Test foundations

| Item | Pull request |
|---|---|
| Stub streams slowly on a marker; the #2712 test uses it | PR 1 `e2e-stub-and-gate`, PR 6 `long-turn-proof` |
| Three tests leave the quarantine before the first refactor | PR 3 `test-foundations` |
| App-as-tool characterization | PR 3 `test-foundations` |
| `scriptedModel` fails on an extra call | PR 3 `test-foundations` |
| Golden harness identical on two runs for the surfaces | PR 3 `test-foundations`, PR 4 `goldens-difference-list` |
| Fault harness: kill, restart, write once, needs attention | PR 5 `fault-harness-nightly`, PR 27 `unknown-outcome-run-again` |
| After 'run again' the counter is 2 | PR 27 `unknown-outcome-run-again` |
| Two processes, 100 claims, one winner | PR 21 `job-store` |
| Legacy and rebuilt workflow side by side | PR 3 `test-foundations`, PR 65 `law-consultation-rebuilt` |
| `e2e.yml` gates PRs; `nightly.yml`; a failure opens an issue | PR 1 `e2e-stub-and-gate`, PR 5 `fault-harness-nightly` |
| No new test waits on real time | PR 3 `test-foundations`, PR 5 `fault-harness-nightly` |
| Browser checks can use the counter tool, a seeded job and an offline outside-content tool | PR 5 `fault-harness-nightly`, PR 21 `job-store` |
| Who acts on a red nightly is documented | PR 5 `fault-harness-nightly` |
| Legacy workflow path characterised before any refactor | PR 4 `goldens-difference-list` |

Cut or moved, with reason:

- 'No law consultation golden' is narrowed: the legacy runs are pinned on synthetic input. There is still no golden for the rebuilt report and no fixed set of real documents.

### #3787 Retention for agent chats and their evidence

| Item | Pull request |
|---|---|
| Agent chat never counted against the cap, never evicts | PR 45 `agent-chats-assembly` |
| Admin sets the retention time; default documented | PR 45 `agent-chats-assembly` |
| Run chats trimmed to 20 per task, with or without an agent | PR 51 `agent-scheduled-link` |
| Sub-agent chat deleted with its parent, in no list | PR 33 `sub-agents-flag-hidden-chats`, PR 34 `delegate-blocking` |
| Evidence deleted with its turns | PR 34 `delegate-blocking`, PR 45 `agent-chats-assembly` |
| Retention cancels pending follow-ups first | PR 38 `chat-event-queue` |
| User deletion: access steps first, then content; a test lists every store | PR 20 `erasure-coverage`, PR 21 `job-store`, PR 38 `chat-event-queue`, PR 44 `agent-definition-api`, PR 45 `agent-chats-assembly`, PR 52 `provided-agents`, PR 56 `agent-webhook-triggers` |
| Chats with a provided agent deleted with the user | PR 45 `agent-chats-assembly`, PR 52 `provided-agents` |
| Own-identity chats survive any user's deletion | PR 53 `agent-own-identity` |
| Each new store has a pii row | PR 20 `erasure-coverage`, PR 21 `job-store`, PR 38 `chat-event-queue`, PR 44 `agent-definition-api`, PR 45 `agent-chats-assembly`, PR 52 `provided-agents`, PR 59 `workflow-engine-loop`, PR 74 `plan-revisions-amend` |
| Pending interactions are deleted with the user; failed steps are retried | PR 20 `erasure-coverage` |

### #3788 Workflow engine: definition per run, amend and revisions

| Item | Pull request |
|---|---|
| PR 0 records each criterion; no later change to a frozen file | PR 4 `goldens-difference-list`, PR 57 `workflow-engine-dispatch` |
| Version 2 on the new engine; later operations reach the starting engine | PR 57 `workflow-engine-dispatch`, PR 59 `workflow-engine-loop` |
| Run finishes on its starting definition; evidence names the hash | PR 59 `workflow-engine-loop` |
| Order derived from references; several named results | PR 60 `workflow-ready-set-durable-steps`, PR 61 `workflow-steps-basic` |
| Write step in flight not re-run; 'run again' | PR 60 `workflow-ready-set-durable-steps` |
| Ask a person pauses and resumes inside loops | PR 66 `workflow-check-branch-ask` |
| Write Action in a model-written loop asks once | PR 76 `plan-loops-approval` |
| Every amend one revision; repeated call same revision; invalid stores nothing | PR 74 `plan-revisions-amend` |
| `PLAN_LOCKED` and `PLAN_LIMIT_REACHED` | PR 74 `plan-revisions-amend`, PR 75 `planned-mode` |
| No new-engine code reads `_workflowDefinition` (grep test) | PR 59 `workflow-engine-loop` |
| One controlling run per execution from the first engine pull request | PR 59 `workflow-engine-loop`, PR 63 `workflow-steps-model` |
| Amend on a worker that does not own the execution; `VERSION_CONFLICT`; a kill between revision record and definition write | PR 74 `plan-revisions-amend` |
| Six plan limits with ceilings in code | PR 74 `plan-revisions-amend` |
| A loop above `maxForEachItems` pauses with a question | PR 76 `plan-loops-approval` |

## 10. Deletion list

| Pull request | Deleted |
|---|---|
| 13 | `server/routes/agents/`, `server/routes/admin/agents.js`, `agentInboxes.js`, the `AdminAgent*` and `AgentRun*` pages, the registry entry `agentFactory`, the run kind `agent`, the two default profiles in `server/defaults/agents/profiles/`, the two route error tests |
| 14 | Both `executeTool` closures in `ChatService.js` |
| 15 | `ChatService.invokeAppInternal` (`:1922-2168`), the fail-open branch of `isAppInvocationAllowed`, the mocks of `invokeAppInternal` in five test files |
| 16, 17 | The body of `runTurn` and `_finishTurn` in `ChatService.js` (moved to `ChatHost`); the user-flag copies `isInvokedViaAppAsTool`, `scheduledRun`, `isAgent` |
| 19 | `platform.scheduledTasks.maxConcurrentRuns` and `maxConcurrentRunsPerUser` (schema, policy, admin page); `DURABLE_TURN_WALL_CLOCK_MS` for user-started turns |
| 22 | `scheduler/tasks/taskRunner.js`; the task lease in `taskModel.js:54-70` and `taskExecution.js:247-355` |
| 26 | Most of `chatRecovery.js` (it keeps non-resumable runs, exhausted attempts and `deliverResumedWorkflows`) |
| 29 | The admin list on `GET /api/runs`; the admin bypass for stop on human-events |
| 30 | The run table in `AdminScheduledTasksPage.jsx` |
| 33, 35 | The registry entry `appAsTool`; the stored keys `agentFactory` and `appAsTool`; the 180 s clock of the old app invocation |
| 38 | The in-memory steering queue in `steering.js` |
| 49 | `/api/scheduled-tasks` and `/api/admin/scheduled-tasks` |
| 50 | `RunStatusBadge`; the `/tasks` pages (a redirect stays) |
| One release after slice B ships | `platform.runs.chatOnRunService` and the pre-move seam wiring in `ChatHost` |

Not deleted in this epic, and listed for the removal of the legacy path (#3784): `WorkflowEngine.js`, `DAGScheduler.js`, the legacy executors, `resumeManager.js`, `orphanSweeper.js`, `triggers/schedulerLock.js`, `server/agents/{memory,inbox,runtime}`, `server/tools/agentTools.js`, `agents/profile/profileWorkflowSerializer.js`, `agents/profile/reviewSettings.js`, `server/validators/agentProfileSchema.js` and `agentInboxSchema.js`, the agent-profile loader in `resourceLoaders.js` with `configCache.getAgentProfiles`, the agent-profile branch in `startup/worker.js` and `executionActor.js`, `VerifierNodeExecutor.js`, the dispatch seam, both `claude-style-agent` defaults, the old default workflow files, and everything under 'Later release' in #3788.

## 11. Review of this plan

Three adversarial reviewers read the first version (68 pull requests). Their findings were checked against the plan, the issues and the code at dd586bb. What changed:

**Order**

- The harnesses, the goldens and the fault harness moved from slice B to the bottom of the stack (PRs 3 to 5). The goldens are now recorded before the turn-start refactor of slice A, which is no longer called move-only. The five tooling pull requests merge to main at once.
- `nightly.yml` also runs on a pull request with the label `run-faults`; the entry condition of the default flip is worded as runs on the head of the previous pull request.
- The stack has 78 pull requests. Split: chat jobs (route; busy modes and client), admin runs (API; page), scheduled rename (API; UI), provided agents (run as the user; own identity), handoff and webhook triggers, basic steps (three steps; Action), default workflows (three pull requests). New: user-deletion coverage (PR 20) and the agent chat page (PR 47). A 1,500-line stop rule applies to every pull request.

**Corrections against the code**

- PR 13 no longer deletes `agentProfileSchema.js`, `agentInboxSchema.js` and `reviewSettings.js`; frozen executors and kept modules import them. The profile loader stays. Runs in flight are cancelled at boot.
- The legacy path 'app tool from a prompt node' is unreachable after that removal. The legacy `app__` golden, the legacy principal resolution and the `appAsTool` alias are dropped; a test pins the path as unreachable.
- The legacy workflow path is pinned in slice A: frozen-file hashes, both law consultation variants on synthetic input, a paused and resumed run, a run resumed after a restart, a trigger-started run.
- A turn snapshot on the user message makes a chat turn rebuildable from its recipe; a job is not resumable when the run ledger is off.
- A scheduled run interrupted by a restart fails as today until the resume pull request; the child kill point and the `delegate` disposition moved to the pull requests that create their call sites.
- The agents e2e stack runs under `NODE_ENV=test` with the test tools, a counter endpoint and a job seed endpoint; browser checks name them.
- `GET /api/runs` is an admin list today; it moves to `/api/admin/runs` and the path becomes the user's own list.
- Dependencies used before they existed were reordered: `PLAN_LOCKED` and the forged-call test, the controlling run of a workflow execution, the `schemaVersion` key, the rule against adding old node types (now with the editor).

**Security and upgrade**

- Interaction intents, the anonymous guest-cookie rule and the route inventory are built in slice A; the inventory enumerates the router.
- The deleted-principal record carries the deletion time; the snapshot age rule has an upgrade path and a refresh on any authenticated request.
- An app called as a tool is read-only as a sub-agent; an app call without a parent run stays a root headless run.
- The taint gate for scheduled runs covers only runs attached to an agent under the assumed answer; the alternative is a blocking question.
- The kill switch implies `chatJobs` off. Model requests are asserted in the goldens and a signature on a difference row needs the product owner's approval.
- Fixtures written by v5.7.2 cover a run waiting for approval, a pending approval and a pending connect.
- Follow-ups have a lateness bound; webhook nonces and rate limits count across workers; a trigger needs an agent with its own identity.

**Coverage against the issues and decisions**

- #2485 was fetched and mapped (section 9 and a ticket file).
- Section 9 now also maps the 'Tests and definition of done' items: load tests, the identity matrix, golden model inputs, the `_workflowDefinition` grep test, `VERSION_CONFLICT`, plan approval outcomes, the three-model protocol.
- #3196: file access at delegation, brief refusal, per-sub-agent limits and the upgrade check have pull requests.
- The loop approval follows the product owner's final decision: once per loop, a question above 200 items, no split. `platform.workflows.plan` lists six keys.
- Every default and marketplace workflow has a proposed disposition (section 2.7).
- The admin rework sequencing is a blocking question with re-check tasks. Blocking questions are now four: the signature on the difference list, the admin rework, the taint gate for plain scheduled tasks, the workflow dispositions.
- Eight migrations (V260 to V267); none extends an earlier one. #2712 is closed by the messages route. The plan file is added to `concepts/`.
- Docs items from the issues are placed: `sse-v2`, the per-model note, the run ledger, 'Node Types', glossary rows, the notes title of scheduled tasks, 'Runs as' on approval cards, who acts on a red nightly.

**Second check by the panel chair (2026-11-20)**

Every review point was checked once more against the revised plan, the issues and the code. Three things changed:

- The migration for tool side effects is dropped. #2485 asks for it, and the first revision kept it, but no installation reads `contents/tools/` any more: V199 and V202 removed the shipped copies, V211 turned admin-created tool files into custom integrations, and `server/services/integrations/integrationTools.js:125` already carries the side effect of an action to the planner. PR 8 switches that line to the trusted helper and tests integration actions instead. The epic has eight migrations (V260 to V267).
- Every sub-issue names the pull request that closes it (the last one that delivers one of its items). #3784 stays open for the later removal of the legacy path, #3198 is deferred, and so the epic issue stays open.
- The removal of the Agent Factory names all importers of `profileWorkflowSerializer.js` (`startup/worker.js` and the applied migrations V052 to V054).

**Review of pull request 1 (2026-11-20)**

The automated review of the first pull request raised points on later pull requests in several rounds and came back to some of them. Each was checked against the plan and the code and is now part of the pull request that owns it:

- The full suite and the transport matrix are started by hand until PR 5 adds the nightly workflow; sections 2.3, PR 1 and PR 5 say so.
- The webhook signature covers the timestamp and the nonce as well as the raw body (PR 56); a changed header fails the signature.
- `authorizeInteraction` has a rule for runs under an agent's own identity: the users with chat access answer, nobody else (PR 53, decision 50, open question 37).
- A follow-up event and its job are bound by a `runId` written at the claim and a create-only job write; a claim left stale is completed by any worker under the same key (PR 40).
- Run admission reserves the slot in the shared store; the copies cached per worker no longer admit a run, and a sweep removes a reservation without a job (PR 22).
- Follow-up on the webhook nonce: a timestamp may be at most 30 seconds ahead, and a nonce is kept until its timestamp plus 5 minutes, so it outlives the acceptance of its timestamp (PR 56).
- Follow-up on run admission: the sweep removes a reservation without a job only after two sightings, and a claim for a run without a reservation is refused (PR 22).
- Second follow-up on run admission: lock, fencing-token checks and one marker per run are replaced by one quota record per principal and one slot record per pool and model. Admission, claim, settle and sweep are compare-and-swap transitions of that record, written create-only as the next version, so a writer that stalled cannot write over a newer state; a run is acknowledged only after its reservation is confirmed in the record. The namespace `run-jobs-active` is gone (PR 21, PR 22, PR 34).
- Third follow-up, on every other exclusive step: the same storage fact holds outside admission, so no winner is decided by a `put` with an etag string or by a lock any more. Section 2.8 defines claim by create and its limits. A job is a head plus one create-only epoch document per claim, and the epoch is the fencing token (PR 21, PR 28); events, follow-ups and sub-agent reports are claimed by a create-only claim document (PR 38, PR 40, PR 42); a plan revision is a create-only document (PR 74); a webhook nonce is one too and survives a restart (PR 56); a scheduled slot and a `delegate` child get a derived runId (PR 22, PR 34); the workflow engine keeps its step state per epoch (PR 60). Each has a test with a writer stalled for longer than the takeover. What no check excludes, a holder that stalls between its last check and the effect, ends as `needs attention` and is not repeated by the system.
- Fourth follow-up, on a claim the sweep recovers: a claimer fixes its epoch first and records it in its quota entry, and a pool slot names that epoch. The sweep that gives the slot away first creates that epoch document itself (reason `recovered`), so a claimer that resumes after both sweeps fails at its create and no job starts without a slot, wherever it paused: the entry is written before the slot is taken, and the job claim is the single enforced point for entry, slot and sweep (PR 21, PR 22).
- Settling and releasing are scoped to the owner: on SIGTERM a worker acts only on jobs whose highest epoch carries its own `workerId`, which names the process. When a worker may touch the job of another owner is set by the last point of this list (PR 22, PR 26, PR 28).
- A stale follow-up claim is decided by the job head: an existing job under the stored `runId` ends the event consumed and runs once, and the lateness bound applies only when no job exists; a lapse is a create-only head marked `lapsed`, so fire and cancel stay one decision (PR 40).
- Follow-up on the stale follow-up claim (PR 40): a head with the mark `lapsed` found during recovery ends the event cancelled, a head without it ends it consumed; the long-outage acceptance item names that exception and a case for the killed completer is added.
- Follow-up on the owner scope: a heartbeat that stood still is no proof that a worker ended, so until PR 28 the job of another owner, its quota entry and its pool slot are settled, picked up or released only after the confirmed end of that process. That is the `exit` the cluster primary saw, or an earlier server start whose process is gone according to the boot record PR 22 adds, which also refuses a second server on one contents directory on the same host. A killed worker's job is therefore handled at the next sweep, and only a holder that is alive and silent waits, with its job `running` and its slot taken. PR 28 adds the heartbeat ground together with the fencing that makes it safe, including a chokepoint at the start of a model call and of a step. The sweep's `recovered` fence stays for the window before the claim, where the claimer has no epoch yet. Both pause tests are in the acceptance lists (section 2.8, PR 21, PR 22, PR 26, PR 28; decision 52, pre-mortem row 49).
- What the pool limit bounds across a takeover (PR 28): holders, by storage; not model calls in flight. One stale model call per superseded holder can overlap, without effect, and is counted; an acceptance case pauses a holder between `assertHolder` and the model request.
- Shutdown order (PR 22, PR 26): a worker settles or releases a job only after the loop of that job has returned, as its last act; otherwise it writes nothing and the job is handled after its exit. Two-worker cases for both paths are added.
- One run per chat (PR 23) is storage-enforced: a claim by create per chat in `chat-run-claims`, ended by the job's end or, without a job, by its creator or on the ground `exited`. `chat.activeRunId` is a display field, the sentence about two runs after a stall is gone, and a post paused after its listing answers `CHAT_BUSY` and submits no job. The busy modes, the leftover and every event-started turn take the same claim (PR 24, PR 38, PR 40; decision 54).
- The answer of a run (PR 28) is decided by a create-only claim `<runId>__answer` that names the flushed record; materialising writes that record's content only, so a holder that resumes after its check writes what is already there.
- The boot record (PR 22) carries the PID namespace. A pid is probed only with the same hostname and namespace and never for pid 1 or the own pid; everything else is observed through `renewSeq` for 30 s. An instance frozen for longer stays undetected, and `IHUB_FORCE_BOOT=1` is the logged and audited override (decision 53).
- Webhook nonce and trigger event (PR 56) are written in a fixed order under a derived event id; a retry that finds a nonce without `done` completes the event and answers 202, and only a completed call answers 409.
- A follow-up (PR 40) is consumed only after its admission is confirmed. A completer confirms a head whose entry is still `reserved`, admits again under the same `runId` when the sweep of PR 22 removed it, or ends the event cancelled through the `lapsed` head; the kill-point item says so and a case for a stop between admission steps (2) and (3) is added.
- The wakes of a parent chat (PR 42) are serialised by the run claim of PR 23: only its holder claims reports, all that are unclaimed at that moment, so two workers cannot split two reports into two wakes.
- Readmission of a follow-up (PR 40): never under the old `runId`. Admission attempts of an event are numbered by claim by create and each has its own `runId`, so a sweep that deletes the head of an abandoned attempt late cannot remove the job of the next one.

## 12. Rejected review points

- **A consent per scheduled task with the gate always on, as the answer the plan assumes.** Not adopted as the assumed answer. #3783 promises that scheduled tasks work as before while `agents` is off, recommendation 55 puts the consent on an agent only, and the change would hold writes of existing customers at the upgrade. It is kept as option (b) of the blocking question, and PR 54 is specified for both answers.
- **'Legacy agent principal' as a row of the parity table in PR 15.** Not built: after PR 13 no run carries such a principal. The table covers session user, personal API key, OAuth client and scheduled run; the test in the removal pull request pins the legacy path as unreachable.
- **One pull request for each of up to nine rebuilt default workflows.** Three workflows are rebuilt under the proposed dispositions besides the law consultation, each in its own pull request; the other files are not rebuilt, with the reason in section 2.7. If the product owner asks for more rebuilds, each gets its own pull request and migration after PR 72.

