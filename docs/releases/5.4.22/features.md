# Features — 5.4.22

## Filesystem Sources Are Now Scoped to `contents/sources/`

Closed a privilege-escalation gap where an admin with only the restricted **Content Admin** role
(not full Admin Access) could use the filesystem-source file browser/editor to read or write files
anywhere under `contents/` — including `config/groups.json` and the `.encryption-key` file used to
decrypt stored secrets.

- Reading, writing, deleting, and browsing filesystem-source files, plus the "Test connection"
  check, are now hard-scoped to `contents/sources/`, regardless of what path is requested.
- Saving a filesystem source with a `config.path` outside `sources/` (or containing a dotfile
  segment) is now rejected by validation.
- All bundled default sources already store their path with the `sources/` prefix, so they are
  unaffected. See **Breaking Changes** below if you have a custom filesystem source with a path
  outside `sources/`.

## Audit Log Filtering by Checkbox, With Entry Counts

**Observability → Audit Log** now filters with checkbox lists instead of single-value dropdowns, so
"everything except logins" is one click rather than impossible. Actor, resource, action, result and
source each open a list of the values that actually occur in the selected date range, each showing
how many entries are behind it.

- **Select all** and **Select none** are single clicks; lists longer than ten values get a
  type-ahead box. Full keyboard and screen-reader support.
- Counts are what make a noisy log tractable: seeing `login — 794` tells you exactly what to untick.
- Option lists are read from the log, not from a fixed list, so resource types added by a later
  release appear on their own.
- Counts and options are computed over the date range only, so unticking a value never makes its
  checkbox vanish.
- A new **search box** matches the summary, resource ID, IP, request ID and actor name of any entry
  in the date range.
- **Quick filters:** Today / Today & yesterday / Last 7 days / Last 30 days, **Hide sign-ins**,
  **Failures only**, and **Clear all filters**.
- The default range is now **today and yesterday** instead of 7 days. The date filter works in whole
  calendar days (UTC) with no time-of-day cutoff, so the default covers two days rather than a
  rolling 24 hours — that way the table is not near-empty just after midnight. Widen it with the
  date inputs or a chip.
- Action, result and source are translated in the table itself, not only in the filter lists.
- Filter state stays in the URL, so a filtered view is still bookmarkable and shareable. Each field
  takes an include parameter and an `<field>Exclude` parameter, with `*` meaning "every value" —
  `?actionExclude=login,logout` is "everything but sign-ins". Existing single-value links such as
  `?resource=app` keep working.
- Audit log queries now scan each daily file once instead of loading the whole date range into
  memory and sorting it, so a wide range costs materially less.

## Workflow Editor: Visual Loop Containers, Parallel Iteration, and Friendlier Editing

Loops in workflows can now be built visually. A loop node is a resizable container on the canvas:
drag any node into it and that node becomes the loop body, executed once per iteration — no more
hand-editing an inline JSON body. Dragging a node back out releases it into the regular graph.

- Loop-body nodes can use `{{_loopItem}}`, `{{_loopIndex}}`, `{{_loopHuman}}`, and `{{_loopTotal}}`
  in their prompts; per-iteration results are collected into the loop's output variable. Existing
  workflows with inline `config.body` definitions keep working unchanged.
- Parallel iteration: a new `concurrency` option (up to 10) on forEach loops processes several
  items at once. Each parallel iteration works on a snapshot of the pre-loop state — only the
  collected results are propagated, keeping runs deterministic.
- Editor improvements: a friendlier searchable node palette, labeled decision branches, an edge
  condition editor, and configuration forms for every node type.
- A new default example workflow, **Topic Deep Dive** (`topic-deep-dive`), demonstrates the
  pattern end to end: outline a topic, analyze every section inside a parallel loop container, and
  compose a final report. Existing installations receive it automatically at the next server
  start. The new **Workflows** documentation page describes loop containers in detail.

## Workflow Loop Bodies Can Branch and Nest, Plus Modernized Example Workflows

Building on the visual loop containers described above, the body of a loop is no longer restricted
to a straight line of steps. Edges drawn between body steps are now evaluated on every iteration,
and a container may sit inside another container.

- **Conditional steps inside a loop body.** Connect two body steps and give the edge a condition —
  the same edge condition editor used in the outer graph. Each iteration then walks the body,
  following the first outgoing edge whose condition holds, so a step can be skipped for some items
  and run for others. A step whose outgoing edges all evaluate to false ends that iteration, which
  is how an early exit is expressed. A body with no edges keeps running every step in order, so
  existing loops (and legacy inline `config.body` arrays) are unaffected.
- **Nested loop containers.** A loop container can be a body step of another container — an outer
  cycle per sub-question, an inner cycle per document, for example. Loop variables are now scoped
  per loop: an inner loop restores `_loopItem`, `_loopIndex`, `_loopHuman` and `_loopTotal` to the
  enclosing loop's values when it finishes, so steps placed after an inner loop still see the outer
  item. Previously the inner loop deleted them. Note that while the inner loop runs, `_loopItem`
  refers to the inner item — copy the outer item into a named variable first if you need both.
- **Modernized example workflows.** `stellungnahmen-review-v2`, `stellungnahmen-review-ifinder-v2`,
  `corpus-analysis-direct-v2`, `corpus-analysis-decomposed-v2` and `iterative-research-auto-v2`
  replace the old cursor idiom — a cursor variable, a decision node and a back-edge — with loop
  containers. The iFinder variant shows both new capabilities at once: a `while` container for
  search refinement and a `forEach` container per document that branches on a truncation notice;
  the decomposed variant is a container nested inside a container. The originals are untouched and
  keep their IDs, so nothing changes for workflows already in use; existing installations pick up
  the new files automatically at the next server start.
- The converted workflows deliberately stay sequential: they accumulate shared evidence and
  coverage state each round, and parallel iteration does not propagate body state updates.

## Loop Bookkeeping and Progress Notes Become Step Options

Reading a loop body used to mean stepping over its plumbing: a step to copy the current item under
a usable name, a step to announce what was about to happen, a step to bump a counter. Those three
are now options on the steps that already exist, so a body contains only the work it actually does.
Across the shipped example workflows this removed 42% of the body steps — from 38 down to 22 —
without changing what any of them do.

- **Name the current item.** A loop's new `itemVariable` option gives the current element a name of
  its own, so body steps write `{{_currentDoc.displayName}}` instead of `{{_loopItem.displayName}}`.
  This is what makes nested loops legible: the outer loop's item keeps its name while an inner loop
  runs, and is restored when the inner loop finishes. `{{_loopItem}}` continues to work everywhere.
- **Count rounds without a counting step.** A loop's new `countInto` option names a state path — for
  example `coverage.processed` — that the loop increases by one after every finished round. It
  works in every loop mode, including `while`, where it replaces the usual "increment the iteration
  counter" transform.
- **Progress notes on any step.** Every step can now carry a `progress: { message, when? }` object
  and announce itself in chat just before it runs, which replaces the separate announcement step
  that used to precede it. The optional `when` condition means a step can speak up only in the
  rounds where it has something to say — the iFinder review uses it to flag only those documents
  whose full text had to be truncated. The standalone `progress` node is unchanged and remains the
  right choice for an announcement that belongs to no particular step.
- The visual editor exposes all three: **Name the current item** and **Count completed rounds into**
  on the loop form, and a **Progress note** field at the bottom of every step's form.
- The five `-v2` example workflows have been simplified accordingly and keep their IDs. Like all
  defaults they are copied into `contents/workflows/` at the next server start only when the file
  is missing, so a copy you have already edited is never overwritten — delete it to take the new
  version.

## Workflow Editor: Variable Discovery, a Real Memory Step, and Container Auto-Layout

A round of fixes to the workflow editor and the shipped example workflows, driven by what
building the loop containers exposed.

- **Know which variables exist.** Selecting a step and opening its new **Variables** tab lists
  every name that step can read, grouped by origin — workflow inputs, each earlier step's output,
  the enclosing loops' items and counters, and the run metadata the engine provides. Click a name
  to copy it as `{{name}}`.
- **Unknown names are flagged before they cost you a run.** The canvas warns about any `{{name}}`
  or `$.data.name` reference that no step defines, and clicking one selects the step it appears in.
  A misspelled variable used to render as an empty string and fail silently. The check knows the
  names steps write beyond `outputVariable` — a corpus search's `corpusVar`/`coverageVar`, a loop's
  `itemVariable`/`countInto`, a transform's operation targets, a human step's `humanResponse_<id>`,
  a start step's inputs and defaults — and it leaves Handlebars block bodies alone rather than
  reporting names that are perfectly valid inside an `{{#each}}`.
- **Fewer variables to define at all.** A loop now defines its own `countInto` counter as `0`
  before the first round, so a `while` condition can read it immediately. Together with the record
  and coverage variables their own steps already create, the "initialise counters" step at the top
  of a workflow is no longer needed — the shipped examples have dropped theirs, and genuine
  constants moved to the Start step's defaults where they read as settings rather than work.
- **Reading agent memory is a step, not a transform.** `memory` is now a real node type with a
  form of its own, replacing a `readAgentMemorySection` operation hidden inside transform steps.
  A missing profile or absent section yields an empty string rather than failing the run. The
  `memory` palette entry previously had no implementation at all and would have failed at run time.
- **Auto-layout arranges loop bodies.** It used to skip every step inside a container, leaving
  body steps wherever they happened to sit. It now lays out each container's steps from the edges
  between them, innermost container first, and grows each container to fit what it holds.
- **Tool steps are configurable again.** The tool picker wrote a `toolName` key the engine never
  reads, so it always looked empty, and Parameters rendered as `[object Object]` because an object
  was bound to a plain textarea — the first keystroke replaced the whole parameter map with a
  string. Tool steps now bind the real `toolId`, the picker offers the callable function ids
  (`iFinder_getContent`, not just `iFinder`), and structured values get a JSON editor that keeps
  the last valid value while you type. The same guard now covers every form field, and HTTP
  headers use the new editor too.
- **iFinder document fetches report truncation.** `getContent` now always returns `truncated`,
  `originalContentLength`, `returnedContentLength` and the `maxLength` it applied, so a workflow
  reads the flag off the result instead of re-deriving it from a length comparison. The iFinder
  review's per-document loop is three steps as a result: fetch, extract, record.
