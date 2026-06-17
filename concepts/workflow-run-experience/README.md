# Workflow Run Experience

Design concept for an **end-user-facing workflow experience layer** on top of iHub's
existing workflow engine. Today the engine is exposed mainly through technical,
admin-oriented surfaces (the React-Flow node editor and the executions dashboard).
This concept proposes a consumer surface that hides the DAG and presents a workflow
run as a sequence of **review/triage screens** — inspired by the SPARK Workflow UI
(BMDS, planning & permit acceleration).

## Documents

- [`2026-06-16 Workflow Run Experience Design.md`](./2026-06-16%20Workflow%20Run%20Experience%20Design.md)
  — the full design: motivation, `reviewView` schema, item-level HITL model,
  component breakdown, mapping to existing code, and a phased implementation plan.

## One-line summary

Keep the node-graph editor as the **authoring** tool; add a declarative
**run experience** (stage stepper → per-stage worklist of reviewable items →
evidence/citation panes → accept/edit/discard) so non-technical users can drive
long-running workflows without ever seeing a node or an edge.
</content>
</invoke>
