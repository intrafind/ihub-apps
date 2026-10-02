# Fixes — Unreleased

## Themed Mermaid Diagrams Render for Every Diagram Type

Pie charts, Gantt charts, mind maps and several other diagram types showed "Incomplete diagram
code." instead of the diagram when they started with Mermaid theme settings (a `config:` front
matter block or an `%%{init: ...}%%` directive). These diagrams now render with their colours, so
an app's system prompt can ask the model to apply a corporate colour palette to any diagram type.
