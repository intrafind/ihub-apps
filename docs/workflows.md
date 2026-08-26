# Workflows

Workflows are multi-step, graph-based automations: nodes (prompt, tool, decision, loop, human, transform, ...) connected by edges. They are defined as JSON files in `contents/workflows/` and edited visually in the admin area under **Admin → Workflows**, which provides a drag-and-drop canvas with a searchable node palette, labeled decision branches, an edge condition editor, and configuration forms for every node type.

Default example workflows ship in `server/defaults/workflows/` and are copied into `contents/workflows/` at server startup when missing. Definitions are validated against the schema in `server/validators/workflowConfigSchema.js`.

## Loop containers (iterate over results)

A `loop` node repeats a body of nodes. Since the introduction of visual loop containers, the loop body can be built directly on the canvas: the loop node is rendered as a resizable container, and any node dragged inside it becomes part of the loop body.

### Building a loop in the visual editor

1. Add a **Loop** node from the node palette and resize the container to taste (its `size: { width, height }` is persisted).
2. Drag other nodes (e.g. a prompt node) **into the container**. They become loop-body children: they carry the loop node's ID as `parentId` and their `position` becomes relative to the container's top-left corner. Dragging a node back out releases it into the top-level graph again.
3. Connect the **container** to the rest of the workflow (incoming edge into the loop node, outgoing edge from it). Body nodes are entered implicitly by the loop on each iteration — edges may **not** cross the container boundary. Body children therefore don't need an incoming edge; if the body has several nodes, connect them to each other to define their order.

A container child in the JSON definition looks like this:

```json
{
  "id": "analyze-section",
  "type": "prompt",
  "name": { "en": "Analyze Section" },
  "parentId": "analyze-sections",
  "position": { "x": 40, "y": 80 },
  "config": {
    "prompt": {
      "en": "[Section {{_loopHuman}}/{{_loopTotal}}] Analyze \"{{_loopItem}}\" of the topic \"{{topic}}\"."
    },
    "outputVariable": "sectionAnalysis"
  }
}
```

### Loop configuration

The loop node's `config` controls the iteration:

| Option           | Description                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`           | `forEach` (iterate an array from state), `for` (fixed `count`), or `while` (JavaScript `condition` evaluated before each iteration).                             |
| `array`          | `forEach` only: the state variable holding the array. Plain names (`sections`), nested paths (`outline.sections`), and `$.`-prefixed paths are all supported.    |
| `outputVariable` | State variable that receives the **collected results** — one entry per iteration, each being the output of the last body node (for prompt nodes an object whose `content` field holds the text). |
| `maxIterations`  | Safety cap on iterations (default 50, hard ceiling 500).                                                                                                          |
| `concurrency`    | `forEach` only: number of iterations run in parallel (1–10, default 1 = sequential). See the parallel-mode caveat below.                                          |

### Loop variables

During each iteration the loop injects these variables into workflow state, usable in any `{{...}}` template inside the body (they are removed again after the loop):

| Variable     | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `_loopItem`  | The current array element (`forEach` mode only).                    |
| `_loopIndex` | 0-based iteration index.                                            |
| `_loopHuman` | 1-based counterpart of `_loopIndex`, for user-facing progress text. |
| `_loopTotal` | Total number of iterations (`-1` in `while` mode).                  |

### Conditional steps inside a loop body

Body children may also be connected **to each other**, and those sibling edges carry conditions exactly like edges in the outer graph — clicking an edge in the editor opens the same condition editor. That turns a single iteration into a small graph of its own, so a step can be skipped or an iteration can end early.

- When the body contains at least one edge between two of its own nodes, the iteration becomes a **walk**: it starts at the body's entry node (the child with no incoming sibling edge) and after each step follows the **first** outgoing edge whose condition holds. Edges are tried in definition order, so place the more specific branch first.
- A step whose outgoing edges all evaluate to false simply **ends that iteration**. The loop then moves on to the next item (or re-evaluates the `while` condition). This is how an early exit inside the body is expressed — no `end` node is involved.
- Because the walk starts at the entry node, a body node that no satisfied edge leads to is **skipped** for that iteration. Once a body has edges, connect every step into the chain; a step left dangling never runs.
- If the body has **no** edges at all, every child runs once per iteration in container order — the original behaviour, and also how legacy inline `config.body` arrays work (they carry no edges and always run straight through).
- A per-iteration step cap (ten steps per body node, plus ten) guards against body edges that form a cycle: the iteration is stopped and a warning is logged.

Two sibling edges leaving the same step form a branch. The example below (from `stellungnahmen-review-ifinder-v2`) emits a progress notice only when the fetched document had to be truncated, and otherwise jumps straight to the extraction step:

```json
{
  "edges": [
    {
      "id": "e-mark-truncation-announce-truncation",
      "source": "mark-truncation",
      "target": "announce-truncation",
      "condition": { "type": "expression", "expression": "$.data._currentDoc.truncated === true" }
    },
    {
      "id": "e-mark-truncation-extract-evidence",
      "source": "mark-truncation",
      "target": "extract-evidence",
      "condition": { "type": "expression", "expression": "$.data._currentDoc.truncated !== true" }
    },
    {
      "id": "e-announce-truncation-extract-evidence",
      "source": "announce-truncation",
      "target": "extract-evidence"
    }
  ]
}
```

Both branches converge again on `extract-evidence`, so the rest of the iteration is written only once. The same workflow uses the other pattern too: its search-refinement loop leaves `refine-decision` through a single conditional edge, so when the model reports that the query plan is good enough, no edge matches and the round simply ends.

All condition types available in the outer graph work on body edges (`always`, `never`, `expression`, `equals`, `contains`, `exists`); an edge without a `condition` is always followed.

### Nested loop containers

A loop container may itself be a body node of another container — the inner loop node just carries the outer loop's ID as its `parentId`, like any other body child. The inner loop then runs to completion once per outer iteration.

```json
{
  "id": "analyse-documents",
  "type": "loop",
  "parentId": "per-subquestion",
  "config": { "mode": "forEach", "array": "_corpus", "maxIterations": 500 }
}
```

Loop variables are **scoped to their own loop**. When an inner loop finishes it restores `_loopItem`, `_loopIndex`, `_loopHuman` and `_loopTotal` to the enclosing loop's values, so body steps placed after the inner container still see the outer item. After a top-level loop finishes the variables are removed again, as before.

> **Caution:** while the inner loop is running, `_loopItem` (and its three companions) refer to the **inner** item. A step inside the inner body that also needs the outer item must read it from a named variable — copy it in the outer body **before** entering the inner container.

The shipped `corpus-analysis-decomposed-v2` does exactly this: `load-subquestion` is the first step of the outer container and copies the current sub-question, `load-doc` is the first step of the inner container and copies the current document.

```json
{
  "id": "load-subquestion",
  "type": "transform",
  "parentId": "per-subquestion",
  "config": { "operations": [{ "copy": "_loopItem", "to": "_subQuestion" }] }
}
```

Its inner extraction prompt therefore uses `{{_subQuestion}}` for the outer item and `{{_loopHuman}}` / `{{_loopTotal}}` for its own per-document counter.

Nesting works on the canvas like any other containment: drag a loop container into another container to nest it, or add a loop from the palette while the viewport centre sits inside a container. A container can never be dropped into itself or into its own body.

### Parallel mode caveat

With `concurrency` greater than 1, each iteration runs against a **snapshot of the pre-loop state**. State updates made inside the body (e.g. a body node's `outputVariable`) are **not propagated** across iterations or back into the workflow — only the results collected into the loop's `outputVariable` (and step logs) survive. This keeps parallel runs deterministic. Use sequential mode (`concurrency: 1` or omitted) when later iterations must see state written by earlier ones.

### Consuming the collected results

Downstream nodes reference the collected array like any other state variable. For prompt-node bodies, iterate the entries and use their `content` field:

```text
{{#each sectionAnalyses}}
---
{{this.content}}
{{/each}}
```

### Inline bodies

The previous way of defining a loop body inline as `config.body` (an array of node definitions inside the loop node's config) remains fully supported. When `config.body` is non-empty it takes precedence; otherwise the body is resolved from the container children.

### Shipped example: `topic-deep-dive`

The default workflow **Topic Deep Dive** (`server/defaults/workflows/topic-deep-dive.json`) is the reference example for loop containers: the user enters a topic, an outline prompt produces `outline.sections` (3–6 section titles via a structured-output schema), a loop container iterates the sections with `concurrency: 2` — its child prompt analyzes one `{{_loopItem}}` per iteration — and a final prompt composes the collected `sectionAnalyses` into a report.

### Modernized example workflows

Several default workflows now ship in a second, container-based variant alongside the original. They do the same work, but replace the old cursor idiom (a cursor variable, a decision node and a back-edge) with visual loop containers, which makes them far easier to read and edit on the canvas. Each variant is a separate workflow with its own ID; the originals remain available unchanged.

| Workflow                           | Loop containers used                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stellungnahmen-review-v2`         | One `forEach` container over the uploaded documents (`_document`): load → announce → extract → record → count.                                                                  |
| `stellungnahmen-review-ifinder-v2` | Two containers: a `while` container running up to three search-refinement rounds, and a `forEach` container per document whose body branches on a truncation notice.            |
| `corpus-analysis-direct-v2`        | One `forEach` container over the search result set (`_corpus`) — the flat completeness pattern: one search, cycle over results.                                                 |
| `corpus-analysis-decomposed-v2`    | **Nested**: a `forEach` container per planned sub-question, containing a second `forEach` container per document of that sub-question's search.                                 |
| `iterative-research-auto-v2`       | One `while` container for the think → research → refine cycle, with a conditional sibling edge that ends the round before the researcher once the thinker reports completeness. |

Like all defaults, these files live in `server/defaults/workflows/` and are copied into `contents/workflows/` at the next server start when missing.

All of them run **sequentially** — none sets `concurrency`. Each round accumulates shared state (collected evidence records, the coverage counter, the merged corpus), and as described under **Parallel mode caveat** above, body state updates are not propagated in parallel mode. Raising `concurrency` on these loops would silently discard that accumulated state.
