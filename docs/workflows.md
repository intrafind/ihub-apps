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
